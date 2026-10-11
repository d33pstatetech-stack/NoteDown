/**
 * Generates the placeholder application icon (`apps/desktop/src-tauri/icons/source.png`).
 *
 * The icon is committed as a PNG so packaging does not depend on a design file;
 * `pnpm --filter @localnotes/desktop exec tauri icon <that file>` derives the
 * platform-specific `.ico`/`.icns`/resized PNGs when an installer is built.
 * Written by hand (zlib + CRC32) to avoid adding an image dependency.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 1024;
const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, "../apps/desktop/src-tauri/icons/source.png");

const CRC_TABLE = new Int32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value;
});

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Rounded square with three text lines: a generic "note" glyph. */
function render() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  const radius = SIZE * 0.22;
  const inset = SIZE * 0.06;
  const put = (x, y, [r, g, b, a]) => {
    const offset = (y * SIZE + x) * 4;
    pixels[offset] = r;
    pixels[offset + 1] = g;
    pixels[offset + 2] = b;
    pixels[offset + 3] = a;
  };
  const insideRounded = (x, y) => {
    const min = inset;
    const max = SIZE - inset;
    if (x < min || x > max || y < min || y > max) return false;
    const cx = Math.min(Math.max(x, min + radius), max - radius);
    const cy = Math.min(Math.max(y, min + radius), max - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };
  const lines = [
    { top: 0.3, width: 0.42 },
    { top: 0.46, width: 0.62 },
    { top: 0.62, width: 0.52 },
  ].map((line) => ({
    y0: SIZE * line.top,
    y1: SIZE * (line.top + 0.07),
    x0: SIZE * 0.24,
    x1: SIZE * (0.24 + line.width),
  }));

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if (!insideRounded(x, y)) {
        put(x, y, [0, 0, 0, 0]);
        continue;
      }
      const onLine = lines.some(
        (line) => y >= line.y0 && y <= line.y1 && x >= line.x0 && x <= line.x1,
      );
      put(x, y, onLine ? [255, 255, 255, 255] : [11, 92, 173, 255]);
    }
  }
  return pixels;
}

function encode(pixels) {
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    raw[y * (SIZE * 4 + 1)] = 0;
    pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, encode(render()));
console.log(`wrote ${target}`);
