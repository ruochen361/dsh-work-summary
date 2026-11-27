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
  [int]$StallDays = 3,
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

# 投入统计的展示格式，与 collect-day.ps1 保持一致。
function Format-Duration([long]$ms) {
  if ($ms -le 0) { return '0m' }
  $m = [int][Math]::Floor($ms / 60000 + 0.5)
  if ($m -lt 1) { return '<1m' }
  if ($m -lt 60) { return "${m}m" }
  return ('{0}h{1:00}m' -f [int][Math]::Floor($m / 60), ($m % 60))
}

function Format-TokenCount([long]$n) {
  $inv = [System.Globalization.CultureInfo]::InvariantCulture
  if ($n -ge 999950) { return [string]::Format($inv, '{0:0.0}M', $n / 1000000.0) }
  if ($n -ge 1000) { return [string]::Format($inv, '{0:0.0}K', $n / 1000.0) }
  return "$n"
}

function Format-Percent([double]$value) {
  return [string]::Format([System.Globalization.CultureInfo]::InvariantCulture, '{0:0.0}%', $value)
}

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

# ---------- 投入（token / 时间）：读各日源数据里的 dsh-usage 注释 ----------
# 单日内部已经做过会话并集，所以区间直接按天相加；旧源数据没有这一节就标缺，提示重新采集。
$usageDays = @{}
foreach ($day in $days) {
  $p = Join-Path $outDir "$day.md"
  if (-not (Test-Path $p)) { continue }
  foreach ($line in (Get-Content $p -Encoding UTF8)) {
    if ($line -match '^<!--\s*dsh-usage\s+(\{.*\})\s*-->\s*$') {
      try { $usageDays[$day] = $Matches[1] | ConvertFrom-Json } catch { }
      break
    }
  }
}
$usageMissing = @($days | Where-Object { -not $usageDays.ContainsKey($_) })

$uSessions = [long]0; $uActive = [long]0; $uModel = [long]0; $uTool = [long]0; $uWait = [long]0
$uInput = [long]0; $uCache = [long]0; $uOutput = [long]0; $uTotal = [long]0
$uByWs = @{}
$uWsOrder = [System.Collections.Generic.List[string]]::new()
foreach ($day in ($usageDays.Keys | Sort-Object)) {
  $u = $usageDays[$day]
  $uSessions += [long]$u.sessions
  $uActive += [long]$u.activeMs
  $uModel += [long]$u.modelMs
  $uTool += [long]$u.toolMs
  $uWait += [long]$u.waitMs
  $uInput += [long]$u.input
  $uCache += [long]$u.cache
  $uOutput += [long]$u.output
  $uTotal += [long]$u.total
  foreach ($w in @($u.byWorkspace)) {
    $key = if ($w.path) { ([string]$w.path).ToLowerInvariant() } else { [string]$w.name }
    if (-not $uByWs.ContainsKey($key)) {
      $uByWs[$key] = [pscustomobject]@{
        Name = [string]$w.name; Path = [string]$w.path; Sessions = [long]0
        ActiveMs = [long]0; ModelMs = [long]0; ToolMs = [long]0; WaitMs = [long]0
        Input = [long]0; Cache = [long]0; Output = [long]0; Total = [long]0
      }
      $uWsOrder.Add($key)
    }
    $g = $uByWs[$key]
    $g.Sessions += [long]$w.sessions
    $g.ActiveMs += [long]$w.activeMs
    $g.ModelMs += [long]$w.modelMs
    $g.ToolMs += [long]$w.toolMs
    $g.WaitMs += [long]$w.waitMs
    $g.Input += [long]$w.input
    $g.Cache += [long]$w.cache
    $g.Output += [long]$w.output
    $g.Total += [long]$w.total
  }
}
$uRows = @($uWsOrder | ForEach-Object { $uByWs[$_] } |
  Sort-Object -Property @{ Expression = 'ActiveMs'; Descending = $true })
$uDenom = $uInput + $uCache
$uHit = if ($uDenom -gt 0) { $uCache / $uDenom * 100 } else { 0 }

# ---------- 主线：日报里的小节 + _主线.md 账本 ----------
# 主线是「一次完整交付」，ID 形如 M-YYYY-MM-DD-NN；日报小节给工作区/状态/判据，
# 账本补首次与最近产出，所以两边要合起来看。
$mainlines = @{}
$mainlineOrder = @()

