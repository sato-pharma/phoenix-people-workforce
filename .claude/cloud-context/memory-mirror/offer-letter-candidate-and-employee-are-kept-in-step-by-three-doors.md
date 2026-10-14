---
name: offer-letter-candidate-and-employee-are-kept-in-step-by-three-doors
description: "the offer letter, the candidate and the Employee Master are kept in step by FOUR doors (HR Add Employee from a letter, the joining form, \"declined offer\" on the Master, a letter marked declined by hand) — the candidate is found only through the letter's pointer, never by name; the overview's candidate tiles and funnel count the candidate POOL and the Hired tile the Master, never the applications half."
metadata:
  node_type: memory
  type: project
  originSessionId: 6b40e024-2cfa-4bf3-9807-0f6c0efe9ce6
  modified: 2026-10-14T08:16:24.205Z
---

On 2026-10-14 the owner said the Talent Acquisition overview ("job offers vs recruitments") showed extremely wrong data — people were hired from the recruitment module but outside Phoenix, and many offers were sent and answered. Audit on production: 24 of 26 accepted letters had no `employee_hr_id`, four letters still read `accepted` for people the Master recorded as `declined_offer`, the Hired tile read the applications half (2 hired rows ever, so October read 0 while 20 people were hired), and 11 joiners still read shortlisted.

Repaired in production data the same day (announced bulk change; pre-image schema `ats_backup_20261014_offerhirefix`), and the code now keeps it repaired through four doors: HR's Add Employee from a letter, the candidate's own joining form, "declined offer" on the Employee Master, and a letter marked declined by hand on the Offers screen. Account: `docs/recruitment-offer-hire-sync.md`.

**Why:** three records describe one hire and nothing wrote one to the next; matching a candidate to a letter by name would have stamped namesakes (same-named people exist — see [[same-named-customers-on-one-seat-are-not-duplicates]]).

**How to apply:** find the candidate ONLY through the letter's `candidateForOfferLetter` pointer — never by name, e-mail or phone. A status move writes one append-only history line and sends no notice (a rejection notice is never automatic). The Hired tile counts the Employee Master inside the picker's window. The titles "Live candidates, by pipeline stage" and "Job offers, by status" are ones he likes — do not rename them. Answered the same day and applied (pre-image `offers_pre_round2`, `candidates_pre_round2`): Clara Refaat's letter is withdrawn (the company withdrew it), the three name-only joiners (Sahar El Gallad, Emad Awad Sami, Esraa Ibrahim Saad) were stamped hired on his word, and five own-inbox or duplicate letters were withdrawn. Letters now accepted 21 / declined 9 / sent 1 / withdrawn 12; candidates hired 19.

Second pass, same day (pre-image `candidates_pre_round3`): the three name-confirmed joiners were also pointed at their letters; five employees whose recruitment CV was copied from a candidate (same file name and byte size, names and phones agree) had their candidates marked hired; two candidates behind declined letters were closed. Door four: a letter marked declined by hand closes its candidate if still live (never hired/rejected, never for withdrawn). The pool, not the 38 applications, feeds Awaiting Review / With Hiring Managers / Active Candidates and the "Live candidates, by pipeline stage" funnel (plus a "Hired, not started" bar from the Master). Candidates now hired 24. A phone number alone never links a person — one number matched three different candidates.
