---
name: duplicate-customer-scan-misses-transliteration-and-cross-line
description: "A folded-Arabic duplicate scan structurally CANNOT see Arabic-vs-Latin transliteration pairs — and the two it missed are cross-LINE, which the owner's treasure rule says never to merge."
metadata: 
  node_type: memory
  type: project
  originSessionId: da5b316c-c6c1-4593-abd2-1ff2cab200e2
  modified: 2026-08-21T00:17:34.390Z
---

Two separate traps, both hit on production `ozucdzovmcqvepbozvqf` on 2026-08-21 while merging the
طاحون duplicate customers.

**1. The orthography fold is blind to script changes.** The scan that found the طاحون pair folds
Arabic variants only:

```sql
regexp_replace(translate(normalized_name, 'ىأإآةئؤ', 'ياااهيو'), '\s+', '', 'g')
```

It catches ى/ي, ة/ه, أإآ/ا — and **nothing written in Latin letters**. Returning `[]` from it proves
only that no *Arabic-spelling* duplicates remain; it is not an all-clear. The seeded 2026-07-02 rows
are Arabic, the app-captured rows are often typed in Latin by the rep, so **the duplicate pair that
matters most is exactly the pair this scan cannot see.**

The blind spot is small and worth enumerating by hand rather than leaving open — only **5 of 162**
active customers are Latin-only:

```sql
where display_name ~ '[A-Za-z]' and display_name !~ '[؀-ۿ]'
```

Of those 5, checked one by one against the 157 Arabic rows: **2 are real twins**, 3 are clean
(`Mohamed nasiem`, `Abd ghaffar Taha`, `Ramzy Riad` — no Arabic counterpart, or a same-surname row in
a different area, which is not a match).

| Latin (app-captured) | Arabic (2026-07-02 seed) | Area | Lines | Outcome |
| --- | --- | --- | --- | --- |
| `Reda Solimany` MKT-HCP-20260816-F585A5F4 | `رضا سليمان` ROI-C-7986552D8DC1 | Alex East | 1 Anti Infective vs 3 CNS | **MERGED 2026-08-21** |
| `Hossam bosraty` MKT-HCP-20260812-A26BF1C7 | `حسام البصراتي` ROI-C-CF7662DC8FAF | Helwan-Maadi | 2 Pedia vs 3 CNS | **MERGED 2026-08-21** |

**Both were merged on the owner's explicit instruction — a cross-`line_id` pair is NOT automatically
a treasure.** I argued `Hossam bosraty` should stay because its second line was a genuine Pedia field
capture; the owner overruled that and had it merged too. **A duplicate person is a duplicate person.
The treasure rule is about not REASSIGNING a customer between lines, not about keeping two rows for
one doctor.** Ask him — do not decide it from the rule text.

The two still differed in a way that changed *how* each merge ran, and that distinction is the
durable lesson:

- **`Reda Solimany`'s second line was head-office desk entry** — created 2026-08-16 by the owner on
  behalf of a **Product Manager** (A-10, area scope *Egypt*), location from map search, no photo.
  Its evidence was **not** carried over; forging a field capture is exactly what the gate forbids.
- **`Hossam bosraty`'s was a real field capture** by a **Pedia District Sales Manager** (B-94):
  timestamped live photo, GPS to **18.1 m** in Maadi. That evidence **was** carried onto the
  survivor, taking it `missing → complete` / `system_validated`.

**So the evidence question is decided per-pair, by whether the capture is real** — check the owner's
`job_title` plus `"at the desk"` / `"map search"` in `validation_notes`. Prod carries only
**6 such desk customers and 5 desk pharmacies**, all from one 2026-08-16 session.

After both merges: **160 active customers**, and only **3** Latin-only rows remain
(`Mohamed nasiem`, `Abd ghaffar Taha`, `Ramzy Riad`) — all three confirmed to have no Arabic twin.

**Merge shape that worked** (both merges this night used it, as one atomic statement):
re-point the loser's links with `not exists` on `(customer_id, distributor_code_id)` to respect the
grain, retire the loser, annotate the survivor — and **do not carry the loser's `evidence_status`
over**. The absorbed record's "evidence" was a desk map-search; promoting it would forge the field
capture the whole gate exists to require. Survivor stayed `missing`, and `usable_links` stayed
**180** across both merges — a merge moves usability, it never creates it.

**2. Both twins differ by LINE — so they are the owner's "treasure", not duplicates to merge.**
[[cross-line-shared-customers-are-never-reassigned]]: a customer called on by two lines is to be
highlighted and **never shifted or reassigned**; only a SAME-line rival is a contest. A customer row
carries a single `line_id`, so **two rows IS how a two-line relationship is currently represented** —
merging them destroys the very signal the rule protects. **Do not merge a name-duplicate until you
have compared `line_id`.** The طاحون merge was safe precisely because both rows were `line_id = 2`.

**How to apply:**

- Run the fold scan, then **also** enumerate the Latin-only rows and eyeball them. Two queries, not one.
- A differing `line_id` does **not** block a merge — the owner merged both cross-line pairs. What it
  changes is whether to carry the loser's evidence: check the owner's `job_title` and `"at the
  desk"` / `"map search"` in `validation_notes` to tell a real field capture from a desk entry.
- A same-surname row in a **different area** is not a twin (`حكيم نسيم غالي` Alex West vs
  `Mohamed nasiem` Haram-Faisal). Require area agreement as well as name.
- These two pairs were **left untouched** pending the owner's ruling. Nothing was merged.

**The pharmacy side looks like the same shape and is NOT — it stays split.** `مستشفي فيكتوريا`
[0001507387] and `مستشفى فيكتوريا` [MKT-PHA-20260816-5C5D312C] fold identically and sit in the same
area (AB1 / Alex East), but they carry **two different POS codes that both resolve `exact` on the
master map, at two different registered streets** — `1507387` = *فيكتوريا شارع الجلاء*, `1507381` =
*فيكتوريا امام نقطة الحرية*. A typo would resolve on one code only, not both.

They also **share a doctor** (رضا سليمان / Reda Solimany, the pair above) — and **that is not
evidence of anything.** Owner, 2026-08-21: *"maybe same dr have more than 1 ph around him."* 45.3% of
customers already link to 2+ pharmacies. I had cited the shared doctor as a merge signal; it is the
norm, not a clue. See [[duplicate-pharmacy-test-is-name-and-gps-not-brick]].

One loose thread there: the captured row's own GPS address reads *"…متفرع من، **Al Galaa**…"*, which
is the street registered to the **other** row's code — so the rep may have attached the neighbouring
POS code. The #2231 governorate check cannot catch it; both codes are Alexandria.

Related: [[marketing-links-were-backfilled-from-a-sheet-not-the-database]] for where the seeded rows
came from, [[seeded-marketing-pharmacies-have-no-area-and-are-invisible]] for the area backfill.
