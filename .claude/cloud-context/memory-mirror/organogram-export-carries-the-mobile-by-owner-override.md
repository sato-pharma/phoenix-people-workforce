---
name: organogram-export-carries-the-mobile-by-owner-override
description: "The organogram XLSX carries a Mobile column — the owner overrode AGENTS §4's \"work fields only\" export rule on 2026-08-23. Do not remove it, and do not \"simplify\" it onto the row."
metadata: 
  node_type: memory
  type: project
  originSessionId: 76790e1c-f7b7-4d3e-a6a2-edce4aff525f
  modified: 2026-08-22T22:53:30.407Z
---

**OWNER OVERRIDE, 2026-08-23: "include mobile number in the export".** AGENTS.md §4 says
organogram exports carry work fields only — no personal data. The mobile number is the one
exception, granted explicitly after I raised the concern across several turns. A future session
reading only AGENTS.md will read the Mobile column as a leak and try to remove it. It is not a
leak; it is an instruction. Nothing else came off the forbidden list.

**The implementation is the load-bearing part, and it is not obvious.** The organogram XLSX is
built **in the browser** — `buildOrganogramExportRows(rows)` runs inside a `"use client"`
component. So the natural implementation, a `mobileNumber` field on `OrganogramWorkFields`, would
put every colleague's number into the page payload of everyone who opens a chart, all day,
whether or not they ever export. Instead:

- `GET /api/reports/organogram/contact-numbers` answers with the numbers for people already on
  the caller's own chart — same permission and same company-vs-line scope resolution as the
  WhatsApp route. It **writes its own `audit_logs` row before answering** and is
  export-rate-limited. Entity type `organogram_contact_export`; `audit_logs.entity_type` is plain
  `text` with no check constraint, so a new type needs no migration.
- `buildOrganogramExportRows(rows, mobileByHrId?)` takes the numbers as a **second argument**.
  Called without one, the Mobile column is empty even when the rows carry a number. That is the
  lock, and `tests/organogram-whatsapp-gate.test.ts` fires on it.
- The column is `text: true` so Excel cannot eat the leading zero — see
  [[employees-mobile-number-is-not-dialable-as-stored]].

**So: never move the number onto the row to "simplify" this.** The separate argument IS the
privacy boundary. Shipped in PR #2311.

Related: [[whatsapp-button-on-leadership-rows-is-an-owner-decision]],
[[access-registry-is-declarative-and-writes-no-audit-row]] (why the audit row is written in the
handler and not by the registry entry).
