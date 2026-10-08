# claude-log

A local Claude Code, Codex and OpenCode analytics dashboard. You drop in a zip of `~/.claude` (or `~/.codex`) or the OpenCode database, and the browser app shows where tokens and money go, which prompts and sessions cost the most, what fills the context, which tools, MCP servers, skills and subagents are used, and where work gets stuck.

The files are parsed in a Web Worker in the browser and are never uploaded anywhere.

## Running

```sh
npm install
npm run dev
```

Zip to upload:

```sh
cd ~/.claude && zip -r ~/Desktop/claude-data.zip projects history.jsonl stats-cache.json sessions -x '*/tool-results/*'
```

It also reads Codex data. Zip `~/.codex` too and drop both zips at once for one combined report (or only this one for a Codex report):

```sh
cd ~/.codex && zip -r ~/Desktop/codex-data.zip sessions archived_sessions history.jsonl
```

OpenCode keeps everything in one SQLite database, so no zip is needed: drop `opencode.db` itself (and `opencode.db-wal` next to it, if present). It lives in the OpenCode data directory (`~/.local/share/opencode` on Linux, `~/Library/Application Support/opencode` on macOS, `%LOCALAPPDATA%\opencode` on Windows).

## CLI: a local report without a zip

The `claude-log` npm package reads the Claude Code, Codex and OpenCode data directly and writes the same dashboard as one self-contained HTML file (scripts, styles and data inlined) that opens from disk in a browser. Nothing is uploaded, not even to the local browser app.

```sh
npx claude-log                 # reads ~/.claude, ~/.codex and ~/.local/share/opencode, writes ./claude-log-report.html and opens it
npx claude-log ~/Desktop/claude-data.zip -o report.html --no-open
npx claude-log --claude        # only ~/.claude (--codex, --opencode: only that tool)
```

See `cli/README.md` for all options. The report contains prompts and file paths, so don't share it carelessly. On large histories it can be tens of MB.

### Building and publishing the CLI

```sh
npm run build:cli              # builds cli/dist/claude-log.mjs
npm run report                 # runs the local build on ~/.claude
cd cli && npm pack             # builds and packs claude-log-<version>.tgz
npx --package ./cli/claude-log-0.1.0.tgz claude-log   # runs the packed tarball like `npx claude-log`
cd cli && npm publish          # builds and publishes to npm (needs `npm login`)
```

The package lives in `cli/` and has no runtime dependencies. Its `prepack` script runs `build:cli` in the repository root, in two steps. First, `vite.report.config.ts` builds `report.html` (entry `src/report.tsx`, the dashboard without the landing page) into a single file with everything inlined. Then `vite.cli.config.ts` bundles `src/cli/main.ts`, that template and all dependencies into one Node script. It also copies `LICENSE` and `NOTICE` into `cli/` and writes `THIRD_PARTY_LICENSES.txt` for the bundled packages (React, zip.js). At run time the CLI parses the data with the same code as the browser app (`src/core/parse.ts`) and puts the dataset as JSON in place of the placeholder in the template.

## Where the data comes from

| File in the zip | What we take from it |
|---|---|
| `projects/<project>/<sessionId>.jsonl` | API calls with `usage` (cost, tokens, model, effort), tools with their results, prompts, slash commands, skills, compactions, turn durations, permission denials, hooks, API errors, session title, `cost-state` |
| `projects/<project>/<sessionId>/subagents/agent-*.jsonl` + `.meta.json` + `.forked-skill.json` | subagent calls, their type, and the skill that started them |
| `history.jsonl` | prompt history (goes further back than the transcripts) |
| `sessions/<pid>.json` | sessions running when the zip was made |
| `stats-cache.json` | counters since the first session |

### Codex

Each directory or zip is detected from its file names: Claude Code transcripts win when both are present, otherwise `rollout-*.jsonl` files make it a Codex dataset (`src/core/ingest-codex.ts`), otherwise an `opencode.db` makes it an OpenCode dataset. Several sources (by default `~/.claude`, `~/.codex` and the OpenCode data directory, whichever exist) are parsed separately and combined by `src/core/merge.ts`. The same directory has the same project key in every tool, so its Claude Code, Codex and OpenCode sessions land in one project, and the "Tool" filter narrows the dashboard to one of them.

| File | What we take from it |
|---|---|
| `sessions/YYYY/MM/DD/rollout-<datetime>-<sessionId>.jsonl`, `archived_sessions/rollout-*.jsonl` | `session_meta` (cwd, git branch, CLI version), `turn_context` (model, effort), `token_count` (usage per response and plan usage limits), tool calls and their results (`exec_command`, `apply_patch`, MCP…), prompts, compactions, turn durations, interruptions |
| `history.jsonl` | prompt history |

Differences from Claude Code:

