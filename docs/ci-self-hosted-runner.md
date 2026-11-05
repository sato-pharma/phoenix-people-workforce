# CI on a self-hosted runner — BACK ON 2026-11-05 (the owner's spare laptop, or a free Oracle Cloud VM)

## 2026-11-05 — CI moves to a free self-hosted machine, behind one repository variable

🔴 **Read this first. It is the current state. Everything below it — the 2026-10-27 cost section and the
2026-10-19 retirement of the Hetzner box — is now history.**

**What was decided, and why.** The owner decided this on the evening of 5 Nov 2026 (Cairo).
- The repository is on GitHub's **free plan**. November's 2,000 included Actions minutes were used up by 5 Nov (2,018 used).
- The spending limit is **$0**, and there is no money to raise it.
- So GitHub refuses to **start** every hosted job: *"The job was not started because recent account payments have failed or your spending limit needs to be increased."*
- Because the release gate waits for `ci.yml`'s `checks` on the `main` commit, **every production deploy is held** too.
- Minutes on a **self-hosted** runner are not billed, so CI runs on a machine of ours that costs nothing:
  - **The current target: the owner's spare laptop.** An ASUS Vivobook Flip 14 TP470E: Intel 11th gen, x86_64, 8 GB RAM. Windows stays as it is. The runner lives in **WSL2 Ubuntu 24.04** on it.
  - **The alternative:** an Oracle Cloud **"Always Free"** Ampere A1 VM: ARM64, Ubuntu 24.04, 4 OCPU, 24 GB.
- This reverses the 2026-10-19 decision ("make all ci actions to be on github"). GitHub-hosted minutes are no longer affordable, and that is the only reason.

**The switch is ONE repository variable, `CI_RUNNER_LABEL`.**
- Every switchable job reads `runs-on: ${{ vars.CI_RUNNER_LABEL || 'ubuntu-latest' }}`.
- **Set to `phoenix-ci`:** every one of those jobs runs on our machine, `main` included.
- **Unset (deleted):** the expression falls back to `ubuntu-latest`, and CI is exactly what it was before.
- The variable is set by hand, only after the runner shows **Idle** on the Runners page. Nothing sets it automatically.
- 🔴 **A label that matches no ONLINE runner does not fall back. The job QUEUES, with nothing red, for up to a day.** If the machine is off, asleep or signed out, either bring it back or **delete the variable**. The next run is then GitHub-hosted again (and, while the minutes are spent, refused again).

**What stays on GitHub's own runners, and why.** These keep the literal `ubuntu-latest` with a `# hosted-only:` comment on the line. `HOSTED_ONLY` in `tests/ci-runner-switch.test.ts` lists them.

| Workflow | Job | Why it cannot move |
| --- | --- | --- |
| `fallback-image.yml` | `image` | Builds the amd64 production image with Docker. Our machines have no Docker, and on ARM64 it would build an image Railway and Fly.io cannot run. |
| `emergency-host.yml` | `gate` | Reads the image registry with Docker. |
| `emergency-host.yml` | `standby` | Pulls and pushes the amd64 image with Docker. |
| `headwind-image.yml` | `build` | Builds the amd64 tablet-server image with Docker, which Railway builds as amd64. |

Because none of the switched jobs uses Docker, `services:` or `container:`, our machines get no Docker.

**What was made to work on both CPU types (x86_64 and ARM64).**
- **gitleaks** (`security-scan.yml`, `Install gitleaks`) picks the `linux_x64` or `linux_arm64` asset from `RUNNER_ARCH`. Each asset has its own pinned checksum, taken from the release's own checksums file.
- **The Playwright browser caches** (`ci.yml` `validate` and `full-e2e`, `synthetic-journeys.yml`) carry `runner.arch` in the key. Without it, an x64 Chromium restored onto ARM64 counts as installed and then cannot launch.
- **The pnpm store key** already carried `RUNNER_ARCH`.
- **Native packages** (Next's SWC, sharp, `@napi-rs/canvas`, lightningcss, Tailwind's oxide, the Supabase CLI) all have `linux-arm64` builds in `pnpm-lock.yaml`.
- **Semgrep** 1.171.0 publishes a `manylinux_2_34_aarch64` wheel.
- **The setup script** picks `actions-runner-linux-x64` or `actions-runner-linux-arm64` from the CPU. Each has its own pinned SHA-256 from GitHub's release notes. The Node fallback tarball is checked against nodejs.org's `SHASUMS256.txt`.

### Route A — the spare laptop (WSL2), the current target

**What the laptop needs, always.**
- **It stays plugged in.** The Windows step stops it sleeping or hibernating on the charger. On battery, Windows' own settings still apply.
- **The lid stays open, or closing it does nothing.** The Windows step sets "lid close: do nothing" for when it is plugged in.
- **After a Windows restart, someone must sign in once.** The runner starts from the Startup folder at sign-in, not at boot.
- **One runner.** WSL is capped at 5 GB of the 8 GB, with 8 GB of swap, so Windows keeps 3 GB. A pull request's five jobs run one after another. That is slower than GitHub's runners, but it bills nothing.
- **Nothing else on the laptop is touched.** The Windows step writes only `%UserProfile%\.wslconfig` and a launcher in your own Startup folder, and changes the power plan. No other drive is read or written. Your photos on D: and the other drives are never touched.

**Before the two blocks.** In PowerShell, run `wsl --install -d Ubuntu-24.04`. Restart Windows if it asks. Open "Ubuntu 24.04" and create your Linux user and password.

**Step 1 — paste this ONE block into the Ubuntu window.**

```bash
rm -rf /tmp/phx-setup && sudo apt-get update && sudo apt-get install -y gh git && gh auth login --hostname github.com --git-protocol https --web && gh repo clone Omar-3-xx/phoenix-people-workforce /tmp/phx-setup -- --depth 1 --branch codex/free-ci-runner && bash /tmp/phx-setup/scripts/setup-self-hosted-runner.sh https://github.com/Omar-3-xx/phoenix-people-workforce
```

- **It asks for your Linux password**, for `sudo`.
- **`gh` shows an 8-character code.** Open https://github.com/login/device in Windows, sign in as the repository owner, and type the code.
- **If `gh` asks a yes/no question**, press Enter for the default.
- **The token is handled for you.** The script then asks GitHub for the runner registration token through `gh` itself, so nothing secret is pasted, shown or saved.
- **Passwordless `sudo`.** It gives your Linux user passwordless `sudo`, because a CI job cannot type a password. This applies inside this Ubuntu only; Windows is not affected.
- **Everything else it installs.**
  - Node 24, git, the PostgreSQL client and Playwright's Chromium libraries.
  - **one** runner service, `phoenix-ci-<laptop>-1`, labelled `self-hosted,linux,x64,phoenix-ci`.
  - It adds no swap file inside Ubuntu: under WSL the swap is the `swap=` line of `.wslconfig`.
- **If systemd is off** (Ubuntu 24.04 has it on by default), the script switches it on in `/etc/wsl.conf` and stops. Run `wsl --shutdown` in PowerShell, open Ubuntu again, and paste the same block again.
- **The Windows drives are switched off inside Ubuntu.** The script stops WSL mounting them inside this Ubuntu, so a CI job cannot see C:, D: or anything on them. This takes effect when Step 2 restarts WSL.
- `--branch codex/free-ci-runner` is needed only until PR #40 merges. Afterwards, drop those two words.
- `rm -rf /tmp/phx-setup` at the front clears an earlier attempt, so the block can be pasted again.

**Step 2 — paste this ONE block into a normal Windows PowerShell window (not "Run as administrator").** It downloads nothing. It is exactly `scripts/setup-spare-laptop-windows.ps1`:

```powershell
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
```

What it does, in order:
1. **`.wslconfig`.** It writes `[wsl2] memory=5GB processors=<all logical CPUs> swap=8GB vmIdleTimeout=-1` into `%UserProfile%\.wslconfig`. Every other line already in that file is kept.
2. **Power, on the charger only** (`powercfg`): never sleep, never hibernate, and closing the lid does nothing.
3. **The Startup launcher.** It writes `phoenix-ci-wsl.vbs` into your own Startup folder (`shell:startup`). At every sign-in it runs `wsl.exe -d Ubuntu-24.04 --exec /bin/sh -c "sleep infinity"` with no window. That keeps WSL, and with it the runner service, up.
4. **The restart.** It runs `wsl --shutdown` (this closes the Ubuntu window) so the 5 GB cap applies. It then starts the launcher and prints the runner service's state, which should read `active running`.

**Does anything need admin? No, normally.**
- `.wslconfig` and the Startup folder are your own files.
- `powercfg /change` and `/setacvalueindex` on the active power plan work for a standard user unless a company policy locks the power plan. If one is refused, the block prints which one in yellow. Set it instead in Settings → System → Power & battery (plugged in: sleep **Never**) and in Control Panel → Power Options → "Choose what closing the lid does" (plugged in: **Do nothing**).
- Only `wsl --install` itself, done before these blocks, needed admin.

**Step 3 — switch CI onto the laptop.** When the runner reads **Idle** at https://github.com/Omar-3-xx/phoenix-people-workforce/settings/actions/runners:

```bash
gh variable set CI_RUNNER_LABEL --repo Omar-3-xx/phoenix-people-workforce --body phoenix-ci
```

Roll back at any time with `gh variable delete CI_RUNNER_LABEL --repo Omar-3-xx/phoenix-people-workforce`.

**Known limit of the laptop.** The production build's compile step peaked near 6.9 GB on GitHub's runners. Under a 5 GB cap it leans on swap, so a `main` push's `validate` can run longer than on GitHub. If `validate` starts hitting its `timeout-minutes: 20` on `main`, that is the cause. Raising the timeout is a `ci.yml` change.

### Route B — an Oracle Cloud "Always Free" VM (the alternative)

1. **Create the VM.** Oracle Cloud, shape `VM.Standard.A1.Flex`, 4 OCPU / 24 GB, image Ubuntu 24.04 (aarch64). Give the boot volume 100 GB or more; the free allowance is 200 GB.
2. **On the VM, as the normal `ubuntu` user,** paste the same Step 1 block as the laptop.
   - The script detects ARM64 and registers **two** runners, labelled `self-hosted,linux,arm64,phoenix-ci`. `RUNNER_COUNT=1` in front of `bash` registers one.
   - It adds an 8 GB `/swapfile`.
   - Oracle's `ubuntu` user already has passwordless `sudo`.
3. **No Windows step.** Switch CI with the same `gh variable set` line once the runners read Idle.

**Safety.**
- The repository is **private**, so only accounts with access can make a workflow run on our machine.
- 🔴 **If it is ever made public, remove the runners first.** On a public repository a fork pull request could run code on the machine.
- The machine holds no secrets of its own. A job's secrets reach it only for the length of that job, exactly as on a hosted runner.
- On the laptop, a job runs inside WSL as your Linux user. The script switches off WSL's mounting of the Windows drives inside this Ubuntu (`[automount] enabled=false` in `/etc/wsl.conf`) and the appending of Windows' PATH, from the next WSL restart. So no CI job can reach C:, D: or the photos on them.

**Pinned by `tests/ci-runner-switch.test.ts`.** The test fails in any of these cases:
- a job reads anything but the exact switch expression;
- a `HOSTED_ONLY` job loses its literal or its `# hosted-only:` reason;
- a `HOSTED_ONLY` entry no longer names a real job;
- `CI_RUNNER_LABEL` is read anywhere but on a `runs-on` line;
- the retired `CI_SELF_HOSTED` is read anywhere;
- a step branches on `runner.environment == 'self-hosted'`;
- the setup script loses either CPU type or its pinned SHA-256, or any line could print the token;
- the Windows block in this document stops matching `scripts/setup-spare-laptop-windows.ps1`.

## What CI costs now, and the guards that hold it (2026-10-27)

**History since 2026-11-05 — the section above is the current state.** Until then this was the state, and the box sections further down were already history.

**Why the bill doubled and CI felt slow.** These are minutes measured from every job, 10–27 Oct; the dollars
come only from GitHub's own billing amounts (the rule below, "The invoice is the only authority").
- **The 19 Oct split doubled the minutes.** The CI split of 19 Oct 18:13 took each run from 4 billed jobs to 8.
  - The median billed minutes per run went from 9 to 16.
  - The number of runs stayed about the same, ~137 a day.
  - So the daily minutes went from **1,189 to 2,397**.
  - Nothing pinned the job count or the cost per run, so nothing failed.
- **Where the 21,575 minutes of 19–27 Oct went:**
  - PR CI took 53%; push CI on `main` took 39%.
  - 146 of the 412 pushes to `main` re-tested a tree already green on its PR, 3,172 minutes. Tree reuse measures this and never skips; the owner looks again on 9 Nov ("Tree reuse", below).
  - Rounding each job up to a whole minute added 24%. `checks` runs a median 0.3 min and `release-gate` 0.1 min, and each bills 1.
- **"Very slow" was GitHub stopping Actions over billing or the spending limit:**
  - It stopped on 5 Aug, 23 Aug, 27 Sep (120 runs failed to start) and 12 Oct.
  - Each stop froze CI. Production deploys only once `validate` and `checks` pass (the release gate), so each stop also held every deploy, silently.
  - The cache was also over its cap (10.47 of 10 GB), which slowed every job. It was fixed 26 Oct; the old pull-request caches expire about 2 Nov.
- **The budget on the new account** (`it-gawish-hr`, read back 27 Oct) is $300 a month, with "Stop usage when budget limit is reached" ON and alerts at 75, 90 and 100%. Whether to change it is the owner's, on github.com/settings/billing/budgets, never a session's.

**The guards, each failing loud rather than silent:**

| Guard | Where | What makes it fire |
| --- | --- | --- |
| The job ledger, `CI_JOBS_BY_EVENT` | `tests/ci-runner-switch.test.ts` | A job, a matrix leg or a trigger added to `ci.yml` without the ledger and a dated billed-minutes note. Today: PR runs `validate`, `static`, `unit (1)`, `unit (2)`, `checks` (13.86 billed min/run); a push to `main` adds `release-gate` and `mobile` (19.36); a dispatch is 6 jobs, with `full-e2e` only when asked. |
| The scheduled-run ceiling, `SCHEDULED_RUNS_CEILING` | `tests/github-workflow-validity.test.ts` | Seven scheduled workflows start 55 runs a day, and 6 dispatched ones make 61. A new cron or a faster one fails until the count and a dated note are updated. |
| The daily cost alarm, step `actions_cost` | `scripts/check-actions-cost.mjs`, in `secret-drift-check.yml` | It reads the billing usage API's own amounts, projects the month against `vars.ACTIONS_MONTHLY_BUDGET`, and pings Telegram with the day the budget would be reached. Exit 2, "cannot tell", is never a pass. |
| The token-expiry alarm, step `token_expiry` | `scripts/check-token-expiry.mjs`, same workflow | It warns 21 days before `PHOENIX_ACTIONS_DISPATCH_TOKEN`, `GHCR_PULL_TOKEN` or `ACTIONS_BILLING_READ_TOKEN` expires, and reports a dead one at once. It prints names and dates only. |
| No alarm is swallowed | `tests/scheduled-alarms-never-withhold.test.ts`, clause 12 | A `continue-on-error` step that the Notify step's `if:` does not name. |
| The Railway keys are tried apart | `scripts/lib/railway-cli-credentials.mjs`, `tests/railway-cli-credentials.test.ts` | A CLI step that merges `RAILWAY_API_TOKEN \|\| RAILWAY_TOKEN` into one value again. |
| Railway watches this owner | `scripts/check-railway-deploy-triggers.mjs` | A source or a deploy trigger on any owner but `GITHUB_OWNER`, in `RAILWAY_PROJECT_ID` or any of `vars.RAILWAY_PROJECT_IDS`. |

**The Railway key fix (27 Oct).**
- **The fault:** the two CLI scripts, `validate-railway-production-secrets.mjs` and `sync-railway-production-secrets.mjs`, merged `RAILWAY_API_TOKEN || RAILWAY_TOKEN` into ONE value.
- **What it broke:** a workspace key and a project key kept breaking each other.
  - 21–23 Oct: the workspace key failed the CLI check.
  - 23 Oct: a production-only project key fixed the check and broke the fallback rehearsal.
  - 27 Oct, 14:27 Cairo: the workspace key came back, which fixed the rehearsal and broke the check again.
- **The fix:** each secret is now tried under its own name. `RAILWAY_TOKEN`'s value is tried as a project key and `RAILWAY_API_TOKEN`'s as a workspace key, and each attempt prints its first error line.
- **If the project key in `RAILWAY_TOKEN` is dead,** the first run says so by name. A new production project key goes into `RAILWAY_TOKEN`, and the workspace key stays for the rehearsal.

**Not decided here, the owner's:** the budget amount; GitHub Enterprise and the move into the `Phoenix-Sato-Pharma`
organization (only after he buys the paid plan); turning tree reuse into a skip.

