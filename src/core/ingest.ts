import { cacheReadPrice, costOf } from './pricing';
import type {
  ApiCall,
  ApiError,
  Command,
  Compaction,
  Dataset,
  Denial,
  HistoryEntry,
  HookEvent,
  LiveSession,
  Prompt,
  Session,
  Source,
  SkillUse,
  StatsCache,
  Subagent,
  ToolCall,
  Turn,
} from './types';

export type FileKind =
  | { kind: 'transcript'; project: string; sid: string }
  | { kind: 'subagent'; project: string; sid: string; agentId: string }
  | { kind: 'subagent-meta'; project: string; sid: string; agentId: string }
  | { kind: 'subagent-skill'; project: string; sid: string; agentId: string }
  | { kind: 'rollout'; sid: string }
  | { kind: 'database' }
  | { kind: 'history' }
  | { kind: 'stats' }
  | { kind: 'live' };

const UUID_JSONL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

// Identifies a file by its path in the zip. Works regardless of which
// directory the user zipped from (~/.claude, projects/, a single project).
export function classifyPath(rawPath: string): FileKind | null {
  const path = rawPath.replace(/\\/g, '/');
  if (path.endsWith('/') || path.includes('__MACOSX/')) return null;
  const parts = path.split('/').filter(Boolean);
  const base = parts[parts.length - 1] ?? '';
  if (parts.includes('tool-results') || parts.includes('file-history')) return null;
  if (base === 'history.jsonl') return { kind: 'history' };
  if (base === 'stats-cache.json') return { kind: 'stats' };
  if (parts[parts.length - 2] === 'sessions' && /^\d+\.json$/.test(base)) return { kind: 'live' };

  const si = parts.lastIndexOf('subagents');
  if (si >= 1 && si === parts.length - 2) {
    const sid = parts[si - 1];
    const project = si >= 2 ? parts[si - 2] : '(no project)';
    const agentId = base.replace(/^agent-/, '').split('.')[0];
    if (base.endsWith('.jsonl')) return { kind: 'subagent', project, sid, agentId };
    if (base.endsWith('.meta.json')) return { kind: 'subagent-meta', project, sid, agentId };
    if (base.endsWith('.forked-skill.json')) return { kind: 'subagent-skill', project, sid, agentId };
    return null;
  }
  if (UUID_JSONL.test(base)) {
    const project = parts.length >= 2 ? parts[parts.length - 2] : '(no project)';
    return { kind: 'transcript', project, sid: base.slice(0, -6) };
  }
  return null;
}

// A project directory name is the cwd with every character outside [a-zA-Z0-9] replaced by "-".
export function projectKeyFromCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function prettyCwd(cwd: string): string {
  return cwd.replace(/^\/(Users|home)\/[^/]+/, '~');
}

export const IMAGE_TOKENS = 1600;
export const CHARS_PER_TOKEN = 4;
const PROMPT_TEXT_LIMIT = 200;
const RUNNER_TWO_WORDS = new Set(['npx', 'pnpm', 'npm', 'yarn', 'bunx', 'bun', 'git', 'gh', 'docker', 'supabase', 'nx', 'uv', 'cargo', 'go', 'make', 'brew']);
const SKIP_PROMPT_PREFIXES = ['<local-command', '<task-notification', '<command-message', '<system-reminder', '[Request interrupted', '<bash-'];

interface ContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rec = any;

interface PendingCarry {
  tool: ToolCall;
  count: number;
  price: number;
}

interface FileState {
  kind: 'transcript' | 'subagent';
  project: string;
  sid: string;
  agentId: string | null;
  toolById: Map<string, ToolCall>;
  pending: PendingCarry[];
  callCount: number;
  priceSum: number;
  prompt: number;
  pendingSlash: { name: string; prompt: number; ts: number } | null;
  cwd: string;
}

