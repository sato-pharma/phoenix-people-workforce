---
name: optional-field-written-unconditionally-is-a-silent-erase
description: "Repo-wide hunt 2026-08-23 for the partial-payload erase trap — 373 write sites, 51 optional-by-own-type, 2 real and BOTH now fixed (#2326, then #2329 for finalizeIntakeEvent), 4 cleared with reasons. Nothing here is outstanding; the value left is the pattern and the four cleared decoys."
metadata: 
  node_type: memory
  type: project
  originSessionId: ad53de17-d4b2-4840-be09-4ee95dd4eaa5
  modified: 2026-08-23T10:29:18.000Z
---

**The trap:** an `.upsert()`/`.update()` that writes an **optional** input field unconditionally
(`notes: input.notes ?? null`) turns every partial payload into a **silent erase**. Absent key gets
read as "clear it". Found live twice; hunted repo-wide on **2026-08-23** after the first fix.

**The rule that fixes it** — ordinary PATCH semantics: absent leaves it alone, `null` clears, a
string writes trimmed. Two mechanisms, pick by statement type:

- **`.update()` → OMIT the column.** Return `{}` and spread it, so the column never enters the
  statement and Postgres does not touch it. No before-image read, nothing to race.
  `src/lib/attendance/exception-notes.ts`.
- **`.upsert()` → read the before-image** and write it back, because an upsert must state every
  column for the insert case. `src/lib/hiring-documents/status-notes.ts`.

**Hunt method and result** (scripts in the session scratchpad, `hunt_trap.py` / `hunt_trap2.py`).
Round 1 used a repo-wide set of optional property names and produced false positives. Round 2
resolves each hit against **its own** enclosing function's parameter type (inline or named alias) —
that is the pass to trust.

```
write objects scanned (.upsert / .update)  : 373 across 99 files
CONFIRMED  field optional in its own type  : 51
REJECTED   field required in its own type  : 74
UNRESOLVED type not found                  :  5
```

**Two real findings, both LATENT — neither ever fired:**

1. **`reviewAttendanceException`** — FIXED by **PR #2326, squash `64d0b351`**, merged 13:26 Cairo.
   `attendance_exceptions.notes` has **two authors** (requester on create, reviewer on decision) and
   all three layers erased the first: the UI posted `notes: reviewNotes[id] ?? null` from an
   untouched box, the route coerced string-or-null, the service wrote it unconditionally. Approving
   without typing blanked the note the table renders directly **above** the review box. **Fixing
   only the service would not have helped** — the client already sent a deliberate-looking `null`.
   `attendance_exceptions` held **0 rows** in production, so nothing was lost.

   **Proven on production**, same wire payload, only the code swapped, on a synthetic row
   (`ZZ-NOTE-PROOF`, seeded then deleted — the table has no FK on `employee_hr_id`, so a synthetic
   id is safer than borrowing a real one: it is on no roster and cannot reach a report):

   ```
   OLD  {"decision":"approved","notes":null}  route->null       -> (null)  WIPED
   NEW  {"decision":"approved"}               route->undefined  -> note PRESERVED
   ```

   The review really ran in the NEW pass — status `approved`, reviewer stamped, `reviewed_at`
   13:55:50 Cairo — so the preserved note is not a no-op. Table restored to 0 rows.
2. **`finalizeIntakeEvent`** (`src/lib/recruitment/inbound/cv-intake-service.ts`) — **FIXED by PR
   #2329**, "a late throw erased the candidate an intake had just recorded", which shipped three
   defences. Re-verified on `origin/main` 2026-08-28: `unappliedFieldCount` now wraps its body in
   try/catch and returns 0 on failure, with a comment naming this exact unwind path, so the
   argument expression can no longer throw into the outer catch. The account below is the dated
   record of what was true on 2026-08-23 and why #2329 was written — it read **NOT fixed** then.
   Param literally named `patch`, four optional fields all `?? null`. Harmless because every call
   site is terminal, except one: the success path finalizes, then calls
   `notifyTalentAcquisitionOfInboundCv(...)`. That call is `.catch()`-guarded but its **argument
   expressions are not** — a synchronous throw in `unappliedFieldCount(...)` lands in the outer
   catch, which re-finalizes without `candidateId`/`fileId`, nulling both and stamping a successful
   intake as `error`. Production: **1021 events, 0 with `outcome = 'error'`** — never fired.

**Four checked and CLEARED — do not re-flag these:**

- **`saveHiringPackProfile`** — 18 optional fields, Form 1 government data, the biggest cluster. It
  is a `PUT` and `payloadFromForm` iterates `ALL_FIELDS` setting every key. Correct full-replace.
- **`updateUserScopeOverride`** — round-1 false positive; its own type declares every field required.
- **`upsertAccessUserCore`** (`manager_hr_id`) — nulling degrades gracefully, reads fall back
  `row.manager_hr_id ?? employee?.managerHrId ?? null`.
- **`recordVacationApprovalStepDecision`** — guarded by `.eq("status", "pending")`, so no prior
  value can exist to erase.

**`saveAttendanceException` is deliberately NOT the same bug** and is pinned by a test assertion.
It creates-or-fully-replaces the dispute, so its payload really is the whole record. The next
session to run this hunt will be tempted to "fix" it — don't.

**The remaining ~45 confirmed-by-type were triaged, NOT proven.** They cluster into
create-or-full-replace writers (`upsertDelivery`, `addEmailSuppression`, the CRM resolution setters,
email template drafts) where an absent field legitimately means "not set". That is a judgement, not
a clearance — re-check before trusting it.

**The decisive triage question**, faster than reading the type: *does a later, different step write
the same row and omit the field?* If one writer creates and a second writer updates, the second is
the suspect. Both real findings are exactly that shape; every cleared case is a single full-replace.

Related: [[hiring-document-writes-were-unaudited-until-2026-08-23]] ·
[[a-narrowed-select-disarms-every-gate-downstream-of-it]] ·
[[system-flags-expenses-never-rejects]]
