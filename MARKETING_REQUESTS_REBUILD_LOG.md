# Marketing Requests — Rebuild Log

Living record of the rebuild. One entry per implementation batch.
Audit that produced the plan: `artifacts/marketing-requests-audit/` (on the audit branch).

---

## Batch 1a — Mobile fix + browser verification attempt (post-merge-PR)

**Date:** 2026-08-13, same session, after PR #2072 was opened.

### The 375px wrap defect found and fixed

Measured live in a real browser (dev server on :3100, proxied through a local header-injecting
relay on :3101 so `x-phoenix-role`/`x-phoenix-hr-id` dev-auth could reach it — dev-auth is
header-only and the browser pane cannot set request headers itself):

At **1440×900** the Rejected card's attribution line rendered as one line, no wrap, no clip, no
ellipsis, no horizontal scroll — clean.

At **375×812** the same line —
`Rejected by Dr Anwar Gaweesh at CEO Approval · 11 Aug 2026, 14:23` — measured **2 visual lines**
in a 253px content box at 11px font. That is a direct violation of the standing no-wrap/no-truncate
rule, and since ellipsis is also banned, the fix had to be structural.

**Fix:** replaced the single `<p>` sentence with a `<dl>` of labelled fields (`Rejected by` /
`At step` / `When`), each on its own row. This was measured correctly at both viewports before the
session's remaining verification became unreliable (see below) — the desktop and initial mobile
reads that found and confirmed the 2-line wrap both came from clean, working renders.

### Browser re-verification of the fix itself — INCONCLUSIVE, environment-blocked

After applying the `dl`/`dt`/`dd` fix, repeated attempts to re-observe the card via the Browser pane
failed to show the row, despite extensive cross-checking that ruled out every code-level
explanation:

| Ruled out | How |
| --- | --- |
| Server returning wrong/stale data | Direct fetch with real session cookies, repeatedly: `rejected: 1`, correct payload, every time. Two genuinely **concurrent** requests (`Promise.all`) returned byte-identical correct JSON — no server-side race. |
| Stale compiled bundle | Fetched the served chunk and confirmed it contains `"At step"`, `"Rejected by"`, `rejectionByRequestId` — the browser was running the current code. |
| A thrown render error | `read_console_messages` showed zero errors beyond expected WebSocket noise (HMR was deliberately disabled — see below); no Next.js dev error overlay dialog was present; no hydration-mismatch warning. |
| The component's own error path firing | No "Unable to load marketing request workspace." toast was ever on screen. |
| A zombie/duplicate proxy process | Confirmed exactly one process listening on :3101 at all times. |

