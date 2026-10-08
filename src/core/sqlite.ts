// A small read-only SQLite reader. OpenCode keeps its sessions in a SQLite
// database (opencode.db), and claude-log has no runtime dependencies, so this
// walks the table B-trees itself: file header, pages, records and overflow
// pages, plus the write-ahead log, which usually holds the newest sessions
// because OpenCode is running while the report is made.
//
// Only what a full table scan needs is implemented: no indexes, no writes.

export interface ByteSource {
  size(): Promise<number>;
  read(offset: number, length: number): Promise<Uint8Array>;
  close?(): Promise<void>;
}

// A ByteSource over bytes already in memory (a zip entry, a test fixture).
export function bufferSource(bytes: Uint8Array): ByteSource {
  return {
    async size() {
      return bytes.length;
    },
    async read(offset: number, length: number) {
      return bytes.subarray(offset, Math.min(offset + length, bytes.length));
    },
  };
}

// A row is decoded into values in column order. Integers become numbers,
// text becomes a string, blobs stay bytes.
export type SqlValue = null | number | string | Uint8Array;

export interface SqliteTable {
  name: string;
  columns: string[];
  rootPage: number;
}

export interface SqliteDatabase {
  tables(): Map<string, SqliteTable>;
  scan(table: string): AsyncGenerator<SqlValue[]>;
}

const HEADER = 'SQLite format 3\0';
const WAL_MAGIC = 0x377f0682;
const WAL_MAGIC_MASK = 0xffff_fffe;

function readU16(b: Uint8Array, at: number): number {
  return (b[at] << 8) | b[at + 1];
}

function readU32(b: Uint8Array, at: number): number {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
}

// SQLite's variable-length integer: the first 8 bytes carry 7 bits each, the
// ninth carries 8.
function varint(b: Uint8Array, at: number): { value: number; next: number } {
  let value = 0;
  for (let i = 0; i < 8; i++) {
    const x = b[at + i];
    value = value * 128 + (x & 0x7f);
    if (x < 0x80) return { value, next: at + i + 1 };
  }
  value = value * 256 + b[at + 8];
  return { value, next: at + 9 };
}

// Serial types 1-6 are integers of 1, 2, 3, 4, 6 and 8 bytes.
const INT_SIZE = [0, 1, 2, 3, 4, 6, 8];

// Reads a big-endian signed integer of 1-8 bytes. Values beyond 2^53 lose
// precision, which is fine for the sizes, timestamps and counters here.
function readInt(b: Uint8Array, at: number, size: number): number {
  if (size === 8) return Number(new DataView(b.buffer, b.byteOffset + at, 8).getBigInt64(0, false));
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + b[at + i];
  const limit = 2 ** (size * 8 - 1);
  if (v >= limit) v -= 2 ** (size * 8);
  return v;
}

function readDouble(b: Uint8Array, at: number): number {
  const view = new DataView(b.buffer, b.byteOffset + at, 8);
  return view.getFloat64(0, false);
}

// Pulls column names out of a CREATE TABLE statement. Table constraints
// (PRIMARY KEY, FOREIGN KEY, …) are skipped.
export function columnsFromSql(sql: string): string[] {
  const open = sql.indexOf('(');
  const close = sql.lastIndexOf(')');
  if (open < 0 || close <= open) return [];
  const body = sql.slice(open + 1, close);
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  let quote = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === '`' || c === "'" || c === '[') {
      quote = c === '[' ? ']' : c;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      items.push(body.slice(start, i));
      start = i + 1;
    }
  }
  items.push(body.slice(start));
  const out: string[] = [];
  for (const item of items) {
    const m = item.trim().match(/^(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][\w$]*))/);
    if (!m) continue;
    const name = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)$/i.test(name)) continue;
    out.push(name);
  }
  return out;
}

// The WAL: frames of pages written since the last checkpoint. Only frames
// from the last complete commit are used, so a half-written tail is ignored.
class Wal {
  private frames = new Map<number, number>();
  private pageSize = 0;

  constructor(
    private data: Uint8Array,
    private dbPageSize: number,
  ) {}

