#!/usr/bin/env bash
# save-claude installer (Git Bash on Windows)
# Copies snapshot.ps1 into ~/.claude/tools/terminal-restore and adds the
# save-claude function to ~/.bashrc.
set -e

DIR="$HOME/.claude/tools/terminal-restore"
mkdir -p "$DIR"
cp "$(dirname "$0")/snapshot.ps1" "$DIR/snapshot.ps1"
echo "Installed snapshot.ps1 to $DIR"

if grep -q "save-claude()" "$HOME/.bashrc" 2>/dev/null; then
  echo "save-claude already defined in ~/.bashrc - leaving it."
else
  cat >> "$HOME/.bashrc" <<'EOF'

# Snapshot open Claude Code chats so they auto-reopen when you next open the repo.
save-claude() { powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME/.claude/tools/terminal-restore/snapshot.ps1" "$@"; }
EOF
  echo "Added save-claude to ~/.bashrc"
fi

echo "Done. Run 'source ~/.bashrc' then 'save-claude' before you shut down."
