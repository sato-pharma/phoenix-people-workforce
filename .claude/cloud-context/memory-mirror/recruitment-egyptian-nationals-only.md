---
name: recruitment-egyptian-nationals-only
description: "Phoenix/Sato Pharma hires Egyptian NATIONALS — nationality decides, not current location; an Egyptian working abroad is KEPT"
metadata:
  node_type: memory
  type: project
  originSessionId: 2660f573-67f5-4949-b3d2-31bccf171402
  modified: 2026-08-28T07:41:36.279Z
---

The owner only hires Egyptian nationals. Ruled 2026-08-14 on Afroz Ansari — a strong profile match
for National Sales Manager, but based in Dubai, UAE — with the instruction to exclude him purely on
nationality/location, independent of qualifications: *"HE IS NATONAL SALES MANAGER BUT HE IS FROM
UAE DUBAI SO EXCLUDE WE ONLYB HIRE EGYPTIOND"* (verbatim, typos preserved for the record).

**Why:** a standing company hiring policy, not a judgment call on this one candidate — qualifications
do not override it.

## 2026-08-28 — NATIONALITY decides, NOT current location

⚠ **The old wording of this file said "exclude any candidate based outside Egypt". That is too broad
and would reject real Egyptian applicants.** Owner ruling 2026-08-28, on two candidates with
distinctly Egyptian names at Gulf addresses — Ahmed Ragab Afifi (Jeddah, KSA, `+966`, arrived by
WhatsApp) and AHMED MUSTAFA (Dubai, UAE, `+971`): *"keep them, they are egyptian."*

**A foreign address is a PROMPT TO CHECK, never a verdict.** Jeddah, Dubai, Riyadh and Kuwait are
exactly where Egyptian pharmacists go to work, so a Gulf address on an Egyptian-named candidate is
more likely an Egyptian looking to come home than a foreigner applying in. The Afroz Ansari case
still holds because he was a non-Egyptian national — his Dubai address was corroborating detail, not
the reason.

**How to apply.** Decide on nationality, using evidence rather than a name reading:

- **Strong evidence** — stated `nationality`; the country of the *university and secondary school*
  (this is the single most reliable field in a CV; it settled two ambiguous UAE-based candidates on
  2026-08-28, both Indian: JSS Mysore + a Kerala secondary school, and University of Pune +
  Karnatak University); a national ID; languages spoken.
- **Weak evidence** — current address, employer country, phone country code. A phone `+971` says
  where the handset is, not where the person is from.
- **Not evidence** — the *shape* of a name. It cuts both ways: a name reading nearly kept two Indian
  nationals and would have rejected two Egyptians. Check the CV instead; it takes one query.
- **If nationality is genuinely unresolvable, ASK.** That instruction is unchanged and is what
  produced this ruling.

## How to record an exclusion — the old advice here would BREAK the record

`ats_candidates.status` has **no CHECK constraint** (verified live 2026-08-28), so the database will
accept any string. **This file used to say to exploit that and write a human-readable status like
`"Not Eligible — Non-Egyptian (Dubai, UAE)"`. Do not.** The app's status union is
`new | shortlisted | sent_to_manager | rejected | hired` (`src/lib/recruitment/candidate-status.ts`),
so a free-text value is written happily and then falls out of every status filter and counter — the
candidate becomes invisible rather than excluded.

The correct shape, used for the 29 exclusions on 2026-08-28:

1. `status = 'rejected'`.
2. One row in `ats_candidate_status_events` carrying `from_status`, `to_status`, the human reason in
   `note`, and an `actor_hr_id` ops marker (`ops:non-egyptian-reject-20260828`). `id` is an identity
   column, so omit it.

That events row is also the before-image, which makes every such rejection individually reversible.
**A raw-SQL status change sends nothing outward** — there is no trigger on `ats_candidates` and
`candidate-status.ts` contains no notify/email/telegram call (both verified 2026-08-28;
`notification_outbox` gained 0 rows across both passes). Verify that again before any future bulk
status write rather than assuming it still holds.

**Scale seen so far:** 29 non-Egyptian candidates excluded on 2026-08-28 — India, Pakistan, Jordan,
Lebanon, Philippines, Nigeria, plus Indian nationals resident in the UAE. Ten of the first thirteen
arrived within 23 minutes on 2026-08-14, all by email, which looks like a job-board blast rather
than organic traffic — expect the wave to recur. **Screening by phone shape alone misses people:**
5 of 17 in the second pass had no phone number at all and were caught only by address and
nationality. See [[a-cv-import-overwrote-a-candidates-whole-identity]] for the phone-key rules.

