import fs from 'node:fs';
import path from 'node:path';
import { SESSIONS_DIR, PROJECTS_DIR } from './paths.js';

/**
 * Claude Code keeps one JSON file per live session in ~/.claude/sessions, named
 * <pid>.json, holding sessionId, cwd, entrypoint, kind, status and name. That is
 * the only accurate answer to "which chats are open right now".
 *
 * Transcript mtime is NOT an answer. Claude Code rewrites transcripts in bulk
 * background passes, so a dozen files can share a modification time to the
 * second while only two or three sessions are actually running.
 *
 * This directory is undocumented internals, so everything here is defensive and
 * falls back to the old mtime scan when the shape is not what we expect.
 */

// Shape confirmed against Claude Code 2.1.270.
export const VERIFIED_AGAINST = '2.1.270';

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else. Still alive.
    return err && err.code === 'EPERM';
  }
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function toSession(raw, file) {
  if (!raw || typeof raw !== 'object') return null;
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : '';
  const cwd = typeof raw.cwd === 'string' ? raw.cwd.trim() : '';
  // A session id is a uuid. Anything shorter means the format moved on.
  if (sessionId.length < 8 || !cwd) return null;
  return {
    sessionId,
    cwd,
    pid: Number.isInteger(raw.pid) ? raw.pid : null,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : '',
    status: typeof raw.status === 'string' ? raw.status : 'unknown',
    kind: typeof raw.kind === 'string' ? raw.kind : '',
    entrypoint: typeof raw.entrypoint === 'string' ? raw.entrypoint : '',
    version: typeof raw.version === 'string' ? raw.version : '',
    startedAt: raw.startedAt ?? null,
    source: 'registry',
    file,
  };
}

/**
 * Read every live interactive CLI session.
 *
 * Filtering on entrypoint/kind is what keeps programmatic sessions out. An app
 * driving Claude through the SDK writes transcripts into the same projects tree,
 * and the old mtime scan happily offered to reopen those as if they were chats.
 */
export function readRegistry({ includeNonInteractive = false } = {}) {
  if (!fs.existsSync(SESSIONS_DIR)) {
    return { ok: false, reason: 'no-registry', sessions: [], skipped: 0 };
  }

  let entries;
  try {
    entries = fs.readdirSync(SESSIONS_DIR);
  } catch (err) {
    return { ok: false, reason: `unreadable: ${err.code || err.message}`, sessions: [], skipped: 0 };
  }

  // Only .json. Sibling .key files hold session secrets and are none of our business.
  const files = entries.filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    return { ok: true, reason: 'empty', sessions: [], skipped: 0 };
  }

  const sessions = [];
  let malformed = 0;
  let skipped = 0;

  for (const file of files) {
    const full = path.join(SESSIONS_DIR, file);
    const session = toSession(readJsonFile(full), full);
    if (!session) {
      malformed++;
      continue;
    }
    if (!includeNonInteractive && (session.kind !== 'interactive' || session.entrypoint !== 'cli')) {
      skipped++;
      continue;
    }
    // A crashed session leaves its file behind. Trust the OS, not the file.
    if (session.pid !== null && !isPidAlive(session.pid)) {
      skipped++;
      continue;
    }
    sessions.push(session);
  }

  // Every file present but none parsed into a session we recognise: the format moved.
  if (sessions.length === 0 && malformed === files.length) {
    return { ok: false, reason: 'unrecognised-format', sessions: [], skipped };
  }

  sessions.sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
  return { ok: true, reason: 'registry', sessions, skipped };
}

// ---------------------------------------------------------------------------
// Legacy fallback: the pre-2.0 behaviour, for Claude Code versions with no
// sessions registry. Less accurate by construction, so callers should say so.
// ---------------------------------------------------------------------------

const MACHINE_PREFIXES = [
  '<local-command', '<command-name', '<command-message', '<command-args',
  '<user-memory', '<system-reminder', '<task-notification', '<user-prompt',
  '<bash-', '<function_results', '<result', 'Caveat:',
];

function humanTextFrom(record) {
  if (!record || record.type !== 'user' || record.isMeta) return null;
  let content = record.message && record.message.content;
  if (Array.isArray(content)) {
    content = content
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text)
      .join(' ');
  }
  if (typeof content !== 'string') return null;
  const text = content.trim();
  if (!text) return null;
  if (MACHINE_PREFIXES.some((p) => text.startsWith(p))) return null;
  return text.replace(/\s+/g, ' ');
}

export function scanTranscripts({ withinMinutes = 45 } = {}) {
  if (!fs.existsSync(PROJECTS_DIR)) return { ok: false, reason: 'no-projects', sessions: [] };
  const cutoff = Date.now() - withinMinutes * 60 * 1000;
  const sessions = [];

  let projectDirs;
  try {
    projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return { ok: false, reason: 'no-projects', sessions: [] };
  }

  for (const dir of projectDirs) {
    const dirPath = path.join(PROJECTS_DIR, dir.name);
    let files;
    try {
      // Top level only. Nested subagents/ transcripts are not chats.
      files = fs.readdirSync(dirPath, { withFileTypes: true })
        .filter((f) => f.isFile() && f.name.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const full = path.join(dirPath, file.name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.mtimeMs < cutoff) continue;

      const sessionId = path.basename(file.name, '.jsonl');
      if (sessionId.length < 8) continue;

      let cwd = '';
      let name = '';
      let humans = 0;
      let sidechain = false;
      let raw;
      try {
        raw = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      for (const line of raw.split('\n')) {
        if (line.length < 2) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (record.isSidechain) sidechain = true;
        if (!cwd && typeof record.cwd === 'string') cwd = record.cwd;
        const text = humanTextFrom(record);
        if (text) {
          humans++;
          name = text;
        }
      }

      if (sidechain || humans === 0 || !cwd) continue;
      if (!fs.existsSync(cwd)) continue;

      sessions.push({
        sessionId,
        cwd,
        pid: null,
        name,
        status: 'unknown',
        kind: '',
        entrypoint: '',
        version: '',
        startedAt: new Date(stat.mtimeMs).toISOString(),
        source: 'transcript-scan',
        file: full,
      });
    }
  }

  sessions.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return { ok: true, reason: 'transcript-scan', sessions };
}

/** Registry first, mtime scan only when the registry is unavailable. */
export function getLiveSessions(opts = {}) {
  const registry = readRegistry(opts);
  if (registry.ok && registry.sessions.length > 0) return registry;
  if (registry.ok && registry.reason === 'empty') return registry;
  const fallback = scanTranscripts(opts);
  return { ...fallback, degradedFrom: registry.reason };
}
