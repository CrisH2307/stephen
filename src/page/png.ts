/**
 * Minimal PNG decode → area-average downscale → encode, in pure Node (zlib only).
 *
 * Screenshots are captured at full size through puppeteer (works identically over CDP and BiDi,
 * which lacks `clip.scale`) and scaled here. Doing it in Node rather than in the page means a
 * hostile page cannot tamper with the image pipeline and a busy page main thread does not block it.
 * Supports 8-bit grayscale / gray+alpha / RGB / RGBA, non-interlaced — what browsers emit.
 */
import { deflateSync, inflateSync } from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface RawImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Uint8Array;
}

/** Width/height from the IHDR chunk (bytes 16–23). */
export function pngSize(png: Uint8Array): { width: number; height: number } {
  const b = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (b.length < 24 || !b.subarray(0, 8).equals(SIG)) throw new Error('Not a PNG');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

export function decodePng(png: Uint8Array): RawImage {
  const b = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (!b.subarray(0, 8).equals(SIG)) throw new Error('Not a PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (off + 8 <= b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString('latin1', off + 4, off + 8);
    const body = b.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8] as number;
      colorType = body[9] as number;
      interlace = body[12] as number;
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (depth !== 8 || !channels || interlace !== 0) {
    throw new Error(`Unsupported PNG (depth ${depth}, colour type ${colorType}, interlace ${interlace})`);
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    const filter = raw[base] as number;
    for (let x = 0; x < stride; x++) {
      const v = raw[base + 1 + x] as number;
      const a = x >= channels ? (cur[x - channels] as number) : 0;
      const up = prev[x] as number;
      const c = x >= channels ? (prev[x - channels] as number) : 0;
      let r: number;
      switch (filter) {
        case 0:
          r = v;
          break;
        case 1:
          r = v + a;
          break;
        case 2:
          r = v + up;
          break;
        case 3:
          r = v + ((a + up) >> 1);
          break;
        case 4: {
          const p = a + up - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - c);
          r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c);
          break;
        }
        default:
          throw new Error(`Bad PNG filter ${filter}`);
      }
      cur[x] = r & 0xff;
    }
    const o = y * width * 4;
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = o + x * 4;
      if (channels === 4) {
        out[d] = cur[s] as number;
        out[d + 1] = cur[s + 1] as number;
        out[d + 2] = cur[s + 2] as number;
        out[d + 3] = cur[s + 3] as number;
      } else if (channels === 3) {
        out[d] = cur[s] as number;
        out[d + 1] = cur[s + 1] as number;
        out[d + 2] = cur[s + 2] as number;
        out[d + 3] = 255;
      } else {
        const g = cur[s] as number;
        out[d] = g;
        out[d + 1] = g;
        out[d + 2] = g;
        out[d + 3] = channels === 2 ? (cur[s + 1] as number) : 255;
      }
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  return { width, height, data: out };
}

/** Per output index: list of [sourceIndex, weight] covering the source span (area average). */
function weights(src: number, dst: number): Array<Array<[number, number]>> {
  const ratio = src / dst;
  const res: Array<Array<[number, number]>> = [];
  for (let i = 0; i < dst; i++) {
    const a = i * ratio;
    const b = Math.min(src, (i + 1) * ratio);
    const w: Array<[number, number]> = [];
    for (let s = Math.floor(a); s < Math.ceil(b); s++) {
      const cov = Math.min(b, s + 1) - Math.max(a, s);
      if (cov > 0) w.push([s, cov / (b - a)]);
    }
    res.push(w);
  }
  return res;
}

