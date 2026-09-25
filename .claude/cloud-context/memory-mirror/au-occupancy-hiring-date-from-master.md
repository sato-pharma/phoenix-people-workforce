---
name: au-occupancy-hiring-date-from-master
description: "OWNER RULE — au occupancy/seat tenure must derive from the employee master's hiring date, never the frozen 2026-07-13 seed snapshot"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 785df647-44c8-4011-856b-d15dd74cd4d8
---

**OWNER RULING (2026-07-18):** "The employee hiring date is the hiring date in the employee master only."

**Why:** The area-unification audit found the packaged au seed (`supabase/migrations/20260713040000_au_seed_reference_data.sql`) hardcodes 132 `au.occupancy_history` rows from a **frozen 2026-07-13 staging snapshot** with `effective_from='2026-07-13'` for everyone, and some seeded occupants have since resigned in production (B-176 resigned 2026-07-06, B-111/B-171 resigned 2026-07-17). That makes resigned employees show as current seat occupants and mis-attributes sales.

**How to apply (FIX-D):** Do NOT ship occupancy as a static seed. At Phase-9 cutover, **rebuild `au.occupancy_history` from the live employee master (`public.employees`)** — occupant = active employees, `effective_from` = each employee's hiring date **as recorded in the employee master**, seat resolved via the employee's (line, canonical area). Keep the static `au.seats` structural definition; replace only the occupancy inserts with a master-derived build. Occupancy freshness is a cutover-time operation, gated + dry-run, never applied to prod without explicit owner approval. See [[field-sales-3way-report-spec]] context and the area-unification audit (task #80).
