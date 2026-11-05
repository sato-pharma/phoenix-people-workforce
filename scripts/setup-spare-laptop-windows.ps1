# Phoenix CI on the spare laptop - the Windows half (2026-11-05). Paste into a NORMAL PowerShell window (not admin).
# Caps WSL at 5 GB + 8 GB swap, keeps the laptop awake on the charger, starts WSL hidden at every sign-in, restarts WSL.
# It writes only inside your user profile (.wslconfig and the Startup folder); no other drive is touched.
& {
  $Distro = 'Ubuntu-24.04'
  $names = @((wsl.exe -l -q) | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ })
  if ($names -notcontains $Distro) { Write-Host "STOPPED: no WSL distro named $Distro (found: $($names -join ', ')). Nothing was changed." -ForegroundColor Red; return }
  # 1. %UserProfile%\.wslconfig - set four keys under [wsl2], keep every other line as it is.
  $cfg = Join-Path $env:USERPROFILE '.wslconfig'
  $want = [ordered]@{ memory = '5GB'; processors = "$([Environment]::ProcessorCount)"; swap = '8GB'; vmIdleTimeout = '-1' }
  $old = @(); if (Test-Path -LiteralPath $cfg) { $old = @(Get-Content -LiteralPath $cfg) }
  $out = New-Object System.Collections.Generic.List[string]
  $done = @{}; $section = ''; $hasWsl2 = $false
  $flush = { foreach ($k in $want.Keys) { if (-not $done[$k]) { $out.Add("$k=$($want[$k])"); $done[$k] = $true } } }
  foreach ($line in $old) {
    if ($line -match '^\s*\[(.+?)\]\s*$') {
      if ($section -eq 'wsl2') { & $flush }
      $section = $Matches[1].Trim().ToLower(); if ($section -eq 'wsl2') { $hasWsl2 = $true }
      $out.Add($line); continue
    }
    if ($section -eq 'wsl2' -and $line -match '^\s*([A-Za-z]+)\s*=') {
      $key = @($want.Keys | Where-Object { $_ -ieq $Matches[1] })
      if ($key.Count -eq 1) { if (-not $done[$key[0]]) { $out.Add("$($key[0])=$($want[$key[0]])"); $done[$key[0]] = $true }; continue }
    }
    $out.Add($line)
  }
  if ($section -eq 'wsl2') { & $flush }
  if (-not $hasWsl2) { $out.Add('[wsl2]'); & $flush }
  [IO.File]::WriteAllText($cfg, (($out -join "`r`n") + "`r`n"), (New-Object System.Text.UTF8Encoding $false))
  Write-Host "1. $cfg written: memory=5GB, processors=$([Environment]::ProcessorCount), swap=8GB, vmIdleTimeout=-1"
  # 2. Power, on the charger only: never sleep, never hibernate, closing the lid does nothing.
  $power = @(
    @('/change', 'standby-timeout-ac', '0'),
    @('/change', 'hibernate-timeout-ac', '0'),
    @('/setacvalueindex', 'SCHEME_CURRENT', 'SUB_BUTTONS', 'LIDACTION', '0'),
    @('/setactive', 'SCHEME_CURRENT')
  )
  foreach ($a in $power) {
    & powercfg.exe @a | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Host "2. powercfg $($a -join ' ') - done" }
    else { Write-Host "2. powercfg $($a -join ' ') was REFUSED - set it by hand: Settings > System > Power (plugged in: sleep Never; lid close: Do nothing)" -ForegroundColor Yellow }
  }
  # 3. A hidden launcher in YOUR Startup folder: at every sign-in it starts WSL with no window and keeps it running.
  $vbs = Join-Path ([Environment]::GetFolderPath('Startup')) 'phoenix-ci-wsl.vbs'
  $q = [char]34
  $run = "wsl.exe -d $Distro --exec /bin/sh -c $q$q" + 'sleep infinity' + "$q$q"
  [IO.File]::WriteAllText($vbs, "CreateObject(${q}WScript.Shell${q}).Run $q$run$q, 0, False`r`n", [Text.Encoding]::ASCII)
  Write-Host "3. $vbs written"
  # 4. Restart WSL so the 5 GB cap applies, then start it hidden, as a sign-in would.
  wsl.exe --shutdown
  Start-Process -FilePath wscript.exe -ArgumentList "$q$vbs$q"
  Start-Sleep -Seconds 20
  Write-Host '4. WSL restarted. The runner service inside it:'
  wsl.exe -d $Distro --exec systemctl list-units --type=service --no-legend --no-pager 'actions.runner.*'
}
