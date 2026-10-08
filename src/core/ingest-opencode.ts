import { CHARS_PER_TOKEN, IMAGE_TOKENS, Ingestor, bashHead, prettyCwd, projectKeyFromCwd } from './ingest';
import { priceFor, type Price } from './pricing';
import { openSqlite, type ByteSource, type SqlValue, type SqliteDatabase } from './sqlite';
import type { ApiCall, Compaction, Dataset, Prompt, Source, ToolCall } from './types';

// OpenCode keeps sessions in a SQLite database (opencode.db) instead of files:
// one row per session, message and content part. Two table generations exist:
// the current session_v2/session_message pair and the older session/message/part
// one. The v2 tables hold a migrated copy of everything the older ones had, so
// they are read first; the old message table is still scanned for the few rows
// the migration skipped (compaction calls), and a database with no v2 messages
// at all is read the old way.
//
// OpenCode records the cost of every assistant message itself, so that number
// is used as-is; the model prices are only used to split it between input,
// output and cache tokens, or to price calls when no cost was recorded.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rec = any;

const NO_PROJECT = '(no project)';
// Built-in tools. Anything else with an underscore is an MCP tool, which
// OpenCode names "<server>_<tool>".
const BUILTIN_TOOLS = new Set([
  'bash',
  'shell',
  'read',
  'write',
  'edit',
  'patch',
  'apply_patch',
  'list',
  'glob',
  'grep',
  'todowrite',
  'todoread',
  'task',
  'skill',
  'webfetch',
  'websearch',
  'question',
  'invalid',
  'multiedit',
  'execute',
  'summarize',
  'compact',
]);

const FILE_TOOLS = new Set(['read', 'write', 'edit', 'patch', 'apply_patch', 'multiedit', 'list']);
const SHELL_TOOLS = new Set(['bash', 'shell']);
const SKILL_PATH = /skills\/(?:\.system\/)?([\w.-]+)\/SKILL\.md/;

interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelRates {
  exact: Map<string, Rates>;
  byModel: Map<string, Rates>;
}

// The models.dev catalog is cached in the database itself (kv table), so its
// prices are available offline for models the built-in table doesn't know.
export function catalogRates(body: string): ModelRates {
  const exact = new Map<string, Rates>();
  const byModel = new Map<string, Rates>();
  let catalog: Rec;
  try {
    catalog = JSON.parse(body);
  } catch {
    return { exact, byModel };
  }
  for (const [provider, p] of Object.entries(catalog) as [string, Rec][]) {
    for (const [id, m] of Object.entries(p?.models ?? {}) as [string, Rec][]) {
      const cost = m?.cost;
      if (!cost || typeof cost.input !== 'number') continue;
      const rates: Rates = {
        input: cost.input,
        output: Number(cost.output) || 0,
        cacheRead: Number(cost.cache_read) || 0,
        cacheWrite: Number(cost.cache_write) || cost.input,
      };
      exact.set(`${provider}/${id}`, rates);
      if (!byModel.has(id)) byModel.set(id, rates);
    }
  }
  return { exact, byModel };
}

// Matches a model id against the models.dev catalog (what OpenCode itself
// priced with) and the built-in prices. Handles "provider/model" ids and
// dotted version numbers (claude-fable-5.1).
export function findRates(model: string, provider: string, catalog: ModelRates | null): Rates | null {
  const candidates = new Set<string>([model]);
  if (model.includes('/')) candidates.add(model.slice(model.lastIndexOf('/') + 1));
  for (const c of [...candidates]) candidates.add(c.replace(/\./g, '-'));
  if (catalog) {
    for (const c of candidates) {
      const hit = catalog.exact.get(`${provider}/${c}`) ?? catalog.exact.get(c) ?? catalog.byModel.get(c);
      if (hit) return hit;
    }
  }
  for (const c of candidates) {
    const p: Price | null = priceFor(c);
    if (p) return { input: p.input, output: p.output, cacheRead: p.cacheRead, cacheWrite: p.input * 1.25 };
  }
  return null;
}

