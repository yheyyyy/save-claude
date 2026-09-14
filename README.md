# save-claude

**Reopen every Claude Code chat you had open, automatically, when you reopen a repo in VSCode. Plus a statusline widget that tells you which chats are waiting on you.**

```bash
npx save-claude
```

Windows, macOS and Linux. Zero dependencies. MIT licensed.

*Last updated: 14 September 2026. Verified against Claude Code 2.1.270.*

---

## The 9am problem

You know this morning.

You had seven Claude Code chats going yesterday. One fixing a login bug. One halfway through a migration. One where you finally got the SQL right after forty minutes. Then you closed VSCode, because it was 7pm and you are a person.

Now it is 9am. You open the repo. You open a terminal, type `claude`, type `/resume`, and squint at a list of sessions that all look the same. You pick one. Probably the wrong one. You open another terminal. `claude`. `/resume`. Squint. Pick. Again. And again. And again.

Seven times. Before coffee.

And halfway through you realise you cannot actually remember which of those chats was the good one, because the list just shows ids and half-remembered first lines.

**save-claude deletes that morning.**

You open the repo. Every chat you had open comes back, in its own terminal, already resumed, labelled so you know which is which. You get your coffee. The chats are already there.

That is the whole idea. It is a small thing. It is a really nice small thing.

---

## What is save-claude?

save-claude is a free, open-source command line tool that saves which Claude Code chat sessions you have open and reopens them automatically the next time you open that repository in VSCode. It reads Claude Code's live session registry, writes one VSCode `folderOpen` task per chat, and each task runs `claude --resume <session-id>` in its own terminal.

It also ships a statusline widget showing how many of your other Claude Code sessions are busy and how many have finished and are waiting for your input.

---

## Quick start

```bash
# 1. See what is open right now
npx save-claude list

# 2. Pick which chats should reopen
npx save-claude

# 3. Wire up the statusline and automatic saving
npx save-claude install
```

Then close VSCode whenever you like. Open the repo again and your chats come back on their own.

The first time you open a repo, VSCode asks "Allow automatic tasks in this folder?" Click **Allow** once and you are done forever.

---

## How do I reopen all my Claude Code sessions at once?

Run `npx save-claude` in any repo where you have chats open. It writes one VSCode task per chat into `.vscode/tasks.json`, each set to `runOn: folderOpen`. When you next open that folder in VSCode, every task fires and you get one terminal per chat, already resumed.

There is no manual `/resume` and no picking from a list. You do nothing at all.

## Why is `/resume` painful when you have several chats?

`claude --resume` restores one session into one terminal. That is correct behaviour, it just does not scale. With seven chats you run the same three steps seven times, and the session picker identifies chats by id and opening line, which is not how you remember them.

save-claude turns seven manual restores into zero.

| | Manual `/resume` | save-claude |
|---|---|---|
| Steps to restore 7 chats | 21 (open terminal, `claude`, `/resume` x7) | 0 |
| Do you have to remember to do anything? | Yes, every single time | No, a `SessionEnd` hook saves for you |
| How chats are labelled | Session id and first line | Claude Code's own derived session name |
| Knows which chats were actually open | No, you guess from a list | Yes, reads the live session registry |
| Tells you which chats are waiting on you | No | Yes, statusline widget |

---

## How does save-claude know which chats are open?

Claude Code keeps one JSON file per **live** session in `~/.claude/sessions`, named `<pid>.json`. Each holds `sessionId`, `cwd`, `entrypoint`, `kind` and a `status` of `busy` or `idle`. That registry is the only accurate answer to "what is open right now", and it is what save-claude reads. It also checks each process id is genuinely alive, so a crashed session that left its file behind is ignored.

### Why not just use transcript timestamps?

Because they lie. Claude Code rewrites conversation transcripts in bulk background passes, so many files share a modification time to the second while only a few sessions are really running.

Measured on a real machine during development:

```
Nine transcripts, identical modification time:  21:20:07
Actual running claude processes:                3
Chats the timestamp method offered to reopen:  21 across 3 repos
Chats the session registry reported:            3
```

Version 1 of this tool used timestamps and over-reported open chats by 7x. Version 2 does not.

The session registry is undocumented internal structure, so save-claude is defensive about it. The shape is verified against Claude Code **2.1.270**. If the directory is missing or its format changes, the tool tells you and falls back to the old timestamp scan rather than breaking.

---

## The statusline widget

When you run several chats at once, the question you actually have is: *which one finished and is waiting for me?* The session registry knows, because `status: idle` means that chat is done and wants your input.

```
◆ 3 sessions  2 busy  1 waiting  ·  ⚠ snapshot 2d old
```

