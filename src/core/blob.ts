import type { ByteSource } from './sqlite';

// A random-access ByteSource over a browser File or Blob. Reading a slice
// doesn't load the whole file, so a large opencode.db stays on disk and the
// SQLite reader pulls only the pages it needs.
export function blobSource(blob: Blob): ByteSource {
  return {
    async size() {
      return blob.size;
    },
    async read(offset: number, length: number) {
      return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
    },
  };
}
