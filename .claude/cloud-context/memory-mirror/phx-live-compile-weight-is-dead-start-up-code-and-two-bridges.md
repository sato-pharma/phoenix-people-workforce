---
name: phx-live-compile-weight-is-dead-start-up-code-and-two-bridges
description: "Why `next dev` (phx-live, and the laptop's pnpm run dev) compiles so much, measured 2026-10-17: ~70% of the server code compiled before the first page is the start-up hook's three schedulers + the Sentry SDK, none of which can run under next dev; per page, the portal sidebar imports the whole Phoenix CRM page loader (+227 files) and dashboard/invalidation imports two cache-tag STRINGS from sales and vacation (+79 modules on ~1,160 routes). Fix = compile-time gates + moves, not the heap or the allocator. SHIPPED as PR 6048 (merged + live 2026-10-17 19:16 Cairo). MEASURED on the box: MemoryHigh hits 2,820 -> 307, swap 2.1 GB -> 0.2 GB, navigation 23.7 s -> 13.7 s, edge-instrumentation 6.1 MB -> 0.1 MB; still touches the 6.8 GB cap once."
metadata:
  node_type: memory
  type: project
  originSessionId: 164a490b-b177-4b7c-a3bc-cd2c15da8076
  modified: 2026-10-17T16:22:41.298Z
---

Measured 2026-10-17 16:50-17:30 Cairo on the box's own `.next/dev/server` output (phx-live, base
`f72f4149c`, after compiling only /login), plus a static import graph of the repo that matched the
compiled module counts closely (employee directory 120 static vs 117 compiled). Owner's ask: "find
which imports make phx-live's compiles so heavy".

**Before the first page (the ~5.4 GB /login baseline):** compiled server output 108 MB, of which
- 56 MB = the start-up hook (`instrumentation.ts`): the CRM live poller (14.6 MB), CRM housekeeping
  (14.6 MB) and Early Birds close scheduler (23.6 MB) chunks — 465 repo files — plus a 6 MB edge copy
  that is almost all Sentry. 🔴 All three schedulers REFUSE to start unless `NODE_ENV=production`
  (`resolveInProcessHostRefusal` in `src/lib/crm/live-poller.ts`), so under next dev they are compiled
  and never run.
