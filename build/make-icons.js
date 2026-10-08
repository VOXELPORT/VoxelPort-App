'use strict';

/**
 * Generates every VoxelPort icon from pixel-art masters (no image libraries
 * needed — PNG and ICO files are encoded by hand below).
 *
 *   node build/make-icons.js
 *
 * Writes the app icon (.png/.ico), the window icon, the Microsoft Store
 * tiles, and — when the sibling repos are checked out next to this one —
 * the website favicon/logo, the Fabric mod icon and the Store listing logos.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ─── Palette (matches the comic × Minecraft theme) ───────────────────────────
const C = {
  O: [0x15, 0x12, 0x0f, 255], // ink
  K: [0xf3, 0xeb, 0xdc, 255], // cream paper
  d: [0xe2, 0xd4, 0xb9, 255], // halftone dot
  V: [0x5f, 0xae, 0x3b, 255], // grass green
  v: [0x3f, 0x7f, 0x25, 255], // dark green
  R: [0xc8, 0x26, 0x2b, 255], // redstone red (drop layer)
  r: [0x9a, 0x1b, 0x1f, 255], // dark red
};
const CLEAR = [0, 0, 0, 0];

// The pixel "V" used in the app/site headers (13×12).
const V_SPRITE = [
  'OOOO.....OOOO',
  'OVVO.....OVVO',
  'OVVO.....OVVO',
  'OvVVO...OVVvO',
  '.OVVO...OVVO.',
  '.OvVVO.OVVvO.',
  '..OVVO.OVVO..',
  '..OvVVOVVvO..',
  '...OVVVVVO...',
  '...OvVVVvO...',
  '....OVVVO....',
  '.....OOO.....',
];

/** A size×size grid of RGBA pixels, every cell transparent. */
function grid(size) {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => CLEAR));
}

/** Cream tile with an ink outline, notched (pixel-rounded) corners and halftone dots. */
function drawTile(g, size) {
  const n = size - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cornerX = Math.min(x, n - x);
      const cornerY = Math.min(y, n - y);
      if (cornerX + cornerY < 2) continue; // notched corner: transparent
      const edge = cornerX === 0 || cornerY === 0 || (cornerX + cornerY === 2);
      if (edge) { g[y][x] = C.O; continue; }
      const dot = size >= 32 && x % 4 === 2 && y % 4 === 2;
      g[y][x] = dot ? C.d : C.K;
    }
  }
}

/** Draws the V sprite at (ox, oy), each sprite pixel `scale`×`scale`, optionally recoloured. */
function drawSprite(g, ox, oy, scale, recolor = {}) {
  V_SPRITE.forEach((row, sy) => {
    [...row].forEach((ch, sx) => {
      if (ch === '.') return;
      const col = C[recolor[ch] || ch];
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) g[oy + sy * scale + dy][ox + sx * scale + dx] = col;
    });
  });
}

/** The V's fill cells (no outline) scaled 2× → list of [x, y, colourKey], origin at 0,0. */
function vFill2x() {
  const cells = [];
  V_SPRITE.forEach((row, sy) => [...row].forEach((ch, sx) => {
    if (ch === 'V' || ch === 'v') cells.push([sx, sy, ch]);
  }));
  const minX = Math.min(...cells.map((c) => c[0]));
  const minY = Math.min(...cells.map((c) => c[1]));
  const out = [];
  for (const [x, y, ch] of cells) {
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) out.push([(x - minX) * 2 + dx, (y - minY) * 2 + dy, ch]);
  }
  return out;
}

/** Paints a layer of cells at (ox, oy): a 1px ink outline first, then the fill. */
function drawOutlined(g, cells, ox, oy, colorOf) {
  const key = (x, y) => `${x},${y}`;
  const filled = new Set(cells.map(([x, y]) => key(x + ox, y + oy)));
  for (const k of filled) {
    const [x, y] = k.split(',').map(Number);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (Math.abs(dx) + Math.abs(dy) !== 1) continue; // 4-neighbour outline keeps pixel corners crisp
        if (!filled.has(key(x + dx, y + dy))) g[y + dy][x + dx] = C.O;
      }
    }
  }
  for (const [x, y, ch] of cells) g[y + oy][x + ox] = colorOf(ch);
}

