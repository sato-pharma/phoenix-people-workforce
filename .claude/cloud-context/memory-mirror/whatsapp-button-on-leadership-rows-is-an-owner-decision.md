---
name: whatsapp-button-on-leadership-rows-is-an-owner-decision
description: "A district manager CAN one-press WhatsApp the CEO and the NSMs from the organogram — the owner was asked directly on 2026-08-23 and said keep it. Do not add rank-based suppression."
metadata: 
  node_type: memory
  type: project
  originSessionId: 76790e1c-f7b7-4d3e-a6a2-edce4aff525f
  modified: 2026-08-22T22:17:45.225Z
---

**OWNER RULE, decided 2026-08-23 when asked the question directly: keep the WhatsApp button on
the CEO row.** It applies to the NSM rows too — same mechanism, same answer.

**Why it looks like a bug and is not.** Line-scoped organogram charts deliberately keep line-less
leadership: `scopeAuOrganogramRows` returns `true` for any row with no `lineName`, so the CEO sits
on every district manager's and regional manager's chart. Put a green one-press *"message this
person on WhatsApp"* button beside him and it reads like a privilege escalation — a rep-level
manager with a direct line to the CEO.

It is not an escalation. The mobile has **always** been in the node popup's safe Contact section,
beside the work email, for everyone who can open a chart. The button changes the *ergonomics* of
reaching one number — two clicks becomes one — and changes **nothing** about who may see it. That
distinction is the whole argument, and it is the thing to re-read before "fixing" this.

**Do not add rank-based suppression** — no "only at or below the viewer's own level", no hiding the
button on leadership rows. It was proposed, put to the owner in plain words, and declined.

Verified in production 2026-08-23: all four leadership seats render the button (the CEO and the
three line NSMs). Two of the four are stored in proper local form and two lost their leading zero
to the spreadsheet import — the normalizer repairs both, see
[[employees-mobile-number-is-not-dialable-as-stored]].

What IS enforced, and must stay enforced, is the chart-membership gate: a line-scoped viewer cannot
resolve a number for someone off their chart, and the refusal is **404, never 403**, so it does not
confirm that a person they may not see exists. `tests/organogram-whatsapp-gate.test.ts` pins that
along with the rule that the number never rides on a row. Shipped in PR #2297, gated by #2304.

Related: [[a-matrix-grant-is-only-gate-one-of-two]] (the organogram's other two-gate trap),
[[organogram-chart-source-is-au-seat-model-not-directory]],
[[never-change-the-organogram-skeleton]].
