// Read an image file into a greyscale Float64Array (0 = black, 1 = white; 64-bit to match Python).
// PNG, JPEG, BMP, GIF and WebP are decoded by the browser; uncompressed TIFF (8 or 16
// bit, grey or RGB) by the small reader below. Colour is converted to grey with the
// same weights as the Python loader (ITU-R 601: 0.299 R + 0.587 G + 0.114 B); a grey
// image stored as RGB stays exact, and colour luma is rounded to whole levels as in Python.

import { roundHalfEven } from "./signal.js?v=395cf4c2";

export async function readImage(file) {
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf, 0, 4);
  const isTiff = (head[0] === 0x49 && head[1] === 0x49) || (head[0] === 0x4d && head[1] === 0x4d);
  return isTiff ? readTiff(buf) : readBrowser(file);
}

async function readBrowser(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(bmp, 0, 0);
  const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height);
  return { grey: toGrey(data, 4, 255, bmp.width * bmp.height), w: bmp.width, h: bmp.height };
}

function toGrey(data, spp, max, n) {
  const g = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * spp];
    if (spp < 3) { g[i] = r / max; continue; }
    const gr = data[i * spp + 1], b = data[i * spp + 2];
    g[i] = (r === gr && r === b ? r : roundHalfEven(0.299 * r + 0.587 * gr + 0.114 * b)) / max;
  }
  return g;
}

// Baseline TIFF, first image only, uncompressed, chunky (interleaved) samples.
function readTiff(buf) {
  const dv = new DataView(buf);
  const le = dv.getUint8(0) === 0x49;
  const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
  if (u16(2) !== 42) throw new Error("Not a classic TIFF (BigTIFF isn't supported).");
  const ifd = u32(4);
  const tags = {};
  for (let k = 0; k < u16(ifd); k++) {
    const e = ifd + 2 + k * 12;
    const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
    const size = { 1: 1, 3: 2, 4: 4 }[type];
    if (!size) continue;
    const at = count * size <= 4 ? e + 8 : u32(e + 8);
    const read = (i) => (size === 1 ? dv.getUint8(at + i) : size === 2 ? u16(at + i * 2) : u32(at + i * 4));
    tags[tag] = Array.from({ length: count }, (_, i) => read(i));
  }
  const w = tags[256][0], h = tags[257][0];
  const bits = (tags[258] || [1])[0], spp = (tags[277] || [1])[0];
  const compression = (tags[259] || [1])[0], planar = (tags[284] || [1])[0];
  const photometric = (tags[262] || [1])[0];
  if (compression !== 1) throw new Error("Compressed TIFF isn't supported here; convert it with gel_ed.load (Python) or save it as PNG.");
  if (planar !== 1) throw new Error("Planar TIFF isn't supported here; save it as PNG.");
  if (bits !== 8 && bits !== 16) throw new Error(`${bits}-bit TIFF isn't supported here; save it as PNG.`);
  const bps = bits / 8, row = w * spp;
  const samples = bits === 8 ? new Uint8Array(w * h * spp) : new Uint16Array(w * h * spp);
  const offsets = tags[273], counts = tags[279];
  let pos = 0;
  for (let s = 0; s < offsets.length && pos < samples.length; s++) {
    const n = Math.min(counts[s] / bps, samples.length - pos);
    for (let i = 0; i < n; i++) samples[pos + i] = bps === 1 ? dv.getUint8(offsets[s] + i) : u16(offsets[s] + i * 2);
    pos += n;
  }
  if (pos < row * h) throw new Error("TIFF image data is shorter than expected.");
  const grey = toGrey(samples, spp, bits === 8 ? 255 : 65535, w * h);
  if (photometric === 0) for (let i = 0; i < grey.length; i++) grey[i] = 1 - grey[i]; // WhiteIsZero
  return { grey, w, h };
}
