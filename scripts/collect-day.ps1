# collect-day.ps1 —— 收集某一天的"工作痕迹"，输出一份源数据 Markdown，供日报总结引用。
# 用法：
#   pwsh -NoProfile -File collect-day.ps1              # 今天
#   pwsh -NoProfile -File collect-day.ps1 -Date 2026-10-28
#   pwsh -NoProfile -File collect-day.ps1 -NoSessions  # 跳过会话解析（更快）
# 输出：<ReportDir>\_源数据\YYYY-MM-DD.md（同时打印路径）
# 本脚本属于 dsh-work-summary 插件仓库；扫哪里由 -Workspace 决定，产物写哪由 -ReportDir 决定。
# 默认数据根是 ~/.dsh/dsh-work-summary（插件激活时创建），插件调用时会把两个参数都显式传进来。

param(
  [string]$Date = (Get-Date -Format 'yyyy-MM-dd'),
  [string]$DshHome = (Join-Path $HOME '.dsh'),
  [string]$Workspace = (Join-Path $DshHome 'dsh-work-summary'),
  [string]$ReportDir = (Join-Path $DshHome 'dsh-work-summary'),
  [switch]$NoSessions
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try { $day = [datetime]::ParseExact($Date, 'yyyy-MM-dd', $null) }
catch { throw "日期格式应为 yyyy-MM-dd，收到：$Date" }

$dayStart = $day
$dayEnd = $day.AddDays(1)
$startMs = [DateTimeOffset]::new($dayStart).ToUnixTimeMilliseconds()
$endMs = [DateTimeOffset]::new($dayEnd).ToUnixTimeMilliseconds()
$sinceArg = $dayStart.ToString('yyyy-MM-dd HH:mm:ss')
$untilArg = $dayEnd.ToString('yyyy-MM-dd HH:mm:ss')

$outDir = Join-Path $ReportDir '_源数据'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$outFile = Join-Path $outDir "$Date.md"

$skipDirs = @('node_modules', '.pnpm-store', '.git', 'dist', 'build', '.next', 'target',
  'temp', 'tmp', '.cache', '__pycache__', '_源数据', '.dsh-vision-router',
  # 第三方资产/工具目录：装技能、跑示例产生的海量文件不该进日报
  '.dsh', 'anatomy', 'shots', '备份',
  # 临时/调试文件专区：一次性脚本与中间产物不算工作产出
  '_scratch')

function Test-SkipPath([string]$rel) {
  foreach ($seg in ($rel -split '[\\/]')) {
    if ($skipDirs -contains $seg) { return $true }
  }
  return $false
}

$sb = [System.Collections.Generic.List[string]]::new()
function Add-Line([string]$s = '') { $sb.Add($s) }

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

Add-Line "# 工作痕迹源数据 · $Date"
Add-Line ''
Add-Line "> 采集窗口：$sinceArg ~ $untilArg（本地时区 $([DateTime]::Now.ToString('zzz'))）"
Add-Line '> 本文件由 `collect-day.ps1` 只读生成，用于日报的事实依据；不要手工编辑。'
Add-Line ''

# ---------- 1. 工作区文件改动 ----------
Add-Line '## 1. 工作区当日改动文件'
Add-Line ''
$files = @()
if (Test-Path $Workspace) {
  $files = Get-ChildItem -Path $Workspace -Recurse -File -Force -ErrorAction SilentlyContinue |
    Where-Object {
      $_.LastWriteTime -ge $dayStart -and $_.LastWriteTime -lt $dayEnd -and
      -not (Test-SkipPath $_.FullName.Substring($Workspace.Length))
    } | Sort-Object LastWriteTime
}

if ($files.Count -eq 0) {
  Add-Line '_当日无文件改动。_'
} else {
  Add-Line "共 $($files.Count) 个文件："
  Add-Line ''
  Add-Line '| 时间 | 大小 | 相对路径 |'
  Add-Line '|------|------|----------|'
  foreach ($f in $files) {
    $rel = $f.FullName.Substring($Workspace.Length).TrimStart('\')
    $size = if ($f.Length -ge 1MB) { '{0:N1} MB' -f ($f.Length / 1MB) }
            elseif ($f.Length -ge 1KB) { '{0:N1} KB' -f ($f.Length / 1KB) }
            else { "$($f.Length) B" }
    Add-Line ("| {0:HH:mm} | {1} | {2} |" -f $f.LastWriteTime, $size, $rel)
  }

  Add-Line ''
  Add-Line '### 按顶层目录汇总'
  Add-Line ''
  $files | Group-Object { ($_.FullName.Substring($Workspace.Length).TrimStart('\') -split '[\\/]')[0] } |
    Sort-Object Count -Descending |
    ForEach-Object { Add-Line ("- ``{0}``：{1} 个文件" -f $_.Name, $_.Count) }
}
Add-Line ''

# ---------- 2. Git 仓库提交 ----------
Add-Line '## 2. Git 仓库当日提交'
Add-Line ''
$gitExe = (Get-Command git -ErrorAction SilentlyContinue).Source
$repos = @()
if ($gitExe -and (Test-Path $Workspace)) {
  $repos = Get-ChildItem -Path $Workspace -Directory -Recurse -Depth 3 -Force -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName '.git') } |
    Select-Object -ExpandProperty FullName
}

if (-not $gitExe) {
  Add-Line '_未找到 git，跳过。_'
} elseif ($repos.Count -eq 0) {
  Add-Line '_工作区内未发现 Git 仓库。_'
} else {
  $anyCommit = $false
  foreach ($repo in $repos) {
    $rel = if ($repo -eq $Workspace) { '.' } else { $repo.Substring($Workspace.Length).TrimStart('\') }
    $log = & $gitExe -C $repo log --since="$sinceArg" --until="$untilArg" --pretty='%h %ad %s' --date=format:'%H:%M' --no-decorate 2>$null
    $branch = (& $gitExe -C $repo rev-parse --abbrev-ref HEAD 2>$null)
    $dirty = @(& $gitExe -C $repo status --porcelain 2>$null).Count
    if ($log) {
      $anyCommit = $true
      Add-Line "### ``$rel`` （分支 $branch）"
      Add-Line ''
      foreach ($l in $log) { Add-Line "- $l" }
      Add-Line ''
      if ($dirty -gt 0) { Add-Line "- 另有 $dirty 个未提交改动" ; Add-Line '' }
    } elseif ($dirty -gt 0) {
      Add-Line "- ``$rel``：当日无提交，但有 $dirty 个未提交改动（分支 $branch）"
    }
  }
  if (-not $anyCommit) { Add-Line '' }
}
Add-Line ''

# ---------- 3. DSH 会话 ----------
Add-Line '## 3. DSH 会话（当日有活动的会话）'
Add-Line ''
if ($NoSessions) {
  Add-Line '_（-NoSessions 跳过）_'
} else {
  $sessRoot = Join-Path $DshHome 'sessions'
  $zstd = (Get-Command zstd -ErrorAction SilentlyContinue).Source
  if (-not $zstd) { $zstd = 'C:\Program Files\poppler\Library\bin\zstd.exe' }

  $sessFiles = @()
  if (Test-Path $sessRoot) {
    $sessFiles = Get-ChildItem -Path $sessRoot -Recurse -File -Filter 'session.v4.jsonl.zstd' -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTime -ge $dayStart -and $_.LastWriteTime -lt $dayEnd } |
      Sort-Object LastWriteTime
  }

  if ($sessFiles.Count -eq 0) {
    Add-Line '_当日无 DSH 会话活动。_'
  } else {
    Add-Line "共 $($sessFiles.Count) 个会话有活动。"
    Add-Line ''
    foreach ($sf in $sessFiles) {
      $wsName = $sf.Directory.Parent.Name
      $title = $null; $cwd = $null; $users = @(); $toolCount = 0
      $toolNames = @{}; $lastReply = $null
      if (Test-Path $zstd) {
        try {
          $raw = & $zstd -d -c $sf.FullName 2>$null
          foreach ($line in $raw) {
            if (-not $line) { continue }
            try { $o = $line | ConvertFrom-Json } catch { continue }
            switch ($o.type) {
              'session'       { if ($o.cwd) { $cwd = $o.cwd } }
              'session/title' { if ($o.data.title) { $title = $o.data.title } }
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
                      if ($users.Count -eq 0 -or $users[-1] -ne $txt) { $users += $txt }
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
                    $lastReply = $r
                  }
                }
              }
              'tool/call' {
                if ($o.time -ge $startMs -and $o.time -lt $endMs) {
                  $toolCount++
                  if ($o.data.name) { $toolNames[$o.data.name] = 1 + [int]$toolNames[$o.data.name] }
                }
              }
            }
          }
        } catch { Add-Line ("- ``{0}`` 解析失败：{1}" -f $wsName, $_.Exception.Message) }
      }

      Add-Line ("### ``{0}``" -f $wsName)
      Add-Line ''
      Add-Line ("- 会话目录：``{0}``" -f $sf.FullName)
      if ($cwd) { Add-Line ("- 工作目录：``{0}``" -f $cwd) }
      if ($title) { Add-Line ("- 标题：{0}" -f $title) }
      Add-Line ("- 当日有效用户消息 {0} 条，工具调用 {1} 次" -f $users.Count, $toolCount)
      if ($toolNames.Count -gt 0) {
        $top = ($toolNames.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 6 |
          ForEach-Object { '{0}×{1}' -f $_.Key, $_.Value }) -join '、'
        Add-Line ("- 工具分布：{0}" -f $top)
      }
      if ($lastReply) { Add-Line ("- 最后一条回复：{0}" -f $lastReply) }
      foreach ($u in ($users | Select-Object -First 12)) { Add-Line ("  - 「{0}」" -f $u) }
      if ($users.Count -gt 12) { Add-Line ("  - …另有 {0} 条" -f ($users.Count - 12)) }
      Add-Line ''
    }
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
foreach ($d in @('_报告源文件', '_巡检', '_日报', '_协作规范')) {
  $p = Join-Path $Workspace $d
  if (Test-Path $p) {
    $recent = Get-ChildItem $p -File -Recurse -Force -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTime -ge $dayStart -and $_.LastWriteTime -lt $dayEnd }
    if ($recent) {
      foreach ($r in $recent) { Add-Line ("- ``{0}``（{1:HH:mm}）" -f $r.FullName, $r.LastWriteTime) }
    }
  }
}
Add-Line ''

# ---------- 6. 源数据归档 ----------
$archiveNotes = @(Invoke-SourceArchive)
if ($archiveNotes.Count -gt 0) {
  Add-Line '## 6. 源数据归档'
  Add-Line ''
  foreach ($note in $archiveNotes) { Add-Line $note }
  Add-Line ''
}

Set-Content -Path $outFile -Value $sb -Encoding UTF8
Write-Output $outFile
