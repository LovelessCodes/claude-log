import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { bufferSource, columnsFromSql, openSqlite } from './sqlite';

// node:sqlite (Node 22.5+) is used only to build databases for the tests.
const sqlite = await import('node:sqlite').catch(() => null);
const dir = mkdtempSync(join(tmpdir(), 'claude-log-sqlite-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const dbPath = (name: string) => join(dir, name);

describe('columnsFromSql', () => {
  it('reads column names and skips constraints', () => {
    expect(
      columnsFromSql(
        'CREATE TABLE `session_message` (\n `id` text PRIMARY KEY,\n `message_id` text NOT NULL,\n "data" text NOT NULL,\n CONSTRAINT `fk` FOREIGN KEY (`id`) REFERENCES `x`(`id`) ON DELETE CASCADE\n)',
      ),
    ).toEqual(['id', 'message_id', 'data']);
    expect(columnsFromSql('CREATE TABLE t (a INTEGER, b TEXT, CHECK (a > 0), PRIMARY KEY (a, b))')).toEqual(['a', 'b']);
  });
});

describe.skipIf(!sqlite)('SQLite reader', () => {
  it('reads every column type, overflow pages and rows written to the WAL', async () => {
    const path = dbPath('main.db');
    const db = new sqlite!.DatabaseSync(path);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER, big INTEGER, r REAL, b BLOB, note TEXT)');
    db.exec('CREATE TABLE other (k TEXT, v TEXT)');
    db.exec(`INSERT INTO t VALUES ('a', -7, 1099511627776, 1.5, x'00ff', 'hello')`);
    // A long value spills into overflow pages.
    const long = 'x'.repeat(200_000);
    db.exec(`INSERT INTO t VALUES ('long', 0, 0, 0, NULL, '${long}')`);
    // Make sure the WAL is empty, then write a row that only lives there.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec(`INSERT INTO t VALUES ('wal', 42, 0, 0, NULL, 'from the wal')`);
    db.exec(`INSERT INTO other VALUES ('key', 'value')`);

    const main = readFileSync(path);
    const wal = readFileSync(`${path}-wal`);
    const reader = await openSqlite(bufferSource(main), bufferSource(wal));
    expect([...reader.tables().keys()].sort()).toEqual(['other', 't']);
    expect(reader.tables().get('t')?.columns).toEqual(['id', 'n', 'big', 'r', 'b', 'note']);

    const rows = new Map<string, unknown[]>();
    for await (const row of reader.scan('t')) rows.set(String(row[0]), row);
    expect(rows.size).toBe(3);
    expect(rows.get('a')).toEqual(['a', -7, 1099511627776, 1.5, new Uint8Array([0, 255]), 'hello']);
    expect((rows.get('long')?.[5] as string).length).toBe(200_000);
    expect(rows.get('wal')).toEqual(['wal', 42, 0, 0, null, 'from the wal']);
    expect([...(await collect(reader.scan('other')))]).toEqual([['key', 'value']]);
    db.close();
  });

  it('reads a database without a WAL file', async () => {
    const path = dbPath('plain.db');
    const db = new sqlite!.DatabaseSync(path);
    db.exec('CREATE TABLE t (a TEXT, b INTEGER)');
    db.exec(`INSERT INTO t VALUES ('one', 1), ('two', 2)`);
    db.close();
    const reader = await openSqlite(bufferSource(readFileSync(path)), null);
    expect([...(await collect(reader.scan('t')))]).toEqual([
      ['one', 1],
      ['two', 2],
    ]);
  });

  it('scans rows in rowid order across multiple B-tree pages', async () => {
    const path = dbPath('many.db');
    const db = new sqlite!.DatabaseSync(path);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const insert = db.prepare('INSERT INTO t (v) VALUES (?)');
    db.exec('BEGIN');
    for (let i = 0; i < 5000; i++) insert.run(`value ${i}`);
    db.exec('COMMIT');
    db.close();
    const reader = await openSqlite(bufferSource(readFileSync(path)), null);
    const ids: number[] = [];
    for await (const row of reader.scan('t')) ids.push(row[0] as number);
    expect(ids).toHaveLength(5000);
    // The stack-based traversal must not walk the leaves backwards.
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it('rejects files that are not SQLite databases', async () => {
    const junk = new TextEncoder().encode('hello world, this is not a database at all. '.repeat(10));
    await expect(openSqlite(bufferSource(junk), null)).rejects.toThrow(/SQLite/);
  });
});

async function collect(gen: AsyncGenerator<unknown[]>): Promise<unknown[][]> {
  const out: unknown[][] = [];
  for await (const row of gen) out.push(row);
  return out;
}
