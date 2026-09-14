import fs from 'node:fs';
import path from 'node:path';
import { SETTINGS_FILE, CLAUDE_DIR, PKG_ROOT, BIN_ENTRY } from './paths.js';
import { parseJsonc } from './jsonc.js';
import * as cc from './ccstatusline.js';

/**
 * Wires two things into ~/.claude/settings.json:
 *   statusLine  -> the widget
 *   SessionEnd  -> an automatic snapshot, so you never have to remember to run this
 *
 * Both point at an absolute node path rather than `npx save-claude`. The
 * statusline runs on every redraw and npx would add a package resolution to each
 * one. SessionEnd has no matcher, per the hooks reference.
 */

const HOOK_TAG = 'save-claude';
const BACKUP = SETTINGS_FILE + '.save-claude-backup';

function quoted(p) {
  return p.includes(' ') ? `"${p}"` : p;
}

export function statuslineCommand() {
  return `node ${quoted(path.join(PKG_ROOT, 'bin', 'save-claude.js'))} statusline`;
}

/** Shorter output, since inside ccstatusline we are one widget among many. */
export function widgetCommand() {
  return `${statuslineCommand()} --compact`;
}

export function snapshotHookCommand() {
  return `node ${quoted(BIN_ENTRY)} snapshot --hook`;
}

function readSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) return {};
  const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
  const parsed = parseJsonc(raw);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function writeSettings(settings) {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function backupOnce() {
  if (!fs.existsSync(SETTINGS_FILE) || fs.existsSync(BACKUP)) return null;
  fs.copyFileSync(SETTINGS_FILE, BACKUP);
  return BACKUP;
}

function hookEntries(settings) {
  const hooks = settings.hooks ?? {};
  const list = Array.isArray(hooks.SessionEnd) ? hooks.SessionEnd : [];
  return { hooks, list };
}

function hasOurHook(list) {
  return list.some((group) =>
    Array.isArray(group?.hooks) &&
    group.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(HOOK_TAG)));
}

export function planInstall({ force = false } = {}) {
  let settings;
  try {
    settings = readSettings();
  } catch (err) {
    return { ok: false, error: `settings.json is not valid JSON (${err.message}); fix it first` };
  }

  const actions = [];
  const conflicts = [];

  const wantStatus = statuslineCommand();
  const current = settings.statusLine;

  if (cc.isInUse(settings)) {
    // Never clobber ccstatusline. Register as one of its widgets instead.
    const config = cc.readConfig();
    if (!config) {
      conflicts.push(`ccstatusline is your statusLine but its config at ${cc.configPath()} is missing or unreadable; open it once with "npx ccstatusline@latest", then rerun`);
    } else {
      const existing = cc.findWidget(config);
      if (!existing) actions.push({ kind: 'ccstatusline-widget', detail: widgetCommand() });
      else if (existing.commandPath !== widgetCommand()) {
        actions.push({ kind: 'ccstatusline-widget', detail: `update widget to ${widgetCommand()}` });
      }
    }
  } else if (!current) {
    actions.push({ kind: 'statusLine', detail: wantStatus });
  } else if (typeof current.command === 'string' && current.command.includes(HOOK_TAG)) {
    if (current.command !== wantStatus) actions.push({ kind: 'statusLine', detail: `update to ${wantStatus}` });
  } else if (force) {
    actions.push({ kind: 'statusLine', detail: `replace existing statusLine with ${wantStatus}` });
  } else {
    conflicts.push(`statusLine already set to: ${current.command ?? JSON.stringify(current)} (use --force to replace)`);
  }

  const { list } = hookEntries(settings);
  if (!hasOurHook(list)) actions.push({ kind: 'SessionEnd', detail: snapshotHookCommand() });

  return { ok: true, settings, actions, conflicts };
}

export function install({ force = false, dryRun = false, lineOverride = undefined } = {}) {
  const plan = planInstall({ force });
  if (!plan.ok) return plan;
  if (plan.actions.length === 0) {
    return { ...plan, changed: false, backup: null };
  }
  if (dryRun) return { ...plan, changed: false, backup: null, dryRun: true };

  // Only touch settings.json when something in it actually changes. A pure
  // ccstatusline widget install must leave it alone, backup included.
  const touchesSettings = plan.actions.some((a) => a.kind !== 'ccstatusline-widget');
  const backup = touchesSettings ? backupOnce() : null;
  const settings = plan.settings;
  const notes = [];

  for (const action of plan.actions) {
    if (action.kind === 'ccstatusline-widget') {
      const result = cc.addWidget(widgetCommand(), { line: lineOverride });
      notes.push(result.ok
        ? `ccstatusline widget: ${result.reason}`
        : `ccstatusline widget failed: ${result.error}`);
      continue;
    }
    if (action.kind === 'statusLine') {
      settings.statusLine = { type: 'command', command: statuslineCommand(), padding: 0 };
    }
    if (action.kind === 'SessionEnd') {
      settings.hooks = settings.hooks ?? {};
      if (!Array.isArray(settings.hooks.SessionEnd)) settings.hooks.SessionEnd = [];
      // SessionEnd takes no matcher: a bare { hooks: [...] } group.
      settings.hooks.SessionEnd.push({
        hooks: [{ type: 'command', command: snapshotHookCommand() }],
      });
    }
  }

  if (touchesSettings) writeSettings(settings);
  return { ...plan, changed: true, backup, notes };
}

export function uninstall({ dryRun = false } = {}) {
  let settings;
  try {
    settings = readSettings();
  } catch (err) {
    return { ok: false, error: `settings.json is not valid JSON (${err.message})` };
  }

  const removed = [];
  if (settings.statusLine && typeof settings.statusLine.command === 'string' &&
      settings.statusLine.command.includes(HOOK_TAG)) {
    removed.push('statusLine');
    if (!dryRun) delete settings.statusLine;
  }

  const { list } = hookEntries(settings);
  if (hasOurHook(list)) {
    removed.push('SessionEnd hook');
    if (!dryRun) {
      const kept = list
        .map((group) => ({
          ...group,
          hooks: (group.hooks ?? []).filter(
            (h) => !(typeof h?.command === 'string' && h.command.includes(HOOK_TAG))),
        }))
        .filter((group) => (group.hooks ?? []).length > 0);
      if (kept.length > 0) settings.hooks.SessionEnd = kept;
      else delete settings.hooks.SessionEnd;
      if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
    }
  }

  if (removed.length > 0 && !dryRun) {
    backupOnce();
    writeSettings(settings);
  }

  const widget = cc.removeWidget({ dryRun });
  if (widget.ok && widget.removed > 0) removed.push(`ccstatusline widget (${widget.removed})`);

  return { ok: true, removed, dryRun };
}
