// UI v4 glass check (docs/research/UI-V4-IA-PLAN.md section 8). Run: node scripts/glass-contrast.mjs
// Each glass surface is a theme tint at alpha A over whatever is behind the window. Worst case: pure black or pure
// white behind it (the real material blur only lowers the backdrop's contrast). Text on it must stay >= 4.5:1.
// Tint colours are the mock's tokens; alphas are the plan's. Exit code 1 if any pair fails.
const T = {
  light: { dark: false, sidebar: 'ECEEF1', ground: 'F5F6F8', surface: 'FFFFFF', ink: '0E1525', ink2: '556070', accent: '2456C9', warn: '8A5A00' },
  dark: { dark: true, sidebar: '1B1E25', ground: '12151B', surface: '171A21', ink: 'EEF0F4', ink2: 'A3AAB7', accent: '7FA6FF', warn: 'E0B04A' },
  navy: { dark: true, sidebar: '16264A', ground: '0F1B33', surface: '16264A', ink: 'EEF2FA', ink2: 'A9B6CF', accent: '8FB0FF', warn: 'E0B04A' },
  rose: { dark: false, sidebar: 'FBEFF2', ground: 'FFF5F7', surface: 'FFFFFF', ink: '2A1219', ink2: '7A5560', accent: 'B4235A', warn: '8A5A00' },
  sun: { dark: false, sidebar: 'FBF5DC', ground: 'FFFBEA', surface: 'FFFFFF', ink: '221C08', ink2: '6B5F35', accent: '7A5E00', warn: '8A5A00' },
};
// Surface -> [alpha in light themes, alpha in dark themes]. The palette uses `surface` as its tint.
export const ALPHA = { sidebar: [0.95, 0.88], toolbar: [0.92, 0.85], palette: [0.90, 0.88] };
const TINT = { sidebar: 'sidebar', toolbar: 'ground', palette: 'surface' };

const rgb = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const over = (tint, a, bg) => tint.map((v, i) => v * a + bg[i] * (1 - a));

let failed = 0;
for (const [name, t] of Object.entries(T)) {
  for (const surf of Object.keys(ALPHA)) {
    const a = ALPHA[surf][t.dark ? 1 : 0];
    const cells = ['ink', 'ink2', 'accent', 'warn'].map((k) => {
      const r = Math.min(...[[0, 0, 0], [255, 255, 255]].map((bg) => ratio(rgb(t[k]), over(rgb(t[TINT[surf]]), a, bg))));
      if (r < 4.5) failed++;
      return `${k} ${r.toFixed(1)}${r < 4.5 ? ' FAIL' : ''}`;
    });
    console.log(`${name.padEnd(5)} ${surf.padEnd(7)} a=${a.toFixed(2)}  ${cells.join('  ')}`);
  }
}
if (failed) { console.error(`${failed} pair(s) under 4.5:1`); process.exit(1); }
console.log('All text pairs >= 4.5:1 on every glass surface, worst case.');
