/**
 * Every theme's colours are readable (#184, UI v4 section 5.4). Reads the hex values from helper/Theme.swift and
 * checks WCAG 2.x contrast ratios, so a later colour edit cannot quietly make text hard to see.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { helperSourceDir } from '../../src/helper/install.js';

const THEMES = ['light', 'dark', 'navy', 'rose', 'sun'];
const TOKENS = ['ground', 'surface', 'surface2', 'lineStrong', 'ink', 'ink2', 'primary', 'primaryText', 'accent', 'ok', 'warn', 'bad'];

// [text, background, minimum ratio]
const PAIRS: [string, string, number][] = [
  ['ink', 'ground', 4.5], ['ink', 'surface', 4.5], ['ink', 'surface2', 4.5],
  ['ink2', 'ground', 4.5], ['ink2', 'surface', 4.5], ['ink2', 'surface2', 4.5],
  ['accent', 'surface', 4.5], ['accent', 'surface2', 4.5],
  ['primaryText', 'primary', 4.5],
  ['lineStrong', 'ground', 3], ['lineStrong', 'surface', 3],
  ['ok', 'surface', 4.5], ['ok', 'surface2', 4.5],
  ['warn', 'surface', 4.5], ['warn', 'surface2', 4.5],
  ['bad', 'surface', 4.5], ['bad', 'surface2', 4.5],
  // The switch knob is `surface` on the accent track (Components/Controls.swift, StephenSwitch).
  ['surface', 'accent', 3],
];

const SWIFT = readFileSync(join(helperSourceDir(), 'Theme.swift'), 'utf8');
// Only Theme.of: stop before the scale section so later code is never parsed as a theme.
const OF_BODY = SWIFT.slice(SWIFT.indexOf('static func of('), SWIFT.indexOf('// MARK: scale'));
const NAMED = new Map(
  [...SWIFT.matchAll(/(\w+) = Color\(hex: 0x([0-9A-Fa-f]{6})\)/g)].map((m): [string, number] => [m[1] ?? '', parseInt(m[2] ?? '0', 16)]),
);
const BLOCKS = new Map(
  [...OF_BODY.matchAll(/case \.(\w+):([\s\S]*?)(?=case \.|$)/g)].map((m): [string, string] => [m[1] ?? '', m[2] ?? '']),
);

/** Hex value (0xRRGGBB) of a token in a theme, or undefined if it is not in Theme.swift. */
function hexOf(theme: string, token: string): number | undefined {
  const block = BLOCKS.get(theme) ?? '';
  const m = block.match(new RegExp(`\\b${token}: (?:Color\\(hex: 0x([0-9A-Fa-f]{6})\\)|(\\w+))`));
  if (!m) return undefined;
  return m[1] ? parseInt(m[1], 16) : NAMED.get(m[2] ?? '');
}

function luminance(hex: number): number {
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const r = lin(((hex >> 16) & 0xff) / 255);
  const g = lin(((hex >> 8) & 0xff) / 255);
  const b = lin((hex & 0xff) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 to 21. */
function ratio(a: number, b: number): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe('theme colours are readable (#184)', () => {
  it('parse guard: every theme and token is found in Theme.swift', () => {
    expect([...BLOCKS.keys()].sort()).toEqual([...THEMES].sort());
    for (const theme of THEMES) {
      for (const token of TOKENS) expect(hexOf(theme, token), `${theme} ${token}`).toBeTypeOf('number');
    }
  });

  it('contrast maths: black on white is 21:1', () => {
    expect(ratio(0x000000, 0xffffff)).toBeCloseTo(21, 5);
  });

  it.each(THEMES)('%s: every text pair reaches its minimum ratio', (theme) => {
    const failures: string[] = [];
    for (const [fg, bg, min] of PAIRS) {
      const r = ratio(hexOf(theme, fg) ?? NaN, hexOf(theme, bg) ?? NaN);
      if (!(r >= min)) failures.push(`${fg} on ${bg}: ${r.toFixed(2)}:1 (needs ${min}:1)`);
    }
    expect(failures, `${theme} theme`).toEqual([]);
  });
});
