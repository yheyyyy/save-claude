#!/usr/bin/env node
import fs from 'node:fs';
import { getLiveSessions, readRegistry, VERIFIED_AGAINST } from '../src/registry.js';
import { findRepoRoot } from '../src/repo.js';
import { saveSnapshot, loadSnapshot, clearSnapshot, snapshotAge } from '../src/snapshot.js';
import { writeTasks, clearTasks, isGitIgnored } from '../src/tasks.js';
import { statuslineCommand } from '../src/statusline.js';
import { install, uninstall, planInstall } from '../src/install.js';
import { pick, isInteractive } from '../src/tui.js';
import { SETTINGS_FILE } from '../src/paths.js';

const ESC = String.fromCharCode(27);
const C = {
  reset: ESC + '[0m', dim: ESC + '[2m', bold: ESC + '[1m',
  cyan: ESC + '[36m', green: ESC + '[32m', yellow: ESC + '[33m', red: ESC + '[31m',
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (text, colour) => (useColor ? `${colour}${text}${C.reset}` : text);
const say = (...a) => console.log(...a);

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [key, inline] = a.slice(2).split('=');
      if (inline !== undefined) flags[key] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('-')) flags[key] = argv[++i];
      else flags[key] = true;
    } else rest.push(a);
  }
  return { flags, rest };
}

function groupByRepo(sessions) {
  const groups = new Map();
  for (const s of sessions) {
    let root;
    try {
      root = findRepoRoot(s.cwd);
    } catch {
      root = s.cwd;
    }
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(s);
  }
  return groups;
}

function describe(session) {
  const short = session.sessionId.slice(0, 8);
  const status = session.status === 'busy' ? c('busy', C.dim)
    : session.status === 'idle' ? c('waiting', C.green)
    : '';
  return { short, status, name: session.name || '(unnamed)' };
}

function warnIfDegraded(result) {
  if (result.degradedFrom) {
    say(c(`! Live session registry unavailable (${result.degradedFrom}).`, C.yellow));
    say(c('  Falling back to transcript timestamps, which over-report open chats.', C.yellow));
    say(c(`  Verified against Claude Code ${VERIFIED_AGAINST}.`, C.dim));
  }
}

