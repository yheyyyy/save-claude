import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseJsonc, hasComments } from '../src/jsonc.js';
import { writeTasks, clearTasks, buildTask, MARKER } from '../src/tasks.js';
import { findRepoRoot, repoKey, samePath } from '../src/repo.js';
import { renderStatusline } from '../src/statusline.js';
import { isPidAlive } from '../src/registry.js';

let passed = 0;
let failed = 0;
const tmpRoots = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'save-claude-test-'));
  tmpRoots.push(dir);
  return dir;
}

function readTasks(repoRoot) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, '.vscode', 'tasks.json'), 'utf8'));
}

const BACKSLASH = String.fromCharCode(92);

console.log('\njsonc');
test('parses comments and trailing commas', () => {
  const doc = parseJsonc('{ /* a */ "x": [1, 2,], // b\n "y": 3, }');
  assert.deepEqual(doc, { x: [1, 2], y: 3 });
});
test('does not treat // inside a string as a comment', () => {
  assert.deepEqual(parseJsonc('{"url": "http://x/y"}'), { url: 'http://x/y' });
});
test('handles an escaped quote before a comment marker', () => {
  const src = `{"a": "q${BACKSLASH}"// not a comment", "b": 1}`;
  assert.deepEqual(parseJsonc(src), { a: `q"// not a comment`, b: 1 });
});
test('handles a trailing backslash in a string', () => {
  const src = `{"p": "C:${BACKSLASH}${BACKSLASH}dir${BACKSLASH}${BACKSLASH}", "q": 2}`;
  assert.deepEqual(parseJsonc(src), { p: `C:${BACKSLASH}dir${BACKSLASH}`, q: 2 });
});
test('hasComments is false for plain json', () => {
  assert.equal(hasComments('{"a":1}'), false);
  assert.equal(hasComments('{"a":1} // x'), true);
});

console.log('\nlabels');
test('strips an injected [TAG]...[/TAG] prefix', () => {
  const taken = new Set();
  const t = buildTask({
    sessionId: 'abcdef12-0000-0000-0000-000000000000',
    name: '[CURRENT_TURN_RESPONSE_LANGUAGE] blah blah [/CURRENT_TURN_RESPONSE_LANGUAGE] what is the total revenue?',
  }, taken);
  assert.equal(t.label, 'claude: what is the total revenue?');
});
test('disambiguates identical names', () => {
  const taken = new Set();
  const a = buildTask({ sessionId: 'aaaaaaaa-1', name: 'same' }, taken);
  const b = buildTask({ sessionId: 'bbbbbbbb-2', name: 'same' }, taken);
  assert.equal(a.label, 'claude: same');
  assert.equal(b.label, 'claude: same (bbbbbbbb)');
  assert.notEqual(a.label, b.label);
});
test('falls back when the name is empty', () => {
  assert.equal(buildTask({ sessionId: 'cccccccc-3', name: '' }, new Set()).label, 'claude: chat');
});

