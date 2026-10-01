---
name: ireports360-timestamps-cairo-local-mislabeled-utc
description: "iReports360 saveDate/checkDate are zone-less Cairo-local times stored tagged UTC — do NOT convert to Cairo again (double-shift bug); a UI timeZone UTC has three causes and only one is a bug."
metadata: 
  node_type: memory
  type: project
  originSessionId: 76130c78-51c5-4485-975a-3e70161783c6
---

iReports360 returns visit `saveDate` and check-in `checkDate` as **zone-less local (Cairo) timestamps** (e.g. `"2026-07-16T18:13:18"` — no offset/Z). The sync (`src/lib/crm/sync.ts`, `crm_save_date: visit.saveDate` / `check_date: checkin.checkDate`) stores the string verbatim and Postgres tags it `+00`, so `crm_save_date` = `"2026-07-16 18:13:18+00"`. **The stored clock reading IS already Cairo wall-clock, NOT a UTC instant.**

**Bug:** converting these to Cairo (`Intl` `timeZone:"Africa/Cairo"`, SQL `AT TIME ZONE 'Africa/Cairo'`, date-fns-tz) adds the Egypt offset a 2nd time → shows/computes ~2-3h too LATE (18:13 → wrongly 9:13 PM instead of 6:13 PM). Can wrongly flag reps as logging visits "late".

**Proof (prod, 102k rows):** hour-of-day of `crm_save_date` read as-stored sits in normal field hours (~2-11 PM); read as UTC→Cairo it implies thousands logged after midnight (not credible).

**Correct handling:**
- Vendor fields = render/compute AS-STORED, no shift (treat as Cairo wall-clock): `crm_save_date`, `check_date`, plus raw `saveDate`/`checkDate`. `visit_date_time` is a midnight placeholder (100% `00:00:00`) → date-only.
- Our own fields ARE true UTC (`new Date().toISOString()`): `synced_at`, `created_at`, `updated_at`, sync-run `started_at`/`completed_at` → converting THOSE to Cairo is correct.

**Fixed in CRM master table** (commit `494b6a21`, branch `codex/crm-single-source-module`): `datetime_local` column kind + `formatVendorLocal()` uses `timeZone:"UTC"` (no shift). See [[ireports360-crm-integration]].

**PENDING AUDIT (spawned task):** every other consumer of these fields' time-of-day — esp. Field Workforce Compliance `computeLoggingTiming` (LOCKED files, need unlock phrase), Visits Report `formatDateTime`, CRM Integrity save-lag/impossible-travel. Time-gaps between two vendor fields are self-consistent; only absolute time-of-day, or gaps mixing a vendor field with a UTC field, are wrong.

**CORRECTION — measured 2026-08-23: "Cairo wall-clock" is right in WINTER and one hour WRONG in
SUMMER, for most rows.** Egypt runs DST (UTC+3) from late April to late October; the vendor's stamps
are mostly Egypt STANDARD time (UTC+2), so during DST they read **one hour behind** actual Cairo.

Proof — August 2026 rows, comparing our own `created_at` (true UTC → Cairo) against the vendor stamp
read as-stored, restricted to rows we received within 30h of the stamp:

| our receive − vendor stamp | rows |
| --- | --- |
| 0 h | 1,231 |
| **+1 h** | **10,743** |
| +2h and beyond (late arrivals) | ~790 |

A uniform sync lag cannot explain it — a 1-hour lag would empty the 0 bucket. It is **per device**:
B-113 averages +0.23h (his phone is on Cairo DST) while B-130 averages +1.38h. B-25 averages +0.90h.

**Consequence:** rendering a vendor time as-stored is up to an hour EARLY in summer, and any
"logged the visit late" judgement built on it inherits that error. Where the truth must be
defensible, anchor on `created_at`/`synced_at` (genuinely UTC) or on the id sequence, not the vendor
stamp. See [[ireports360-api-is-nine-endpoints-and-has-no-audit-trail]].

**RENDER AUDIT CLOSED — 2026-09-02, PR #2939 (`99ff6e891`).** The "PENDING AUDIT" above is answered
for every DISPLAY site. `timeZone: "UTC"` in this codebase has **THREE** causes, not two, and only
one of them is ever a bug:

1. **DATE-ONLY** — a `date` column (`visit_date`, `hire_date`, `conducted_on`, `activity_date`), a
   `"YYYY-MM"` period key, or a window bound. `new Date("2026-08-23")`, `` `${iso}T00:00:00Z` `` and
   `Date.UTC(...)` all pin it to UTC midnight, so **UTC is what STOPS the calendar day shifting.**
   Rendering it in Cairo moves a late-evening row onto the next day and silently changes which days
   a KPI counts. **39 of 43 sites.**
2. **VENDOR WALL-CLOCK** — `crm_save_date`, `check_date`, raw `saveDate`/`checkDate`. Already Cairo
   (this file, above). Cairo renders them **2–3h LATE**. **4 of 43 sites.**
3. **TRUE INSTANT** — stamped by our own `new Date().toISOString()`: sync-run `started_at`/
   `completed_at`, `synced_at`, `created_at`, `updated_at`. **This is the only one that belongs in
   Cairo**, and the only one that was ever wrong.

**Classify by the BACKING COLUMN, never by the formatter name.** `toLocaleTimeString` is not
evidence of an instant: `crm-integrity-workspace.tsx` and `early-birds-format.ts` were both flagged
as likely bugs and were both **false positives** — "fixing" either would have introduced a real
error. After the one genuine fix (`crm-sync-status-panel.tsx`, PR #2937) there is **no second
instance** of the bug; all 43 remaining UTC sites are correct and now carry a comment saying why.

**`cairoMinutesOfDay()` LIES IN ITS NAME — and is correct.**
`src/lib/field-workforce-compliance/ireports360-source.ts` formats with `timeZone: "UTC"`
despite the name, because it is fed `saveDate` (case 2). That is the compute half of the pending
audit and it needs **no change**: `computeLoggingTiming`'s late-start verdict is right. Do not
"resolve the inconsistency" by making the body match the name — that is precisely the double-shift.
The invariant itself is now written down at `src/lib/crm/sync.ts` as the VENDOR TIMESTAMP
INVARIANT.
