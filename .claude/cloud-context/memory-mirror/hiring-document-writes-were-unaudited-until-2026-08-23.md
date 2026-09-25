---
name: hiring-document-writes-were-unaudited-until-2026-08-23
description: "Every Hiring Documents write was invisible to audit_logs until PR #2315 (2026-08-23); four new entity types now cover six writers"
metadata: 
  node_type: memory
  type: project
  originSessionId: ad53de17-d4b2-4840-be09-4ee95dd4eaa5
  modified: 2026-08-23T07:11:43.741Z
---

Until **2026-08-23** every write in the Hiring Documents module produced **zero** `audit_logs`
rows. Proven on production `ozucdzovmcqvepbozvqf` before the fix: `0` rows for anything
hiring-related, ever, against 109,171 audit rows in the preceding 30 days (338 of them
`vacation_request`). A note on **B-106** was cleared and nothing anywhere could say what it had
said or who cleared it — that is what surfaced the gap.

Closed by PR #2315, squash `9b1f7735`, merged 08:28:51 Cairo, live on production the same minute.

**Four entity types** now exist in `src/lib/admin/audit.ts`:
`hiring_document_definition`, `hiring_document_file`, `hiring_document_note`,
`hiring_document_status`.

**Six writers** in `src/lib/hiring-documents/service.ts` audit, all via `writeRequiredAuditLog`
(throws — never the silent `writeAuditLog`). Four gained a **required** `access: AccessContext`
first parameter, so a call site that forgets the actor does not compile:
`createHiringDocumentDefinition`, `deleteHiringDocumentDefinition`, `updateHiringDocumentStatus`,
`updateHiringDocumentEmployeeNotes`. `attachHiringDocumentFiles` and `removeHiringDocumentFile`
already had it.

**Verified against the live database, not just the test suite.** One no-op call to the real
notes writer against production produced exactly one row, 0 → 1:

```
2026-08-23 08:31:53  hiring_document_note  B-106  actor=system
summary: "Hiring notes for Abanoub Ehab Shoukry Andaros cleared."
old={"notes": null}  new={"notes": null}
```

Note the summary carries the **employee's name**, not the HR id — `describeHiringDocumentTarget`
resolves it and falls back to the raw id only if that lookup throws.

The **status** writer — the deadline field's path, and the module's busiest — was proven the same
way on a row that actually held data, so the before-image is visible rather than a pair of nulls:

```
2026-08-23 08:39:32  hiring_document_status  B-106:0ca533c6-…ffda964  actor=system
summary: "Graduation certificate for Abanoub Ehab Shoukry Andaros set to missing
          (deadline 2026-03-09) — was missing (deadline 2026-03-09)."
old={"notes": null, "status": "missing", "dueDate": "2026-03-09"}
new={"notes": null, "status": "missing", "dueDate": "2026-03-09"}
```

**That writer used to silently wipe the note — FIXED the same day by PR #2319, squash `0a009022`.**
It wrote `notes: cleanText(input.notes)` unconditionally, and `notes` is optional, so an omitted key
was written as *clear it*. The checklist UI omits it on **every** status write (Mark submitted, Mark
missing and the deadline box all post `{documentId, dueDate, employeeHrId, status}` and nothing
else), so a note was blanked by the next click on that row. Nothing was actually lost, because no UI
writes that column — the only notes box in the manager is the per-employee one on a different table
— which is why all 8 status rows read NULL. `src/lib/hiring-documents/status-notes.ts` now applies
the ordinary PATCH rule: absent changes nothing, `null` and `""` both clear.

**Both halves were proven on the real production row**, same UI payload, only the code swapped —
B-106 / Graduation certificate, seeded and restored each pass. The audit rows are the evidence:

```
10:10:37  OLD code   note "verification note…"  ->  (null)      WIPED
10:10:59  NEW code   note "verification note…"  ->  "verification note…"   PRESERVED
```

**The general trap, which is not specific to this module:** an upsert that writes an OPTIONAL field
unconditionally turns every partial payload into a silent erase. Look for it wherever a `PATCH`
route hands a partial object straight to `.upsert()`.

`dueDate` is still forced to null whenever `status !== "missing"` — that one is deliberate.

`markHiringDocumentSubmitted` is a hand-written duplicate of the same upsert that existed only to
dodge the wipe. It stays, for a different reason now: its tick is a consequence of the scan, so it
is audited inside the caller's single `hiring_document_file` row (`markedSubmitted: true`) and must
not raise a second `hiring_document_status` row. **It is not an audit hole** — check before
"fixing" it.

The remaining four writers (two definition, two file) are covered by
`tests/hiring-documents-audit.test.ts` but have not been exercised against production.

**Two traps if you touch this again:**

- `tests/hiring-documents-audit.test.ts` asserts an *invariant*, not a list: any exported async
  function whose body mutates a table must appear in the audited set. Its `functionBody()`
  extractor bounds on the function's **own** column-0 closing brace (`"\n}\n"`), **not** on the
  next top-level `export` the way `tests/payroll-mutation-audit.test.ts` does. Bounding on the next
  export swallows every private helper sitting below the last exported function —
  `markHiringDocumentSubmitted` lives down there and calls `.update(`, which made the read-only
  `getHiringDocumentFileForDownload` read as a seventh unaudited writer.
- The table is `hiring_document_statuses` (plural), and `hiring_document_files` timestamps its rows
  with **`uploaded_at`**, not `created_at`.

Related: [[payroll-mutations-were-unaudited-until-2026-08-21]] ·
[[vacations-audit-coverage-is-complete-via-two-tables]] ·
[[hiring-document-files-table-and-private-bucket-live-in-prod]] ·
[[access-registry-is-declarative-and-writes-no-audit-row]]
