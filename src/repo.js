import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Walk up to the nearest directory holding a .git entry. .git is a file rather
 * than a directory inside a worktree, so test existence, not directory-ness.
 * Falls back to the starting directory when the chat was not inside a repo.
 */
export function findRepoRoot(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir);
    dir = parent;
  }
}

const SEPARATORS = new Set(['/', String.fromCharCode(92)]);

/** path.resolve already normalises separators, so only a trailing one can remain. */
function normalisePath(p) {
  let out = path.resolve(p);
  while (out.length > 1 && SEPARATORS.has(out[out.length - 1])) out = out.slice(0, -1);
  return out;
}

/** Stable filename for a repo's snapshot: readable prefix plus a hash to avoid collisions. */
export function repoKey(repoRoot) {
  const norm = normalisePath(repoRoot);
  const cmp = process.platform === 'win32' ? norm.toLowerCase() : norm;
  const hash = crypto.createHash('sha256').update(cmp).digest('hex').slice(0, 10);
  const base = path.basename(norm).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 40) || 'repo';
  return `${base}-${hash}`;
}

export function samePath(a, b) {
  if (!a || !b) return false;
  return process.platform === 'win32'
    ? normalisePath(a).toLowerCase() === normalisePath(b).toLowerCase()
    : normalisePath(a) === normalisePath(b);
}
