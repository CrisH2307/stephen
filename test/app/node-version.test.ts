/** `stephen doctor`'s Node check (#249): the same range as package.json engines. Node 21 fails clearly. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NODE_RANGE, nodeSupported } from '../../src/cli.js';

describe('nodeSupported', () => {
  it.each(['20.19.0', 'v20.20.1', '22.12.0', '22.20.1', '23.9.0', '24.20.0', '26.0.0'])('%s is supported', (v) => expect(nodeSupported(v)).toBe(true));
  it.each(['18.20.0', '20.18.3', '21.0.0', '21.5.0', '21.7.3', '22.11.0', '19.9.0'])('%s is not', (v) => expect(nodeSupported(v)).toBe(false));
  it('matches package.json engines', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { engines: { node: string } };
    expect(pkg.engines.node).toBe(NODE_RANGE);
  });
});