  // Returns false when the file isn't a usable WAL.
  parse(): boolean {
    if (this.data.length < 32) return false;
    const magic = readU32(this.data, 0);
    if ((magic & WAL_MAGIC_MASK) !== WAL_MAGIC) return false;
    let pageSize = readU32(this.data, 8);
    if (pageSize === 0) pageSize = this.dbPageSize;
    if (pageSize !== this.dbPageSize) return false;
    this.pageSize = pageSize;

    // The magic's low bit picks the byte order of the checksums. Try both:
    // whichever reproduces the stored header checksum is the right one.
    const little = this.checksumOrder(readU32(this.data, 24), readU32(this.data, 28));
    if (little == null) return false;
    let sum = this.headerChecksum(little);
    if (sum[0] !== readU32(this.data, 24) || sum[1] !== readU32(this.data, 28)) return false;

    const frameSize = 24 + pageSize;
    let lastCommit = -1;
    let index = 0;
    for (let at = 32; at + frameSize <= this.data.length; at += frameSize, index++) {
      const pageNo = readU32(this.data, at);
      const commitSize = readU32(this.data, at + 4);
      if (pageNo === 0) break;
      if (readU32(this.data, at + 8) !== readU32(this.data, 16) || readU32(this.data, at + 12) !== readU32(this.data, 20)) break;
      sum = this.frameChecksum(at, pageSize, little, sum);
      if (sum[0] !== readU32(this.data, at + 16) || sum[1] !== readU32(this.data, at + 20)) break;
      if (commitSize !== 0) lastCommit = index;
    }
    if (lastCommit < 0) return false;
    for (let i = 0, at = 32; i <= lastCommit; i++, at += frameSize) this.frames.set(readU32(this.data, at), at + 24);
    return true;
  }

  page(pgno: number): Uint8Array | null {
    const at = this.frames.get(pgno);
    return at == null ? null : this.data.subarray(at, at + this.pageSize);
  }

  private checksumOrder(stored0: number, stored1: number): boolean | null {
    for (const little of [false, true]) {
      const [s0, s1] = this.headerChecksum(little);
      if (s0 === stored0 && s1 === stored1) return little;
    }
    return null;
  }

  private headerChecksum(little: boolean): [number, number] {
    return checksum(this.data, 0, 24, 0, 0, little);
  }

  private frameChecksum(at: number, pageSize: number, little: boolean, seed: [number, number]): [number, number] {
    // The checksum covers the frame's first 8 bytes and the page content.
    const head = this.data.subarray(at, at + 8);
    const [s0, s1] = checksum(head, 0, 8, seed[0], seed[1], little);
    return checksum(this.data, at + 24, at + 24 + pageSize, s0, s1, little);
  }
}

// SQLite's WAL checksum: two 32-bit sums over 8-byte blocks.
function checksum(data: Uint8Array, start: number, end: number, s0: number, s1: number, little: boolean): [number, number] {
  let a = s0 >>> 0;
  let b = s1 >>> 0;
  for (let at = start; at + 8 <= end; at += 8) {
    const x0 = little ? (data[at] | (data[at + 1] << 8) | (data[at + 2] << 16) | (data[at + 3] << 24)) >>> 0 : readU32(data, at);
    const x1 = little ? (data[at + 4] | (data[at + 5] << 8) | (data[at + 6] << 16) | (data[at + 7] << 24)) >>> 0 : readU32(data, at + 4);
    a = (a + x0 + b) >>> 0;
    b = (b + x1 + a) >>> 0;
  }
  return [a, b];
}

// Caches decoded pages by number. Pages of a table are often spread across the
// whole file (rows deleted and reused), so reading exact pages beats pulling
// in large chunks around them; a few pages of read-ahead keep a B-tree scan
// from issuing one request per 4 KB page.
class PageCache {
  private pages = new Map<number, Uint8Array>();

  constructor(
    private src: ByteSource,
    private pageSize: number,
    private onBytes?: (n: number) => void,
  ) {}

