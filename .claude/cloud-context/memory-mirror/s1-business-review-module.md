---
name: s1-business-review-module
description: "Standalone read-only S1 Pedia business-review module — branch, pipeline, rulings, key numbers, open items"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2eb8f492-0e0d-42a5-ae36-8310912bd554
  modified: 2026-07-31T18:43:17.244Z
---

Standalone **READ-ONLY** S1 (Jan–Jun 2026) business-review module for the exec review (Pedia line ONLY for now; other 2 lines later). Isolated worktree `F:/Phoenix Workforce/_wt-s1-review`, branch `codex/s1-business-review-pedia` (off origin/main e7411415). Route `/business-review-s1`, visible to **CEO / SFE Manager / Super Admin** only. MUST NOT touch any other Phoenix module (owner rule).

✅ **SHIPPED — verified on `origin/main` 2026-07-31** via PRs **#1485 + #1498**. It grew past this
memory's description: main now carries an admin page, an **employee-portal** page
(`app/employee-portals/business-review-s1/page.tsx`), an export API route, a `portal-review.client.tsx`,
and **three lines of data** (`anti-s1.json`, `cns-s1.json`, plus Pedia) with an `access-map.json` —
not the Pedia-only, single-page, no-API module described below. Treat the file list here as historical.
The **"Not committed/pushed" status was stale**; worktree `_wt-s1-review` was clean and was removed
2026-07-31 (branch `codex/s1-business-review-pedia` still exists locally). Original note: typechecks clean; browser NOT verified at the time (mind [[preview-start-ignores-worktree-cwd]], [[worktree-junction-breaks-turbopack]]).

**Files:** `app/business-review-s1/page.tsx` (role gate) · `src/components/business-review-s1/dashboard.client.tsx` (3 tabs Achievers/Epic-Fails/Full-Analysis + Exclude-vacant Switch) · `src/lib/business-review-s1/{types,service}.ts` · `data/pedia-s1.json` (bundled, NO DB/migration) · `ingest/build_dataset.py` (regenerate from `~/Downloads` S1 files). Uses locked `calculateIncentive2026` read-only for payout tiers.

**Verified numbers (tie to raw DATA):** line include-only **63.5%** (12,150,914/19,134,122) · all-products 60.76% · **NSM/line w/ exception 62.15%** (+280k) · **excl-vacant 72.5%** · Q1 53.4% / Q2 67.7%.
**Rulings:** include products (count for incentive)=Ivyronc, Guamusin, Lacto Advanced 1/2. **20,000-unit Ivyronc Feb order = exception @14 EGP (=280,000): EXCL rep/DM, INCL NSM+line.** Marketing = trust old-CRM raw `DoctorRequest_ (3).xls` (HTML-as-xls), **5 Pedia DMs = 932,080** (Phoenix export understated 809,980; Taha mis-parsed −117k). **Request line = requester's line, not product.** Outstation expenses **37,435** (authoritative `Total` col, excl Rejected, no January). Thresholds: rep-brick fail <20%, DSM fail <40%.
**Cairo:** Haitham Abdelkarim WAS Cairo Pedia DSM, **RESIGNED → vacant**. Merged Haitham+"Cairo DM" labels (verified 0 overlap, NO double-count; TOTAL Cairo units==DATA). 19.7%, declining Jan→Jun. Drives the Exclude-vacant toggle.
**DMs:** Nermeen 110% (star — least spend, most visits 970/mo + doubles 520, marketing only 4mo Mar–Jun), Hekal 68% (marketing 1mo/12.6k), Yehya 68%, Abdallah 66% (most marketing 354k), Taha 58%. Guamusin chronically weak (25% line-wide). Ismailia-Suez sold 52k with ZERO target (target-setting gap, not a fail).

**Open:** browser-verify as CEO; nav link (add to system-navigation.ts for the 3 roles = one shared-file touch, needs owner OK — else direct URL); salary upload → EGP payouts; map names; other 2 lines; confirm DoctorRequest_(3) is the complete old-CRM export. See [[incentive-policy-lock]], [[ped-line-closing-workbook-s1-quarter-bug]].
