---
name: marketing-pharmacy-picker-1460-cutover-resume
description: "RESOLVED 2026-07-30: all 4 PRs (#1457/1459/1460/1436) merged AND confirmed live in prod (ancestors of deployed commit a5cb5027). 1-Aug cutover blocker is cleared."
metadata: 
  node_type: memory
  type: project
  originSessionId: 894ee5c3-efa3-4a87-b040-fe1a6c19297c
  modified: 2026-07-30T00:00:09.914Z
---

**RESOLVED 2026-07-30:** a routine "is main synced / is my work live" check confirmed all 4 merge commits below
(`eb5c4a89`, `8390ebaa`, `bde47357`, `e7411415`) are ancestors of `origin/main` HEAD `a5cb5027`, and that exact
commit is the one Cloud Run `phoenix-hr` (europe-west3) is serving at 100% traffic (revision `phoenix-hr-00655-hek`,
tag `sha-a5cb5027`), verified reachable at `https://phoenix-hr.satopharma.com` (200 OK). The "prod promote pending"
note below is stale — no separate promote step was needed once any later deploy shipped current main. No action
needed for the 1-Aug cutover; it is live. Original working notes preserved below for context.

Owner brought a prior AI session's transcript (docx "Marketing requests and ROI tracking audit", by omar anwar, 2026-07-29) that hit the usage limit mid-work and asked to resume it. Module = Marketing Requests & ROI Tracking — the **employee-portal submission form** (`src/components/employee-portal/marketing-request-drafts.tsx`) + pharmacy attribution in `src/lib/marketing-requests/service.ts`.

**Core bug:** the Phoenix submission form captured NO target pharmacies (payload had no `pharmacies` key). Attribution matches on distributor+pharmacy code+product+period, so every Phoenix request from the **1 August 2026** cutover would read EGP 0 ROI forever. Archived requests only have targets because the old system captured them.

**Verified live on 2026-07-29 (prod ref `ozucdzovmcqvepbozvqf`):**
- Reference import is REAL + live: `marketing_pharmacy_code_references` = 45,414 rows = 19,603 (`Phoenix Pharmacy Database.xlsx`, pre-existing) + 25,811 (`Phoenix_All_Customers_Distributors.xlsx`, the session's import). Reversible via `delete where source_file='Phoenix_All_Customers_Distributors.xlsx'`. The transcript's 45,908 was a pre-dedup projection; 45,414 (post-dedup, distinct pairs) is the truth. Blocked customers 87→~14.
- Picker data source live: `marketing_customer_pharmacies` = 303 links / 154 customers, all active, 193 `system_validated` + 110 pending.
- All 4 PRs OPEN, mergeable=CLEAN, every CI check green, base=main:
  - **#1460 picker** (THE Monday blocker) — worktree `F:/Phoenix Workforce/_wt-marketing-roi-truth`, branch `codex/marketing-pharmacy-picker`, commit `623101c5`, clean+synced, `.env.local` present. Form now sends `pharmacies`; workspace offers `pharmaciesByCustomer`; state tracks DESELECTIONS (derived, no setState-in-effect). Default = all customer pharmacies selected.
  - **#1459** reference-data importer + written override for bad codes (`codex/marketing-pharmacy-code-override`).
  - **#1457** live capture-quality score (`roi-confidence.ts`).
  - **#1436** dead marketing-route cleanup (+0/-463).
- #1459 & #1460 both edit `service.ts`+`types.ts` but DISJOINT hunks (override=create path ~L1048-1382; picker=workspace path ~L3765-3974) → auto-merge clean, but 2nd-merged goes BEHIND main and needs a main-merge + CI rerun before merging.
- Already merged base on main: #1454 (confidence score / ROI flight deck), #1455 (capture gates).

**Picker PIXELS now verified (2026-07-29, this session):** clicked through on localhost:3007 as Super Admin at /admin/marketing-requests — picker renders (name·code·distributor), counter + deselect warning fire, customer switch repopulates, zero console errors. Did NOT submit (`.env.local` = PROD). No bug; the earlier "2 of 8" was me clicking the wrong customer (Salam=2, Sadr=8).

**OWNER DECISION (2026-07-29): PARK the historical/inferred data question.** All 303 `marketing_customer_pharmacies` links are ONE backfill (2026-07-02 04:39 UTC, `created_by`=null, from Customer Pharmacy Mapping #709/#712): 193 `system_validated` (inferred from APPROVED historical requests) + 110 `pending` (pending/rejected), note "…not GPS field-validated. Backfill script 2026-07-02." marked via `INFERRED_HISTORY_MARKER` in `src/lib/customer-pharmacy-mapping/readiness.ts`. Owner: accept the 105 inferred customers as targetable (do NOT gate on field re-validation now), FINISH the go-forward module so Marketing Requests + ROI work for NEW requests from **1 August**. Governance surface already exists at `/admin/customer-pharmacy-mapping` (ready/pending_only/no_links buckets, inferred badges).

**FINISH scope = land the 4 open PRs:** #1460 picker (CRITICAL — without it new requests capture no targets), #1459 importer+override, #1457 capture-quality score, #1436 dead-route cleanup. All OPEN/mergeable/CI-green/base main. #1459+#1460 edit service.ts+types.ts in DISJOINT hunks (create path ~1048-1382 vs workspace path ~3765-3974); #1436 also touches types.ts — 2nd/3rd merged goes behind main, re-sync + CI rerun before merge. Merge→staging auto-deploy→verify→prod promote (separate approval per AGENTS.md).

Related: [[marketing-roi-three-engines-divergence]] [[local-env-already-points-at-production]] [[preview-start-ignores-worktree-cwd]] [[one-prod-deploy-per-task]]
