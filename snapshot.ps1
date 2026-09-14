<#
  save-claude / snapshot.ps1  -  Claude Code terminal restore

  Run this RIGHT BEFORE you shut down or close VSCode.

  It finds the Claude Code chats you actually have open - real interactive
  conversations you have been typing in (transcripts touched within the last
  -WithinMinutes minutes that contain genuine human messages) - groups them by
  the repo they belong to, and writes a .vscode\tasks.json into each repo. Next
  time you OPEN that repo in VSCode, every one of those chats reopens in its own
  terminal, already resumed, labelled with its latest line so you know which is
  which.

  It ignores slash-command runs, skill/subagent sidechains and other machine
  generated transcripts, so you get your chats and not the noise.

  It only writes to a repo's .vscode\tasks.json, never to your transcripts. A
  tasks.json this tool did not create is backed up and skipped, so your own
  build/test tasks are never clobbered.

  Options:
    -WithinMinutes 45      how recently a chat must have been active to count
    -Max 12                cap chats restored per repo (most recent first)
    -Exclude a1b2,c3d4      comma-separated 8-char session id prefixes to skip
    -DryRun                show what would happen, write nothing
#>
param(
  [int]$WithinMinutes = 45,
  [int]$Max = 12,
  [string]$Exclude = '',
  [string]$ProjectsRoot = "$env:USERPROFILE\.claude\projects",
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$MARKER   = 'save-claude-managed'
$cut      = (Get-Date).AddMinutes(-$WithinMinutes)
$homeDir  = $env:USERPROFILE.TrimEnd('\','/')
$skipIds  = @($Exclude.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$markup   = '<local-command','<command-name','<command-message','<command-args',
            'Caveat:','<user-memory','<system-reminder','<task-notification',
            '<user-prompt','<bash-','<function_results','<result'

function Get-HumanText($rec) {
  if ($rec.type -ne 'user' -or $rec.isMeta) { return $null }
  $c = $rec.message.content
  if ($c -is [System.Array]) {
    $c = ($c | Where-Object { $_.type -eq 'text' } | ForEach-Object { $_.text }) -join ' '
  }
  $c = "$c".Trim()
  if (-not $c) { return $null }
  foreach ($m in $markup) { if ($c.StartsWith($m)) { return $null } }
  return ($c -replace '\s+',' ')
}

# 1. Collect real, human, interactive sessions grouped by their cwd
$byRepo = @{}
Get-ChildItem $ProjectsRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
  Get-ChildItem $_.FullName -Filter *.jsonl -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -ge $cut } | ForEach-Object {
      $file = $_; $sid = $file.BaseName; $short = $sid.Substring(0,8)
      if ($skipIds -contains $short) { return }
      $cwd = $null; $humans = 0; $lastHuman = ''; $side = $false
      foreach ($line in (Get-Content $file.FullName -ErrorAction SilentlyContinue)) {
        if ($line.Length -lt 2) { continue }
        try { $r = $line | ConvertFrom-Json } catch { continue }
        if ($r.isSidechain) { $side = $true }
        if (-not $cwd -and $r.cwd) { $cwd = "$($r.cwd)".TrimEnd('\','/') }
        $h = Get-HumanText $r
        if ($h) { $humans++; $lastHuman = $h }
      }
      if ($side -or $humans -eq 0 -or -not $cwd) { return }
      if ($cwd -ieq $homeDir) { return }
      if (-not (Test-Path -LiteralPath $cwd)) { return }
      if (-not $byRepo.ContainsKey($cwd)) { $byRepo[$cwd] = @() }
      $byRepo[$cwd] += [pscustomobject]@{ id=$sid; short=$short; at=$file.LastWriteTime; label=$lastHuman }
    }
}

if ($byRepo.Count -eq 0) {
  Write-Host "No open Claude chats found in the last $WithinMinutes minutes. Nothing to do." -ForegroundColor Yellow
  return
}

function ConvertTo-JsonString([string]$s) {
  if ($null -eq $s) { return '' }
  if ($s.Length -gt 70) { $s = $s.Substring(0,70) + '...' }
  ($s -replace '\\','\\' -replace '"','\"' -replace "[`t`r`n]",' ')
}

# 2. Per repo, write .vscode\tasks.json
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
foreach ($repo in $byRepo.Keys) {
  $chats = @($byRepo[$repo] | Sort-Object at -Descending | Select-Object -First $Max)
  $vsdir = Join-Path $repo '.vscode'
  $tasksPath = Join-Path $vsdir 'tasks.json'

  $entries = foreach ($c in $chats) {
    $detail = ConvertTo-JsonString $c.label
@"
    {
      "label": "claude: $($c.short)  -  $detail",
      "detail": "$MARKER",
      "type": "shell",
      "command": "claude",
      "args": ["--resume", "$($c.id)"],
      "isBackground": true,
      "problemMatcher": [],
      "runOptions": { "runOn": "folderOpen" },
      "presentation": { "panel": "dedicated", "reveal": "always", "focus": false }
    }
"@
  }
  $json = @"
{
  "version": "2.0.0",
  "tasks": [
$([string]::Join(",`n", $entries))
  ]
}
"@

  Write-Host "`n== $repo ==" -ForegroundColor Cyan
  foreach ($c in $chats) { Write-Host ("   {0}  {1}  {2}" -f $c.at.ToString('HH:mm'), $c.short, $c.label) }
  if ($byRepo[$repo].Count -gt $chats.Count) {
    Write-Host ("   (+{0} older chat(s) beyond -Max {1}; raise -Max to include)" -f ($byRepo[$repo].Count-$chats.Count), $Max) -ForegroundColor DarkGray
  }

  if ($DryRun) { Write-Host "   [dry run] would write $tasksPath" -ForegroundColor DarkGray; continue }

  if (Test-Path -LiteralPath $tasksPath) {
    $existing = Get-Content -LiteralPath $tasksPath -Raw
    if ($existing -notmatch $MARKER) {
      $bak = "$tasksPath.bak-$stamp"
      Copy-Item -LiteralPath $tasksPath -Destination $bak
      Write-Host "   ! existing tasks.json is not mine - backed up to $bak and SKIPPED." -ForegroundColor Yellow
      continue
    }
  }

  New-Item -ItemType Directory -Force -Path $vsdir | Out-Null
  Set-Content -LiteralPath $tasksPath -Value $json -Encoding UTF8
  Write-Host "   wrote $tasksPath" -ForegroundColor Green

  # git safety: warn if .vscode is not ignored in this repo
  if (Test-Path -LiteralPath (Join-Path $repo '.git')) {
    Push-Location $repo
    $ignored = (& git check-ignore .vscode/tasks.json) 2>$null
    Pop-Location
    if (-not $ignored) {
      Write-Host "   ! .vscode is NOT gitignored here - add '.vscode/' to .gitignore so this is not committed." -ForegroundColor Yellow
    }
  }
}

if (-not $DryRun) {
  Write-Host "`nDone. Open each repo in VSCode and your chats reopen automatically." -ForegroundColor Green
  Write-Host "First time per repo, VSCode asks 'Allow automatic tasks in this folder?' - click Allow." -ForegroundColor Green
}
