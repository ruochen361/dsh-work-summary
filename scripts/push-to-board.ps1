# push-to-board.ps1 —— 把日报的「明日开场清单」追加到工作看板（看板.md）。
# 纯 Markdown + 复选框，不依赖任何 DSH 插件，可 git 追踪、可手工改。
# 本脚本属于 dsh-work-summary 插件仓库，而看板/日报在数据目录（默认 ~/.dsh/dsh-work-summary），
# 所以脚本不再猜看板位置：-BoardPath 必须显式给出（插件会传）。
#
# 用法：
#   pwsh -NoProfile -File push-to-board.ps1 -BoardPath ~\.dsh\dsh-work-summary\看板.md -Show
#   pwsh -NoProfile -File push-to-board.ps1 -BoardPath ~\.dsh\dsh-work-summary\看板.md -Report ~\.dsh\dsh-work-summary\日报-2026-10-29.md
#   pwsh -NoProfile -File push-to-board.ps1 -BoardPath ... -Report ...\周报-2026-11-18_2026-11-24.md -Section 下周开场
#   pwsh -NoProfile -File push-to-board.ps1 -BoardPath ... -DryRun          # 只解析不写入
#   pwsh -NoProfile -File push-to-board.ps1 -BoardPath ... -Done "git init" # 移到「已完成」
#   pwsh -NoProfile -File push-to-board.ps1 -BoardPath ... -Drop "git init" # 移到「已放弃」
#
# 去重：同一标题（条目取前 36 字）已在看板任意一栏出现时跳过。
# 小节名由 -Section 指定：日报默认「明日开场清单」，周报/月报传「下周开场」「下月开场」。

param(
  [string]$Report,
  [string]$BoardPath,
  [string]$Section = '明日开场清单',
  [string]$Done,
  [string]$Drop,
  [switch]$DryRun,
  [switch]$Show
)

$ErrorActionPreference = 'Stop'
$Today = (Get-Date -Format 'yyyy-MM-dd')
if (-not $BoardPath) {
  throw '缺少 -BoardPath：看板在数据目录（默认 ~\.dsh\dsh-work-summary\看板.md），不在脚本旁边。'
}

function Read-Board {
  if (-not (Test-Path $BoardPath)) {
    return @(
      '# 工作看板', '',
      '> 由 `dsh-work-summary\push-to-board.ps1` 自动追加；手工维护也完全可以。', '',
      '## 待办', '', '## 进行中', '', '## 已完成', ''
    )
  }
  return @(Get-Content $BoardPath -Encoding UTF8)
}

function Get-Hash([string]$s) {
  $norm = ($s -replace '\s', '' -replace '`', '' -replace '\*\*', '')
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($norm)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $hex = ([System.BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLower()
  $sha.Dispose()
  return $hex.Substring(0, 8)
}

function Get-Title([string]$s) {
  $t = ($s -replace '\*\*', '' -replace '`', '').Trim()
  foreach ($sep in '：', '；', '。', '，') {
    $i = $t.IndexOf($sep)
    if ($i -ge 8 -and $i -le 36) { return $t.Substring(0, $i) }
  }
  if ($t.Length -gt 36) { return $t.Substring(0, 36) + '…' }
  return $t
}

function Find-Section([string[]]$lines, [string]$name) {
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match ('^##\s*' + [regex]::Escape($name))) { return $i }
  }
  return -1
}

function Section-End([string[]]$lines, [int]$start) {
  for ($i = $start + 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^##\s') { return $i }
  }
  return $lines.Count
}

function Save-Board([string[]]$lines) {
  $outList = New-Object System.Collections.Generic.List[string]
  foreach ($l in $lines) {
    if ($l.Trim() -eq '' -and $outList.Count -gt 0 -and $outList[$outList.Count - 1].Trim() -eq '') { continue }
    $outList.Add($l)
  }
  while ($outList.Count -gt 0 -and $outList[$outList.Count - 1].Trim() -eq '') { $outList.RemoveAt($outList.Count - 1) }
  $outList.Add('')
  Set-Content -Path $BoardPath -Value $outList -Encoding UTF8
}