function Get-Mainline([string]$id) {
  if (-not $script:mainlines.ContainsKey($id)) {
    $script:mainlines[$id] = [pscustomobject]@{
      Id = $id; Title = ''; Workspace = ''; Status = '进行中'
      First = ''; Last = ''; Days = @()
      CriteriaDone = 0; CriteriaTotal = 0; TextTotal = 0
    }
    $script:mainlineOrder += $id
  }
  return $script:mainlines[$id]
}

foreach ($day in $days) {
  if (-not $daily.ContainsKey($day)) { continue }
  $cur = $null
  foreach ($raw in $daily[$day]) {
    $line = $raw.Trim()
    if ($line -match '^####\s+(M-\d{4}-\d{2}-\d{2}-\d{2})\s*(.*)$') {
      $cur = Get-Mainline $Matches[1]
      if ($Matches[2].Trim()) { $cur.Title = $Matches[2].Trim() }
      if (-not ($cur.Days -contains $day)) { $cur.Days += $day }
      continue
    }
    if ($line -match '^#{1,5}\s') { $cur = $null; continue }
    if (-not $cur) { continue }
    if ($line -match '^-\s*工作区\s*[：:]\s*(.+)$') { $cur.Workspace = $Matches[1].Trim().Trim('`') }
    elseif ($line -match '^-\s*状态\s*[：:]\s*(.+)$') { $cur.Status = $Matches[1].Trim() }
    elseif ($line -match '^-\s*\[( |x|X)\]\s*(.+)$') {
      $cur.CriteriaTotal = [int]$cur.CriteriaTotal + 1
      if ($Matches[1] -ne ' ') { $cur.CriteriaDone = [int]$cur.CriteriaDone + 1 }
    } elseif ($line -match '^-\s*判据\s*[：:]\s*(.+)$') {
      foreach ($part in ($Matches[1] -split '[；;]')) {
        if ($part.Trim()) { $cur.TextTotal = [int]$cur.TextTotal + 1 }
      }
    }
  }
}

$ledgerPath = Join-Path $ReportDir '_主线.md'
if (Test-Path $ledgerPath) {
  $cur = $null
  foreach ($raw in (Get-Content $ledgerPath -Encoding UTF8)) {
    $line = $raw.Trim()
    if ($line -match '^##\s+(M-\d{4}-\d{2}-\d{2}-\d{2})\s*(.*)$') {
      $cur = Get-Mainline $Matches[1]
      if ($Matches[2].Trim()) { $cur.Title = $Matches[2].Trim() }
      continue
    }
    if (-not $cur) { continue }
    if ($line -match '^-\s*工作区\s*[：:]\s*(.+)$') { if (-not $cur.Workspace) { $cur.Workspace = $Matches[1].Trim().Trim('`') } }
    elseif ($line -match '^-\s*状态\s*[：:]\s*(.+)$') { $cur.Status = $Matches[1].Trim() }
    elseif ($line -match '^-\s*首次产出\s*[：:]\s*(.+)$') { $cur.First = $Matches[1].Trim() }
    elseif ($line -match '^-\s*最近产出\s*[：:]\s*(.+)$') { $cur.Last = $Matches[1].Trim() }
    elseif ($line -match '^-\s*\[( |x|X)\]\s*(.+)$') {
      $cur.CriteriaTotal = [int]$cur.CriteriaTotal + 1
      if ($Matches[1] -ne ' ') { $cur.CriteriaDone = [int]$cur.CriteriaDone + 1 }
    }
  }
}

