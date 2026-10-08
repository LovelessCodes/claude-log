import { blobSource } from '../core/blob';
import { mergeDatasets } from '../core/merge';
import { parseFiles, type Progress, type SourceFile } from '../core/parse';
import { parseZip } from '../core/zip';
import type { Dataset } from '../core/types';

export type WorkerMessage =
  | { type: 'progress'; progress: Progress }
  | { type: 'done'; dataset: Dataset }
  | { type: 'error'; message: string };

const isDatabase = (name: string) => /\.db$/i.test(name);
const isWal = (name: string) => /\.db-wal$/i.test(name);
const isShm = (name: string) => /\.db-shm$/i.test(name);

self.onmessage = async (e: MessageEvent<{ files: File[] }>) => {
  const post = (m: WorkerMessage) => self.postMessage(m);
  try {
    const files = e.data.files;
    // A dropped opencode.db is paired with its -wal file when both are here.
    const wals = new Map(files.filter((f) => isWal(f.name)).map((f) => [f.name.replace(/-wal$/i, ''), f]));
    const parsed: Dataset[] = [];
    for (const file of files) {
      if (isWal(file.name) || isShm(file.name)) continue;
      if (isDatabase(file.name)) {
        const wal = wals.get(file.name) ?? null;
        const source: SourceFile = {
          path: file.name,
          size: file.size + (wal?.size ?? 0),
          kind: { kind: 'database' },
          lines: async () => {},
          text: async () => '',
          database: async () => ({ main: blobSource(file), wal: wal ? blobSource(wal) : null }),
        };
        parsed.push(await parseFiles(file.name, [source], 0, (progress) => post({ type: 'progress', progress })));
      } else {
        parsed.push(await parseZip(file, file.name, (progress) => post({ type: 'progress', progress })));
      }
    }
    if (parsed.length === 0) throw new Error('Nothing to read. Drop a .zip file, or an opencode.db (the -wal file only works next to its database).');
    post({ type: 'done', dataset: mergeDatasets(parsed) });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