/** Read hook JSON from stdin when invoked as a SessionEnd hook. */
function readStdinSync() {
  try {
    if (process.stdin.isTTY) return '';
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function commitRepos(groups, { dryRun, quiet }) {
  let repos = 0;
  for (const [repoRoot, sessions] of groups) {
    const snap = dryRun ? null : saveSnapshot(repoRoot, sessions);
    const ordered = (snap ? snap.sessions : sessions).map((entry) => ({
      sessionId: entry.sessionId,
      name: entry.name ?? '',
    }));
    const result = writeTasks(repoRoot, ordered, { dryRun });
    repos++;

    if (quiet) continue;

    say(`\n${c('==', C.dim)} ${c(repoRoot, C.cyan)}`);
    for (const s of sessions) {
      const d = describe(s);
      say(`   ${d.short}  ${d.name}  ${d.status}`);
    }
    if (!result.ok) {
      say(c(`   ! ${result.error}`, C.yellow));
      if (result.backup) say(c(`     backed up once to ${result.backup}`, C.dim));
      continue;
    }
    for (const w of result.warnings) say(c(`   ! ${w}`, C.yellow));
    say(dryRun
      ? c(`   [dry run] would write ${result.tasksPath}`, C.dim)
      : c(`   wrote ${result.tasksPath} (${result.written} chat tasks, ${result.kept} of your own kept)`, C.green));

    if (isGitIgnored(repoRoot) === false) {
      say(c(`   ! .vscode/tasks.json is not gitignored here`, C.yellow));
    }
  }
  return repos;
}

// --- commands --------------------------------------------------------------

async function cmdDefault(flags) {
  const result = getLiveSessions();
  warnIfDegraded(result);

  if (result.sessions.length === 0) {
    say('No live Claude Code chats found. Nothing to save.');
    return 0;
  }

  const groups = groupByRepo(result.sessions);

  if (!isInteractive() || flags.all) {
    commitRepos(groups, { dryRun: Boolean(flags['dry-run']), quiet: false });
    return 0;
  }

  const chosen = await pick({
    title: 'save-claude · which chats should reopen?',
    groups: [...groups].map(([repoRoot, sessions]) => ({
      label: repoRoot,
      items: sessions.map((s) => {
        const d = describe(s);
        return { key: s.sessionId, text: `${d.short}  ${d.name}`, hint: s.status };
      }),
    })),
  });

  if (chosen === null) {
    say('Cancelled. Nothing written.');
    return 1;
  }
  if (chosen.size === 0) {
    say('Nothing selected. Nothing written.');
    return 0;
  }

  const filtered = new Map();
  for (const [repoRoot, sessions] of groups) {
    const keep = sessions.filter((s) => chosen.has(s.sessionId));
    if (keep.length > 0) filtered.set(repoRoot, keep);
  }
  const repos = commitRepos(filtered, { dryRun: Boolean(flags['dry-run']), quiet: false });
  say(`\n${c('Done.', C.green)} ${repos} repo(s). Open one in VSCode and the chats reopen.`);
  say(c('First time per repo VSCode asks "Allow automatic tasks in this folder?" - click Allow.', C.dim));
  return 0;
}

function cmdSnapshot(flags) {
  const isHook = Boolean(flags.hook);
  const quiet = Boolean(flags.quiet || isHook);

  const result = getLiveSessions();
  const sessions = [...result.sessions];

  // As a SessionEnd hook, this session is the one closing, so it may already be
  // out of the registry. Take it from the hook payload instead.
  if (isHook) {
    try {
      const raw = readStdinSync();
      if (raw.trim()) {
        const input = JSON.parse(raw);
        if (input.session_id && input.cwd && !sessions.some((s) => s.sessionId === input.session_id)) {
          sessions.push({
            sessionId: input.session_id,
            cwd: input.cwd,
            name: input.session_name || '',
            status: 'ended',
            startedAt: new Date().toISOString(),
          });
        }
      }
    } catch {
      // A hook must never break the session it is attached to.
    }
  }

  if (sessions.length === 0) {
    if (!quiet) say('No live Claude Code chats found. Nothing to save.');
    return 0;
  }

  if (!quiet) warnIfDegraded(result);
  const repos = commitRepos(groupByRepo(sessions), { dryRun: Boolean(flags['dry-run']), quiet });
  if (!quiet) say(`\n${c('Done.', C.green)} ${repos} repo(s) updated.`);
  return 0;
}

function cmdList() {
  const result = getLiveSessions();
  warnIfDegraded(result);
  if (result.sessions.length === 0) {
    say('No live Claude Code chats.');
    return 0;
  }
  for (const [repoRoot, sessions] of groupByRepo(result.sessions)) {
    say(`\n${c(repoRoot, C.cyan)}`);
    for (const s of sessions) {
      const d = describe(s);
      say(`   ${d.short}  ${d.name}  ${d.status}`);
    }
  }
  return 0;
}

function cmdStatus() {
  const repoRoot = findRepoRoot(process.cwd());
  const registry = readRegistry();
  say(`repo:       ${repoRoot}`);
  say(`registry:   ${registry.ok ? c('available', C.green) : c(registry.reason, C.yellow)} (verified against ${VERIFIED_AGAINST})`);
  say(`live chats: ${registry.sessions.length}`);
  const age = snapshotAge(repoRoot);
  say(`snapshot:   ${age === null ? c('never saved', C.yellow) : `${Math.round(age / 60000)}m old`}`);
  const snap = loadSnapshot(repoRoot);
  say(`saved:      ${snap ? snap.sessions.length : 0} chat(s) for this repo`);
  const plan = planInstall();
  if (plan.ok) {
    say(`settings:   ${plan.actions.length === 0 ? c('wired up', C.green) : c(`${plan.actions.length} thing(s) not installed`, C.yellow)}`);
    for (const conflict of plan.conflicts) say(c(`   ! ${conflict}`, C.yellow));
  }
  return 0;
}

function cmdClean() {
  const repoRoot = findRepoRoot(process.cwd());
  const result = clearTasks(repoRoot);
  if (!result.ok) {
    say(c(`! ${result.error}`, C.red));
    return 1;
  }
  clearSnapshot(repoRoot);
  say(result.deleted
    ? `Removed ${result.removed} task(s) and deleted ${result.tasksPath}.`
    : `Removed ${result.removed} task(s) from ${result.tasksPath}; your own tasks kept.`);
  return 0;
}

function cmdInstall(flags) {
  const dryRun = Boolean(flags['dry-run']);
  const lineOverride = flags.line === undefined ? undefined : Number.parseInt(flags.line, 10);
  const result = install({ force: Boolean(flags.force), dryRun, lineOverride });
  if (!result.ok) {
    say(c(`! ${result.error}`, C.red));
    return 1;
  }
  for (const conflict of result.conflicts) say(c(`! ${conflict}`, C.yellow));
  if (result.actions.length === 0) {
    say(c('Already installed. Nothing to do.', C.green));
    return 0;
  }
  for (const action of result.actions) {
    say(`${dryRun ? '[dry run] would set' : 'set'} ${c(action.kind, C.cyan)}: ${action.detail}`);
  }
  for (const note of result.notes ?? []) say(c(`  ${note}`, C.dim));
  if (!dryRun) {
    if (result.backup) say(c(`backed up ${SETTINGS_FILE} to ${result.backup}`, C.dim));
    say(c('\nDone. Statusline is live and snapshots now happen on their own.', C.green));
  }
  return 0;
}

function cmdUninstall(flags) {
  const result = uninstall({ dryRun: Boolean(flags['dry-run']) });
  if (!result.ok) {
    say(c(`! ${result.error}`, C.red));
    return 1;
  }
  say(result.removed.length === 0
    ? 'Nothing of ours in settings.json.'
    : `Removed: ${result.removed.join(', ')}`);
  return 0;
}

function cmdHelp() {
  say(`${c('save-claude', C.bold)} - reopen your live Claude Code chats, and see which are waiting

${c('Usage', C.bold)}
  npx save-claude                 pick which live chats reopen, write .vscode/tasks.json
  npx save-claude snapshot        same, non-interactive, every live chat
  npx save-claude list            show live chats and their status
  npx save-claude status          show what is wired up for this repo
  npx save-claude statusline      the widget (reads session JSON on stdin)
  npx save-claude install         add statusline + automatic SessionEnd snapshots
  npx save-claude uninstall       take both back out
  npx save-claude clean           remove our tasks from this repo, keep yours

${c('Flags', C.bold)}
  --all        skip the picker, take every live chat
  --dry-run    show what would happen, write nothing
  --force      let install replace an existing statusLine
  --quiet      no output

Chats are read from the live session registry in ~/.claude/sessions, verified
against Claude Code ${VERIFIED_AGAINST}. Transcript timestamps are only a fallback.`);
  return 0;
}

// --- entry -----------------------------------------------------------------

async function main() {
  const { flags, rest } = parseArgs(process.argv.slice(2));
  const command = rest[0] ?? 'default';

  switch (command) {
    case 'default': return cmdDefault(flags);
    case 'snapshot': return cmdSnapshot(flags);
    case 'list': return cmdList();
    case 'status': return cmdStatus();
    case 'statusline': return statuslineCommand(flags);
    case 'install': return cmdInstall(flags);
    case 'uninstall': return cmdUninstall(flags);
    case 'clean': return cmdClean();
    case 'help': case '--help': case '-h': return cmdHelp();
    default:
      say(c(`Unknown command: ${command}`, C.red));
      cmdHelp();
      return 1;
  }
}

main()
  .then((code) => { process.exitCode = code ?? 0; })
  .catch((err) => {
    console.error(c(`save-claude failed: ${err.message}`, C.red));
    process.exitCode = 1;
  });
