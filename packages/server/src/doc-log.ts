import { crc32 } from 'node:zlib';

/**
 * The update log of one file, `files/<id>.updates`: the Yjs updates made since the last full save, one record each,
 * appended as they happen. A save then costs what the edit costs, not what the file weighs.
 *
 * A record is its length (u32, little endian), the CRC-32 of its bytes (u32) and the bytes. A crash can leave the last
 * record cut short or half written; reading stops at the first record that does not check out, and what came before
 * it is kept.
 */

const HEADER = 8;
/** One Yjs update is far smaller; a length above this is a damaged header, not a record. */
const MAX_RECORD = 512 * 1024 * 1024;

export function encodeRecords(records: readonly Uint8Array[]): Uint8Array {
  let size = 0;
  for (const r of records) size += HEADER + r.byteLength;
  const out = Buffer.allocUnsafe(size);
  let at = 0;
  for (const r of records) {
    out.writeUInt32LE(r.byteLength, at);
    out.writeUInt32LE(crc32(r) >>> 0, at + 4);
    out.set(r, at + HEADER);
    at += HEADER + r.byteLength;
  }
  return out;
}

/** The records that check out, and how many bytes of the log they take; anything after that is a torn tail. */
export function decodeRecords(log: Uint8Array): { records: Uint8Array[]; validBytes: number } {
  const buf = Buffer.from(log.buffer, log.byteOffset, log.byteLength);
  const records: Uint8Array[] = [];
  let at = 0;
  while (at + HEADER <= buf.length) {
    const length = buf.readUInt32LE(at);
    const sum = buf.readUInt32LE(at + 4);
    if (length > MAX_RECORD || at + HEADER + length > buf.length) break;
    const body = buf.subarray(at + HEADER, at + HEADER + length);
    if ((crc32(body) >>> 0) !== sum) break;
    records.push(new Uint8Array(body));
    at += HEADER + length;
  }
  return { records, validBytes: at };
}