console.log('\ntasks.json');
test('creates the file when absent', () => {
  const repo = tmpRepo();
  const res = writeTasks(repo, [{ sessionId: 'aaaaaaaa-1', name: 'one' }]);
  assert.equal(res.ok, true);
  const doc = readTasks(repo);
  assert.equal(doc.tasks.length, 1);
  assert.equal(doc.tasks[0].command, 'claude');
  assert.deepEqual(doc.tasks[0].args, ['--resume', 'aaaaaaaa-1']);
});
test('keeps the user tasks and replaces only ours', () => {
  const repo = tmpRepo();
  fs.mkdirSync(path.join(repo, '.vscode'));
  fs.writeFileSync(path.join(repo, '.vscode', 'tasks.json'), JSON.stringify({
    version: '2.0.0',
    tasks: [{ label: 'build', type: 'shell', command: 'make' }],
  }, null, 2));

  writeTasks(repo, [{ sessionId: 'aaaaaaaa-1', name: 'one' }]);
  let doc = readTasks(repo);
  assert.equal(doc.tasks.length, 2);
  assert.equal(doc.tasks[0].label, 'build');

  // Second run must replace our task, not append a duplicate.
  writeTasks(repo, [{ sessionId: 'bbbbbbbb-2', name: 'two' }]);
  doc = readTasks(repo);
  assert.equal(doc.tasks.length, 2, 'should still be build + one of ours');
  assert.equal(doc.tasks[0].label, 'build');
  assert.equal(doc.tasks.filter((t) => t.detail === MARKER).length, 1);
  assert.deepEqual(doc.tasks[1].args, ['--resume', 'bbbbbbbb-2']);
});
test('does not pile up backups across runs', () => {
  const repo = tmpRepo();
  fs.mkdirSync(path.join(repo, '.vscode'));
  fs.writeFileSync(path.join(repo, '.vscode', 'tasks.json'),
    '{ // my tasks\n "version": "2.0.0", "tasks": [{"label":"build"}] }');

  for (let i = 0; i < 5; i++) writeTasks(repo, [{ sessionId: `s${i}`, name: `n${i}` }]);

  const backups = fs.readdirSync(path.join(repo, '.vscode')).filter((f) => f.includes('backup'));
  assert.equal(backups.length, 1, `expected exactly 1 backup, got ${backups.length}`);
});
test('leaves an unparseable tasks.json alone', () => {
  const repo = tmpRepo();
  fs.mkdirSync(path.join(repo, '.vscode'));
  const p = path.join(repo, '.vscode', 'tasks.json');
  fs.writeFileSync(p, 'this is not json at all');
  const res = writeTasks(repo, [{ sessionId: 'aaaaaaaa-1', name: 'one' }]);
  assert.equal(res.ok, false);
  assert.equal(fs.readFileSync(p, 'utf8'), 'this is not json at all');
  assert.ok(fs.existsSync(p + '.save-claude-backup'));
});
test('writes no BOM', () => {
  const repo = tmpRepo();
  writeTasks(repo, [{ sessionId: 'aaaaaaaa-1', name: 'one' }]);
  const buf = fs.readFileSync(path.join(repo, '.vscode', 'tasks.json'));
  assert.notEqual(buf[0], 0xef, 'file starts with a UTF-8 BOM');
});
test('dry run writes nothing', () => {
  const repo = tmpRepo();
  writeTasks(repo, [{ sessionId: 'aaaaaaaa-1', name: 'one' }], { dryRun: true });
  assert.equal(fs.existsSync(path.join(repo, '.vscode', 'tasks.json')), false);
});
test('clean removes ours and keeps theirs', () => {
  const repo = tmpRepo();
  fs.mkdirSync(path.join(repo, '.vscode'));
  fs.writeFileSync(path.join(repo, '.vscode', 'tasks.json'), JSON.stringify({
    version: '2.0.0', tasks: [{ label: 'build', command: 'make' }],
  }));
  writeTasks(repo, [{ sessionId: 'aaaaaaaa-1', name: 'one' }]);
  const res = clearTasks(repo);
  assert.equal(res.removed, 1);
  assert.equal(res.deleted, false);
  assert.deepEqual(readTasks(repo).tasks.map((t) => t.label), ['build']);
});
test('clean deletes the file when only ours were in it', () => {
  const repo = tmpRepo();
  writeTasks(repo, [{ sessionId: 'aaaaaaaa-1', name: 'one' }]);
  const res = clearTasks(repo);
  assert.equal(res.deleted, true);
  assert.equal(fs.existsSync(path.join(repo, '.vscode', 'tasks.json')), false);
});

console.log('\nrepo');
test('findRepoRoot walks up to .git', () => {
  const repo = tmpRepo();
  fs.mkdirSync(path.join(repo, '.git'));
  const nested = path.join(repo, 'a', 'b', 'c');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(findRepoRoot(nested), fs.realpathSync(repo) === repo ? repo : findRepoRoot(nested));
  assert.ok(samePath(findRepoRoot(nested), repo));
});
test('findRepoRoot treats .git as a file (worktrees)', () => {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, '.git'), 'gitdir: /elsewhere');
  const nested = path.join(repo, 'sub');
  fs.mkdirSync(nested);
  assert.ok(samePath(findRepoRoot(nested), repo));
});
test('findRepoRoot falls back to the start dir outside a repo', () => {
  const dir = tmpRepo();
  assert.ok(samePath(findRepoRoot(dir), dir));
});
test('repoKey is stable and distinct', () => {
  assert.equal(repoKey('/a/b/project'), repoKey('/a/b/project/'));
  assert.notEqual(repoKey('/a/b/project'), repoKey('/a/c/project'));
});

console.log('\nstatusline');
test('never throws on junk input', () => {
  assert.doesNotThrow(() => renderStatusline(null, { color: false }));
  assert.doesNotThrow(() => renderStatusline({ cwd: 12345 }, { color: false }));
});
test('emits no ANSI when color is off', () => {
  const out = renderStatusline({ cwd: process.cwd() }, { color: false });
  assert.ok(!out.includes(String.fromCharCode(27)), `found ANSI in: ${JSON.stringify(out)}`);
});

console.log('\nregistry');
test('current process counts as alive', () => {
  assert.equal(isPidAlive(process.pid), true);
});
test('nonsense pids do not', () => {
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive('abc'), false);
});

for (const dir of tmpRoots) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
