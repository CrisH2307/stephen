import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePng, downscale, encodePng, pngSize, scalePng, type RawImage } from '../../src/page/png.js';

function solid(w: number, h: number, rgba: [number, number, number, number]): RawImage {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
  return { width: w, height: h, data };
}

describe('png', () => {
  it('round-trips RGBA and RGB images', () => {
    const img = solid(7, 5, [10, 20, 30, 255]);
    img.data.set([200, 100, 50, 128], 4 * 12); // one translucent pixel → RGBA encoding
    const back = decodePng(encodePng(img));
    expect(back.width).toBe(7);
    expect(back.height).toBe(5);
    expect(Array.from(back.data)).toEqual(Array.from(img.data));
    const opaque = solid(3, 3, [1, 2, 3, 255]);
    const enc = encodePng(opaque);
    expect(enc[25]).toBe(2); // colour type RGB
    expect(Array.from(decodePng(enc).data)).toEqual(Array.from(opaque.data));
  });

  it('decodes every filter type', () => {
    // 2x2 RGB, rows with filters 1 (Sub) and 4 (Paeth) and 3 (Average) on a third row.
    const rows = [
      [1, 10, 20, 30, 5, 5, 5], // Sub: px2 = px1 + 5
      [4, 1, 1, 1, 0, 0, 0], // Paeth
      [3, 0, 0, 0, 0, 0, 0], // Average
    ];
    const raw = Buffer.from(rows.flat());
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(2, 0);
    ihdr.writeUInt32BE(3, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    const img = decodePng(png);
    const px = (x: number, y: number): number[] => Array.from(img.data.slice((y * 2 + x) * 4, (y * 2 + x) * 4 + 3));
    expect(px(0, 0)).toEqual([10, 20, 30]);
    expect(px(1, 0)).toEqual([15, 25, 35]);
    expect(px(0, 1)).toEqual([11, 21, 31]); // Paeth: left=0, up=10 → up
    expect(px(1, 1)).toEqual([15, 25, 35]); // Paeth: p=11+15-10=16 → nearest is up (15)
    expect(px(0, 2)).toEqual([5, 10, 15]); // Average: (0 + 11) >> 1
  });

  it('downscales by area average', () => {
    const img = solid(4, 2, [0, 0, 0, 255]);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) img.data.set([255, 255, 255, 255], (y * 4 + x) * 4);
    const half = downscale(img, 2, 1);
    expect(half.width).toBe(2);
    expect(half.height).toBe(1);
    expect(Array.from(half.data)).toEqual([255, 255, 255, 255, 0, 0, 0, 255]);
    const odd = downscale(solid(5, 5, [100, 100, 100, 255]), 2, 2);
    expect(Array.from(odd.data.slice(0, 4))).toEqual([100, 100, 100, 255]);
  });

  it('scalePng reports scaled IHDR dimensions and passes through scale 1', () => {
    const png = encodePng(solid(1280, 90, [9, 9, 9, 255]));
    expect(pngSize(scalePng(png, 0.5))).toEqual({ width: 640, height: 45 });
    expect(pngSize(scalePng(png, 0.1))).toEqual({ width: 128, height: 9 });
    expect(scalePng(png, 1)).toEqual(png);
    expect(() => pngSize(Buffer.from('nope'))).toThrow();
  });
});

function chunk(type: string, body: Buffer): Buffer {
  // CRC is not checked by the decoder; zero is fine for this test.
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), body, Buffer.alloc(4)]);
}
