---
name: github-actions-cron-secret-went-stale-after-a-railway-rotation
description: "CRON_SECRET exists in TWO stores - GitHub Actions secrets and Railway - and the arrow points GitHub -> Railway: sync-railway-production-secrets.yml rewrites it into Railway production unconditionally on any push touching that workflow or its .mjs, so rotating in Railway ALONE does not stick and 401s every cron-job.org job at once. Rotating only Railway (2026-08-14) already 401d the Direct Orders sweeps for nine nights with no alert. Since 2026-08-23 nothing SCHEDULED reads the GitHub copy, only a manual workflow_dispatch - but the sync still does"
metadata: 
  node_type: memory
  type: project
  originSessionId: 95a9153c-7cad-40ba-8918-05de11f9c69f
  modified: 2026-08-24T00:09:16.017Z
---

**Rotating `CRON_SECRET` on Railway is only half a rotation.** Found 2026-08-23, nine nights late.

**RE-ALIGNED 2026-08-23 17:45 Cairo** at the owner's instruction — the GitHub copy now holds the
same value as Railway (`updated_at` moved 2026-08-05T09:19:25Z -> 2026-08-23T14:45:10Z). This was a
RE-ALIGNMENT, **not a new-value rotation**: the secret itself is unchanged everywhere. Piped
railway -> `gh secret set` in one process so the value never reached a file, a log, or the session.
Verified after: `direct-orders-expire-held` returned `HTTP 200 {"success":true,"expired":0}` with 1
held order aged 5 days and none past 14 — the quiet-day answer, nothing mutated.

**The real hazard was not the stale copy lying unused — it was LOADED.**
`sync-railway-production-secrets.yml` passes `secrets.CRON_SECRET` INTO Railway and fires on any
push to `main` touching that workflow or `scripts/sync-railway-production-secrets.mjs`. So the
2026-08-05 value was one unrelated edit away from overwriting the live one and 401ing every job at
once. Re-aligning disarmed that, and it stays disarmed only while both copies match.

**SUPERSEDED 2026-08-24: the "all 17 matched" line below was true when written and was FALSE within
hours.** A rotation later on 2026-08-23 (~17:00 UTC) reached only 10 of the 17 — the fleet then held
**two distinct fingerprints at once**, which is the signature to look for. The 7 left on the old
value included `phoenix-synthetic-journeys`, which 401'd hourly 20:00–02:00 Cairo. See
[[a-partial-cron-secret-rotation-leaves-two-fingerprints]]. Never re-assert "all N match" from an
older note — sweep the fingerprints live.

**Count correction: cron-job.org now holds 17 jobs, 12 enabled — not 14.** All 17 carry an
`Authorization` header and on 2026-08-23 all 17 matched Railway. Compare them by sha256 fingerprint
via `GET /jobs/{id}` -> `.jobDetails.extendedData.headers`; never print the token. A TRUE rotation
therefore means 19 writes (Railway + GitHub + 17 jobs) with an unavoidable 401 window between the
Railway write and the last PATCH — do it in one scripted pass, not by hand.

`CRON_SECRET` lives in two independent stores:

| Store | Who reads it | How to check |
| --- | --- | --- |
| **Railway** production env | the running app, and **cron-job.org**'s **14** jobs send the matching value | `railway variables --environment production --service phoenix-people-workforce --json` |
| **GitHub Actions** repo secret | `.github/workflows/direct-orders-sweeps.yml` — since 2026-08-23 it has **no `schedule:`**, so this copy is now read only by a hand-run `workflow_dispatch` | `gh api repos/it-gawish-hr/phoenix-people-workforce/actions/secrets/CRON_SECRET` → read `updated_at` |

The 2026-08-14 rotation (the one in [[railway-stdin-bom-trap]]) updated Railway and cron-job.org.
GitHub's copy still read `"updated_at": "2026-08-05T09:19:25Z"`. So **eleven cron jobs kept working
and exactly two broke** — the two Direct Orders clocks, because they were the only ones scheduled
from GitHub Actions rather than cron-job.org. That asymmetry is why it looked like a Direct Orders
bug and not a secret bug.

**Both clocks were moved into cron-job.org on 2026-08-23** — `phoenix-direct-orders-expire-held`
(job `8313165`, 02:17) and `phoenix-direct-orders-probation` (job `8313177`, 02:27), both
Africa/Cairo. So the asymmetry is gone: a future half-rotation now breaks **all fourteen jobs at
once**, which is impossible to miss, instead of two stragglers nobody watches. The stale GitHub copy
is still stale and still worth re-aligning, but it no longer stops anything from running — treat it
as a manual-fallback credential, not a production one. See
[[cron-job-org-is-managed-by-a-rest-api-not-just-the-web-ui]].

`sync-railway-production-secrets.yml` pushes **GitHub → Railway**, never the reverse, and it is
path-filtered to changes in itself (last run 2026-08-09). It cannot notice or repair this drift.
**The convention it implies is: rotate on GitHub first, then run that workflow.** Rotating directly
on Railway silently breaks it.

