/**
 * Static import scan of src/ for boundary tests (test/memory/boundary.test.ts). Reads the TypeScript sources as
 * text: `import … from`, `export … from`, `import '…'` and `import('…')`. Type-only imports are kept apart, since
 * they vanish at runtime and give no code path.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..', '..');
export const SRC_ROOT = join(REPO_ROOT, 'src');

export interface ImportRef {
  /** Repo-relative path of the importing file, with "/" separators ("src/server/tools.ts"). */
  from: string;
  /** The specifier as written ("../memory/store.js"). */
  spec: string;
  /** Repo-relative resolved file for relative specifiers, else null (packages, node: builtins). */
  resolved: string | null;
  typeOnly: boolean;
  /** `import('…')`: only loaded when that code path runs. */
  dynamic?: boolean;
}

const rel = (abs: string) => relative(REPO_ROOT, abs).split(sep).join('/');

/** Every .ts file under `dir` (absolute paths). */
export function listTsFiles(dir = SRC_ROOT): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listTsFiles(p));
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function resolveSpec(fromAbs: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromAbs), spec);
  const candidates = [base.replace(/\.js$/, '.ts'), base, `${base}.ts`, join(base, 'index.ts')];
  for (const c of candidates) if (existsSync(c) && statSync(c).isFile()) return rel(c);
  return rel(base.replace(/\.js$/, '.ts'));
}

const STATIC_RE = /(?:^|[\n;])\s*(import|export)\s+(type\s+)?([^;'"`]*?)\s*from\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_RE = /(?:^|[\n;])\s*import\s*['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

/** All imports of one file. */
export function importsOf(fileAbs: string): ImportRef[] {
  const src = readFileSync(fileAbs, 'utf8');
  const from = rel(fileAbs);
  const out: ImportRef[] = [];
  for (const m of src.matchAll(STATIC_RE)) {
    const clause = m[3] ?? '';
    // `import { type A, type B } from` is type-only too.
    const named = /^\{([\s\S]*)\}$/.exec(clause.trim());
    const allTypeNamed = !!named && named[1]!.split(',').map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith('type '));
    out.push({ from, spec: m[4]!, resolved: resolveSpec(fileAbs, m[4]!), typeOnly: !!m[2] || allTypeNamed });
  }
  for (const m of src.matchAll(SIDE_EFFECT_RE)) out.push({ from, spec: m[1]!, resolved: resolveSpec(fileAbs, m[1]!), typeOnly: false });
  for (const m of src.matchAll(DYNAMIC_RE)) out.push({ from, spec: m[1]!, resolved: resolveSpec(fileAbs, m[1]!), typeOnly: false, dynamic: true });
  return out;
}

/** Every import in src/. */
export function scanSrc(): ImportRef[] {
  return listTsFiles().flatMap(importsOf);
}

/** A forbidden-importer rule: files matching any `importers` prefix must not reach anything under `target`. */
export interface Boundary {
  /** Repo-relative folder ("src/memory/") or file the importers must not reach. */
  target: string;
  /** Repo-relative folder prefixes ("src/server/") or exact files ("src/eval/dry-server.ts"). */
  importers: readonly string[];
}

/** Code Claude's tools run in: it must never reach the memory store (or, later, the app socket). */
export const CLAUDE_REACHABLE: readonly string[] = ['src/server/', 'src/safety/', 'src/desktop/', 'src/drivers/', 'src/page/', 'src/eval/dry-server.ts'];

const under = (path: string, prefix: string) => (prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix);

/** Direct imports (type-only included: even a type import is a sign of coupling) that break the boundary. */
export function directViolations(b: Boundary, refs: readonly ImportRef[] = scanSrc()): ImportRef[] {
  return refs.filter((r) => r.resolved && under(r.resolved, b.target) && b.importers.some((p) => under(r.from, p)));
}

/**
 * Runtime (value) import chains from an importer file to the target: ["src/server/tools.ts", "src/voice/x.ts",
 * "src/memory/store.ts"]. Type-only imports are skipped (they emit no code).
 */
export function transitiveViolations(b: Boundary, refs: readonly ImportRef[] = scanSrc()): string[][] {
  const graph = new Map<string, string[]>();
  for (const r of refs) {
    if (!r.resolved || r.typeOnly) continue;
    const list = graph.get(r.from) ?? [];
    list.push(r.resolved);
    graph.set(r.from, list);
  }
  const files = listTsFiles().map(rel).filter((f) => b.importers.some((p) => under(f, p)));
  const chains: string[][] = [];
  for (const start of files) {
    const prev = new Map<string, string | null>([[start, null]]);
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift()!;
      if (under(cur, b.target)) {
        const chain: string[] = [];
        for (let c: string | null = cur; c; c = prev.get(c) ?? null) chain.unshift(c);
        chains.push(chain);
        break;
      }
      for (const next of graph.get(cur) ?? []) {
        if (prev.has(next)) continue;
        prev.set(next, cur);
        queue.push(next);
      }
    }
  }
  return chains;
}

/**
 * Every file loaded at start-up from `start` (static value imports only; dynamic `import()` and type-only imports
 * are skipped): what a process like `stephen serve` has in memory before any command-specific code runs.
 */
export function staticReach(start: string, refs: readonly ImportRef[] = scanSrc()): Set<string> {
  const graph = new Map<string, string[]>();
  for (const r of refs) {
    if (!r.resolved || r.typeOnly || r.dynamic) continue;
    const list = graph.get(r.from) ?? [];
    list.push(r.resolved);
    graph.set(r.from, list);
  }
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length) {
    for (const next of graph.get(queue.shift()!) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}
