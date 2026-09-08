# Render each sheet of a workbook to a PNG, through Excel itself.
#
# WHY THIS EXISTS. The Monthly Closing workbook must be visually inspected before it is handed over,
# and this repository has three documented ways of LOOKING at a generated workbook that lie
# (AGENTS.md 2.1): LibreOffice's "--convert-to png" renders only the leftmost columns, an ExcelJS
# load-and-save "review copy" silently drops the merges, and "--convert-to html" rebuilds a pivot
# from its declared source on every load, so a stale cache renders fresh. Excel itself is the only
# renderer that shows what the reader will see.
#
# HOW, AND WHY IT IS THIS EXACT RECIPE. Four combinations were measured before one worked:
#
#   Appearance  Format     Window                Result
#   xlScreen    xlBitmap   ScreenUpdating off      705 bytes - blank
#   xlScreen    xlPicture  maximized             2,812 bytes - shapes only, no cells
#   xlPrinter   xlPicture  maximized             2,926 bytes - shapes only, no cells
#   xlScreen    xlBitmap   maximized, sized    206,478 bytes - CORRECT
#
# So: xlBitmap, not xlPicture; a visible maximized window, because xlScreen renders nothing when
# Excel has no painted window; and the chart's size set on the ChartObject AFTER it is created,
# because a chart added at the range's size still exports its own plot area and clips everything.
# A render under ~10 KB is the tell that it went wrong again - the script reports one as UNKNOWN
# rather than handing back a blank page, which reads as an empty sheet.
#
# ASCII ONLY, DELIBERATELY. Windows PowerShell 5.1 reads a BOM-less UTF-8 file as ANSI, so a single
# em dash in a comment breaks the parse with "the string is missing the terminator" pointing at an
# unrelated line 40 lines further down. Keep every character in this file ASCII.
#
# Usage:
#   powershell -File scripts/render-workbook-sheets.ps1 -Workbook <path> -OutDir <dir> [-Sheets a,b]

param(
  [Parameter(Mandatory = $true)][string]$Workbook,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [string[]]$Sheets,
  [int]$MaxRows = 60,
  [int]$MinBytes = 10000
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# Excel refuses a file carrying the mark of the web from an automation context, and the copy keeps
# the original untouched while the renderer scribbles chart objects onto it.
$work = Join-Path $OutDir ("render-src" + [IO.Path]::GetExtension($Workbook))
Copy-Item $Workbook $work -Force
Unblock-File $work -ErrorAction SilentlyContinue

$xl = New-Object -ComObject Excel.Application
$xl.Visible = $true            # xlScreen needs a painted window; see the table above
$xl.DisplayAlerts = $false
$xl.WindowState = -4137        # xlMaximized
$wb = $xl.Workbooks.Open($work)
Start-Sleep -Milliseconds 900

$results = @()
foreach ($ws in $wb.Worksheets) {
  if ($Sheets -and ($Sheets -notcontains $ws.Name)) { continue }
  if ($ws.Visible -ne -1) { continue }   # the veryHidden Data sheet carries no design

  $safe = ($ws.Name -replace '[^A-Za-z0-9]+', '-').Trim('-')
  $path = Join-Path $OutDir ($safe + ".png")
  try {
    $ws.Activate()
    $xl.ActiveWindow.Zoom = 100
    Start-Sleep -Milliseconds 300

    $used = $ws.UsedRange
    $lastRow = [Math]::Min($used.Row + $used.Rows.Count - 1, $MaxRows)
    $lastCol = $used.Column + $used.Columns.Count - 1
    $rng = $ws.Range($ws.Cells.Item(1, 1), $ws.Cells.Item($lastRow, $lastCol))

    $rng.CopyPicture(1, 2) | Out-Null      # xlScreen, xlBitmap
    Start-Sleep -Milliseconds 600
    $cob = $ws.ChartObjects().Add(400, 400, 400, 300)
    $cob.Width = [double]$rng.Width
    $cob.Height = [double]$rng.Height
    $cob.Chart.ChartArea.Border.LineStyle = -4142
    $cob.Chart.Paste()
    Start-Sleep -Milliseconds 350
    $cob.Chart.Export($path, "PNG") | Out-Null
    $cob.Delete() | Out-Null

    $bytes = (Get-Item $path).Length
    $verdict = "ok"
    if ($bytes -lt $MinBytes) { $verdict = "BLANK?" }
    $results += [pscustomobject]@{ Sheet = $ws.Name; Rows = $lastRow; Bytes = $bytes; Render = $verdict }
  } catch {
    $results += [pscustomobject]@{ Sheet = $ws.Name; Rows = 0; Bytes = 0; Render = "FAILED: " + $_.Exception.Message }
  }
}

$wb.Close($false)
$xl.Quit()

$results | Format-Table -AutoSize
$bad = @($results | Where-Object { $_.Render -ne "ok" })
if ($bad.Count -gt 0) {
  Write-Output ("" + $bad.Count + " sheet(s) did not render. A blank page reads as an empty sheet, so treat these as UNKNOWN, not clean.")
  exit 1
}
Write-Output ("all " + $results.Count + " sheet(s) rendered")
