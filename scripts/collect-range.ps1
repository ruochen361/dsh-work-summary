# collect-range.ps1 —— 收集一个日期区间的"工作痕迹"，供周报/月报聚合引用。
# 用法：
#   pwsh -NoProfile -File collect-range.ps1 -From 2026-11-18 -To 2026-11-24
#   pwsh -NoProfile -File collect-range.ps1 -From 2026-11-01 -To 2026-11-30 -NoSessions
# 输出：<ReportDir>\_源数据\周期-YYYY-MM-DD_YYYY-MM-DD.md（同时打印路径）
# 本脚本属于 dsh-work-summary 插件仓库；扫哪里由 -Workspace 决定，产物写哪由 -ReportDir 决定。
# 与 collect-day.ps1 的分工：单日采集扫工作区/会话；区间采集以已有日报为主，把跨天事实摊平。

param(
  [Parameter(Mandatory = $true)][string]$From,
  [Parameter(Mandatory = $true)][string]$To,
  [string]$DshHome = (Join-Path $HOME '.dsh'),
  [string]$Workspace = (Join-Path $DshHome 'dsh-work-summary'),
  [string]$ReportDir = (Join-Path $DshHome 'dsh-work-summary'),
  [switch]$NoSessions
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try { $fromDay = [datetime]::ParseExact($From, 'yyyy-MM-dd', $null) }
catch { throw "起始日期格式应为 yyyy-MM-dd，收到：$From" }
try { $toDay = [datetime]::ParseExact($To, 'yyyy-MM-dd', $null) }
catch { throw "结束日期格式应为 yyyy-MM-dd，收到：$To" }
if ($toDay -lt $fromDay) { throw "结束日期不能早于起始日期：$From ~ $To" }

$span = ($toDay - $fromDay).Days + 1
if ($span -gt 400) { throw "区间最长 400 天，当前 $span 天：$From ~ $To" }

$rangeEnd = $toDay.AddDays(1)
$days = @()
for ($d = $fromDay; $d -le $toDay; $d = $d.AddDays(1)) { $days += $d.ToString('yyyy-MM-dd') }

$outDir = Join-Path $ReportDir '_源数据'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$outFile = Join-Path $outDir ("周期-{0}_{1}.md" -f $From, $To)

$skipDirs = @('node_modules', '.pnpm-store', '.git', 'dist', 'build', '.next', 'target',
  'temp', 'tmp', '.cache', '__pycache__', '_源数据', '.dsh-vision-router',
  '.dsh', 'anatomy', 'shots', '备份', '_scratch')

function Test-SkipPath([string]$rel) {
  foreach ($seg in ($rel -split '[\\/]')) {
    if ($skipDirs -contains $seg) { return $true }
  }
  return $false
}

$sb = [System.Collections.Generic.List[string]]::new()
function Add-Line([string]$s = '') { $sb.Add($s) }

function Get-Section([string[]]$content, [string]$number) {
  $start = -1
  for ($i = 0; $i -lt $content.Count; $i++) {
    if ($content[$i] -match ('^##\s*' + $number + '\s*[、.．]')) { $start = $i + 1; break }
  }
  if ($start -lt 0) { return @() }
  $out = @()
  for ($i = $start; $i -lt $content.Count; $i++) {
    if ($content[$i] -match '^##\s') { break }
    $out += $content[$i]
  }
  return $out
}

function Get-NonEmpty([string[]]$lines) {
  $out = @()
  foreach ($l in $lines) {
    $t = $l.Trim()
    if ($t -eq '' -or $t -match '^---+$') { continue }
    $out += $t
  }
  return $out
}

function Get-ListItems([string[]]$lines) {
  $out = @()
  foreach ($l in $lines) {
    if ($l -match '^\s*(?:\d+[\.、]|[-*])\s+(.+)$') { $out += $Matches[1].Trim() }
  }
  return $out
}

function Get-AgeDays([string]$text) {
  if ($text -match '^(\d{4}-\d{2}-\d{2})') {
    try {
      $d = [datetime]::ParseExact($Matches[1], 'yyyy-MM-dd', $null)
      $age = ((Get-Date).Date - $d.Date).Days
      if ($age -ge 0) { return $age }
    } catch { }
  }
  return -1
}

function Format-Size([long]$bytes) {
  if ($bytes -ge 1MB) { return ('{0:N1} MB' -f ($bytes / 1MB)) }
  if ($bytes -ge 1KB) { return ('{0:N1} KB' -f ($bytes / 1KB)) }
  return "$bytes B"
}

# ---------- 读取区间内的日报与源数据 ----------
$daily = @{}
$missingDaily = @()
$dailySizes = @{}
foreach ($day in $days) {
  $p = Join-Path $ReportDir "日报-$day.md"
  if (Test-Path $p) {
    $daily[$day] = @(Get-Content $p -Encoding UTF8)
    $dailySizes[$day] = (Get-Item $p).Length
  } else {
    $missingDaily += $day
  }
}

$missingSource = @()
foreach ($day in $days) {
  if (-not (Test-Path (Join-Path $outDir "$day.md"))) { $missingSource += $day }
}

# ---------- 工作区改动 ----------
$files = @()
if (Test-Path $Workspace) {
  $files = Get-ChildItem -Path $Workspace -Recurse -File -Force -ErrorAction SilentlyContinue |
    Where-Object {
      $_.LastWriteTime -ge $fromDay -and $_.LastWriteTime -lt $rangeEnd -and
      -not (Test-SkipPath $_.FullName.Substring($Workspace.Length))
    } | Sort-Object LastWriteTime
}

# ---------- Git 区间提交 ----------
$gitExe = (Get-Command git -ErrorAction SilentlyContinue).Source
$repos = @()
if ($gitExe -and (Test-Path $Workspace)) {
  $repos = Get-ChildItem -Path $Workspace -Directory -Recurse -Depth 3 -Force -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName '.git') } |
    Select-Object -ExpandProperty FullName
}
$gitBlocks = @()
$gitCommitCount = 0
foreach ($repo in $repos) {
  $rel = if ($repo -eq $Workspace) { '.' } else { $repo.Substring($Workspace.Length).TrimStart('\') }
  $log = @(& $gitExe -C $repo log --since="$From 00:00:00" --until="$To 23:59:59" --pretty='%h %ad %s' --date=format:'%m-%d' --no-decorate 2>$null)
  $branch = (& $gitExe -C $repo rev-parse --abbrev-ref HEAD 2>$null)
  $dirty = @(& $gitExe -C $repo status --porcelain 2>$null).Count
  if ($log.Count -gt 0 -or $dirty -gt 0) {
    $gitBlocks += [pscustomobject]@{ Rel = $rel; Branch = $branch; Log = $log; Dirty = $dirty }
    $gitCommitCount += $log.Count
  }
}

# ---------- 看板 ----------
$boardPath = Join-Path $ReportDir '看板.md'
$boardCounts = @{}
$openItems = @()
if (Test-Path $boardPath) {
  $cur = ''
  foreach ($line in (Get-Content $boardPath -Encoding UTF8)) {
    if ($line -match '^##\s*(.+?)\s*$') {
      $cur = $Matches[1]
      if (-not $boardCounts.ContainsKey($cur)) { $boardCounts[$cur] = 0 }
      continue
    }
    if ($line -match '^\s*-\s*\[ \]\s*(.+)$') {
      if ($cur) { $boardCounts[$cur] = [int]$boardCounts[$cur] + 1 }
      $openItems += $Matches[1].Trim()
    }
  }
}
$openTotal = 0
foreach ($v in $boardCounts.Values) { $openTotal += [int]$v }

# ---------- 输出 ----------
Add-Line "# 周期痕迹源数据 · $From ~ $To"
Add-Line ''
Add-Line "> 采集窗口：$From 00:00:00 ~ $To 23:59:59（$span 天，本地时区 $([DateTime]::Now.ToString('zzz'))）"
Add-Line '> 本文件由 `collect-range.ps1` 只读生成，用于周报/月报的事实依据；不要手工编辑。'
Add-Line ''

Add-Line '## 1. 区间概况'
Add-Line ''
Add-Line "- 区间：$From ~ $To（$span 天，含首尾）"
Add-Line "- 日报：有 $(($days.Count - $missingDaily.Count)) 天 / 缺 $($missingDaily.Count) 天"
Add-Line "- 源数据：有 $(($days.Count - $missingSource.Count)) 天 / 缺 $($missingSource.Count) 天"
Add-Line "- 工作区改动：$($files.Count) 个文件"
Add-Line "- Git：$($repos.Count) 个仓库，$gitCommitCount 条提交"
Add-Line "- 看板：未完成 $openTotal 条"
Add-Line ''

Add-Line '## 2. 日报覆盖'
Add-Line ''
if ($daily.Count -eq 0) {
  Add-Line '_区间内没有任何日报。_'
} else {
  foreach ($day in $days) {
    if ($daily.ContainsKey($day)) {
      Add-Line ("- ``日报-$day.md``（{0}）" -f (Format-Size $dailySizes[$day]))
    }
  }
  if ($missingDaily.Count -gt 0) {
    Add-Line ''
    Add-Line ("缺日报 {0} 天：{1}" -f $missingDaily.Count, ($missingDaily -join '、'))
  }
}
Add-Line ''

Add-Line '## 3. 每日概览摘录（一）'
Add-Line ''
if ($daily.Count -eq 0) {
  Add-Line '_无日报可摘。_'
} else {
  foreach ($day in $days) {
    if (-not $daily.ContainsKey($day)) { continue }
    Add-Line "### $day"
    Add-Line ''
    $lines = @(Get-NonEmpty @(Get-Section $daily[$day] '一'))
    if ($lines.Count -eq 0) {
      Add-Line '_该日概览为空。_'
    } else {
      foreach ($l in ($lines | Select-Object -First 10)) { Add-Line "- $l" }
    }
    Add-Line ''
  }
}

Add-Line '## 4. 产出汇总（三）'
Add-Line ''
if ($daily.Count -eq 0) {
  Add-Line '_无日报可摘。_'
} else {
  foreach ($day in $days) {
    if (-not $daily.ContainsKey($day)) { continue }
    Add-Line "### $day"
    Add-Line ''
    $lines = @(Get-NonEmpty @(Get-Section $daily[$day] '三'))
    if ($lines.Count -eq 0) {
      Add-Line '_该日没有产出记录。_'
    } else {
      foreach ($l in ($lines | Select-Object -First 40)) { Add-Line $l }
    }
    Add-Line ''
  }
}

Add-Line '## 5. 问题与风险汇总（四）'
Add-Line ''
if ($daily.Count -eq 0) {
  Add-Line '_无日报可摘。_'
} else {
  foreach ($day in $days) {
    if (-not $daily.ContainsKey($day)) { continue }
    Add-Line "### $day"
    Add-Line ''
    $lines = @(Get-NonEmpty @(Get-Section $daily[$day] '四'))
    if ($lines.Count -eq 0) {
      Add-Line '_该日没有风险记录。_'
    } else {
      foreach ($l in ($lines | Select-Object -First 20)) { Add-Line $l }
    }
    Add-Line ''
  }
}

Add-Line '## 6. 明日开场清单汇总（六）'
Add-Line ''
if ($daily.Count -eq 0) {
  Add-Line '_无日报可摘。_'
} else {
  foreach ($day in $days) {
    if (-not $daily.ContainsKey($day)) { continue }
    $items = @(Get-ListItems @(Get-Section $daily[$day] '六'))
    if ($items.Count -eq 0) { continue }
    Add-Line "### $day"
    Add-Line ''
    foreach ($it in $items) { Add-Line "- $it" }
    Add-Line ''
  }
}

Add-Line '## 7. 工作看板现状'
Add-Line ''
if ($boardCounts.Count -eq 0) {
  Add-Line '_看板为空或不存在。_'
} else {
  $parts = @()
  foreach ($k in @('待办', '进行中', '已完成', '已放弃')) {
    if ($boardCounts.ContainsKey($k)) { $parts += ("{0} {1}" -f $k, $boardCounts[$k]) }
  }
  foreach ($k in $boardCounts.Keys) {
    if (@('待办', '进行中', '已完成', '已放弃') -notcontains $k) { $parts += ("{0} {1}" -f $k, $boardCounts[$k]) }
  }
  Add-Line ("- " + ($parts -join ' / '))
  if ($openItems.Count -gt 0) {
    Add-Line ''
    Add-Line '### 未完成明细（含已挂天数）'
    Add-Line ''
    foreach ($it in ($openItems | Select-Object -First 30)) {
      $age = Get-AgeDays $it
      $tag = if ($age -ge 0) { "已挂 $age 天" } else { '未标日期' }
      Add-Line "- （$tag）$it"
    }
    if ($openItems.Count -gt 30) { Add-Line "- …另有 $($openItems.Count - 30) 条" }
  }
}
Add-Line ''

Add-Line '## 8. Git 区间提交'
Add-Line ''
if (-not $gitExe) {
  Add-Line '_未找到 git，跳过。_'
} elseif ($gitBlocks.Count -eq 0) {
  Add-Line '_区间内没有 Git 提交或未提交改动。_'
} else {
  foreach ($b in $gitBlocks) {
    Add-Line ("### ``{0}``（分支 {1}，当前未提交 {2}）" -f $b.Rel, $b.Branch, $b.Dirty)
    Add-Line ''
    if ($b.Log.Count -gt 0) {
      foreach ($l in ($b.Log | Select-Object -First 80)) { Add-Line "- $l" }
    } else {
      Add-Line '_区间内无提交。_'
    }
    Add-Line ''
  }
}
Add-Line ''

Add-Line '## 9. 工作区区间改动'
Add-Line ''
if ($files.Count -eq 0) {
  Add-Line '_区间内工作区无文件改动。_'
} else {
  Add-Line "共 $($files.Count) 个文件。"
  Add-Line ''
  Add-Line '### 按顶层目录汇总'
  Add-Line ''
  $files | Group-Object { ($_.FullName.Substring($Workspace.Length).TrimStart('\') -split '[\\/]')[0] } |
    Sort-Object Count -Descending |
    ForEach-Object { Add-Line ("- ``{0}``：{1} 个文件" -f $_.Name, $_.Count) }
  Add-Line ''
  Add-Line '### 最近改动的 40 个文件'
  Add-Line ''
  Add-Line '| 时间 | 大小 | 相对路径 |'
  Add-Line '|------|------|----------|'
  $recent = $files | Sort-Object LastWriteTime -Descending | Select-Object -First 40
  foreach ($f in $recent) {
    $rel = $f.FullName.Substring($Workspace.Length).TrimStart('\')
    Add-Line ("| {0:MM-dd HH:mm} | {1} | {2} |" -f $f.LastWriteTime, (Format-Size $f.Length), $rel)
  }
  if ($files.Count -gt 40) { Add-Line ''; Add-Line "- …另有 $($files.Count - 40) 个更早的文件" }
}
Add-Line ''

Add-Line '## 10. 源数据覆盖'
Add-Line ''
if ($missingSource.Count -eq 0) {
  Add-Line '_区间内每天的源数据都在。_'
} else {
  Add-Line ("缺源数据 {0} 天：{1}" -f $missingSource.Count, ($missingSource -join '、'))
}
Add-Line ''

Add-Line '## 11. 复发候选（风险小节跨天重复）'
Add-Line ''
$riskDays = @{}
foreach ($day in $days) {
  if (-not $daily.ContainsKey($day)) { continue }
  foreach ($line in @(Get-ListItems @(Get-Section $daily[$day] '四'))) {
    $key = ($line -replace '^\s*(?:\d+[\.、]|[-*])\s*', '' -replace '[`*]', '' -replace '（[^）]*）', '').Trim()
    # 数字与标点归一化：「第 12 天」「第 13 天」算同一件事
    $key = $key -replace '\d+', '#'
    $key = $key -replace '[\s，。；：、！？,.;:!?（）()【】\[\]「」“”"-]', ''
    if ($key.Length -lt 6) { continue }
    if ($key.Length -gt 40) { $key = $key.Substring(0, 40) + '…' }
    if (-not $riskDays.ContainsKey($key)) { $riskDays[$key] = @() }
    if (-not ($riskDays[$key] -contains $day)) { $riskDays[$key] += $day }
  }
}
$repeat = $riskDays.GetEnumerator() | Where-Object { $_.Value.Count -ge 2 } | Sort-Object { $_.Value.Count } -Descending
if (-not $repeat) {
  Add-Line '_没有跨天重复的风险项。_'
} else {
  foreach ($entry in ($repeat | Select-Object -First 10)) {
    Add-Line ("- {0}：{1} 天（{2}）" -f $entry.Key, $entry.Value.Count, ($entry.Value -join '、'))
  }
}
Add-Line ''

Set-Content -Path $outFile -Value $sb -Encoding UTF8
Write-Output $outFile