  async page(pgno: number): Promise<Uint8Array> {
    const cached = this.pages.get(pgno);
    if (cached) return cached;
    const bytes = await this.src.read((pgno - 1) * this.pageSize, this.pageSize * 4);
    const count = Math.floor(bytes.length / this.pageSize);
    for (let i = 0; i < count; i++) {
      const no = pgno + i;
      if (this.pages.has(no)) continue;
      this.onBytes?.(this.pageSize);
      if (this.pages.size >= 8192) this.pages.delete(this.pages.keys().next().value as number);
      this.pages.set(no, bytes.subarray(i * this.pageSize, (i + 1) * this.pageSize));
    }
    const page = this.pages.get(pgno);
    if (!page) throw new Error(`SQLite page ${pgno} is beyond the end of the file.`);
    return page;
  }
}

class Reader implements SqliteDatabase {
  private pageSize = 0;
  private reserved = 0;
  private decoder = new TextDecoder('utf-8');
  private wal: Wal | null = null;
  private schema = new Map<string, SqliteTable>();
  private pages: PageCache | null = null;

  constructor(
    private src: ByteSource,
    private onBytes?: (n: number) => void,
  ) {}

  async open(walData: Uint8Array | null): Promise<void> {
    const fileSize = await this.src.size();
    if (fileSize < 100) throw new Error('Not a SQLite database: the file is too small.');
    const head = await this.src.read(0, 100);
    if (new TextDecoder().decode(head.subarray(0, 16)) !== HEADER) throw new Error('Not a SQLite database: the file header is missing.');
    let pageSize = readU16(head, 16);
    if (pageSize === 1) pageSize = 65536;
    if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0) throw new Error(`Unsupported SQLite page size ${pageSize}.`);
    this.pageSize = pageSize;
    this.reserved = head[20];
    const encoding = readU32(head, 56);
    if (encoding === 2) this.decoder = new TextDecoder('utf-16le');
    else if (encoding === 3) this.decoder = new TextDecoder('utf-16be');
    this.pages = new PageCache(this.src, pageSize, this.onBytes);

