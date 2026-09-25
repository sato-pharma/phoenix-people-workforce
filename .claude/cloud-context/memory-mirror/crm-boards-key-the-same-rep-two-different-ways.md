---
name: crm-boards-key-the-same-rep-two-different-ways
description: "Doctor Coverage keys reps `hr:<lowercased id>`, Brick Coverage keys them bare — cross-using them matches NOTHING and looks correct doing it"
metadata: 
  node_type: memory
  type: reference
  originSessionId: ee8e1dd7-5943-412c-9063-b9a3827f3d74
  modified: 2026-08-21T07:49:41.323Z
---

The CRM coverage boards use **two different rep-key conventions for the same person**, and nothing
in either name warns you:

| Module | Key for HR id `AI-0009` | Built by |
| --- | --- | --- |
| `sfe-doctor-coverage.ts` (`repKeyOf`), shared with `sfe-field-analytics.ts` | `hr:ai-0009` | `` `hr:${visit.agent_hr_id.toLowerCase()}` `` (or `crm:<id>` when unmapped) |
| `brick-coverage.ts` (`loadRepTerritories`) | `ai-0009` | `canonicalHrIdKey(seat.hr_id)` |

**Why it bites:** a filter built with the wrong shape matches ZERO rows, and a coverage board
showing zero rows reads as *"this rep visited nobody"* — a plausible, damning, completely false
answer. It does not throw, does not warn, and looks perfectly reasonable on screen. This is why
`repsMatching` in `src/lib/crm/coverage-filters.ts` returns REPS rather than keys: each board maps
`rep.hrId` into its own convention, instead of one board's keys being handed to the other.

Two further traps inside this:

- **Do not "improve" `coverageRepKey` to use `canonicalHrIdKey`.** That folds the legacy `aaa → aa`
  alias, which `repKeyOf` does NOT — so canonicalizing can only ever invent a key that no board row
  carries. (Checked 2026-08-21: only one `AA` exists, Anwar Gaweesh, and he is CEO-tier, so the
  alias is inert today. It would not stay inert if someone canonicalized one side.)
- `tests/crm-coverage-filters.test.ts` **fingerprints `repKeyOf`'s source line**, so changing it
  turns CI red rather than silently emptying every territory filter. If that assertion fails, the
  fix is to change BOTH sides deliberately — never to re-pin the fingerprint.

**How to apply:** before matching rep keys across CRM modules, check which convention each side
produces, and prove the two sets actually intersect against production rather than reasoning about
it. The intersection check that caught this: 74 seat-model reps vs 62 board reps → 60 shared. The
2 board-only keys were `B-74` and `B-154` — **active District Sales Managers who log visits but
hold no REP seat**, so they never appear in a territory-derived rep picker (they remain findable
through the board's Search box, which matches on rep name).

See [[crm-visits-join-to-bricks-both-maps-now-filled]] and
[[employees-crm-id-null-does-not-mean-no-crm-activity]].
