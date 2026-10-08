import { createReadStream, existsSync, statSync } from 'node:fs';
import { open, readdir, readFile, stat, type FileHandle } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { prettyCwd } from '../core/ingest';
import { NO_TRANSCRIPTS, classifyAll, parseFiles, type Progress, type SourceFile } from '../core/parse';
import type { ByteSource } from '../core/sqlite';
import type { Dataset } from '../core/types';

// The same entries the zip command on the landing page picks from ~/.claude.
const CLAUDE_DIR_ENTRIES = ['projects', 'history.jsonl', 'stats-cache.json', 'sessions'];
// The parts of ~/.codex with session rollouts and prompt history.
const CODEX_DIR_ENTRIES = ['sessions', 'archived_sessions', 'history.jsonl'];
// OpenCode keeps everything in one SQLite database.
const OPENCODE_DIR_ENTRIES = ['opencode.db', 'opencode.db-wal'];
const SKIP_DIRS = new Set(['tool-results', 'file-history', 'node_modules', '.git']);

// A random-access reader over a file on disk. The SQLite reader only pulls the
// pages it needs, so a multi-hundred-MB database is never loaded at once.
export function fileSource(path: string): ByteSource {
  let handle: FileHandle | null = null;
  const openFile = async () => (handle ??= await open(path, 'r'));
  return {
    async size() {
      return (await (await openFile()).stat()).size;
    },
    async read(offset: number, length: number) {
      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await (await openFile()).read(buf, 0, length, offset);
      return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
    },
    async close() {
      await handle?.close();
      handle = null;
    },
  };
}

// A SourceFile for a database passed directly on the command line
// (claude-log ~/.local/share/opencode/opencode.db).
export function databaseFile(path: string): SourceFile {
  const wal = existsSync(`${path}-wal`) ? `${path}-wal` : null;
  return {
    path: basename(path),
    size: statSync(path).size + (wal ? statSync(wal).size : 0),
    kind: { kind: 'database' },
    lines: async () => {},
    text: async () => '',
    database: async () => ({ main: fileSource(path), wal: wal ? fileSource(wal) : null }),
  };
}

async function walk(path: string, out: string[]) {
  const info = await stat(path).catch(() => null);
  if (!info) return;
  if (info.isFile()) {
    out.push(path);
    return;
  }
  if (!info.isDirectory()) return;
  for (const d of await readdir(path, { withFileTypes: true })) {
    if (d.isDirectory() && SKIP_DIRS.has(d.name)) continue;
    await walk(join(path, d.name), out);
  }
}

async function streamLines(path: string, onLine: (line: string) => void, onBytes: (n: number) => void) {
  let rest = '';
  for await (const chunk of createReadStream(path, { encoding: 'utf8' })) {
    const value = chunk as string;
    onBytes(value.length);
    const parts = (rest + value).split('\n');
    rest = parts.pop() ?? '';
    for (const p of parts) onLine(p);
  }
  if (rest) onLine(rest);
}

function startPaths(root: string): string[] {
  if (existsSync(join(root, 'projects'))) return CLAUDE_DIR_ENTRIES.map((e) => join(root, e));
  // ~/.codex (has config.toml or auth.json next to sessions/)
  if (existsSync(join(root, 'sessions')) && (existsSync(join(root, 'config.toml')) || existsSync(join(root, 'auth.json')))) {
    return CODEX_DIR_ENTRIES.map((e) => join(root, e));
  }
  // ~/.local/share/opencode (or the platform's data directory)
  if (existsSync(join(root, 'opencode.db'))) return OPENCODE_DIR_ENTRIES.map((e) => join(root, e));
  return [root];
}

// Parses a data directory in place: ~/.claude, its projects/ directory or a
// single project directory, ~/.codex or its sessions/ directory, or the
// OpenCode data directory with its opencode.db.
export async function parseDir(root: string, onProgress: (p: Progress) => void): Promise<Dataset> {
  const paths: string[] = [];
  for (const s of startPaths(root)) await walk(s, paths);

  const rels = paths.map((path) => relative(root, path).split(sep).join('/'));
  const { kinds } = classifyAll(rels);
  const files: SourceFile[] = [];
  let skipped = 0;
  for (const [i, path] of paths.entries()) {
    const rel = rels[i];
    const kind = kinds[i];
    if (!kind) {
      skipped++;
      continue;
    }
    const wal = kind.kind === 'database' && existsSync(`${path}-wal`) ? `${path}-wal` : null;
    files.push({
      path: rel,
      size: (await stat(path)).size + (wal ? (await stat(wal)).size : 0),
      kind,
      lines: (onLine, onBytes) => streamLines(path, onLine, onBytes),
      text: () => readFile(path, 'utf8'),
      ...(kind.kind === 'database' ? { database: async () => ({ main: fileSource(path), wal: wal ? fileSource(wal) : null }) } : {}),
    });
  }
  if (files.length === 0) throw new Error(`${NO_TRANSCRIPTS} in ${root}.`);
  return parseFiles(prettyCwd(root), files, skipped, onProgress);
}
