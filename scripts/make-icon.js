// Writes extension/icon.png, the icon shown in desktop notifications. Chrome needs a PNG for notifications.
import zlib from "node:zlib";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "extension", "icon.png");
const SIZE = 128;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// A plain blue square with a white border: simple, clear at notification size.
function pixels() {
  const row = 1 + SIZE * 4;
  const raw = Buffer.alloc(SIZE * row);
  for (let y = 0; y < SIZE; y++) {
    raw[y * row] = 0; // no filter
    for (let x = 0; x < SIZE; x++) {
      const border = x < 8 || y < 8 || x >= SIZE - 8 || y >= SIZE - 8;
      const i = y * row + 1 + x * 4;
      const [r, g, b] = border ? [255, 255, 255] : [26, 111, 216];
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = 255;
    }
  }
  return raw;
}

export async function writeIcon() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(pixels())),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  await fs.writeFile(OUT, png);
  return OUT;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`icon written: ${path.relative(ROOT, await writeIcon())}`);
}