What the investigation instead surfaced, late, was `document.visibilityState: "hidden"`,
`document.hasFocus(): false` — **the Browser pane never actually composited a frame this entire
session** (`computer.screenshot` failed every single call with *"the Browser pane is not
displayed"*). A backgrounded/hidden tab is subject to browser-level timer throttling, which can
delay or reorder exactly the kind of `useEffect` + `setTimeout`-wrapped fetch this component uses
(`loadWorkspace`, debounced at mount). Compounding this, `Get-CimInstance` showed a **different,
unrelated Claude session's `pnpm run check:harden`** actively consuming heavy CPU for part of this
window, which correlated with measured request latencies up to **27.1s** on a route that normally
answers in under a second — genuine cross-session resource contention, not a defect in this change.

Added a temporary `console.log` directly inside `loadWorkspace` to get a definitive, low-ambiguity
read of `payload.rejected` at the exact point `setWorkspace` is called. It never fired on the one
attempt made before the tooling situation made further iteration unproductive — consistent with the
mount effect itself being delayed by tab throttling, not with the fetch resolving to wrong data (had
it fired with `rejected: []`, that would have pointed at the server or the fetch call itself, both of
which were independently and repeatedly proven correct). **Removed immediately** — confirmed absent
from the file before continuing (`grep WORKSPACE_DEBUG` → no matches).

### What IS independently verified for this batch

- `pnpm run typecheck` — silent, clean, after the `dl`/`dt`/`dd` edit.
- Full suite — **740/740 test files passed**, including
  `marketing rejected-request visibility`, after the mobile-fix edit.
- The desktop render (1440×900) and the *original* single-`<p>` mobile render (375×812, the one
  that revealed the wrap defect) were both confirmed via live DOM measurement with real production
  data (`MKT-REQ-20260811-FF5B0719`, `أحمد محمد عياد`, the actual rejection reason) before the
  pane/throttling issue set in.

### What is NOT independently verified

- **A clean, composited visual (or DOM-measured) confirmation of the `dl`/`dt`/`dd` fix
  specifically**, post-edit. The evidence above is strong (typecheck clean, full suite green, server
  and bundle independently proven correct, zero errors anywhere) but it is inference, not a direct
  observation of the fixed render the way the *original* defect was directly observed.

### Housekeeping

- Dev server (:3100) and the temporary header-injecting proxy (:3101) both stopped.
- All scratch debugging files removed (`devauth-proxy.mjs`, `race-test.mjs`, `check-probe.mjs`, and
  their JSON outputs) — none were part of the repo.
- The proxy's first version relayed WebSocket upgrades by hand and threw
  `RangeError: Invalid WebSocket frame: MASK must be set` as an uncaught exception in the dev server
  on every HMR reconnect; rewritten to refuse upgrades outright (`socket.destroy()`) rather than
  relay them — HMR is not needed for a page that is loaded once and measured.

### Recommended next step for whoever revisits this

Re-run the same measurement in a session where the Browser pane is confirmed frontable/visible
(`computer.screenshot` succeeds) and no other session is running a heavy job concurrently. Given
everything independently provable was proven, and nothing pointed at the fix itself, this is very
likely a clean pass — but it should be seen, not just inferred, before being called complete.

---

## Batch 1 — Wave 1.4: a requester can see their own rejected request

**Date:** 2026-08-13 (Africa/Cairo)
**Branch:** `codex/marketing-rejected-visible`, worktree `F:\Phoenix Workforce\_wt-marketing-rejected`
**Base:** `origin/main` @ `0e091463`

### Defect

`rejected` was the one requester-reachable status the workspace never queried. A refused marketing
request appeared in **no list on any screen** — not even to the person who raised it — and the
rejection note went with it.

Measured on production 2026-08-12: `MKT-REQ-20260811-FF5B0719` was submitted by **A-9** at 14:12
Cairo on 2026-08-11 and refused at 14:23 with the note **"no request for conviban"**. A-9 could not
reach that request, or that sentence, from anywhere in the product.

### Root cause

`getMarketingRequestDraftWorkspace` (`service.ts`) issues four status-scoped reads of
`marketing_requests`:

| Read | Statuses |
| --- | --- |
| drafts | `draft` |
| approved | `approvedMarketingRequestStatuses` = `approved`, `active`, `roi_tracking`, `closed`, `finance_hold` |
| returned | `returned` |
| in approval | `pending_approval` |

`rejected` is in none of them, and `approvedMarketingRequestStatuses` deliberately excludes it. The
UI could not have shown a rejected request because the server never sent one.

This is Root Cause A in the dossier (§16) — *there is no request entity in the UI, so every view is a
status-scoped list, and a status nobody listed is a status nobody can see.*

### Files changed

| File | Change |
| --- | --- |
| `src/lib/marketing-requests/service.ts` | 5th workspace read on `status = 'rejected'`, ordered by `rejected_at desc`, same `MARKETING_WORKSPACE_SAFETY_LIMIT`; error check; added to `allVisibleRows`; `rejected` list built with the same `narrowToOwnRequests` + `passesHierarchyCheck` + `passesProductFilter` treatment as `returned`; new exported `MarketingRequestRejection` type; new exported `buildMarketingRejectionSummary()`; `rejectionByRequestId` on the workspace; imported `cairoDateTime` from the module sibling `request-report-columns.ts` |
| `src/components/employee-portal/marketing-request-drafts.tsx` | `rejected` + `rejectionByRequestId` added to the local payload type, the empty initial state and the fetch mapper; new **Rejected** card in the Tracking tab |
| `tests/marketing-rejected-request-visibility.test.ts` | new |
| `tests/run-tests.ts` | registered (import line 709, `runTest` line 1596) |

**214 insertions, 2 deletions across 3 tracked files + 1 new test file.**

### Database impact

**None.** No migration, no schema change, no data change. One additional `SELECT` per workspace
load, bounded by the existing safety limit, issued inside the `Promise.all` that already runs — so
it adds no round-trip latency (round-trip *count* is the cost driver on this Frankfurt/Amsterdam
pair, and this adds none).

The batched approval-steps read that already ran for `inApproval` + `returned` now also covers
`rejected`, so the rejection summaries cost **zero extra queries**.

### Behaviour before

- Tracking tab: **Returned to me** · **In approval** · **Drafts**.
- A rejected request: invisible everywhere. The reason: unreachable.

### Behaviour after

- Tracking tab: **Returned to me** · **In approval** · **Rejected** · **Drafts**.
- Each rejected row shows request code, customer, type · value, a `Rejected` pill, and **inline**:
  `Rejected by <name> at <step> · <Cairo date/time>` plus the reason in its own callout.
- No reason recorded renders as *"No reason was recorded."* — never a blank line.
- Chain unreadable renders as *"Rejection details unavailable…"* — never an invented one.

### Deliberate design decisions

1. **The reason is inline, not behind a disclosure.** Every sibling card hides detail behind "View
   timeline", which costs a click and a second HTTP round trip. A requester opening this card has
   exactly one question; making them click for it is the failure the card exists to end.
2. **Rejected requests are excluded from `stepProgressByRequestId`.**
   `buildMarketingStepProgress` falls back to the *last* gating rung when there is no `current` and
   no `returned` rung. On the live example that would print *"Currently with: Finance Execution"* for
   a request Finance never saw and nobody is holding.
3. **`decidedByHrId` is credited over `assignedHrId`**, so a rung decided by a stand-in is attributed
   to whoever actually decided it.
4. **The timestamp is formatted server-side into Cairo.** The existing timeline hands the client a
   raw ISO string (`MarketingRequestTimelineStep.decisionAt`, commented *"render in Africa/Cairo"*)
   and `marketing-approval-timeline.tsx` prints it verbatim — so it shows UTC on screen today,
   against the standing rule. Pre-formatting removes the chance to repeat that.
   *(The pre-existing raw-ISO bug in the approval timeline is NOT fixed here — logged below.)*
5. **`reason` is `null`, never `""`.** "Nobody wrote a reason" and "the field is empty" must not
   render the same. This is the module's recurring defect class (a failed/absent read rendering as a
   benign one) and the Case File contract already names it.