| Part | Meaning |
|---|---|
| `3 sessions` | Other live chats, excluding the one drawing the statusline |
| `2 busy` | Currently working, leave them alone |
| `1 waiting` | Finished and waiting on you. This is the number you care about |
| `⚠ snapshot 2d old` | What would be restored is out of date |

No more clicking through terminals to find out which one stopped.

### Does it work with ccstatusline?

Yes, and it will not touch your setup. If you already use [ccstatusline](https://github.com/sirmalloc/ccstatusline), `npx save-claude install` detects it and registers save-claude as a `custom-command` widget in `~/.config/ccstatusline/settings.json`. Your existing `statusLine` is left exactly as it was.

Inside ccstatusline it runs in compact form, leading with the number that matters:

```
◆ 2 waiting ⚠ 2d
```

Choose which line it lands on with `--line N`. If you do not use ccstatusline, save-claude sets `statusLine` in `~/.claude/settings.json` instead, and refuses to overwrite an existing one unless you pass `--force`.

It renders in about 150ms, comfortably inside the widget timeout.

---

## Do I have to remember to run it?

No, and this is the best part. `npx save-claude install` adds a `SessionEnd` hook, so Claude Code saves your open chats for you every time a session closes. You never type a save command before shutting down.

Snapshots merge rather than replace. When you close VSCode every session fires its own `SessionEnd`, and by the time the last one runs the earlier ones are already gone from the registry. Merging is what stops the straggler being the only chat that comes back. Entries older than 16 hours are pruned, so yesterday's work does not pile up.

---

## Commands

```bash
npx save-claude              # pick which live chats reopen, write .vscode/tasks.json
npx save-claude snapshot     # same, non-interactive, every live chat
npx save-claude list         # show live chats and their status
npx save-claude status       # what is wired up for this repo
npx save-claude statusline   # the widget (reads session JSON on stdin)
npx save-claude install      # statusline widget + automatic SessionEnd snapshots
npx save-claude uninstall    # undo install
npx save-claude clean        # remove our tasks from this repo, keep yours
```

| Flag | Effect |
|---|---|
| `--all` | Skip the picker, take every live chat |
| `--dry-run` | Show what would happen, write nothing |
| `--force` | Let install replace an existing `statusLine` |
| `--line N` | Which ccstatusline line the widget goes on |
| `--quiet` | No output |

Running bare `save-claude` opens a checkbox picker. Space toggles, `a` selects all, `n` selects none, enter confirms, `q` cancels. In a non-interactive shell it takes every live chat.

For a stable install path instead of `npx`:

```bash
npm install -g save-claude
save-claude install
```

---

## Will it break my existing VSCode tasks?

No. save-claude is deliberately careful with files it did not create.

- **Your own tasks are kept.** Only tasks tagged `"detail": "save-claude-managed"` are rewritten. Your build and test tasks are read, preserved and written back untouched.
- **Comments and trailing commas are handled.** `tasks.json` is JSONC, so it parses both. Comments cannot survive a rewrite, so the original is copied once to `tasks.json.save-claude-backup` first.
- **A broken `tasks.json` is left alone.** If it will not parse, the file is untouched, backed up once, and that repo is skipped.
- **Backups never pile up.** One fixed backup name, written only when absent. Version 1 used timestamps and left a fresh copy on every single run.
- **Your transcripts are never written to.**
- **Session key files are never read.** Only `*.json` in `~/.claude/sessions`, never the sibling `*.key` files.
- **`~/.claude/settings.json` is backed up once** before any change, and `npx save-claude uninstall` puts everything back.

---

## Which chats count as real chats?

Only sessions with `kind: interactive` and `entrypoint: cli`.

This matters more than it sounds. If you build applications on the Claude Agent SDK, those runs write transcripts into the same `~/.claude/projects` tree as your real chats. Version 1 could not tell them apart and would cheerfully offer to reopen six API calls as if they were conversations. Version 2 filters them out.

---

## Frequently asked questions

### Does save-claude keep my sessions running in the background?

No. Nothing stays running and nothing is kept alive. Claude Code already saves every conversation to `~/.claude/projects/<repo>/<session-id>.jsonl`. save-claude only records which ones were open and replays them with `claude --resume` later. Your chats were never in danger.

### Why one task per chat instead of a single restore command?

Because a VSCode task is one terminal. There is no CLI that spawns a VSCode terminal, and `folderOpen` tasks only run for the folder you actually open. One task per chat is the only way to get one terminal per chat.

### What if my chat was in a subdirectory of the repo?

It is rolled up to the git root automatically. VSCode only runs `folderOpen` tasks for the folder you open, so a `tasks.json` buried in a subfolder would never fire. save-claude walks up to the nearest `.git` and writes there instead. Git worktrees are handled too, where `.git` is a file rather than a directory.

### Can I lose a chat this way?

No. save-claude only ever writes `.vscode/tasks.json` and its own snapshot files. It never modifies, moves or deletes a transcript.

### What happens to a chat that is too old?

Claude Code deletes transcripts after `cleanupPeriodDays`, which defaults to 30 days of inactivity. A chat past that is already gone and its task shows a harmless "no session found". Raise `cleanupPeriodDays` in `~/.claude/settings.json` to keep chats longer.

### Should I commit the generated tasks.json?

No. Add `.vscode/` to the repo's `.gitignore`. save-claude warns you when a repo does not ignore it.

### Does it work if I moved my Claude config?

Yes, `CLAUDE_CONFIG_DIR` is respected.

### Is it safe to run repeatedly?

Yes. Runs are idempotent. Each run replaces only its own tasks, writes at most one backup ever, and keeps the snapshot in `~/.claude/save-claude` rather than churning a file inside your repo.

### Is save-claude free?

Yes. MIT licensed, no account, no sign-up, no paid tier. The source is about 1,800 lines of plain ES modules with zero runtime dependencies, so you can read all of it in an afternoon.

### Does save-claude send my conversations anywhere?

No. It makes no network calls at all. The only Node modules it imports are `fs`, `os`, `path`, `crypto`, `readline`, `url` and `child_process`, and the only external command it runs is `git check-ignore` to warn you when `.vscode/` is not ignored. Your chats never leave your machine.

### How many Claude Code sessions can it restore at once?

As many as you have open. Each becomes its own VSCode task and its own terminal. On a normal laptop the practical limit is how many terminals you want running, not anything in the tool.

### Can I choose which chats reopen?

Yes. Running bare `npx save-claude` opens a checkbox picker listing every live chat grouped by repo. Space toggles one, `a` selects all, `n` selects none, enter confirms. Use `npx save-claude --all` to skip the picker.

### How do I know which chat is waiting for me?

The statusline widget. `status: idle` in Claude Code's session registry means that chat has finished and wants your input, so the widget shows it as `waiting`. Run `npx save-claude list` for the same information in full.

### What versions does save-claude need?

Node 18.17 or newer. The session registry format is verified against Claude Code 2.1.270. Older Claude Code versions still work through the transcript timestamp fallback, less accurately.

### Does save-claude work without VSCode?

Partly. The snapshot is plain JSON in `~/.claude/save-claude` and `npx save-claude list` works anywhere. Automatic reopening needs VSCode, because it depends on `folderOpen` tasks. There is no equivalent hook in a bare terminal.

### Does it work with Cursor, Windsurf or other VSCode forks?

It should. They read `.vscode/tasks.json` and support `runOn: folderOpen` the same way. This has not been tested, so treat it as unverified rather than promised.

---

## Upgrading from version 1

Version 1 was a Windows-only PowerShell script installed by editing `~/.bashrc`. Version 2 replaces it with a cross-platform npm package and a much more accurate way of detecting open chats.

```bash
rm -rf ~/.claude/tools/terminal-restore
# then delete the save-claude() function from ~/.bashrc
npx save-claude install
```

Old generated `tasks.json` files are recognised and rewritten in place, so nothing is left orphaned.

---

## How it works, end to end

```
you work                 several claude chats open across terminals
  ↓
session ends             SessionEnd hook fires, snapshot saved automatically
  ↓
you close VSCode         chats are safe on disk, nothing is running
  ↓
you open the repo        VSCode runs the folderOpen tasks
  ↓
your chats are back      one resumed terminal each, labelled, ready
```

---

## Development

```bash
git clone https://github.com/yheyyyy/save-claude.git
cd save-claude
npm test
```

No build step, no runtime dependencies, about 1,800 lines of plain ES modules. The suite covers JSONC parsing, task merging, backup behaviour, label handling, repo root resolution, process liveness and statusline robustness.

Dependency-free is a deliberate choice. The statusline runs on every redraw and `npx save-claude` should start instantly, so pulling in a UI framework to draw a list of checkboxes would be paid for on every invocation.

---

## Related projects

- [ccstatusline](https://github.com/sirmalloc/ccstatusline), a highly customisable Claude Code statusline. save-claude integrates with it rather than competing.
- [Claude Code hooks documentation](https://code.claude.com/docs/en/hooks), the `SessionEnd` event this tool uses.
- [Claude Code statusline documentation](https://code.claude.com/docs/en/statusline), the JSON contract the widget reads.

---

## License

MIT. Use it, fork it, make your mornings better.
