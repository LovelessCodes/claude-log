import { Ingestor, classifyPath, type FileKind } from './ingest';
import { CodexIngestor, classifyCodexPath } from './ingest-codex';
import { parseOpenCode } from './ingest-opencode';
import { mergeDatasets } from './merge';
import type { ByteSource } from './sqlite';
import type { Dataset, Source } from './types';

export interface Progress {
  doneBytes: number;
  totalBytes: number;
  filesDone: number;
  filesTotal: number;
  current: string;
}

// One file to ingest, wherever it lives (a zip entry or a file on disk).
export interface SourceFile {
  path: string;
  size: number;
  kind: FileKind;
  lines(onLine: (line: string) => void, onBytes: (n: number) => void): Promise<void>;
  text(): Promise<string>;
  // OpenCode's database, plus its write-ahead log when one is next to it.
  database?(): Promise<{ main: ByteSource; wal: ByteSource | null }>;
}

// OpenCode keeps everything in a SQLite database, not in per-session files.
export function classifyOpenCodePath(rawPath: string): FileKind | null {
  const path = rawPath.replace(/\\/g, '/');
  if (path.endsWith('/') || path.includes('__MACOSX/')) return null;
  return path.split('/').pop() === 'opencode.db' ? { kind: 'database' } : null;
}

// Decides whether a set of paths holds Claude Code, Codex or OpenCode data and
// classifies each path accordingly (null = not used). Claude Code and Codex
// both have a history.jsonl, so one source is picked for the whole set: Claude
// Code when it has transcripts, otherwise Codex when it has rollouts,
// otherwise OpenCode when it has a database.
export function classifyAll(paths: string[]): { source: Source; kinds: (FileKind | null)[] } {
  const claude = paths.map(classifyPath);
  if (claude.some((k) => k?.kind === 'transcript')) return { source: 'claude', kinds: claude };
  const codex = paths.map(classifyCodexPath);
  if (codex.some((k) => k?.kind === 'rollout')) return { source: 'codex', kinds: codex };
  const opencode = paths.map(classifyOpenCodePath);
  if (opencode.some((k) => k?.kind === 'database')) return { source: 'opencode', kinds: opencode };
  return { source: 'claude', kinds: claude };
}

export const NO_TRANSCRIPTS =
  'No Claude Code transcripts (<sessionId>.jsonl files in project directories), Codex sessions (rollout-*.jsonl files) or OpenCode databases (opencode.db)';

// Feeds the files to an Ingestor in order and reports progress.
// `skipped` is the number of files that weren't recognized.
export async function parseFiles(name: string, files: SourceFile[], skipped: number, onProgress: (p: Progress) => void): Promise<Dataset> {
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const progress: Progress = { doneBytes: 0, totalBytes, filesDone: 0, filesTotal: files.length, current: '' };
  let lastReport = 0;
  const report = (force = false) => {
    const now = Date.now();
    if (force || now - lastReport > 150) {
      lastReport = now;
      onProgress({ ...progress });
    }
  };

  const databases = files.filter((f) => f.kind.kind === 'database' && f.database);
  if (databases.length > 0) {
    // A SQLite database is read through a page source instead of line by line.
    const datasets: Dataset[] = [];
    for (const f of databases) {
      progress.current = f.path;
      const { main, wal } = await f.database!();
      const onBytes = (n: number) => {
        progress.doneBytes += n;
        report();
      };
      datasets.push(await parseOpenCode(name, main, wal, onBytes));
      progress.filesDone++;
      report();
    }
    const out = datasets.length === 1 ? datasets[0] : mergeDatasets(datasets);
    out.files.skipped += skipped;
    report(true);
    return out;
  }

  const ing = files.some((f) => f.kind.kind === 'rollout') ? new CodexIngestor(name) : new Ingestor(name);
  for (let i = 0; i < skipped; i++) ing.skip();

  for (const f of files) {
    progress.current = f.path;
    const onBytes = (n: number) => {
      progress.doneBytes += n;
      report();
    };
    const { kind } = f;
    if (kind.kind === 'transcript' || kind.kind === 'subagent' || kind.kind === 'rollout') {
      ing.beginFile(kind);
      await f.lines((l) => ing.line(l), onBytes);
      ing.endFile();
    } else if (kind.kind === 'history') {
      await f.lines((l) => ing.historyLine(l), onBytes);
    } else {
      const text = await f.text();
      onBytes(text.length);
      ing.json(kind, text);
    }
    progress.filesDone++;
    report();
  }
  report(true);
  return ing.finalize();
}
