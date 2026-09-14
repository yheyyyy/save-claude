import readline from 'node:readline';

/**
 * Checkbox picker, hand rolled on readline keypress events.
 *
 * Deliberately dependency-free. The statusline path runs on every redraw and
 * `npx save-claude` should start instantly, so pulling in React and Ink to draw
 * a list of checkboxes would be paid for on every single invocation.
 */

const ESC = String.fromCharCode(27);
const C = {
  reset: ESC + '[0m',
  dim: ESC + '[2m',
  bold: ESC + '[1m',
  cyan: ESC + '[36m',
  green: ESC + '[32m',
  invert: ESC + '[7m',
};

function clearScreen() {
  process.stdout.write(ESC + '[2J' + ESC + '[H');
}

export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * @param {{title: string, groups: Array<{label: string, items: Array<{key: string, text: string, hint?: string}>}>}} opts
 * @returns {Promise<Set<string>|null>} chosen keys, or null when cancelled
 */
export function pick({ title, groups }) {
  return new Promise((resolve) => {
    const flat = [];
    for (const group of groups) {
      flat.push({ type: 'header', label: group.label });
      for (const item of group.items) flat.push({ type: 'item', ...item });
    }

    const selectable = flat.filter((r) => r.type === 'item');
    if (selectable.length === 0) return resolve(new Set());

    const chosen = new Set(selectable.map((r) => r.key));
    let cursor = flat.findIndex((r) => r.type === 'item');

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const draw = () => {
      clearScreen();
      process.stdout.write(`${C.bold}${title}${C.reset}\n`);
      process.stdout.write(`${C.dim}space toggle · a all · n none · enter confirm · q cancel${C.reset}\n\n`);
      flat.forEach((row, i) => {
        if (row.type === 'header') {
          process.stdout.write(`\n${C.cyan}${row.label}${C.reset}\n`);
          return;
        }
        const box = chosen.has(row.key) ? `${C.green}[x]${C.reset}` : '[ ]';
        const hint = row.hint ? ` ${C.dim}${row.hint}${C.reset}` : '';
        const line = `  ${box} ${row.text}${hint}`;
        process.stdout.write(i === cursor ? `${C.invert}>${C.reset}${line}\n` : ` ${line}\n`);
      });
      process.stdout.write(`\n${C.dim}${chosen.size} of ${selectable.length} selected${C.reset}\n`);
    };

    const move = (delta) => {
      let next = cursor;
      for (let i = 0; i < flat.length; i++) {
        next = (next + delta + flat.length) % flat.length;
        if (flat[next].type === 'item') break;
      }
      cursor = next;
    };

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('keypress', onKey);
      clearScreen();
    };

    function onKey(str, key) {
      if (!key) return;
      if (key.name === 'up' || key.name === 'k') { move(-1); draw(); return; }
      if (key.name === 'down' || key.name === 'j') { move(1); draw(); return; }
      if (key.name === 'space') {
        const row = flat[cursor];
        if (row?.type === 'item') {
          if (chosen.has(row.key)) chosen.delete(row.key);
          else chosen.add(row.key);
        }
        draw();
        return;
      }
      if (str === 'a') { selectable.forEach((r) => chosen.add(r.key)); draw(); return; }
      if (str === 'n') { chosen.clear(); draw(); return; }
      if (key.name === 'return' || key.name === 'enter') { cleanup(); resolve(chosen); return; }
      if (str === 'q' || key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        cleanup();
        resolve(null);
      }
    }

    process.stdin.on('keypress', onKey);
    draw();
  });
}
