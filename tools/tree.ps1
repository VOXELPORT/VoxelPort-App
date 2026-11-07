param([int]$RootPid)
# Memory and CPU time of a process and all its descendants (the app plus its web view / helper processes).
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
$ids = New-Object System.Collections.Generic.HashSet[int]
$null = $ids.Add($RootPid)
do {
  $before = $ids.Count
  foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId)) { $null = $ids.Add([int]$p.ProcessId) } }
} while ($ids.Count -gt $before)
$procs = foreach ($id in $ids) { Get-Process -Id $id -ErrorAction SilentlyContinue }
$ws = ($procs | Measure-Object WorkingSet64 -Sum).Sum
$priv = ($procs | Measure-Object PrivateMemorySize64 -Sum).Sum
$cpu = ($procs | ForEach-Object { if ($_.TotalProcessorTime) { $_.TotalProcessorTime.TotalSeconds } else { 0 } } | Measure-Object -Sum).Sum
[pscustomobject]@{
  processes = @($procs).Count
  workingSetMB = [math]::Round($ws / 1MB, 1)
  privateMB = [math]::Round($priv / 1MB, 1)
  cpuSeconds = [math]::Round($cpu, 3)
  names = (($procs | Group-Object ProcessName | ForEach-Object { "$($_.Name)x$($_.Count)" }) -join ',')
} | ConvertTo-Json -Compress
