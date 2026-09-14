# save-claude

Reopen all your Claude Code chats automatically when you reopen a repo in VSCode.

If you run many `claude` sessions across many VSCode terminals, closing the
editor kills every session and reopening them by hand is slow. `save-claude`
fixes that. Run one command before you shut down, and next time you open a repo
in VSCode each of your open chats reopens in its own terminal, already resumed.

Windows only (uses PowerShell + VSCode tasks). Default terminal assumed to be
Git Bash, but any shell works if you call the script directly.

## How it works

Your chats are never lost. Claude Code saves every conversation to
`~/.claude/projects/<repo>/<session-id>.jsonl`. `save-claude` does not keep
anything running. It records which chats were open, then replays them.

1. **`save-claude`** (you run it before shutting down) scans your saved chats,
   keeps only the ones touched recently that contain real messages you typed
   (it drops slash-command runs, skill/subagent transcripts and other noise),
   works out which repo each belongs to, and writes a `.vscode/tasks.json` into
   each repo listing those chats.
2. **Reopening** happens on its own. When you open that repo in VSCode, it runs
   the `runOn: folderOpen` tasks, opening one terminal per chat, each running
   `claude --resume <id>`. Each terminal is labelled with the chat's latest line
   so you can tell them apart.

```
save-claude          ->  scans open chats, writes .vscode/tasks.json per repo
shut down            ->  chats are safe on disk
open the repo again  ->  VSCode auto-runs the tasks -> one resumed terminal per chat
```

The `.vscode/tasks.json` is fully rewritten each run, so only your latest set
of open chats reopens, never old ones.

## Install

```bash
# from a Git Bash terminal
mkdir -p ~/.claude/tools/terminal-restore
cp snapshot.ps1 ~/.claude/tools/terminal-restore/snapshot.ps1

cat >> ~/.bashrc <<'EOF'

# Snapshot open Claude Code chats so they auto-reopen when you next open the repo.
save-claude() { powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME/.claude/tools/terminal-restore/snapshot.ps1" "$@"; }
EOF

source ~/.bashrc
```

Then add `window.restoreWindows: "all"` to your VSCode user `settings.json` so
launching VSCode reopens all your windows (each then fires its own chats).

## Usage

```bash
save-claude                      # snapshot open chats in every active repo
save-claude -Max 6               # cap at 6 terminals per repo
save-claude -WithinMinutes 60    # widen what counts as "open"
save-claude -Exclude 051f003e    # skip a chat by its 8-char id
save-claude -DryRun              # show what it would do, write nothing
```

The first time you open a repo, VSCode asks "Allow automatic tasks in this
folder?" - click **Allow** once.

## Notes and limits

- It restores the exact **chats**, not the exact tab positions or split layout.
- It only covers repos where you had a real chat open when you ran it.
- A `tasks.json` this tool did not create is backed up and skipped, so your own
  build/test tasks are safe.
- Claude Code deletes chat transcripts after `cleanupPeriodDays` (default 30
  days of inactivity). A chat older than that is gone, and its task would show a
  harmless "no session found". Raise `cleanupPeriodDays` in
  `~/.claude/settings.json` to keep chats longer.
- Add `.vscode/` to a repo's `.gitignore` so the generated file is not
  committed. The tool warns you when a repo does not ignore it.

## License

MIT
