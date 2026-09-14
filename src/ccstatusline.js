import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseJsonc } from './jsonc.js';

/**
 * ccstatusline integration.
 *
 * If you already run ccstatusline, replacing settings.json statusLine would blow
 * your whole statusline away. ccstatusline has a `custom-command` widget that
 * runs a shell command and splices in its stdout, so we register as a widget
 * instead and leave everything else alone.
 *
 * Its custom-command runner passes `{...context.data, terminal_width}` on stdin,
 * and context.data is the same Claude session JSON Claude Code handed it. So the
 * widget still receives session_id and cwd, which is what self-exclusion needs.
 *
 * Widget fields confirmed from src/widgets/CustomCommand.tsx: commandPath,
 * maxWidth, timeout (default 1000ms), preserveColors.
 */

const WIDGET_TYPE = 'custom-command';
const TAG = 'save-claude';

export function configPath() {
  return path.join(os.homedir(), '.config', 'ccstatusline', 'settings.json');
}

export function isInUse(settings) {
  const cmd = settings?.statusLine?.command;
  return typeof cmd === 'string' && cmd.toLowerCase().includes('ccstatusline');
}

export function readConfig() {
  const file = configPath();
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = parseJsonc(fs.readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.lines)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function allWidgets(config) {
  return config.lines.flat().filter((w) => w && typeof w === 'object');
}

export function findWidget(config) {
  return allWidgets(config).find(
    (w) => w.type === WIDGET_TYPE && typeof w.commandPath === 'string' && w.commandPath.includes(TAG));
}

/** ccstatusline ids are plain incrementing strings, so keep that convention. */
function nextId(config) {
  let max = 0;
  for (const w of allWidgets(config)) {
    const n = Number.parseInt(w.id, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1);
}

export function buildWidget(config, command) {
  return {
    id: nextId(config),
    type: WIDGET_TYPE,
    color: 'green',
    commandPath: command,
    // Our own colours carry meaning (green = waiting on you), so keep them.
    preserveColors: true,
    maxWidth: 28,
    // Node cold start is ~150ms; their default 1000ms is tight on a busy machine.
    timeout: 3000,
  };
}

/** Append to the last line that already has widgets, so it sits with existing content. */
function targetLine(config, requested) {
  if (Number.isInteger(requested) && requested >= 0 && requested < config.lines.length) return requested;
  for (let i = config.lines.length - 1; i >= 0; i--) {
    if (Array.isArray(config.lines[i]) && config.lines[i].length > 0) return i;
  }
  return 0;
}

export function addWidget(command, { line, dryRun = false } = {}) {
  const config = readConfig();
  if (!config) return { ok: false, error: `no readable ccstatusline config at ${configPath()}` };

  const existing = findWidget(config);
  if (existing) {
    if (existing.commandPath === command) return { ok: true, changed: false, reason: 'already present' };
    if (!dryRun) {
      existing.commandPath = command;
      writeConfig(config);
    }
    return { ok: true, changed: true, reason: 'updated command path' };
  }

  const index = targetLine(config, line);
  if (!Array.isArray(config.lines[index])) config.lines[index] = [];
  const widget = buildWidget(config, command);
  if (!dryRun) {
    config.lines[index].push(widget);
    writeConfig(config);
  }
  return { ok: true, changed: true, reason: `added to line ${index}`, widget, line: index };
}

export function removeWidget({ dryRun = false } = {}) {
  const config = readConfig();
  if (!config) return { ok: false, error: `no readable ccstatusline config at ${configPath()}` };
  let removed = 0;
  config.lines = config.lines.map((lineWidgets) => {
    if (!Array.isArray(lineWidgets)) return lineWidgets;
    const kept = lineWidgets.filter(
      (w) => !(w?.type === WIDGET_TYPE && typeof w.commandPath === 'string' && w.commandPath.includes(TAG)));
    removed += lineWidgets.length - kept.length;
    return kept;
  });
  if (removed > 0 && !dryRun) writeConfig(config);
  return { ok: true, removed };
}

function writeConfig(config) {
  const file = configPath();
  const backup = file + '.save-claude-backup';
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
