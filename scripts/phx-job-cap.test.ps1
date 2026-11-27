<#
Proves the job-object cap actually binds, with a NEGATIVE CONTROL beside it.

Without the control this test is worthless: a node process that dies proves nothing on its own -
it could have died of anything, and "it died" is exactly what a broken harness also produces. So
the same allocator is run TWICE, identical in every way except membership of the job:

  CONTROL   no job  -> must reach the full target and print DONE
  CAPPED    in job  -> must die BEFORE the target, at roughly the cap

A pass needs both halves. If the control also dies, the allocator or the machine is the problem
and the cap has been proved nothing.

  powershell -NoProfile -ExecutionPolicy Bypass -File phx-job-cap.test.ps1
#>
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\phx-job-cap.ps1"

$TargetMB = 1600      # what the allocator tries to reach
$CapMB    = 400       # the per-process ceiling under test
$node     = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction Stop).Source }

# Waits, so the harness has time to assign it, then allocates OFF-HEAP buffers (which is what
# --max-old-space-size cannot bound and what a job object can) until it reaches the target.
#
# WRITTEN TO A FILE, NOT PASSED WITH `node -e`. The first version of this test passed the script
# inline and the control process started, allocated nothing and exited silently with a 4 MB peak,
# which reads exactly like "the cap worked" if you are not carrying a control. Start-Process joins
# its ArgumentList into one command line that Windows then re-parses, so a multi-line script full
# of quotes and parentheses does not survive the trip. A file has nothing to re-parse.
$allocJs = Join-Path ([System.IO.Path]::GetTempPath()) ("phx-job-cap-alloc-" + [guid]::NewGuid().ToString('N') + ".js")
@"
const chunks = [];
const target = $TargetMB;
setTimeout(() => {
  try {
    while (chunks.length * 50 < target) {
      chunks.push(Buffer.alloc(50 * 1024 * 1024, 1));
      console.log('MB ' + chunks.length * 50);
    }
    console.log('DONE ' + chunks.length * 50);
  } catch (e) {
    console.log('THREW ' + e.message);
    process.exit(3);
  }
}, 3000);
"@ | Set-Content -Path $allocJs -Encoding ascii

function Invoke-Allocator {
  param([string]$Label, [IntPtr]$Job)
  $out = New-TemporaryFile
  $p = Start-Process -FilePath $node -ArgumentList $allocJs -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $out.FullName -RedirectStandardError "$($out.FullName).err"
  $assigned = $false
  if ($Job -ne [IntPtr]::Zero) {
    Start-Sleep -Milliseconds 400
    $assigned = Add-ProcessToPhxJob -Job $Job -ProcessId $p.Id
  }
  $peakMB = 0
  $deadline = (Get-Date).AddSeconds(90)
  while (-not $p.HasExited -and (Get-Date) -lt $deadline) {
    try { $p.Refresh(); $mb = [math]::Round($p.PrivateMemorySize64/1MB); if ($mb -gt $peakMB) { $peakMB = $mb } } catch { break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; $timedOut = $true } else { $timedOut = $false }
  Start-Sleep -Milliseconds 300
  $stdout = (Get-Content $out.FullName -ErrorAction SilentlyContinue) -join "`n"
  $lastMB = 0
  foreach ($m in [regex]::Matches($stdout, '(?m)^MB (\d+)$')) { $lastMB = [int]$m.Groups[1].Value }
  $reachedDone = $stdout -match 'DONE'
  Remove-Item $out.FullName, "$($out.FullName).err" -Force -ErrorAction SilentlyContinue
  [pscustomobject]@{
    Label = $Label; Assigned = $assigned; PeakMB = $peakMB; LastReportedMB = $lastMB
    Done = $reachedDone; ExitCode = $(if ($timedOut) { 'TIMEOUT' } else { $p.ExitCode })
  }
}

Write-Output "== CONTROL (no job, must reach $TargetMB MB) =="
$control = Invoke-Allocator -Label 'CONTROL' -Job ([IntPtr]::Zero)
$control | Format-List | Out-String | Write-Output

Write-Output "== CAPPED (job per-process limit $CapMB MB, must die below $TargetMB MB) =="
$job = New-PhxJobCap -Name ("Local\PhxJobCapTest-" + [guid]::NewGuid().ToString('N')) -PerProcessGB ($CapMB/1024) -JobGB 0
$capped = Invoke-Allocator -Label 'CAPPED' -Job $job
$capped | Format-List | Out-String | Write-Output
Write-Output ("job peak memory reported by the kernel: {0} MB" -f [math]::Round([PhxJob]::PeakJobMemory($job)/1MB))

$fails = @()
if (-not $control.Done)                       { $fails += "CONTROL did not reach $TargetMB MB - the allocator or the machine is at fault, so the cap is unproven" }
if ($control.LastReportedMB -lt $TargetMB)    { $fails += "CONTROL only reached $($control.LastReportedMB) MB" }
if (-not $capped.Assigned)                    { $fails += 'CAPPED was never assigned to the job' }
if ($capped.Done)                             { $fails += "CAPPED reached DONE - the limit did not bind" }
if ($capped.LastReportedMB -ge $TargetMB)     { $fails += "CAPPED reached $($capped.LastReportedMB) MB, at or past the target" }
if ($capped.PeakMB -gt ($CapMB * 2))          { $fails += "CAPPED peaked at $($capped.PeakMB) MB, far above the $CapMB MB cap" }

Remove-Item $allocJs -Force -ErrorAction SilentlyContinue

Write-Output ""
if ($fails.Count) {
  foreach ($f in $fails) { Write-Output "FAIL  $f" }
  Write-Output ("RESULT: FAIL ({0} problems)" -f $fails.Count)
  exit 1
}
Write-Output "RESULT: PASS  control reached $($control.LastReportedMB) MB and printed DONE; capped stopped at $($capped.LastReportedMB) MB against a $CapMB MB ceiling"
exit 0