**Diagnosing this without printing the secret** — length + first char code rules out the BOM trap,
and a live 200 proves which copy is good:

```powershell
$s = (railway variables --environment production --service phoenix-people-workforce --json | ConvertFrom-Json).CRON_SECRET
"len=$($s.Length) firstCharCode=$([int]$s[0])"   # 64 / 101 = clean; 65279 = BOM
curl.exe -s -w "`nHTTP=%{http_code}" -H "Authorization: Bearer $s" `
  "https://phoenix-hr.satopharma.com/api/cron/direct-orders-expire-held"
```

`direct-orders-expire-held` is the **safe probe**: it is idempotent and expires nothing unless an
order is genuinely past 14 days, so it returns `{"success":true,"expired":0}` on a quiet day. Check
`direct_order_requests where status='held'` first. Do **not** probe with `direct-orders-probation` —
it emails the owner and the CEO when it flags anything.

Re-align (owner runs it — a session must not handle the token):

```bash
railway variables --environment production --service phoenix-people-workforce --json | jq -r .CRON_SECRET | gh secret set CRON_SECRET --repo it-gawish-hr/phoenix-people-workforce
```

Related: [[railway-stdin-bom-trap]] (the rotation that started it),
[[a-cron-that-fails-nightly-can-do-so-forever-unwatched]] (why nobody noticed),
[[railway-token-expired-breaks-all-secret-sync]].

## 2026-08-24 — it happened again, and the "all 17 matched" line above was already stale

**Six of the twelve enabled cron-job.org jobs were holding a SUPERSEDED secret**, found ~03:00 Cairo
2026-08-24. A rotation moved Railway to a new `CRON_SECRET` and only half the jobs were re-written —
almost certainly the 100/day API quota dying mid-sweep
([[cron-job-org-rest-api-is-100-requests-per-day]]). **The paragraph above claiming all 17 matched on
2026-08-23 was true when written and false hours later — do not trust it, re-measure.**

Stranded (old): `notify-daily` 8200909 · `synthetic-journeys` 8220577 · `direct-orders-expire-held`
8313165 · `direct-orders-probation` 8313177 · `direct-orders-rotate-sheet-token` 8313169 ·
`marketing-requests-rotate-sheet-token` 8313171. Healthy: 8200914, 8200915, 8200919, 8200920,
8242721, 8313297. **Not in job-id order** — do not assume a prefix of the list survived.

🔴 **A 401'd cron job is SILENT, not loud.** The route rejects before `pingDeadMansSwitch`, so there
is no failure ping, no GitHub dispatch, and no log the owner sees — it looks exactly like "not due
yet". Only the HOURLY job blew its grace window and surfaced; the daily/weekly ones were invisible.
`notify-daily` was 3.5h from silently skipping the whole company's daily email.

**Diagnose from Railway, not from the scheduler:** `railway logs` →
`Unauthorized cron invocation: <job>` with `context.hasAuthHeader:true` and
`userAgent:"…cron-job.org…"` proves the caller is still calling with a stale token. `hasAuthHeader:false`
is just someone probing the URL unauthenticated (my own curl looked exactly like that — don't confuse them).

**Audit WITHOUT spending API quota: use the web UI.** `console.cron-job.org` is session-authed and is
NOT subject to the 100/day API limit, so it works even while the API returns 429 on every endpoint.
Per job, run in the page: hash the input whose value matches `/^Bearer /` and compare the first 12
hex of sha256 against Railway's `CRON_SECRET`. Compare fingerprints, never print the token.

**Console automation traps (cost ~10 wasted steps):**
- Setting the field with the React native-value setter + `input` event **appears to work and does not
  persist** — Save writes the OLD value back. Only a real click + `ctrl+a` + `ctrl+v` sticks.
- `computer left_click` **by `ref`** silently misses on this console; the header field lives behind the
  **ADVANCED** tab and the ref click often leaves COMMON active. Screenshot, then click by COORDINATE.
- The left sidebar **collapses**, moving ADVANCED from x≈503 to x≈319 and the value field from x≈875 to
  x≈812. Re-screenshot after every navigation; do not reuse coordinates across pages.
- `navigator.clipboard.writeText` throws `Document is not focused` right after a `navigate` — click the
  page once first. sessionStorage survives same-tab navigation, so stash the good value there and
  re-write the clipboard on each page; the secret then never enters the session context.
- **ALWAYS reload and re-fingerprint after Save.** Two saves reported nothing and had not persisted;
  the success toast also fades before a 4 s screenshot, so absence of a toast proves nothing.

**Proof it was fixed** (three independent sources, all required): cron-job.org history
`synthetic-journeys` 03:00:03 Cairo **Successful (1.96 s)** after 02:00:03 **Failed** · Healthchecks
`phoenix-run-synthetic-journeys` **down → up**, ping 00:00:05Z · GitHub a fresh `workflow_dispatch`
00:00:05Z closing a 7-hour gap. Related: [[a-cron-that-fails-nightly-can-do-so-forever-unwatched]].

## 2026-08-24 00:33Z — fleet 17/17, and the GitHub copy re-aligned again

**All 17 jobs now carry ONE fingerprint** (`363218FB974ADF9F` = sha256("Bearer "+secret)[0:16]).
The 5 remaining stragglers were the **disabled** ones — `inbound-intake (Copy)` 8203339,
`ireports360-live-sync` 8200918, `ireports360-reconcile` 8203342, `ireports360-sync` 8200916,
`reconcile-visits` 8200910. **Owner instruction: fix the disabled ones too** — a dead credential
parked in a third-party account is a liability, not an audit trail. A partial PATCH of
`{job:{extendedData:{headers:…}}}` preserved `enabled`, `schedule` and `lastExecution` on all five
(asserted after each write — re-enabling the Copy would double every inbound-intake run).

**GitHub Actions copy re-aligned 2026-08-24T00:33:22Z** (was `2026-08-23T17:03:06Z`, i.e. it HAD been
rotated with the fleet — 3 min after the first 401 — so it was probably already correct; re-aligned
anyway because a GitHub secret is write-only and "probably" is not verifiable). This disarms
`sync-railway-production-secrets.yml`, which pushes **GitHub → Railway** on any push touching itself
or `scripts/sync-railway-production-secrets.mjs`: a stale copy there would overwrite Railway and
401 the whole fleet at once.

**Re-align safely without the value reaching a file, a log, or the session** — and assert the bytes
BEFORE writing, because a past rotation stored a BOM unnoticed:

```bash
raw="$(railway variables --environment production --service phoenix-people-workforce --json \
        | sed '1s/^\xEF\xBB\xBF//')"                       # strip UTF-8 BOM
