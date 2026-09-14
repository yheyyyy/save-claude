import fs from 'node:fs';
import path from 'node:path';
import { SNAPSHOT_DIR } from './paths.js';
import { repoKey } from './repo.js';

export const DEFAULT_TTL_HOURS = 16;

/**
 * Snapshots live in ~/.claude/save-claude/snapshots, not in the repo, so running
 * this repeatedly never churns a tracked file.
 *
 * Writes MERGE rather than replace. When you close VSCode every session fires its
 * own SessionEnd, and by the time the last one runs the earlier ones are already
 * gone from the registry. A replacing write would keep only the straggler. The
 * TTL is what stops yesterday's chats accumulating forever.
 */

function snapshotPath(repoRoot) {
  return path.join(SNAPSHOT_DIR, `${repoKey(repoRoot)}.json`);
}

export function loadSnapshot(repoRoot) {
  const file = snapshotPath(repoRoot);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.sessions)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSnapshot(repoRoot, sessions, { ttlHours = DEFAULT_TTL_HOURS, merge = true } = {}) {
  const now = Date.now();
  const cutoff = now - ttlHours * 3600 * 1000;
  const byId = new Map();

  if (merge) {
    const previous = loadSnapshot(repoRoot);
    for (const entry of previous?.sessions ?? []) {
      if (!entry || typeof entry.sessionId !== 'string') continue;
      const seen = Date.parse(entry.lastSeen ?? '');
      if (Number.isFinite(seen) && seen < cutoff) continue;
      byId.set(entry.sessionId, entry);
    }
  }

  for (const s of sessions) {
    byId.set(s.sessionId, {
      sessionId: s.sessionId,
      name: s.name || '',
      cwd: s.cwd,
      startedAt: s.startedAt ?? null,
      lastSeen: new Date(now).toISOString(),
    });
  }

  const merged = [...byId.values()].sort((a, b) =>
    String(b.lastSeen).localeCompare(String(a.lastSeen)));

  const payload = {
    repo: path.resolve(repoRoot),
    savedAt: new Date(now).toISOString(),
    tool: 'save-claude',
    sessions: merged,
  };

  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  fs.writeFileSync(snapshotPath(repoRoot), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

export function clearSnapshot(repoRoot) {
  try {
    fs.unlinkSync(snapshotPath(repoRoot));
    return true;
  } catch {
    return false;
  }
}

/** Age in ms of the newest snapshot anywhere, for the statusline freshness badge. */
export function newestSnapshotAge(now = Date.now()) {
  let newest = null;
  let files;
  try {
    files = fs.readdirSync(SNAPSHOT_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  for (const file of files) {
    try {
      const stat = fs.statSync(path.join(SNAPSHOT_DIR, file));
      if (newest === null || stat.mtimeMs > newest) newest = stat.mtimeMs;
    } catch {
      // ignore
    }
  }
  return newest === null ? null : now - newest;
}

/** Age in ms of one repo's snapshot, or null when it has never been saved. */
export function snapshotAge(repoRoot, now = Date.now()) {
  try {
    return now - fs.statSync(snapshotPath(repoRoot)).mtimeMs;
  } catch {
    return null;
  }
}