// "<server>_<tool>" for anything that isn't a built-in.
export function mcpTool(name: string): { server: string; tool: string } | null {
  if (BUILTIN_TOOLS.has(name)) return null;
  const at = name.indexOf('_');
  if (at <= 0 || at === name.length - 1) return null;
  return { server: name.slice(0, at), tool: name.slice(at + 1) };
}

interface PendingCarry {
  tool: ToolCall;
  count: number;
  price: number;
}

interface SessionInfo {
  id: string;
  parent: string | null;
  root: string;
  project: string;
  directory: string;
  sub: boolean;
  firstTs: number;
  lastTs: number;
  callCount: number;
  priceSum: number;
  pending: PendingCarry[];
  lastCtx: number;
  compaction: Compaction | null;
  prompt: number;
  turnStart: number;
  lastAssistant: number;
  apiMs: number;
  defaultModel: string;
  defaultVariant: string;
  reportedCost: number;
  linesAdded: number;
  linesRemoved: number;
}

const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : Number(x) || 0);
const str = (x: unknown): string => (typeof x === 'string' ? x : x == null ? '' : String(x));

const relPath = (p: string, cwd: string) => (cwd && p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : prettyCwd(p));

// The label shown for a tool call and the files it touched.
function toolDetail(name: string, input: Rec, cwd: string): { detail: string; files?: string[] } {
  const s = (k: string) => str(input?.[k]);
  if (FILE_TOOLS.has(name)) {
    const p = s('filePath') || s('path');
    return { detail: p ? relPath(p, cwd) : '' };
  }
  if (SHELL_TOOLS.has(name)) return { detail: bashHead(s('command')) };
  if (name === 'grep' || name === 'glob') return { detail: s('pattern') };
  if (name === 'webfetch') {
    try {
      return { detail: new URL(s('url')).hostname };
    } catch {
      return { detail: '' };
    }
  }
  if (name === 'websearch') return { detail: s('query') };
  if (name === 'task') return { detail: s('description') || s('subagent_type') };
  if (name === 'skill') return { detail: s('name') || s('id') };
  if (name === 'apply_patch') {
    const patch = s('patch') || s('input');
    const files = patchFiles(patch);
    return { detail: files[0] ?? '', files: files.length > 1 ? files : undefined };
  }
  return { detail: '' };
}

