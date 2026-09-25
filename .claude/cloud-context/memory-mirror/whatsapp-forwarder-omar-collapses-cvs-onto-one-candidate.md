---
name: whatsapp-forwarder-omar-collapses-cvs-onto-one-candidate
description: "RESOLVED 2026-08-18 - 201280955558 (Omar Anwar) was added to RECRUITMENT_WHATSAPP_IMPORT_SENDERS on Railway prod, all 303 parked rows were released and drained into per-person candidates, and the 37 collapsed CVs were cleaned up. The queue is NOT parked. Kept for the lesson: a bulk forwarder who is not an import sender collapses every CV he sends onto one candidate by phone."
metadata: 
  node_type: memory
  type: project
  originSessionId: 8bba9208-5cc4-429c-bf4e-fdf6041124f1
  modified: 2026-08-18T17:56:05.624Z
---

## 🔴 2026-09-11 — THE FORWARDING DIRECTION REVERSED, AND THE ALLOWLIST DID NOT FOLLOW

**Since coexistence went live (2026-09-11 02:16 Cairo) the handset `01159888247` RECEIVES instead of
forwarding, and a DIFFERENT number now forwards INTO it.** `RECRUITMENT_WHATSAPP_IMPORT_SENDERS` held
only `01159888247` — the old outward direction — so the new forwarder was unknown and every CV it
passed on was filed with **the forwarder's own phone as the candidate's**.

- **Two candidates were created carrying the OWNER'S PRIVATE MOBILE as their personal phone**:
  Abdel-Rahman El-Ghaly and Samaa Shalaby, both also sharing one `phone_norm`, so the duplicate
  checker saw them as the same person. **Corrected 2026-09-11 12:21 Cairo** to the numbers their own
  CVs carried at high confidence. **He asked that his number not be written down — it is not recorded
  here, and the allowlist is where it belongs.**
- **Allowlist now `01159888247,01280955558`** (GitHub repo variable, synced to Railway on the next
  push to `main`). Set 12:22 Cairo.
- 🔴 **CONTACT REVIEW CANNOT FIX A WRONG PHONE — only a BLANK one.** Its own subtitle: *"Candidates
  with no email or phone on record whose own CV carries one. Accepting fills only the blank column —
  anything already on the record always wins."* A candidate holding a WRONG value is not even listed.
  Reaching for that screen to correct bad contact data wastes a trip.
- 🔴 **The sanctioned correction is `PATCH /api/recruitment/candidates/[id]` with `{ phone }`**, which
  routes through `updateCandidatePayload` and RECOMPUTES `phone_norm` beside it. **Never raw-SQL the
  phone**: the norm column is app-maintained and a hand-written local-format number would leave the
  dedupe index pointing at the old value.
- ⚠ **This now has teeth it did not have before.** The manual reply box shipped the same morning reads
  the conversation a CV ARRIVED in, so on a mis-attributed record "Reply on WhatsApp" messages the
  FORWARDER, not the candidate, with nothing on screen to reveal it.


**The "163 CVs sent, none appear" incident (2026-08-18).** A recruiter/forwarder, **WhatsApp
`201280955558` ("Omar Anwar")**, bulk-forwards many people's CVs. His number is NOT in
`RECRUITMENT_WHATSAPP_IMPORT_SENDERS`, so intake uses `identitySource: "sender"` and stamps HIS
phone (`+201280955558`) on every candidate. `createCandidate` then dedup-matches them all by phone
onto **one** candidate `cc764b4a-a5ea-498d-9cf4-d9a1ce769f0b` — wrongly named **"AYA MOHAMED
MAHMOUD"** (his first forward, 2026-07-25). Proof: 14/14 recent matches → 1 candidate, `match_reason=phone`;
that card holds **21 distinct CV files from 21 people**. CV FILES ARE PRESERVED (misattributed, not lost).

**FIX = add `201280955558` to `RECRUITMENT_WHATSAPP_IMPORT_SENDERS`** (Railway prod env, comma-sep,
read at drain time; APPEND, don't overwrite any existing senders). Then release the parked queue,
then split the 21 collapsed CVs (reset their `ats_cv_intake_events` + re-enqueue so they reprocess
as `identitySource:"cv"`).

**RESOLVED for the live batch (2026-08-18 ~17:50 UTC):** `RECRUITMENT_WHATSAPP_IMPORT_SENDERS` now =
`01159888247,201280955558` (Railway prod, deploy `5ebd45ee` SUCCESS). Verified: released test CVs
created DISTINCT candidates (Bakr Tawfik, Mohamed Mahmoud, Aiman Naz Azhar), phone null — no collapse.
Then released all 303 parked rows; they drain into per-person candidates over the following hours.

**Collapse cleanup (2026-08-18):** 37 CVs had merged onto `cc764b4a`. **35** (fresh media) were
re-queued by deleting their `ats_cv_intake_events` rows + resetting their queue rows to `queued` —
they now reprocess into distinct candidates. AYA's phone was nulled (was +201280955558).

**STILL OPEN (do after the ~313-row queue finishes draining, ~4h from 18:00 UTC):**
1. Delete the 35 ORPHAN file copies still attached to `cc764b4a` — but only per-file AFTER confirming
   that CV's reprocess created a new candidate+file (don't delete the sole copy if a re-fetch failed).
   Keep only the 2 July-25 originals: `45deb141-…` (AYA's own CV) and `d81d3bfe-…` (a 2nd person).
2. Split `d81d3bfe-…` (2nd person, 07-25, media EXPIRED) into its own candidate from the STORED file
   bytes — needs app-side extraction, not a re-queue. AYA (`45deb141`) stays as the real Aya.
See [[intake-candidates-never-get-phone-applied]], [[recruitment-intake-works-pipeline-never-used]].
