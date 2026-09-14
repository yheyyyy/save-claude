import { readRegistry } from './registry.js';
import { findRepoRoot, samePath } from './repo.js';
import { snapshotAge } from './snapshot.js';

/**
 * Statusline widget. Claude Code pipes session JSON on stdin and prints whatever
 * we write to stdout, so this runs on every redraw. It must be fast, it must
 * never hang, and it must never crash: a thrown error here would show up as
 * garbage in the user's prompt.
 */

const STALE_AFTER_MS = 6 * 3600 * 1000;

const ESC = String.fromCharCode(27);
const COLOR = {
  reset: ESC + '[0m',
  dim: ESC + '[2m',
  cyan: ESC + '[36m',
  yellow: ESC + '[33m',
  green: ESC + '[32m',
};

function paint(text, color, enabled) {
  return enabled ? `${color}${text}${COLOR.reset}` : text;
}

function humaniseAge(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function renderStatusline(rawInput = {}, { now = Date.now(), color = true, compact = false } = {}) {
  // JSON.parse('null') is null, and a default parameter only covers undefined.
  const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
  const parts = [];

  const registry = readRegistry();
  // Only the registry can answer this. The mtime fallback has no liveness or
  // busy/idle signal, so the widget stays silent rather than inventing one.
  if (registry.ok) {
    const others = registry.sessions.filter((s) => {
      if (input.session_id && s.sessionId === input.session_id) return false;
      if (!input.session_id && input.pid && s.pid === input.pid) return false;
      return true;
    });

    if (others.length > 0) {
      const busy = others.filter((s) => s.status === 'busy').length;
      const waiting = others.filter((s) => s.status === 'idle').length;

      if (compact) {
        // Statusline real estate is scarce. Lead with the actionable number.
        parts.push(waiting > 0
          ? paint(`◆ ${waiting} waiting`, COLOR.green, color)
          : paint(`◆ ${others.length} busy`, COLOR.dim, color));
      } else {
        const bits = [paint(`◆ ${others.length} session${others.length === 1 ? '' : 's'}`, COLOR.cyan, color)];
        if (busy > 0) bits.push(paint(`${busy} busy`, COLOR.dim, color));
        if (waiting > 0) bits.push(paint(`${waiting} waiting`, COLOR.green, color));
        parts.push(bits.join('  '));
      }
    }
  }

  const cwd = input.cwd || input.workspace?.current_dir || process.cwd();
  let repoRoot;
  try {
    repoRoot = findRepoRoot(cwd);
  } catch {
    repoRoot = cwd;
  }

  const age = snapshotAge(repoRoot, now);
  if (age === null) {
    parts.push(paint(compact ? '⚠ unsaved' : '⚠ no snapshot', COLOR.yellow, color));
  } else if (age > STALE_AFTER_MS) {
    parts.push(paint(compact ? `⚠ ${humaniseAge(age)}` : `⚠ snapshot ${humaniseAge(age)} old`, COLOR.yellow, color));
  }

  return parts.join(paint(compact ? ' ' : '  ·  ', COLOR.dim, color));
}

function readStdin(timeoutMs = 250) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(data);
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); finish(); });
    process.stdin.on('error', () => { clearTimeout(timer); finish(); });
  });
}

export async function statuslineCommand(flags = {}) {
  let input = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) input = JSON.parse(raw);
  } catch {
    input = {};
  }

  let line = '';
  try {
    const color = !process.env.NO_COLOR && !flags.plain;
    line = renderStatusline(input, { color, compact: Boolean(flags.compact) });
  } catch {
    line = '';
  }
  if (line) process.stdout.write(line);
  return 0;
}

export { samePath };
