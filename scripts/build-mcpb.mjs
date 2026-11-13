#!/usr/bin/env node
// Packs the Claude Desktop extension, integrations/claude-desktop/, into bogen-<version>.mcpb: a zip of its
// manifest.json and icon.png, as the MCP Bundle format describes (github.com/modelcontextprotocol/mcpb). Nothing of
// Bogen is bundled: the extension starts the bogen command that install.sh puts in ~/.local/bin.
//
//   node scripts/build-mcpb.mjs [<out dir>]     # default release/mcpb; prints the file it wrote
//
// The zip is the same bytes for the same input: fixed dates, files in name order, deflated. scripts/release.mjs calls
// it and signs the result like its other assets.
import { deflateRawSync, crc32 } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
export const MCPB_SOURCE = join(root, 'integrations', 'claude-desktop');

/** 1 January 2026, 00:00, in the MS-DOS time a zip stores. */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

/** A zip of `files` ({ name: bytes }), deflated, with fixed dates. */
export function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const name of Object.keys(files).sort()) {
    const data = Buffer.from(files[name]);
    const packed = deflateRawSync(data, { level: 9 });
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // made by Unix, zip 3.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** The extension as bytes, and its version, from the folder. */
export function buildMcpb(source = MCPB_SOURCE) {
  const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
  const files = {};
  for (const name of readdirSync(source)) files[name] = readFileSync(join(source, name));
  if (!files['icon.png']) throw new Error(`${source} has no icon.png`);
  return { version: manifest.version, bytes: zip(files) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(process.argv[2] ?? join(root, 'release', 'mcpb'));
  const { version, bytes } = buildMcpb();
  mkdirSync(out, { recursive: true });
  const file = join(out, `bogen-${version}.mcpb`);
  writeFileSync(file, bytes);
  console.log(file);
}