$board = Read-Board

if ($Show) { $board | ForEach-Object { Write-Output $_ }; return }

# ---------- -Done / -Drop：把匹配的待办移到「已完成」/「已放弃」 ----------
$mode = if ($Drop) { 'drop' } elseif ($Done) { 'done' } else { $null }
if ($mode) {
  $keyword = if ($mode -eq 'drop') { $Drop } else { $Done }
  $targetSection = if ($mode -eq 'drop') { '已放弃' } else { '已完成' }
  $todoIdx = Find-Section $board '待办'
  if ($todoIdx -lt 0) { throw "看板缺少「## 待办」小节：$BoardPath" }
  $todoEnd = Section-End $board $todoIdx

  $kept = @(); $moved = @()
  for ($i = 0; $i -lt $board.Count; $i++) {
    $inTodo = ($i -gt $todoIdx -and $i -lt $todoEnd)
    if ($inTodo -and $board[$i] -match '^\s*-\s*\[ \]' -and $board[$i].Contains($keyword)) {
      $body = ($board[$i] -replace '^\s*-\s*\[ \]\s*', '').Trim()
      if ($mode -eq 'drop') { $moved += ('- ⛔ {0}（放弃 {1}）' -f $body, $Today) }
      else { $moved += ('- [x] {0}（完成 {1}）' -f $body, $Today) }
      while ($i + 1 -lt $todoEnd -and $board[$i + 1] -match '^\s{2,}\S') { $i++ }
      continue
    }
    $kept += $board[$i]
  }

  if ($moved.Count -eq 0) { Write-Output ("「待办」里没有包含「{0}」的条目。" -f $keyword); return }
  if ($DryRun) {
    Write-Output ("DryRun：将处理 {0} 条：" -f $moved.Count)
    $moved | ForEach-Object { Write-Output $_ }
    return
  }

  $doneIdx = Find-Section $kept $targetSection
  if ($doneIdx -lt 0) {
    if ($kept.Count -gt 0 -and $kept[-1].Trim() -ne '') { $kept += '' }
    $kept += ('## ' + $targetSection)
    $doneIdx = $kept.Count - 1
  }

  $out = @()
  $out += $kept[0..$doneIdx]
  $tail = @()
  if ($doneIdx + 1 -lt $kept.Count) { $tail = @($kept[($doneIdx + 1)..($kept.Count - 1)]) }
  # 去掉紧跟标题的空行，再统一补一个空行，避免出现连续空行
  while ($tail.Count -gt 0 -and $tail[0].Trim() -eq '') { $tail = @($tail[1..($tail.Count - 1)]) }
  $out += ''
  $out += $moved
  if ($tail.Count -gt 0) { $out += $tail }

  Save-Board $out
  $verb = if ($mode -eq 'drop') { '已放弃' } else { '已标记完成' }
  Write-Output ("{0} {1} 条：" -f $verb, $moved.Count)
  $moved | ForEach-Object { Write-Output $_ }
  return
}

# ---------- 从日报/周报解析指定小节（默认「明日开场清单」） ----------
if (-not $Report) {
  $Report = (Get-ChildItem (Split-Path -Parent $BoardPath) -Filter '日报-*.md' -File |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
}
if (-not $Report -or -not (Test-Path $Report)) { throw "找不到日报文件：$Report" }

$lines = Get-Content $Report -Encoding UTF8
$start = -1
$sectionPattern = '^##\s.*' + [regex]::Escape($Section)
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match $sectionPattern) { $start = $i + 1; break }
}
if ($start -lt 0) { throw "日报里没有「$Section」小节：$Report" }