> 🔴 **THE CI BOX IS RETIRED AND EVERYTHING BELOW ABOUT IT IS HISTORY.** Owner, 2026-10-19: *"make all ci actions to be on github and be able to make checks on one or more or ten or even 100 at the same time … as fast as you can safely without skipping any check"* and *"retire the hetzner box and do not use it … it is the source of slowness"*.
>
> **What runs now.** Every job in `ci.yml`, `security-scan.yml` and `lockfile.yml` runs on GitHub-hosted `ubuntu-latest`, written as a literal; `tests/ci-runner-switch.test.ts` fails a workflow that names anything else. No `CI_RUNNER_LABEL`, no `CI_SELF_HOSTED`, no runner registration, and `scripts/setup-self-hosted-runner.sh` is deleted.
>
> | `ci.yml` job | Does | Waits for |
> | --- | --- | --- |
> | `validate` (required name) | the production build and the Playwright login smoke | nothing |
> | `static` | the `check:*` contracts, `pnpm audit`, ESLint, `next typegen`, the type gate, the tree-reuse dry run | nothing |
> | `unit` | the unit suite, 2 parallel jobs of 2 shards each (3 until 2026-10-23), every test in exactly one shard | nothing |
> | `checks` (required name) | the gate: green only when `static` and `unit` are `success` and the parts' coverage records add up to every test the runner declares | `static`, `unit` |
> | `mobile`, `full-e2e` | unchanged | nothing |
>
> Nothing is skipped: every step that ran before still runs, on the same events, in exactly one of these jobs. The wall clock is now the slowest single job instead of the sum of the steps that used to share one. Several PRs run side by side with no queue of ours — the only ceiling is GitHub's concurrent-job cap for the plan (Free 20, Pro 40, Team 60, Enterprise 500).
>
> **`scripts/remote-check.mjs` asks GitHub.** It needs the commit on origin, reads that commit's PR run by sha (`--dispatch` starts a `ci.yml` run) and grades each stage from the jobs' own steps. The retired `--wait`, `--no-wait`, `--free`, `--no-actions` and `--else-actions` flags are refused by name. `remote-check lockfile` dispatches `lockfile.yml` and writes both files back.
>
> **Capabilities that changed.** The pre-push `remote-check test` for a push that ADDS a test file is gone — GitHub runs only a commit origin already holds; `node scripts/check-contracts.mjs` (~8s) plus the PR's parallel `unit` jobs replace it. `phx-live` and `phx-preview` went with the box.
>
> **Not decided, his call:** deleting the Hetzner server (money, his click in the provider's console); building the production Docker image in CI and deploying that digest on Railway (changes the deploy path); moving the repository into a GitHub organization (larger runners, a higher concurrency cap). The sections below describe the box era; read "the box" as "retired".

Why this exists, how to turn it on, how to turn it off, and the rules that keep it safe.

## The measurement that motivated it

Measured 2026-09-27 against the live account and the Actions API:

🔴 **THE INVOICE IS THE ONLY AUTHORITY ON THE MONEY, AND MEASURED MINUTES MUST NEVER BE CONVERTED
INTO ONE.** On 2026-09-27 a session measured every job of the month, multiplied by GitHub's published
$0.008/min, and reported **~$559** for September. The owner's answer: *"I never paid this value. The
maximum value I paid is the September value"* — **$300.88, the highest Actions invoice he has ever
paid.** The invoice is real money; the derivation was arithmetic on top of an assumed rate and an
assumed allowance. **The invoice wins.**

**The gap is roughly 2x and is NOT explained.** Three candidate causes were tested and all three
failed, so do not re-run them: queue time inside a job's `started_at` accounts for only **2.6%**;
**zero** jobs of 25 September ran on a self-hosted runner (all 1,235 were GitHub-hosted); and
excluding zero-duration skipped jobs changes nothing. Even billing the raw unrounded wall clock
(2,615 min that day instead of 3,230) still lands well above the invoice. The rate that would
reconcile is ~$0.0043/min, almost exactly half the published Linux rate — which points at a plan
allowance, a spending cap or a discount that **cannot be read from here: the billing endpoints need a
`user` token scope no session has.**

🔴 **So the rule is: measure MINUTES, report MINUTES, and anchor every dollar to the invoice.** A
session that converts minutes to money will overstate it and be contradicted by the owner, who is the
only one who can see the bill.

| | |
| --- | --- |
| **September invoice — the anchor** | **$300.88** (owner, the most ever paid) · August $240.77 |
| Measured billable job minutes, 25 Sep, `ci.yml` | **3,230** (3,624 across all workflows) |
| `ci.yml` runs, 09-01..09-26 | **4,304** (2,657 `pull_request` · 1,647 `push` · ~8 dispatch) |
| Billable minutes per full run | **14** before #4527 · **10.9** after |
| **Owner's target** | **$60/month TOTAL** — not a $60 saving (owner, 2026-09-27) |

**The minute measurement is reproducible and internally consistent** — a model built from real
per-day run counts predicts 3,233 billable `ci.yml` minutes for 25 September against **3,230
measured**, and 3,628 across all workflows against **3,624**, 0.1% out on both. Trust it for
*ratios*, which is what it is for. Never for a monthly total.

14 billable minutes for 4m33s of wall clock, because **GitHub bills each job separately and
rounds every job UP to a whole minute** (measured on run `36277556391`: validate 273s→5,
typecheck 196s→4, test 139s→3, lint 50s→1, mobile 8s→1).

GitHub charges **$0/minute for self-hosted runners** — you pay only for the machine. That is a fixed
cost which does not climb with the commit rate, against a metered one that does.

🔴 **BUT CAPACITY IS SPENT IN RUNNER-SECONDS, NOT IN BILLABLE MINUTES, AND THE TWO ARE 35% APART.**
This document previously concluded that one ~$12 8 GB VPS "covers 37,610 outright" by comparing
billable minutes against a machine's wall clock. They are different quantities: GitHub's ceil-per-job
rounding inflates what it CHARGES above the work actually done, while a self-hosted box owes only the
work. Measured over every job of 25 September: **3,858 billable minutes against 2,850 runner-minutes
of real work — 35.4% of the bill is rounding.** That gap is exactly where the saving comes from; it is
also why the capacity sum must use the smaller number.

At September's average volume with post-#4527 per-run cost, real demand is **~1,650 runner-minutes a
day**. A 2-vCPU box supplies 1,440 a day *at 100% utilisation, serially* — which no CI runner reaches,
because a run wants its four jobs concurrent and peak days are twice the average. So the honest
requirement is **two to three boxes, not one**, and the ~$12 single-VPS figure was never achievable.
Two 4-vCPU instances give **8 concurrent job slots**, which is the shape that matters: ~4 slots
covers steady demand, so 8 leaves roughly 2x headroom and turns a 6-run burst from about half an hour
of queueing on three slots into about ten minutes.

🔴 **CORRECTED 2026-09-28 — THIS PARAGRAPH CARRIED THE COST AT ~€27/MONTH FOR THE PAIR, AND THE ORDER
TABLE BELOW SAYS ~€35.49 EACH.** That is **~€71/month**, a 2.6x understatement, in the one paragraph
someone would decide the purchase on. It is almost certainly the pre-increase price: Hetzner's rose
about 170% on 15 June 2026, which is why the order table already says to re-read rather than trust it.
**I could not confirm a current figure** — hetzner.com renders its prices client-side, so the public
page yields nothing readable, and the authenticated console is the only authority. **Read the price in
the console before buying; treat both numbers in this file as stale.**

The second figure was wrong in a quieter way. "~11,500 runner-minutes a day of headroom" is 8 slots x
1,440 minutes — the theoretical ceiling at 100% utilisation, which the sentence two lines above says no
CI runner reaches. Usable is more like 7,000-8,000, against demand of ~1,650. The conclusion does not
change; the word "headroom" for a ceiling is what made it read as spare capacity.

🔴 **AND THIS IS THE ONLY LEVER THAT REACHES THE OWNER'S $60/MONTH TOTAL.** Against the $300.88
invoice, $60 is an **80% cut**. #4527's per-run saving is 16.5%; driving re-pushes from 1.61 runs per
PR to a perfect 1.0 adds ~20% more; together they land near $190, not $60. **No combination of
pipeline tuning and push discipline gets there** — only taking the per-minute price to $0 and paying
a fixed machine cost instead, which two 4-vCPU boxes do at roughly half the target. Say that plainly
rather than offering another trim. 🔴 **But this is arithmetic, not a recommendation: the owner
refused that purchase on 2026-09-28 (*"I WILL NOT BUY THIS"*).** It stands as the reason $60 is out of
reach on metered minutes, and never as a case for buying the boxes.

**This is a separate lever from [#4527](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/4527)**,
which merges `lint`+`typecheck`+`test` into one job and cuts ~14% off every run. They compose:
fewer billable minutes per run, and those minutes billed at $0.

## Why the volume is what it is

The pipeline is already tuned close to its limit. **The spend is driven by how many times it runs,
and that is self-inflicted by how agent sessions ship.** Measured 2026-09-27:

| | |
| --- | --- |
| Pushes to `main`, 7 days | **338** (~48/day) — each a full CI run |
| PRs merged, 7 days | **≥100** (query capped at 100) |
| PRs touching **≤3 files** | **41%** |
| PRs changing **≤50 lines** | **23%** |
| Billing per shipped change | **~28 billable minutes** (≈14 on the PR + ≈14 on the merge to `main`) |

A three-file change costs the same ~28 minutes as a three-hundred-file one, because billing is
per-job-rounded-up, not per-line. `AGENTS.md` §0 records the shipping pattern — "~46 commits/day,
6.7 files per commit" — as a neutral fact about how this repo is run; at $0.008/minute it is also
the single largest line in the bill.

**The rule this produced** (owner, 2026-09-27: *"you make many prs and many merges you can wider the
contact of the pr to make less merges"*) is in `AGENTS.md` §6 under Git hygiene: batch related work
into one branch and one PR, and push fixups in fewer, larger commits — concurrency cancels
superseded PR runs, so two pushes a minute apart bill twice and verify once.

Still split when the parts need **separate approval** (a migration, a locked file, a protected rule)
or when one part is urgent and the rest is not. Never split merely because it reads tidier.

This composes with everything below: fewer runs, each cheaper (#4527), each billed at $0 (the
runner).

### 🔴 A feature arriving in instalments is still ONE feature — owner, 2026-09-29

*"batch the next feature into one PR, not six"*. This is the second ruling on the same bill, and it
exists because the first one did not bite: the rule above says **batch related work**, and a session
can satisfy it honestly on every single PR while still shipping a feature in six pieces — because
each piece really was one coherent change when it was asked for.

**The arc that produced it, measured.** The one-press seat hire, all on 2026-09-29:

| PR | Merged (Cairo) | Files | Lines |
| --- | --- | --- | --- |
| #4723 an open seat opens Add Employee already filled in | 12:12 | 10 | +454/-6 |
| #4727 the same one-press hire on every open report row | 12:22 | 4 | +97/-1 |
| #4731 the one-press hire on the portal page | 12:41 | 5 | +175/-10 |
| #4736 a seat hire can pick the candidate from recruitment | 12:54 | 5 | +529/-3 |
| **#4740 pins this very rule** | **13:31** | **3** | **+34/-1** |
| #4743 the SFE can download a CV from the seat popup | 14:41 | 1 | +58/-1 |
| #4746 a greyed "No CV on file" on a seat holding none | 15:18 | 4 | +334/-48 |
| #4748 carry a candidate CV onto an already-hired employee | 15:53 | 6 | +783/-5 |

🔴 **The rule was pinned at 13:31 Cairo and the splitting carried straight on through it** — three
more that afternoon, then five more that evening on the same offer→seat→hire chain (#4751 18 files,
#4761 11, #4772 1, #4783 4, #4787 5). **A rule in `AGENTS.md` did not change the behaviour**, which
is why the hook now names the specific shapes to hold: the same mechanism on another surface, a
follow-up named in the same breath, and a pin of a ruling just given.

**Why it keeps happening — two mechanisms, only one of them obvious.** The owner asks for surfaces
one at a time, because that is how the need occurs to him; each request genuinely reads as its own
small change. The second is avoidable and is the real defect: **a new PR gets opened rather than
widening one that already carries his `merge <n> when green`**, out of a misplaced reluctance to
touch an approved PR. That reluctance is now explicitly overruled — widening a PR his approval sits
on is allowed, provided it is said plainly and he is given the chance to re-confirm.

**What one merge actually costs, measured on #4787 rather than assumed:**

| Run | Billable |
| --- | --- |
| PR `ci.yml` (checks 5.40 → 6, validate 4.92 → 5, mobile 0.17 → 1) | 12 |
| PR secret-scan | 1 |
| `main` CI on the merge commit | 12 |
| **One merge of a 5-file PR** | **25 billable minutes** |

That confirms the ~28 figure above from live data, and it is per *merge* — the file count changes
nothing, because every job is rounded up to a whole minute.

🔴 **Every `secret-scan` row in this section and the next is a run that can no longer happen — read
them as history, not as today's bill.** #4787 merged 2026-09-29 17:05 UTC and #4800 took
`secret-scan` off `pull_request` at 19:14 UTC the same evening, so `security-scan.yml` now fires
only on its daily schedule (05:17 UTC then, 20:17 UTC since 2026-10-16) and on dispatch. A pull request runs `ci.yml` and nothing else
(verified on #5005, 2026-10-01: one workflow run on the head). Subtract those minutes and the same
merge today is **24**, the branch below **38**, **50** in all. The point the measurement was taken
to make — the cost is per *merge*, not per file — is untouched.

🔴 **And the fixup half is worse than the merge half.** Every run on `codex/col-agreement`, the
branch behind #4787:

| Head | Workflow | Result | Billable |
| --- | --- | --- | --- |
| `6038b494f` | CI | **failure** | 9 |
| `b56dc2ab7` | CI | cancelled by concurrency | 5 |
| `c941994dc` | CI | **failure** | 12 |
| `dbc065145` | CI | success | 12 |
| (4 × secret-scan) | | success | 4 |
| | | **branch total** | **42** |

**54 billable minutes with `main`'s own run — for one 5-file PR whose clean cost is 25.** The
concurrency cancel worked exactly as the rule above promises, saving ~7 minutes on one push. But
**21 minutes went on two full red runs**, and both reds were defects a local run of the *one*
failing test catches in seconds: a test reading a property the type does not have (invisible locally
because the suite strips types rather than checking them), and a line shape the heredoc-backslash
sweep rejects. **Running the specific failing test locally is not "a local full validation" and is
not banned by §7** — it is the cheapest thing in this document.

**What counts as one feature**, operationally: if the next instruction is plainly the same mechanism
on another surface, a follow-up named in the same breath, or a pin of a ruling just given, it is the
same feature — hold it, and say in one line that you are holding so he can override. Splitting stays
right when the parts need **separate approval** (a migration, a locked file, a protected rule) or
when one part is urgent and the rest is not.

**Never convert these minutes into a monthly bill.** Doing that overstated September by roughly 2x;
the invoice is the only authority and the owner read it as **$300.88**. Measure minutes, report
minutes.

### 🔴 A roll-up must be merged before its members — measured 2026-09-30

AGENTS.md §6 already said not to merge a roll-up's members separately. What it did not say is how
long you have, and the answer turned out to be **about three minutes**.

**The arc, all on 2026-09-30, Cairo:**

| | |
| --- | --- |
| 12:59 | `rollup-prs.mjs` names #4910 + #4909 + #4907 — 3 merges → 1, ~56 billable minutes |
| ~13:16 | `--apply` builds it, #4911 opens, and **a comment is left on each member** warning it off |
| 13:17:55 | **#4910 merged separately** — 90 seconds later |
| 13:18:55 | **#4909 merged separately** |
| 13:2x | #4911's `validate` passes and `checks` goes red — on #4907's *own* typecheck, byte-identical on its own run |
| — | #4911 closed: one unmerged member left, so it replaced no merges. One CI run spent, none saved |

That morning #4814 had already gone the same way, four minutes after roll-up #4821 was built and
commented on. **Three members lost across two roll-ups in one day.**

**So the comment is a courtesy, not a guard.** Three sessions were each told in writing on their own
PR and each merged anyway — not carelessness: a session reads its PR as green and its instruction as
"merge it", and a comment is not something GitHub enforces. Nothing available makes it one.

**What follows, and why it is NOT "wait for green".** An earlier reading of this day put the window
at about ten minutes and concluded a roll-up should be built once its members went green. That is
backwards — by the time they are green they are minutes from being merged. Build it the moment the
tool names one and put it to the owner in the same turn; `--apply`'s own 25-minute members-checks
wait, added the same day, already covers the risk of building over an unfinished member, so there is
nothing left to wait for.

### 🔴 The other end of that gap: a roll-up ships the sha it was BUILT from — measured 2026-10-02

The section above is about a member merging before the roll-up. This is the mirror image: the member
stays open, but **pushes a new commit**, and the roll-up merges the one it snapshotted.

`--apply` is not careless about shas. Its build loop takes a last look at each member's head
immediately before merging it into the branch and **skips** one that moved, precisely so the branch
is only ever made of commits whose required checks and file sets were measured. What it cannot do is
keep looking after the branch is pushed — and that is where the approval lives.

**The arc, 2026-10-02 (UTC):**

| | |
| --- | --- |
| 20:54:51 | `--apply` builds roll-up #5191 from #5188's head `4df18d572` |
| 20:58:41 | #5188's own session pushes `f93c220e8` — *"my own fix made every click a no-op — pass functions, not strings"* |
| 21:02:38 | and `d8226fbf1`, restoring four import blocks a regex edit had swallowed |
| 21:12:41 | **#5191 merges, carrying `4df18d572`** — the commit its author had replaced 14 minutes earlier |
| 21:1x | #5188 reads `DIRTY / CONFLICTING`: `main` now holds the squash of its own first commit |

Two things made this worse than a stale merge. First, **what shipped was a fix that does nothing** —
the carried commit passed its in-page function to `page.evaluate` as a *string*, which puppeteer
evaluates as an expression, so the body never runs; it was wrapped in `.catch(() => {})`, so it
failed silently. Second, **a conflicted PR gets no CI run at all**, so #5188 could not go green again
on its own: the required checks sat on "Expected" and the branch had to be rebuilt by hand.

`--settle` was the only thing that noticed, and only indirectly: it declined to call #5188 `carried`
because its files genuinely differed from `main`. **That disagreement — the roll-up's body listing a
member that `--settle` will not call carried — is the tell.**

**The fix, live 2026-10-03.** The carried sha is now written into the body beside each member
(`- #5188 — title (3 files) @ 4df18d572…`), which keeps it in the one place that cannot drift from
the branch, and two readers compare it against the live head:

- `node scripts/rollup-prs.mjs --verify-heads` — read-only, exit **3** when a member has moved.
- `bash-guard.mjs` **C13**, second clause — refuses `gh pr merge` of a roll-up whose member has been
  pushed since, because *a comment on a PR is not enforcement* applies here exactly as it did above.

Both fail open: a body with no recorded sha (built before this shipped) and a head that could not be
read are **UNKNOWN, never stale**, so neither can block a merge on the guard's own blind spot. A
stale roll-up is **rebuilt, not merged** — `gh pr close <n>` then `--apply`, with its members still
open and nothing lost. Pinned by `tests/rollup-member-guard.test.ts`.

🔴 **And if the members land first, close the roll-up — never merge it.** It then replaces no merges,
and its files are byte-identical on `main`, which is the `carried` verdict: merging is an empty
squash paying a full `main` run to ship nothing. `--settle` is the right ending, and
`tests/rollup-prs.test.ts` §4b exists because the script once proposed rolling an already-carried PR
up a second time.

**The day did end with the mechanism working.** At 16:01 another session's roll-up, #4917, carried
two PRs cleanly and `--settle` closed the originals 55 seconds after it merged. The difference was
the members-checks wait landing in between.

### 🔴 The second shape: the member goes green INSIDE the wait, and the owner's approval is already in hand — measured 2026-10-01

Everything above is about a session merging a member it was told not to. This one is not
carelessness and no comment could have caught it, because **the roll-up PR did not exist yet**: it
was still inside `--apply`'s own 25-minute members-checks wait. Neither clause in AGENTS.md §6
reaches that window — one says *do not merge a member once a roll-up is **open***, the other says
*build it the moment the tool names one*. Between those two sentences there is a gap of up to 25
minutes, and the owner's approval lands in it by construction.

**The arc, 2026-10-01, Cairo:**

| | |
| --- | --- |
| 05:51 | `rollup-prs.mjs` names #5047 + #5043 — 2 merges → 1, ~28 billable minutes |
| ~05:52 | `--apply` starts; no roll-up PR exists yet, it is waiting on both members' checks |
| 05:52 | the session puts **#5047** to the owner, who answers `merge 5047 when green` |
| 05:55 | #5047 goes green; #5043 is still running, 23 minutes left of the wait |
| 05:56 | **#5047 merged** on that standing approval |
| 05:5x | the roll-up opens as #5048 carrying a member already on `main`; #5043 is merged separately anyway; #5048 closed as `carried` |

**Two merges where the tool had just offered one.** No work was lost and nothing broke — the cost is
purely the bill.

🔴 **The rule, and it is about what the session QUOTES, not about what the owner types.** Once
`--apply` is running, the next-step box must name **the roll-up**, never a member — and a member
going green first is the trigger to *wait*, not to merge. A session that has already quoted a
member's number holds the approval the moment that member goes green, so the only thing standing
between the tool's offer and two merges is whose number was put in front of him. This is the one
guard that works here, because it acts before the approval exists rather than trying to withdraw it
afterwards: the comment on a PR could not help, and neither could `--settle`.

**The honest trade, so nobody over-corrects.** Holding a green member for up to 25 minutes is not
free either — it spends the owner's turns, and his standing rule is that triaging PRs is never his
job. So hold it *silently*: say in one line that a roll-up is building and carry on, rather than
asking him to decide between the two numbers. If the wait expires without a roll-up, the member's
own merge is still there to put to him.

## 🔴 Where the money actually is — and why the run COUNT lies

**Counting runs gives the wrong answer, and a session acted on it.** On 2026-09-27 the owner was told
manual re-runs were "26% of the bill, ~$78/month" because they are ~26% of the *runs*. They are
**3.9% of the minutes**. The correction matters because the obvious cost lever — "stop re-running CI"
— is worth about **$12/month**, not $78, and chasing it would have cost more effort than it saved.

🔴 **AND A SAMPLE LIES TOO.** The shares below were first measured over 240 runs and were wrong by
enough to matter. These are counted from **every run of 09-01..09-26**, per event, with per-run cost
measured over a full day:

| trigger | runs | share of CI minutes | avg billable min/run |
| --- | --- | --- | --- |
| `pull_request` | 2,657 | **60.5%** | 12.8 |
| `push` to `main` | 1,647 | **39.5%** | 13.5 |
| `workflow_dispatch` | ~8 | **~0.0%** | 1.2 |

Dispatch is a **rounding error** — not the 3.9% a sample showed, and certainly not the 26% a run count
showed. September holds about eight of them in total.

🔴 **The trap that produced every wrong figure in this document: the Actions runs API caps at 1,000
rows and truncates the OLDEST silently.** Four separate wide queries came back with *exactly* 1,000
rows and looked like complete months. Count the rows; if the answer is exactly 1,000, narrow the
window and query again.

**`ci.yml` is 89.1% of the whole Actions bill** — 3,230 of 3,624 billable minutes across every run of
every workflow on 25 September, a full day rather than a tail of recent runs. Security Scan is 6.3% at
1.3 min/run, Synthetic Journeys 2.1%, everything else under 1.5% each. **Nothing outside `ci.yml` is
worth touching.**

Two more facts that close off the obvious ideas:

- 🔴 **1.61 CI runs per PR, and 1,652 PRs in 26 days — THE LEVER IS THE 1,652, NOT THE 1.61.**
  Counted over the whole month: 2,657 `pull_request` runs across **1,652 distinct branches**. The
  earlier "2.18 runs per PR" came from a 50-branch sample and overstated the re-push waste; on
  2026-09-27 the measured figure was **1.27**, close to the floor of 1.0. So push discipline is
  nearly exhausted as a saving: driving 1.61 to a perfect 1.0 would reclaim ~$103/month and demands
  that no PR ever gets a second push. **Sixty-four PRs a day is the actual cost driver**, which is
  what the ONE WIDE PR rule attacks — batching five narrow PRs into one saves four PR runs *and*
  four `main` runs, roughly ten times what a re-push costs.
- **`main` gets exactly one run per commit** — 51 commits, 51 runs, zero duplicates. No waste there.

🔴 **And `main`'s 39.5% is no longer waste at all — it is the price of the production deploy gate.**
Railway's Wait for CI reads the check suites on the pushed commit, so removing `push: main` from
`ci.yml` to save that ~$197 would silently un-gate production. See [deployment.md](deployment.md),
"The deploy gate". **That leaves the runner as the only lever that cuts the bill without cutting
safety** — which is the whole argument of this document.

### Reproducing the measurement

GitHub's own `/timing` endpoint returns `{"billable":{}}` while an account is payment-restricted, so
these figures were computed from per-job wall clock with **ceil-per-job** applied, the way GitHub
charges:

```bash
gh run list --workflow=ci.yml --limit 240 --json databaseId,event \
  --jq '.[] | "\(.databaseId)|\(.event)"' |
while IFS='|' read -r id ev; do
  m=$(gh api "repos/Omar-3-xx/phoenix-people-workforce/actions/runs/$id/jobs" \
    --jq '[.jobs[] | select(.started_at != null and .completed_at != null)
           | ((.completed_at|fromdateiso8601) - (.started_at|fromdateiso8601)) / 60 | ceil] | add // 0')
  echo "${m:-0}|$ev"
done | awk -F'|' '{s[$2]+=$1; n[$2]++; t+=$1} END {for (e in s) printf "%7d min %5.1f%% %3d runs %s\n", s[e], 100*s[e]/t, n[e], e}'
```

The sample window is short — 240 runs was ~27 hours on that day. **Trust the shares, not a monthly
projection from them**, and anchor the money to the real invoice.

## 🔴 THE DECISION: the runner goes on Railway — owner, 2026-09-27

*"Railway's own compute maths came out around $95/month ok accepted."* So the host is a Railway
container, not the owner's laptop and not a rented VPS.

**The arithmetic, with its assumptions attached — this is an ESTIMATE, not a quote.** Railway's
published standard-compute rates, converted from per-second, billed on actual usage rather than
allocation:

| | rate | per month |
| --- | --- | --- |
| memory | $0.00000386 / GB / sec | **$10.14 per GB** |
| vCPU | $0.00000772 / vCPU / sec | **$20.29 per vCPU** |

Workload, corrected to measured runner-second demand rather than to billable minutes:
**~1,650 runner-minutes/day ≈ 835 busy hours/month** at September's average volume. At ~2 vCPU and
~4 GB while busy: ~$44 CPU + ~$44 memory + ~$8 idle across replicas ≈ **$95** — but that buys ONE
box's capacity, and the section above establishes the requirement is two to three. 🔴 **At ~$95 per
box Railway does NOT reach the owner's $60 total, and two of them are three times it** — a flat-rate
VPS does, which is why the comparison matters and why Railway's metered compute is the wrong shape for
this job even though it is the platform already in use.

🔴 **MEMORY WAS THE ASSUMPTION NOBODY HAD MEASURED, AND THE FIRST REAL ATTEMPT FAILED ON IT.** A
Railway-hosted runner rollout on 2026-09-27 (`CI_RUNNER=self-hosted`, set 20:01:18Z) failed `validate`
reproducibly on two different runners, in the Build step, with an identical signature:

    OS can't spawn worker thread: Resource temporarily unavailable (os error 11)
    fatal runtime error: failed to initiate panic, error 5, aborting

Runs `36346183612` and `36346466953`; the failing **jobs** inside them are `108695670880` and
`108696483287`. 🔴 **Those two were labelled "job ids" here until 2026-09-28, and that mislabel costs
real time: `gh api actions/jobs/36346183612/logs` returns EMPTY with no error**, which reads as "the log
expired" rather than "wrong id". A second job on that rollout printed every test as PASS and
then took `The runner has received a shutdown signal`, which is a replica cycling mid-job, not a test
failing. Rolled back with `gh variable set CI_RUNNER --body ubuntu-latest` at 20:04:38Z; set it
explicitly rather than deleting it, so the repo variables still read safe.

🔴 **THE HEADING ABOVE AND THE SENTENCE "SO THE ~4 GB FIGURE IS TOO LOW" WERE BOTH MINE, AND BOTH ARE
WRONG — MEMORY IS NOT IMPLICATED AT ALL.** I read `os error 11` as a memory/pids cap and passed that on
before looking at the rest of the log. The build **succeeds**; the abort comes afterwards, and the line
before it names the real cause:

```
✓ Compiled successfully in 40s
Collecting page data using 47 workers ...
OS can't spawn worker thread: Resource temporarily unavailable (os error 11)
```

`next build` sizes that worker pool from the CPUs it can **see**, which inside a container is the
HOST's count — 47 — not the container's allowance, so tokio asks for 47 threads against a far lower pid
limit and gets `EAGAIN`. **Nothing to do with memory, the image, or the code**, and more replicas would
split the same allowance. Memory therefore remains exactly as unmeasured as the table above says:
neither confirmed nor refuted. **Raising the container's memory would not have fixed this.**

🔴 **AND NO ENVIRONMENT VARIABLE CAN CAP IT.** `NEXT_CPUS` was set on the service and the next run
still printed `using 47 workers`. Read from the installed `next@16.3.3`, `dist/build/index.js:371`
takes the count from `config.experimental.cpus` alone. So the cap lives in `next.config.ts` behind
`PHX_BUILD_CPUS`, and `ci.yml`'s Build step passes it **only** when
`runner.environment == 'self-hosted'` — a GitHub-hosted build keeps the key absent and is byte-for-byte
its old configuration, because capping workers on GitHub's 4-core runners would slow every build here
to buy nothing. Pinned by `tests/next-build-cpu-cap.test.ts`, both guards proved by breaking them.

🔴 **A BROKEN RUNNER ROLLOUT TURNS `main` RED, AND THE DEPLOY GATE THEN CORRECTLY PINS PRODUCTION.**
That is the gate working, but it is invisible until somebody reads it, and Railway abandons the
withheld deployment at the two-hour mark with nothing turning red. On 2026-09-27 two commits were
withheld this way. **Never flip `CI_RUNNER` without watching the first `main` run to a verdict**, and
roll back on the first failure instead of debugging while production is held. Quote the range and the
assumption, never the $95 alone.

### Four constraints, each one evidenced

1. 🔴 **LINUX x86_64, NEVER WINDOWS — the day's most expensive lesson.** The `OMAR-GAWISH` runner was
   Windows/X64 and failed **all three jobs in 18–30 seconds**, because every `run:` step here is bash
   and GitHub's default shell on Windows is PowerShell: `set -euo pipefail` becomes
   `Set-Variable : A parameter cannot be found that matches parameter name 'euo'`. A Railway container
   is Linux, so this is satisfied by construction — it is written down anyway, because the next person
   to stand one up by hand on a laptop will hit it again.
2. **A SEPARATE Railway project, not a service beside production.** The safety rules below already say
   the host has repository-level trust and must be treated as production infrastructure; a runner
   executes whatever any workflow tells it to. The Phoenix project is also where cross-service
   `${{...}}` variable references are the documented pattern. And `superb-smile` demonstrated on
   2026-09-25 exactly what an extra project connected to this repo does when nobody is watching it.
3. **2–3 replicas minimum.** A runner takes one job at a time and the work is ~26.6 h per 24 h day, so
   a single runner queues behind itself — which from the outside is indistinguishable from the
   2026-09-27 startup-failure outage. Pro allows 42 replicas at 24 vCPU / 24 GB each, so this is a
   configuration choice, not a ceiling.
4. **The rollback stays ONE command:** `gh variable delete CI_RUNNER`, or set it back to
   `ubuntu-latest`. **Never hard-code `self-hosted` in a `runs-on`.**

### An open question nobody has settled

Railway now sells **Sandboxes** — in its own words, *"isolated Linux VMs for agents, builds, and
untrusted code"* — billed only while running, at roughly $50/GB-month and $50/vCPU-month while
active. That is the product literally designed for untrusted code, and for a bursty CI load it may
beat standard compute or be far worse, depending entirely on how the idle listener is billed. It
could not be settled from the pricing page, and it has not been guessed at. **Price it before
choosing standard compute, and record the answer here.**

### Who does what

Creating the Railway project and service is a **money move on a production surface — the owner's
dashboard click**, per the standard `docs/devices/headwind-rustdesk.md` §4 sets: *a session prepares;
it does not press.* What is ours is the last step only: flipping `CI_RUNNER` once the runner reads
**Idle**, and reverting it the moment anything queues. 🔴 **Do not flip it while zero runners are
registered** — since the `OMAR-GAWISH` deregistration there are none, and jobs do **not** fall back
to GitHub's: `main` runs would queue for ever rather than fail, which under the production deploy
gate means no deploy at all, silently, until Railway abandons it at the two-hour timeout.

## It is BUILT, and two of the three jobs already pass — 2026-09-27

The owner had it built rather than prepared, overriding this document's own "a session prepares, it
does not press". What existed:

🔴 **THE RAILWAY RUNNER PROJECT IS DELETED — 2026-10-01, at the owner's instruction. Nothing in this
section is infrastructure any more; it is the record of an approach that was tried and closed.** It
had been idle since its pool went down on 2026-09-27 (all three replicas `EXITED`, zero GitHub
registrations) while still billing **171.9 CPU units and 8,726 GB-hours** that cycle — more than the
production app's 110.6 / 1,351 — which is why it went. CI runs on GitHub-hosted runners plus the one
Hetzner box (§4's ruling); the box is a preview machine, and `phoenix-ci-ubuntu-8gb-nbg1-1` is the
only self-hosted runner GitHub has registered.

| | |
| --- | --- |
| Railway project | 🔴 **DELETED 2026-10-01** — was `phoenix-ci-runner` `d657a3c0-684c-4e83-88bc-ded47b32a00d` |
| service | `ci-runner` `f6a18a22-1434-4423-95d5-875b88928f9b`, image `ghcr.io/actions/actions-runner:latest` |
| region | EU West `europe-west4-drams3a` — **explicitly scaled there, see the trap below** |
| shape | 3 replicas, runners named `phoenix-ci-<RAILWAY_REPLICA_ID>`, labels `self-hosted,X64,Linux,phoenix` |

Three tested flips, each reverted on anything but success:

| job | result | against GitHub-hosted |
| --- | --- | --- |
| `mobile` | **success**, 33s | — |
| `checks` | **success**, 201s | ~254s hosted — **faster**, and this is the dominant job |
| `validate` | **failure**, 97s | the `Build` step only; steps 1–12 pass. Fixed above. |

🔴 **THE OWNER HALTED THIS TESTING UNTIL THERE WAS A PER-BRANCH SWITCH** — his ruling, typed in another
session's window on 2026-09-28 and relayed here, recorded because it *stopped* an action, which is the
safe direction to err in. The reason is below: a flip cannot be made safe by watching, only by scoping.

✅ **That condition has since been met.** The per-branch switch landed in #4594 (merge `9bde1c3a4`):
the repo-wide `CI_RUNNER` is gone, all six `runs-on` lines compute the runner, and self-hosted is
reachable only from a same-repo `ci-runner/<task>` PR. Verified on `main`'s own run for that merge —
`validate`, `checks` and `mobile` all on `ubuntu-latest`. **Arming it is still a separate decision
and still the owner's**; this file does not record whether the variable is currently set, because that
changes without a commit — read `gh variable list`.

### What the three flips actually established — 2026-09-28

| job | on the runner | against GitHub-hosted |
| --- | --- | --- |
| `mobile` | **success**, 33s | — |
| `checks` | **success**, 201–212s | ~254s hosted — **faster**, and it is the dominant job |
| `validate` | **failure** | `Build` fixed by the CPU cap; then the smoke test, cause below |

🔴 **ONE `validate` PASS ON THE RUNNER IS NOT EVIDENCE — run `36353275114` was docs-only.** Its head
`3dfc8fd8b` changes `docs/observability.md` and nothing else (verified: one file), so `ci.yml`'s
docs-only fast path skipped the build and the Playwright step entirely. The `checks` and `mobile` passes
are real; that one is not. **Check the head's file list before citing any green as progress.**

🔴 **AND THE SMOKE TEST'S CAUSE WAS THE INHERITED `PORT`, NOT ANYTHING ABOUT NEXT.** The runner inherits
its Railway service's whole environment, which sets `PORT=8080`; `next start` and the standalone server
both bind `process.env.PORT`, defaulting to 3000 only when it is unset — true on GitHub's runners, false
here. Measured inside the container: `printenv PORT` → `8080`, and `next start` → `Local:
http://localhost:8080  ✓ Ready in 93ms`. The server was healthy on a port nothing watched.

**Two wrong diagnoses were published before that one, and both are retracted in the code:** `::1`
resolution order (#4570 — changed nothing) and `output: "standalone"` (#4577 — the warning is advisory;
the server serves 93 ms after printing it). **#4577 is nevertheless the fix**, because its
`env: { PORT: "3000", … }` overrides the inherited 8080 — `webServer.env` is spread last over
`process.env` in playwright 1.63 — and #4579 corrects the stated reason. Pinned by
`tests/next-build-cpu-cap.test.ts`, including that the bound port and the polled port are the same
number.

**So the remaining work is not a flip.** It is the per-branch switch the owner asked for; until then
`CI_RUNNER` stays `ubuntu-latest` and the registered runners sit idle.

**Two traps this rollout paid for:**

- 🔴 **`ghcr.io/actions/actions-runner:latest` is BARE — no Node.js** — and `ci.yml` runs
  `Enable Corepack (pnpm)` **before** `actions/setup-node`, so step 4 dies `corepack: command not
  found` (exit 127). Solved in the container's start command (NodeSource Node 24, then
  `corepack enable`, logging `node v24.21.0 corepack 0.36.0` before it registers). That ordering
  assumption in `ci.yml` is invisible until an image without Node runs it.
- 🔴 **A NEW RAILWAY SERVICE IN THIS ACCOUNT IS CREATED IN `sfo`, NOT EUROPE** — the same default that
  put `superb-smile` in the US. `AGENTS.md` §3's "it must stay in Europe" therefore needs an
  **explicit** `railway service scale` on every new service, and the region map printed by the scale
  API is the only place it shows.

**While `CI_RUNNER` reads `ubuntu-latest`, the replicas still bill** — roughly $8/month in idle memory
for three. That is spend producing nothing, and parking them at 0 is a dashboard decision.

## 🔴 When the box is busy: pay for Actions — owner's policy, 2026-10-06, sharpened 2026-10-08
### 🔴 SUPERSEDED THE SAME AFTERNOON: a busy box no longer dispatches by default — 2026-10-08

The owner's performance-recovery plan (approved 2026-10-08, branch `codex/perf-recovery`) changed the
default this section describes: **a busy or unreachable box with no open PR now ends NO VERDICT
(exit 6) and dispatches nothing.** Only an explicit `--actions` or `--urgent` starts a billed
`ci.yml` run. With an open PR the PR's own run is still read by sha, for free, exactly as below.
The reason is the measurement behind the plan: ≥165 BUSY answers in 4-8 Oct, each of which would have
billed ~14 Actions minutes under dispatch-at-once, for a verdict the branch's PR produces on the same
commit a minute later. `parseEscalation` returns `dispatch` (true only on `--actions`/`--urgent`), and
`tests/remote-check.test.ts` §10 and §10e pin both halves.

Three more changes landed with it, each pinned:

- **No heavy work without its lock (FUP-010).** The run used to wait 30 minutes for the box lock and
  then print "running anyway" and start every stage beside the holder — the overlap the lock exists
  to stop, on a box that OOM-killed 7 processes in its first 8 days of uptime. It now waits 120s
  (only the race between the probe and the lock) and then runs NOTHING, exit 9, NO VERDICT. ci.yml's
  typecheck lock fails its step red on timeout instead of running unlocked.
- **A ceiling on every run.** The box runs the script as `timeout --kill-after=30 <N> bash -s`, with
  N summed from per-stage budgets (lint 240s, typecheck 300s, test 720s, build 480s, plus 300s of
  setup); the run's TERM trap removes its tree. The local side gives ssh 90s more, then TERMs and
  KILLs it. Every such ending is NO VERDICT, and PASS needs exit 0 plus a printed PASS line for every
  stage asked for (`tests/remote-check-lint-cache.test.ts`).
- **A persistent ESLint cache.** Box lint took 182s on every run from 2 Oct, because each run's fresh
  tree threw its `.eslintcache` away and file-entry-cache keys entries by absolute path. The cache now
  lives in `<remoteRoot>/eslint-cache/<key>.json` with the run path swapped for a placeholder, keyed
  by the lockfile, manifests, eslint config, tsconfig and node version. Correctness rests on eslint's
  `--cache-strategy content` and its per-entry config hash, not on the rewrite.

### The dispatch route was reading its own run from the list that drops runs — 2026-10-08

`findPullRequestRun` was deliberately written against `gh run list`: that list is eventually
consistent and has dropped a run that existed, so the PR's run is asked for with
`gh api repos/{owner}/{repo}/actions/runs?head_sha=<sha>`. The DISPATCH finder beside it was not
moved at the same time, and kept scanning `gh run list --workflow ci.yml --branch <branch>
--event workflow_dispatch`.

That is the worse of the two places to keep it, because the dispatch route has already spent the
money. The order is: dispatch (~14 billable Actions minutes committed), then poll for the run.
`settleActionsRun`'s `sawRun` latches only on a run the finder actually returned, so a list that
omits the brand-new run for the first three minutes of polling — nine reads at 20s — makes the
watcher exit 6 with:

    remote-check: NO VERDICT — no the dispatched run exists for <sha> after 3 minutes, and a run
    is registered the moment it is created, queued or not.

That sentence is true of the runs API, which is what the finder now asks. It was never true of
`gh run list`, which is what it was asking — so the single message asserting the run cannot exist
was produced by the one reader in the script that can fail to see it, while the dispatched run goes
on to complete, billed and unread.

**The `event` filter is load-bearing and is why the two finders are not one function.** Measured
2026-10-08 on `15bacd57a`: one sha carried both a `pull_request` run and a `workflow_dispatch` run
of `ci.yml`. `stageJobsFor` grades those by DIFFERENT maps, so answering the dispatch route from the
PR's run would reproduce the no-verdict-on-green defect #5475 closed, in the other direction. The
`createdAt >= dispatchedAfter` gate stays for the same class of reason: by-sha alone would happily
return an EARLIER dispatch of the same commit.

**What the no-PR arm gets right, verified against live runs rather than the YAML (2026-10-08).** On
a real `workflow_dispatch` run, `checks`/Lint, `checks`/Typecheck, `checks`/Test and
`validate`/Build are all `success` while `validate`/Test is `skipped` — the exact complement of a
pull request, and `STAGE_JOBS` grades all four requested stages `pass`. Grading that same run with
`STAGE_JOBS_PR` answers `no-verdict` for `test`, which is what makes the two maps demonstrably
non-interchangeable rather than merely declared so. The ordering in `settleActionsRun` — the
whole-run `pass` short circuit sitting above the headSha guard — cannot misfire, because
`gradeActionsRun` compares `headSha` first and returns `no-verdict` for a foreign sha, so the later
guard is defence in depth.



**His words, 2026-10-08:** *"if free use it directly but if busy use github actions."* The original,
2026-10-06: *"in critical situations, let's depend on GitHub Actions; in normal situations we are on
the box to decrease the cost."* This is that policy, implemented in `scripts/remote-check.mjs` rather
than left to each session's judgement.

**The problem it solves, measured the day it was written.** Several sessions share one 7,740 MB box, so
`remote-check` refuses to start a second run — correctly: a `next build` wants ~7.4 GB and dies beside
company. But until that day the refusal was the END of the road, so a session invented a retry loop.
One did, around a finished branch waiting to open its PR: **14 consecutive refusals between 15:26 and
15:43 Cairo — 17 minutes, every one `exit 2`, not one of them reaching the box**, while another
session's `all` held it. Nothing was wrong with the branch, the box or the refusal. The work was simply
parked, and the session had no sanctioned way out.

**The routes out of a busy — or unreachable — box.**

| Invocation | What happens | Cost |
| --- | --- | --- |
| *(no flag)* — the default | the probe asks the box; **busy OR no answer → reads the open PR's own run, or dispatches `ci.yml` at once if there is none**, free → runs on the box | nothing when free, nothing when a PR is read, ~14 billable minutes for a dispatch |
| `--urgent` | the same thing, said out loud — kept as an alias, and still immediate when the knob below sets a wait | ~14 billable minutes, at once |
| `--wait <minutes>` | queues for the box on your own budget, a line each 30 s, then escalates — **wins over `--urgent`'s zero, in either order** | nothing, then ~14 billable minutes |
| `--no-actions` (alias `--free`) | waits **10 minutes** and **never bills** — refuses at the end of the wait | nothing, ever |
| `--no-wait --no-actions` | refuses at once | nothing, ever |
| `PHX_CHECK_WAIT_MINUTES=<0-60>` | the house default for every call in that shell — `=10` restores the pre-2026-10-08 wait-then-escalate | as the number says |

🔴 **THE BOX WHEN IT IS FREE, GITHUB ACTIONS THE MOMENT IT IS BUSY — OWNER RULING, 2026-10-08:** *"i
want to make the run depend on github actions if the self hosted box is busy .. if free use it directly
but if busy use github actions"*. `DEFAULT_WAIT_MINUTES` is therefore **0**: a bare invocation probes the
box and, on a busy answer, dispatches immediately instead of polling first.

🔴 **AND A BOX THAT DOES NOT ANSWER AT ALL TAKES THE SAME ROUTES — his second ruling the same day:**
*"make an unreachable box escalate to Actions too, not only a busy one"*. A failed ssh, or a box that
answers without `PROBE_OK`, used to end the invocation at **exit 2 with no verdict** — on the single
piece of evidence that most argues *for* GitHub Actions, namely that the box cannot be used at all.
`decideBusyAction` now takes `probeKnown` and returns a `reason` of `free`, `busy` or `unreachable`,
and an unreachable box dispatches, polls a budget if one was given (a dropped ssh is often a blip, and
a poll costs nothing), or refuses under `--no-actions`.

🔴 **AND THE PROBE'S OWN `ssh` HAD TO SOFT-FAIL, WHICH IS WHERE THE FIRST ATTEMPT AT THIS WAS WRONG.**
`ssh()` dies on a failed connection, *before* any output is parsed — so a `probeKnown: false` branch on
its own could only ever describe a box that answered and said nothing useful, while a box that was
genuinely **down**, the case he actually named, still ended the invocation in the transport. Measured on
the branch that shipped this: `PHX_CHECK_HOST=127.0.0.1 remote-check test` printed `ssh failed: …
Permission denied` and stopped. The probe now passes `softFail`, gets `null`, and `parseBusyProbe` reads
that as `known: false`. **It is the only call that soft-fails** — a failed ssh around the real run is
still the transport fault that must not wear a verdict (exit 5) — and the test asserts the count is
exactly two (the one-shot probe and the poll loop's), so nobody can extend it to the run. The ssh
reason is still printed either way: a changed host key is the first failure anyone hits here, and it
must never be swallowed into a silent "box busy".

🔴 **THIS DOES NOT WEAKEN THE FAIL-CLOSED PROBE, AND NOBODY SHOULD "RESTORE" IT.** The probe fails
closed so an unreadable answer is never mistaken for an **idle box** — what that forbids is *starting a
run there*, which is what OOM-kills another session's build. `run` remains unreachable from
`probeKnown: false` (section 10b asserts it across every `actions` × `wait` × `waited` combination), so
the invariant is intact; what changed is only that the caller is handed the route that never touches the
box. Two things made it work in practice rather than on paper: **the refusal is now gated on
`plan.action === "refuse"`, not on the run list** — an unreachable box has *zero* runs, so the old
condition skipped the refusal and fell through to the push — and **the escalation banner names which of
the two happened**, because "BUSY" printed about a box that is down sends the reader off to wait for a
run that does not exist.

**What that replaces, and what it costs.** The 2026-10-06 ruling made the default *wait ten minutes, then
escalate* — the same policy with a queue in front of it. The queue was the cheap half of the trade, since
the box bills nothing, and the evidence against it is from the evening it shipped: the box was **three
sessions deep for over 25 minutes**, the ten-minute wait expired into a refusal anyway, and the second
attempt was still waiting when opening the PR overtook it. So the wait bought a session ten idle minutes
and, often enough, the dispatch as well. Paying at once is the owner's call on that trade and it is not
free: **a dispatch is ~14 billable Actions minutes**, and a busy box is common here. `PHX_CHECK_WAIT_MINUTES`
is the knob that buys the waiting back — for one shell, one session or this whole machine — without a code
change, and an unreadable value is **refused** rather than ignored, because an ignored setting runs the
other policy and reports success.

🔴 **`--urgent` IS NOW AN ALIAS, NOT A TIER.** It was 4 minutes while the default refused instantly, then 0
(*"make `--urgent` escalate immediately instead of after 4 minutes"*, 2026-10-06), and the default has now
caught up with it. It is kept because callers and docs already pass it, and because it is the way to say
*immediately* when `PHX_CHECK_WAIT_MINUTES` has set a house wait: **an explicit `--wait <minutes>` wins
over its zero in either order**, so `--wait 6 --urgent` waits six minutes — the zero may never *shorten* a
budget the caller asked for.

🔴 **AND THAT IS WHY `--no-actions` IS LOAD-BEARING RATHER THAN A NICETY — IT IS ALSO THE ONE PLACE THE
WAIT SURVIVES.** `.claude/hooks/push-typecheck-guard.mjs` runs `remote-check typecheck` on **every push**,
where the default would now spend ~14 billable minutes *immediately* on a verdict the PR's own `checks` job
produces anyway — so the guard passes `--no-wait --no-actions` and keeps its instant "NO VERDICT, push
allowed". And because `--free` promises never to bill, a zero wait there would turn it into that same
instant refusal under a flag that says it waits: `FREE_WAIT_MINUTES` keeps the ten-minute poll on the one
path where polling is the only route to a verdict. `tests/remote-check.test.ts` section 10b pins the
default, the `--free` wait, the flag-beats-knob ordering and the hook's exact argument list; each was
watched firing on its own break. **Any other per-push or per-commit caller added later must opt out the
same way.**

**Why a wait is allowed at all, when the refusal's own comment argued against queueing.** The objection
was never to waiting — it was to waiting *silently*: a 30-minute `flock` on the box reads as a hang. Every
poll prints the runs it is waiting for and how much budget is left, so a quiet terminal still means
something is wrong. That is what makes `--wait` and `--free` safe to keep now that neither is the default.

**Why the Actions fallback verifies the sha twice.** `gh workflow run` takes a **ref**, not a commit, so
it checks whatever origin holds for that branch. The script compares `git ls-remote origin
refs/heads/<branch>` to the local commit **before** dispatching, and `gradeActionsRun` refuses any run
whose `headSha` is not that commit **after**. Without both, a forgotten push turns "my code is green"
into a statement about somebody else's commit. Pushing the branch to make them agree costs nothing:
`ci.yml` triggers on `pull_request` and on a push to `main` only, so a feature-branch push runs
nothing.

**It refuses to pay twice.** If the branch already has an open PR, that PR is already running the same
two required jobs on the same commit, and a dispatch beside them would bill a second round for one
answer. 🔴 **Until 2026-10-08 that arm printed `gh pr checks <n> --watch` and exited 6 — NO VERDICT,
with a free, already-paid-for answer sitting on that very commit.** Survivable while the box was waited
out for ten minutes first, because the arm was rare; the same day's ruling made a busy box escalate at
ONCE, so it became the common ending, and by the time anything is pushed most branches HAVE a PR. The
owner's answer: *"make the open-PR refusal read that PR's checks instead of exiting 6"*. It now polls
that run and produces a real **PASS / FAIL**, for **no Actions minutes at all** — reading is `gh api`.
So the rule of thumb is simply: **ready to open the PR → open it, and `remote-check` will read it**; not
ready → run it bare and let a busy box dispatch.

**Reading a PR's run takes a DIFFERENT job map, and that is the whole subtlety.** `ci.yml` puts the unit
suite in `validate` on a pull request and in `checks` on every other event (exact complements, pinned by
`tests/ci-suite-placement.test.ts`), and **a pull request never builds at all.** Measured on #5471's own
green run, 2026-10-08:

| Job | Lint | Typecheck | Test | Build |
| --- | --- | --- | --- | --- |
| `checks` | success | success | **skipped** | — |
| `validate` | — | — | **success** | **skipped** |

So grading that all-green PR with the dispatch map would have read `test` from `checks` / Test =
`skipped` → **NO VERDICT**: the same defect wearing a new hat. `STAGE_JOBS_PR` grades `test` in
`validate`, and `build: null` says out loud that a PR cannot answer for the build — `remote-check all`
on a branch with a PR reports the three stages that passed and NO VERDICT for the build, instead of
inheriting a pass from two green checks. Which map is used is read off **the run's own `event`**
(`stageJobsFor`), never off the route that asked: the same sha can carry a PR run and a dispatched run
at once. Both routes settle through **one** watcher (`settleActionsRun`), so there is a single
allow-list, and a whole-run `success` is a short circuit only when that run ran every stage asked for
(`stagesNotRunBy`) — otherwise a green PR would print PASS for a build that never happened.

**The PR's run is asked for BY SHA** (`gh api .../actions/runs?head_sha=…`, filtered to `ci.yml` and the
`pull_request` event), never scanned from `gh run list`, which is eventually consistent and has dropped a
run that existed — here that would read as "the PR has no verdict" on a commit that had already passed,
and send the reader to bill a dispatch for an answer they already had.

**And a run that never appears is given up on in 3 minutes, not 25.** A run object exists the moment it
is created, queued or not, so "no run at all" never becomes a run by waiting — and the arm this replaced
had exactly one virtue, that it ended at once.

**The verdict is allow-listed, never deny-listed.** Only `completed/success` passes and only
`completed/failure` fails; `cancelled`, `timed_out`, `skipped`, `neutral`, `action_required`,
`startup_failure` and every unfinished status are **NO VERDICT** (exit 6), which is a retry and never a
green. This repo has already lost a day to the other shape — a watcher that `continue`d on a deny-list
of unfinished states met a 422 body, matched none of them, fell out of its loop and printed its success
line.

**Exit codes.** `0` pass · `1` fail · `2` refusal (nothing ran) · `3` the tree moved · `4` OOM, no
verdict · `5` transport, no verdict · **`6` the Actions route gave no verdict**. Only `0` and `1` are
verdicts; an automated chain retries the rest.

Pinned by `tests/remote-check.test.ts` section 10, in the required `validate` job: the default still
refuses, the escalation never spawns a heavy runner locally, the open-PR short circuit sits BEFORE the
dispatch and **settles that PR's run rather than exiting 6**, its run is asked for by sha, both sha
guards are asserted, there is exactly **one** watcher, and **both job maps are checked against `ci.yml`
for the event each one grades** — including the proof that `build: null` is still true, so the day a
pull request starts building, that test fails instead of answering NO VERDICT for ever.

## 🔴 The safety rules

1. **PRIVATE REPOSITORIES ONLY.** A self-hosted runner executes whatever a workflow tells it to.
   On a **public** repo, anyone opening a fork pull request runs arbitrary code on the host.
   `phoenix-people-workforce` is private, so only accounts with repository access can trigger it —
   the case GitHub's own guidance considers acceptable. **If this repo is ever made public, remove
   the runner first.**
2. **Never on the owner's laptop.** `AGENTS.md` §5 records that the 16 GB machine already
   hard-freezes under a build plus a dev server. A CI runner there guarantees it.
   🔴 **This happened.** On 2026-09-27 a runner named `OMAR-GAWISH` (`self-hosted, Windows, X64`)
   was registered and online, and with `CI_RUNNER=self-hosted` it took the jobs — see rule 2b for
   what that did. Deregister it: `gh api -X DELETE repos/Omar-3-xx/phoenix-people-workforce/actions/runners/<id>`,
   and on the machine `cd C:\actions-runner && .\config.cmd remove`. A registered runner is not
   idle — it competes for every job the moment the variable points at it.
2b. 🔴 **THE RUNNER MUST BE LINUX. A WINDOWS RUNNER FAILS EVERY JOB IN SECONDS, AND LOOKS HEALTHY
   DOING IT.** Every `run:` step here is bash; GitHub's default shell on a Windows runner is
   PowerShell, which cannot parse `answer() { … }` or `[ "$X" = "y" ]`. Measured 2026-09-27 on
   PR #4537: all four required checks failed in 11–25 s with `An expression was expected after '('`
   and `Missing type name after '['`, from
   `C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.EXE`. Nothing reports "wrong OS" — the
   runner shows `status: online`, the checks simply go red, and the failure reads like a broken
   branch. **Under the production deploy gate this is far worse than a red PR:** every `main` run
   would fail in seconds, so Railway would withhold every deploy and then skip it at the two-hour
   timeout with nothing red to explain why (`deployment.md`, "The deploy gate", failure modes 1 and
   3). `scripts/setup-self-hosted-runner.sh` is an Ubuntu script and refuses anything else; the
   `runs-on` label must resolve to a **Linux x86_64** host, and a runner registered any other way
   must be deregistered rather than left online.
3. **The host has repository-level trust.** Anything in `.env` on that box, and any credential the
   workflows use, is reachable by any job. Treat it as production infrastructure: no shared logins,
   SSH keys only, firewall everything except SSH out.
4. **The registration token is short-lived** (~1 hour) and is never written to disk by the setup
   script. It is not a long-term secret, but do not paste it into chat or commit it.

## Turning it on

The workflows do **not** hard-code `self-hosted`, and since 2026-09-28 they do not read a
repo-wide `CI_RUNNER` either. All six `runs-on` lines — four in `ci.yml`, two in
`security-scan.yml` — are byte-identical and read:

```yaml
runs-on: ${{ (vars.CI_SELF_HOSTED != 'off' && vars.CI_RUNNER_LABEL != '' && github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && startsWith(github.head_ref, 'ci-runner/')) && vars.CI_RUNNER_LABEL || 'ubuntu-latest' }}
```

**Self-hosted is opt-in PER BRANCH: push `ci-runner/<task>` and that PR runs on the label; every
other branch, and `main`, runs hosted.** Each condition earns its place:

| condition | why |
| --- | --- |
| `vars.CI_SELF_HOSTED != 'off'` | a one-word kill switch that does not require remembering the configured label |
| `vars.CI_RUNNER_LABEL != ''` | **nothing is baked in.** A job whose label matches no online runner does **not** fall back — it QUEUES, for ever, with nothing red. An unset variable therefore means hosted |
| `github.event_name == 'pull_request'` | **`main` can never be self-hosted.** main's CI *is* the production deploy gate, so a runner that fails or queues there stops shipping |
| `head.repo.full_name == github.repository` | same-repo only — a fork PR on a self-hosted runner is arbitrary code execution on our own machine |
| `startsWith(github.head_ref, 'ci-runner/')` | the opt-in is the branch **name**, so there is nothing to flip and nothing to remember to revert. It also cannot change mid-flight, unlike `vars.*`, which are re-resolved on every new run **attempt** |

🔴 **WHY THE LABEL IS A VARIABLE AND NOT `self-hosted`, MEASURED 2026-09-28.** `runs-on: self-hosted`
matches **every** self-hosted runner on the repo, so it can never mean "the box I provisioned" — and a
label that matches no online runner **queues for ever** rather than failing. When this switch was
written every runner here carried the same four labels (`self-hosted,X64,Linux,phoenix`), so nothing
could be targeted deliberately at all.

✅ **That has since been fixed at the owner's instruction (2026-09-28): the Railway replicas now also
carry `railway-eu`**, kept alongside their existing labels rather than replacing them, so nothing that
targeted them before broke. Verified live — three runners, all online, all carrying
`self-hosted,X64,Linux,phoenix,railway-eu`. **So `CI_RUNNER_LABEL=railway-eu` names that pool on
purpose, and the switch is provable end to end without new hardware.** A future Hetzner box takes its
own label and is selected the same way.

🔴 **Do not quote a runner COUNT from this or any doc.** It read **ten** and then **three** inside the
same hour on 2026-09-28: the Railway replicas register non-ephemerally, so stale registrations pile up
after each redeploy until someone clears them, and a session that had just written "ten" was stale
within the hour. Read `gh api repos/<repo>/actions/runners` and compare the label **sets**. Register a new host with its own extra label and name that label here:

```bash
# on the host, BEFORE running the setup script
export RUNNER_LABELS=self-hosted,linux,x64,phoenix,hetzner
```
```bash
# then point the switch at it — and note this does NOT turn anything on by itself:
# only a same-repo ci-runner/<task> PR is eligible
gh variable set CI_RUNNER_LABEL --body hetzner    # or railway-eu, which already exists
```

🔴 **DO NOT READ THE CURRENT SWITCH STATE FROM THIS FILE — read `gh variable list`.** These are
repository variables: they change without a commit, so any value written here is a snapshot that
begins rotting the moment it is written. This paragraph used to assert *"neither variable is set
today, deliberately"*, and it went false about twenty minutes later, when `CI_RUNNER_LABEL` was set
to `railway-eu` on the owner's instruction (2026-09-28T00:22:00Z). A session reading it would have
believed every job was hosted while `ci-runner/` PRs were already going to the replicas. The file had
been wrong about a live value twice that night — the other was the cost figure, corrected in #4607.

| what `gh variable list` shows | what it means |
| --- | --- |
| `CI_RUNNER_LABEL` **unset** | every job hosted, whatever the branch — the switch cannot fire at all |
| `CI_RUNNER_LABEL` **set** | a same-repo `ci-runner/<task>` PR runs on that label; `main`, dispatches, schedules and every other PR stay hosted |
| `CI_SELF_HOSTED=off` | kill switch, wins over everything, takes effect on a new run **attempt** |

✅ **A DATED MEASUREMENT IS SAFE TO WRITE DOWN HERE; A CURRENT VALUE IS NOT** — which is why the
evidence below stays and the state above does not. On 2026-09-28, **with `CI_RUNNER_LABEL` already
armed**, dispatch `36362005374` put `validate`, `checks` and `mobile` on `ubuntu-latest` while the
replicas sat idle, and PR #4599 took all four required checks on the replicas including the Playwright
login smoke test. Both arms of the prefix condition, demonstrated on real events rather than computed
from the expression. Those readings are true for ever because they carry their date; "the label is
set today" is not.

**Arming it is the owner's call**, and *the label existing is not the same thing as the switch being
on* — that sentence stays true whatever the variables happen to read today.

`scripts/setup-self-hosted-runner.sh` defaults `RUNNER_LABELS` to `self-hosted,linux,x64,phoenix` —
byte-identical to what the Railway replicas carry — so the override is the whole point. Deregistering
those replicas is **not** a prerequisite and does not work as one: the service re-registers a replica
whenever one cycles, so `gh api -X DELETE .../runners/<id>` is a loop, not a fix. Stopping that
project is the owner's dashboard decision.

`PHX_BUILD_CPUS` is unaffected — it gates on `runner.environment == 'self-hosted'`, which is true on
any self-hosted runner whatever its labels.

**The rollback is `gh variable set CI_SELF_HOSTED --body off`**, and because `vars.*` are re-resolved
on a new run attempt, `gh run rerun --failed` then rescues a stuck `ci-runner/` PR.

1. Provision a host — Ubuntu 22.04/24.04, **x86_64, 8 GB RAM minimum** (`ci.yml` runs typecheck
   with `--max-old-space-size=6144`, and the build peaks around 4 GB), ~40 GB disk.
2. Get a registration token: **Settings → Actions → Runners → New self-hosted runner**
   (`/settings/actions/runners/new`). 🔴 **That is a short-lived token, NOT a PAT** — this path stores
   no credential at all, which is why deleting the `phoenix-ci-runner` PAT on 2026-10-01 left it
   untouched. Only the retired Railway container pool needed a PAT; see the table under the
   2026-09-29 stand-down below.
3. On the host:
   ```bash
   git clone https://github.com/Omar-3-xx/phoenix-people-workforce
   cd phoenix-people-workforce
   export RUNNER_TOKEN=...
   bash scripts/setup-self-hosted-runner.sh
   ```
   It installs Node 24 + corepack/pnpm, Playwright's **system** libraries (the browsers themselves
   are still downloaded and cached per run by `ci.yml`), registers the runner and installs it as a
   systemd service so it survives reboot.
4. Confirm it shows **Idle** at `/settings/actions/runners`.
4b. 🔴 **Confirm the OS before flipping the variable, and that NO other runner is registered** —
   this is the step whose absence cost PR #4537 a full red cycle on 2026-09-27 (safety rule 2b):
   ```bash
   gh api repos/Omar-3-xx/phoenix-people-workforce/actions/runners \
     --jq '.runners[] | {name, os, status, labels: [.labels[].name]}'
   ```
   Every row must read `"os": "Linux"`. A `"Windows"` row will take the jobs and fail all of them in
   seconds, and `status: online` tells you nothing about whether it can run bash.
5. Point the switch at the label you gave it — **never at `self-hosted`**, which matches every
   self-hosted runner on the repo:
   ```bash
   gh variable set CI_RUNNER_LABEL --repo Omar-3-xx/phoenix-people-workforce --body 'hetzner'
   ```
   This alone turns nothing on: only a same-repo PR from a `ci-runner/<task>` branch is eligible.
   `main`, dispatches, schedules and every other PR stay hosted.
6. Open a PR from a `ci-runner/<task>` branch and watch that run end-to-end before trusting it —
   including which machine took each job (section D below).

## Click by click — from nothing to a proven runner

Ported from PR #4583 (`codex/runner-label-guard`), which was closed once the per-branch switch landed:
its `CI_RUNNER` instructions were superseded, but this procedure was not, and it is the half that
matters when there is hardware on the desk. Reconciled with the switch, so the variable names here are
the live ones.

The numbered steps above assume a host that already exists and a shell that is already non-root.
🔴 **Hetzner's Ubuntu image logs you in as `root`, and `setup-self-hosted-runner.sh` refuses to run as
root** (`[ "$(id -u)" -ne 0 ] || die`) — so the procedure above stops dead at that line with the
servers already bought. **Step B2 is the missing step.**

🔴 **THIS ORDER WAS REFUSED AND THE SECTION IS KEPT ONLY AS COSTED RESEARCH — DO NOT ACT ON IT AND
DO NOT RE-PITCH IT.** The owner's answer on 2026-09-28 was *"I WILL NOT BUY THIS"*, about exactly this
pair at €70.98/month. It stays in the document because the price research, the region trap and the
root-login trap below all cost real work to establish and would otherwise be re-derived — not because
anything is pending. **Self-hosted CI already runs on the existing Railway pool** (the switch above);
nothing here is required for that.

**A — order (browser, `console.hetzner.com`), IF it is ever revisited.** Prices read from Hetzner's own
data 2026-09-28; they rose about 170% on 15 June 2026, so re-read them rather than trusting this table
later.

| field | value | why |
| --- | --- | --- |
| **Add server** | in the project, **Servers** → **Add server** | |
| Location | **Nuremberg (NBG1)** | EU. `sfo` is the default for a new service elsewhere in this account — not here, but check it |
| Image | **Ubuntu 24.04** | the script installs Node 24 itself |
| Type | **Shared vCPU · AMD · CPX32** — 4 vCPU, 8 GB, 160 GB, 20 TB | about €35.49/mo each. **NOT CPX31** — US-only, 3 TB, far dearer |
| Networking | leave **Public IPv4 + IPv6** on | the runner needs outbound only, but SSH in is how you set it up |
| SSH key | **add your public key** | without one Hetzner emails a root password, which is worse in every way |
| Volumes / Firewalls / Backups / Placement | skip | a runner holds no state worth backing up |
| Name | `phx-ci-1` | `RUNNER_NAME` defaults to `phoenix-ci-$(hostname -s)`, so distinct names give distinct runners — which is what makes step D readable |
| quantity | **2** if the console offers a count, otherwise repeat for `phx-ci-2` | |

**B — on EACH box.** B2 is the step the old procedure was missing.

```bash
# B1  from your machine, as root (Hetzner's default)
ssh root@<server-ip>

# B2  make a non-root sudo user and give it your key — the script REFUSES to run as root
adduser --disabled-password --gecos "" phx
usermod -aG sudo phx
install -d -m 700 -o phx -g phx /home/phx/.ssh
cp /root/.ssh/authorized_keys /home/phx/.ssh/authorized_keys
chown phx:phx /home/phx/.ssh/authorized_keys && chmod 600 /home/phx/.ssh/authorized_keys
exit

# B3  back in as that user
ssh phx@<server-ip>
git clone https://github.com/Omar-3-xx/phoenix-people-workforce
cd phoenix-people-workforce

# B4  the label override — the whole point of the section above
export RUNNER_LABELS=self-hosted,linux,x64,phoenix,hetzner

# B5  a registration token, valid about ONE HOUR, from
#     /settings/actions/runners/new  (get a fresh one per box if the first expires)
export RUNNER_TOKEN=<paste>

bash scripts/setup-self-hosted-runner.sh
```

It installs Node 24 plus corepack/pnpm and Playwright's system libraries, registers the runner and
installs it as a systemd service so it survives reboot. It warns below 7 GB — a CPX32 reports 8, so
that warning appearing means you bought the wrong plan.

**C — arm the switch. 🔴 READ `gh variable list` FIRST — this step is only an *arming* if
`CI_RUNNER_LABEL` is unset.** If it already names another pool, the same keystroke is a **repoint**, and it
moves every opted-in PR off that pool in one write with nothing to warn you.

```bash
gh variable list                                  # what does CI_RUNNER_LABEL say NOW?
gh variable set CI_RUNNER_LABEL --body hetzner    # the label you gave the box in B4
```

This step said *"Two variables, and neither is set today"* until 2026-09-28, and it was false — the same
claim §L452 carried, surviving twenty lines further down after that one was fixed. It is the worse of the
two placements: L452 is read by someone **checking** state, this is read by someone **acting** on it, minutes
after paying for hardware. Which is the rule the whole file now works to — **a dated measurement is safe to
write down; a current value is not** — applied to an instruction rather than a description: do not tell the
reader what the variable is, tell them to look, and say what each answer means for the command underneath.

Then push a branch named `ci-runner/<task>` and open a PR from it. **Nothing else becomes
self-hosted** — not `main`, not a dispatch, not any other PR. Roll back with
`gh variable set CI_SELF_HOSTED --body off`, which takes effect on `gh run rerun --failed` because
`vars.*` re-resolve on a new attempt.

**D — prove it, and prove it on the right hardware.** A green run is not evidence on its own; read
which machine took each job:

```bash
gh api repos/Omar-3-xx/phoenix-people-workforce/actions/runners \
  --jq '.runners[] | select([.labels[].name] | index("hetzner")) | "\(.name) \(.status) \(.os)"'
gh run list --workflow=ci.yml --limit 1 --json databaseId --jq '.[0].databaseId'
gh api repos/Omar-3-xx/phoenix-people-workforce/actions/runs/<id>/jobs \
  --jq '.jobs[] | "\(.name) on \(.runner_name) \([.labels[]] | join(","))"'
```

Every job's `runner_name` must start `phoenix-ci-phx-ci`. **A `phoenix-ci-<uuid>` name is a Railway
replica**, which means the label selection did not hold — those carry `railway-eu` as well as
`phoenix`, so check the labels line too. 🔴 **And watch that first `main` run to a verdict**: `main` is
never self-hosted under the switch, but a red `main` for any reason makes Railway skip the production
deploy within minutes, and re-running it green does not resurrect it.

## Widening it — DONE, the owner's ruling of 2026-09-30

🔴 **EVERY SAME-REPO PULL REQUEST RUNS SELF-HOSTED NOW.** The owner widened it in his own words —
*"widen self-hosted CI to all PRs"* — and the `startsWith(github.head_ref, 'ci-runner/')` clause is
gone from all six `runs-on` lines. **`main`, pushes, dispatches, schedules and fork PRs are still
hosted**, and the two clauses that keep them there are load-bearing:

| clause | what it stops |
| --- | --- |
| `github.event_name == 'pull_request'` | `main` on a self-hosted runner. **`main`'s CI IS the production deploy gate** — a runner that fails or queues there stops shipping, with nothing red |
| `head.repo.full_name == github.repository` | a fork PR executing arbitrary code on the owner's box |

**Rolling back is the kill switch, never an edit to the expression:**

```bash
gh variable set CI_SELF_HOSTED --repo Omar-3-xx/phoenix-people-workforce --body off
```

`vars.*` re-resolve on each new run **attempt**, so that returns every PR to hosted on its next
attempt and `gh run rerun --failed` picks it up. The branch-name clause could not be undone that way,
which was its original appeal — and is now moot.

### Why the 2026-09-28 refusal was right then and wrong now

That ruling was not overturned by argument; the measurement under it was an artefact. `checks` read
**324–339s** self-hosted against ~209s hosted, which reads exactly like slow shared vCPU. It was the
**ESLint cache, keyed by absolute path**: a cache written on `ubuntu-latest` at `/home/runner/work/…`
matched **not one file** in `/home/phx/actions-runner/_work/…`, so eslint re-linted all 6,597 files
**while the step logged a cache hit** — 168s cold against 4s warm, measured twice independently on
the host. #4844 scoped the key to the workspace. On the one genuinely CPU-bound step the box had been
winning the whole time: `tsc` **115s** here against **153–162s** hosted.

🔴 **Three other explanations were proposed the same day and all three were wrong** — shared-vCPU CPU,
a cold pnpm store, and a second runner stealing CPU. Each is refuted with its evidence earlier in this
file. **Read those before deriving a fourth.**

The older refusal rested on a different pool, too: it counted **four** required jobs queueing behind
three Railway replicas. Protection has since dropped to **two** required checks (`validate`, `checks`),
and the Railway pool is gone. Neither half of that arithmetic still describes anything.

### What is still true, and is a trade rather than a defect

🔴 **There are two runners and two required jobs, so one PR occupies the whole box and a second
concurrent PR queues behind it entirely.** In a busy hour that is slower than hosted. The owner widened
it knowing that; it is not a regression to report, and the fix is not hardware — **he refused the
two-CPX32 purchase on 2026-09-28 (*"I WILL NOT BUY THIS"*) and bought one box himself. Never re-pitch
it.** If depth ever matters more than the bill, the lever is another runner process on the existing
host, measured first: see the memory arithmetic above, because `tsc` alone peaks at 5.86 GB of 7.7 GB.

### One typecheck at a time — owner, 2026-09-30

*"fix the CI box so two PR typechecks never run at once."* The queueing above is per JOB, and
`checks` and `validate` are different jobs — so two PRs could still land one `checks` job on each
runner and run two `tsc` at once. Measured that morning: 4.1 GB and 2 GB side by side with the
preview server, 3.1 GB into swap. ci.yml's Typecheck step now takes a kernel lock
(`/tmp/phx-typecheck.lock`, `flock`) in the same shell as `tsc`, so the second one **waits** for the
first (~110s) while lint and the unit suite keep running. `scripts/remote-check.mjs typecheck` takes
the same lock, so a hand-run check queues behind CI too. The wait is bounded at 20 minutes and then
runs anyway with a warning, so a stuck holder cannot fail a PR by itself; on a GitHub-hosted runner
the lock is always free. Pinned by `tests/ci-typecheck-lock.test.ts`, which on Linux holds the lock
from another process and proves the step waits.

### The build OOM was contention, not size — measured 2026-10-05

`node scripts/remote-check.mjs build` was recorded on 2026-10-04 dying `Killed` with exit **137** —
SIGKILL, the kernel's OOM killer — during `Collecting page data using 3 workers`, **after**
`✓ Compiled successfully`, taking ~300s to die where the measured figure for a whole build was 112s.
That left the build as the one stage with no proof before `main`: a PR's CI does not build
(`validate` builds only on non-PR events), so until 2026-10-05 the build first ran on the `main`
commit itself. `remote-check all` now INCLUDES it — that omission is why this regression went
unnoticed: `all` was what sessions ran, and it could not see the broken stage.

🔴 **THE OBVIOUS FIX IS WRONG, AND THIS SECTION EXISTS SO NOBODY PAYS FOR IT TWICE.** Capping
`next build` is the natural reading of "3 workers" plus "out of memory", and it does nothing. Four
runs on the box, each sampled every 10s for `free -m` and per-process RSS:

| workers (`PHX_BUILD_CPUS`) | heap cap | result | peak available | peak `next-build` RSS |
| --- | --- | --- | --- | --- |
| 2 | 3072 MB | PASS 113s | 307 MB | — |
| 2 | 2048 MB | PASS 118s | 213 MB | — |
| 1 | 2048 MB | PASS 123s | 215 MB | 6455 MB |
| **3 (uncapped control)** | **none** | **PASS 118s** | **295 MB** | **6458 MB** |

**The uncapped control passes.** So no cap was ever the fix, and two commit messages claiming
otherwise were squashed out rather than shipped. Both knobs are inert here for one reason: the
"workers" are **threads inside a single `next-build` process** — `ps` shows `next-build` at 6.4 GB
with `next-server` at 5 MB and `node` at 2 MB beside it — and that memory is Turbopack's native
Rust allocation. `--max-old-space-size` bounds the V8 heap and not that, which is why 3072 → 2048
moved the peak by nothing; `experimental.cpus` barely moves it either, with 2 workers → 1 returning
**2 MB** of headroom for **5 extra seconds**.

What the table does establish is that this build needs **~7.4 GB of a 7.7 GB box** however it is
invoked. It has no headroom at all, so it survives alone and dies beside anything substantial —
which is exactly what ~300s-to-die against ~118s-to-finish describes, and three concurrent checks
have left this box at 250 MB available on their own.

So the protection is a lock, not a number. 🔴 **Do not "improve" it by adding `PHX_BUILD_CPUS` or
`NODE_OPTIONS` back** — and `ci.yml`'s `PHX_BUILD_CPUS: 4` is not a precedent: that is a different
host with a different failure (47 visible CPUs and a thread-spawn abort, above), not this one.

#### The per-stage lock was not enough — corrected the same day

The first fix gave the `build` entry the same `/tmp/phx-typecheck.lock` as the typecheck. **That was
necessary and insufficient, and the very next build proved it**: on 2026-10-05 a build on a tree
carrying that lock was OOM-killed at `Collecting page data using 3 workers` again, in 210s. Sampling
the box immediately afterwards found two unrelated node processes holding **~4.7 GB** of the 7,740 MB,
and minutes later a second `remote-check` running there — a `tsc --noEmit` at **5,499 MB**.

The hole is plain once stated: **`lint` and `test` take no lock at all.** The typecheck lock
serialises a build against a typecheck and against `ci.yml`'s Typecheck step, and against nothing
else — so a second session running `all` collides on its two unguarded stages. The box is shared
between concurrent sessions, and it also carries a standing preview dev server.

**So the unit of exclusion is the RUN, not the stage.** `buildRunScript` now opens
`/tmp/phx-remote-check.lock` on fd 9 and takes it for the whole run, releasing it when the SSH
shell exits. Two details are load-bearing:

- **A different lock file on purpose.** `flock(2)` locks an open file *description*, so taking
  `/tmp/phx-typecheck.lock` at run level and again inside the typecheck would deadlock the run
  against itself. The per-stage locks stay where they are, so `ci.yml`'s Typecheck step still
  interlocks with them.
- **It can never fail the run.** If the 30-minute wait elapses it prints why and proceeds, exactly
  as `ci.yml`'s Typecheck step does. A lock that can turn a check red is a check people learn to
  skip.

🔴 **And exit 137 no longer reads as FAIL — it is NO VERDICT, exit 4.** It is SIGKILL from the OOM
killer; the build had already printed `✓ Compiled successfully` when it was killed, so it says
nothing about the branch. Reporting it as a failure is the cry-wolf shape: it blocks a push for a
reason that is not true, and the standing pre-push step (AGENTS.md §7) is exactly the kind of gate
that stops being read once it lies. A genuine failure still outranks a kill, so a run that both
fails and is killed reports FAIL.

#### And a lock cannot bind a branch that never heard of it — so the box is asked first

The run-level lock closes the hole for runs launched from a branch that carries it. `remote-check`
runs **the committed sha of whatever branch you invoke it from**, so every session still on a branch
cut from `main` takes no lock at all. Measured 2026-10-05, with that change sitting unmerged on its
own branch: **two `pnpm run test` runs on the box at once**, 1313s and 208s, and this session's suite
took 1313s against the 463s it takes alone.

So before anything is pushed, the existing one-round-trip state call also asks whether a run is
already there, and `remote-check` **refuses** rather than queueing:

```
remote-check: the box is ALREADY running 1 remote-check run(s):
    runs/932c1350f6e1-muv1a2b3-9xk2
not starting a second one. … Wait for the run above to finish, or set PHX_CHECK_FORCE=1 …
```

Three things about it are deliberate:

- **It refuses, it does not wait.** A lock makes the second run sit silently for up to thirty
  minutes, which is indistinguishable from a hang — and it does nothing at all about an older
  branch. A refusal naming the run already there is immediately actionable.
- **It reads `/proc/*/cwd`, not a lock file and not `pgrep`.** Every version of this script, back to
  before any of this existed, `cd`s into `runs/<id>` — so a process whose working directory is under
  `runs/` **is** a live run, whatever branch launched it. A stale directory left by `kill -9` has no
  process and is invisible here, which matters because `STALE_RUN_MINUTES` keeps such directories
  for six hours.
- 🔴 **It fails CLOSED.** The probe ends with `PROBE_OK`; without that marker the answer is
  *unknown*, and unknown refuses. Reading "no output" as an idle box would turn every failed ssh
  into a green light, which is the one direction this must never fail in.

`PHX_CHECK_FORCE=1` overrides it for one command. Pinned by `tests/remote-check.test.ts`, which
exercises `parseBusyProbe` directly rather than reading the source — including that two processes of
one run are one run, and that four shapes of unreadable output each come back `known: false`.

All of these behaviours are pinned in `tests/remote-check.test.ts` and were watched failing one at a
time, each on its own named assertion: the run lock removed, the run lock pointed at the per-stage
file, a second `exec 9>>` added to force the deadlock, the fall-through turned into `&&`, the 137
branch collapsed to `R=FAIL`, the `exit 4` line dropped, and the caller's `status === 4` arm
disabled. 🔴 **Run them through `tests/run-tests.ts`** — the file exports `runRemoteCheckTests` and
`node tests/remote-check.test.ts` executes nothing, exits 0, and prints nothing at all, which is
indistinguishable from a pass.

#### A run can contain another run, so the lock path is an argument

The run-level lock's first version hard-coded `/tmp/phx-remote-check.lock`. **That deadlocked the
suite against itself.** `tests/remote-check.test.ts` section 9 launches two generated box scripts at
once to prove each sees its own tree — and the suite itself runs **inside** a `remote-check` run that
already holds that lock, so both inner scripts blocked on their own parent and waited out the full
`flock -w 1800` fall-through. Measured 2026-10-05: the `test` stage sat at **31 minutes** with
`flock -w 1800 9` waiting and fd 9 on `/tmp/phx-remote-check.lock` held by the outer run's bash.

It does not hang — the fall-through is deliberate, so it eventually warns and proceeds — which is
worse, because a 30-minute stall reads as contention rather than as a bug in the lock.

`buildRunScript` now takes `lockFile`, defaulting to `BOX_LOCK_FILE` (the real path). A nested or
test run passes its own file, which keeps the lock mechanism exercised without self-blocking, and
the path is validated before it is spliced into bash. Pinned three ways: the argument is honoured,
the **default** is still the real lock, and an unsafe path throws.

#### A dropped ssh connection is not a failed branch — measured the same day

The first run after the busy refusal shipped got as far as `--- lint PASS in 181s ---` and
`--- typecheck PASS in 124s ---`, then printed

```
client_loop: send disconnect: Connection reset by peer
remote-check: FAIL — 64ad8cbcd
exit=255
```

and the shipping chain halted without pushing. **Nothing had failed.** 255 is ssh's own code for a
connection that died; the generated box script only ever exits 0, 1, 3 or 4, so 255 can only have
come from the transport. This is the same cry-wolf failure as the OOM kill, arriving from the other
end of the pipe, and it is fixed in both directions:

- **The cause.** `SSH_OPTS` now carries `ServerAliveInterval=30`, `ServerAliveCountMax=10` and
  `TCPKeepAlive=yes`. `next build` prints nothing between "Collecting page data" and its summary, so
  a run goes genuinely silent for minutes — exactly what a NAT or firewall idle timer reaps.
  `CountMax 10` tolerates five minutes of an unreachable box before giving up, longer than any blip
  seen here and far short of hanging for ever.
- **The report.** `status === 255` exits **5** with `NO VERDICT` and says plainly that any stage
  which printed `PASS` above really did pass — so a re-run can skip nothing but need not distrust
  what it already saw.

A test asserts the box script never emits `exit 255` itself: if it could, a real failure would read
as a dropped connection, which is the inverse mistake and the more dangerous one.

🔴 **AND THE STRANDED RUN KEEPS GOING, AND KEEPS THE LOCK — so "run it again" was the wrong
advice.** Measured on the very run this arm was written for: after the client died, **four processes
were still working under the run directory**, with a **live `sshd-session` ancestor** — the box had
not noticed the client was gone. So neither "the connection died" nor "the sshd is gone" is a usable
abandonment test from the box, and the only honest reading is that an abandoned run is
indistinguishable from a live one *from the box side*. A plain re-run therefore meets its own
predecessor and is refused by the busy probe.

The session that launched it, though, knows its own run id — so the refusal now prints how to reap
**one** run by its own directory, and says explicitly not to use a blanket `pkill`, which would take
another session's live run with it:

```
ssh -i <key> phx@46.225.184.142   'for p in /proc/[0-9]*; do d=$(readlink "$p/cwd" 2>/dev/null) || continue;
   case "$d" in */runs/<RUN_ID>*) kill -KILL ${p#/proc/};; esac; done'
```

The server-side fix — `ClientAliveInterval` in the box's `sshd_config`, which would make sshd notice
and reap the session itself — is **not available to a session here**: `phx` has no passwordless
sudo (`sudo -n` fails), so the box's sshd config cannot be changed from a check run.

🔴 **A weak break reads as a missing test.** Changing `status === 255` to `status === 2550` did
*not* fire the assertion — `255` is a substring of `2550`, so the regex still matched. The arm had
to be removed outright, and `process.exit(5)` changed to `process.exit(1)`, before it fired. A break
that does not fire is not evidence; it is a break that did not land.

### remote-check: one tree per invocation — 2026-10-01

The lock above serialises `tsc`, and nothing else. Until 2026-10-01 every `remote-check.mjs`
invocation, from every session, also shared ONE directory on the box (`~/remote-check/work`) and one
branch (`remote-check`): push, `git checkout -f <sha>`, run. Two sessions at once therefore checked
out over each other mid-run. The box's own reflog shows it: `19442c382` checked out at 05:59:44
Cairo, `5d2bfaa24` over it at 06:01:25 while the first run was still going. The first run printed
`box head: 19442c382`, then failed its typecheck with `TS6053` on a test file that commit *has*, and
passed the unit suite with `2085 test files` — the other commit's count; CI ran 2,086 on the same
sha. Wrong in both directions, under the right header.

Now each run pushes to its own ref (`refs/remote-check/<run id>`), `git worktree add`s its own
directory under `~/remote-check/runs/`, and its EXIT trap removes both; a directory a hard-killed run
left behind is reaped after 6 hours. After the checkout, the install and every check it re-reads
HEAD, and a run whose tree is no longer its sha exits **3** and prints **NO VERDICT** instead of PASS
or FAIL. A fresh tree has no `.next/types`, so the typecheck now runs `next typegen` first, as
ci.yml does — the shared directory had been typechecking against whatever route types some earlier
commit left behind. The cost is a fresh `pnpm install` (hard links from the box's store) and a cold
eslint cache per run. `~/remote-check/work` is no longer used. The bash lives in
`scripts/remote-check-plan.mjs`; `tests/remote-check.test.ts` runs it for real against a throwaway
bare repo with two overlapping invocations on two commits.

### remote-check runs as phxci — owner, 2026-10-08

🔴 **Branch code on the box runs as `phxci`, a user with no sudo — never as `phx`.** A check runs
whatever the pushed branch says: its tests, its build, its package scripts. `phx` has passwordless
sudo and owns the preview env file in `/home/phx/secure`, so until this change any branch that
reached the box could read that file or change anything on the machine. The owner ordered it moved
("run remote-check as a non-sudo user on the box").

What is on the box (set up by hand on 2026-10-08, nothing in git creates it):

- **User `phxci`**: password locked, not in `sudo`, its own `/home/phxci/remote-check` (the bare repo,
  `runs/`, `eslint-cache/`), and a seeded corepack and pnpm store. Its `authorized_keys` holds the
  laptop's existing remote-check key with `restrict`, so it cannot forward ports or agents.
- **It cannot read `/home/phx`** (mode 750, `phxci` is not in group `phx`) and `sudo -n true` fails.
  Both were tried as `phxci` and both were refused.
- **The box lock is still ONE lock across both users.** `fs.protected_regular=2` refuses a cross-user
  open of a plain file in `/tmp`, so the lock files moved to `/var/lib/phx-locks` (`root:phxlocks`,
  2770; both users are in `phxlocks`) and the historical names `/tmp/phx-remote-check.lock` and
  `/tmp/phx-typecheck.lock` became ROOT-owned links to them. A root-owned link is followable by
  everyone, so a session still on the old code (running as `phx`) and a new one (running as `phxci`)
  still exclude each other. Tested both ways: `phx` was refused the lock while `phxci` held it.
- **`/etc/tmpfiles.d/phx-locks.conf`** recreates the directory, the two files and the two links at
  boot, because `/tmp` is a tmpfs.

`PHX_CHECK_USER` still overrides the default. Setting it to `phx` brings the old exposure back, so
only do that to compare against a run from before this change. Pinned by assertion 6b in
`tests/remote-check.test.ts`.

### The remote typecheck before every push — owner, 2026-10-04

🔴 **SUPERSEDED 2026-10-08: the guard no longer runs anything.** The owner's performance-recovery
ruling: *"the push guard must not start a remote check that blocks a normal push. Previously completed
verification for the exact commit SHA may be reused."* `push-typecheck-guard.mjs` now only READS
`<git-common-dir>/phx-remote-check/<sha>.json`, which `remote-check.mjs` writes when a run ends in a
printed PASS or FAIL. It refuses a push solely when that record holds a typecheck FAIL for the exact
commit being pushed, notes a reused PASS, and otherwise allows at once — no ssh, no wait, a 10s
settings timeout. A chained `git commit && git push` now passes this guard, because the new commit has no record (`bash-guard.mjs` C12 refuses that shape for its own reason).
Measured before: push p75 48s and p90 68s on 7-8 Oct, 146s p75 on 4-6 Oct, capped at 7 minutes.
Pinned by `tests/push-typecheck-guard.test.ts`, which also asserts the fake remote-check is never
called. The account below is kept for its history.

*"add a remote typecheck before every push, in a worktree."* `buggy_code` is the top friction
category in his own usage report, and the costly shape is a type error that only the PR's `checks` job
finds: a full CI round to find it (~14 billable minutes, twice with the `main` run) and another to fix
it. A local `tsc` cannot be the answer (bash-guard C8, 4.0–4.5 GB), but `remote-check.mjs typecheck`
answers in about two minutes with nothing heavy on the laptop, so
`.claude/hooks/push-typecheck-guard.mjs` makes it the push's own first step — PreToolUse on Bash and
PowerShell, timeout 480 s in `.claude/settings.json`, pinned by `tests/push-typecheck-guard.test.ts`.

**What it does.** On a `git push` that sends the checked-out commit it runs the typecheck on the box for
that exact sha and **refuses the push only on a FAILED verdict**, handing back every `tsc` error. It
resolves `cd <dir> &&` and `git -C <dir>` first, so a push typed from another folder checks the right
repository. **What it leaves alone:** a dry run, a delete, a tag push, `--all`/`--mirror`, a push of
another ref or of `refs/backups/*`, a branch origin already holds, a push whose diff against
`origin/main` holds no `.ts/.tsx/.js/.mjs/.json` and no pnpm manifest (the same call CI makes for a
docs-only change, so a migration-only push is not made to wait), and a commit that already PASSED —
remembered per sha in `<git-common-dir>/phx-remote-typecheck/`, shared by every worktree.

**What it cannot do — and says so.** A PreToolUse hook runs before the WHOLE command, so for
`git commit … && git push` HEAD is still the commit BEFORE the one about to ship. Checking it would prove
nothing, so a push chained after a commit, merge, rebase, cherry-pick, pull, reset, am, revert, checkout
or switch is **refused** with the instruction to run those as their own command first (unless the work
holds nothing a typechecker reads). That is the one cost of "before every push". It sends the COMMIT, not
the working tree, exactly like `remote-check.mjs` itself.

**When the box cannot answer it does NOT block.** No SSH key, box down, a run whose tree moved (exit 3),
a failed install, or more than 7 minutes: the push is allowed with a plain "NO VERDICT, not checked"
note, and the PR's `checks` job is still the gate. A guard that stopped every push whenever the box was
unreachable would be switched off inside the hour — bash-guard C12 (gitleaks) makes the same call.

**This is not the retired pre-push git hook.** AGENTS.md §7 retired `check:harden` and
`.git/hooks/pre-push` on 2026-08-18 because they ran heavy work ON THIS LAPTOP. This one runs nothing
heavy here, is not a git hook (a push typed in a plain terminal never sees it), and exists because he
asked for it by name. `PHX_PUSH_CHECK_OFF=1 <cmd>` (`$env:PHX_PUSH_CHECK_OFF=1; <cmd>` in PowerShell)
pushes one command regardless — only when he said to. **Like every hook it loads at session start from
the worktree's own branch**, so a session already open when this merged does not have it.

### REVERSED the same day — PRs back on hosted, the box is previews only, 2026-09-30

The owner widened it in the morning and reversed it that evening, in his own words: *"put PRs back
on hosted and keep the box for previews only"*. `CI_SELF_HOSTED` went **off** — the kill switch, not
an edit to the `runs-on` expression, exactly as "The safety rules" requires. The expression is
UNCHANGED and still reaches every same-repo pull request, so one variable restores widening; the
"Widening it" section above stays as the account of how it is wired, not as a description of what is
running.

**It was reversed because the box could not carry it, and the measurement is the reason.** `tsc`
peaks at **5.55 GB** on a box with **7.7 GB**, so TWO concurrent `checks` jobs cannot fit. On
2026-09-30 two typechecks sitting at **4.6 GB + 1.3 GB** drove it **3,579 MB into swap**, and the
queue read **9 runs queued and 0 in progress** — CI had stopped rather than slowed, which is the
failure a shared box makes look like slowness. Capped to ONE runner (`phoenix-ci-nbg1-b` stopped,
masked and deregistered), the two required jobs then SERIALISE at **~305s against ~209s hosted**.
That is why hosted won: the box is faster per job and slower per PR, and a PR is what the owner
waits on.

🔴 **The runner self-updates and does not come back.** It upgraded **2.331.0 → 2.337.0**, exited
`no retry needed` with code **0**, and `svc.sh`'s generated systemd unit carries `Restart=no` — so
it read **offline** while every job queued behind the other runner, with nothing red anywhere to say
so. Both units now carry a `Restart=always` drop-in. **Never register a runner without checking
`systemctl show <unit> -p Restart`.**

What survives the reversal, and is why the safety rules above are not now dead letters: the
`github.event_name == 'pull_request'` clause is the ONLY thing keeping `main` hosted, and `main`'s CI
is the production deploy gate; the same-repo clause is what stops a fork PR executing arbitrary code
on his box; and the hardware refusal stands (*"I WILL NOT BUY THIS"*, of two CPX32s at
€70.98/month — he bought ONE box himself). The box keeps serving previews — since 2026-10-17 only
`phx-live`, because he retired `phx-preview` that day (`docs/agents-worktree-and-machine-limits.md`,
"phx-live").

## Turning it off

```bash
gh variable set CI_SELF_HOSTED --repo Omar-3-xx/phoenix-people-workforce --body off
```

That is the kill switch and it wins over everything else, so it works without having to remember which
label was configured. `gh variable delete CI_RUNNER_LABEL` also does it, by making the label unset —
either way an eligible PR falls back to hosted rather than queueing. 🔴 **`gh variable delete CI_RUNNER`
is the OLD command and now does nothing**: that variable was retired in #4594 and no workflow reads it.

Because `vars.*` are re-resolved on each new run **attempt**, a run already in flight keeps the old
value — `gh run rerun --failed` is what picks the kill switch up. The next run goes back to
GitHub-hosted. Nothing else changes, no workflow edit, no PR. Do this
first and diagnose afterwards whenever the runner misbehaves — a queued job reports no status, and
a required check with no status blocks every PR.

### 🔴 The switch goes off BEFORE the host stops — never after

**Stopping the runner host first is the one order that breaks things, and it breaks them silently.**
`CI_SELF_HOSTED=off` sends every job back to `ubuntu-latest`. Leaving the switch armed while
`CI_RUNNER_LABEL` still names a pool with **no online runner** does NOT fall back: the job **queues
for ever**, reports no status, and a required check with no status blocks the PR with nothing red
anywhere to read. The label being *unset* falls back; the label being *set to a dead pool* does not.
Those two are a word apart in the section above and opposite in effect.

**The order, whenever the host is being stood down or moved:**

1. `CI_SELF_HOSTED=off`, and read it back from `gh variable list` — not from the command's exit code.
2. Confirm no `ci-runner/` PR is open or in flight. `vars.*` resolve when a run **attempt** is
   created, so a run already created keeps the armed value and still wants the pool.
3. Only then stop the replicas.
4. The registrations then sit in the repo's runner list as stale `offline` entries. Delete them by
   **id** — the Railway replicas register non-ephemerally, which is why this list has read ten and
   three inside one hour.

**Recorded 2026-09-29**, because that is the order the owner's stand-down followed: the switch was set
to `off` at 16:53 Cairo, on an idle pool — it had carried no CI at all since the two proof PRs
([#4599](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/4599) and
[#4601](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/4601)) on 28 September, while
still billing for idle memory. 🔴 **The Railway host itself was still running when this was
written — three replicas online — so nothing here says it was retired.** And this is a dated event,
never a statement of what the switch reads today: ask `gh variable list` for that, for the reason
[#4618](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/4618) exists.

### 2026-09-29 — the Railway host was stood down (stopped, NOT deleted)

Later the same day the pool itself went down. Verified state at the time of writing:

| | |
| --- | --- |
| Railway project | 🔴 **DELETED 2026-10-01** — was `d657a3c0-684c-4e83-88bc-ded47b32a00d`, `deletedAt: null` until then |
| Service | `ci-runner` `f6a18a22-1434-4423-95d5-875b88928f9b` — gone with the project |
| Deployment | `b6f0858b` — was `deploymentStopped: true`, `canRedeploy: true` |
| Replicas | all three `EXITED` — `1116628c`, `8f9e5a88`, `37e95625` |
| GitHub registrations | ids 32, 33, 34 deleted; `actions/runners` reads `total_count: 0` |

🔴 **UPDATED 2026-10-01: "retired" became DELETED.** The owner instructed it, and the project, its
service and its deployment are gone — so the paragraph that stood here, saying they "all still exist
and the deployment is redeployable", is no longer true. **Bringing a Railway pool back is now a
rebuild from the provisioning runbook above, not a redeploy**, and creating a project remains the
owner's dashboard click. Inventory taken before pressing: no volumes in any environment, the one
service reading `● Completed`, no runner registered with GitHub from it, and no code path referencing
it — only this document.

🔴 **AND `railway list` LISTED IT FOR MINUTES AFTER IT WAS GONE, IN BOTH PLAIN AND `--json` FORM.**
The first `railway delete -p <name> -y` succeeded, printing only its selection line; the listing then
still showed the project, a second delete answered `Project "phoenix-ci-runner" not found` with exit
1, and `railway status` on the linked directory answered **`Project is deleted.`** — which is the only
readout that told the truth. This is the volume-delete trap (AGENTS.md §2.3) with the signs reversed:
there the delete reports success and does nothing, here it reports almost nothing and works while the
listing lies. **Never conclude a Railway delete failed because the thing is still listed, and never
re-press on that basis** — read the object directly.

🔴 **The registration ids in that table are spent.** A replica registers non-ephemerally at
startup, so a redeploy mints NEW ids and the old ones never come back — never write an id from this
file into a command. Read `gh api repos/<repo>/actions/runners` at the moment you need one.

🔴 **THE TWO WAYS A RUNNER REGISTERS NEED DIFFERENT CREDENTIALS, AND ONLY ONE OF THEM NEEDED A PAT —
WHICH IS WHY DELETING THE `phoenix-ci-runner` PAT ON 2026-10-01 CHANGED NOTHING ABOUT THE RUNBOOK
ABOVE.** The two paths are not interchangeable and a session that conflates them either hunts a token
it does not need or rebuilds a pool it cannot authenticate:

| path | credential | state after 2026-10-01 |
| --- | --- | --- |
| **The manual runbook above** (a host you provision, `scripts/setup-self-hosted-runner.sh`) | `RUNNER_TOKEN` — a **registration token valid about ONE HOUR**, read off `/settings/actions/runners/new`. **No PAT, no stored secret** | **Unaffected.** Re-register the Hetzner box, or a replacement host, with a fresh token from that page and nothing else |
| **The Railway container pool** (`ghcr.io/actions/actions-runner:latest`, 3 replicas self-registering at startup) | a **fine-grained PAT in the service's own variables** — a replica boots unattended, so it cannot be handed a one-hour token by a human | **Gone twice over.** The project was deleted, and the `phoenix-ci-runner` PAT with it. Rebuilding that pool needs the owner to **mint a NEW fine-grained PAT first** — the old one cannot be recovered or re-read |

So: **re-registering a runner does NOT need a PAT. Rebuilding the Railway pool does, and the one it
used no longer exists.** `scripts/setup-self-hosted-runner.sh` dies with
`RUNNER_TOKEN is not set` and names the page to get one from — that message is the whole credential
story for the path this document actually recommends.

**Reading that project without relinking the CLI**, which matters because the primary checkout is
linked to `phoenix-headwind` and relinking breaks every other session's `railway run`:

```bash
railway status --project d657a3c0-684c-4e83-88bc-ded47b32a00d --environment production --json
```

`--project` requires `--environment` for both output modes. It is a read; it changes no link.

### 2026-09-30 — the Hetzner box is LIVE, and the switch points at it

The owner bought **one** CPX32 and the pool moved off Railway the same night. State at the time of
writing, read from the live APIs rather than from the order:

| | |
| --- | --- |
| Host | `ubuntu-8gb-nbg1-1` — CPX32, 4 vCPU, 7,740 MB RAM, 150 GB, `x86_64`, Nuremberg (`nbg1`) |
| OS | Ubuntu **26.04.1 LTS** (`resolute`) |
| Runners | **two on the one box** — `phoenix-ci-ubuntu-8gb-nbg1-1` and `phoenix-ci-nbg1-b`, both labelled `self-hosted,X64,Linux,phoenix,hetzner` |
| Services | one systemd unit per runner, `actions.runner.Gawish-1997-phoenix-people-workforce.<runner name>` — both enabled, active, surviving reboot |
| Switch | `CI_SELF_HOSTED = on`, `CI_RUNNER_LABEL = hetzner` |
| Toolchain | node 24.21.0, pnpm 12.8.1, git 2.53.0, Playwright system deps installed |

🔴 **8 GB of swap was added deliberately, and it is not optional.** `ci.yml` runs typecheck with
`--max-old-space-size=6144` against 7,740 MB of RAM. A runner takes one job at a time so nothing
competes with it, but 6 GB of heap inside 7.7 GB leaves no margin for the compiler's own
non-heap memory — and an OOM-killed typecheck prints nothing and exits non-zero, which reads
exactly like a code failure. `/swapfile`, `fstab`-persisted.

**Two things cost real time on the way in. Neither is a defect in this runbook; both are new.**

🔴 **A Hetzner server created without ticking an SSH key CANNOT BE REACHED WITH ONE AFTERWARDS —
not by adding the key to the project, and not by Rebuild.** The key is applied at creation only;
`Rebuild` takes an image and re-applies the keys *from creation*, of which there were none, so it
lands in the same hole. The project key read as present and correct the whole time — its
fingerprint matched the laptop's exactly — which is precisely what makes this hard to see. The way
out without deleting the server is **Rescue**: enable it, the box power-cycles into a network
Debian, mount the real root at `/mnt`, append the public key to `/mnt/root/.ssh/authorized_keys`,
reboot. 🔴 **Hetzner's console does NOT offer a key selector when enabling rescue — it issues a
one-time root password and clears it from the panel once the box has booted**, so capture it when
it appears. Confirm you are really in rescue from the wire, not the UI: port 22 answers
`SSH-2.0-OpenSSH_9.2p1 Debian-2+deb12u7` there, and the installed system answers as Ubuntu.

🔴 **NodeSource had no repository for `resolute` at all**, so `setup_24.x` left the box with no
Node and `setup-self-hosted-runner.sh` could not proceed. The script now falls back to the official
tarball and resolves the version from `nodejs.org` — see its Node section. **Expect this again on
the next Ubuntu release**: NodeSource lags a new codename by months, and the failure is quiet.

## What to expect after the switch

- **Cost**: metered Actions spend for this repo goes to ~$0. The VPS is the whole bill.
- 🔴 **STEADY STATE IT IS FASTER THAN HOSTED — `checks` ~145s against ~209s. NEVER JUDGE THIS BOX ON
  ITS FIRST RUNS.** The step that decides CI is the typecheck, and it is the step the box wins:

  | step of `checks` | box, steady state | GitHub-hosted |
  | --- | --- | --- |
  | `pnpm install --frozen-lockfile` | **0.5s** (pnpm store persists between jobs) | 11–14s |
  | `next typegen` | 1.7s | <5s |
  | `lint` (ESLint cache restored) | ~5s | 5–6s |
  | **`tsc --noEmit`** | **114s** | **153–162s** |
  | **job total** | **~145s** | **203–219s, mean 209s** |

  `tsc` measured directly on the host, cold (`--incremental false`, no `tsbuildinfo`), peak RSS
  **5.55 GB** — which is why the 6 GB heap stands and why the swap file is not optional.

  🔴 **THE OBSERVED JOBS SAID THE OPPOSITE — 324s, 327s, 339s — AND THE CAUSE IS THE ESLINT CACHE,
  NOT THE CPU, NOT A COLD STORE, AND NOT THE SECOND RUNNER.** All three explanations were proposed on
  2026-09-30 and all three are wrong; the row above marked "lint ~5s" is what the job gets only once
  `ci.yml`'s cache key carries the workspace. What was actually happening:

  | on the self-hosted `checks` job | | hosted |
  | --- | --- | --- |
  | **Lint** | **165s · 169s** | 5–6s |
  | Typecheck | **115s · 115s** | 153–162s |

  `.eslintcache` is a JSON object keyed by **absolute path**. Hosted runs write
  `/home/runner/work/<repo>/<repo>/…`; this box works in
  `/home/phx/actions-runner[-2]/_work/<repo>/<repo>/…`. So the restored cache matches **not one
  file**, eslint re-lints all 6,597 — and the step logs a **cache hit** while doing it, which is why
  nobody looked there. Two sessions measured it independently on the host: **168s / 165s with no
  usable cache, 4.16s / 4s with one that box wrote** (3,600,957 bytes). That 160s is the entire gap.

  🔴 **THE THREE WRONG DIAGNOSES, SO NOBODY RE-RUNS THEM.** *Shared-vCPU CPU* — refuted by the one
  pure-CPU step: `tsc` is **115s here against 153–162s hosted**, measured twice independently on the
  host (113.94s and 115s, peak RSS 5.55 GB / 5.86 GB). The box **wins** on CPU. *Cold pnpm store* —
  refuted by `install` already reading **0.5–3s** while `checks` still took 324s, and by three
  consecutive runs drifting only 339 → 327 → 324s, which is not a store filling. *The second runner
  stealing CPU* — refuted by attempt 1 of run `36652062486`, which ran `checks` **solo and
  sequential** and still took **339s**, slower than the concurrent runs. Concurrency changed nothing,
  and a runner was briefly removed on that mistaken basis before being restored.

  🔴 **THE COMPARISON BASIS IS THE WHOLE MEASUREMENT, AND IT WAS GOT WRONG THREE TIMES IN ONE HOUR, IN
  BOTH DIRECTIONS.** #4837 moved the unit suite from `checks` into `validate` on 2026-09-29T23:39Z, so
  **every run before that timestamp has a different job composition and is not comparable**, and a
  `push` run's `validate` additionally carries the build and the login smoke. One draft read
  "`validate` is roughly twice as fast" off pre-split or push runs (270–365s); another compared
  per-job self-hosted times against a whole PR's *wall clock* and got "2× slower"; a third blamed a
  cold store; a fourth compared observed jobs against **~145s, which was a projection assuming a
  working ESLint cache and not an observed job at all**, and removed a runner over the difference.
  **Filter to `event=pull_request` and to runs created after the last change to the job split — and
  never compare an observed number against a projected one without saying which is which.**

  🔴 **ONCE THE KEY LANDS, THE BOX WINS THE WAIT AND NOT ONLY THE JOB — BUT ONLY WITH BOTH RUNNERS.**
  Wall clock is `max(checks, validate)`: about `max(145, 160) = ~160s` here against hosted's
  `max(209, 157) = ~209s`. With one runner the two required checks serialise instead and the box
  loses. **The cache key and the runner count are one change; do not ship or undo them separately.**
- 🔴 **ONE RUNNER PROCESS TAKES ONE JOB, SO A SINGLE REGISTRATION SERIALISES THE TWO REQUIRED CHECKS.**
  The first run took **508s** that way (339s then 161s, back to back) — most of that 339s was the
  ESLint cache above, so read the 508s as the shape of the problem, not as its cost.
  A **second** runner registered on the SAME box fixes it — `RUNNER_DIR=$HOME/actions-runner-2
  RUNNER_NAME=phoenix-ci-nbg1-b` with the same labels, which the setup script supports as-is. **It
  fits**: with both jobs running at once the box's lowest available RAM was **1,180 MB** and swap
  use peaked at 67 MB, so the 6 GB typecheck heap needs no lowering. 🔴 **Expect a scheduling delay
  of up to ~90s before GitHub hands work to a runner that has just registered** — a job sitting
  `queued` beside an idle runner in that window is not a misconfiguration.
- 🔴 **A persistent runner keeps state between jobs**, which GitHub-hosted runners never do. That is
  where the speed comes from and also the one new failure mode: a stale `node_modules`, `.next` or
  generated type file can make a run pass that should have failed. If a result ever looks
  suspicious, clear `~/actions-runner/_work` and re-run before believing it.

## The typecheck moved to TypeScript 7 — 2026-10-06

`checks` was **209s hosted, ~157-185s of it the typecheck**. Lint is 5s behind a restored ESLint
cache, `next typegen` under 2s, install 11-14s. So nothing that left the typecheck alone could move
this job, and the wall clock of a PR was this job.

**The gate is now the native compiler**, installed as `typescript-native`, an `npm:typescript@7.0.2`
alias in `package.json`. `typescript@5` stays installed and must: typescript-eslint loads it through
`eslint-config-next/typescript`, Next loads it because a `tsconfig.json` exists, twelve tests import
the compiler API from it, and the editor's language service is it.

Measured on this tree, same `tsconfig.json`, both cold, on the 4-vCPU cloud container:

| | time | peak RSS | diagnostics |
| --- | --- | --- | --- |
| `tsc` (TypeScript 5.9.3) | **276s** | 5.8 GB | 0 |
| TypeScript 7.0.2, default checkers | **28.5s** | 6.45 GB | 3 (false) |
| TypeScript 7.0.2, `--checkers 2` | 37.6s (2 vCPU) | 6.12 GB | 3 (false) |
| TypeScript 7.0.2, `--checkers 1` | 52s (2 vCPU) | **5.06 GB** | 3 (false) |

### Why it was safe this time and was not on 2026-09-30

The 09-30 trial measured `@typescript/native-preview` 7.0.0-dev.20260707.2 — a dated development
build — at 7.7x, and refused it on three `TS2871 "This expression is always nullish"` diagnostics
that are false. **That refusal was right.** What changed is not the speed: TypeScript 7.0.2 shipped
**stable on 2026-07-08**, and the adoption rests on a replay rather than on a benchmark.

**The replay.** Every pull request whose CI typecheck failed in the fortnight to 2026-10-03 — 14
branches, 19 errors — was fetched at the exact head CI graded, and TypeScript 7 run over it.
**It reports every error TypeScript 5.9 reports.** Three looked missing at first and none was: two
exist only in the PR's MERGE commit (TS 5.9 does not report them on the head tree either — checked),
and the third was a `--checkers` flag mis-set on the first pass. A compiler that is faster but blind
to a class of error would be worse than the one it replaces; this is the evidence that it is not.

**The three false positives were fixed, not suppressed.** All three were one idiom — a redundant
`?? null` nested inside the left operand of another `??`, in `src/lib/customer-360/service.ts` (x2)
and `src/lib/verified-captures/distributor-codes.ts`. Reproduced in a 30-line isolated file, where
dropping the inner `?? null` is quiet in **both** compilers and provably equivalent (it only turns a
Map miss's `undefined` into `null` one operand before the next `??`). TypeScript 7.1's nightly
reports zero on the untouched tree, so this is an upstream bug already fixed — the rewrite is how
the gate moves today without waiting for it.

### `--checkers 1`, and why the flag is not a tuning knob

Both callers pass `--checkers 1`: `package.json`'s `typecheck` script, which `ci.yml`'s `checks` job
runs, and `scripts/remote-check.mjs`'s box command.

* **It bounds the memory.** One checker peaks at **5.06 GB**, below the 5.8 GB TypeScript 5 already
  needed — so the self-hosted box's profile strictly improves, which is what makes it safe beside a
  preview server on 7.7 GB. The default checker-per-core peaks at 6.45 GB.
* **It is the only mechanical tell that the alias is still there.** Nothing in the script, the
  workflow or the box command names a version: all three run `tsc`, and WHICH `tsc` that is comes
  from pnpm linking `node_modules/.bin/tsc` to the higher of the two installed versions. Drop the
  alias and the gate silently reverts to the 276s compiler with every command and every doc still
  reading correctly. **TypeScript 5 refuses `--checkers` outright**, so that reversion fails loudly
  instead. `tests/typecheck-native-compiler.test.ts` asserts both callers still pass it, that the
  alias is 7 or above, that `typescript` is still 5.x, and that the linked binary answers 7.

### Two things that have NOT changed

🔴 **A GLOBAL INSTALL DOES NOT TYPECHECK THIS PROJECT — IT FAILS RESOLUTION AND LOOKS 15x FASTER.**
Installed with `npm i -g`, it resolved neither `next/link` nor `react/jsx-runtime` nor
`JSX.IntrinsicElements` and "finished" in 7.6s with thousands of `TS2307`/`TS7026`. That is the time
to fail, not a measurement. It must be installed into the project, which the alias does.

🔴 **AND THE CACHE THAT WOULD MAKE A TYPECHECK FAST IS STILL FORBIDDEN HERE.** `tsconfig.json` sets
`incremental: true` **and** `assumeChangesOnlyAffectDirectDependencies: true`, and on 2026-07-30 a
warm run in this repo returned **exit 0 with three live `TS2741` errors**. Restoring
`tsconfig.tsbuildinfo` from `actions/cache` would trade away the correctness of the one check that
guards types. Do not propose it — and note the speed-up above makes it pointless as well as unsafe.
`typecheck-incremental-false-green`

## Do not re-attempt these

Recorded in `ci.yml`'s own comments with the measurements:

- `next build --turbopack` — a **no-op**; Next 16.2.11 already builds with Turbopack (175s vs 174s,
  byte-identical output).
- `.next/cache` — restored fine, **saved nothing** (148s warm vs 143s cold), and its entries reached
  97% of the 16.47 GB repository cache budget.
- Extending the docs-only fast path to `main` pushes — measured **4 of the last 200 commits (2%)**
  are docs-only. Worth roughly $2/month.

## 🔴 Only 0 and 1 are verdicts — the four non-code failures that used to print FAIL — 2026-10-06

`scripts/remote-check.mjs` is the standing pre-push step (AGENTS.md §7) and the engine behind
`.claude/hooks/push-typecheck-guard.mjs`, which refuses a `git push` on a FAILED typecheck. That
makes its final line a load-bearing claim: **`remote-check: FAIL — <sha>` says the owner's code is
broken, and a push is blocked on it.** Four failures that never read the code at all were arriving
wearing exactly that line.

| What happened on the box | Before | Now |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` failed, or `git worktree add` could not make the private tree | exit **1** → `FAIL — <sha>` | exit **7** → NO VERDICT |
| the run took HUP/INT/TERM (the box's memory watchdog, a reboot, a hand `kill` of a stranded run) | exit **130** → `FAIL — <sha>` | exit **8** → NO VERDICT |
| a stage gave up waiting for `/tmp/phx-typecheck.lock` (`flock -w 1200`) | exit **1** → `FAIL — <sha>` | exit **9** → NO VERDICT |
| the dispatched `ci.yml` run went red in `mobile`, the Build or the login smoke | run conclusion `failure` → `FAIL — <sha>` | the requested stage's own job is graded |

Measured before and after, with real `bash` and real `flock` (the generated script run against a
throwaway bare repo, which is what `tests/remote-check.test.ts` section 9 does):

```
install:  BEFORE exit 1 "install failed"                 AFTER exit 7, no verdict line
signal:   BEFORE exit 130 (fell through to the FAIL line) AFTER exit 8  "INTERRUPTED by a signal"
lock:     BEFORE exit 1  "--- typecheck FAIL in 1s ---"   AFTER exit 9  "--- typecheck LOCK-TIMEOUT in 0s ---"
```

**The lock timeout is detected BEFORE the stage, not by its exit code.** `flock -w` gives up with
exit **1**, which is also `tsc`'s code for "there are type errors", so the two cannot be told apart
afterwards. The generated script therefore runs `flock -w <seconds> -E 75 <file> true` in front of
any stage whose command starts with `flock -w <seconds> <file>`: the probe releases the lock
immediately, cannot misread a real failure (it runs before any of the code does), and a conflict code
of 75 makes the stage report `LOCK-TIMEOUT`. 🔴 **Do not "simplify" this by adding `-E` to the stage
command itself** — `tests/ci-typecheck-lock.test.ts` pins its `flock -w <seconds> /tmp/phx-typecheck.lock`
prefix, because this caller and `ci.yml`'s own Typecheck step must never drift onto different lock
files, and that pin is what catches the drift.

**The Actions escalation now grades the stage, not the run.** A `workflow_dispatch` runs the whole of
`ci.yml` — including `mobile`, which REPORTS and never gates (AGENTS.md §7), the Build, and the
Playwright login smoke. Grading the run's own conclusion therefore charged this branch for somebody
else's breakage: a mobile lockfile bump or a smoke flake came back as `FAIL — <sha>` for a typecheck
that had passed. `gradeActionsStages` reads the run's JOBS and grades only the job and step that run
the requested stage (`lint`/`typecheck` → `checks`; `test`/`build` → `validate`), reports any other
red job beside the verdict, and treats a stage whose job is missing, unfinished, cancelled or skipped
as NO VERDICT — never FAIL. A real failure in the requested stage still outranks an unknown
elsewhere, exactly as the box script's own `FAILED` outranks `KILLED`.

🔴 **AND THE ESCALATION NEVER DISPATCHES ON `main`.** `ci.yml`'s concurrency group is `CI-<ref>` for a
pull request and **`CI-<sha>`** otherwise, with `cancel-in-progress` true only for a PR — so a
dispatch from `main` lands in the SAME group as the push run of that commit, which is the run
Railway's "Wait for CI" holds the production deploy on. A cancelled or failed suite there makes
Railway mark that deploy SKIPPED within minutes, and re-running it green does not resurrect it
(AGENTS.md §2.3). There is nothing to gain either: `main` already runs the whole gate on every
commit. It refuses with exit 6 and POINTS AT that run rather than reading it, which is where it now
differs from the open-PR arm above: `remote-check` is invoked from a feature branch (committing on
local `main` is itself banned, AGENTS.md §2), so a session that lands here has a worktree to go to
before any verdict would help it.

### The push guard leaked an `ssh`, which disarmed it for the rest of the session

`spawnSync`'s own timeout signals the `node` it started and nothing else. When the guard's 7-minute
cap fired, the `ssh` underneath survived: the box kept the run, kept `/tmp/phx-typecheck.lock` held,
and the **next** push met the busy probe, got NO VERDICT and went out unchecked. One orphan was
enough to turn the guard off silently.

The child now runs in a process group of its own (`detached` on POSIX) and the timeout reaps the
GROUP — `process.kill(-pid)`, SIGTERM then SIGKILL, with `taskkill /T /F` on Windows, where negative
pids do not exist. Measured with a stand-in child that spawns a grandchild which would outlive a
plain kill of its parent:

```
BEFORE  hook returned in 2310ms | grandchild pid 1746 | ALIVE AFTER: true
AFTER   hook returned in 2321ms | grandchild pid 1839 | ALIVE AFTER: false
```

That grandchild is pinned by `tests/push-typecheck-guard.test.ts`, which fails against the old guard
with the headline *"the grandchild outlived the guard's timeout"*. The guard still DENIES only on a
real typecheck FAIL; every NO VERDICT code above is now named in the note it leaves instead of
reading as "it exited 7".

## `AGENTS.md` — the full wording condensed out on 2026-10-08

AGENTS.md loads on every request and again after every compaction, so on 2026-10-08 these lines were shortened to their rule. Nothing was dropped: each block below is the wording as it stood, word for word, and the rule it carries is still in AGENTS.md. Search here for the evidence, the owner's words and the measurements behind a rule.

### §6 — One wide PR, roll-ups, and measuring CI

🔴 **ONE WIDE PR, NOT FIVE NARROW ONES — EVERY MERGE COSTS ~28 BILLABLE CI MINUTES** (owner,
2026-09-27: "you make many prs and many merges you can wider the contact of the pr to make less
merges"). A merge pays a full CI run on the PR **and** another on `main`, ~14 billable minutes each,
because GitHub rounds every job up to a whole minute. That VOLUME, not the pipeline, is the whole
bill. 🔴 **THE ONLY AUTHORITY ON WHAT THIS COSTS IS THE INVOICE — $300.88 for September, the highest
he has ever paid** (his own statement, 2026-09-27, correcting a session that had derived nearly twice
that from measured job minutes). **Never convert measured minutes into a monthly bill**: the billing
API needs a token scope no session here has, so a session cannot check its own arithmetic. Measure
minutes, report minutes, anchor money to the invoice he can read. **So batch related work into ONE
branch and ONE PR**: finish the whole task — the fix, its test, its doc, the follow-ups you can
already see — before opening it, and push fixups in fewer, larger commits (concurrency cancels
superseded PR runs, so two pushes a minute apart bill twice and verify once). Splitting is still
right when the parts need SEPARATE approval (a migration, a locked file, a protected rule) or when
one part is urgent and the rest is not — never merely because the change feels tidier in pieces.
🔴 **AND A FEATURE ARRIVING IN INSTALMENTS IS STILL ONE FEATURE — HOLD THE PARTS** (owner,
2026-09-29: *"batch the next feature into one PR, not six"*, after one shipped as six PRs in a
morning because he asked for the surfaces one at a time). When the next instruction is plainly the
same mechanism on another surface, a follow-up named in the same breath, or a pin of a ruling just
given, **hold it and open ONE PR when the feature is whole**, saying in one line that you are holding
so he can override. Widening a PR his approval already sits on is allowed — say so plainly and let
him re-confirm; it is no longer a reason to open a second.
`hold-a-whole-feature-for-one-pr-even-when-he-asks-in-pieces`
🔴 **AND A SMALL PR IS NEVER PUT TO HIM AT ALL — NOT EVEN WHEN IT IS THE ONLY ONE OPEN** (owner,
2026-10-12, 21:4x Cairo: *"i will not merge a small pr"*). #5802 — three files, a regenerated
cloud-context mirror — was put to him as the only open PR and therefore as one clean merge, which is
exactly the sentence this rule refuses: he did not ask which PR or weigh it, he refused the shape.
The 09-27 and 09-30 rules govern how the work is BUILT; this one governs what REACHES him. So a small
diff never appears in a `Next step:` line or in quoted words, and **`rollup-prs.mjs` reporting
"nothing to roll up" is not permission to hand the single PR over** — that is the exact gap, since
the script needs two or more open PRs with disjoint files and is silent by design when one is open.
The answer is to **widen it** — commit the work already in hand onto that same branch so the PR
stops being small — or to park it and say in one line what it is waiting for. What counts as small
is Claude's judgement, never his, exactly as it has been since 2026-09-30.
🔴 **NEVER HAND HIM MORE THAN ONE MERGE AT A TIME — TRIAGING OPEN PRs IS NEVER HIS JOB, AND
CONSOLIDATING THEM IS YOURS** (owner, 2026-09-30: *"i till now donot know what to do with small open
prs"*). He does nothing: he never decides which to merge, which to close, or what counts as small.
**Before asking him to merge anything, run `node scripts/rollup-prs.mjs`** — it groups every open PR
whose file set is DISJOINT from the others into one branch, reports which are SUPERSEDED and which
must stay SEPARATE (a migration, a protected file, a frozen path), and `--apply` opens ONE PR. It
never merges; `--settle` closes only a PR already byte-identical on `main`. 🔴 **A ROLL-UP'S MEMBERS
ARE NOW REFUSED MECHANICALLY — `bash-guard.mjs` C13 denies `gh pr merge` of any PR an open roll-up's
body lists**, because **a comment on a PR is not enforcement**: the ~3-minute window was lost at
least four times with this rule loaded. It reads the roll-up's own body, so nothing extra is marked;
the roll-up itself and an unreadable body both pass, and `PHX_MERGE_OK=1` stands it down. Pinned by
`tests/rollup-member-guard.test.ts`.
🔴 **`--apply` WAITS for the members' required checks and builds ONLY from the ones that finish GREEN** —
up to 25 min (`--wait <minutes>` or `PHX_ROLLUP_WAIT_MINUTES`; `--no-wait` takes whatever is green now).
**A quiet run is working, not hung.** A member that is red, unfinished at the deadline, pushed mid-wait,
or carrying checks older than its own head commit is LEFT OUT, not refused — it rolls up next run. **An
unknown flag is REFUSED**, because an ignored one runs an older worktree's behaviour while reporting
success. Account: the script's own header.
🔴 **THE WINDOW IS ABOUT THREE MINUTES, SO A ROLL-UP MUST BE MERGED BEFORE ITS MEMBERS, NOT MERELY
BUILT BEFORE THEM** (measured 2026-09-30). One opened at 13:16 lost both members by 13:18:55 — the
first 90 seconds after being commented on — which with the morning's #4814 makes **three members lost
in one day: the comment is a courtesy, never a guard.** So build it the moment `rollup-prs.mjs` names
one and put it to him in the SAME turn; never hold it until the members go green, which is what
`--apply`'s own 25-minute checks wait already covers. 🔴 **And if they land first, CLOSE it — never
merge it:** it then replaces no merges, its files are byte-identical on `main` (the `carried`
verdict), and merging is an empty squash paying a full `main` run. Account:
`docs/ci-self-hosted-runner.md`, "A roll-up must be merged before its members".
🔴 **MEASURE IN MINUTES, NEVER IN RUNS, AND NEVER FROM A SAMPLE — both lie**, and two sampled dollar
figures were published and corrected before this was re-measured from every run of the month.
`ci.yml` is ~89% of the bill, so nothing outside it is worth touching, and `main` already runs
exactly once per commit. **`main`'s ~40% is NOT reclaimable — it is the production deploy gate**
(§2), so the only lever left that costs no safety is the self-hosted runner. 🔴 **The Actions runs
API caps at 1,000 rows and truncates the OLDEST silently** — a wide query returning *exactly* 1,000
is truncated data wearing the shape of a complete month; count the rows and disbelieve that number.
Account for all three — the measured arc, why the run COUNT lies, and why 54 billable minutes went on
one 5-file PR: `docs/ci-self-hosted-runner.md`, "Why the volume is what it is", "Where the money
actually is" and "A feature arriving in instalments is still ONE feature".

## The same-module hold was removed (owner, 2026-10-19)

Bash-guard clause **C18** used to refuse a `gh pr create` whose conventional-commit scope matched a PR
open now or merged in the last six hours (asked for 2026-10-14 in the cost-cuts session, *"halve the
merge count"*, with `PHX_PR_HOLD_OK=1` as the stand-down). The owner ordered it removed on 2026-10-19 —
*"remove this fucken rule"* — typed as he stood the clause down by hand. **Never rebuild it.**
The clause, `scripts/pr-same-module-hold.mjs` and `tests/pr-same-module-hold-guard.test.ts` are gone, and
`PHX_PR_HOLD_OK` now means nothing.

What stays is the **judgement**, not a guard: every merge still costs a full CI run on the PR and another
on `main`, so related work still belongs in ONE branch and ONE PR (AGENTS.md §6, "ONE WIDE PR"), and a
small PR is still never put to him. Nothing refuses a second PR for one module any more.

## The tree-reuse DRY RUN — measuring whether a push to `main` repeats its PR's checks (owner, 2026-10-14)

Asked as *"build step 3 as a dry run"* after the lighter-main-CI plan. Measured 2026-10-14 over 12 push
runs: a push to `main` bills **12.3 minutes** (`validate` 6.2, `checks` 5.1, one more job 1.0), and `checks`
(lint, typecheck, the unit suite) repeats work the PR's run already did on its merge commit. If the commit
that lands has the **same tree** as that merge commit, the repeat proves nothing new. `main` moves about
every 26 minutes, so a PR is often tested against an older `main` and lands with a different tree — how
often is the open question, and the first, rough count (24 of 42 recent merges with an unchanged PR base)
is NOT trusted. **This ships only the measuring.**

**How it works.** In `checks`, a PR run writes the tree it tests into the NAME of a step (`Tested tree
<sha>`), because a step name is readable from the jobs API with `actions: read` alone. A push run finds
its PR from the `(#N)` in the squash subject, takes that PR's final head, finds the green PR run, reads the
name back and compares it with `git rev-parse HEAD^{tree}`; it says the verdict as the NAME of the next
step (`Tree reuse dry run MATCH|DIFFER|UNKNOWN`). **Read the result with `node scripts/ci-tree-reuse.mjs
--report 40`** — it counts verdicts from step names alone, so it needs no log download. Runs from before
this change read `no dry run`, and a PR run from before it reads UNKNOWN, so the first days under-count.

**What it must never become without the owner's word.** It changes nothing about what runs: both steps are
`continue-on-error`, push- or PR-only, the last two steps of `checks`, and `tests/ci-tree-reuse-dryrun.test.ts`
fails if ANY condition in `ci.yml` reads the verdict. The permissions it adds to `checks` are read-only
(`actions`, `pull-requests`). Skipping `checks` on a MATCH would be a separate decision: equal trees are the
same bytes, so it is not a diff classifier, but `tests/ci-gate-parity.test.ts` exists because skipping
required work on a guess has broken `main` twice. **Not done, and why:** the plan's build step. Skipping `main`'s build when the
narrowed build-risk classifier says no would drop the only build that sees a `src/**` break (the PR build
was narrowed on 2026-10-08 on exactly that understanding), and the strict "only docs, `.claude`, tests,
xlsx, markdown" version covers 2 of the last 80 merges — so it saves nothing.

### Tree reuse — SHADOW MODE replaced the dry run (owner, 2026-10-26)

His words: "observational only ... Any uncertainty means: FULL CI REQUIRED", "Do not consider a job reusable
simply because its status says SUCCESS", and "Do not automatically activate CI skipping after 14 days."
The three-way MATCH/DIFFER/UNKNOWN dry run above found the PR only from a squash subject's `(#N)` (merge and
rebase commits always read UNKNOWN) and trusted the run-level `success`. The same script now classifies
every push to `main` into five classes:

| Class | Means |
| --- | --- |
| `ELIGIBLE_FOR_REUSE` | identical tree, `ci.yml` on `main`, one same-repo human PR merged as exactly this commit, a one-commit push, the newest PR run's latest attempt green, every required job (`validate`, `static`, `unit (1)`, `unit (2)`, `checks`) green, AND every work step of `static` and both `unit` jobs green, finished under 12 hours earlier on the same UTC and Cairo day |
| `NOT_ELIGIBLE` | a definite no — direct push, fork or bot PR, a red, cancelled, skipped or missing required job, another workflow, different trees |
| `INSUFFICIENT_EVIDENCE` | cannot tell — no or several candidate PRs, a multi-commit push, no tree recorded, a stale or day-crossing PR run; also the fall-through |
| `SAFETY_CHECK_FAILED` | the evidence contradicts itself — forced push, subject and API name different PRs, two recorded trees, jobs from two attempts, a green job whose work step was skipped or cancelled |
| `HISTORICAL_DATA_UNAVAILABLE` | a git or API read failed, or the jobs are gone |

**How the PR is found:** `commits/{sha}/pulls` (squash, rebase and merge commits alike), cross-checked
against the subject's `(#N)` when there is one. A run's `pull_requests[]` is EMPTY once its PR merges
(read on run 40254982420), so it is never used; the run is matched by `head_sha` and `head_repository`.
"Did the push move `main` by one commit" is `before == sha^1` — the payload's commit count would mislead,
because a merge commit's push lists every commit of the PR.

**`validate` is never reusable** — its build, standalone assembly and Playwright smoke run on a push only.
**The unit suite reads production credentials**, so it is not hermetic; that is written into every record
as a caveat, and is why a day-crossing or 12-hour-old PR run is not enough.

**Output, never a gate:** the class and an estimated minute count in the next step's NAME (`Tree reuse
shadow ELIGIBLE_FOR_REUSE ~8 min`), a `tree-reuse-shadow-record {json}` log line and a table in the job
summary (no token, header or env). Read it with a bare `node scripts/ci-tree-reuse.mjs --report`
(false-eligible runs listed, shadow-step overhead measured) and backtest with `--replay 50` (read-only,
classifies past pushes from history). The step is push-only, `continue-on-error`, capped at 2 minutes,
and the script always exits 0. Activation is a separate decision that is the owner's alone; nothing
changes on day 14.

**The report reads the whole window or says it did not.** The fixed window is 26 Oct 2026 05:12 to 9 Nov
2026 05:12 Cairo (start included, end excluded), converted through the time-zone database because Cairo
leaves summer time at midnight on 30 Oct. GitHub's run search returns at most 1,000 results per query and
answers `total_count 0` past page 10, so the report splits any range whose count is over 1,000 at its
midpoint until each piece fits, reads every piece twice, keeps one record per run id (the highest
attempt), and checks that each piece returned exactly as many runs as GitHub counted. It reconciles the
runs with the push events on `main` (the activity API), not with commits, and reports pushes with a
verdict, without one, eligible, not eligible, insufficient evidence, missing, failed or cancelled, and
reruns. Retries back off and wait out a rate limit; a range that still fails is named in
`retrieval.gaps` and the status is `INCOMPLETE_RETRIEVAL`. Before day 14 the status is
`PARTIAL_OBSERVATION`, which says the window has not ended, never that data is missing; `--report <n>`
reads the newest n push runs with no cap.