$mainlineRows = @()
foreach ($id in $mainlineOrder) {
  # 区间结束后才出现的主线不能倒灌进历史周期。
  if ($id.Substring(2, 10) -gt $To) { continue }
  $m = $mainlines[$id]
  $first = $m.First
  $last = $m.Last
  foreach ($d in $m.Days) {
    if (-not $first -or $d -lt $first) { $first = $d }
    if (-not $last -or $d -gt $last) { $last = $d }
  }
  if (-not $first) { $first = $last }
  if (-not $last) { $last = $first }
  # 手工改过的账本可能写 `—` 或带说明；非日期一律当没写，避免后面 Substring 抛错。
  if ($first -and $first -notmatch '^\d{4}-\d{2}-\d{2}$') { $first = '' }
  if ($last -and $last -notmatch '^\d{4}-\d{2}-\d{2}$') { $last = '' }
  if (-not $first) { $first = $last }
  if (-not $last) { $last = $first }
  if ($first -gt $To) { continue }
  $touched = $m.Days.Count -gt 0
  $open = $m.Status -notin @('完成', '放弃')
  if (-not $open -and -not $touched) { continue }
  $stall = 0
  if ($last) {
    try { $stall = ($toDay - [datetime]::ParseExact($last, 'yyyy-MM-dd', $null)).Days }
    catch { $stall = 0 }
    if ($stall -lt 0) { $stall = 0 }
  }
  $status = $m.Status
  if ($open -and $stall -ge $StallDays) { $status = '受阻' }
  $critTotal = $m.CriteriaTotal
  if ($critTotal -eq 0 -and $m.TextTotal -gt 0) { $critTotal = $m.TextTotal }
  $mainlineRows += [pscustomobject]@{
    Id = $id; Title = $m.Title; Workspace = $m.Workspace; Status = $status
    First = $first; Last = $last; Stall = $stall
    CriteriaDone = $m.CriteriaDone; CriteriaTotal = $critTotal
    Touched = $touched
  }
}