$items = @()
for ($i = $start; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match '^##\s') { break }
  if ($lines[$i] -match '^\s*(?:\d+[\.、]|[-*])\s+(.+)$') {
    $t = $Matches[1].Trim()
    # 以 ✅ 开头或标注「已完成」的条目视为已办，不进看板
    if ($t -notmatch '^(✅|\[x\])' -and $t -notmatch '已完成') { $items += $t }
  }
}
if ($items.Count -eq 0) { throw "「$Section」里没有解析到条目：$Report" }

Write-Output ("解析到 {0} 条待办：来自 {1}" -f $items.Count, $Report)
foreach ($it in $items) { Write-Output ('  - ' + $it) }

# ---------- 去重：同时比对「详情指纹」与「标题指纹」 ----------
function Get-TitleOfLine([string]$line) {
  $parts = $line -split '｜'
  if ($parts.Count -ge 2) { return $parts[1].Trim() }
  return ''
}

# 只在「## 待办」里查重：已完成/已放弃的条目允许再次进入待办（是新的待办，不是重复）
$existing = @{}
$todoStart = Find-Section $board '待办'
$todoEndIdx = if ($todoStart -ge 0) { Section-End $board $todoStart } else { 0 }
for ($i = 0; $i -lt $board.Count; $i++) {
  if ($todoStart -lt 0 -or $i -le $todoStart -or $i -ge $todoEndIdx) { continue }
  $l = $board[$i]
  if ($l -notmatch '^\s*-\s*\[ \]') { continue }
  $tk = Get-TitleOfLine $l
  if ($tk) { $existing[(Get-Hash $tk)] = $true }
  if ($l -match '#h([0-9a-f]{8})') { $existing[$Matches[1]] = $true; continue }
  # 兼容手写/旧格式条目：用紧随其后的「详情：」行（或条目正文）算指纹
  $src2 = $l
  if ($i + 1 -lt $board.Count -and $board[$i + 1] -match '^\s{2,}-\s*详情：(.+)$') { $src2 = $Matches[1] }
  $existing[(Get-Hash $src2)] = $true
}

$newLines = @(); $added = 0; $skipped = @()
$src = Split-Path $Report -Leaf
foreach ($it in $items) {
  $title = Get-Title $it
  $hash = Get-Hash $it
  $tkey = Get-Hash $title
  if ($existing.ContainsKey($hash) -or $existing.ContainsKey($tkey)) { $skipped += $title; continue }
  $newLines += ('- [ ] {0} ｜ {1} ｜ 来源：{2} ｜ #h{3}' -f $Today, $title, $src, $hash)
  $newLines += ('  - 详情：{0}' -f $it)
  $existing[$hash] = $true
  $existing[$tkey] = $true
  $added++
}

if ($added -eq 0) { Write-Output ("已写入 0 条，跳过重复 {0} 条 → {1}" -f $skipped.Count, $BoardPath); return }
if ($DryRun) {
  Write-Output ("DryRun：将写入 {0} 条：" -f $added)
  $newLines | ForEach-Object { Write-Output $_ }
  return
}

# ---------- 插入到「## 待办」末尾 ----------
$todoIdx = Find-Section $board '待办'
if ($todoIdx -lt 0) { throw "看板缺少「## 待办」小节：$BoardPath" }
$todoEnd = Section-End $board $todoIdx

$insertAt = $todoEnd
while ($insertAt -gt $todoIdx + 1 -and $board[$insertAt - 1].Trim() -eq '') { $insertAt-- }

$out = @()
if ($insertAt -gt 0) { $out += $board[0..($insertAt - 1)] }
# 待办为空时插在标题正下方，补一个空行保持 Markdown 结构
if ($out.Count -gt 0 -and $out[-1] -match '^##\s') { $out += '' }
$out += $newLines
if ($insertAt -lt $board.Count) { $out += $board[$insertAt..($board.Count - 1)] }

Save-Board $out
Write-Output ("已写入 {0} 条，跳过重复 {1} 条 → {2}" -f $added, $skipped.Count, $BoardPath)
if ($skipped.Count -gt 0) { foreach ($s in $skipped) { Write-Output ('  跳过：' + $s) } }
