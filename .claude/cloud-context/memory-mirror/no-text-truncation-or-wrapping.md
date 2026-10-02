---
name: no-text-truncation-or-wrapping
description: "System-wide rule — never truncate text with an ellipsis (truncate, line-clamp, text-overflow) and never clip it; when text does not fit, WRAP it (break-words, align-top, a taller row) — wrapping wins over the old no-wrap rule (owner golden rule 2026-09-01)"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 3974625d-0ba6-408d-855c-0272c03818fb
  modified: 2026-10-02T16:38:24.970Z
---

Never use `truncate` (overflow:hidden + text-overflow:ellipsis) anywhere in the system. When text does not fit, let it **wrap** onto more lines.
**Superseded 2026-10-02:** previously "never let text wrap to multiple lines" — the owner's 2026-09-01 golden rule ([[never-horizontal-scroll-always-mobile-and-desktop-friendly]]) asked for stacked, wrapping cells; where the two collide, wrapping wins (AGENTS.md §4).

**Why:** truncation hides data, and so does clipping — text cut off at an edge is present and unread. Vertical space is free; horizontal space is not.

**How to apply:**
- Wrapping is the permitted answer — `break-words`, `align-top`, a taller row.
- Never rely on an outer `overflow-hidden` container to clip text silently at the edge — clipped text hides data exactly like an ellipsis. (The one control that cannot wrap is a native `<select>`; never shrink it — print the value somewhere outside it instead, as the golden-rule note describes.)
  **Superseded 2026-10-02:** previously "use `whitespace-nowrap`; silent clipping by an outer `overflow-hidden` is acceptable as a last resort" — replaced by the 2026-09-01 golden rule, under which clipped text is the defect.
- Prefer layout changes (2-row structure, full-width rows, merging columns, stacking values in one cell) to give text room rather than hiding it — fit by MERGING columns, never by shrinking type.
  **Superseded 2026-10-02:** previously listed "smaller font" as a layout fix — AGENTS.md §4's fits-the-screen rule says fit by merging columns, never shrinking type.
- Never reach for `truncate`, `line-clamp`, or `text-overflow: ellipsis` in any new code
- If reviewing existing code, replace `truncate` with a wrapping cell (`break-words`), not `whitespace-nowrap`
  **Superseded 2026-10-02:** previously "replace `truncate` with `whitespace-nowrap`" — the 2026-09-01 golden rule makes wrapping the answer.