/** 32×32 master: 2× V with an outlined red comic drop-layer offset down-right. */
function master32() {
  const g = grid(32);
  drawTile(g, 32);
  const cells = vFill2x();
  const w = Math.max(...cells.map((c) => c[0])) + 1;
  const h = Math.max(...cells.map((c) => c[1])) + 1;
  const shift = 3;
  // Centre the combined footprint (main + offset layer) inside the tile.
  const ox = Math.round((32 - (w + shift)) / 2);
  const oy = Math.round((32 - (h + shift)) / 2);
  drawOutlined(g, cells, ox + shift, oy + shift, (ch) => (ch === 'v' ? C.r : C.R));
  drawOutlined(g, cells, ox, oy, (ch) => C[ch]);
  // Where the drop layer only peeks through the V's notch as stray single
  // pixels, ink them over — at icon sizes they read as noise, not shadow.
  const isRed = (x, y) => g[y] && (g[y][x] === C.R || g[y][x] === C.r);
  const stray = [];
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      if (!isRed(x, y)) continue;
      const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => isRed(x + dx, y + dy)).length;
      if (n < 2) stray.push([x, y]);
    }
  }
  for (const [x, y] of stray) g[y][x] = C.O;
  return g;
}

/** 16×16 master for tiny sizes: 1× V, no drop layer (it would just be noise). */
function master16() {
  const g = grid(16);
  drawTile(g, 16);
  drawSprite(g, 1, 2, 1);
  return g;
}

// ─── Raster helpers ──────────────────────────────────────────────────────────

/** Nearest-neighbour upscale by an integer factor → { w, h, px: Buffer RGBA }. */
function upscale(g, factor) {
  const n = g.length;
  const w = n * factor;
  const px = Buffer.alloc(w * w * 4);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const c = g[Math.floor(y / factor)][Math.floor(x / factor)];
      px.set(c, (y * w + x) * 4);
    }
  }
  return { w, h: w, px };
}

/** Area-average downscale (premultiplied alpha) to an arbitrary w×h. */
function resize(img, w, h) {
  const out = Buffer.alloc(w * h * 4);
  const sx = img.w / w;
  const sy = img.h / h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0; let gg = 0; let b = 0; let a = 0; let count = 0;
      for (let yy = Math.floor(y * sy); yy < Math.ceil((y + 1) * sy); yy++) {
        for (let xx = Math.floor(x * sx); xx < Math.ceil((x + 1) * sx); xx++) {
          const i = (yy * img.w + xx) * 4;
          const al = img.px[i + 3] / 255;
          r += img.px[i] * al; gg += img.px[i + 1] * al; b += img.px[i + 2] * al; a += al; count++;
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(gg / a); out[o + 2] = Math.round(b / a); }
      out[o + 3] = Math.round((a / count) * 255);
    }
  }
  return { w, h, px: out };
}

/** Places `img` centred on a halftone cream canvas of w×h (for wide Store tiles). */
function onPaper(img, w, h) {
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dot = x % 10 === 5 && y % 10 === 5;
      px.set(dot ? C.d : C.K, (y * w + x) * 4);
    }
  }
  const ox = Math.floor((w - img.w) / 2);
  const oy = Math.floor((h - img.h) / 2);
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const s = (y * img.w + x) * 4;
      const al = img.px[s + 3] / 255;
      if (!al) continue;
      const d = ((oy + y) * w + ox + x) * 4;
      for (let k = 0; k < 3; k++) px[d + k] = Math.round(img.px[s + k] * al + px[d + k] * (1 - al));
      px[d + 3] = 255;
    }
  }
  return { w, h, px };
}