// Files touched by an apply_patch body.
function patchFiles(patch: string): string[] {
  const out: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) {
    const p = (m[1] ?? m[2]).trim();
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

// Builds the dataset for one opencode.db (plus its -wal, when present).
export async function parseOpenCode(name: string, main: ByteSource, wal: ByteSource | null, onBytes: (n: number) => void): Promise<Dataset> {
  try {
    const db = await openSqlite(main, wal, onBytes);
    const ing = new OpenCodeIngestor(name);
    await ing.ingest(db);
    return ing.finalize();
  } finally {
    await main.close?.();
    await wal?.close?.();
  }
}

export class OpenCodeIngestor extends Ingestor {
  protected readonly tool: Source = 'opencode';
  private info = new Map<string, SessionInfo>();
  private projectDirs = new Map<string, string>();
  private seenMessages = new Set<string>();
  private catalog: ModelRates | null = null;

  constructor(sourceName: string) {
    super(sourceName);
  }

  async ingest(db: SqliteDatabase): Promise<void> {
    const tables = db.tables();
    const rows = async function* (table: string) {
      const cols = tables.get(table)?.columns ?? [];
      for await (const row of db.scan(table)) {
        const rec: Record<string, SqlValue> = {};
        for (let i = 0; i < cols.length; i++) rec[cols[i]] = row[i];
        yield rec;
      }
    };

    if (tables.has('project')) {
      for await (const r of rows('project')) {
        const id = str(r.id);
        const worktree = str(r.worktree);
        if (id && worktree) this.projectDirs.set(id, worktree);
      }
    }

    if (tables.has('session_v2')) {
      for await (const r of rows('session_v2')) this.sessionRow(r);
    }
    if (tables.has('session')) {
      for await (const r of rows('session')) {
        if (!this.info.has(str(r.id))) this.sessionRow(r);
      }
    }
    this.fixRoots();

    if (tables.has('kv')) {
      for await (const r of rows('kv')) {
        if (str(r.key) === 'models-dev:catalog') {
          const value = str(r.value);
          try {
            const kv = JSON.parse(value);
            this.catalog = catalogRates(str(kv.body));
          } catch {
            // no catalog: prices fall back to the built-in table
          }
        }
      }
    }

    let v2Messages = 0;
    if (tables.has('session_message')) {
      for await (const r of rows('session_message')) {
        this.messageRow(r);
        v2Messages++;
      }
    }

    if (v2Messages > 0) {
      // The migration left a few messages behind, mostly compaction calls.
      // They are processed after the v2 stream, so they are not allowed to
      // touch the session state (carry, context, turns); their prompt is
      // resolved by time in finalize.
      if (tables.has('message')) {
        for await (const r of rows('message')) {
          if (!this.seenMessages.has(str(r.id))) this.legacyMessage(r, [], true);
        }
      }
    } else if (tables.has('message')) {
      // A database from before OpenCode 1.18: messages and parts in two tables.
      const messages = new Map<string, Rec>();
      for await (const r of rows('message')) messages.set(str(r.id), r);
      // Parts of one message are not always adjacent: a late tool result can
      // be inserted after parts of later messages, so group them first.
      const partsByMessage = new Map<string, Rec[]>();
      if (tables.has('part')) {
        for await (const r of rows('part')) {
          const mid = str(r.message_id);
          const list = partsByMessage.get(mid);
          if (list) list.push(r);
          else partsByMessage.set(mid, [r]);
        }
      }
      for (const msg of messages.values()) this.legacyMessage(msg, partsByMessage.get(str(msg.id)) ?? []);
    }
  }

  private sessionRow(r: Record<string, SqlValue>) {
    const id = str(r.id);
    if (this.info.has(id)) return;
    const parent = str(r.parent_id) || null;
    const directory = str(r.directory) || this.projectDirs.get(str(r.project_id)) || '';
    const project = directory ? projectKeyFromCwd(directory) : NO_PROJECT;
    if (directory) this.noteCwd(project, directory);
    let model = '';
    let variant = '';
    try {
      const m = JSON.parse(str(r.model) || '{}');
      model = str(m.id);
      variant = str(m.variant);
    } catch {
      // leave the model unknown
    }
    const firstTs = num(r.time_created);
    const lastTs = num(r.time_updated);
    const info: SessionInfo = {
      id,
      parent,
      root: id,
      project,
      directory,
      sub: false,
      firstTs,
      lastTs,
      callCount: 0,
      priceSum: 0,
      pending: [],
      lastCtx: 0,
      compaction: null,
      prompt: -1,
      turnStart: 0,
      lastAssistant: 0,
      apiMs: 0,
      defaultModel: model,
      defaultVariant: variant,
      reportedCost: num(r.cost),
      linesAdded: num(r.summary_additions),
      linesRemoved: num(r.summary_deletions),
    };
    this.info.set(id, info);

    if (parent) {
      this.files.subagents++;
      info.sub = true;
      info.root = parent;
      this.subagents.set(id, {
        agentId: id,
        sid: parent,
        project,
        agentType: str(r.agent) || '(unknown)',
        description: str(r.title),
        skill: null,
        firstTs,
        lastTs,
      });
    } else {
      this.files.transcripts++;
      const s = this.session(id, project);
      s.project = project;
      s.cwd = directory;
      s.title = str(r.title);
      s.version = str(r.version);
      s.entrypoint = str(r.agent);
      s.firstTs = firstTs;
      s.lastTs = lastTs;
    }
  }

  // A child session belongs to the parent that spawned it; its calls are
  // counted as subagent calls of the root session.
  private fixRoots() {
    for (const info of this.info.values()) {
      if (!info.parent) continue;
      let root = info.parent;
      for (let guard = 0; guard < 100 && this.info.get(root)?.parent; guard++) root = this.info.get(root)?.parent as string;
      const top = this.info.get(root);
      if (top && !top.parent) {
        info.root = root;
        info.project = top.project;
        info.directory = top.directory;
        const sa = this.subagents.get(info.id);
        if (sa) sa.sid = root;
      } else {
        // The parent is gone; keep the session as its own top-level one.
        info.parent = null;
        info.root = info.id;
        info.sub = false;
        this.subagents.delete(info.id);
        this.files.subagents--;
        this.files.transcripts++;
        const s = this.session(info.id, info.project);
        s.project = info.project;
        s.cwd = info.directory;
        s.firstTs = info.firstTs;
        s.lastTs = info.lastTs;
      }
    }
  }

  private messageRow(r: Record<string, SqlValue>) {
    const id = str(r.id);
    this.seenMessages.add(id);
    const info = this.info.get(str(r.session_id));
    if (!info) return;
    let data: Rec;
    try {
      data = JSON.parse(str(r.data));
    } catch {
      this.files.badLines++;
      return;
    }
    const ts = num(r.time_created) || num(data?.time?.created);
    this.message(info, str(r.type), data, ts, null);
  }

  private legacyMessage(r: Record<string, SqlValue>, parts: Rec[], detached = false) {
    const id = str(r.id);
    this.seenMessages.add(id);
    const info = this.info.get(str(r.session_id));
    if (!info) return;
    let data: Rec;
    try {
      data = JSON.parse(str(r.data));
    } catch {
      this.files.badLines++;
      return;
    }
    const ts = num(r.time_created) || num(data?.time?.created);
    const parsed: Rec[] = [];
    for (const p of parts) {
      try {
        parsed.push(JSON.parse(str(p.data)));
      } catch {
        this.files.badLines++;
      }
    }
    this.message(info, str(data?.role), data, ts, parsed, detached);
  }

  private message(info: SessionInfo, type: string, data: Rec, ts: number, parts: Rec[] | null, detached = false) {
    const session = this.session(info.root, info.project);
    if (ts) {
      if (!session.firstTs || ts < session.firstTs) session.firstTs = ts;
      if (ts > session.lastTs) session.lastTs = ts;
      const sa = this.subagents.get(info.id);
      if (sa) {
        if (!sa.firstTs || ts < sa.firstTs) sa.firstTs = ts;
        if (ts > sa.lastTs) sa.lastTs = ts;
      }
    }
    switch (type) {
      case 'user':
        if (!detached) this.userMessage(info, data, ts, parts);
        break;
      case 'assistant':
        this.assistantMessage(info, data, ts, parts, detached);
        break;
      case 'compaction':
        if (!detached) this.compaction(info, str(data?.reason) || 'auto', ts);
        break;
      case 'idle':
        if (!detached) this.closeTurn(info, ts);
        break;
      default:
        break;
    }
  }

  private userMessage(info: SessionInfo, data: Rec, ts: number, parts: Rec[] | null) {
    if (info.sub) return;
    let text = str(data.text);
    if (parts) {
      text = parts
        .filter((p) => p?.type === 'text' && !p.synthetic)
        .map((p) => str(p.text))
        .join('\n')
        .trim();
      for (const p of parts) {
        if (p?.type === 'compaction') this.compaction(info, p.auto === false ? 'manual' : 'auto', ts);
      }
    }
    text = text.trim();
    if (!text) return;
    this.closeTurn(info, ts);
    const command = text.match(/^\/([\w-]+)/);
    info.prompt = this.addPrompt(ts, info.root, info.project, text, command ? 'command' : 'text');
    if (command) this.commands.push({ ts, sid: info.root, project: info.project, name: command[1] });
    // The prompt history goes back as far as the transcripts here, but the
    // Activity chart reads it, so every typed prompt is recorded.
    this.history.push({ ts, source: 'opencode', project: info.project, command: !!command, len: text.length });
    info.turnStart = ts;
    info.lastAssistant = 0;
  }

  // One assistant message is one model response.
  private assistantMessage(info: SessionInfo, data: Rec, ts: number, parts: Rec[] | null, detached = false) {
    const tokens = data?.tokens ?? {};
    const input = num(tokens.input);
    const output = num(tokens.output);
    const reasoning = num(tokens.reasoning);
    const cr = num(tokens.cache?.read);
    const cw = num(tokens.cache?.write);
    const totalTok = input + output + reasoning + cr + cw;
    const recorded = num(data?.cost);
    const created = num(data?.time?.created) || ts;
    const completed = num(data?.time?.completed);
    const model = str(data?.model?.id ?? data?.modelID) || info.defaultModel || 'unknown';
    const provider = str(data?.model?.providerID ?? data?.providerID);
    const variant = str(data?.model?.variant ?? data?.variant) || info.defaultVariant || '(default)';
    const error = data?.error;
    if (error && typeof error.message === 'string') {
      this.apiErrors.push({ ts: created, sid: info.root, project: info.project, text: String(error.message).slice(0, 200) });
    }

    if (totalTok > 0 || recorded > 0) {
      const rates = findRates(model, provider, this.catalog);
      const out = output + reasoning;
      const weights = rates ?? { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
      const raw = input * weights.input + cw * weights.cacheWrite + cr * weights.cacheRead + out * weights.output;
      // The recorded cost is the truth; prices only split it between token
      // types. A recorded zero stays zero (a free model); without prices the
      // split follows the token counts.
      const scale = recorded > 0 ? (raw > 0 ? recorded / raw : totalTok > 0 ? recorded / totalTok : 0) : 0;
      const costIn = input * weights.input * scale;
      const costCw = cw * weights.cacheWrite * scale;
      const costCr = cr * weights.cacheRead * scale;
      const costOut = out * weights.output * scale;
      const call: ApiCall = {
        ts: created,
        sid: info.root,
        project: info.project,
        model,
        effort: variant,
        fast: false,
        input,
        cw5: cw,
        cw1h: 0,
        cr,
        out,
        think: reasoning,
        costIn,
        costCw,
        costCr,
        costOut,
        cost: costIn + costCw + costCr + costOut,
        stop: str(data?.finish) || '(unknown)',
        sub: info.sub,
        agentId: info.sub ? info.id : null,
        prompt: info.sub || detached ? -1 : info.prompt,
      };
      this.calls.push(call);
      if (!detached) {
        info.callCount++;
        info.priceSum += rates ? rates.cacheRead / 1e6 : totalTok > 0 ? call.cost / totalTok : 0;
        info.lastCtx = input + cr;
        info.apiMs += completed > created ? completed - created : 0;
        // The call that writes the summary still carries the old context; the
        // first call smaller than the context before the compaction is the new one.
        if (info.compaction && info.lastCtx < info.compaction.pre) {
          info.compaction.post = info.lastCtx;
          info.compaction = null;
        }
      }
    }
    if (completed && !detached) info.lastAssistant = completed;

    if (Array.isArray(data?.content)) {
      for (const item of data.content) {
        if (item?.type !== 'tool') continue;
        this.toolItem(info, { name: str(item.name), id: str(item.id), state: item.state ?? {} }, created);
      }
    }
    if (parts) {
      for (const p of parts) {
        if (p?.type !== 'tool') continue;
        this.toolItem(info, { name: str(p.tool), id: str(p.callID), state: p.state ?? {} }, ts);
      }
    }
  }

  private toolItem(info: SessionInfo, item: { name: string; id: string; state: Rec }, ts: number) {
    let name = item.name || 'invalid';
    const input = item.state.input ?? {};
    const status = str(item.state.status);
    let server: string | null = null;
    const mcp = mcpTool(name);
    if (mcp) {
      server = mcp.server;
      name = `mcp__${mcp.server}__${mcp.tool}`;
    }
    const { detail, files } = toolDetail(item.name, input, info.directory);
    let chars = 0;
    let images = 0;
    const content = item.state.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c?.type === 'text') chars += str(c.text).length;
        else if (c?.type === 'file') images++;
      }
    } else if (typeof item.state.output === 'string') {
      chars = item.state.output.length;
    } else if (typeof item.state.metadata?.output === 'string') {
      chars = item.state.metadata.output.length;
    }
    const errorMessage = item.state.error?.message;
    if (typeof errorMessage === 'string' && !chars) chars = errorMessage.length;
    const exit = item.state.metadata?.exit;
    const interrupted = item.state.metadata?.interrupted === true;
    const error = status === 'error' || interrupted || (typeof exit === 'number' && exit !== 0);
    const tool: ToolCall = {
      ts,
      sid: info.root,
      project: info.project,
      name,
      server,
      detail,
      ...(files ? { files } : {}),
      sub: info.sub,
      error,
      resTok: Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKENS,
      images,
      carriedTok: 0,
      carriedCost: 0,
      prompt: info.sub ? -1 : info.prompt,
    };
    this.tools.push(tool);
    info.pending.push({ tool, count: info.callCount, price: info.priceSum });
    if (typeof errorMessage === 'string' && /abort/i.test(errorMessage)) {
      this.denials.push({ ts, sid: info.root, project: info.project, kind: 'interrupted', tool: name });
    }
    const skill = item.name === 'skill' ? str(input.name ?? input.id) : '';
    if (skill) this.addSkill(ts, info.root, info.project, skill, 'tool', tool.prompt);
    if (item.name === 'read' || item.name === 'write' || item.name === 'edit') {
      // A SKILL.md read through the file tools counts as a skill use too.
      const path = str(input.filePath ?? input.path);
      const fromPath = path.match(SKILL_PATH)?.[1];
      if (fromPath) this.addSkill(ts, info.root, info.project, fromPath, 'tool', tool.prompt);
    }
  }

  private compaction(info: SessionInfo, trigger: string, ts: number) {
    if (info.compaction) return;
    const c: Compaction = { ts, sid: info.root, project: info.project, trigger, pre: info.lastCtx, post: 0, durationMs: 0 };
    this.compactions.push(c);
    info.compaction = c;
    this.flush(info);
  }

  // A turn runs from a prompt until the next prompt or the idle message.
  private closeTurn(info: SessionInfo, ts: number) {
    if (info.turnStart && info.lastAssistant >= info.turnStart && ts >= info.turnStart) {
      this.turns.push({ ts: info.turnStart, sid: info.root, project: info.project, durationMs: info.lastAssistant - info.turnStart });
    }
    info.turnStart = 0;
    info.lastAssistant = 0;
  }

  // Tool results are carried until a compaction or the end of the session.
  private flush(info: SessionInfo) {
    for (const x of info.pending) {
      x.tool.carriedTok += x.tool.resTok * (info.callCount - x.count);
      x.tool.carriedCost += x.tool.resTok * (info.priceSum - x.price);
    }
    info.pending = [];
  }

  finalize(): Dataset {
    // Calls and tools that were not seen in order (subagent sessions and the
    // messages the migration left in the old table) get the prompt that was
    // active at their time.
    const bySid = new Map<string, Prompt[]>();
    for (const p of this.prompts) {
      const list = bySid.get(p.sid);
      if (list) list.push(p);
      else bySid.set(p.sid, [p]);
    }
    for (const list of bySid.values()) list.sort((a, b) => a.ts - b.ts);
    const promptAt = (sid: string, ts: number): number => {
      const list = bySid.get(sid);
      if (!list || list.length === 0) return -1;
      let lo = 0;
      let hi = list.length - 1;
      let best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid].ts <= ts) {
          best = list[mid].id;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return best;
    };
    for (const c of this.calls) if (c.prompt < 0) c.prompt = promptAt(c.sid, c.ts);
    for (const t of this.tools) if (t.prompt < 0) t.prompt = promptAt(t.sid, t.ts);

    const childrenCost = new Map<string, number>();
    for (const info of this.info.values()) {
      if (!info.parent) continue;
      childrenCost.set(info.root, (childrenCost.get(info.root) ?? 0) + info.reportedCost);
      this.flush(info);
      this.closeTurn(info, info.lastTs || info.lastAssistant);
    }
    for (const info of this.info.values()) {
      if (info.parent) continue;
      this.flush(info);
      this.closeTurn(info, info.lastTs || info.lastAssistant);
      const s = this.sessions.get(info.id);
      if (s) {
        s.reported = {
          cost: info.reportedCost + (childrenCost.get(info.id) ?? 0),
          linesAdded: info.linesAdded,
          linesRemoved: info.linesRemoved,
          apiMs: info.apiMs,
          toolMs: 0,
        };
      }
    }
    return super.finalize();
  }
}
