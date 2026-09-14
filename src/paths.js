import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOME = os.homedir();

// Claude Code honours CLAUDE_CONFIG_DIR; respect it so we read the same tree it writes.
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR
  ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
  : path.join(HOME, '.claude');

export const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
export const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
export const STATE_DIR = path.join(CLAUDE_DIR, 'save-claude');
export const SNAPSHOT_DIR = path.join(STATE_DIR, 'snapshots');

const here = path.dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = path.resolve(here, '..');
export const BIN_ENTRY = path.join(PKG_ROOT, 'bin', 'save-claude.js');
