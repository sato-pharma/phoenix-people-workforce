<#
  Re-run ONE test on the spare in seconds instead of a whole CI run (owner, 2026-11-23: "do spare recommendations 22,
  23 and 25" - #22).
    & ~/.claude/scripts/spare-test-one.ps1 'tests/office-golden-rule-lock.test.ts'    # a test file
    & ~/.claude/scripts/spare-test-one.ps1 runOfficeGoldenRuleLockTests               # its run function
    & ~/.claude/scripts/spare-test-one.ps1 'golden rule'                              # words from its FAIL line
    & ~/.claude/scripts/spare-test-one.ps1 'golden rule' -Path 'F:\...\_wt-foo'       # from another checkout
  It goes through spare-test.ps1 unchanged: THIS checkout's exact state (commits, edits, new files) sent as one patch,
  the spare's test lock, a fresh folder checked to the byte, no .env.local, the folder removed after. Only the command
  differs: instead of loading all 2,246 test files (tests/run-tests.ts, ~8 s of imports per part, then the suite) it
  writes a small harness into the run folder that imports the ONE file and awaits its exported run...Tests functions,
  with the permission matrix seeded before each, exactly as runTest does. A name matching several tests runs them all
  (at most 10). Exit code: 0 all passed, 1 a test failed, 4/5 as spare-test.ps1.
  Not the gate: CI's run of the whole suite still decides. A test that depends on another test's side effect can pass
  alone and fail in the suite (and the other way round) - the suite is the truth.
#>
param([Parameter(Mandatory, Position = 0)][string]$Test, [string]$Path = (Get-Location).Path)
$ErrorActionPreference = 'Continue'
$runner = Join-Path $Path 'tests\run-tests.ts'
if (-not (Test-Path -LiteralPath $runner)) { throw "no tests\run-tests.ts under $Path - run it from a Phoenix checkout or give -Path" }
$src = Get-Content -Raw -LiteralPath $runner
# every import: function name -> file
$imports = @{}
foreach ($m in [regex]::Matches($src, 'import\s*\{([^}]*)\}\s*from\s*"\./([^"]+\.test\.ts)"')) {
  foreach ($fn in ($m.Groups[1].Value -split ',')) { $f = ($fn -split '\s+as\s+')[-1].Trim(); if ($f) { $imports[$f] = $m.Groups[2].Value } }
}
# every runTest call: name -> function. Three shapes the first pattern missed, found 23 Nov 2026 (it matched 1,406 of
# 3,167 calls): a trailing comma after the function (`runX,\n);`, about half the file), a name in single quotes, and a
# name split across lines with `+`. The name is every literal piece, joined.
$lit = '"(?:[^"\\]|\\.)*"|''(?:[^''\\]|\\.)*''|`[^`]*`'
$calls = foreach ($m in [regex]::Matches($src, "runTest\(\s*((?:$lit)(?:\s*\+\s*(?:$lit))*)\s*,\s*(\w+)\s*,?\s*\)")) {
  $name = -join ([regex]::Matches($m.Groups[1].Value, '"((?:[^"\\]|\\.)*)"|''((?:[^''\\]|\\.)*)''|`([^`]*)`') |
    ForEach-Object { $_.Groups[1].Value + $_.Groups[2].Value + $_.Groups[3].Value })
  [pscustomobject]@{ Name = $name; Fn = $m.Groups[2].Value }
}
$pick = @()
if ($Test -match '\.test\.ts$') {
  $file = ($Test -replace '\\', '/') -replace '^(\./)?(tests/)?', ''
  $pick = @($calls | Where-Object { $imports[$_.Fn] -eq $file })
  if (-not $pick) { throw "tests/$file is not called from tests/run-tests.ts (a test not registered there never runs - see the add-test skill)" }
} elseif ($Test -match '^run\w+$') {
  $pick = @($calls | Where-Object { $_.Fn -eq $Test })
} else {
  $pick = @($calls | Where-Object { $_.Name -like "*$Test*" })
}
if (-not $pick) { throw "no test in tests/run-tests.ts matches '$Test'" }
if ($pick.Count -gt 10) { throw "'$Test' matches $($pick.Count) tests - give more of the name, the file or the run function" }
$list = foreach ($p in $pick) { if (-not $imports[$p.Fn]) { throw "$($p.Fn) is called but its import was not found" }; '{0}|{1}' -f $imports[$p.Fn], $p.Fn }
Write-Output ("Running {0} test(s) on the spare:" -f $pick.Count); $pick | ForEach-Object { Write-Output "  - $($_.Name)" }
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($list -join "`n")))
$harness = @'
import { seedPermissionMatrixWithDefaultsForTests } from "../src/lib/auth/permissions.ts";
process.env.PHOENIX_TEST_SUITE = "1";
const wanted = Buffer.from(process.env.PHX_ONE ?? "", "base64").toString("utf8").split("\n").filter(Boolean);
let failed = 0;
for (const line of wanted) {
  const [file, fn] = line.split("|");
  const t0 = Date.now();
  try {
    const mod = await import(`./${file}`);
    if (typeof mod[fn] !== "function") throw new Error(`${fn} is not exported by tests/${file}`);
    seedPermissionMatrixWithDefaultsForTests();
    await mod[fn]();
    console.log(`PASS ${fn} (tests/${file}) in ${Date.now() - t0} ms`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${fn} (tests/${file}) in ${Date.now() - t0} ms`);
    console.log(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
}
console.log(`spare laptop: ${wanted.length - failed} of ${wanted.length} passed`);
process.exitCode = failed ? 1 : 0;
'@
$hb64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($harness -replace "`r", '')))
$cmd = "echo $hb64 | base64 -d > tests/.spare-one.ts && PHX_ONE=$b64 node --experimental-strip-types --experimental-specifier-resolution=node --import ./tests/register-alias-loader.mjs tests/.spare-one.ts"
$t = [Diagnostics.Stopwatch]::StartNew()
# 700 MB, not the suite's 2 GB: one file's imports, not a whole part - room even beside a running preview.
& "$PSScriptRoot\spare-test.ps1" $cmd -Path $Path -MinFreeMb 700
$code = $LASTEXITCODE
Write-Output ("spare laptop: finished in {0:n0} s, exit {1}" -f $t.Elapsed.TotalSeconds, $code)
exit $code
