import { windowLabel } from './format';
import type { ApiCall, Dataset, Prompt, Session, Source, ToolCall } from './types';

export interface Filter {
  from: number | null;
  to: number | null;
  project: string | null;
  // Claude Code, Codex or OpenCode only, when the report combines tools.
  source: Source | null;
}

export function sourceLabel(source: Source): string {
  return source === 'claude' ? 'Claude Code' : source === 'codex' ? 'Codex' : 'OpenCode';
}

// "Claude Code + Codex + OpenCode" for a set of tools.
export function toolTitle(sources: Source[]): string {
  return sources.map(sourceLabel).join(' + ');
}

export interface Row {
  key: string;
  label: string;
  value: number;
  [extra: string]: string | number | boolean | null | string[];
}

export interface Series {
  key: string;
  label: string;
  color: string;
  values: number[];
}

export type GroupBy = 'model' | 'project' | 'tokenType';

const MAX_SERIES = 7;
export const OTHER_COLOR = 'var(--series-other)';
const SLOT = (i: number) => `var(--series-${i + 1})`;

// A row's tool comes from its session.
const inRange = (f: Filter, sourceOf: Map<string, Source>) => (x: { ts: number; project: string; sid: string }) =>
  (f.from == null || x.ts >= f.from) &&
  (f.to == null || x.ts < f.to) &&
  (f.project == null || x.project === f.project) &&
  (f.source == null || sourceOf.get(x.sid) === f.source);

export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysBetween(fromTs: number, toTs: number): string[] {
  const out: string[] = [];
  const d = new Date(fromTs);
  d.setHours(0, 0, 0, 0);
  while (d.getTime() <= toTs) {
    out.push(dayKey(d.getTime()));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

function groupSum<T>(items: T[], key: (x: T) => string, val: (x: T) => number): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of items) {
    const k = key(x);
    m.set(k, (m.get(k) ?? 0) + val(x));
  }
  return m;
}

// Shell tools: Claude Code's Bash, Codex's exec_command, OpenCode's bash.
const SHELL_TOOLS = new Set(['Bash', 'bash', 'exec_command', 'shell_command', 'shell', 'local_shell', 'container.exec']);
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'edit', 'write', 'patch'];

const total = (c: ApiCall) => c.input + c.cw5 + c.cw1h + c.cr + c.out;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
// No spread: Math.min(...xs) throws at ~65K arguments in some browsers.
const minOf = (xs: number[]) => xs.reduce((a, b) => (b < a ? b : a), Infinity);
const maxOf = (xs: number[]) => xs.reduce((a, b) => (b > a ? b : a), -Infinity);

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[i];
}

// Color follows the entity (model, project), not its position after filtering:
// the order is fixed once, over the whole dataset.
export interface Palette {
  model: Map<string, string>;
  project: Map<string, string>;
}

export function buildPalette(ds: Dataset): Palette {
  const rank = (m: Map<string, number>) => {
    const out = new Map<string, string>();
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([k], i) => out.set(k, i < MAX_SERIES ? SLOT(i) : OTHER_COLOR));
    return out;
  };
  return {
    model: rank(groupSum(ds.calls, (c) => c.model, (c) => c.cost)),
    project: rank(groupSum(ds.calls, (c) => c.project, (c) => c.cost)),
  };
}

export const TOKEN_TYPES = [
  { key: 'costCr', label: 'Cache read', tokens: (c: ApiCall) => c.cr },
  { key: 'costOut', label: 'Output (incl. thinking)', tokens: (c: ApiCall) => c.out },
  { key: 'costCw', label: 'Cache write', tokens: (c: ApiCall) => c.cw5 + c.cw1h },
  { key: 'costIn', label: 'Uncached input', tokens: (c: ApiCall) => c.input },
] as const;

