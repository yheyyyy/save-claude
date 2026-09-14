import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseJsonc, hasComments } from './jsonc.js';

export const MARKER = 'save-claude-managed';
const BACKUP_SUFFIX = '.save-claude-backup';

/**
 * VSCode runs folderOpen tasks only for the folder you actually open, and a task
 * is one terminal. So restoring N chats genuinely needs N tasks: there is no CLI
 * to spawn a terminal, and a single task cannot fan out.
 *
 * What changed from v1 is everything around that. We merge into an existing
 * tasks.json instead of backing it up and giving up, we back up at most once
 * instead of once per run, and labels come from the session name so they are
 * actually distinguishable.
 */

function shortId(sessionId) {
  return sessionId.slice(0, 8);
}

function cleanLabel(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    // Apps prepend directive blocks like [CURRENT_TURN_RESPONSE_LANGUAGE] ... [/...].
    // Left in, every label starts with the same 200 characters and truncates identically.
    .replace(/^\s*\[[A-Z0-9_]+\][\s\S]*?\[\/[A-Z0-9_]+\]\s*/g, '')
    .replace(/^\s*<[^>]{1,60}>\s*/, '')
    .trim();
}

function labelFor(session, taken) {
  const base = cleanLabel(session.name) || 'chat';
  const truncated = base.length > 56 ? `${base.slice(0, 55)}…` : base;
  let label = `claude: ${truncated}`;
  // VSCode requires unique task labels. Only disambiguate when we must.
  if (taken.has(label)) label = `claude: ${truncated} (${shortId(session.sessionId)})`;
  let n = 2;
  while (taken.has(label)) {
    label = `claude: ${truncated} (${shortId(session.sessionId)}-${n})`;
    n++;
  }
  taken.add(label);
  return label;
}

export function buildTask(session, taken) {
  return {
    label: labelFor(session, taken),
    detail: MARKER,
    type: 'shell',
    command: 'claude',
    args: ['--resume', session.sessionId],
    isBackground: true,
    problemMatcher: [],
    runOptions: { runOn: 'folderOpen' },
    presentation: { panel: 'dedicated', reveal: 'always', focus: false, group: 'save-claude' },
  };
}

function isOurs(task) {
  return task && typeof task === 'object' && task.detail === MARKER;
}

function backupOnce(tasksPath) {
  const backup = tasksPath + BACKUP_SUFFIX;
  // Fixed name, and only written when absent. v1 used a timestamp, so every run
  // left another identical copy behind.
  if (fs.existsSync(backup)) return null;
  fs.copyFileSync(tasksPath, backup);
  return backup;
}

/**
 * Rewrite only the tasks this tool owns, leaving the user's own build and test
 * tasks untouched.
 */
export function writeTasks(repoRoot, sessions, { dryRun = false } = {}) {
  const vsDir = path.join(repoRoot, '.vscode');
  const tasksPath = path.join(vsDir, 'tasks.json');
  const warnings = [];
  let doc = { version: '2.0.0', tasks: [] };
  let existingOther = [];

  if (fs.existsSync(tasksPath)) {
    let raw;
    try {
      raw = fs.readFileSync(tasksPath, 'utf8');
    } catch (err) {
      return { ok: false, tasksPath, error: `cannot read: ${err.message}`, warnings };
    }

    let parsed;
    try {
      parsed = parseJsonc(raw);
    } catch (err) {
      const backup = dryRun ? null : backupOnce(tasksPath);
      return {
        ok: false,
        tasksPath,
        error: `existing tasks.json is not valid JSON (${err.message}); left untouched`,
        backup,
        warnings,
      };
    }

    if (parsed && typeof parsed === 'object') {
      doc = parsed;
      if (!Array.isArray(doc.tasks)) doc.tasks = [];
      existingOther = doc.tasks.filter((t) => !isOurs(t));
    }

    if (hasComments(raw)) {
      if (!dryRun) backupOnce(tasksPath);
      warnings.push(`comments in tasks.json are dropped on rewrite; original copied to ${path.basename(tasksPath) + BACKUP_SUFFIX}`);
    }
  }

  const taken = new Set(existingOther.map((t) => t && t.label).filter(Boolean));
  const ours = sessions.map((s) => buildTask(s, taken));

  doc.version = doc.version || '2.0.0';
  doc.tasks = [...existingOther, ...ours];

  if (!dryRun) {
    fs.mkdirSync(vsDir, { recursive: true });
    // No BOM: Set-Content -Encoding UTF8 in v1 emitted one.
    fs.writeFileSync(tasksPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  }

  return { ok: true, tasksPath, written: ours.length, kept: existingOther.length, warnings };
}

/** Strip our tasks, keep everyone else's, delete the file if nothing is left. */
export function clearTasks(repoRoot) {
  const tasksPath = path.join(repoRoot, '.vscode', 'tasks.json');
  if (!fs.existsSync(tasksPath)) return { ok: true, tasksPath, removed: 0, deleted: false };

  let doc;
  try {
    doc = parseJsonc(fs.readFileSync(tasksPath, 'utf8'));
  } catch (err) {
    return { ok: false, tasksPath, error: err.message };
  }
  if (!doc || !Array.isArray(doc.tasks)) return { ok: true, tasksPath, removed: 0, deleted: false };

  const before = doc.tasks.length;
  const kept = doc.tasks.filter((t) => !isOurs(t));
  const removed = before - kept.length;

  if (kept.length === 0 && removed > 0) {
    fs.unlinkSync(tasksPath);
    return { ok: true, tasksPath, removed, deleted: true };
  }
  doc.tasks = kept;
  fs.writeFileSync(tasksPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return { ok: true, tasksPath, removed, deleted: false };
}

/** True when git ignores the generated file. null when we cannot tell. */
export function isGitIgnored(repoRoot) {
  if (!fs.existsSync(path.join(repoRoot, '.git'))) return null;
  try {
    execFileSync('git', ['check-ignore', '-q', path.join('.vscode', 'tasks.json')], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return true;
  } catch (err) {
    // Exit 1 means "not ignored". Anything else (git missing, not a repo) is unknown.
    return err && err.status === 1 ? false : null;
  }
}