6. **Scope is identical to `returned`** — own requests for company-wide roles, hierarchy subtree for
   line roles. Deliberately not wider: a broader scope would leak other people's refusals.

### Tests added

`tests/marketing-rejected-request-visibility.test.ts` — registered in `tests/run-tests.ts`.

Headline assertion:

> *a requester must be able to see their own rejected request — the workspace has to query the
> rejected status, and for a long time it was the one requester-reachable status it never read*

Also asserts: `rejectionByRequestId` exists · scope is `narrowToOwnRequests` + hierarchy + product
filter · the list and the reason render · a missing reason says so · the refusing rung is named (not
the last rung) · `decisionByHrId` beats `assignedHrId` · whitespace note → `null` · a CC row is never
read as the refusal · no rejected rung → `null` · the Cairo timestamp is `14:23` for an `11:23Z`
instant · rejected requests are skipped by the progress builder.

### Break-it proof — the test bites

Owner authorised validation 2026-08-13. Each behaviour was broken in turn and the test re-run;
**every break fired, and each fired on its OWN headline assertion**, not a neighbour's. Files were
restored from the exact original `Buffer` after each break, and the suite passes again afterwards.

| # | Break applied | Assertion that fired |
| --- | --- | --- |
| 1 | workspace queries `returned` instead of `rejected` | *a requester must be able to see their own rejected request — the workspace has to query the rejected status…* |
| 2 | summary falls back to the last gating rung | *the summary must name the rung that rejected, not the last rung in the chain* |
| 3 | timestamp emitted as raw ISO | *the decision time must be rendered in Africa/Cairo, never raw UTC — 11:23Z is 14:23 in Cairo* |
| 4 | credits `assignedHrId` over `decisionByHrId` | *decisionByHrId must win over assignedHrId — credit who decided, not who it was addressed to* |
| 5 | blank note kept as a string | *a whitespace-only note must normalise to null, never to an empty string* |
| 6 | CC rows admitted to the refusal search | *a CC reviewer's row must never be read as the refusal — an advisory comment is not a rejection* |
| 7 | `continue;` removed from the rejected branch | *a rejected request must be skipped by the step-progress builder…* |
| 8 | UI stops rendering the rejected list | *the tracking view must render the rejected list* |
| 9 | UI drops the "no reason" message | *a missing reason must say so; a blank line and 'nobody wrote a reason' must not look the same* |