export function buildView(ds: Dataset, f: Filter, palette: Palette, groupBy: GroupBy) {
  const sourceOf = new Map(ds.sessions.map((s) => [s.id, s.source]));
  const keep = inRange(f, sourceOf);
  const calls = ds.calls.filter(keep);
  const tools = ds.tools.filter(keep);
  const prompts = ds.prompts.filter(keep);
  const skills = ds.skills.filter(keep);
  const commands = ds.commands.filter(keep);
  const compactions = ds.compactions.filter(keep);
  const turns = ds.turns.filter(keep);
  const denials = ds.denials.filter(keep);
  const hooks = ds.hooks.filter(keep);
  const apiErrors = ds.apiErrors.filter(keep);
  // History rows have no session, but know their tool.
  const keepHistory = inRange({ ...f, source: null }, sourceOf);
  const history = ds.history.filter((h) => keepHistory({ ...h, sid: '' }) && (f.source == null || h.source === f.source));
  const label = (p: string) => ds.projects[p] ?? p;
  const sessionById = new Map<string, Session>(ds.sessions.map((s) => [s.id, s]));
  const subById = new Map(ds.subagents.map((s) => [s.agentId, s]));

  // --- KPI
  const cost = sum(calls.map((c) => c.cost));
  const tokens = sum(calls.map(total));
  const inputSide = sum(calls.map((c) => c.input + c.cw5 + c.cw1h + c.cr));
  const cr = sum(calls.map((c) => c.cr));
  const out = sum(calls.map((c) => c.out));
  const think = sum(calls.map((c) => c.think));
  const subCost = sum(calls.filter((c) => c.sub).map((c) => c.cost));
  const sessionIds = new Set(calls.map((c) => c.sid));
  const reportedSessions = ds.sessions.filter((s) => s.reported && sessionIds.has(s.id));
  const reportedIds = new Set(reportedSessions.map((s) => s.id));
  const reported = {
    cost: sum(reportedSessions.map((s) => s.reported!.cost)),
    computed: sum(calls.filter((c) => reportedIds.has(c.sid)).map((c) => c.cost)),
    linesAdded: sum(reportedSessions.map((s) => s.reported!.linesAdded)),
    linesRemoved: sum(reportedSessions.map((s) => s.reported!.linesRemoved)),
    sessions: reportedSessions.length,
  };
  const realPrompts = prompts.filter((p) => p.kind === 'text' || p.calls > 0);
  const kpi = {
    cost,
    tokens,
    calls: calls.length,
    sessions: sessionIds.size,
    prompts: realPrompts.length,
    tools: tools.length,
    cacheHit: inputSide ? cr / inputSide : 0,
    out,
    thinkShare: out ? think / out : 0,
    subShare: cost ? subCost / cost : 0,
    costPerPrompt: realPrompts.length ? sum(realPrompts.map((p) => p.cost)) / realPrompts.length : 0,
    reported,
  };

  // --- Daily cost
  const tsList = calls.map((c) => c.ts).filter(Boolean);
  const days = tsList.length ? daysBetween(minOf(tsList), maxOf(tsList)) : [];
  const dayIdx = new Map(days.map((d, i) => [d, i]));
  const seriesMap = new Map<string, Series>();
  const addTo = (key: string, lbl: string, color: string, di: number, v: number) => {
    let s = seriesMap.get(key);
    if (!s) seriesMap.set(key, (s = { key, label: lbl, color, values: new Array(days.length).fill(0) }));
    s.values[di] += v;
  };
  for (const c of calls) {
    const di = dayIdx.get(dayKey(c.ts));
    if (di == null) continue;
    if (groupBy === 'tokenType') {
      TOKEN_TYPES.forEach((t, i) => addTo(t.key, t.label, SLOT(i), di, c[t.key]));
    } else {
      const k = groupBy === 'model' ? c.model : c.project;
      const color = (groupBy === 'model' ? palette.model : palette.project).get(k) ?? OTHER_COLOR;
      if (color === OTHER_COLOR) addTo('__other', 'Other', OTHER_COLOR, di, c.cost);
      else addTo(k, groupBy === 'model' ? k : label(k), color, di, c.cost);
    }
  }
  const slotOrder = (s: Series) => (s.key === '__other' ? 99 : Number(s.color.match(/\d+/)?.[0] ?? 98));
  const daily = { days, series: [...seriesMap.values()].sort((a, b) => slotOrder(a) - slotOrder(b)) };
  const dayCost = new Map<string, number>();
  for (const c of calls) dayCost.set(dayKey(c.ts), (dayCost.get(dayKey(c.ts)) ?? 0) + c.cost);
  const peakDay = [...dayCost.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
  const activeDays = dayCost.size;

  // --- Cost breakdowns
  const breakdown = (key: (c: ApiCall) => string, lbl: (k: string) => string): Row[] => {
    const m = new Map<string, { cost: number; tokens: number; calls: number; out: number }>();
    for (const c of calls) {
      const k = key(c);
      const r = m.get(k) ?? { cost: 0, tokens: 0, calls: 0, out: 0 };
      r.cost += c.cost;
      r.tokens += total(c);
      r.calls++;
      r.out += c.out;
      m.set(k, r);
    }
    return [...m.entries()]
      .map(([k, r]) => ({ key: k, label: lbl(k), value: r.cost, tokens: r.tokens, calls: r.calls, out: r.out, share: cost ? r.cost / cost : 0 }))
      .sort((a, b) => b.value - a.value);
  };
  const byProject = breakdown((c) => c.project, label);
  const byModel = breakdown((c) => c.model, (k) => k);
  const byEffort = breakdown((c) => c.effort, (k) => k);
  const byThread = breakdown((c) => (c.sub ? 'Subagents' : 'Main thread'), (k) => k);
  const bySource = breakdown((c) => sourceLabel(sourceOf.get(c.sid) ?? 'claude'), (k) => k);
  const byTokenType: Row[] = TOKEN_TYPES.map((t) => ({
    key: t.key,
    label: t.label,
    value: sum(calls.map((c) => c[t.key])),
    tokens: sum(calls.map(t.tokens)),
    share: 0,
  }))
    // Codex (OpenAI) has no cache writes.
    .filter((r) => r.key !== 'costCw' || calls.some((c) => sourceOf.get(c.sid) !== 'codex'))
    .map((r) => ({ ...r, share: cost ? r.value / cost : 0 }));

  // --- Most expensive prompts and sessions
  const topPrompts = [...realPrompts]
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 100)
    .map((p: Prompt) => ({
      key: String(p.id),
      label: p.text,
      value: p.cost,
      ts: p.ts,
      project: label(p.project),
      session: sessionById.get(p.sid)?.title ?? '',
      calls: p.calls,
      tools: p.tools,
      tokens: p.tokens,
      subCost: p.subCost,
      skills: p.skills,
    }));

  const sessAgg = new Map<string, { cost: number; calls: number; tokens: number; maxCtx: number; first: number; last: number }>();
  for (const c of calls) {
    const r = sessAgg.get(c.sid) ?? { cost: 0, calls: 0, tokens: 0, maxCtx: 0, first: Infinity, last: 0 };
    r.cost += c.cost;
    r.calls++;
    r.tokens += total(c);
    if (!c.sub) r.maxCtx = Math.max(r.maxCtx, c.input + c.cw5 + c.cw1h + c.cr);
    r.first = Math.min(r.first, c.ts);
    r.last = Math.max(r.last, c.ts);
    sessAgg.set(c.sid, r);
  }
  const countBySid = (xs: { sid: string }[]) => groupSum(xs, (x) => x.sid, () => 1);
  const toolsBySid = countBySid(tools);
  const compBySid = countBySid(compactions);
  const promptsBySid = countBySid(realPrompts);
  const subsBySid = groupSum(ds.subagents.filter((s) => sessionIds.has(s.sid)), (s) => s.sid, () => 1);
  const topSessions = [...sessAgg.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, 100)
    .map(([sid, r]) => {
      const s = sessionById.get(sid);
      return {
        key: sid,
        label: s?.title || sid.slice(0, 8),
        value: r.cost,
        tool: sourceLabel(s?.source ?? 'claude'),
        project: label(s?.project ?? ''),
        branch: s?.branch ?? '',
        ts: r.first,
        durationMs: r.last - r.first,
        calls: r.calls,
        prompts: promptsBySid.get(sid) ?? 0,
        tools: toolsBySid.get(sid) ?? 0,
        tokens: r.tokens,
        maxCtx: r.maxCtx,
        compactions: compBySid.get(sid) ?? 0,
        subagents: subsBySid.get(sid) ?? 0,
      };
    });

  // --- Tools
  // A key can be a list: a Codex patch that touches several files counts once for each.
  const toolRows = (key: (t: ToolCall) => string | string[] | null, lbl: (k: string) => string = (k) => k): Row[] => {
    const m = new Map<string, { n: number; err: number; resTok: number; carriedTok: number; carriedCost: number; images: number }>();
    for (const t of tools) {
      const keys = key(t);
      if (keys == null) continue;
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        const r = m.get(k) ?? { n: 0, err: 0, resTok: 0, carriedTok: 0, carriedCost: 0, images: 0 };
        r.n++;
        if (t.error) r.err++;
        r.resTok += t.resTok;
        r.carriedTok += t.carriedTok;
        r.carriedCost += t.carriedCost;
        r.images += t.images;
        m.set(k, r);
      }
    }
    return [...m.entries()]
      .map(([k, r]) => ({ key: k, label: lbl(k), value: r.n, count: r.n, errors: r.err, errorRate: r.n ? r.err / r.n : 0, resTok: r.resTok, carriedTok: r.carriedTok, carriedCost: r.carriedCost, images: r.images }))
      .sort((a, b) => b.value - a.value);
  };
  const toolName = (t: ToolCall) => prettyTool(t.name);
  const byTool = toolRows(toolName);
  const byServer = toolRows((t) => t.server);
  const byBash = toolRows((t) => (SHELL_TOOLS.has(t.name) ? t.detail : null));
  const fileRows = (names: string[]) => toolRows((t) => (names.includes(t.name) && t.detail ? (t.files ?? t.detail) : null));
  const filesRead = fileRows(['Read', 'read']);
  const filesEdited = fileRows(EDIT_TOOLS);
  const byContext = [...byTool].sort((a, b) => (b.carriedCost as number) - (a.carriedCost as number)).map((r) => ({ ...r, value: r.carriedCost as number }));
  const byWeb = toolRows((t) => (t.name === 'WebFetch' || t.name === 'webfetch' ? t.detail || '(other)' : null));

  // --- Skills, subagents, commands
  const skillAgg = new Map<string, { n: number; tool: number; slash: number; subagent: number; prompts: Set<number>; projects: Set<string> }>();
  for (const s of skills) {
    const r = skillAgg.get(s.name) ?? { n: 0, tool: 0, slash: 0, subagent: 0, prompts: new Set<number>(), projects: new Set<string>() };
    r.n++;
    r[s.source]++;
    if (s.prompt >= 0) r.prompts.add(s.prompt);
    r.projects.add(label(s.project));
    skillAgg.set(s.name, r);
  }
  const bySkill: Row[] = [...skillAgg.entries()]
    .map(([k, r]) => ({
      key: k,
      label: k,
      value: r.n,
      viaTool: r.tool,
      viaSlash: r.slash,
      viaSubagent: r.subagent,
      turnCost: sum([...r.prompts].map((p) => ds.prompts[p]?.cost ?? 0)),
      projects: [...r.projects].join(', '),
    }))
    .sort((a, b) => b.value - a.value);

  const agentAgg = new Map<string, { n: Set<string>; cost: number; calls: number }>();
  for (const c of calls) {
    if (!c.agentId) continue;
    const t = subById.get(c.agentId)?.agentType ?? '(unknown)';
    const r = agentAgg.get(t) ?? { n: new Set<string>(), cost: 0, calls: 0 };
    r.n.add(c.agentId);
    r.cost += c.cost;
    r.calls++;
    agentAgg.set(t, r);
  }
  const byAgent: Row[] = [...agentAgg.entries()]
    .map(([k, r]) => ({ key: k, label: k, value: r.cost, runs: r.n.size, calls: r.calls, perRun: r.n.size ? r.cost / r.n.size : 0 }))
    .sort((a, b) => b.value - a.value);

  const skillNames = new Set(ds.skills.map((s) => s.name));
  const byCommand: Row[] = [...groupSum(commands, (c) => c.name, () => 1).entries()]
    .map(([k, n]) => ({ key: k, label: '/' + k, value: n, skill: skillNames.has(k) }))
    .sort((a, b) => b.value - a.value);

  // --- Activity
  const heat = { prompts: grid(), cost: grid() };
  for (const p of realPrompts) heat.prompts[weekday(p.ts)][new Date(p.ts).getHours()]++;
  for (const c of calls) heat.cost[weekday(c.ts)][new Date(c.ts).getHours()] += c.cost;

  const hTs = history.map((h) => h.ts).filter(Boolean);
  const hDays = hTs.length ? daysBetween(minOf(hTs), maxOf(hTs)) : [];
  const hIdx = new Map(hDays.map((d, i) => [d, i]));
  const hVals = new Array(hDays.length).fill(0);
  for (const h of history) {
    const i = hIdx.get(dayKey(h.ts));
    if (i != null && !h.command) hVals[i]++;
  }
  const historyDaily = { days: hDays, series: [{ key: 'prompts', label: 'Prompts', color: SLOT(0), values: hVals }] };

  const durations = turns.map((t) => t.durationMs).sort((a, b) => a - b);
  const turnStats = {
    n: durations.length,
    median: quantile(durations, 0.5),
    p90: quantile(durations, 0.9),
    max: durations[durations.length - 1] ?? 0,
    total: sum(durations),
  };

  // --- Plan usage limits (Codex). They are account-wide, so only the date filter applies.
  const limitSamples = f.source != null && f.source !== 'codex' ? [] : ds.limits.filter((x) => (f.from == null || x.ts >= f.from) && (f.to == null || x.ts < f.to));
  const limitKeys = [...new Set(limitSamples.map((x) => `${x.limit}|${x.windowMinutes}`))].sort((a, b) => Number(a.split('|')[1]) - Number(b.split('|')[1]));
  const lTs = limitSamples.map((x) => x.ts);
  const lDays = lTs.length ? daysBetween(minOf(lTs), maxOf(lTs)) : [];
  const lIdx = new Map(lDays.map((d, i) => [d, i]));
  const limits = limitKeys.map((key) => {
    const [limit, minutes] = key.split('|');
    const samples = limitSamples.filter((x) => `${x.limit}|${x.windowMinutes}` === key);
    const peaks = new Array(lDays.length).fill(0);
    for (const x of samples) {
      const i = lIdx.get(dayKey(x.ts));
      if (i != null) peaks[i] = Math.max(peaks[i], x.usedPercent);
    }
    const latest = samples[samples.length - 1];
    const window = windowLabel(Number(minutes));
    const label = `${window[0].toUpperCase()}${window.slice(1)} limit${limit === 'codex' ? '' : ` (${limit})`}`;
    return {
      key,
      label,
      latest,
      peak: maxOf(samples.map((x) => x.usedPercent)),
      daily: { days: lDays, series: [{ key, label: 'Peak use', color: SLOT(0), values: peaks }] },
    };
  });

  // --- Friction
  const byDenialKind: Row[] = [...groupSum(denials, (d) => d.kind, () => 1).entries()].map(([k, n]) => ({ key: k, label: DENIAL_LABELS[k] ?? k, value: n })).sort((a, b) => b.value - a.value);
  const byDenialTool: Row[] = [...groupSum(denials, (d) => prettyTool(d.tool), () => 1).entries()].map(([k, n]) => ({ key: k, label: k, value: n })).sort((a, b) => b.value - a.value);
  const toolErrors = byTool.filter((r) => (r.errors as number) > 0).sort((a, b) => (b.errors as number) - (a.errors as number)).map((r) => ({ ...r, value: r.errors as number }));
  const hookAgg = new Map<string, { ok: number; err: number }>();
  for (const h of hooks) {
    const r = hookAgg.get(h.name) ?? { ok: 0, err: 0 };
    if (h.ok) r.ok++;
    else r.err++;
    hookAgg.set(h.name, r);
  }
  const byHook: Row[] = [...hookAgg.entries()].map(([k, r]) => ({ key: k, label: k, value: r.ok + r.err, errors: r.err })).sort((a, b) => b.value - a.value);
  const byStop: Row[] = [...groupSum(calls, (c) => c.stop, () => 1).entries()].map(([k, n]) => ({ key: k, label: k, value: n })).sort((a, b) => b.value - a.value);
  const compactionRows = [...compactions].sort((a, b) => b.ts - a.ts).map((c, i) => ({
    key: String(i),
    label: sessionById.get(c.sid)?.title || c.sid.slice(0, 8),
    value: c.pre,
    ts: c.ts,
    project: label(c.project),
    trigger: c.trigger,
    post: c.post,
    durationMs: c.durationMs,
  }));

  return {
    kpi: { ...kpi, activeDays, perDay: activeDays ? cost / activeDays : 0, peakDay },
    daily,
    byProject,
    byModel,
    byEffort,
    byThread,
    bySource,
    byTokenType,
    topPrompts,
    topSessions,
    byTool,
    byServer,
    byBash,
    filesRead,
    filesEdited,
    byContext,
    byWeb,
    bySkill,
    byAgent,
    byCommand,
    heat,
    historyDaily,
    turnStats,
    byDenialKind,
    byDenialTool,
    toolErrors,
    byHook,
    byStop,
    compactions: compactionRows,
    apiErrors,
    limits,
    counts: { denials: denials.length, toolErrors: sum(toolErrors.map((r) => r.value)), apiErrors: apiErrors.length, compactions: compactions.length, autoCompactions: compactions.filter((c) => c.trigger === 'auto').length },
  };
}

export type View = ReturnType<typeof buildView>;

const DENIAL_LABELS: Record<string, string> = {
  'permission-rule': 'Permission rule',
  'automode-blocked': 'Blocked by auto mode',
  'user-rejected': 'Rejected by you',
  'automode-unavailable': 'Auto mode unavailable',
  interrupted: 'Interrupted',
  'automode-parsing-error': 'Auto mode parsing error',
};

export function prettyTool(name: string): string {
  if (!name.startsWith('mcp__')) return name;
  const [, server, ...rest] = name.split('__');
  return `${server} · ${rest.join('__')}`;
}

// Monday = 0.
function weekday(ts: number): number {
  return (new Date(ts).getDay() + 6) % 7;
}

function grid(): number[][] {
  return Array.from({ length: 7 }, () => new Array(24).fill(0));
}
