import { BlobReader, TextWriter, Uint8ArrayWriter, ZipReader, configure, type Entry, type FileEntry } from '@zip.js/zip.js';
import { NO_TRANSCRIPTS, classifyAll, parseFiles, type Progress, type SourceFile } from './parse';
import { bufferSource, type ByteSource } from './sqlite';
import type { Dataset } from './types';

export type { Progress } from './parse';

// The parser itself runs in a Web Worker, so zip.js doesn't need to spawn its own.
configure({ useWebWorkers: false });

// A database inside a zip has to be decompressed whole, because a compressed
// entry can't be read page by page. Refuse sizes a browser can't hold and
// point at the CLI (or the raw opencode.db file, which is read page by page).
const MAX_ZIP_DB = 1_000_000_000;

async function entrySource(entry: FileEntry): Promise<ByteSource> {
  if (entry.uncompressedSize > MAX_ZIP_DB) {
    throw new Error(
      `${entry.filename} is ${(entry.uncompressedSize / 1e9).toFixed(1)} GB. A database this large can't be read from a zip in the browser; run "npx claude-log" instead, or drop the opencode.db file itself.`,
    );
  }
  return bufferSource(await entry.getData(new Uint8ArrayWriter()));
}

async function streamLines(entry: FileEntry, onLine: (line: string) => void, onBytes: (n: number) => void) {
  const decoder = new TextDecoderStream();
  const writing = entry.getData(decoder.writable);
  const reader = decoder.readable.getReader();
  let rest = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    onBytes(value.length);
    const parts = (rest + value).split('\n');
    rest = parts.pop() ?? '';
    for (const p of parts) onLine(p);
  }
  if (rest) onLine(rest);
  await writing;
}

export async function parseZip(file: Blob, name: string, onProgress: (p: Progress) => void): Promise<Dataset> {
  const zip = new ZipReader(new BlobReader(file));
  const entries: Entry[] = await zip.getEntries();

  const fileEntries = entries.filter((e) => !e.directory);
  const { kinds } = classifyAll(fileEntries.map((e) => e.filename));
  const byName = new Map(fileEntries.map((e) => [e.filename, e as FileEntry]));
  const wanted: SourceFile[] = [];
  let skipped = 0;
  for (const [i, e] of fileEntries.entries()) {
    const kind = kinds[i];
    if (!kind) {
      skipped++;
      continue;
    }
    const entry = e as FileEntry;
    const wal = kind.kind === 'database' ? byName.get(`${entry.filename}-wal`) : undefined;
    wanted.push({
      path: entry.filename,
      size: entry.uncompressedSize + (wal?.uncompressedSize ?? 0),
      kind,
      lines: (onLine, onBytes) => streamLines(entry, onLine, onBytes),
      text: () => entry.getData(new TextWriter()),
      ...(kind.kind === 'database' ? { database: async () => ({ main: await entrySource(entry), wal: wal ? await entrySource(wal) : null }) } : {}),
    });
  }
  if (wanted.length === 0) {
    await zip.close();
    throw new Error(`${NO_TRANSCRIPTS} in the zip.`);
  }

  try {
    return await parseFiles(name, wanted, skipped, onProgress);
  } finally {
    await zip.close();
  }
}
