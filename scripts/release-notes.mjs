// F14: the release notes for one version, as plain text for friends, from CHANGELOG.md.
//   node scripts/release-notes.mjs <version> [path/to/CHANGELOG.md]
// The changelog format (see CHANGELOG.md): "## <version> (<date>)", then "### Added", "### Changed" or "### Fixed",
// then "- " bullets. The output drops Markdown (links keep their words, no backticks or bold), so it reads the same
// in an update window, a DMG note or a chat message. The appcast part waits for F6 and F7.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HEADINGS = { added: 'New', changed: 'Changed', fixed: 'Fixed', removed: 'Removed', security: 'Safety' };

/** Markdown inline marks → plain words. Pure. */
export function plain(text) {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links keep their words
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
    .replace(/(^|[^\w*])\*([^*\s](?:[^*]*[^*\s])?)\*(?![\w*])/g, '$1$2') // *italics*
    .replace(/(^|[^\w])_([^_\s](?:[^_]*[^_\s])?)_(?!\w)/g, '$1$2') // _italics_, never snake_case
    .replace(/\s+/g, ' ')
    .trim();
}

/** The plain notes for `version`, or null when the changelog has no such section. Pure. */
export function releaseNotes(changelog, version) {
  const lines = changelog.split('\n');
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = lines.findIndex((l) => new RegExp(`^## \\[?${esc}\\]?(\\s|$)`).test(l));
  if (start < 0) return null;
  const date = /\((\d{4}-\d{2}-\d{2})\)/.exec(lines[start])?.[1];
  const head = `Stephen ${version}${date ? ` (${date})` : ''}`;
  // Sections in order; a heading with no bullets is left out, so no label stands alone.
  const sections = [{ label: null, bullets: [] }];
  let bullet = null;
  const flush = () => {
    if (bullet !== null) sections.at(-1).bullets.push(`- ${plain(bullet)}`);
    bullet = null;
  };
  for (const l of lines.slice(start + 1)) {
    if (/^## /.test(l)) break;
    const h = /^### +(.+)$/.exec(l);
    if (h) {
      flush();
      const key = h[1].trim().toLowerCase();
      sections.push({ label: `${HEADINGS[key] ?? plain(h[1])}:`, bullets: [] });
    } else if (/^\s*[-*] +/.test(l)) {
      flush();
      bullet = l.replace(/^\s*[-*] +/, '');
    } else if (bullet !== null && l.trim()) bullet += ` ${l.trim()}`; // a wrapped bullet
  }
  flush();
  const out = [head];
  for (const sec of sections.filter((x) => x.bullets.length)) out.push(...(sec.label ? ['', sec.label] : []), ...sec.bullets);
  return out.length > 1 ? out.join('\n') : null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [version, file = 'CHANGELOG.md'] = process.argv.slice(2);
  if (!version) {
    console.error('Usage: node scripts/release-notes.mjs <version> [CHANGELOG.md]');
    process.exit(2);
  }
  const notes = releaseNotes(readFileSync(file, 'utf8'), version);
  if (!notes) {
    console.error(`${file} has no notes for ${version}. Add a "## ${version} (YYYY-MM-DD)" section with bullets.`);
    process.exit(1);
  }
  console.log(notes);
}
