---
name: ireports360-dead-columns-are-hidden-not-deleted
description: "iReports360 sends permanently-empty fields; the convention is hide-the-column-but-keep-the-data, and customer_name must stay in VISIT_SELECT even though nothing displays it"
metadata:
  type: project
---

Two iReports360 vendor fields are dead in production and are now **hidden, not deleted**:

- `attendance` — 122,814 visits, 120,922 zeros + 1,892 NULL, **never once 1** (PR #2242).
- `customer_name` ("Facility name") — 88,132 NULL + 34,682 `''` = **all 122,814, zero populated**,
  2026-01-01 → 2026-08-20 (PR #2245). `contact_name` beside it is populated on 85,959.

Both stay fetched, stored, and in `raw_payload`. Both are pinned in
`tests/crm-checkin-coord-guard.test.ts` against `CRM_VISIT_COLUMNS`.

**The trap:** they are NOT treated the same in `VISIT_SELECT` (`src/lib/crm/master.ts`, ~line 305).
`attendance` was removed from it — nothing read it. **`customer_name` deliberately stays**, because
two live call sites read `row.customer_name`: `attachRecognitionScore` counts it as a "visit target"
signal, and the master search filter `ilike`s it. Deleting it from the select is the obvious tidy-up
and it breaks both **silently** — no error, no test, and only the day the vendor starts sending the
field. The explaining comment sits ~190 lines above the select, so it is easy to miss.

The `contactName || customerName` fallbacks in `my-visits-workspace.tsx` and
`field-workforce-visits-view.tsx` are kept for the same self-healing reason.

**Why:** a column of pure placeholders reads as real data ("every rep absent all year"), but the
vendor could start populating either field at any time, so destroying the pipeline is the wrong fix.

**How to apply:** asked to "fix column X" in the CRM master — check whether anything reads it before
touching `VISIT_SELECT`, hide the display only, and add a pin beside the existing two. Editing anchor
note: `{ key: "contact_name", ... }` appears in **all three** column sets, so a single-line anchor
into `CRM_VISIT_COLUMNS` is ambiguous. Related: [[never-silent-drop-count-and-flag-instead]].