# 工作区别名：_工作区.md 的「## 别名」段，`- <路径> = <名字>`。
$aliasMap = @{}
$wsDoc = Join-Path $ReportDir '_工作区.md'
if (Test-Path $wsDoc) {
  $inAlias = $false
  $inComment = $false
  foreach ($line in (Get-Content $wsDoc -Encoding UTF8)) {
    $trimmed = $line.Trim()
    # 跳过 <!-- … --> 块注释，注释里的示例不能被当成真实别名。
    if ($inComment) {
      if ($trimmed -match '-->') { $inComment = $false }
      continue
    }
    if ($trimmed -match '^<!--') { $inComment = $true; continue }
    if ($line -match '^##\s*别名') { $inAlias = $true; continue }
    if ($line -match '^##\s') { $inAlias = $false; continue }
    if ($inAlias -and $line -match '^\s*-\s*(.+?)\s*=\s*(.+?)\s*$') {
      $aliasMap[$Matches[1].Trim().Trim('`').ToLower()] = $Matches[2].Trim()
    }
  }
}
function Format-Workspace([string]$path) {
  if (-not $path) { return '（未标工作区）' }
  $firstPath = ($path -split '[,，]')[0].Trim()
  if ($aliasMap.ContainsKey($firstPath.ToLower())) { return $aliasMap[$firstPath.ToLower()] }
  $leaf = Split-Path $firstPath -Leaf
  if ($leaf) { return $leaf }
  return $firstPath
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
$openMainlines = @($mainlineRows | Where-Object { $_.Status -notmatch '完成|放弃' })
Add-Line "- 主线：$($mainlineRows.Count) 条（未清 $($openMainlines.Count) 条）"
if ($usageDays.Count -eq 0) {
  Add-Line '- 投入：区间内没有 token/时间数据（源数据未含投入节，重新采集该日即可补上）'
} else {
  Add-Line ("- 投入：活跃 {0} · 模型 {1} · 工具 {2} · 等你确认 {3}（覆盖 {4}/{5} 天）" -f
    (Format-Duration $uActive), (Format-Duration $uModel), (Format-Duration $uTool),
    (Format-Duration $uWait), $usageDays.Count, $days.Count)
  Add-Line ("- Token：合计 {0}（新输入 {1} / 缓存读 {2} / 输出 {3}，缓存命中 {4}）" -f
    (Format-TokenCount $uTotal), (Format-TokenCount $uInput), (Format-TokenCount $uCache),
    (Format-TokenCount $uOutput), (Format-Percent $uHit))
}
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

Add-Line '## 12. 主线（区间）'
Add-Line ''
if ($mainlineRows.Count -eq 0) {
  Add-Line '_区间内日报没有主线小节，`_主线.md` 也没有未清条目。_'
} else {
  Add-Line '按工作区分组；「本期未推进」是账本里有、但区间日报没有小节的未清主线。'
  Add-Line ''
  $groups = $mainlineRows | Group-Object { Format-Workspace $_.Workspace } | Sort-Object Name
  foreach ($group in $groups) {
    Add-Line "### $($group.Name)"
    Add-Line ''
    foreach ($row in ($group.Group | Sort-Object First, Id)) {
      $firstText = if ($row.First) { $row.First.Substring(5) } else { '—' }
      $lastText = if ($row.Last) { $row.Last.Substring(5) } else { '—' }
      $span = if ($firstText -ne '—' -and $firstText -eq $lastText) { $firstText } else { "$firstText → $lastText" }
      $parts = @($row.Status)
      if ($row.CriteriaTotal -gt 0) { $parts += ("判据 {0}/{1}" -f $row.CriteriaDone, $row.CriteriaTotal) }
      if ($row.Stall -gt 0) { $parts += ("挂起 {0} 天" -f $row.Stall) }
      if (-not $row.Touched) { $parts += '本期未推进' }
      Add-Line ("- {0} {1}：{2}（{3}）" -f $row.Id, $row.Title, $span, ($parts -join '，'))
    }
    Add-Line ''
  }
}

Add-Line '## 13. 投入（token / 时间，区间）'
Add-Line ''
if ($usageDays.Count -eq 0) {
  Add-Line '_区间源数据都没有投入节；重新采集这些日期即可补上。_'
} else {
  Add-Line ("**投入：** 会话·日 {0} 个 · 活跃 {1} · 模型 {2} · 工具 {3} · 等你确认 {4}" -f
    $uSessions, (Format-Duration $uActive), (Format-Duration $uModel),
    (Format-Duration $uTool), (Format-Duration $uWait))
  Add-Line ("**Token：** 合计 {0}（新输入 {1} / 缓存读 {2} / 输出 {3}，缓存命中 {4}）" -f
    (Format-TokenCount $uTotal), (Format-TokenCount $uInput), (Format-TokenCount $uCache),
    (Format-TokenCount $uOutput), (Format-Percent $uHit))
  Add-Line ''
  Add-Line '| 工作区 | 会话·日 | 活跃 | 模型 | 工具 | 等你确认 | Token | 缓存读 | 命中 |'
  Add-Line '|---|---|---|---|---|---|---|---|---|'
  foreach ($row in $uRows) {
    $denom = $row.Input + $row.Cache
    $hit = if ($denom -gt 0) { $row.Cache / $denom * 100 } else { 0 }
    Add-Line ("| {0} | {1} | {2} | {3} | {4} | {5} | {6} | {7} | {8} |" -f
      $row.Name, $row.Sessions, (Format-Duration $row.ActiveMs), (Format-Duration $row.ModelMs),
      (Format-Duration $row.ToolMs), (Format-Duration $row.WaitMs), (Format-TokenCount $row.Total),
      (Format-TokenCount $row.Cache), (Format-Percent $hit))
  }
  Add-Line ''
  Add-Line ("- 覆盖：{0}/{1} 天有投入数据；跳过 {2} 天（旧源数据没有该节，重新采集即可补上）。" -f
    $usageDays.Count, $days.Count, $usageMissing.Count)
  if ($usageMissing.Count -gt 0) {
    $preview = @($usageMissing | Select-Object -First 12)
    $suffix = if ($usageMissing.Count -gt 12) { ' …' } else { '' }
    Add-Line ("- 缺投入的日期：{0}{1}" -f ($preview -join '、'), $suffix)
  }
  Add-Line '- 口径：同每日源数据 3.5 节；区间按天相加，单日内部已完成会话并集。'
  $rangeJson = [ordered]@{
    sessions = $uSessions
    activeMs = $uActive
    modelMs = $uModel
    toolMs = $uTool
    waitMs = $uWait
    input = $uInput
    cache = $uCache
    output = $uOutput
    total = $uTotal
    days = $days.Count
    daysWithUsage = $usageDays.Count
    byWorkspace = @($uRows | ForEach-Object {
      [ordered]@{
        name = $_.Name; path = $_.Path; sessions = $_.Sessions
        activeMs = $_.ActiveMs; modelMs = $_.ModelMs; toolMs = $_.ToolMs; waitMs = $_.WaitMs
        input = $_.Input; cache = $_.Cache; output = $_.Output; total = $_.Total
      }
    })
  }
  Add-Line ('<!-- dsh-usage-range ' + ($rangeJson | ConvertTo-Json -Compress -Depth 5) + ' -->')
}

Set-Content -Path $outFile -Value $sb -Encoding UTF8
Write-Output $outFile
