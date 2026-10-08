import { useMemo, useState, type ReactNode } from 'react';
import { Heatmap, StackedColumns } from './components/charts';
import { icons, Logo } from './components/icons';
import { BarList, Card, DataTable, Segmented, StatTile, ThemeToggle, type Column } from './components/ui';
import { buildPalette, buildView, sourceLabel, toolTitle, type Filter, type GroupBy, type Row, type View } from './core/aggregate';
import { compact, date, dateTime, dayLabel, duration, num, pct, usd, usdExact } from './core/format';
import type { Dataset, LiveSession, Source } from './core/types';
import type { Theme } from './theme';

type Preset = 'all' | '30d' | '7d' | '1d' | 'custom';
type ToolFilter = 'all' | Source;
// Which tools the current view shows. Codex records no subagents, hooks or
// cost-state; OpenCode records no hooks or plan limits. Those parts are hidden
// when the view has no data for them.
type Has = { claude: boolean; codex: boolean; opencode: boolean };
const DAY = 86_400_000;

const anySubagents = (has: Has) => has.claude || has.opencode;
const anyLines = (has: Has) => has.claude || has.opencode;
const anyDenials = (has: Has) => has.claude || has.opencode;

const n = (r: Row, k: string) => Number(r[k] ?? 0);

function toInputDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function Dashboard({ dataset: ds, onReset, theme, onTheme }: { dataset: Dataset; onReset?: () => void; theme: Theme; onTheme: (t: Theme) => void }) {
  const lastTs = useMemo(() => ds.calls.reduce((m, c) => (c.ts > m ? c.ts : m), 0) || Date.now(), [ds]);
  const firstTs = useMemo(() => ds.calls.reduce((m, c) => (c.ts && c.ts < m ? c.ts : m), Infinity), [ds]);
  const [preset, setPreset] = useState<Preset>('all');
  const [customFrom, setCustomFrom] = useState(toInputDate(Number.isFinite(firstTs) ? firstTs : lastTs));
  const [customTo, setCustomTo] = useState(toInputDate(lastTs));
  const [project, setProject] = useState<string>('');
  const [tool, setTool] = useState<ToolFilter>('all');
  const [groupBy, setGroupBy] = useState<GroupBy>('model');
  const [heatMetric, setHeatMetric] = useState<'prompts' | 'cost'>('prompts');

  const filter: Filter = useMemo(() => {
    const endOfLast = new Date(lastTs);
    endOfLast.setHours(24, 0, 0, 0);
    const end = endOfLast.getTime();
    const p = project || null;
    const source = tool === 'all' ? null : tool;
    switch (preset) {
      case 'all':
        return { from: null, to: null, project: p, source };
      case '30d':
        return { from: end - 30 * DAY, to: end, project: p, source };
      case '7d':
        return { from: end - 7 * DAY, to: end, project: p, source };
      case '1d':
        return { from: end - DAY, to: end, project: p, source };
      case 'custom': {
        const from = customFrom ? new Date(customFrom + 'T00:00').getTime() : null;
        const to = customTo ? new Date(customTo + 'T00:00').getTime() + DAY : null;
        return { from, to, project: p, source };
      }
    }
  }, [preset, customFrom, customTo, project, tool, lastTs]);

  const multi = ds.sources.length > 1;
  const shown = tool === 'all' ? ds.sources : [tool];
  const has: Has = { claude: shown.includes('claude'), codex: shown.includes('codex'), opencode: shown.includes('opencode') };
  const palette = useMemo(() => buildPalette(ds), [ds]);
  const v = useMemo(() => buildView(ds, filter, palette, groupBy), [ds, filter, palette, groupBy]);
  const projectOptions = useMemo(() => {
    const cost = new Map<string, number>();
    for (const c of ds.calls) cost.set(c.project, (cost.get(c.project) ?? 0) + c.cost);
    return Object.keys(ds.projects)
      .filter((k) => cost.has(k))
      .sort((a, b) => (cost.get(b) ?? 0) - (cost.get(a) ?? 0))
      .map((k) => ({ key: k, label: ds.projects[k] }));
  }, [ds]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Logo size={36} />
          <div>
            <h1>{toolTitle(ds.sources)} Analytics</h1>
            <div className="source">
              <span className="source-file">
                {icons.file}
                {ds.sourceName}
              </span>
              <span>
                {num(ds.files.transcripts)} sessions{ds.files.subagents > 0 ? ` · ${num(ds.files.subagents)} subagents` : ''}
              </span>
              <span>
                {date(firstTs)} – {date(lastTs)}
              </span>
            </div>
          </div>
        </div>
        <div className="topbar-actions">
          <ThemeToggle theme={theme} onChange={onTheme} />
          {onReset && (
            <button className="btn" onClick={onReset}>
              Load another file
            </button>
          )}
        </div>
      </header>

      <div className="filters">
        <Segmented<Preset>
          label="Date range"
          value={preset}
          onChange={setPreset}
          options={[
            { value: 'all', label: 'All' },
            { value: '30d', label: '30 days' },
            { value: '7d', label: '7 days' },
            { value: '1d', label: 'Last day' },
            { value: 'custom', label: 'Custom' },
          ]}
        />
        {preset === 'custom' && (
          <>
            <label className="field">
              from <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
            </label>
            <label className="field">
              to <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
            </label>
          </>
        )}
        {multi && (
          <Segmented<ToolFilter>
            label="Tool"
            value={tool}
            onChange={setTool}
            options={[
              { value: 'all', label: 'All tools' },
              ...ds.sources.map((s) => ({ value: s, label: sourceLabel(s) })),
            ]}
          />
        )}
        <label className="field">
          Project
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">All projects</option>
            {projectOptions.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {preset !== 'all' && preset !== 'custom' && <span className="note" style={{ margin: 0 }}>counted back from the last activity in the data ({date(lastTs)})</span>}
      </div>

      {ds.unknownModels.length > 0 && (
        <div className="warn-box">
          No pricing for models: {ds.unknownModels.join(', ')}. Their calls cost $0 (tokens are counted normally).
        </div>
      )}

      <Overview v={v} has={has} />
      {/* Limits lead a Codex-only report; next to Claude Code data they are a detail. */}
      {v.limits.length > 0 && !has.claude && <Limits v={v} has={has} />}
      <Spend v={v} groupBy={groupBy} setGroupBy={setGroupBy} has={has} />
      <Prompts v={v} has={has} />
      <Sessions v={v} has={has} />
      <Context v={v} />
      <Tools v={v} has={has} />
      {(has.claude || v.bySkill.length > 0 || v.byCommand.length > 0) && <Skills v={v} has={has} />}
      <Activity v={v} heatMetric={heatMetric} setHeatMetric={setHeatMetric} live={ds.live} projects={ds.projects} />
      {v.limits.length > 0 && has.claude && <Limits v={v} has={has} />}
      <Friction v={v} has={has} />
    </div>
  );
}

function Section({ title, icon, lead, children }: { title: string; icon: ReactNode; lead?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <h2>
        <span className="section-icon">{icon}</span>
        {title}
      </h2>
      {lead && <p className="lead">{lead}</p>}
      <div className="grid">{children}</div>
    </section>
  );
}

// ---------- Overview ----------

function Overview({ v, has }: { v: View; has: Has }) {
  const k = v.kpi;
  const gap = k.reported.cost ? k.reported.computed / k.reported.cost - 1 : 0;
  return (
    <Section title="Overview" icon={icons.overview}>
      <StatTile
        hero
        span={6}
        label="Cost at API prices"
        value={usdExact(k.cost)}
        sub={
          k.reported.sessions > 0 ? (
            has.claude && has.opencode ? (
              <>
                The tools' own records add up to {usdExact(k.reported.cost)} for {num(k.reported.sessions)} sessions in this range; the parsed calls give{' '}
                {pct(Math.abs(gap), 1)} {gap < 0 ? 'less' : 'more'}.
              </>
            ) : has.claude ? (
              <>
                Claude Code itself recorded {usdExact(k.reported.cost)} for {num(k.reported.sessions)} finished sessions in this range. Transcripts give{' '}
                {pct(Math.abs(gap), 1)} {gap < 0 ? 'less' : 'more'} because they don't include auxiliary calls.
              </>
            ) : (
              <>
                OpenCode itself recorded {usdExact(k.reported.cost)} for {num(k.reported.sessions)} sessions in this range. Every call is logged, so
                the two numbers are usually very close.
              </>
            )
          ) : (
            `On a subscription this is the equivalent value, not an actual bill.${has.codex ? ' Codex costs use OpenAI standard tier prices.' : ''}${
              has.opencode ? ' OpenCode costs are the amounts OpenCode recorded.' : ''
            }`
          )
        }
      />
      <StatTile label="Total tokens" value={compact(k.tokens)} sub={`${pct(k.cacheHit, 1)} of input is cache reads`} />
      <StatTile label="API calls" value={num(k.calls)} sub={`${usd(k.calls ? k.cost / k.calls : 0)} avg per call`} />
      <StatTile label="Prompts" value={num(k.prompts)} sub={`${usd(k.costPerPrompt)} avg per prompt`} />
      <StatTile label="Sessions" value={num(k.sessions)} sub={`${usd(k.sessions ? k.cost / k.sessions : 0)} avg per session`} />
      <StatTile label="Tool calls" value={num(k.tools)} sub={`${(k.prompts ? k.tools / k.prompts : 0).toFixed(1)} per prompt`} />
      <StatTile label="Output tokens" value={compact(k.out)} sub={`${pct(k.thinkShare)} is thinking`} />
      {anySubagents(has) && <StatTile label="Subagent share of cost" value={pct(k.subShare)} />}
      <StatTile span={anySubagents(has) ? 3 : 6} label="Daily average" value={usd(k.perDay)} sub={`${num(k.activeDays)} active days`} />
      <StatTile
        span={anySubagents(has) ? 3 : 6}
        label="Most expensive day"
        value={k.peakDay ? usd(k.peakDay[1]) : '—'}
        sub={k.peakDay ? dayLabel(k.peakDay[0]) : undefined}
      />
      {anyLines(has) && (
        <StatTile
          label="Lines changed"
          value={`+${compact(k.reported.linesAdded)} / −${compact(k.reported.linesRemoved)}`}
          sub="from the tool's own session records, finished sessions only"
        />
      )}
    </Section>
  );
}

// ---------- Plan usage limits (Codex) ----------

const percent = (v: number) => `${Math.round(v)}%`;

function Limits({ v, has }: { v: View; has: Has }) {
  return (
    <Section
      title={has.claude ? 'Codex plan usage limits' : 'Plan usage limits'}
      icon={icons.chart}
      lead="Codex records how much of each plan limit window is used up after every response. Limits are account-wide, so the project filter doesn't apply to them."
    >
      {v.limits.map((l) => (
        <StatTile
          key={l.key}
          span={6}
          label={`${l.label}: last reading`}
          value={percent(l.latest.usedPercent)}
          sub={
            <>
              at {dateTime(l.latest.ts)}
              {l.latest.resetsAt > 0 && <> · reset {dateTime(l.latest.resetsAt)}</>} · peak in range {percent(l.peak)}
            </>
          }
        />
      ))}
      {v.limits.map((l) => (
        <Card
          key={l.key}
          span={v.limits.length > 1 ? 6 : 12}
          title={`${l.label}: peak use per day`}
          sub="Highest reading of the day, in % of the limit"
          table={{
            rows: l.daily.days.map((d, i) => ({ day: d, value: l.daily.series[0].values[i] })),
            columns: [
              { key: 'day', label: 'Day' },
              { key: 'value', label: 'Peak use', num: true, render: (r: { value: number }) => percent(r.value) },
            ],
          }}
        >
          <StackedColumns days={l.daily.days} series={l.daily.series} format={percent} />
        </Card>
      ))}
    </Section>
  );
}

// ---------- Where the money goes ----------

function Spend({ v, groupBy, setGroupBy, has }: { v: View; groupBy: GroupBy; setGroupBy: (g: GroupBy) => void; has: Has }) {
  const span = anySubagents(has) ? 4 : 6;
  const multi = has.claude && (has.codex || has.opencode) || has.codex && has.opencode;
  const breakdownTable = (rows: Row[], first: string) => ({
    rows,
    sortKey: 'value',
    columns: [
      { key: 'label', label: first },
      { key: 'value', label: 'Cost', num: true, render: (r: Row) => usdExact(r.value) },
      { key: 'share', label: 'Share', num: true, render: (r: Row) => pct(n(r, 'share'), 1) },
      { key: 'tokens', label: 'Tokens', num: true, render: (r: Row) => compact(n(r, 'tokens')) },
      { key: 'calls', label: 'Calls', num: true, render: (r: Row) => num(n(r, 'calls')) },
    ] as Column<Row>[],
  });
  const tip = (r: Row) => [
    { name: 'share', value: pct(n(r, 'share'), 1) },
    { name: 'tokens', value: compact(n(r, 'tokens')) },
    { name: 'API calls', value: num(n(r, 'calls')) },
  ];
  return (
    <Section title="Where tokens and money go" icon={icons.money}>
      <Card
        span={12}
        title="Daily cost"
        sub={groupBy === 'tokenType' ? 'by token type' : groupBy === 'model' ? 'by model' : 'by project (top 7, the rest as “Other”)'}
        tools={
          <Segmented<GroupBy>
            label="Group by"
            value={groupBy}
            onChange={setGroupBy}
            options={[
              { value: 'model', label: 'Model' },
              { value: 'project', label: 'Project' },
              { value: 'tokenType', label: 'Token type' },
            ]}
          />
        }
        table={{
          rows: v.daily.days.map((d, i) => ({ day: d, total: v.daily.series.reduce((s, x) => s + x.values[i], 0), ...Object.fromEntries(v.daily.series.map((s) => [s.key, s.values[i]])) })),
          columns: [
            { key: 'day', label: 'Day' },
            { key: 'total', label: 'Total', num: true, render: (r: Record<string, number>) => usdExact(r.total) },
            ...v.daily.series.map((s) => ({ key: s.key, label: s.label, num: true, render: (r: Record<string, number>) => usdExact(r[s.key] ?? 0) })),
          ],
        }}
      >
        <StackedColumns days={v.daily.days} series={v.daily.series} format={usd} />
      </Card>
      <Card span={multi ? 4 : 6} title="Cost by project" table={breakdownTable(v.byProject, 'Project')}>
        <BarList rows={v.byProject} format={usd} tip={tip} />
      </Card>
      <Card span={multi ? 4 : 6} title="Cost by model" table={breakdownTable(v.byModel, 'Model')}>
        <BarList rows={v.byModel} format={usd} tip={tip} />
      </Card>
      {multi && (
        <Card span={4} title="Cost by tool" table={breakdownTable(v.bySource, 'Tool')}>
          <BarList rows={v.bySource} format={usd} tip={tip} />
        </Card>
      )}
      <Card
        span={span}
        title="Cost by token type"
        sub="What you actually pay for"
        table={{
          rows: v.byTokenType,
          columns: [
            { key: 'label', label: 'Type' },
            { key: 'value', label: 'Cost', num: true, render: (r: Row) => usdExact(r.value) },
            { key: 'share', label: 'Share', num: true, render: (r: Row) => pct(n(r, 'share'), 1) },
            { key: 'tokens', label: 'Tokens', num: true, render: (r: Row) => compact(n(r, 'tokens')) },
          ],
        }}
        note="Cache reads are the whole context read on every call. They grow with session length."
      >
        <BarList rows={v.byTokenType} format={usd} tip={(r) => [{ name: 'share', value: pct(n(r, 'share'), 1) }, { name: 'tokens', value: compact(n(r, 'tokens')) }]} />
      </Card>
      <Card span={span} title="Cost by effort level" table={breakdownTable(v.byEffort, 'Effort')}>
        <BarList rows={v.byEffort} format={usd} tip={tip} />
      </Card>
      {anySubagents(has) && (
        <Card span={4} title="Main thread vs. subagents" table={breakdownTable(v.byThread, 'Thread')}>
          <BarList rows={v.byThread} format={usd} tip={tip} />
        </Card>
      )}
    </Section>
  );
}

// ---------- Prompts ----------

function Prompts({ v, has }: { v: View; has: Has }) {
  type P = View['topPrompts'][number];
  return (
    <Section
      title="Most expensive prompts"
      icon={icons.prompt}
      lead={`A prompt's cost is every API call from when it was sent until the next prompt${anySubagents(has) ? ', including subagents started in that time.' : '.'}`}
    >
      <Card span={12} title="Top 100 prompts by cost">
        <DataTable<P>
          rows={v.topPrompts}
          sortKey="value"
          columns={[
            { key: 'value', label: 'Cost', num: true, render: (r) => usdExact(r.value) },
            {
              key: 'label',
              label: 'Prompt',
              wrap: true,
              render: (r) => (
                <>
                  {r.label}
                  {r.skills.length > 0 && (
                    <div>
                      {r.skills.map((s) => (
                        <span className="pill" key={s}>
                          skill: {s}
                        </span>
                      ))}
                    </div>
                  )}
                </>
              ),
            },
            { key: 'project', label: 'Project' },
            { key: 'ts', label: 'When', render: (r) => dateTime(r.ts), value: (r) => r.ts },
            { key: 'calls', label: 'Calls', num: true, render: (r) => num(r.calls) },
            { key: 'tools', label: 'Tools', num: true, render: (r) => num(r.tools) },
            ...(anySubagents(has) ? [{ key: 'subCost', label: 'Subagents part', num: true, render: (r: P) => (r.subCost ? usd(r.subCost) : '—') }] : []),
            { key: 'tokens', label: 'Tokens', num: true, render: (r) => compact(r.tokens) },
          ]}
        />
      </Card>
    </Section>
  );
}

// ---------- Sessions ----------

function Sessions({ v, has }: { v: View; has: Has }) {
  type S = View['topSessions'][number];
  return (
    <Section
      title="Sessions"
      icon={icons.sessions}
      lead={`“Max context” is the largest input of a single main-thread call. Long sessions without ${has.claude ? '/clear' : has.codex ? '/new' : 'a new session'} read that context on every step.`}
    >
      <Card span={12} title="Top 100 sessions by cost">
        <DataTable<S>
          rows={v.topSessions}
          sortKey="value"
          columns={[
            { key: 'value', label: 'Cost', num: true, render: (r) => usdExact(r.value) },
            { key: 'label', label: 'Session', wrap: true },
            ...(has.claude && (has.codex || has.opencode) || has.codex && has.opencode ? [{ key: 'tool', label: 'Tool' }] : []),
            { key: 'project', label: 'Project' },
            { key: 'branch', label: 'Branch' },
            { key: 'ts', label: 'Start', render: (r) => dateTime(r.ts), value: (r) => r.ts },
            { key: 'durationMs', label: 'Duration', num: true, render: (r) => duration(r.durationMs) },
            { key: 'prompts', label: 'Prompts', num: true },
            { key: 'calls', label: 'Calls', num: true, render: (r) => num(r.calls) },
            { key: 'tools', label: 'Tools', num: true, render: (r) => num(r.tools) },
            { key: 'maxCtx', label: 'Max context', num: true, render: (r) => compact(r.maxCtx) },
            { key: 'compactions', label: 'Compactions', num: true },
            ...(anySubagents(has) ? [{ key: 'subagents', label: 'Subagents', num: true }] : []),
          ]}
        />
      </Card>
    </Section>
  );
}

// ---------- Context ----------

function Context({ v }: { v: View }) {
  const c = v.counts;
  return (
    <Section
      title="What fills the context"
      icon={icons.context}
      lead="A tool result enters the context and is read from cache on every later call until a compaction or the end of the session. This is an estimate: about 4 characters per token, about 1,600 tokens per image."
    >
      <Card
        span={8}
        title="Estimated cost of carrying tool results in context"
        table={{
          rows: v.byContext,
          sortKey: 'value',
          columns: [
            { key: 'label', label: 'Tool' },
            { key: 'value', label: 'Carry cost', num: true, render: (r: Row) => usdExact(r.value) },
            { key: 'resTok', label: 'Result tokens', num: true, render: (r: Row) => compact(n(r, 'resTok')) },
            { key: 'count', label: 'Calls', num: true, render: (r: Row) => num(n(r, 'count')) },
            { key: 'avg', label: 'Avg per result', num: true, value: (r: Row) => n(r, 'resTok') / Math.max(1, n(r, 'count')), render: (r: Row) => compact(n(r, 'resTok') / Math.max(1, n(r, 'count'))) },
            { key: 'images', label: 'Images', num: true, render: (r: Row) => num(n(r, 'images')) },
            { key: 'carriedTok', label: 'Carried tokens', num: true, render: (r: Row) => compact(n(r, 'carriedTok')) },
          ] as Column<Row>[],
        }}
      >
        <BarList
          rows={v.byContext}
          format={usd}
          tip={(r) => [
            { name: 'result tokens', value: compact(n(r, 'resTok')) },
            { name: 'images', value: num(n(r, 'images')) },
            { name: 'carried tokens', value: compact(n(r, 'carriedTok')) },
          ]}
        />
      </Card>
      <div className="span-4" style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
        <StatTile
          span={null}
          label="Compactions"
          value={num(c.compactions)}
          // Codex doesn't record what triggered a compaction.
          sub={v.compactions.every((x) => x.trigger === 'unknown') ? undefined : `${num(c.autoCompactions)} automatic`}
        />
        <StatTile
          span={null}
          label="Avg context before compaction"
          value={compact(v.compactions.length ? v.compactions.reduce((s, x) => s + x.value, 0) / v.compactions.length : 0)}
          sub={v.compactions.length ? `avg after compaction ${compact(v.compactions.reduce((s, x) => s + x.post, 0) / v.compactions.length)}` : undefined}
        />
      </div>
      <Card span={12} title="Compactions">
        <DataTable
          rows={v.compactions}
          sortKey="ts"
          columns={[
            { key: 'ts', label: 'When', render: (r: View['compactions'][number]) => dateTime(r.ts), value: (r) => r.ts },
            { key: 'label', label: 'Session', wrap: true },
            { key: 'project', label: 'Project' },
            { key: 'trigger', label: 'Trigger' },
            { key: 'value', label: 'Before', num: true, render: (r) => compact(r.value) },
            { key: 'post', label: 'After', num: true, render: (r) => compact(r.post) },
            { key: 'durationMs', label: 'Duration', num: true, render: (r) => duration(r.durationMs) },
          ]}
        />
      </Card>
    </Section>
  );
}

// ---------- Tools ----------

function toolTable(rows: Row[], first: string) {
  return {
    rows,
    sortKey: 'value',
    columns: [
      { key: 'label', label: first },
      { key: 'value', label: 'Calls', num: true, render: (r: Row) => num(r.value) },
      { key: 'errors', label: 'Errors', num: true, render: (r: Row) => num(n(r, 'errors')) },
      { key: 'errorRate', label: 'Error rate', num: true, render: (r: Row) => pct(n(r, 'errorRate'), 1) },
      { key: 'resTok', label: 'Result tokens', num: true, render: (r: Row) => compact(n(r, 'resTok')) },
    ] as Column<Row>[],
  };
}

// For paths the file name matters, so truncate from the start.
const pathTail = (r: Row) => {
  const parts = r.label.split('/');
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : r.label;
};

const toolTip = (r: Row) => [
  { name: 'errors', value: `${num(n(r, 'errors'))} (${pct(n(r, 'errorRate'), 1)})` },
  { name: 'result tokens', value: compact(n(r, 'resTok')) },
];

function Tools({ v, has }: { v: View; has: Has }) {
  return (
    <Section title="Tools and MCP" icon={icons.tools}>
      <Card span={6} title="Most used tools" table={toolTable(v.byTool, 'Tool')}>
        <BarList rows={v.byTool} format={num} tip={toolTip} limit={12} />
      </Card>
      <Card span={6} title="MCP servers" table={toolTable(v.byServer, 'Server')}>
        <BarList rows={v.byServer} format={num} tip={toolTip} limit={12} />
      </Card>
      <Card
        span={has.claude ? 4 : 6}
        title={has.claude ? 'Bash commands' : 'Shell commands'}
        sub="First word of the command, skipping cd and variables"
        table={toolTable(v.byBash, 'Command')}
      >
        <BarList rows={v.byBash} format={num} tip={toolTip} limit={12} />
      </Card>
      {/* Codex reads files through shell commands, so there is no Read tool to count. */}
      {(has.claude || has.opencode) && (
        <Card span={4} title="Most read files" table={toolTable(v.filesRead, 'File')}>
          <BarList rows={v.filesRead} format={num} tip={toolTip} limit={12} display={pathTail} />
        </Card>
      )}
      <Card
        span={has.claude ? 4 : 6}
        title="Most edited files"
        sub={
          has.claude && (has.codex || has.opencode)
            ? 'Edit, Write, MultiEdit, apply_patch'
            : has.claude
              ? 'Edit, Write, MultiEdit'
              : 'write, edit, apply_patch (once per file in a patch)'
        }
        table={toolTable(v.filesEdited, 'File')}
      >
        <BarList rows={v.filesEdited} format={num} tip={toolTip} limit={12} display={pathTail} />
      </Card>
      {v.byWeb.length > 0 && (
        <Card span={6} title="WebFetch by domain" table={toolTable(v.byWeb, 'Domain')}>
          <BarList rows={v.byWeb} format={num} tip={toolTip} />
        </Card>
      )}
    </Section>
  );
}

// ---------- Skills, subagents, commands ----------

function Skills({ v, has }: { v: View; has: Has }) {
  const lead = [
    has.claude
      ? 'A skill is counted when the model invoked it (the Skill tool), when you typed it as a /command, or when it started a subagent (forked skill).'
      : has.opencode
        ? 'A skill is counted when the model invoked it (the skill tool) or when it read the skill\u2019s SKILL.md file.'
        : 'A skill is counted when Codex reads its SKILL.md with a shell command.',
    has.claude && has.codex ? ' A Codex skill is counted when Codex reads its SKILL.md.' : '',
    has.claude && has.opencode ? ' An OpenCode skill is counted when the skill tool or a file read loads it.' : '',
    ' Turn cost is the total cost of the prompts in which the skill was used.',
  ].join('');
  return (
    <Section title={anySubagents(has) ? 'Skills, subagents and commands' : 'Skills and commands'} icon={icons.skills} lead={lead}>
      <Card
        span={6}
        title="Skill uses"
        table={{
          rows: v.bySkill,
          sortKey: 'value',
          columns: [
            { key: 'label', label: 'Skill' },
            { key: 'value', label: 'Uses', num: true },
            { key: 'viaTool', label: 'By model', num: true },
            { key: 'viaSlash', label: 'Via /command', num: true },
            { key: 'viaSubagent', label: 'As subagent', num: true },
            { key: 'turnCost', label: 'Turn cost', num: true, render: (r: Row) => usd(n(r, 'turnCost')) },
            { key: 'projects', label: 'Projects', wrap: true },
          ] as Column<Row>[],
        }}
      >
        <BarList
          rows={v.bySkill}
          format={num}
          limit={12}
          tip={(r) => [
            { name: 'by model', value: num(n(r, 'viaTool')) },
            { name: 'via /command', value: num(n(r, 'viaSlash')) },
            { name: 'as subagent', value: num(n(r, 'viaSubagent')) },
            { name: 'turn cost', value: usd(n(r, 'turnCost')) },
          ]}
        />
      </Card>
      {anySubagents(has) && (
        <Card
          span={6}
          title="Subagent cost by type"
          table={{
            rows: v.byAgent,
            sortKey: 'value',
            columns: [
              { key: 'label', label: 'Type' },
              { key: 'value', label: 'Cost', num: true, render: (r: Row) => usdExact(r.value) },
              { key: 'runs', label: 'Runs', num: true },
              { key: 'perRun', label: 'Per run', num: true, render: (r: Row) => usd(n(r, 'perRun')) },
              { key: 'calls', label: 'API calls', num: true, render: (r: Row) => num(n(r, 'calls')) },
            ] as Column<Row>[],
          }}
        >
          <BarList
            rows={v.byAgent}
            format={usd}
            limit={12}
            tip={(r) => [
              { name: 'runs', value: num(n(r, 'runs')) },
              { name: 'per run', value: usd(n(r, 'perRun')) },
            ]}
          />
        </Card>
      )}
      <Card
        span={6}
        title="Slash commands"
        table={{
          rows: v.byCommand,
          sortKey: 'value',
          columns: [
            { key: 'label', label: 'Command' },
            { key: 'value', label: 'Uses', num: true },
            { key: 'skill', label: 'Skill?', render: (r: Row) => (r.skill ? 'yes' : '') },
          ] as Column<Row>[],
        }}
      >
        <BarList rows={v.byCommand} format={num} limit={12} tip={(r) => (r.skill ? [{ name: 'is a skill', value: '✓' }] : [])} />
      </Card>
    </Section>
  );
}

// ---------- Activity ----------

function Activity({
  v,
  heatMetric,
  setHeatMetric,
  live,
  projects,
}: {
  v: View;
  heatMetric: 'prompts' | 'cost';
  setHeatMetric: (m: 'prompts' | 'cost') => void;
  live: LiveSession[];
  projects: Record<string, string>;
}) {
  const t = v.turnStats;
  return (
    <Section title="Activity" icon={icons.activity}>
      <Card
        span={8}
        title="When you work"
        sub="Weekday × hour, local time"
        tools={
          <Segmented
            label="Metric"
            value={heatMetric}
            onChange={setHeatMetric}
            options={[
              { value: 'prompts', label: 'Prompts' },
              { value: 'cost', label: 'Cost' },
            ]}
          />
        }
      >
        <Heatmap grid={v.heat[heatMetric]} format={heatMetric === 'cost' ? usd : num} unit={heatMetric === 'cost' ? 'cost' : 'prompts'} />
      </Card>
      <div className="span-4" style={{ display: 'grid', gap: 12, alignContent: 'start', gridTemplateColumns: '1fr 1fr' }}>
        <StatTile span={null} label="Turns (responses)" value={num(t.n)} />
        <StatTile span={null} label="Median turn" value={duration(t.median)} />
        <StatTile span={null} label="90th percentile" value={duration(t.p90)} />
        <StatTile span={null} label="Longest turn" value={duration(t.max)} />
      </div>
      <Card
        span={12}
        title="Prompts per day"
        sub="Typed prompts, excluding slash commands. Claude Code reads this from history.jsonl, which goes further back than the transcripts; OpenCode has no separate history."
        table={{
          rows: v.historyDaily.days.map((d, i) => ({ day: d, value: v.historyDaily.series[0].values[i] })),
          columns: [
            { key: 'day', label: 'Day' },
            { key: 'value', label: 'Prompts', num: true },
          ],
        }}
      >
        <StackedColumns days={v.historyDaily.days} series={v.historyDaily.series} format={num} />
      </Card>
      {live.length > 0 && (
        <Card span={12} title="Sessions running when the zip was made" sub="from ~/.claude/sessions/*.json">
          <DataTable<LiveSession>
            rows={live}
            sortKey="updatedAt"
            columns={[
              {
                key: 'status',
                label: 'Status',
                render: (r) => (
                  <>
                    <span className="status-dot" style={{ background: LIVE_STATUS[r.status]?.color ?? 'var(--series-other)' }} />
                    {LIVE_STATUS[r.status]?.label ?? r.status}
                  </>
                ),
              },
              { key: 'name', label: 'Name' },
              { key: 'project', label: 'Project', render: (r) => projects[r.project] ?? r.cwd },
              { key: 'pid', label: 'PID', num: true },
              { key: 'kind', label: 'Kind' },
              { key: 'version', label: 'Version' },
              { key: 'startedAt', label: 'Start', render: (r) => dateTime(r.startedAt), value: (r) => r.startedAt },
              { key: 'updatedAt', label: 'Last update', render: (r) => dateTime(r.updatedAt), value: (r) => r.updatedAt },
            ]}
          />
        </Card>
      )}
    </Section>
  );
}

const LIVE_STATUS: Record<string, { label: string; color: string }> = {
  busy: { label: 'working', color: 'var(--accent)' },
  waiting: { label: 'waiting for you', color: 'var(--warning)' },
  idle: { label: 'idle', color: 'var(--series-other)' },
};

// ---------- Friction ----------

function Friction({ v, has }: { v: View; has: Has }) {
  const tile = anyDenials(has) ? 3 : 4;
  const simple = (first: string) => ({
    sortKey: 'value',
    columns: [
      { key: 'label', label: first },
      { key: 'value', label: 'Count', num: true },
    ] as Column<Row>[],
  });
  return (
    <Section
      title="Friction"
      icon={icons.friction}
      lead={
        !has.claude
          ? 'Where work gets stuck: commands you rejected or interrupted, tool errors (including non-zero exit codes), API errors.'
          : 'Where work gets stuck: permission denials, tool errors, hooks, API errors. Tools that are denied often are candidates for the allowlist.'
      }
    >
      <StatTile span={tile} label={has.claude ? 'Permission denials' : 'Rejected or interrupted'} value={num(v.counts.denials)} />
      <StatTile
        span={tile}
        label="Tool errors"
        value={num(v.counts.toolErrors)}
        sub={v.kpi.tools ? `${pct(v.counts.toolErrors / v.kpi.tools, 1)} of calls` : undefined}
      />
      <StatTile span={tile} label="API errors" value={num(v.counts.apiErrors)} sub="overloads, rate limits, dropped connections" />
      {has.claude && <StatTile label="Model refusals" value={num(v.byStop.find((r) => r.key === 'refusal')?.value ?? 0)} sub="stop_reason = refusal" />}
      <Card span={6} title="Denials by reason" table={{ rows: v.byDenialKind, ...simple('Reason') }}>
        <BarList rows={v.byDenialKind} format={num} />
      </Card>
      <Card span={6} title="Denials by tool" table={{ rows: v.byDenialTool, ...simple('Tool') }}>
        <BarList rows={v.byDenialTool} format={num} />
      </Card>
      <Card span={has.claude ? 6 : 12} title="Tool errors" table={toolTable(v.toolErrors, 'Tool')}>
        <BarList rows={v.toolErrors} format={num} tip={(r) => [{ name: 'of all calls', value: pct(n(r, 'errorRate'), 1) }]} />
      </Card>
      {has.claude && (
        <Card
          span={6}
          title="Hooks"
          table={{
            rows: v.byHook,
            sortKey: 'value',
            columns: [
              { key: 'label', label: 'Hook' },
              { key: 'value', label: 'Runs', num: true },
              { key: 'errors', label: 'Errors', num: true },
            ] as Column<Row>[],
          }}
        >
          <BarList rows={v.byHook} format={num} tip={(r) => [{ name: 'errors', value: num(n(r, 'errors')) }]} />
        </Card>
      )}
      {v.apiErrors.length > 0 && (
        <Card span={12} title="Recent API errors">
          <DataTable
            rows={[...v.apiErrors].sort((a, b) => b.ts - a.ts)}
            columns={[
              { key: 'ts', label: 'When', render: (r: View['apiErrors'][number]) => dateTime(r.ts), value: (r) => r.ts },
              { key: 'text', label: 'Message', wrap: true },
            ]}
          />
        </Card>
      )}
    </Section>
  );
}
