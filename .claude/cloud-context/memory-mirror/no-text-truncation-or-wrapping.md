---
name: no-text-truncation-or-wrapping
description: "OUTDATED IN PART (contradiction sweep 2026-10-02) — current: Wrapping is the permitted answer — break-words, a taller row ... where the two collide the golden rule governs and wrapping wins; clipped text hides data (see `never-horizontal-scroll-always-mobile-and-desktop-friendly`). Older text follows: System-wide rule — never truncate text with ellipsis and never let text wrap to multiple lines"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 3974625d-0ba6-408d-855c-0272c03818fb
---

Never use `truncate` (overflow:hidden + text-overflow:ellipsis) anywhere in the system. Never let text wrap to multiple lines.

**Why:** Owner explicitly forbids both — truncation hides data, wrapping looks messy. Both are banned system-wide.

**How to apply:**
- Use `whitespace-nowrap` to keep text on one line WITHOUT clipping with `...`
- The outer `overflow-hidden` container clips silently at the edge if text is genuinely too long — that is acceptable as a last resort
- Prefer layout changes (2-row structure, full-width rows, smaller font) to give text room rather than hiding it
- Never reach for `truncate`, `line-clamp`, or `text-overflow: ellipsis` in any new code
- If reviewing existing code, replace `truncate` with `whitespace-nowrap`
