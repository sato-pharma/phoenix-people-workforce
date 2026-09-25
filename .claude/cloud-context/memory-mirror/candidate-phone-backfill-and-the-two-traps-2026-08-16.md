---
name: candidate-phone-backfill-and-the-two-traps-2026-08-16
description: "The candidate phone backfill ran on prod 2026-08-16 (33 -> 140 phones); two traps make a naive phone backfill write garbage or break dedupe."
metadata: 
  node_type: memory
  type: project
  originSessionId: 2660f573-67f5-4949-b3d2-31bccf171402
  modified: 2026-08-15T22:12:00.721Z
---

Ran on PRODUCTION (`ozucdzovmcqvepbozvqf`) 2026-08-16, owner-approved. **Do NOT re-run, do NOT undo.**
Candidates with a phone went **33 → 140 (+107)**. Verified after: 227 rows, **0 pre-existing phones
overwritten, 0 `phone_norm` mismatches, 0 phones without a norm, 0 duplicate norms.** Before-state in
`candidate_status_backup_20260816.ats_candidates_phone_before` (private schema — see
[[recruitment-candidate-migrations-applied-to-prod-2026-08-16]]).

## Two traps that make a naive phone backfill actively harmful

**1. `extracted_fields->'phone'` is an OBJECT, not a string.** Its shape is
`{"value": <string|null>, "confidence": "high"|"low"}`. So `extracted_fields->>'phone'` returns the
**stringified JSON object**, not the number — and a backfill built on it writes `{"value": ...}` into
the phone column of every row while reporting a healthy-looking count. Always read
`(extracted_fields->'phone')->>'value'`. This nearly wrote JSON blobs into 145 rows here.

**2. `ats_candidates.phone_norm` has a partial UNIQUE index and NOTHING maintains it.**
`recruitment_candidates_phone_norm_uidx` is `UNIQUE (phone_norm) WHERE phone_norm IS NOT NULL`, and
there are **no triggers on `ats_candidates` at all** — `phone_norm` is written by the app only
(`candidates.ts` → `normalizePhone`). Two consequences: a raw SQL write that sets `phone` alone
leaves the row **invisible to dedupe**, and a colliding value **rejects the whole statement**, not
just that row. `normalizePhone` is digits-only — SQL equivalent
`nullif(regexp_replace(v, '[^0-9]', '', 'g'), '')`. The same applies to `email_norm` and
`national_id_norm`, which carry the same partial-unique pattern.
`cv-intake-service.ts` already handles this at intake by retrying the write **without** the phone so
the other enriched columns still land — do not "simplify" that retry away.

## What the AI's phone values actually look like (measured on 178 extractions)

Only **41 of 115** fillable high-confidence values were a standard 11-digit Egyptian mobile. The rest:
16 with the `20` country code, 4 in `0020…` international form, ~12 Egyptian landlines
(`03x`/`07x`/`09x`), and **~30 genuinely foreign** — Saudi `966`, UAE `971`, India `91x`, Pakistan
`923`, Jordan `962`, Lebanon `961`, Philippines `63x`. A foreign phone is **not** evidence of a
foreign national (Egyptians work abroad); eligibility is flagged separately by `nationality.ts` — see
[[recruitment-egyptian-nationals-only]]. Foreign numbers were written; they are real contact details.

**8 values were not phone numbers at all** — 22, 23, 24 and 32 digits, i.e. two or more numbers run
together. Those were NOT written and are still sitting in `extracted_fields` for a human. The rule
used was "10–13 digits, plus 14 when it starts `0020`". Only **high** confidence was written: 21
further fillable rows were low-confidence and were deliberately skipped, because a wrong phone number
is worse than a blank one — you ring the wrong person and never ring the right one.

**87 candidates still have no phone**, mostly the ones whose CV was never read — see
[[recruitment-intake-works-pipeline-never-used]].