/** Area-average downscale (streams rows, O(output width) extra memory per row). */
export function downscale(img: RawImage, width: number, height: number): RawImage {
  const W = Math.max(1, Math.min(img.width, Math.round(width)));
  const H = Math.max(1, Math.min(img.height, Math.round(height)));
  if (W === img.width && H === img.height) return img;
  const wx = weights(img.width, W);
  const wy = weights(img.height, H);
  // Which output rows each source row contributes to.
  const contrib: Array<Array<[number, number]>> = Array.from({ length: img.height }, () => []);
  wy.forEach((list, oy) => {
    for (const [sy, w] of list) (contrib[sy] as Array<[number, number]>).push([oy, w]);
  });
  const acc = new Map<number, Float64Array>();
  const out = new Uint8Array(W * H * 4);
  const rowBuf = new Float64Array(W * 4);
  let nextToEmit = 0;
  for (let sy = 0; sy < img.height; sy++) {
    const targets = contrib[sy] as Array<[number, number]>;
    if (!targets.length) continue;
    rowBuf.fill(0);
    const so = sy * img.width * 4;
    for (let ox = 0; ox < W; ox++) {
      let r = 0;
      let g = 0;
      let bl = 0;
      let al = 0;
      for (const [sx, w] of wx[ox] as Array<[number, number]>) {
        const p = so + sx * 4;
        r += (img.data[p] as number) * w;
        g += (img.data[p + 1] as number) * w;
        bl += (img.data[p + 2] as number) * w;
        al += (img.data[p + 3] as number) * w;
      }
      rowBuf[ox * 4] = r;
      rowBuf[ox * 4 + 1] = g;
      rowBuf[ox * 4 + 2] = bl;
      rowBuf[ox * 4 + 3] = al;
    }
    for (const [oy, w] of targets) {
      let a = acc.get(oy);
      if (!a) {
        a = new Float64Array(W * 4);
        acc.set(oy, a);
      }
      for (let i = 0; i < a.length; i++) (a[i] as number) += (rowBuf[i] as number) * w;
    }
    // Emit output rows whose sources are all consumed.
    while (nextToEmit < H) {
      const list = wy[nextToEmit] as Array<[number, number]>;
      const last = (list[list.length - 1] as [number, number])[0];
      if (last > sy) break;
      const a = acc.get(nextToEmit) ?? new Float64Array(W * 4);
      const o = nextToEmit * W * 4;
      for (let i = 0; i < a.length; i++) out[o + i] = Math.max(0, Math.min(255, Math.round(a[i] as number)));
      acc.delete(nextToEmit);
      nextToEmit++;
    }
  }
  return { width: W, height: H, data: out };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ (buf[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const tb = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(tb));
  return Buffer.concat([len, tb, crc]);
}

/** Encode RGBA as PNG (RGB when fully opaque), 'Up' filter per row. */
export function encodePng(img: RawImage): Buffer {
  let opaque = true;
  for (let i = 3; i < img.data.length; i += 4) {
    if (img.data[i] !== 255) {
      opaque = false;
      break;
    }
  }
  const ch = opaque ? 3 : 4;
  const stride = img.width * ch;
  const raw = Buffer.alloc((stride + 1) * img.height);
  let prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  for (let y = 0; y < img.height; y++) {
    const so = y * img.width * 4;
    for (let x = 0; x < img.width; x++) {
      for (let c = 0; c < ch; c++) cur[x * ch + c] = img.data[so + x * 4 + c] as number;
    }
    const o = y * (stride + 1);
    raw[o] = 2;
    for (let i = 0; i < stride; i++) raw[o + 1 + i] = ((cur[i] as number) - (prev[i] as number)) & 0xff;
    prev = Uint8Array.from(cur);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = opaque ? 2 : 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Longest side of any screenshot we return (the image API rejects larger images). */
export const MAX_OUTPUT_DIM = 8000;
/** Most pixels we capture / decode for one screenshot: bounds the synchronous PNG work (finding #14). */
export const MAX_CAPTURE_PIXELS = 25_000_000;

export interface CapturePlan {
  /** CSS px to capture (height possibly clipped). */
  width: number;
  height: number;
  /** Scale to apply to the captured image (≤ the requested one). */
  scale: number;
  /** True when the height was cut to stay within the limits. */
  clipped: boolean;
}

/**
 * Fit a capture of w×h CSS px at device-pixel-ratio dpr and requested scale within the limits:
 * the scale is reduced so the output width ≤ maxDim, then the captured height is clipped so the
 * output height ≤ maxDim and the captured pixels ≤ maxPixels.
 */
export function planCapture(
  w: number,
  h: number,
  dpr: number,
  scale: number,
  maxDim = MAX_OUTPUT_DIM,
  maxPixels = MAX_CAPTURE_PIXELS,
): CapturePlan {
  const r = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const width = Math.max(1, Math.ceil(w));
  let height = Math.max(1, Math.ceil(h));
  const capW = width * r;
  let s = Math.min(1, scale);
  if (capW * s > maxDim) s = maxDim / capW;
  const maxCapH = Math.min(maxDim / s, maxPixels / capW);
  let clipped = false;
  if (height * r > maxCapH) {
    height = Math.max(1, Math.floor(maxCapH / r));
    clipped = true;
  }
  return { width, height, scale: s, clipped };
}

/**
 * Scale a PNG by `scale` (0 < scale ≤ 1), further reduced so neither side exceeds maxDim.
 * Returns the input untouched when no scaling is needed. Refuses images over maxPixels.
 */
export function scalePng(png: Uint8Array, scale: number, maxDim = MAX_OUTPUT_DIM, maxPixels = MAX_CAPTURE_PIXELS * 1.5): Buffer {
  const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  const { width, height } = pngSize(buf);
  const s = Math.min(scale, maxDim / width, maxDim / height);
  if (!(s < 0.999)) return buf;
  if (width * height > maxPixels) throw new Error(`Screenshot too large to process (${width}×${height})`);
  const img = decodePng(buf);
  return encodePng(downscale(img, Math.min(maxDim, img.width * s), Math.min(maxDim, img.height * s)));
}