- ~20 MB = the Sentry SDK vendor chunks (`@sentry/conventions` 5.7, `server-utils` 4.7, `core` 4.0,
  `server-runtime-injection` 3.0, `node` 1.4, `nextjs` 0.9). Sentry is off on every dev run (gate is
  APP_ENV=production + DSN; phx-live sets APP_ENV=development, the laptop's .env.local leaves it empty).
  It enters through dynamic imports of `src/lib/observability/sentry-server.ts` in instrumentation.ts
  (x2), `dead-mans-switch.ts` (imported by 44 files) and `process-health.ts`.
- the login page itself: 3 MB.

**Why the guards do not prune it:** webpack drops a dynamic import only inside a BLOCK-form `if` on an
env var Next defines at build time (`NEXT_RUNTIME`, `NODE_ENV`). Proof in the same output: the
block-form `if (process.env.NEXT_RUNTIME === "nodejs") {…}` keeps the schedulers out of the edge bundle,
while `forwardRequestErrorToSentry`'s early `return` does NOT keep sentry-server out of it. A RUNTIME
guard (`sentryServerStatus(...)`, `PHOENIX_LIVE_CRM_POLL`) prunes nothing.

**Per page, the two bridges (static graph, 1,616 pages/routes/layouts):**
- `src/components/employee-portal/employee-portal-server-shell.tsx` (the portal layout, so EVERY
  portal page) and `app/api/employee-portals/navigation/route.ts` import `phoenixCrmSidebarEntries` from
  `src/lib/phoenix-crm/server/page.ts`, which also imports `loadPhoenixCrmOverview` -> visit-asks ->
  insight reports: +227 files. The sidebar function uses none of it. Also imported the same way by
  profile, payslips, visits, plans and field-crm/day pages.
- `src/lib/dashboard/invalidation.ts` imports `CLOSING_STORE_SPLIT_CACHE_TAG` ("closing-store-split")
  and `COMPANY_VACATION_REPORT_CACHE_TAG` ("company-vacation-report") from their owners; the employee
  directory imports invalidation, so 79 modules / 4 MB of sales + vacation ride into ~1,160 routes. The
  file already declares FINANCE/VACATION_REPORT_ROWS tags locally for this exact reason.
- Real calls, harder, left alone: `notifications/in-app.ts` -> `approvals-hub/service.ts` (127 files,
  152 routes); `resignations/service.ts` -> `recruitment/offer-outcome-sync.ts` (304 routes).
- The portal LANDING page reaches ~770 files on its own imports and genuinely uses them.

**Projected effect of the fix set** (schedulers + Sentry imports inside block-form `NODE_ENV ===
"production"` gates; the sidebar entries moved to a module without the overview loader, page.ts
re-exporting; the two tag strings declared in invalidation.ts): start-up 465 -> 24 repo files and no
Sentry SDK; portal layout 728 -> 475 files; navigation route 675 -> 422; 1,167 of 1,616 routes smaller,
14.9% fewer files summed. No runtime change anywhere: production keeps NODE_ENV=production. GB saved is
NOT known until it is measured on the box with the same six-request workload
(scratchpad `run-workload.sh` + `measure.sh`, see [[phx-preview-is-retired-phx-live-is-the-one-dev-server]]).
Tests that read instrumentation.ts source (crm-cutover, early-birds-close-scheduler, process-health,
sentry-production-only, mailbox-compliance-monitor, and more) will need their patterns checked.

**SHIPPED as PR 6048** (branch `codex/dev-lighter-compile`, commit `28e7612ba`, opened 2026-10-17
18:46 Cairo, merge waits on the owner) — the whole fix set above, plus four new source pins each
watched failing against its own break. The rules went to `engineering-deploys` (the NODE_ENV-block
rule; it also covers instrumentation.ts) and `portal` (the sidebar gate and the invalidation hub),
because `platform`'s pointer was 3,977 of its 4,000-byte cap and one more bullet took it to 4,275.
**MERGED 19:06 Cairo (`e1bd55188`), LIVE 19:16; production's boot lines matched the pre-deploy
baseline on both services** (website: `[sentry] started`, `[process-role] web`, the three schedulers
"not started: PHOENIX_PROCESS_ROLE is 'web'"; worker: all three started, poller upserting visits; no
"not a production build" line). Note `railway logs -f` returns NOTHING for a filter with `[` `]` or a
`:` in it — filter on a bare word (`sentry`, `live-poll`).

**MEASURED on the box 19:14-19:22 Cairo** (owner: "stop the phx-live run on the recruitment-notifications
folder and measure 6048"). Same six requests via `scratchpad/measure-pair.sh` (prepare, warm-up run,
measured run per commit; webpack cache kept across prepares), control `83bd1a5a3` vs change `e1bd55188`:

| | control warm-up | control measured | change warm-up | change measured |
| --- | --- | --- | --- | --- |
| MemoryHigh hits | 3,945 | 2,820 | **0** | **307** |
| cgroup swap after | 2,300 MB | 2,149 MB | **0** | **179 MB** |
| RAM + swap at rest | ~7.9 GB | ~7.7 GB | 6.2 GB | 4.7 GB |
| /login first | 21.6 s | 18.5 s | 20.6 s | 9.5 s |
| navigation API | 35.5 s | 23.7 s | 12.9 s | 13.7 s |
| approvals-hub (a 404 compile) | 37.2 s | 23.5 s | 2.0 s | 14.7 s |

`edge-instrumentation.js` 6,126,581 -> 113,480 bytes; the 3 scheduler chunks are no longer emitted (the
only two files still naming one are instrumentation.js / edge-instrumentation.js themselves, by
source-path text). 🔴 **Still tight:** the change's measured run touched the 6.8 GB MemoryHigh once
(peak 6,802), so `next dev` on the 7.7 GB box is lighter, not roomy. The next cuts, if ever asked:
`notifications/in-app.ts` -> approvals-hub (152 routes) and `resignations/service.ts` ->
offer-outcome-sync (304 routes) — real calls, never proposed unasked.
