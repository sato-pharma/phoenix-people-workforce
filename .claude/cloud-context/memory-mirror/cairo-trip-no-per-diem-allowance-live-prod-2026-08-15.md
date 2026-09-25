---
name: cairo-trip-no-per-diem-allowance-live-prod-2026-08-15
description: "Regional employee travelling TO Cairo earns no outstation per-diem allowance — LIVE prod #2160, do NOT undo"
metadata: 
  node_type: memory
  type: project
  originSessionId: a42b6687-407a-4c53-a5f5-c95b3c4a7f40
  modified: 2026-08-15T13:27:23.872Z
---

Owner rule (2026-08-15), shipped LIVE to prod as commit `f32f768d` / PR #2160: an employee whose
residence is in ANY region who travels TO Cairo earns **no outstation per-diem allowance** for that
trip. Cairo is the head-office city — coming to it is not an "outstation" for allowance purposes.

**Exact boundaries the owner confirmed in-session — do NOT widen or narrow:**
- "Cairo" = the **Cairo governorate ONLY**. Giza (6th October, Sheikh Zayed, Dokki) and Qalyubia
  (Benha, Shubra El-Kheima) are separate governorates and **still earn an allowance** — never fold
  them into a "Greater Cairo".
- Only the **per-diem allowance** is zeroed. Transport, tickets, meeting, other costs still pay.
- Direction is **TO Cairo, not FROM**. A Cairo-resident (e.g. training manager A-7, residence
  القاهره/مدينة نصر → Cairo) who goes to Alexandria and returns to Cairo **keeps** the allowance.
  Assiut-based reps (region Upper Egypt, residence اسيوط → Assiut) **lose** it on a Cairo trip.
- **Unresolved residence NEVER fires the rule** — never strip an allowance on a guess; that case is
  already held for Super Admin review by the existing residence-vs-destination governorate rule.

**Why it's easy to "fix back" by mistake:** a future session seeing a Cairo trip pay 0 allowance
may read it as a bug and revert. It is not a bug. It is this rule.

**How to apply:** logic is a pure module `src/lib/outstation/cairo-allowance-rule.ts`
(`cairoTripEarnsNoAllowance` + `applyCairoNoAllowance`), folded into the single guarded-allowance
chokepoint `calculateGuardedAllowanceBreakdown` in `src/lib/outstation/service.ts`, so all four
write paths inherit it: employee GPS submit, admin preview, admin create, admin edit. Governorates
resolve via `resolveFirstGovernorate` (@/lib/geo/egypt-locations). Pinned by
`tests/outstation-cairo-no-allowance.test.ts`. Same visible-not-silent discipline as the
duplicate-day guard [[system-flags-expenses-never-rejects]].
