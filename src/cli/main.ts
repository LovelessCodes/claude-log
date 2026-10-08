// claude-log: parses Claude Code, Codex and OpenCode data on this machine and
// writes the dashboard as a single HTML file that opens straight from disk.
// Nothing is uploaded.
import { spawn } from 'node:child_process';
import { existsSync, openAsBlob, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import pkg from '../../cli/package.json';
import template from '../../cli/.template/report.html?raw';
import { bytes, usd } from '../core/format';
import { prettyCwd } from '../core/ingest';
import { parseFiles, type Progress } from '../core/parse';
import { mergeDatasets } from '../core/merge';
import type { Dataset } from '../core/types';
import { parseZip } from '../core/zip';
import { databaseFile, parseDir } from './dir';

const PLACEHOLDER = '__CLAUDE_LOG_DATASET__';
const DEFAULT_OUT = 'claude-log-report.html';

const HELP = `claude-log ${pkg.version}
Builds a Claude Code, Codex and OpenCode usage dashboard as a single HTML file. Everything runs locally.

Usage:
  claude-log [source...] [options]

Sources (default: $CLAUDE_CONFIG_DIR or ~/.claude, $CODEX_HOME or ~/.codex and
$XDG_DATA_HOME or ~/.local/share/opencode, whichever exist; several sources are
combined into one report):
  a Claude Code data directory (~/.claude, its projects/ directory or one project),
  a Codex data directory (~/.codex or its sessions/ directory),
  an OpenCode data directory or its opencode.db (the -wal file is read too),
  or a .zip made with the command from the web app

Options:
  -o, --out <file>  where to write the report (default: ./${DEFAULT_OUT})
      --claude      only read the default Claude Code directory
      --codex       only read the default Codex directory
      --opencode    only read the default OpenCode directory
      --no-open     don't open the report in the browser
  -h, --help        show this help
  -v, --version     show the version

The report contains your prompts and file paths. Treat it like the transcripts themselves.

Made by Marcin Milewicz · Apache-2.0 · ${pkg.homepage}`;

function fail(message: string): never {
  console.error(`claude-log: ${message}`);
  process.exit(1);
}

// OpenCode's data directory follows the XDG layout (env-paths), on every OS.
export function opencodeDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return resolve(homedir(), 'Library', 'Application Support', 'opencode');
  if (platform === 'win32') {
    const base = resolve(env.LOCALAPPDATA ?? resolve(homedir(), 'AppData', 'Local'), 'opencode');
    // env-paths appends "Data" on Windows; older installs may sit directly in opencode/.
    return existsSync(join(base, 'Data', 'opencode.db')) ? join(base, 'Data') : base;
  }
  return resolve(env.XDG_DATA_HOME ?? resolve(homedir(), '.local', 'share'), 'opencode');
}

function progressLine(p: Progress): string {
  const ratio = p.totalBytes ? Math.min(100, Math.round((p.doneBytes / p.totalBytes) * 100)) : 0;
  return `Parsing ${ratio}% · ${bytes(p.doneBytes)} of ${bytes(p.totalBytes)} · file ${p.filesDone} of ${p.filesTotal}`;
}

export function renderReport(html: string, ds: Dataset): string {
  const parts = html.split(PLACEHOLDER);
  if (parts.length !== 2) throw new Error('The report template is broken: the data placeholder is missing.');
  // "<" only occurs inside JSON strings, where < is equivalent, so the data can't close the <script> tag.
  const json = JSON.stringify(ds).replace(/</g, '\\u003c');
  return parts[0] + json + parts[1];
}

function openInBrowser(file: string) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [file]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', file]] : ['xdg-open', [file]];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => console.error(`Couldn't open a browser. Open ${file} manually.`));
  child.unref();
}

async function parseSource(source: string, onProgress: (p: Progress) => void): Promise<Dataset> {
  if (statSync(source).isDirectory()) return parseDir(source, onProgress);
  if (/\.db$/i.test(source)) return parseFiles(prettyCwd(source), [databaseFile(source)], 0, onProgress);
  return parseZip(await openAsBlob(source), basename(source), onProgress);
}

function describe(ds: Dataset): string {
  if (ds.sources[0] === 'codex') return `${ds.files.transcripts} Codex sessions from ${ds.sourceName}`;
  if (ds.sources[0] === 'opencode') return `${ds.files.transcripts} OpenCode sessions and ${ds.files.subagents} subagents from ${ds.sourceName}`;
  return `${ds.files.transcripts} Claude Code sessions and ${ds.files.subagents} subagents from ${ds.sourceName}`;
}

async function main() {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        out: { type: 'string', short: 'o' },
        claude: { type: 'boolean' },
        codex: { type: 'boolean' },
        opencode: { type: 'boolean' },
        'no-open': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (err) {
    fail(`${err instanceof Error ? err.message : String(err)}\nRun claude-log --help for usage.`);
  }
  const { values, positionals } = args;
  if (values.help) return console.log(HELP);
  if (values.version) return console.log(pkg.version);
  if (positionals.length > 0 && (values.claude || values.codex || values.opencode)) {
    fail('--claude, --codex and --opencode pick the default directories. Pass either sources or these options.');
  }

  const claudeDir = resolve(process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), '.claude'));
  const codexDir = resolve(process.env.CODEX_HOME ?? resolve(homedir(), '.codex'));
  const opencodeDir = opencodeDataDir();
  // Explicit sources must all work. Default directories are skipped when they're missing or hold no sessions.
  const explicit = positionals.length > 0;
  const anyTool = values.claude || values.codex || values.opencode;
  const sources = explicit
    ? positionals.map((p) => resolve(p))
    : [
        ...(values.claude || !anyTool ? [claudeDir] : []),
        ...(values.codex || !anyTool ? [codexDir] : []),
        ...(values.opencode || !anyTool ? [opencodeDir] : []),
      ].filter((d) => existsSync(d));
  for (const s of sources) if (!existsSync(s)) fail(`${s} doesn't exist.`);
  if (sources.length === 0) fail(`Found none of ${claudeDir}, ${codexDir} or ${opencodeDir}. Pass a data directory or zip.`);

  const tty = process.stderr.isTTY;
  const onProgress = (p: Progress) => {
    if (tty) process.stderr.write(`\r\x1b[2K${progressLine(p)}`);
  };
  const clearProgress = () => {
    if (tty) process.stderr.write('\r\x1b[2K');
  };

  const t0 = Date.now();
  const parsed: Dataset[] = [];
  for (const source of sources) {
    try {
      parsed.push(await parseSource(source, onProgress));
    } catch (err) {
      clearProgress();
      const message = err instanceof Error ? err.message : String(err);
      if (explicit) fail(message);
      console.error(`Skipping ${source}: ${message}`);
    }
  }
  clearProgress();
  if (parsed.length === 0) fail('No sessions to report.');
  const ds = mergeDatasets(parsed);

  const out = resolve(values.out ?? DEFAULT_OUT);
  const html = renderReport(template, ds);
  await writeFile(out, html);

  const cost = ds.calls.reduce((s, c) => s + c.cost, 0);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Parsed ${parsed.map(describe).join(', and ')} in ${secs} s (${usd(cost)} at API prices).`);
  console.log(`Report: ${out} (${bytes(html.length)})`);

  if (!values['no-open'] && process.stdout.isTTY) openInBrowser(out);
}

await main();
