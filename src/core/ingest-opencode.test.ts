import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { catalogRates, findRates, mcpTool, parseOpenCode, type ModelRates } from './ingest-opencode';
import { classifyAll, classifyOpenCodePath } from './parse';
import { bufferSource } from './sqlite';

// node:sqlite (Node 22.5+) builds the databases for these tests.
const sqlite = await import('node:sqlite').catch(() => null);
const dir = mkdtempSync(join(tmpdir(), 'claude-log-opencode-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CWD = '/Users/me/dev/app';
const PROJECT = '-Users-me-dev-app';
const SID = 'ses_parent000000000000000000000';
const CHILD = 'ses_child0000000000000000000000';
const at = (sec: number) => Date.UTC(2026, 1, 19, 10, 0, sec);

const V2_TABLES = `
  CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);
  CREATE TABLE session_v2 (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT, directory TEXT NOT NULL,
    title TEXT, version TEXT, agent TEXT, model TEXT, cost REAL DEFAULT 0, summary_additions INTEGER,
    summary_deletions INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
  CREATE TABLE session_message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT, time_created INTEGER, time_updated INTEGER);
  CREATE TABLE session (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, directory TEXT NOT NULL, title TEXT,
    version TEXT, agent TEXT, model TEXT, cost REAL DEFAULT 0, time_created INTEGER, time_updated INTEGER);
  CREATE TABLE message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL);
  CREATE TABLE part (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER,
    time_updated INTEGER, data TEXT NOT NULL);
`;

const session = (id: string, parent: string | null, agent: string, title: string, cost: number, model = 'claude-sonnet-5') => ({
  id,
  project_id: 'global',
  parent_id: parent,
  directory: CWD,
  title,
  version: '1.18.0',
  agent,
  model: JSON.stringify({ id: model, providerID: 'anthropic', variant: 'high' }),
  cost,
  time_created: at(0),
  time_updated: at(30),
});

const assistant = (id: string, sessionId: string, ts: number, tokens: object, cost: number, content: object[], extra: object = {}, model = 'claude-sonnet-5') => ({
  id,
  session_id: sessionId,
  type: 'assistant',
  seq: 0,
  time_created: ts,
  time_updated: ts,
  data: JSON.stringify({
    agent: 'build',
    model: { providerID: 'anthropic', id: model, variant: 'high' },
    cost,
    tokens,
    content,
    finish: 'tool-calls',
    time: { created: ts, completed: ts + 2000 },
    ...extra,
  }),
});

const user = (id: string, sessionId: string, ts: number, text: string) => ({
  id,
  session_id: sessionId,
  type: 'user',
  seq: 0,
  time_created: ts,
  time_updated: ts,
  data: JSON.stringify({ text, time: { created: ts } }),
});

const tool = (name: string, input: object, extra: object = {}) => ({
  type: 'tool',
  id: `call_${name}`,
  name,
  state: { status: 'completed', input, content: [{ type: 'text', text: 'x'.repeat(400) }], ...extra },
});

const CATALOG = JSON.stringify({
  body: JSON.stringify({
    anthropic: {
      id: 'anthropic',
      models: {
        'claude-sonnet-5': { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } },
      },
    },
  }),
});

function buildV2(name = 'v2.db'): string {
  const path = join(dir, name);
  const db = new sqlite!.DatabaseSync(path);
  db.exec(V2_TABLES);
  const insert = (table: string, row: Record<string, unknown>) => {
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...(Object.values(row) as never[]));
  };
  insert('project', { id: 'global', worktree: CWD });
  insert('session_v2', session(SID, null, 'build', 'Fix the build', 0.5));
  insert('session_v2', session(CHILD, SID, 'explore', 'Find the config (@explore subagent)', 0.02));
  insert('kv', { key: 'models-dev:catalog', value: CATALOG, time_created: at(0), time_updated: at(0) });

  insert('session_message', user('msg_u1', SID, at(1), 'Fix the build'));
  insert(
    'session_message',
    assistant('msg_a1', SID, at(2), { input: 2000, output: 100, reasoning: 50, cache: { read: 8000, write: 1000 } }, 0.1234, [
      tool('read', { filePath: `${CWD}/src/a.ts` }),
      tool('skill', { name: 'pdf' }),
    ]),
  );
  insert('session_message', { id: 'msg_c1', session_id: SID, type: 'compaction', seq: 0, time_created: at(3), time_updated: at(3), data: JSON.stringify({ status: 'completed', reason: 'auto', summary: 'summary' }) });
  insert('session_message', assistant('msg_a2', SID, at(4), { input: 9000, output: 80, reasoning: 10, cache: { read: 0, write: 0 } }, 0.5, [
    tool('bash', { command: 'npm test -- --run' }, { metadata: { exit: 1, output: 'boom' } }),
    tool('t3-code_preview_open', { url: 'http://localhost:5173' }),
  ]));
  insert('session_message', { id: 'msg_i1', session_id: SID, type: 'idle', seq: 0, time_created: at(9), time_updated: at(9), data: JSON.stringify({ outcome: 'succeeded', time: { created: at(9) } }) });
  // A subagent session's own prompt is not a prompt of the report.
  insert('session_message', user('msg_u2', CHILD, at(1.5), 'Search the repo'));
  insert('session_message', assistant('msg_a3', CHILD, at(2.5), { input: 1000, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }, 0.02, [tool('grep', { pattern: 'radar' })]));
  // An API error.
  insert('session_message', assistant('msg_a4', SID, at(10), { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, 0, [], { error: { type: 'provider.error', message: 'Provider exploded' } }));
  db.close();
  return path;
}

function buildLegacy(name = 'legacy.db', interleaved = false): string {
  const path = join(dir, name);
  const db = new sqlite!.DatabaseSync(path);
  db.exec(V2_TABLES);
  const insert = (table: string, row: Record<string, unknown>) => {
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...(Object.values(row) as never[]));
  };
  insert('project', { id: 'global', worktree: CWD });
  insert('session', { id: SID, project_id: 'global', parent_id: null, directory: CWD, title: 'Old session', version: '1.17.0', agent: 'build', model: JSON.stringify({ id: 'gpt-5', providerID: 'openai', variant: 'default' }), cost: 0.5, time_created: at(0), time_updated: at(30) });
  insert('message', { id: 'm1', session_id: SID, time_created: at(1), time_updated: at(1), data: JSON.stringify({ role: 'user', time: { created: at(1) } }) });
  insert('part', { id: 'p1', message_id: 'm1', session_id: SID, time_created: at(1), time_updated: at(1), data: JSON.stringify({ type: 'text', text: 'Old prompt' }) });
  insert('message', { id: 'm2', session_id: SID, time_created: at(2), time_updated: at(2), data: JSON.stringify({ role: 'assistant', mode: 'build', agent: 'build', variant: 'medium', cost: 0.01, tokens: { input: 1000, output: 50, reasoning: 10, cache: { read: 0, write: 0 } }, modelID: 'gpt-5', providerID: 'openai', time: { created: at(2), completed: at(3) }, finish: 'tool-calls' }) });
  insert('part', { id: 'p2', message_id: 'm2', session_id: SID, time_created: at(2), time_updated: at(2), data: JSON.stringify({ type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', input: { command: 'ls -la' }, output: 'file1\nfile2' } }) });
  if (interleaved) {
    // Another message's parts land between the parts of m2.
    insert('message', { id: 'm3', session_id: SID, time_created: at(4), time_updated: at(4), data: JSON.stringify({ role: 'user', time: { created: at(4) } }) });
    insert('part', { id: 'p3', message_id: 'm3', session_id: SID, time_created: at(4), time_updated: at(4), data: JSON.stringify({ type: 'text', text: 'Second prompt' }) });
  }
  insert('part', { id: 'p4', message_id: 'm2', session_id: SID, time_created: at(2), time_updated: at(2), data: JSON.stringify({ type: 'step-finish', tokens: { input: 1000 }, cost: 0.01 }) });
  db.close();
  return path;
}

async function parse(path: string) {
  return parseOpenCode('opencode.db', bufferSource(readFileSync(path)), null, () => {});
}

describe('classifyOpenCodePath', () => {
  it('recognizes the database and its side files', () => {
    expect(classifyOpenCodePath('/root/.local/share/opencode/opencode.db')).toEqual({ kind: 'database' });
    expect(classifyOpenCodePath('backup/opencode.db')).toEqual({ kind: 'database' });
    expect(classifyOpenCodePath('opencode.db-wal')).toBeNull();
    expect(classifyOpenCodePath('opencode.db-shm')).toBeNull();
  });

  it('picks OpenCode only when there are no transcripts or rollouts', () => {
    expect(classifyAll(['opencode.db', 'opencode.db-wal']).source).toBe('opencode');
    expect(classifyAll(['projects/p/11111111-2222-3333-4444-555555555555.jsonl', 'opencode.db']).source).toBe('claude');
    expect(classifyAll(['sessions/2026/02/19/rollout-2026-02-19T22-04-25-019c77b7-e090-7ab1-afda-3b18ef2ccd69.jsonl', 'opencode.db']).source).toBe('codex');
  });
});

describe('mcpTool', () => {
  it('splits server and tool names, leaving built-ins alone', () => {
    expect(mcpTool('t3-code_preview_open')).toEqual({ server: 't3-code', tool: 'preview_open' });
    expect(mcpTool('apply_patch')).toBeNull();
    expect(mcpTool('bash')).toBeNull();
    expect(mcpTool('grep')).toBeNull();
  });
});

describe('model rates', () => {
  it('reads the models.dev catalog cached in the database', () => {
    const catalog: ModelRates = catalogRates(JSON.parse(CATALOG).body);
    expect(findRates('claude-sonnet-5', 'anthropic', catalog)).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
    expect(findRates('anthropic/claude-sonnet-5', 'anthropic', catalog)?.cacheRead).toBe(0.3);
  });

  it('falls back to the built-in prices and dotted version numbers', () => {
    expect(findRates('claude-fable-5.1', 'openrouter', null)).toMatchObject({ input: 10, output: 50 });
    expect(findRates('gpt-5.3-codex', 'openai', null)).toMatchObject({ input: 1.75 });
    expect(findRates('mystery-model', 'unknown', null)).toBeNull();
  });
});

describe.skipIf(!sqlite)('OpenCodeIngestor', () => {
  it('builds the dataset from the v2 tables', async () => {
    const ds = await parse(buildV2());
    expect(ds.sources).toEqual(['opencode']);
    expect(ds.files).toMatchObject({ transcripts: 1, subagents: 1, badLines: 0 });

    expect(ds.sessions).toHaveLength(1);
    expect(ds.sessions[0]).toMatchObject({ id: SID, project: PROJECT, cwd: CWD, title: 'Fix the build', version: '1.18.0', entrypoint: 'build' });
    expect(ds.projects[PROJECT]).toBe('~/dev/app');
    // The reported cost adds the subagent's own session cost.
    expect(ds.sessions[0].reported?.cost).toBeCloseTo(0.52, 10);

    expect(ds.subagents).toEqual([
      expect.objectContaining({ agentId: CHILD, sid: SID, agentType: 'explore', description: 'Find the config (@explore subagent)' }),
    ]);

    // Two calls of the parent, one of the child (counted as a subagent call).
    expect(ds.calls).toHaveLength(3);
    const main = ds.calls.filter((c) => !c.sub);
    const sub = ds.calls.filter((c) => c.sub);
    expect(sub).toHaveLength(1);
    expect(sub[0]).toMatchObject({ sid: SID, agentId: CHILD, project: PROJECT, model: 'claude-sonnet-5', effort: 'high', stop: 'tool-calls' });
    expect(main[0]).toMatchObject({ input: 2000, cr: 8000, cw5: 1000, cw1h: 0, out: 150, think: 50, prompt: 0 });
    // The recorded cost is kept and split by the catalog prices.
    expect(main[0].cost).toBeCloseTo(0.1234, 10);
    expect(main[0].costIn + main[0].costCw + main[0].costCr + main[0].costOut).toBeCloseTo(0.1234, 10);
    expect(main[0].costCr / main[0].cost).toBeCloseTo(2400 / 14400, 3);
    // The subagent call is assigned to the parent's prompt by time.
    expect(sub[0].prompt).toBe(0);

    const tools = ds.tools.filter((t) => !t.sub);
    expect(tools.map((t) => t.name)).toEqual(['read', 'skill', 'bash', 'mcp__t3-code__preview_open']);
    expect(tools[0]).toMatchObject({ detail: 'src/a.ts', error: false, resTok: 100 });
    expect(tools[2]).toMatchObject({ name: 'bash', detail: 'npm test', error: true });
    expect(tools[3]).toMatchObject({ server: 't3-code' });

    expect(ds.prompts.map((p) => p.text)).toEqual(['Fix the build']);
    expect(ds.prompts[0]).toMatchObject({ kind: 'text', calls: 3, tools: 5, skills: ['pdf'] });
    expect(ds.skills).toEqual([expect.objectContaining({ name: 'pdf', source: 'tool', prompt: 0 })]);
    expect(ds.compactions).toHaveLength(1);
    expect(ds.compactions[0]).toMatchObject({ trigger: 'auto', pre: 10_000, post: 9000 });
    // The turn runs from the prompt to the idle message.
    expect(ds.turns).toEqual([expect.objectContaining({ durationMs: 5000 })]);
    expect(ds.history).toEqual([{ ts: at(1), source: 'opencode', project: PROJECT, command: false, len: 13 }]);
    expect(ds.apiErrors).toEqual([expect.objectContaining({ text: 'Provider exploded' })]);
    expect(ds.unknownModels).toEqual([]);
  });

  it('reads a database from before OpenCode 1.18 (message and part tables)', async () => {
    const ds = await parse(buildLegacy());
    expect(ds.files.transcripts).toBe(1);
    expect(ds.prompts.map((p) => p.text)).toEqual(['Old prompt']);
    expect(ds.calls).toHaveLength(1);
    expect(ds.calls[0]).toMatchObject({ model: 'gpt-5', effort: 'medium', input: 1000, out: 60, think: 10, prompt: 0 });
    expect(ds.calls[0].cost).toBeCloseTo(0.01, 10);
    expect(ds.tools).toEqual([expect.objectContaining({ name: 'bash', detail: 'ls', resTok: 3, prompt: 0 })]);
  });

  it('groups parts that are not adjacent in the part table', async () => {
    // A late tool result can be written after parts of later messages; the
    // message must not be ingested once per contiguous run of its parts.
    const ds = await parse(buildLegacy('legacy-interleaved.db', true));
    expect(ds.calls).toHaveLength(1);
    expect(ds.calls[0].cost).toBeCloseTo(0.01, 10);
    expect(ds.tools).toHaveLength(1);
    expect(ds.prompts.map((p) => p.text)).toEqual(['Old prompt', 'Second prompt']);
    expect(ds.calls[0].prompt).toBe(0);
  });

  it('attributes migration leftovers by time and keeps them out of the session state', async () => {
    const path = join(dir, 'leftover.db');
    const db = new sqlite!.DatabaseSync(path);
    db.exec(V2_TABLES);
    const insert = (table: string, row: Record<string, unknown>) => {
      const keys = Object.keys(row);
      db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...(Object.values(row) as never[]));
    };
    insert('project', { id: 'global', worktree: CWD });
    insert('session_v2', session(SID, null, 'build', 'Leftovers', 0.5));
    insert('session_message', user('u1', SID, at(1), 'First prompt'));
    insert('session_message', assistant('a1', SID, at(2), { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, 0.01, []));
    insert('session_message', user('u2', SID, at(4), 'Second prompt'));
    // A compaction call the migration left in the old table: older than the
    // second prompt, but its completion lands inside the second turn.
    insert('message', {
      id: 'msg_old',
      session_id: SID,
      time_created: at(1.2),
      time_updated: at(5),
      data: JSON.stringify({
        role: 'assistant',
        mode: 'compaction',
        summary: true,
        cost: 0.05,
        tokens: { input: 1000, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: 'claude-sonnet-5',
        providerID: 'anthropic',
        time: { created: at(1.2), completed: at(5) },
        finish: 'stop',
      }),
    });
    db.close();
    const ds = await parse(path);
    expect(ds.prompts.map((p) => p.text)).toEqual(['First prompt', 'Second prompt']);
    const leftover = ds.calls.find((c) => c.ts === at(1.2));
    // Not the newest prompt, but the one active when the call happened.
    expect(leftover).toMatchObject({ prompt: 0, cost: 0.05 });
    // The open second turn must not pick up the leftover's completion time.
    expect(ds.turns).toEqual([expect.objectContaining({ durationMs: 3000 })]);
  });

  it('splits a recorded cost by token counts when no prices are known', async () => {
    const path = join(dir, 'noprice.db');
    const db = new sqlite!.DatabaseSync(path);
    db.exec(V2_TABLES);
    const insert = (table: string, row: Record<string, unknown>) => {
      const keys = Object.keys(row);
      db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...(Object.values(row) as never[]));
    };
    insert('session_v2', session(SID, null, 'build', 'Mystery', 1, 'mystery-model'));
    insert('session_message', user('u', SID, at(1), 'Go'));
    insert(
      'session_message',
      assistant('a', SID, at(2), { input: 100, output: 50, reasoning: 50, cache: { read: 300, write: 0 } }, 1, [], {}, 'mystery-model'),
    );
    db.close();
    const ds = await parse(path);
    const call = ds.calls[0];
    expect(call.model).toBe('mystery-model');
    expect(call.cost).toBeCloseTo(1, 10);
    // 100 input + 100 output + 300 cache read + 0 cache write = 500 tokens.
    expect(call.costIn).toBeCloseTo(0.2, 10);
    expect(call.costOut).toBeCloseTo(0.2, 10);
    expect(call.costCr).toBeCloseTo(0.6, 10);
    expect(call.costCw).toBe(0);
  });
});