    if (walData) {
      const wal = new Wal(walData, pageSize);
      if (wal.parse()) this.wal = wal;
    }
    await this.readSchema();
  }

  tables(): Map<string, SqliteTable> {
    return this.schema;
  }

  async *scan(table: string): AsyncGenerator<SqlValue[]> {
    const info = this.schema.get(table);
    if (!info) throw new Error(`SQLite table ${table} not found.`);
    const seen = new Set<number>();
    const stack = [info.rootPage];
    while (stack.length > 0) {
      const pgno = stack.pop() as number;
      if (pgno === 0 || seen.has(pgno)) continue;
      seen.add(pgno);
      const page = await this.page(pgno);
      const hdr = pgno === 1 ? 100 : 0;
      const type = page[hdr];
      const nCell = readU16(page, hdr + 3);
      if (type === 13) {
        for (let i = 0; i < nCell; i++) {
          const cell = readU16(page, hdr + 8 + i * 2);
          yield await this.record(page, cell, info.columns.length);
        }
      } else if (type === 5) {
        // Push the children so the stack pops them in rowid order: the
        // rightmost pointer last, the cell pointers right to left.
        stack.push(readU32(page, hdr + 8));
        for (let i = nCell - 1; i >= 0; i--) {
          const cell = readU16(page, hdr + 12 + i * 2);
          stack.push(readU32(page, cell));
        }
      } else {
        throw new Error(`Unsupported SQLite B-tree page type ${type} in table ${table}.`);
      }
    }
  }

  // A table leaf cell: payload size, rowid, then the record payload (with the
  // spill list when it doesn't fit on one page).
  private async record(page: Uint8Array, cell: number, columns: number): Promise<SqlValue[]> {
    const { value: payloadSize, next } = varint(page, cell);
    const { next: body } = varint(page, next);
    const usable = this.pageSize - this.reserved;
    let local = payloadSize;
    if (payloadSize > usable - 35) {
      const maxLocal = usable - 35;
      const minLocal = Math.floor(((usable - 12) * 32) / 255) - 23;
      local = minLocal + ((payloadSize - minLocal) % (usable - 4));
      if (local > maxLocal) local = minLocal;
    }
    let payload: Uint8Array;
    if (local === payloadSize) {
      payload = page.subarray(body, body + payloadSize);
    } else {
      payload = new Uint8Array(payloadSize);
      payload.set(page.subarray(body, body + local), 0);
      let overflow = readU32(page, body + local);
      let at = local;
      while (overflow !== 0 && at < payloadSize) {
        const p = await this.page(overflow);
        overflow = readU32(p, 0);
        const take = Math.min(usable - 4, payloadSize - at);
        payload.set(p.subarray(4, 4 + take), at);
        at += take;
      }
    }
    return this.decode(payload, columns);
  }

  private decode(payload: Uint8Array, columns: number): SqlValue[] {
    const { value: headerSize, next: first } = varint(payload, 0);
    const types: number[] = [];
    let at = first;
    while (at < headerSize) {
      const { value, next } = varint(payload, at);
      types.push(value);
      at = next;
    }
    const out: SqlValue[] = [];
    let data = headerSize;
    for (let i = 0; i < columns; i++) {
      const t = types[i] ?? 0;
      if (t === 0) {
        out.push(null);
      } else if (t >= 1 && t <= 6) {
        const size = INT_SIZE[t];
        out.push(readInt(payload, data, size));
        data += size;
      } else if (t === 7) {
        out.push(readDouble(payload, data));
        data += 8;
      } else if (t === 8) {
        out.push(0);
      } else if (t === 9) {
        out.push(1);
      } else if (t >= 12) {
        const size = t >= 13 && t % 2 === 1 ? (t - 13) / 2 : (t - 12) / 2;
        const bytes = payload.subarray(data, data + size);
        if (t % 2 === 1) {
          out.push(this.decoder.decode(bytes));
        } else {
          out.push(bytes.slice());
        }
        data += size;
      } else {
        throw new Error(`Unsupported SQLite serial type ${t}.`);
      }
    }
    return out;
  }

  private async readSchema(): Promise<void> {
    const stack = [1];
    const seen = new Set<number>();
    while (stack.length > 0) {
      const pgno = stack.pop() as number;
      if (pgno === 0 || seen.has(pgno)) continue;
      seen.add(pgno);
      const page = await this.page(pgno);
      const hdr = pgno === 1 ? 100 : 0;
      const type = page[hdr];
      const nCell = readU16(page, hdr + 3);
      if (type === 13) {
        for (let i = 0; i < nCell; i++) {
          const cell = readU16(page, hdr + 8 + i * 2);
          const row = await this.record(page, cell, 5);
          const [kind, name, , root, sql] = row;
          if (kind === 'table' && typeof name === 'string' && typeof root === 'number' && typeof sql === 'string') {
            this.schema.set(name, { name, columns: columnsFromSql(sql), rootPage: root });
          }
        }
      } else if (type === 5) {
        for (let i = 0; i < nCell; i++) {
          const cell = readU16(page, hdr + 12 + i * 2);
          stack.push(readU32(page, cell));
        }
        stack.push(readU32(page, hdr + 8));
      } else {
        throw new Error('Unsupported SQLite B-tree page type in the schema table.');
      }
    }
  }

  private async page(pgno: number): Promise<Uint8Array> {
    const fromWal = this.wal?.page(pgno);
    if (fromWal) return fromWal;
    return (this.pages as PageCache).page(pgno);
  }
}

// Opens a database (and optionally its -wal file) for scanning.
export async function openSqlite(main: ByteSource, wal: ByteSource | null, onBytes?: (n: number) => void): Promise<SqliteDatabase> {
  const walData = wal ? await readAll(wal, onBytes) : null;
  const reader = new Reader(main, onBytes);
  await reader.open(walData);
  return reader;
}

async function readAll(src: ByteSource, onBytes?: (n: number) => void): Promise<Uint8Array> {
  const size = await src.size();
  const out = new Uint8Array(size);
  let at = 0;
  while (at < size) {
    const chunk = await src.read(at, Math.min(1 << 20, size - at));
    if (chunk.length === 0) break;
    out.set(chunk, at);
    at += chunk.length;
    onBytes?.(chunk.length);
  }
  return out.subarray(0, at);
}
