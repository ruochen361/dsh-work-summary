# collect-day.ps1 —— 收集某一天的"工作痕迹"，输出一份源数据 Markdown，供日报总结引用。
# 用法：
#   pwsh -NoProfile -File collect-day.ps1              # 今天
#   pwsh -NoProfile -File collect-day.ps1 -Date 2026-10-28
#   pwsh -NoProfile -File collect-day.ps1 -NoSessions  # 跳过会话解析（更快）
# 输出：<ReportDir>\_源数据\YYYY-MM-DD.md（同时打印路径）
# 本脚本属于 dsh-work-summary 插件仓库；扫哪些工作区由 DSH 会话自动发现，产物写哪由 -ReportDir 决定。
# 默认数据根是 ~/.dsh/dsh-work-summary（插件激活时创建），插件调用时会把参数显式传进来。
#
# 工作区规则（R29）：
#   - 从 ~/.dsh/sessions 里近两天（D-1、D 两个日历日）有活动的会话 cwd 自动发现；
#   - junction / 符号链接先解析成真实路径再去重；
#   - _工作区.md 里可以写「别名」与「忽略」，首次运行自动生成；
#   - 不要求 .git / AGENTS.md / package.json，任何存在的工作目录都算；
#   - 最多列 12 个工作区、每个工作区最多列 400 个改动文件、12 个 Git 仓库。