## 2026-08-28 pass 3 — the WHOLE queue swept, and four traps in the sweep itself

A full sweep of all 404 active candidates rejected **35 more** (running total under actor marker
`ops:non-egyptian-reject-20260828`: **64**). Pool after: 448 total, 79 rejected, 316 new, 24
sent_to_manager, 29 shortlisted, 0 on an off-union status. `notification_outbox` gained **0** rows
again. Countries added this pass: Nepal, Indonesia, Myanmar, Ghana, Algeria, South Africa, Iraq,
Syria, Tanzania.

**Four things went wrong in the classifier before they went right. Expect all four again.**

1. **A Latin-only regex silently keeps foreigners AND flags Egyptians.** Eight rows classified
   "no country matched" were plainly Egyptian: `جامعة عين شمس` (Arabic, and one row stored it with
   *reversed presentation glyphs* — `ﺷﻤﺲ ﻋﻴﻦ ﺟﺎﻣﻌﺔ`), `AIN-SHAMS` (hyphen, not the space the pattern
   had), `AASTMT` (the acronym, never the full Arab Academy name), and `Assuit` (that spelling, not
   `assiut`/`asyut`). Match Arabic text, acronyms, and hyphen variants, or hand-read every unmatched
   row — never treat "no match" as "foreign".
2. **The `university` field alone is the WRONG field — read `educationHistory` and weight the
   UNDERGRADUATE degree.** HUSSAIN FATHI ABDULHADI showed `university = "Anglia Ruskin University"`
   (UK), which reads as an Egyptian who studied abroad. His `educationHistory` held a **BSc from
   Zarqa Private University, Jordan, 2009** — the MBA was the later, mobile degree. A master's says
   where someone could afford to go; a bachelor's says where they grew up.
3. **A name-based `IN (...)` list silently drops rows to a typographic apostrophe.** 35 names listed,
   **34** matched. `Sana’ Ahmad Jarrar` stores U+2019 (RIGHT SINGLE QUOTATION MARK, codepoint
   `2019`), not ASCII `0027` — and `ilike '%Jarrar%'` found her instantly while both the exact and
   the `lower(btrim())` comparison returned zero. **Always assert `listed = targeted` in the same
   statement** and chase any gap; without that count the row just never gets actioned and nothing
   says so. Prefer matching by `id`.
4. **`full_name LIKE 'WhatsApp Import (%'` rows are NOT junk to be swept away.** 24 of them, all
   created 2026-08-18 20:52–21:17. 23 carry `is_cv = false` — the extractor's designed verdict on a
   non-CV, i.e. the known image/certificate attachments. But **one was a real applicant**: `RTYyOAA=`
   was **Nada Hussien Ramadan Hussien** (Helwan University, Giza, `is_cv = true`, and the row's own
   phone `01005370130` matched her CV's phone exactly), sitting in the queue under a base64
   placeholder. Her `full_name` was restored 2026-08-28 (`15766596-a5e5-4617-9958-75fd21b61dd7`);
   phone and email were deliberately left untouched. **Check `is_cv` before writing any placeholder
   row off.** Note her row email `hussien262@gmail.com` differs from the CV's
   `nada.hussien262@gmail.com` — not repaired, flagged.

**The one unresolvable case went to the owner and he decided: REJECT.** `Samy Kassab`
(`e7aeb8cf-dce4-4779-adb9-efb92f2f5726`, `+966 57 758 1850`, `samykassab@yahoo.com`) had four
degrees recorded — DBA, MBA, Master's in Commercial Law, LLB — and **not one institution** on any of
them, plus no nationality, no address, no languages, and a career entirely in KSA. The surname
occurs in Egypt, Lebanon and Syria alike, so nothing in the CV could settle it. He was left `new`
and asked about rather than guessed; the owner answered *"reject him"* the same day. Rejected
2026-08-28 with the note recording that it was **his instruction, not evidence** — which is what
makes the row honest if it is ever revisited.

**This is the ASK rule paying off, and it is cheap.** One name, one line of question, one word back.
Do not let a future sweep talk itself into guessing to avoid the interruption. Final totals for the
day: **65 events** under `ops:non-egyptian-reject-20260828`, pool 448 total / 80 rejected / 315 new
/ 24 sent_to_manager / 29 shortlisted, `notification_outbox` +0 across all three passes.