secret="$(printf '%s' "$raw" | jq -r '.CRON_SECRET' | tr -d '\r\n')"   # strip CRLF
[ "${#secret}" -eq 64 ] || exit 1
printf '%s' "Bearer ${secret}" | sha256sum | cut -c1-16     # must equal the live fleet's fp
printf '%s' "$secret" | gh secret set CRON_SECRET --repo it-gawish-hr/phoenix-people-workforce
```

`updated_at` moving proves the write landed; the pre-pipe fingerprint proves WHAT landed. A GitHub
secret cannot be read back, so those two together are the strongest available proof short of firing
a workflow — and **do not fire `direct-orders-sweeps.yml` to test it**: it has no route selector and
runs `direct-orders-probation`, which emails the owner and the CEO ([[never-fire-bulk-emails-ever]]).

## 2026-08-31 — the sync FIRED, and the "last run 2026-08-09" line above is stale

**`sync-railway-production-secrets.yml` is not dormant.** The line above calling it
"path-filtered to changes in itself (last run 2026-08-09)" was true for three weeks and is now
wrong — do not read it as evidence the hazard is theoretical.

PR #2820 touched `scripts/sync-railway-production-secrets.mjs` (adding the attendance browser
token), which fired run **33407660884** at **15:18:11Z**. Its log reads `synced CRON_SECRET` and
`completed: updated=48, skipped=7` — it rewrites **every** mapped variable on every firing, with no
diffing and no "only if changed". So the window in which a stale GitHub copy silently overwrites
Railway is not rare: it opens on any push touching either of those two files.

**Proof the alignment held** (the disarm from 2026-08-24 is still holding): a production redeploy
at **15:45:00Z** activated the freshly-written value — variables are injected at container start
and the sync passes `--skip-deploys`, so the write sat inert for 27 minutes — and
`ireports360-sync-cron` then wrote 122 `audit_logs` notification rows at **15:48:20Z**. A cron route
authenticating three minutes after the new value went live is positive proof the copies match.
`app_error_events` showed 0 auth failures, but that is the weak half: per
[[app-error-events-is-user-triggered-zero-is-not-broken]] a zero there means quiet, not healthy —
the authenticated write is what proves it.

⚠ **That 27-minute gap is the trap to remember.** `--skip-deploys` means a clobbered `CRON_SECRET`
does nothing at all until the next deploy, which may be days later and will be some unrelated
commit. The 401s then appear to start with that deploy, and the secret sync that actually caused
them is invisible in its history. If cron auth breaks right after a deploy, check
`sync-railway-production-secrets.yml`'s last run before you touch the deploy.

**The stale instruction in `direct-orders-sweeps.yml` is retired** — it said the repository's copy
"is the copy that went stale. Re-align it before relying on a manual run", which was true only on
2026-08-23 and would have caused a needless rotation. Corrected in PR #2824, which also moved the
guarded re-align (BOM strip, length assert, fingerprint before writing) into
`docs/agents-production-hooks.md`, and repointed both HTTP 401 handlers at it — they had been
recommending the bare `railway | jq | gh` pipe, which is precisely how a BOM reaches production
now that GitHub is upstream.

**Counts in that workflow's comments are now count-free**, because the ones there ("twelve",
"fourteen") were superseded by 17 total / 12 enabled on 2026-08-24 and nothing would have caught it.