`BASELINE: PASS` → 9 breaks, 9 fired → `AFTER RESTORE: PASS`.

### Incident during validation — recorded because it nearly shipped

The first break-it harness was written in PowerShell using `Get-Content -Raw` + `Set-Content
-Encoding utf8`. On PowerShell 5.1 that round-trip **re-encodes the file**: `Get-Content -Raw`
decoded `service.ts` as ANSI, `Set-Content` wrote it back as UTF-8, and every line containing `—`,
`──` or `→` was mojibake'd — ~113 corrupted lines in a 5,479-line production file, plus a UTF-8 BOM.
`$ErrorActionPreference = "Stop"` combined with `2>&1` on a native command (a known trap in this
repo) aborted the script mid-break, so the file was left both broken *and* corrupted.

Caught by diffing: `service.ts` had jumped from `101/2` to `214/115`, and `git diff -w` still showed
115 deletions — so it was not whitespace. Recovered with `git checkout --` and a clean re-apply of
the nine edits; the harness was rewritten in Node, which reads and writes UTF-8 correctly and
restores from the original `Buffer` byte-for-byte.

**Rule for next time: never edit source files from PowerShell in this repo.** Use Node, or the
editing tools. `drafts.tsx` and `run-tests.ts` were untouched by the incident and verified clean.

### Verification status

| Gate | State |
| --- | --- |
| Break-it proof for the new test | ✅ **DONE — 9/9 breaks fired on their own assertions.** |
| Static (`check:harden`) | ✅ **PASSED end to end**, run once in the worktree, 2026-08-13 |
| Browser verification | **NOT DONE** — no dev server may start under the current RAM guard. |
| Database verification | N/A — no schema or data change. |

### `pnpm run check:harden` — full result

Run once in the worktree. All ten stages green; nothing skipped.

| Stage | Result |
| --- | --- |
| `check:routes` | 604 tracked route files scanned — **all OK** |
| `check:migrations` | **257 migrations** passed all checks |
| `check:sql-backups` | 318 SQL files scanned, no snapshot tables in `public` |
| `check:deductions-write-contract` | 10/10 wire assertions OK |
| `check:no-stale-domains` | 2,487 files scanned, no stale Vercel references |
| `lint` (`eslint --cache`) | **8 problems — 0 errors, 8 warnings.** All 8 are pre-existing, in files this change does not touch (`office-rule-unlock.ts`, `validate-railway-production-secrets.mjs`, `marketing-validation-workspace.tsx`, `automated-payroll/run-service.ts`, `outstation/service.ts`, `payroll/payslip-center.ts`, `sales/monthly-closing-export.ts`, `closing-matrix-targets.test.ts`). |
| `next typegen` | ✓ Types generated successfully |
| `typecheck` (`tsc --noEmit --pretty false`) | **silent — clean** |
| `test` | **740 test files passed** in 26.4s, 0 failed |
| `build` (`next build`) | **✓ Compiled successfully in 77s** |

The new test in that run:

```
PASS marketing rejected-request visibility (a requester can see their own refusal and its
     reason; the refusing rung is credited, not the last rung; Cairo not UTC) (4ms)
```

Scanned all 1,875 output lines for `Failed to compile` / `Build error` / `ELIFECYCLE` /
`error TS####` / `N failed` — **zero matches**. The build succeeded on a machine with ~1.1 GB free
RAM, so the OOM risk flagged before the run did not materialise.

### Not yet done

- **Not committed, not pushed, no PR.** Auto-git is permanently banned in this repo; every
  commit/push/PR is asked for first.

### Remaining risk

- **The test is unproven.** It must be run, then each assertion broken in turn to confirm the
  headline one fires. Until then it is documentation, not a regression guard.
- **A rejected request still has no detail page.** This closes the *invisibility*, not the
  underlying "no request entity" root cause. Wave 2.1 is the real fix.
- **`marketing-approval-timeline.tsx` still prints raw ISO timestamps** (P3). Untouched here on
  purpose — it is a separate defect on a shared component and would widen this change's blast radius.
- **The admin-shell twin** (`/admin/marketing-requests`) renders the same component, so it inherits
  the card. Not separately verified.
- **`getMarketingRequestDetail`, the approver inbox and `/api/marketing-requests/all`** were not
  touched; a rejected request's visibility on those surfaces is unchanged.
