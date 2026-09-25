---
name: payroll-copilot-sheet-redesign
description: "Payroll Copilot's main sheet rebuilt from 11 lumped columns to the full 27-column canonical set, with frozen identity columns, a synced top scrollbar, and a shared admin-shell width fix"
metadata: 
  node_type: memory
  type: project
  originSessionId: dc87c264-63ec-46bc-b397-ee25de8604a0
---

Owner screenshotted the Payroll Copilot "Payroll Sheet" tab 2026-07-08 and asked bluntly: "does this module meet its objective?" (build payroll in minutes). Root-caused and fixed in worktree `_wt-payroll-sheet-redesign`, branch `codex/payroll-copilot-sheet-redesign`, **PR #972 opened** (not yet merged).

**Root cause (2-part):**
1. The on-screen "Payroll Sheet" table only rendered 11 columns (HR ID/Name/Hire Date/Line/Area/Job Title + lumped Additions/Deductions/Net/Status/Actions) — collapsing everything into 2 money numbers. The owner's REAL manual sheet (and his originally-pasted header) has **27 columns** broken out individually (Base Salary, CRM, Fingerprint, Unpaid Vacations, Medical Insurance, Loans, Extra Cost of Living, Fuel Allowance, Month Salary, First/Second Part, Payment Group, etc.). **The data was ALREADY flowing to the client** — `serializeDraft` in service.ts and the client-side `EmployeeRow` type already carried every field. This was a PURE rendering gap (introduced during the earlier "one-screen rebuild" that fixed workflow speed but silently dropped column detail), not a backend gap — huge relief, meant zero backend changes needed.
2. A hardcoded `max-w-6xl` (1152px) on the Copilot's own outer wrapper PLUS a **shared, sitewide `max-w-[1480px]` cap in the admin shell** (`app-shell.tsx`, used by EVERY `/admin/*` page) caused the "large empty space" complaint.

**What shipped (PR #972):**
- Full 27-column table in `payroll-copilot-workbench.tsx` (`SHEET_COLUMNS` data-driven array + `frozenOffset()` helper) — HR ID/Full Name/Hire Date frozen (sticky-left, `position:sticky` + computed `left` offset) so identity stays visible while scrolling the money columns.
- A second, **synced top horizontal scrollbar** just under the "Payroll sheet (N)" header bar — a thin `overflow-x-auto` strip with an inner spacer div matching table width, bidirectionally synced via `onScroll` handlers + a `syncingRef` guard against re-trigger loops. (100+ row tables made the native bottom scrollbar unreachable without scrolling to the very end first.)
- Removed the Copilot's own `max-w-6xl` cap (now `w-full`).
- Widened the **shared** admin-shell cap 1480px→1760px in 3 files (`app-shell.tsx`, `app-shell-loading.tsx` for the loading skeleton, `topbar.tsx`) — purely additive, affects every admin page but never narrows anything. Spot-checked CEO Command Center post-change: renders cleanly, no regression.
- Widened individual column pixel widths after live-testing against real employee data found truncation on Full Name (190→300px, some Egyptian names have 4-5 name components), Job Title (140→190px), Area (110→160px).

**Verification method note:** the month-select `<select>` dropdown in this component was extremely unreliable to drive via automation this session — neither `form_input` nor native-setter-plus-dispatchEvent reliably synced React state (DOM value updated, React state didn't, causing silent stale-button-label bugs); only real click+keyboard (`computer` tool, trusted browser events) worked, and even that was inconsistent across reloads. Used direct JS DOM/computed-style inspection (`javascript_tool`, reading `getBoundingClientRect()`, `scrollLeft`, `scrollWidth` etc.) as the reliable verification method once past the month-selector step — confirmed exact column widths, zero truncation, frozen-column behavior, and scrollbar sync this way instead of trusting screenshots alone.

**Gate:** typecheck+lint+333 tests+build all green across 3 iterative rounds (redesign → +top scrollbar → +width/column widening after owner's follow-up "still empty white space... too condensed" with a screenshot).

**Explicitly NOT done, flagged to owner:** the separate **CEO Payroll View** (`src/components/payroll/dashboard/salary-report-table.tsx`, the POST-generation batch table at the main `/admin` payroll dashboard, NOT Copilot) has the **exact same** lumped-11-column problem — confirmed via code read, not fixed in this PR, awaiting owner's go-ahead to apply the identical treatment there too.

Ties into [[payroll-copilot-report-exports]], [[payroll-copilot-recovery-2026-07-07]], [[payroll-copilot-design]].
