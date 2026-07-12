// Pure helper: extract a single version's release notes from a Keep-a-Changelog
// file. Reused by scripts/release.mjs and .github/workflows/release.yml so the
// GitHub Release body always matches the committed CHANGELOG.

const HEADER_RE = /^##\s*\[([^\]]+)\]\s*[—–-]\s*(.+?)\s*$/;

/**
 * @param {string} changelogText  Full CHANGELOG.md contents.
 * @param {string} version        Version to extract (with or without leading "v").
 * @returns {{ version: string, date: string, notes: string }}
 * @throws if the version has no section.
 */
export function extractReleaseNotes(changelogText, version) {
  const target = String(version).replace(/^v/i, '').trim();
  const lines = String(changelogText).split(/\r?\n/);

  let start = -1;
  let date = '';
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADER_RE);
    if (m && m[1].trim() === target) {
      start = i;
      date = m[2].trim();
      break;
    }
  }
  if (start === -1) {
    throw new Error(`CHANGELOG: versão ${version} não encontrada`);
  }

  const body = [];
  for (let j = start + 1; j < lines.length; j++) {
    if (HEADER_RE.test(lines[j])) break;
    body.push(lines[j]);
  }

  return { version: target, date, notes: body.join('\n').trim() };
}