param(
  [string]$Date = (Get-Date -Format 'yyyy-MM-dd'),
  [string]$DshHome = (Join-Path $HOME '.dsh'),
  [string]$Workspace = '',
  [string]$ReportDir = (Join-Path $DshHome 'dsh-work-summary'),
  [int]$StallDays = 3,
  [switch]$NoSessions
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try { $day = [datetime]::ParseExact($Date, 'yyyy-MM-dd', $null) }
catch { throw "日期格式应为 yyyy-MM-dd，收到：$Date" }

$dayStart = $day
$dayEnd = $day.AddDays(1)
# 工作区发现按日历日算：昨天与今天两个完整自然日，凌晨跑也不会漏掉跨零点的会话。
$windowStart = $dayStart.AddDays(-1)
$startMs = [DateTimeOffset]::new($dayStart).ToUnixTimeMilliseconds()
$endMs = [DateTimeOffset]::new($dayEnd).ToUnixTimeMilliseconds()
$sinceArg = $dayStart.ToString('yyyy-MM-dd HH:mm:ss')
$untilArg = $dayEnd.ToString('yyyy-MM-dd HH:mm:ss')

$outDir = Join-Path $ReportDir '_源数据'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$outFile = Join-Path $outDir "$Date.md"

$maxWorkspaces = 12
$maxFilesPerWorkspace = 400
$maxReposPerWorkspace = 12
# 目录遍历上限：防止把整个用户目录或误配的盘符根扫穿；到顶就停，并在第 1 节注明。
$maxDirsPerWorkspace = 20000

# 投入统计口径（R35）：
#   - 活跃时长：会话事件按时间排序，相邻间隔超过 5 分钟视为离开，超出部分不计；
#   - 工具耗时：tool/call → tool/result 配对，单次最多计 10 分钟，防止一条挂住的命令吃掉整天；
#   - 等你确认：交互型工具的耗时本质是等你回话，单列，不混进工具耗时。
$idleCapMs = 5 * 60 * 1000
$toolCapMs = 10 * 60 * 1000
$waitTools = @('ask_user_question', 'plugin_manager')
# 会话里 assistant/message.usage 的字段名（DSH v4 会话格式）。
# token 以消息落盘时记录的 usage 为准：失败的尝试没有 usage，不计入，口径见源数据脚注。

$skipDirs = @('node_modules', '.pnpm-store', '.git', 'dist', 'build', '.next', 'target',
  'temp', 'tmp', '.cache', '__pycache__', '_源数据', '.dsh-vision-router',
  # 第三方资产/工具目录：装技能、跑示例产生的海量文件不该进日报
  '.dsh', 'anatomy', 'shots', '备份',
  # 临时/调试文件专区：一次性脚本与中间产物不算工作产出
  '_scratch')

function Test-SkipName([string]$name) {
  return ($skipDirs -contains $name)
}

$sb = [System.Collections.Generic.List[string]]::new()
function Add-Line([string]$s = '') { $sb.Add($s) }

# ---------- 工作区配置：_工作区.md ----------
$wsConfigPath = Join-Path $ReportDir '_工作区.md'

function Initialize-WorkspaceConfig {
  if (Test-Path -LiteralPath $wsConfigPath) { return }
  Set-Content -LiteralPath $wsConfigPath -Encoding UTF8 -Value @(
    '# 工作区'
    ''
    '> 工作区由 `collect-day.ps1` 从近两天有活动的 DSH 会话自动发现，一般不用手工维护。'
    '> 这里只放两类修正：改显示名的「别名」，和不该进日报的「忽略」目录（含其子目录）。'
    ''
    '## 别名'
    ''
    '<!-- 一行一个：- 绝对路径 = 显示名。例：'
    '- F:\novel = 小说'
    '-->'
    ''
    '## 忽略'
    ''
    '<!-- 一行一个：- 绝对路径。例：'
    '- C:\Users\me\AppData\Local\Temp'
    '-->'
  )
}

function Get-WorkspaceConfig {
  $cfg = @{ Aliases = @{}; Ignores = [System.Collections.Generic.List[string]]::new() }
  if (-not (Test-Path -LiteralPath $wsConfigPath)) { return $cfg }
  $section = ''
  $inComment = $false
  foreach ($line in (Get-Content -LiteralPath $wsConfigPath -Encoding UTF8)) {
    $trimmed = $line.Trim()
    # 跳过 <!-- … --> 块注释：模板里的示例路径不能被当成真实别名/忽略。
    if ($inComment) {
      if ($trimmed -match '-->') { $inComment = $false }
      continue
    }
    if ($trimmed -match '^<!--') { $inComment = $true; continue }
    if ($line -match '^##\s*(.+?)\s*$') {
      $section = switch -Regex ($Matches[1]) {
        '^别名' { 'alias' }
        '^忽略' { 'ignore' }
        default { '' }
      }
      continue
    }
    if ($section -eq 'alias' -and $line -match '^\s*-\s*(.+?)\s*=\s*(.+?)\s*$') {
      $p = ConvertTo-NormalPath $Matches[1]
      if ($p) { $cfg.Aliases[$p.ToLowerInvariant()] = $Matches[2] }
    } elseif ($section -eq 'ignore' -and $line -match '^\s*-\s*(.+?)\s*$') {
      $p = ConvertTo-NormalPath $Matches[1]
      if ($p) { $cfg.Ignores.Add($p) }
    }
  }
  return $cfg
}

function ConvertTo-NormalPath([string]$p) {
  if (-not $p) { return $null }
  $p = $p.Trim().Trim('"').Trim("'")
  if (-not $p) { return $null }
  try { $full = [IO.Path]::GetFullPath($p) } catch { return $null }
  return $full.TrimEnd('\')
}

# junction / 符号链接解析成真实路径，最多 5 层，避免环。
function Resolve-RealPath([string]$p) {
  $cur = ConvertTo-NormalPath $p
  if (-not $cur) { return $null }
  for ($i = 0; $i -lt 5; $i++) {
    $item = Get-Item -LiteralPath $cur -Force -ErrorAction SilentlyContinue
    if (-not $item) { break }
    if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { break }
    $target = $item.Target
    if ($target -is [array]) { $target = $target[0] }
    if (-not $target) { break }
    if (-not [IO.Path]::IsPathRooted($target)) {
      $target = Join-Path (Split-Path -Parent $cur) $target
    }
    $next = ConvertTo-NormalPath $target
    if (-not $next -or $next -eq $cur) { break }
    $cur = $next
  }
  return $cur
}

function Test-PathUnder([string]$path, [string]$root) {
  if (-not $path -or -not $root) { return $false }
  $p = $path.TrimEnd('\').ToLowerInvariant()
  $r = $root.TrimEnd('\').ToLowerInvariant()
  return ($p -eq $r -or $p.StartsWith($r + '\'))
}

$wsConfig = Get-WorkspaceConfig

$defaultIgnores = @(
  (Join-Path $HOME '.dsh'),
  (Join-Path $HOME 'AppData'),
  $ReportDir,
  $env:TEMP,
  $env:WINDIR,
  ${env:ProgramFiles},
  ${env:ProgramFiles(x86)},
  $env:ProgramData
) | Where-Object { $_ } | ForEach-Object { ConvertTo-NormalPath $_ } | Where-Object { $_ }

# 家目录本身不扫（整个 profile 太大），但家目录下的项目照常发现；AppData 已经在 $defaultIgnores 里整棵跳过。
$exactIgnores = @($HOME) | Where-Object { $_ } | ForEach-Object { ConvertTo-NormalPath $_ } | Where-Object { $_ }

function Test-IgnoredWorkspace([string]$path) {
  # 盘符根（F:\）不扫，递归整块盘没有意义。
  $parent = Split-Path -Parent $path
  if (-not $parent) { return '盘符根目录' }
  $lower = $path.TrimEnd('\').ToLowerInvariant()
  foreach ($root in $exactIgnores) {
    if ($lower -eq $root.TrimEnd('\').ToLowerInvariant()) { return "忽略（$root）" }
  }
  foreach ($root in ($wsConfig.Ignores + $defaultIgnores)) {
    if (Test-PathUnder $path $root) { return "忽略（$root）" }
  }
  return $null
}

# ---------- 会话解析 ----------
# 近两天有活动的会话都读一遍：工作区发现与第 3 节共用这份结果，避免重复解压。

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

# 事件间隔封顶后切成区间，多会话取并集才不会被并行会话重复计时。
function Get-ActiveIntervals($points) {
  $list = [System.Collections.Generic.List[object]]::new()
  $arr = @($points | Sort-Object -Unique)
  for ($i = 0; $i -lt $arr.Count - 1; $i++) {
    $a = [long]$arr[$i]
    $b = [long]$arr[$i + 1]
    if ($b -le $a) { continue }
    $span = [Math]::Min($b - $a, $idleCapMs)
    $list.Add([pscustomobject]@{ Start = $a; End = $a + $span })
  }
  return ,$list
}

function Merge-IntervalMs($intervals) {
  $arr = @($intervals | Sort-Object Start)
  $merged = [System.Collections.Generic.List[object]]::new()
  foreach ($iv in $arr) {
    if ($merged.Count -gt 0 -and $iv.Start -le $merged[-1].End) {
      if ($iv.End -gt $merged[-1].End) { $merged[-1].End = $iv.End }
    } else {
      $merged.Add([pscustomobject]@{ Start = $iv.Start; End = $iv.End })
    }
  }
  $sum = [long]0
  foreach ($m in $merged) { $sum += ($m.End - $m.Start) }
  return $sum
}

function Read-SessionInfo($file) {
  $zstd = (Get-Command zstd -ErrorAction SilentlyContinue).Source
  if (-not $zstd) { $zstd = 'C:\Program Files\poppler\Library\bin\zstd.exe' }
  $info = [pscustomobject]@{
    File       = $file
    DirName    = $file.Directory.Parent.Name
    Cwd        = $null
    Title      = $null
    Users      = [System.Collections.Generic.List[string]]::new()
    LastReply  = $null
    ToolToday  = 0
    ToolWindow = 0
    ToolNames  = @{}
    Today      = ($file.LastWriteTime -ge $dayStart -and $file.LastWriteTime -lt $dayEnd)
    Error      = $null
    # 投入统计（R35）
    TokensIn     = [long]0
    TokensOut    = [long]0
    TokensCache  = [long]0
    TokensTotal  = [long]0
    Messages     = 0
    ModelMs      = [long]0
    ToolMs       = [long]0
    WaitMs       = [long]0
    ToolCallN    = 0
    ActivePoints = [System.Collections.Generic.List[long]]::new()
    CallInfo     = @{}
    ActiveIntervals = @()
  }
  if (-not (Test-Path -LiteralPath $zstd)) {
    $info.Error = '未找到 zstd，无法解析会话'
    $script:sessionProblems['zstd'] = $true
    return $info
  }
  try {
    $raw = & $zstd -d -c $file.FullName 2>$null
    if ($LASTEXITCODE -ne 0) {
      $info.Error = "zstd 解压失败（退出码 $LASTEXITCODE）；该会话未计入"
      $script:sessionProblems['decompress'] = 1 + [int]$script:sessionProblems['decompress']
    }
    foreach ($line in $raw) {
      if (-not $line) { continue }
      try { $o = $line | ConvertFrom-Json } catch { continue }
      if ($o.time -ge $startMs -and $o.time -lt $endMs) { $info.ActivePoints.Add([long]$o.time) }
      switch ($o.type) {
        'session'       { if ($o.cwd) { $info.Cwd = $o.cwd } }
        'session/title' { if ($o.data.title) { $info.Title = $o.data.title } }
        'user/message' {
          if ($o.time -ge $startMs -and $o.time -lt $endMs) {
            $txt = ($o.data.content | Where-Object { $_.type -eq 'text' } | ForEach-Object { $_.text }) -join ' '
            if ($txt) {
              $txt = ($txt -replace '\s+', ' ').Trim()
              # 过滤注入内容与无信息量的催更
              $injected = $txt -match '^(<system-reminder>|Current runtime context|Time sampled|\[System\]|A skill is a reusable)'
              $filler = $txt.Length -le 4 -and $txt -match '^(继续|好的|ok|OK|嗯|你好)'
              if (-not $injected -and -not $filler) {
                if ($txt.Length -gt 110) { $txt = $txt.Substring(0, 110) + '…' }
                if ($info.Users.Count -eq 0 -or $info.Users[-1] -ne $txt) { $info.Users.Add($txt) }
              }
            }
          }
        }
        'assistant/message' {
          if ($o.time -ge $startMs -and $o.time -lt $endMs) {
            $r = ($o.data.content | Where-Object { $_.type -eq 'text' } | ForEach-Object { $_.text }) -join ' '
            if ($r) {
              $r = ($r -replace '\s+', ' ').Trim()
              if ($r.Length -gt 220) { $r = $r.Substring(0, 220) + '…' }
              $info.LastReply = $r
            }
            $u = $o.data.usage
            if ($u) {
              $info.Messages++
              $info.TokensIn += [long]$u.inputTokens
              $info.TokensOut += [long]$u.outputTokens
              $info.TokensCache += [long]$u.cacheReadTokens
              $info.TokensTotal += [long]$u.totalTokens
            }
            # 模型耗时：回复流第一个 chunk 的时间 → 消息落盘时间。
            $first = $null
            foreach ($chunk in @($o.data.stream)) {
              foreach ($stamp in @($chunk.time, $chunk.time0)) {
                if ($stamp -and ($null -eq $first -or [long]$stamp -lt $first)) { $first = [long]$stamp }
              }
            }
            if ($null -ne $first -and $o.time -gt $first) { $info.ModelMs += [long]($o.time - $first) }
          }
        }
        'tool/call' {
          if ($o.time -ge $startMs -and $o.time -lt $endMs) {
            $info.ToolToday++
            $info.ToolCallN++
            if ($o.data.name) { $info.ToolNames[$o.data.name] = 1 + [int]$info.ToolNames[$o.data.name] }
            if ($o.data.callId) {
              $info.CallInfo[[string]$o.data.callId] = [pscustomobject]@{ Time = [long]$o.time; Name = [string]$o.data.name }
            }
          }
          if ($o.time -ge [DateTimeOffset]::new($windowStart).ToUnixTimeMilliseconds() -and $o.time -lt $endMs) {
            $info.ToolWindow++
          }
        }
        'tool/result' {
          if ($o.time -ge $startMs -and $o.time -lt $endMs) {
            # callId 在 data.message.toolCallId；兼容顶层写法。
            $callId = $o.data.toolCallId
            if (-not $callId -and $o.data.message) { $callId = $o.data.message.toolCallId }
            if ($callId -and $info.CallInfo.ContainsKey([string]$callId)) {
              $call = $info.CallInfo[[string]$callId]
              # 一个 call 只该配一次结果；重复的 result 事件别把耗时算两遍。
              $info.CallInfo.Remove([string]$callId)
              $d = [long]$o.time - [long]$call.Time
              if ($d -lt 0) { $d = 0 }
              if ($waitTools -contains $call.Name) {
                $info.WaitMs += $d
              } else {
                if ($d -gt $toolCapMs) { $d = $toolCapMs }
                $info.ToolMs += $d
              }
            }
          }
        }
      }
    }
    $info.ActiveIntervals = Get-ActiveIntervals $info.ActivePoints
  } catch {
    $info.Error = $_.Exception.Message
  }
  return $info
}

$sessionProblems = @{ zstd = $false; decompress = 0 }
$sessionInfos = @()
$sessRoot = Join-Path $DshHome 'sessions'
if (-not $NoSessions -and (Test-Path $sessRoot)) {
  $sessFiles = @(Get-ChildItem -Path $sessRoot -Recurse -File -Filter 'session.v4.jsonl.zstd' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -ge $windowStart -and $_.LastWriteTime -lt $dayEnd } |
    Sort-Object LastWriteTime)
  foreach ($sf in $sessFiles) { $sessionInfos += (Read-SessionInfo $sf) }
}

# ---------- 工作区列表 ----------
$workspaces = [System.Collections.Generic.List[object]]::new()
$seen = @{}
$skipped = [System.Collections.Generic.List[object]]::new()

function Add-Workspace([string]$rawPath, [string]$source) {
  $real = Resolve-RealPath $rawPath
  if (-not $real -or -not (Test-Path -LiteralPath $real -PathType Container)) {
    $skipped.Add([pscustomobject]@{ Path = $rawPath; Reason = '目录不存在' })
    return $null
  }
  # 盘符根整块扫没有意义，显式指定也不放行（否则一次采集可能跑几十分钟）。
  if (-not (Split-Path -Parent $real)) {
    $skipped.Add([pscustomobject]@{ Path = $real; Reason = '盘符根目录' })
    return $null
  }
  if ($seen.ContainsKey($real.ToLowerInvariant())) {
    $existing = $workspaces | Where-Object { $_.RealPath.ToLowerInvariant() -eq $real.ToLowerInvariant() } | Select-Object -First 1
    if ($existing -and $source -eq '会话' -and -not $existing.FromSession) { $existing.FromSession = $true }
    return $existing
  }
  # 显式指定的根是用户意图，不再套默认忽略规则；自动发现的才过滤。
  $reason = if ($source -eq '指定') { $null } else { Test-IgnoredWorkspace $real }
  if ($reason) {
    $skipped.Add([pscustomobject]@{ Path = $real; Reason = $reason })
    return $null
  }
  $alias = $wsConfig.Aliases[$real.ToLowerInvariant()]
  $name = if ($alias) { $alias } else { Split-Path -Leaf $real }
  $ws = [pscustomobject]@{
    Name        = $name
    RealPath    = $real
    FromSession = ($source -eq '会话')
    Explicit    = ($source -eq '指定')
    Sessions    = 0
    ToolWindow  = 0
    Files       = @()
    FileTotal   = 0
    Truncated   = $false
    ScanStopped = $false
    Repos       = @()
    RepoTotal   = 0
  }
  $seen[$real.ToLowerInvariant()] = $true
  $workspaces.Add($ws)
  return $ws
}

foreach ($info in $sessionInfos) {
  if (-not $info.Cwd) { continue }
  $ws = Add-Workspace $info.Cwd '会话'
  if ($ws) {
    $ws.Sessions++
    $ws.ToolWindow += $info.ToolWindow
  }
}

$explicitWs = $null
if ($Workspace) {
  $explicitWs = Add-Workspace $Workspace '指定'
}

# 一个工作区都没发现时退回旧行为，至少把调用方指定的根扫了。
if ($workspaces.Count -eq 0) {
  $fallback = if ($Workspace) { $Workspace } else { Join-Path $DshHome 'dsh-work-summary' }
  $explicitWs = Add-Workspace $fallback '指定'
  $fallbackNote = '未从会话发现工作区，退回指定根。'
} else {
  $fallbackNote = $null
}

# 排序：会话多、工具调用多的在前；显式指定的根始终保留在列表里。
$allCount = $workspaces.Count
$workspaces = @($workspaces | Sort-Object @{ Expression = { if ($_.Explicit) { 0 } else { 1 } } },
  @{ Expression = 'Sessions'; Descending = $true },
  @{ Expression = 'ToolWindow'; Descending = $true },
  @{ Expression = 'Name' })
if ($workspaces.Count -gt $maxWorkspaces) {
  $workspaces = @($workspaces | Select-Object -First $maxWorkspaces)
}

# 同名工作区用父目录区分，避免两个 docs 混淆。
$nameCount = @{}
foreach ($ws in $workspaces) { $nameCount[$ws.Name] = 1 + [int]$nameCount[$ws.Name] }
foreach ($ws in $workspaces) {
  if ($nameCount[$ws.Name] -gt 1) {
    $ws.Name = '{0}\{1}' -f (Split-Path -Leaf (Split-Path -Parent $ws.RealPath)), $ws.Name
  }
}

# 每个工作区：改动文件（广度优先，跳过 skipDirs 与链接目录）与 Git 仓库。
# 父子工作区同时出现时（比如 F:\dsh_plugins 与 F:\dsh_plugins\dsh-work-summary），
# 父区扫描要跳过子区，否则同一批文件与提交会被统计两遍。
foreach ($ws in $workspaces) {
  $children = @($workspaces | Where-Object { $_ -ne $ws -and (Test-PathUnder $_.RealPath $ws.RealPath) } |
    ForEach-Object { $_.RealPath.ToLowerInvariant() })
  $ws | Add-Member -NotePropertyName ChildRoots -NotePropertyValue $children -Force
}

function Test-ChildRoot([string]$path, $childRoots) {
  if (-not $childRoots -or $childRoots.Count -eq 0) { return $false }
  $p = $path.TrimEnd('\').ToLowerInvariant()
  return ($childRoots -contains $p)
}

function Get-WorkspaceFiles($ws) {
  $found = [System.Collections.Generic.List[object]]::new()
  $total = 0
  $queue = [System.Collections.Generic.Queue[object]]::new()
  $queue.Enqueue($ws.RealPath)
  $dirCount = 0
  while ($queue.Count -gt 0) {
    if ($dirCount -ge $maxDirsPerWorkspace) { $ws.ScanStopped = $true; break }
    $dirCount++
    $dir = $queue.Dequeue()
    $entries = @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)
    foreach ($e in $entries) {
      if ($e.PSIsContainer) {
        if (Test-SkipName $e.Name) { continue }
        if (Test-ChildRoot $e.FullName $ws.ChildRoots) { continue }
        if ($e.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
        $queue.Enqueue($e.FullName)
        continue
      }
      if ($e.LastWriteTime -lt $dayStart -or $e.LastWriteTime -ge $dayEnd) { continue }
      $rel = $e.FullName.Substring($ws.RealPath.Length).TrimStart('\')
      if (-not $rel) { continue }
      $total++
      if ($found.Count -lt $maxFilesPerWorkspace) { $found.Add([pscustomobject]@{ File = $e; Rel = $rel }) }
    }
  }
  $ws.FileTotal = $total
  $ws.Truncated = ($total -gt $maxFilesPerWorkspace)
  $ws.Files = @($found | Sort-Object { $_.File.LastWriteTime })
}

function Get-WorkspaceRepos($ws) {
  $repos = [System.Collections.Generic.List[string]]::new()
  $queue = [System.Collections.Generic.Queue[object]]::new()
  $queue.Enqueue([pscustomobject]@{ Path = $ws.RealPath; Depth = 0 })
  while ($queue.Count -gt 0 -and $repos.Count -lt $maxReposPerWorkspace) {
    $node = $queue.Dequeue()
    if (Test-Path -LiteralPath (Join-Path $node.Path '.git')) { $repos.Add($node.Path) }
    if ($node.Depth -ge 2) { continue }
    foreach ($d in @(Get-ChildItem -LiteralPath $node.Path -Directory -Force -ErrorAction SilentlyContinue)) {
      if (Test-SkipName $d.Name) { continue }
      if (Test-ChildRoot $d.FullName $ws.ChildRoots) { continue }
      if ($d.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
      $queue.Enqueue([pscustomobject]@{ Path = $d.FullName; Depth = $node.Depth + 1 })
    }
  }
  $ws.Repos = @($repos)
  $ws.RepoTotal = $repos.Count
}

foreach ($ws in $workspaces) {
  Get-WorkspaceFiles $ws
  Get-WorkspaceRepos $ws
}

# ---------- 源数据归档 ----------
# `_源数据` 只保留最近 60 个 Markdown；更旧的按数据日期分季度压进 `_归档\YYYY-QN.zip`。
# 只归档不是今天的文件；打包成功并校验条目后才删除原文件，失败只记一行，不影响采集。
$archiveKeep = 60
$archiveDir = Join-Path $ReportDir '_归档'

function Get-SourceDay([string]$filePath) {
  $name = [IO.Path]::GetFileNameWithoutExtension($filePath)
  if ($name -match '^(\d{4})-(\d{2})-(\d{2})$') { return $name }
  if ($name -match '^周期-(\d{4})-(\d{2})-(\d{2})_') {
    return '{0}-{1}-{2}' -f $Matches[1], $Matches[2], $Matches[3]
  }
  return (Get-Item -LiteralPath $filePath).LastWriteTime.ToString('yyyy-MM-dd')
}

function Get-QuarterName([string]$day) {
  $year = [int]$day.Substring(0, 4)
  $month = [int]$day.Substring(5, 2)
  return '{0}-Q{1}' -f $year, ([math]::Floor(($month - 1) / 3) + 1)
}

function Add-ArchiveIndex([string]$quarter, [int]$added, [string]$first, [string]$last, [string]$zipName) {
  $index = Join-Path $archiveDir '索引.md'
  if (-not (Test-Path -LiteralPath $index)) {
    Set-Content -LiteralPath $index -Encoding UTF8 -Value @(
      '# 源数据归档索引'
      ''
      '| 归档时间 | 季度 | 新增 | 区间 | 包 |'
      '|---|---|---:|---|---|'
    )
  }
  $row = '| {0} | {1} | +{2} | {3} ~ {4} | `{5}` |' -f (Get-Date -Format 'yyyy-MM-dd HH:mm'), $quarter, $added, $first, $last, $zipName
  Add-Content -LiteralPath $index -Encoding UTF8 -Value $row
}

function Invoke-SourceArchive {
  $notes = [System.Collections.Generic.List[string]]::new()
  try {
    if (-not (Test-Path -LiteralPath $outDir)) { return @() }
    $all = @(Get-ChildItem -LiteralPath $outDir -File -Filter '*.md' -Force -ErrorAction Stop)
    $todayName = [IO.Path]::GetFileName($outFile)
    $old = @($all | Where-Object { $_.Name -ne $todayName })
    # 今天这次采集即将写入的文件也算一个名额，所以总数是旧文件 + 1。
    $total = $old.Count + 1
    if ($total -le $archiveKeep) { return @() }

    $excess = $total - $archiveKeep
    $candidates = @($old | ForEach-Object {
        [pscustomobject]@{ File = $_; Day = (Get-SourceDay $_.FullName) }
      } | Sort-Object Day, @{ Expression = { $_.File.Name } })
    $take = @($candidates | Select-Object -First $excess)

    foreach ($group in ($take | Group-Object { Get-QuarterName $_.Day })) {
      $zipName = '{0}.zip' -f $group.Name
      $zipPath = Join-Path $archiveDir $zipName
      $paths = @($group.Group | ForEach-Object { $_.File.FullName })
      $days = @($group.Group | ForEach-Object { $_.Day } | Sort-Object)
      $added = $paths.Count
      try {
        New-Item -ItemType Directory -Force -Path $archiveDir | Out-Null
        if (Test-Path -LiteralPath $zipPath) {
          Compress-Archive -LiteralPath $paths -DestinationPath $zipPath -Update -CompressionLevel Optimal -ErrorAction Stop
        } else {
          Compress-Archive -LiteralPath $paths -DestinationPath $zipPath -CompressionLevel Optimal -ErrorAction Stop
        }

        # 先确认压缩包里确实有这些条目，再删源文件；避免删了却没进包。
        $zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
        try { $entryNames = @($zip.Entries | ForEach-Object { $_.FullName }) }
        finally { $zip.Dispose() }
        $missing = @($paths | Where-Object { $entryNames -notcontains [IO.Path]::GetFileName($_) })
        if ($missing.Count -gt 0) { throw "压缩包缺少 $($missing.Count) 个文件" }

        foreach ($path in $paths) { Remove-Item -LiteralPath $path -Force -ErrorAction Stop }
        Add-ArchiveIndex $group.Name $added $days[0] $days[$days.Count - 1] $zipName
        $notes.Add("> 归档：$added 个源数据 → ``_归档\$zipName``（$($days[0]) ~ $($days[$days.Count - 1])）")
      } catch {
        $notes.Add("> 归档失败：$($_.Exception.Message)")
      }
    }
  } catch {
    $notes.Add("> 归档失败：$($_.Exception.Message)")
  }
  return $notes.ToArray()
}

# 首次运行生成 _工作区.md，让忽略与别名有地方写。
Initialize-WorkspaceConfig

Add-Line "# 工作痕迹源数据 · $Date"
Add-Line ''
Add-Line "> 采集窗口：$sinceArg ~ $untilArg（本地时区 $([DateTime]::Now.ToString('zzz'))）"
Add-Line '> 本文件由 `collect-day.ps1` 只读生成，用于日报的事实依据；不要手工编辑。'
Add-Line ''

# ---------- 0. 工作区（近两天活跃） ----------
Add-Line '## 0. 工作区（近两天活跃）'
Add-Line ''
if ($workspaces.Count -eq 0) {
  Add-Line '_未发现工作区：近两天没有带工作目录的 DSH 会话，也没有传入 -Workspace。_'
} else {
  Add-Line "共 $($workspaces.Count) 个工作区（窗口 $($windowStart.ToString('yyyy-MM-dd')) ~ $Date，按会话活跃度排序）。"
  if ($allCount -gt $workspaces.Count) { Add-Line "> 另有 $($allCount - $workspaces.Count) 个未列出（上限 $maxWorkspaces）。" }
  if ($fallbackNote) { Add-Line "> $fallbackNote" }
  if ($sessionProblems['zstd']) { Add-Line '> 警告：未找到 zstd，无法从 DSH 会话发现工作区（只扫指定根）。' }
  if ($sessionProblems['decompress'] -gt 0) { Add-Line "> 警告：$($sessionProblems['decompress']) 个会话解压失败，工作区可能漏列（见第 3 节）。" }
  Add-Line ''
  Add-Line '| 工作区 | 路径 | 近两天会话 | 近两天工具调用 | 当日改动文件 |'
  Add-Line '|---|---|---:|---:|---:|'
  foreach ($ws in $workspaces) {
    $filesCell = if ($ws.Truncated) { "$($ws.FileTotal)（截断）" } else { "$($ws.FileTotal)" }
    Add-Line ("| {0} | ``{1}`` | {2} | {3} | {4} |" -f $ws.Name, $ws.RealPath, $ws.Sessions, $ws.ToolWindow, $filesCell)
  }
  if ($skipped.Count -gt 0) {
    Add-Line ''
    Add-Line "> 已跳过 $($skipped.Count) 个目录：" + (($skipped | Select-Object -First 6 | ForEach-Object { "``$($_.Path)``（$($_.Reason)）" }) -join '、')
  }
}
Add-Line ''

# ---------- 1. 工作区文件改动 ----------
Add-Line '## 1. 工作区当日改动文件'
Add-Line ''
$totalFiles = ($workspaces | ForEach-Object { $_.FileTotal } | Measure-Object -Sum).Sum
if (-not $totalFiles) {
  Add-Line '_当日无文件改动。_'
} else {
  foreach ($ws in $workspaces) {
    if ($ws.FileTotal -eq 0) { continue }
    Add-Line ("### {0}（``{1}``）" -f $ws.Name, $ws.RealPath)
    Add-Line ''
    if ($ws.Truncated) {
      Add-Line "共 $($ws.FileTotal) 个文件，仅列前 $maxFilesPerWorkspace 个："
    } else {
      Add-Line "共 $($ws.FileTotal) 个文件："
    }
    if ($ws.ScanStopped) {
      Add-Line "> 目录数超过 $maxDirsPerWorkspace 个，已停止遍历；以下统计可能不完整。"
    }
    Add-Line ''
    Add-Line '| 时间 | 大小 | 相对路径 |'
    Add-Line '|------|------|----------|'
    foreach ($entry in $ws.Files) {
      $f = $entry.File
      $size = if ($f.Length -ge 1MB) { '{0:N1} MB' -f ($f.Length / 1MB) }
              elseif ($f.Length -ge 1KB) { '{0:N1} KB' -f ($f.Length / 1KB) }
              else { "$($f.Length) B" }
      Add-Line ("| {0:HH:mm} | {1} | {2} |" -f $f.LastWriteTime, $size, $entry.Rel)
    }

    Add-Line ''
    Add-Line '按顶层目录汇总：'
    Add-Line ''
    foreach ($g in ($ws.Files | Group-Object { ($_.Rel -split '[\\/]')[0] } | Sort-Object Count -Descending | Select-Object -First 12)) {
      Add-Line ("- ``{0}``：{1} 个文件" -f $g.Name, $g.Count)
    }
    Add-Line ''
  }
}
Add-Line ''

# ---------- 2. Git 仓库提交 ----------
Add-Line '## 2. Git 仓库当日提交'
Add-Line ''
$gitExe = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $gitExe) {
  Add-Line '_未找到 git，跳过。_'
} else {
  $anyRepo = $false
  foreach ($ws in $workspaces) {
    if ($ws.Repos.Count -eq 0) { continue }
    $anyRepo = $true
    Add-Line ("### {0}（``{1}``）" -f $ws.Name, $ws.RealPath)
    Add-Line ''
    foreach ($repo in $ws.Repos) {
      $rel = if ($repo -eq $ws.RealPath) { '.' } else { $repo.Substring($ws.RealPath.Length).TrimStart('\') }
      $log = & $gitExe -C $repo log --since="$sinceArg" --until="$untilArg" --pretty='%h %ad %s' --date=format:'%H:%M' --no-decorate 2>$null
      $branch = (& $gitExe -C $repo rev-parse --abbrev-ref HEAD 2>$null)
      $dirty = @(& $gitExe -C $repo status --porcelain 2>$null).Count
      if ($log) {
        Add-Line "#### ``$rel`` （分支 $branch）"
        Add-Line ''
        foreach ($l in $log) { Add-Line "- $l" }
        Add-Line ''
        if ($dirty -gt 0) { Add-Line "- 另有 $dirty 个未提交改动" ; Add-Line '' }
      } elseif ($dirty -gt 0) {
        Add-Line "- ``$rel``：当日无提交，但有 $dirty 个未提交改动（分支 $branch）"
      }
    }
  }
  if (-not $anyRepo) { Add-Line '_工作区内未发现 Git 仓库。_' }
}
Add-Line ''

# ---------- 3. DSH 会话 ----------
Add-Line '## 3. DSH 会话（当日有活动的会话）'
Add-Line ''
if ($NoSessions) {
  Add-Line '_（-NoSessions 跳过）_'
} else {
  $todaySessions = @($sessionInfos | Where-Object { $_.Today })
  if ($todaySessions.Count -eq 0) {
    Add-Line '_当日无 DSH 会话活动。_'
  } else {
    Add-Line "共 $($todaySessions.Count) 个会话有活动。"
    Add-Line ''
    foreach ($info in $todaySessions) {
      $wsName = $null
      if ($info.Cwd) {
        $realCwd = Resolve-RealPath $info.Cwd
        $match = $workspaces | Where-Object { $realCwd -and (Test-PathUnder $realCwd $_.RealPath) } |
          Sort-Object { $_.RealPath.Length } -Descending | Select-Object -First 1
        if ($match) { $wsName = $match.Name }
      }
      Add-Line ("### ``{0}``" -f $info.DirName)
      Add-Line ''
      Add-Line ("- 会话目录：``{0}``" -f $info.File.FullName)
      if ($info.Cwd) { Add-Line ("- 工作目录：``{0}``" -f $info.Cwd) }
      if ($wsName) { Add-Line ("- 所属工作区：{0}" -f $wsName) }
      if ($info.Title) { Add-Line ("- 标题：{0}" -f $info.Title) }
      if ($info.Error) { Add-Line ("- 解析失败：{0}" -f $info.Error) }
      Add-Line ("- 当日有效用户消息 {0} 条，工具调用 {1} 次" -f $info.Users.Count, $info.ToolToday)
      if ($info.ToolNames.Count -gt 0) {
        $top = ($info.ToolNames.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 6 |
          ForEach-Object { '{0}×{1}' -f $_.Key, $_.Value }) -join '、'
        Add-Line ("- 工具分布：{0}" -f $top)
      }
      if ($info.LastReply) { Add-Line ("- 最后一条回复：{0}" -f $info.LastReply) }
      foreach ($u in ($info.Users | Select-Object -First 12)) { Add-Line ("  - 「{0}」" -f $u) }
      if ($info.Users.Count -gt 12) { Add-Line ("  - …另有 {0} 条" -f ($info.Users.Count - 12)) }
      Add-Line ''
    }
  }
}
Add-Line ''

# ---------- 3.5 投入统计（token / 时间，R35） ----------
# 只统计当日窗口内的事件；多会话并行时活跃时长取并集，不能直接相加。
Add-Line '## 3.5 投入统计（token / 时间）'
Add-Line ''
$usageRows = @()
if ($NoSessions) {
  # 重采时沿用上一次的投入节：-NoSessions 只跳过会话解析，不该把已经算好的 token/时间抹掉。
  $prevUsage = [System.Collections.Generic.List[string]]::new()
  if (Test-Path -LiteralPath $outFile) {
    $inSection = $false
    foreach ($old in (Get-Content -LiteralPath $outFile -Encoding UTF8)) {
      if ($old -match '^##\s*3\.5\s') { $inSection = $true; continue }
      if ($inSection) {
        if ($old -match '^##\s') { break }
        $prevUsage.Add($old)
      }
    }
  }
  while ($prevUsage.Count -gt 0 -and [string]$prevUsage[$prevUsage.Count - 1].Trim() -eq '') {
    $prevUsage.RemoveAt($prevUsage.Count - 1)
  }
  while ($prevUsage.Count -gt 0 -and [string]$prevUsage[0].Trim() -eq '') {
    $prevUsage.RemoveAt(0)
  }
  if ($prevUsage.Count -gt 0) {
    Add-Line '_（-NoSessions 重采，沿用上一次的投入数据；要重算就按正常方式再采一次）_'
    Add-Line ''
    foreach ($line in $prevUsage) { Add-Line $line }
  } else {
    Add-Line '_（-NoSessions 跳过）_'
  }
} else {
  $activeInfos = @($sessionInfos | Where-Object { $_.ActivePoints.Count -gt 0 })
  if ($activeInfos.Count -eq 0) {
    Add-Line '_当日无 DSH 会话活动，无投入数据。_'
  } else {
    $groups = @{}
    $groupOrder = [System.Collections.Generic.List[string]]::new()
    foreach ($info in $activeInfos) {
      $wsName = '未归属'
      $wsPath = ''
      if ($info.Cwd) {
        $realCwd = Resolve-RealPath $info.Cwd
        $match = $workspaces | Where-Object { $realCwd -and (Test-PathUnder $realCwd $_.RealPath) } |
          Sort-Object { $_.RealPath.Length } -Descending | Select-Object -First 1
        if ($match) { $wsName = $match.Name; $wsPath = $match.RealPath }
      }
      if (-not $groups.ContainsKey($wsName)) {
        $groups[$wsName] = [pscustomobject]@{
          Name = $wsName; Path = $wsPath; Sessions = 0
          Intervals = [System.Collections.Generic.List[object]]::new()
          ModelMs = [long]0; ToolMs = [long]0; WaitMs = [long]0
          Input = [long]0; Cache = [long]0; Output = [long]0; Total = [long]0
        }
        $groupOrder.Add($wsName)
      }
      $g = $groups[$wsName]
      $g.Sessions++
      foreach ($iv in $info.ActiveIntervals) { $g.Intervals.Add($iv) }
      $g.ModelMs += [long]$info.ModelMs
      $g.ToolMs += [long]$info.ToolMs
      $g.WaitMs += [long]$info.WaitMs
      $g.Input += [long]$info.TokensIn
      $g.Cache += [long]$info.TokensCache
      $g.Output += [long]$info.TokensOut
      $g.Total += [long]$info.TokensTotal
    }
    $usageRows = @($groupOrder | ForEach-Object {
      $g = $groups[$_]
      [pscustomobject]@{
        Name = $g.Name; Path = $g.Path; Sessions = $g.Sessions
        ActiveMs = [long](Merge-IntervalMs $g.Intervals)
        ModelMs = $g.ModelMs; ToolMs = $g.ToolMs; WaitMs = $g.WaitMs
        Input = $g.Input; Cache = $g.Cache; Output = $g.Output; Total = $g.Total
      }
    } | Sort-Object -Property @{ Expression = 'ActiveMs'; Descending = $true })

    $tSessions = [long](($usageRows | Measure-Object -Property Sessions -Sum).Sum)
    # 合计活跃取全工作区并集：并行会话/跨工作区同时干活不能重复计时，所以它可能小于各行相加。
    $tActive = [long](Merge-IntervalMs @($activeInfos | ForEach-Object { $_.ActiveIntervals }))
    $tModel = [long](($usageRows | Measure-Object -Property ModelMs -Sum).Sum)
    $tTool = [long](($usageRows | Measure-Object -Property ToolMs -Sum).Sum)
    $tWait = [long](($usageRows | Measure-Object -Property WaitMs -Sum).Sum)
    $tInput = [long](($usageRows | Measure-Object -Property Input -Sum).Sum)
    $tCache = [long](($usageRows | Measure-Object -Property Cache -Sum).Sum)
    $tOutput = [long](($usageRows | Measure-Object -Property Output -Sum).Sum)
    $tTotal = [long](($usageRows | Measure-Object -Property Total -Sum).Sum)
    $tDenom = $tInput + $tCache
    $tHit = if ($tDenom -gt 0) { $tCache / $tDenom * 100 } else { 0 }

    Add-Line ("**投入：** 会话 {0} 个 · 活跃 {1} · 模型 {2} · 工具 {3} · 等你确认 {4}" -f
      $tSessions, (Format-Duration $tActive), (Format-Duration $tModel), (Format-Duration $tTool), (Format-Duration $tWait))
    Add-Line ("**Token：** 合计 {0}（新输入 {1} / 缓存读 {2} / 输出 {3}，缓存命中 {4}）" -f
      (Format-TokenCount $tTotal), (Format-TokenCount $tInput), (Format-TokenCount $tCache),
      (Format-TokenCount $tOutput), (Format-Percent $tHit))
    Add-Line ''
    Add-Line '| 工作区 | 会话 | 活跃 | 模型 | 工具 | 等你确认 | Token | 新输入 | 缓存读 | 输出 | 命中 |'
    Add-Line '|---|---|---|---|---|---|---|---|---|---|---|'
    foreach ($row in $usageRows) {
      $denom = $row.Input + $row.Cache
      $hit = if ($denom -gt 0) { $row.Cache / $denom * 100 } else { 0 }
      Add-Line ("| {0} | {1} | {2} | {3} | {4} | {5} | {6} | {7} | {8} | {9} | {10} |" -f
        $row.Name, $row.Sessions, (Format-Duration $row.ActiveMs), (Format-Duration $row.ModelMs),
        (Format-Duration $row.ToolMs), (Format-Duration $row.WaitMs), (Format-TokenCount $row.Total),
        (Format-TokenCount $row.Input), (Format-TokenCount $row.Cache), (Format-TokenCount $row.Output),
        (Format-Percent $hit))
    }
    Add-Line ''
    Add-Line ("- 口径：活跃=会话事件间隔封顶 5 分钟后按会话并集（合计为全工作区并集，按行相加可能略大）；模型=回复流首末；工具=调用配对，单次封顶 10 分钟；等你确认={0} 的等待；token 取 assistant/message.usage，失败重试不计。" -f ($waitTools -join '、'))
    $usageJson = [ordered]@{
      sessions = $tSessions
      activeMs = $tActive
      modelMs = $tModel
      toolMs = $tTool
      waitMs = $tWait
      input = $tInput
      cache = $tCache
      output = $tOutput
      total = $tTotal
      byWorkspace = @($usageRows | ForEach-Object {
        [ordered]@{
          name = $_.Name; path = $_.Path; sessions = $_.Sessions
          activeMs = $_.ActiveMs; modelMs = $_.ModelMs; toolMs = $_.ToolMs; waitMs = $_.WaitMs
          input = $_.Input; cache = $_.Cache; output = $_.Output; total = $_.Total
        }
      })
    }
    Add-Line ('<!-- dsh-usage ' + ($usageJson | ConvertTo-Json -Compress -Depth 5) + ' -->')
  }
}
Add-Line ''

# ---------- 4. 工作看板（工作区内的 Markdown 看板） ----------
Add-Line '## 4. 工作看板（`看板.md`）'
Add-Line ''
$boardMd = Join-Path $ReportDir '看板.md'
if (Test-Path $boardMd) {
  $bl = Get-Content $boardMd -Encoding UTF8
  $cur = ''
  $counts = @{}; $openItems = @()
  foreach ($line in $bl) {
    if ($line -match '^##\s*(.+?)\s*$') { $cur = $Matches[1]; $counts[$cur] = 0; continue }
    if ($line -match '^\s*-\s*\[ \]\s*(.+)$') {
      if ($cur) { $counts[$cur] = [int]$counts[$cur] + 1 }
      if ($cur -eq '待办') { $openItems += $Matches[1].Trim() }
    }
  }
  $total = ($counts.Values | Measure-Object -Sum).Sum
  if (-not $total) {
    Add-Line '_看板为空。_'
  } else {
    foreach ($k in $counts.Keys) { if ($counts[$k] -gt 0) { Add-Line ("- {0}：{1} 条未完成" -f $k, $counts[$k]) } }
    if ($openItems.Count -gt 0) {
      Add-Line ''
      Add-Line '待办明细：'
      foreach ($it in ($openItems | Select-Object -First 12)) { Add-Line ("- {0}" -f $it) }
      if ($openItems.Count -gt 12) { Add-Line ("- …另有 {0} 条" -f ($openItems.Count - 12)) }
    }
  }
} else {
  Add-Line '_未找到 `看板.md`（看板路径由 -ReportDir 决定）。_'
}
Add-Line ''

# ---------- 5. 当日已有产物 ----------
Add-Line '## 5. 已知产物目录'
Add-Line ''
$productDirs = @('_报告源文件', '_巡检', '_日报', '_协作规范')
$anyProduct = $false
foreach ($ws in $workspaces) {
  foreach ($d in $productDirs) {
    $p = Join-Path $ws.RealPath $d
    if (-not (Test-Path $p)) { continue }
    $recent = @(Get-ChildItem $p -File -Recurse -Force -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTime -ge $dayStart -and $_.LastWriteTime -lt $dayEnd })
    if ($recent.Count -eq 0) { continue }
    $anyProduct = $true
    Add-Line ("### {0} · ``{1}``" -f $ws.Name, $d)
    Add-Line ''
    foreach ($r in $recent) { Add-Line ("- ``{0}``（{1:HH:mm}）" -f $r.FullName, $r.LastWriteTime) }
    Add-Line ''
  }
}
if (-not $anyProduct) { Add-Line '_当日无已知产物目录更新。_' }
Add-Line ''

# ---------- 6. 源数据归档 ----------
$archiveNotes = @(Invoke-SourceArchive)
if ($archiveNotes.Count -gt 0) {
  Add-Line '## 6. 源数据归档'
  Add-Line ''
  foreach ($note in $archiveNotes) { Add-Line $note }
  Add-Line ''
}

# ---------- 7. 未清主线（_主线.md 账本） ----------
Add-Line '## 7. 未清主线（`_主线.md`）'
Add-Line ''
$ledgerPath = Join-Path $ReportDir '_主线.md'
if (-not (Test-Path $ledgerPath)) {
  Add-Line '_暂无主线账本：第一份含 `#### M-YYYY-MM-DD-NN` 小节的日报落盘后会生成。_'
} else {
  $entries = @()
  $cur = $null
  foreach ($line in (Get-Content $ledgerPath -Encoding UTF8)) {
    if ($line -match '^##\s+(M-\d{4}-\d{2}-\d{2}-\d{2})\s*(.*)$') {
      $cur = [pscustomobject]@{
        Id = $Matches[1]; Title = $Matches[2].Trim(); Workspace = ''; Status = '进行中'; Last = ''
      }
      $entries += $cur
      continue
    }
    if (-not $cur) { continue }
    if ($line -match '^-\s*工作区：\s*(.+)$') { $cur.Workspace = $Matches[1].Trim() }
    elseif ($line -match '^-\s*状态：\s*(.+)$') { $cur.Status = $Matches[1].Trim() }
    elseif ($line -match '^-\s*最近产出：\s*(.+)$') { $cur.Last = $Matches[1].Trim() }
  }
  $openEntries = @($entries | Where-Object { $_.Status -ne '完成' -and $_.Status -ne '放弃' })
  if ($openEntries.Count -eq 0) {
    Add-Line '_没有未完成的主线。_'
  } else {
    Add-Line '| 主线 | 标题 | 工作区 | 状态 | 最近产出 | 挂起天数 |'
    Add-Line '|---|---|---|---|---|---|'
    foreach ($e in $openEntries) {
      $days = 0
      if ($e.Last -match '^\d{4}-\d{2}-\d{2}$') {
        try {
          $days = [int][math]::Floor(($day - [datetime]::ParseExact($e.Last, 'yyyy-MM-dd', $null)).TotalDays)
        } catch { $days = 0 }
        if ($days -lt 0) { $days = 0 }
      }
      $status = $e.Status
      if ($days -ge $StallDays) { $status = '受阻' }
      $ws = if ($e.Workspace) { $e.Workspace } else { '—' }
      $last = if ($e.Last) { $e.Last } else { '—' }
      Add-Line ("| {0} | {1} | {2} | {3} | {4} | {5} |" -f $e.Id, $e.Title, $ws, $status, $last, $days)
    }
    Add-Line ''
    Add-Line ("受阻判定：未完成、未放弃，且最近产出距今 ≥ {0} 天（mainline.stallDays）。" -f $StallDays)
  }
}
Add-Line ''

Set-Content -Path $outFile -Value $sb -Encoding UTF8
Write-Output $outFile
