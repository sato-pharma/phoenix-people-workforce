---
name: crm-triple-visit-detection
description: "CRM module — triple-visit detection (rep→middle-manager→top-manager chain) rule, scale, and owner-chosen surfacing."
metadata: 
  node_type: memory
  type: project
  originSessionId: 76130c78-51c5-4485-975a-3e70161783c6
---

Owner concept (2026-07-17, branch `codex/crm-single-source-module`): a **triple visit** is
the rare **manager↔manager double visit where the middle manager is ALSO out with a rep** —
so three people are stacked at one contact/day.

**Detection rule (per day, prefer same contact):** a manager **M** who is the `double`
(partner) on a rep **R**'s visit AND the `agent` on M's own visit whose `double` is a higher
manager **T**. The shared bridge M → the three people {R (base), M (middle), T (top)} form a
triple. In the mirror `ireports360_visits`: v1 = (agent=R, double=M), v2 = (agent=M, double=T),
same `visit_date` (+ same `contact_crm_id` when specified), R≠M≠T all distinct, doubles not
null/0. Self-join on `v1.double_crm_id = v2.agent_crm_id`.

**Verified example (prod):** contact 67243, 2026-06-29 — visit 1198459 (agent Mostafa.Mamdouh
`B-82` rep, double Ahmed.Abdallah `B-74`) + visit 1199388 (agent Ahmed.Abdallah `B-74`, double
Hany.Saad `PD-0001`) = triple. Owner's other example 1197493 (contact 95774) is NOT a triple —
only Ahmed↔Hany there, no rep. So detection MUST be data-driven per contact+day, never assumed
from the manager-manager pair alone.

**Scale (prod history, 2026-07-17):** 58 distinct triples = **14 confirmed-contact**
(contact_crm_id<>0, three at the same specific doctor) + **44 same-day contact-unspecified**
(contact_crm_id=0; accompaniment chain explicit but no doctor named). **0 quadruples** — triple
is the ceiling, no N-stack generalization needed.

**Owner-chosen surfacing (both):**
1. A dedicated **"Triple Visits" tab** in the CRM master table (rep → middle → top, contact,
   date, linked visit IDs).
2. A **flag/badge on the Double Visits tab** rows that belong to a triple.
Include **all 58**, but **flag the 44 contact-unspecified** ones distinctly (never silently
mixed — same "flag, don't silently recount" philosophy as [[crm-resigned-agents-exclusion-list]]
and the Regular-no-checkin reclassification).

Build must respect the resigned-agent exclusion ([[crm-resigned-agents-exclusion-list]]).
Contact=0 join is weaker — only same-day, so those are the flagged/lower-confidence set.