- OpenAI has no cache writes. `cached_input_tokens` count as cache reads at the model's cached input rate, and the rest of the input at the input rate. Prices are the OpenAI standard tier (`src/core/pricing.ts`).
- Codex writes most `token_count` events twice. A response counts only when the session's running `total_token_usage` changes.
- A tool error is a non-zero exit code or a failed call. "Rejected or interrupted" counts commands you rejected or aborted.
- Skills are counted when Codex reads a `skills/<name>/SKILL.md` file with a shell command.
- The plan usage limits section shows the `rate_limits` readings (5-hour and weekly windows). They are account-wide, so only the date filter applies.
- Codex records no subagents, hooks, cost-state or session titles. Those parts of the dashboard are hidden when the view has no Claude Code data, and the first prompt stands in for the session title.

### OpenCode

OpenCode keeps everything in one SQLite database (`opencode.db`, with `opencode.db-wal` next to it while it runs). There is no native dependency and no server: the CLI and the browser app read the file page by page through a small read-only SQLite reader (`src/core/sqlite.ts`), WAL included, so the newest sessions show up even while OpenCode is running. In the browser, drop the `opencode.db` file itself; the raw file is read by page instead of being loaded whole.

| Table | What we take from it |
|---|---|
| `session_v2` (older: `session`) | sessions and subagent sessions (`parent_id`), cwd, title, CLI version, agent, and OpenCode's own cost and token totals |
| `session_message` (older: `message` + `part`) | one row per assistant response (model, variant, tokens, cost, finish reason) with its content parts: prompts, tool calls and results, reasoning, compactions, idle markers. Older databases without the v2 tables are read through `message`/`part` |
| `kv` (`models-dev:catalog`) | the models.dev price catalog OpenCode cached, used to split a recorded cost between input, output and cache tokens |

Differences from Claude Code:

- Cost is what OpenCode itself recorded for every assistant message (its equivalent API value); the price tables only split that number between token types. A recorded zero (a free model) stays zero.
- A subagent (the `task` tool) is a child session. Its calls count as subagent calls of the parent session and are assigned to the parent's prompt by time, but the prompt that starts a subagent is not counted as one of your prompts.
- Tool names follow OpenCode's conventions: `bash`, `read`, `edit`, `write`, `glob`, `grep`, `skill`, `task`, and `<server>_<tool>` for MCP servers. A failed tool is an error status, a non-zero exit code or an interruption; aborted tools count as interrupted.
- Compactions come from `compaction` messages. The context "after" is the first call that is smaller than the context before the compaction, because the summary call itself still carries the old context.
- A turn runs from a prompt to the next prompt or to the `idle` message.
- The prompt history comes from the session messages themselves; OpenCode keeps no separate history file.
- OpenCode records no plan usage limits, hooks or live sessions. Those parts of the dashboard are hidden when the view has no data for them.

## How the metrics are computed

- **Cost** is computed per API call from `usage` using the pricing in `src/core/pricing.ts`. Cache write: 5 min = 1.25× input, 1 h = 2× input. Cache read has a per-model rate. On a subscription this is the equivalent value, not a bill. OpenCode records the cost of every message itself, so for OpenCode the recorded amount is the cost and the prices only split it between input, output and cache tokens (the models.dev catalog cached in the database is preferred, the built-in table is the fallback, and without prices the split follows the token counts).
- **Deduplication**: one API response is written as several lines with the same `requestId`, so it is counted once. `tool_use` blocks are deduplicated by id, because resumed sessions copy their history into a new file.
- **Prompt cost** is every call from a prompt until the next prompt in the session. Subagent calls are assigned to the parent session's prompt by time.
- **Tool result carry cost** is the result size (about 4 characters per token, about 1,600 tokens per image) × the cache read rate × the number of later calls until a compaction or the end of the session. This is an estimate.
- **Skills** are counted from the `Skill` tool, from a slash command followed by the skill's content ("Base directory for this skill"), and from subagents with `forked-skill.json`.
- Cost from transcripts comes out a few percent lower than `totalCostUSD` in `cost-state`, because Claude Code doesn't write some auxiliary calls (e.g. Haiku) to the transcript. The dashboard shows both numbers.

## Verifying on real data

```sh
npm test                                     # parser tests
npm run verify -- ~/Desktop/claude-data.zip  # parses the zip (or an opencode.db) in Node and compares the cost with the recorded one
```

## Example screenshots

The screenshots on the landing page (`public/examples/`, one per theme; the app defaults to dark with a light/dark toggle) come from synthetic data with fictional projects and prompts, so no real transcripts are published:

```sh
npx tsx scripts/demo-data.ts ~/Desktop/demo-claude-data.zip
```

Load that zip in the app to get the same dashboard. `public/og.png` (the link preview, 1200×630) is the Overview section of that dashboard.

## License

[Apache-2.0](LICENSE) © Marcin Milewicz. You can use, modify and redistribute the code, including commercially. Redistributions and derivative works must keep the copyright and license notices and the attribution in [NOTICE](NOTICE).
