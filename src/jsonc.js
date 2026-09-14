// Minimal JSONC reader. VSCode tasks.json and Claude settings.json both tolerate
// // and /* */ comments plus trailing commas, so JSON.parse alone would throw on
// a perfectly valid file that the user hand-edited.

const BACKSLASH = String.fromCharCode(92);
const BOM = String.fromCharCode(0xfeff);

function stripComments(text) {
  let out = '';
  let i = 0;
  let inStr = false;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === BACKSLASH) { out += text[i + 1] ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function stripTrailingCommas(text) {
  let out = '';
  let i = 0;
  let inStr = false;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === BACKSLASH) { out += text[i + 1] ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === ',') {
      let j = i + 1;
      while (j < n && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') { i++; continue; }
    }
    out += c;
    i++;
  }
  return out;
}

export function parseJsonc(text) {
  const body = text.startsWith(BOM) ? text.slice(1) : text;
  return JSON.parse(stripTrailingCommas(stripComments(body)));
}

/** True when the file uses comments, so the caller can warn that a rewrite drops them. */
export function hasComments(text) {
  const body = text.startsWith(BOM) ? text.slice(1) : text;
  return stripComments(body) !== body;
}