export function bashHead(command: string): string {
  let c = command.trim();
  for (;;) {
    const m = c.match(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/);
    if (!m) break;
    c = c.slice(m[0].length);
  }
  c = c.replace(/^(\w+=("[^"]*"|'[^']*'|\S*)\s+)+/, '');
  const words = c.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '(empty)';
  const first = words[0].replace(/^.*\//, '');
  if (RUNNER_TWO_WORDS.has(first) && words[1] && !words[1].startsWith('-')) return `${first} ${words[1]}`;
  return first;
}

function toolDetail(name: string, input: Record<string, unknown>, cwd: string): string {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  switch (name) {
    case 'Bash':
      return bashHead(str('command'));
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const p = str('file_path') || str('notebook_path');
      return cwd && p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : prettyCwd(p);
    }
    case 'Agent':
    case 'Task':
      return str('subagent_type') || 'general-purpose';
    case 'Skill':
      return str('skill');
    case 'WebFetch':
      try {
        return new URL(str('url')).hostname;
      } catch {
        return '';
      }
    default:
      return '';
  }
}

function resultSize(content: unknown): { chars: number; images: number } {
  if (typeof content === 'string') return { chars: content.length, images: 0 };
  let chars = 0;
  let images = 0;
  if (Array.isArray(content)) {
    for (const b of content as ContentBlock[]) {
      if (b?.type === 'image') images++;
      else if (typeof b?.text === 'string') chars += b.text.length;
    }
  }
  return { chars, images };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as ContentBlock[])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function between(s: string, open: string, close: string): string {
  const i = s.indexOf(open);
  if (i < 0) return '';
  const j = s.indexOf(close, i + open.length);
  return j < 0 ? '' : s.slice(i + open.length, j).trim();
}

const tsOf = (r: Rec): number => (typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : 0);

export class Ingestor {
  protected sessions = new Map<string, Session>();
  protected calls: ApiCall[] = [];
  protected tools: ToolCall[] = [];
  protected prompts: Prompt[] = [];
  protected skills: SkillUse[] = [];
  protected commands: Command[] = [];
  protected compactions: Compaction[] = [];
  protected turns: Turn[] = [];
  protected denials: Denial[] = [];
  protected hooks: HookEvent[] = [];
  protected apiErrors: ApiError[] = [];
  protected subagents = new Map<string, Subagent>();
  protected history: HistoryEntry[] = [];
  protected live: LiveSession[] = [];
  protected stats: StatsCache | null = null;
  protected seenRequests = new Set<string>();
  protected seenToolUses = new Set<string>();
  protected cwdByProject = new Map<string, Map<string, number>>();
  protected unknownModels = new Set<string>();
  protected files = { transcripts: 0, subagents: 0, skipped: 0, badLines: 0 };
  private file: FileState | null = null;

  protected readonly tool: Source = 'claude';

  constructor(protected sourceName: string) {}

  skip() {
    this.files.skipped++;
  }

  beginFile(k: FileKind) {
    if (k.kind !== 'transcript' && k.kind !== 'subagent') return;
    if (k.kind === 'transcript') this.files.transcripts++;
    else this.files.subagents++;
    this.file = {
      kind: k.kind,
      project: k.project,
      sid: k.sid,
      agentId: k.kind === 'subagent' ? k.agentId : null,
      toolById: new Map(),
      pending: [],
      callCount: 0,
      priceSum: 0,
      prompt: -1,
      pendingSlash: null,
      cwd: '',
    };
    if (k.kind === 'subagent') this.subagent(k.project, k.sid, k.agentId);
  }

  endFile() {
    if (this.file) this.flushCarry(this.file);
    this.file = null;
  }

  // One JSONL line from a transcript (main thread or subagent).
  line(raw: string) {
    const f = this.file;
    if (!f || raw.length === 0) return;
    let r: Rec;
    try {
      r = JSON.parse(raw);
    } catch {
      this.files.badLines++;
      return;
    }
    const ts = tsOf(r);
    const session = this.session(f.sid, f.project);
    if (ts) {
      if (!session.firstTs || ts < session.firstTs) session.firstTs = ts;
      if (ts > session.lastTs) session.lastTs = ts;
      if (f.agentId) {
        const sa = this.subagent(f.project, f.sid, f.agentId);
        if (!sa.firstTs || ts < sa.firstTs) sa.firstTs = ts;
        if (ts > sa.lastTs) sa.lastTs = ts;
      }
    }
    if (typeof r.cwd === 'string' && r.cwd) {
      f.cwd ||= r.cwd;
      if (!session.cwd) session.cwd = r.cwd;
      this.noteCwd(f.project, r.cwd);
    }
    if (typeof r.gitBranch === 'string' && r.gitBranch) session.branch = r.gitBranch;
    if (typeof r.version === 'string' && r.version) session.version = r.version;
    if (typeof r.entrypoint === 'string' && r.entrypoint) session.entrypoint = r.entrypoint;
    const sub = f.kind === 'subagent' || r.isSidechain === true;

    switch (r.type) {
      case 'assistant':
        this.assistant(f, r, ts, sub, session.id);
        break;
      case 'user':
        this.user(f, r, ts, sub, session.id);
        break;
      case 'system':
        this.system(f, r, ts, session.id);
        break;
      case 'attachment': {
        const a = r.attachment ?? {};
        if (typeof a.type === 'string' && a.type.startsWith('hook_') && a.hookName) {
          const ok = a.type === 'hook_success' || a.type === 'hook_additional_context';
          this.hooks.push({ ts, sid: session.id, project: f.project, name: String(a.hookName), ok });
        }
        break;
      }
      case 'ai-title':
        if (typeof r.aiTitle === 'string') session.title = r.aiTitle;
        break;
      case 'custom-title':
        if (typeof r.customTitle === 'string') session.title = r.customTitle;
        break;
      case 'cost-state':
        if (f.kind === 'transcript') {
          session.reported = {
            cost: Number(r.totalCostUSD) || 0,
            linesAdded: Number(r.totalLinesAdded) || 0,
            linesRemoved: Number(r.totalLinesRemoved) || 0,
            apiMs: Number(r.totalAPIDuration) || 0,
            toolMs: Number(r.totalToolDuration) || 0,
          };
        }
        break;
    }
  }

  private assistant(f: FileState, r: Rec, ts: number, sub: boolean, sid: string) {
    const m = r.message ?? {};
    const model: string = m.model ?? 'unknown';
    if (r.isApiErrorMessage || model === '<synthetic>') {
      if (r.isApiErrorMessage) {
        this.apiErrors.push({ ts, sid, project: f.project, text: textOf(m.content).slice(0, 200) });
      }
      return;
    }
    const rid: string | undefined = r.requestId ?? m.id;
    const u = m.usage;
    if (rid && u && !this.seenRequests.has(rid)) {
      this.seenRequests.add(rid);
      const cc = u.cache_creation ?? {};
      const cwTotal = Number(u.cache_creation_input_tokens) || 0;
      const cw1h = Number(cc.ephemeral_1h_input_tokens) || 0;
      const cw5 = cc.ephemeral_5m_input_tokens != null ? Number(cc.ephemeral_5m_input_tokens) || 0 : cwTotal - cw1h;
      const tokens = {
        input: Number(u.input_tokens) || 0,
        cw5,
        cw1h,
        cr: Number(u.cache_read_input_tokens) || 0,
        out: Number(u.output_tokens) || 0,
      };
      const fast = u.speed === 'fast';
      const c = costOf(model, tokens, fast);
      if (!c) this.unknownModels.add(model);
      this.calls.push({
        ts,
        sid,
        project: f.project,
        model,
        effort: typeof r.effort === 'string' ? r.effort : '(none)',
        fast,
        ...tokens,
        think: Number(u.output_tokens_details?.thinking_tokens) || 0,
        costIn: c?.costIn ?? 0,
        costCw: c?.costCw ?? 0,
        costCr: c?.costCr ?? 0,
        costOut: c?.costOut ?? 0,
        cost: c?.cost ?? 0,
        stop: m.stop_reason ?? '(stream)',
        sub,
        agentId: f.agentId,
        prompt: sub ? -1 : f.prompt,
      });
      f.callCount++;
      f.priceSum += cacheReadPrice(model);
    }

    if (!Array.isArray(m.content)) return;
    for (const b of m.content as ContentBlock[]) {
      if (b?.type !== 'tool_use' || !b.id || !b.name) continue;
      if (this.seenToolUses.has(b.id)) continue;
      this.seenToolUses.add(b.id);
      const input = (b.input ?? {}) as Record<string, unknown>;
      const name = b.name;
      const server = name.startsWith('mcp__') ? name.split('__')[1] ?? null : null;
      const tool: ToolCall = {
        ts,
        sid,
        project: f.project,
        name,
        server,
        detail: toolDetail(name, input, f.cwd),
        sub,
        error: false,
        resTok: 0,
        images: 0,
        carriedTok: 0,
        carriedCost: 0,
        prompt: sub ? -1 : f.prompt,
      };
      this.tools.push(tool);
      f.toolById.set(b.id, tool);
      if (name === 'Skill' && typeof input.skill === 'string') {
        this.addSkill(ts, sid, f.project, input.skill, 'tool', tool.prompt);
      }
    }
  }

  private user(f: FileState, r: Rec, ts: number, sub: boolean, sid: string) {
    const content = r.message?.content;
    if (Array.isArray(content)) {
      for (const b of content as ContentBlock[]) {
        if (b?.type !== 'tool_result' || !b.tool_use_id) continue;
        const tool = f.toolById.get(b.tool_use_id);
        if (!tool) continue;
        const { chars, images } = resultSize(b.content);
        tool.error = b.is_error === true;
        tool.images = images;
        tool.resTok = Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKENS;
        f.pending.push({ tool, count: f.callCount, price: f.priceSum });
        if (typeof r.toolDenialKind === 'string') {
          this.denials.push({ ts, sid, project: f.project, kind: r.toolDenialKind, tool: tool.name });
        }
      }
    }
    if (sub) return;
    const text = textOf(content);
    if (!text) return;

    if (r.isMeta) {
      // Skill invoked by a slash command: right after <command-name> comes a meta message with the skill's content.
      if (f.pendingSlash && text.startsWith('Base directory for this skill')) {
        const p = f.pendingSlash;
        this.addSkill(p.ts, sid, f.project, p.name, 'slash', p.prompt);
      }
      f.pendingSlash = null;
      return;
    }
    if (r.isCompactSummary || r.isVisibleInTranscriptOnly) return;

    if (text.includes('<command-name>')) {
      const name = between(text, '<command-name>', '</command-name>').replace(/^\//, '');
      if (!name) return;
      const args = between(text, '<command-args>', '</command-args>');
      this.commands.push({ ts, sid, project: f.project, name });
      f.prompt = this.addPrompt(ts, sid, f.project, `/${name}${args ? ' ' + args : ''}`, 'command');
      f.pendingSlash = { name, prompt: f.prompt, ts };
      return;
    }
    f.pendingSlash = null;
    const trimmed = text.trimStart();
    if (SKIP_PROMPT_PREFIXES.some((p) => trimmed.startsWith(p))) return;
    f.prompt = this.addPrompt(ts, sid, f.project, trimmed, 'text');
  }

  private system(f: FileState, r: Rec, ts: number, sid: string) {
    switch (r.subtype) {
      case 'compact_boundary': {
        const m = r.compactMetadata ?? {};
        this.compactions.push({
          ts,
          sid,
          project: f.project,
          trigger: String(m.trigger ?? 'unknown'),
          pre: Number(m.preTokens) || 0,
          post: Number(m.postTokens) || 0,
          durationMs: Number(m.durationMs) || 0,
        });
        // After a compaction, tool results drop out of the context.
        this.flushCarry(f);
        break;
      }
      case 'turn_duration':
        this.turns.push({ ts, sid, project: f.project, durationMs: Number(r.durationMs) || 0 });
        break;
      case 'stop_hook_summary': {
        const errors = Array.isArray(r.hookErrors) ? r.hookErrors.length : 0;
        const infos: Rec[] = Array.isArray(r.hookInfos) ? r.hookInfos : [];
        for (const info of infos) {
          const cmd = String(info?.command ?? 'Stop');
          const name = 'Stop: ' + (cmd.match(/[\w.-]+\.(sh|py|js|ts|mjs)/)?.[0] ?? cmd.slice(0, 40));
          this.hooks.push({ ts, sid, project: f.project, name, ok: errors === 0 });
        }
        break;
      }
    }
  }

  // Estimate of how many context tokens tool results "carried": result size ×
  // number of subsequent API calls (until the end of the file or the next compaction).
  private flushCarry(f: FileState) {
    for (const p of f.pending) {
      p.tool.carriedTok += p.tool.resTok * (f.callCount - p.count);
      p.tool.carriedCost += p.tool.resTok * (f.priceSum - p.price);
    }
    f.pending = [];
  }

  protected addPrompt(ts: number, sid: string, project: string, text: string, kind: Prompt['kind']): number {
    const id = this.prompts.length;
    this.prompts.push({
      id,
      ts,
      sid,
      project,
      text: text.length > PROMPT_TEXT_LIMIT ? text.slice(0, PROMPT_TEXT_LIMIT) + '…' : text,
      kind,
      skills: [],
      calls: 0,
      tools: 0,
      tokens: 0,
      cost: 0,
      subCost: 0,
    });
    return id;
  }

  protected addSkill(ts: number, sid: string, project: string, name: string, source: SkillUse['source'], prompt: number) {
    this.skills.push({ ts, sid, project, name, source, prompt });
  }

  protected session(id: string, project: string): Session {
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, source: this.tool, project, cwd: '', title: '', branch: '', version: '', entrypoint: '', firstTs: 0, lastTs: 0, reported: null };
      this.sessions.set(id, s);
    }
    return s;
  }

  private subagent(project: string, sid: string, agentId: string): Subagent {
    let s = this.subagents.get(agentId);
    if (!s) {
      s = { agentId, sid, project, agentType: '(unknown)', description: '', skill: null, firstTs: 0, lastTs: 0 };
      this.subagents.set(agentId, s);
    }
    return s;
  }

  protected noteCwd(project: string, cwd: string) {
    let m = this.cwdByProject.get(project);
    if (!m) this.cwdByProject.set(project, (m = new Map()));
    m.set(cwd, (m.get(cwd) ?? 0) + 1);
  }

  // Small JSON files: subagent metadata, live sessions, stats-cache.
  json(k: FileKind, text: string) {
    let d: Rec;
    try {
      d = JSON.parse(text);
    } catch {
      this.files.badLines++;
      return;
    }
    switch (k.kind) {
      case 'subagent-meta': {
        const s = this.subagent(k.project, k.sid, k.agentId);
        s.agentType = String(d.agentType ?? s.agentType);
        s.description = String(d.description ?? '');
        break;
      }
      case 'subagent-skill': {
        const s = this.subagent(k.project, k.sid, k.agentId);
        s.skill = typeof d.skillName === 'string' ? d.skillName : null;
        break;
      }
      case 'live': {
        const cwd = String(d.cwd ?? '');
        this.live.push({
          pid: Number(d.pid) || 0,
          sessionId: String(d.sessionId ?? ''),
          project: projectKeyFromCwd(cwd),
          cwd,
          name: String(d.name ?? ''),
          status: String(d.status ?? ''),
          kind: String(d.kind ?? ''),
          version: String(d.version ?? ''),
          startedAt: Number(d.startedAt) || 0,
          updatedAt: Number(d.updatedAt) || 0,
        });
        if (cwd) this.noteCwd(projectKeyFromCwd(cwd), cwd);
        break;
      }
      case 'stats':
        this.stats = {
          firstSessionDate: d.firstSessionDate ?? null,
          totalSessions: Number(d.totalSessions) || 0,
          totalMessages: Number(d.totalMessages) || 0,
          lastComputedDate: d.lastComputedDate ?? null,
        };
        break;
    }
  }

  historyLine(raw: string) {
    if (!raw) return;
    let d: Rec;
    try {
      d = JSON.parse(raw);
    } catch {
      this.files.badLines++;
      return;
    }
    const cwd = String(d.project ?? '');
    const text = String(d.display ?? '');
    this.history.push({ ts: Number(d.timestamp) || 0, source: 'claude', project: projectKeyFromCwd(cwd), command: text.startsWith('/'), len: text.length });
    if (cwd) this.noteCwd(projectKeyFromCwd(cwd), cwd);
  }

  finalize(): Dataset {
    const prompts = this.prompts;
    const subagents = [...this.subagents.values()];

    // Subagents run during a main-thread prompt, so their calls are assigned
    // to the parent session's last prompt before that moment.
    const promptsBySid = new Map<string, Prompt[]>();
    for (const p of prompts) {
      let arr = promptsBySid.get(p.sid);
      if (!arr) promptsBySid.set(p.sid, (arr = []));
      arr.push(p);
    }
    for (const arr of promptsBySid.values()) arr.sort((a, b) => a.ts - b.ts);
    const promptAt = (sid: string, ts: number): number => {
      const arr = promptsBySid.get(sid);
      if (!arr || arr.length === 0) return -1;
      let lo = 0;
      let hi = arr.length - 1;
      let best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].ts <= ts) {
          best = arr[mid].id;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return best;
    };

    for (const c of this.calls) {
      if (c.prompt < 0 && c.sub) c.prompt = promptAt(c.sid, c.ts);
      if (c.prompt < 0) continue;
      const p = prompts[c.prompt];
      p.calls++;
      p.tokens += c.input + c.cw5 + c.cw1h + c.cr + c.out;
      p.cost += c.cost;
      if (c.sub) p.subCost += c.cost;
    }
    for (const t of this.tools) {
      if (t.prompt < 0 && t.sub) t.prompt = promptAt(t.sid, t.ts);
      if (t.prompt >= 0) prompts[t.prompt].tools++;
    }
    for (const s of subagents) {
      if (s.skill) {
        const prompt = promptAt(s.sid, s.firstTs);
        this.skills.push({ ts: s.firstTs, sid: s.sid, project: s.project, name: s.skill, source: 'subagent', prompt });
      }
    }
    for (const s of this.skills) {
      if (s.prompt >= 0 && !prompts[s.prompt].skills.includes(s.name)) prompts[s.prompt].skills.push(s.name);
    }

    const projects: Record<string, string> = {};
    const allKeys = new Set<string>([...this.cwdByProject.keys(), ...this.calls.map((c) => c.project), ...this.history.map((h) => h.project)]);
    for (const key of allKeys) {
      const m = this.cwdByProject.get(key);
      let best = '';
      let bestN = -1;
      // Prefer the cwd whose encoded name matches the directory key.
      for (const [cwd, n] of m ?? []) {
        const score = n + (projectKeyFromCwd(cwd) === key ? 1e9 : 0);
        if (score > bestN) {
          best = cwd;
          bestN = score;
        }
      }
      projects[key] = best ? prettyCwd(best) : key;
    }

    return {
      sources: [this.tool],
      sourceName: this.sourceName,
      generatedAt: Date.now(),
      projects,
      sessions: [...this.sessions.values()],
      calls: this.calls,
      tools: this.tools,
      prompts,
      skills: this.skills,
      commands: this.commands,
      compactions: this.compactions,
      turns: this.turns,
      denials: this.denials,
      hooks: this.hooks,
      apiErrors: this.apiErrors,
      subagents,
      history: this.history,
      live: this.live,
      stats: this.stats,
      limits: [],
      unknownModels: [...this.unknownModels],
      files: this.files,
    };
  }
}