// ─── Encoders ────────────────────────────────────────────────────────────────

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
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png({ w, h, px }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
/** Classic ICO bitmap entry: 32-bit BGRA, bottom-up, plus an (unused) AND mask. */
function dib({ w, h, px }) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); header.writeInt32LE(w, 4); header.writeInt32LE(h * 2, 8);
  header.writeUInt16LE(1, 12); header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = ((h - 1 - y) * w + x) * 4;
      const d = (y * w + x) * 4;
      pixels[d] = px[s + 2]; pixels[d + 1] = px[s + 1]; pixels[d + 2] = px[s]; pixels[d + 3] = px[s + 3];
    }
  }
  const maskRow = Math.ceil(w / 32) * 4;
  return Buffer.concat([header, pixels, Buffer.alloc(maskRow * h)]);
}

/**
 * ICO container: PNG for the 256px entry (smaller file), classic bitmaps for
 * the rest — the most compatible mix across Explorer, installers and tools.
 */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  const pngs = images.map((img) => (img.w >= 256 ? png(img) : dib(img)));
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach((img, i) => {
    const e = i * 16;
    dir[e] = img.w >= 256 ? 0 : img.w; dir[e + 1] = img.h >= 256 ? 0 : img.h;
    dir[e + 2] = 0; dir[e + 3] = 0;
    dir.writeUInt16LE(1, e + 4); dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(pngs[i].length, e + 8); dir.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  return Buffer.concat([header, dir, ...pngs]);
}

/** SVG of a pixel grid (merges horizontal runs) — used for the website favicon. */
function svg(g) {
  const n = g.length;
  let rects = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n;) {
      const c = g[y][x];
      let e = x;
      while (e < n && g[y][e] === c) e++;
      if (c[3]) rects += `<rect x="${x}" y="${y}" width="${e - x}" height="1" fill="#${c.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('')}"/>`;
      x = e;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">${rects}</svg>\n`;
}

// ─── Build everything ────────────────────────────────────────────────────────

const m32 = master32();
const m16 = master16();
const big = upscale(m32, 32); // 1024×1024 pixel-perfect master

/** Best-looking square icon at `size`: exact pixel art where possible. */
function iconAt(size) {
  if (size % 32 === 0) return upscale(m32, size / 32);
  if (size % 16 === 0 && size < 32) return upscale(m16, size / 16);
  if (size < 32) return resize(upscale(m16, 12), size, size);
  return resize(big, size, size);
}

const here = __dirname;
const app = path.join(here, '..');
const repos = path.join(app, '..');
const written = [];
function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  written.push(path.relative(repos, file));
}

// Desktop app
write(path.join(here, 'icon.png'), png(big));
write(path.join(here, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256].map(iconAt)));
write(path.join(app, 'src', 'renderer', 'icon.png'), png(iconAt(256)));
write(path.join(app, 'src', 'renderer', 'icon.svg'), svg(m32)); // crisp header logo

// Microsoft Store (MSIX) tiles
const tiles = path.join(here, 'appx');
write(path.join(tiles, 'StoreLogo.png'), png(iconAt(50)));
write(path.join(tiles, 'Square44x44Logo.png'), png(iconAt(44)));
write(path.join(tiles, 'SmallTile.png'), png(onPaper(iconAt(48), 71, 71)));
write(path.join(tiles, 'Square150x150Logo.png'), png(onPaper(iconAt(96), 150, 150)));
write(path.join(tiles, 'Wide310x150Logo.png'), png(onPaper(iconAt(128), 310, 150)));
write(path.join(tiles, 'LargeTile.png'), png(onPaper(iconAt(224), 310, 310)));

// Sibling repos / folders, when present
const site = path.join(repos, 'website', 'public');
if (fs.existsSync(site)) {
  write(path.join(site, 'logo.png'), png(iconAt(512)));
  write(path.join(site, 'favicon.svg'), svg(m32));
  write(path.join(site, 'apple-touch-icon.png'), png(onPaper(iconAt(160), 180, 180)));
}
const mod = path.join(repos, 'VoxelPort', 'src', 'main', 'resources', 'assets', 'voxelport');
if (fs.existsSync(mod)) write(path.join(mod, 'icon.png'), png(iconAt(512)));
const store = path.join(repos, 'store-screenshots');
if (fs.existsSync(store)) {
  for (const s of [300, 150, 71]) write(path.join(store, `store-logo-${s}x${s}.png`), png(iconAt(s)));
}

console.log(written.join('\n'));
