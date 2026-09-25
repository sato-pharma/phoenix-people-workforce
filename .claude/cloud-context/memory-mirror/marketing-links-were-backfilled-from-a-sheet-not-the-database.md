---
name: marketing-links-were-backfilled-from-a-sheet-not-the-database
description: "303 marketing customer-pharmacy links came from a 2026-07-02 backfill of ROI-sheet requests Phoenix never held. State 2026-09-17: 163 pending links (45 on the owner's hold); the other 118 went to him as an AREA sheet (two dropdowns, no decision column, PR #3934). He RETURNED it 20:10 Cairo, sorted, with 0 customer and 7 pharmacy area changes, 4 of them against the distributor's registered territory. He ruled 'use the registered area for all 5': 2 pharmacy areas were applied 20:35 Cairo (exact undo inside) and the 4 contradicted changes were dropped. Approve/reject stays his own click."
metadata: 
  node_type: memory
  type: project
  originSessionId: da5b316c-c6c1-4593-abd2-1ff2cab200e2
  modified: 2026-09-17T17:35:48.335Z
---

Every anomaly in the marketing customer/pharmacy graph traces to **one backfill on 2026-07-02**.
The app-captured path (from 2026-08-02) is internally consistent. Audited on production
`ozucdzovmcqvepbozvqf` 2026-08-21.

## 2026-09-17 — the stuck pending queue went to the owner as a ruling sheet

**Live split, production 2026-09-17 18:50 Cairo (active links of active customers):** pending
**163 / 71 customers** · `system_validated` 276 / 135 · `sfe_validated` 15 / 5 · rejected 2 / 1.

**Where the 163 came from** (read from the note — there is no source column):

- **131 — the 2026-07-02 backfill:** the 39 held on 2026-08-21, plus 92 carrying *"Inferred from
  pending/rejected historical marketing requests"*.
- **24 — a hand-run 2026-09-08 backfill of SECOND distributor codes** onto pairings those links
  already named, inheriting their status. 🔴 **The note starts `Backfilled 2026-09-08` and carries
  NEITHER marker** (`INFERRED_HISTORY_MARKER` / `DESK_VALIDATION_MARKER`), so code reads it as a rep's
  field capture. That backfill wrote 81 links in all, one statement: every one stamped
  `2026-09-08 16:19:14.574275+00` (19:19 Cairo) by B-10.
- **8 — rep captures in the app** (2026-08-25 to 09-07), waiting for proof on both sides.

**Why nothing moved — every exit was measured shut:** the 118 un-held links last changed 2026-09-08
19:19 Cairo. No note carries an `Approved` stamp, so the mapping page has never recorded an approval;
the only rulings ever are **2 rejections, 2026-09-03 07:19 Cairo** (codes registered to shops in
other governorates). The page's loader failed for every caller until **#3627 (merged 2026-09-10
00:40 Cairo)**. No capture was ever attempted for a backfilled customer, so the sweeps released 0.

**Holds 39 → 45 (owner, in chat: "Hold them too").** The 6 second-code twins of held pairings had
this sentence APPENDED 2026-09-17 18:11 Cairo — notes and `updated_at` only, status untouched,
`updated_by_hr_id` still B-10:
` Held 2026-09-17 by owner decision: this is a second distributor code for a customer and pharmacy pairing held on 2026-08-21, so it waits for the same release as that pairing. Release only once the shop is captured or the pairing is confirmed.`
**Exact undo:** `replace(validation_notes, <that sentence>, '')` and `updated_at =
'2026-09-08 16:19:14.574275+00'` on ids `3e88ec05-992b-4d4a-acea-17d15db27264`,
`e426c375-66ea-42df-ab1e-b50fdca4fd87`, `30f9d872-ce6c-4ea9-88fd-0a534f7d5f9a`,
`1f7c4b7c-a1a6-4e14-84cb-affe6472f634`, `ac60f20a-db26-4890-aff8-6ea193ad4f6c`,
`1e71d60d-0128-49f0-9823-2b68ac945a3f`. The JSON pre-image in the scratchpad was lost when Temp was
wiped the same evening; session transcript `f2e9e8d4-16df-4e35-9f76-1fa928461c36` still holds it.

**The route he chose: "Ruling sheet (Recommended)"**, one row per customer + pharmacy.
`scripts/customer-pharmacy-pending-questions.ts` (PR #3934) first wrote
`xlsx/customer-pharmacy-ruling-2026-09-17.xlsx` with a Decision dropdown (Approve / Reject / Leave
pending / Other). 🔴 **Same evening he replaced it: "choose from droplist the AREA not the decision",
and picked "Two dropdowns" in chat.** Then he asked for an address column. The LIVE sheet is
`xlsx/customer-pharmacy-areas-addresses-2026-09-17.xlsx` (primary checkout, gitignored, no backup;
the earlier `customer-pharmacy-areas-2026-09-17.xlsx` has the same dropdowns at B/G and no addresses):
**99 pairings / 118 links / 50 customers**, the 45 held links left out, **Customer's area (col B)
and Pharmacy's area (col H) as lists pre-filled with the area on file**, each followed by its address
(C = CRM contact address + app capture, 69 rows; I = distributor-registered address from the live
`source_of_sales_customer_map` + app capture, 86 rows), a Note column, and NO decision column. The list
is the 49 active areas with `line_id is null` (very hidden `Area list` sheet); cells turn red while
B ≠ H. Hidden columns O = link ids, P/Q = customer's/pharmacy's area AS FILED.
What the rows say:

- **40 of the 50 customers have nothing approved** (80 of 99 rows) — unusable on any request today.
- **CRM corroborates nearly all of it:** 86 rows have calls through the CRM contact id by reps of
  the customer's own area (80 all in-area, 6 plus elsewhere); 7 rows match on name only (in-area
  calls); 3 have calls but none by that area's reps; 3 have none logged.
- **The owner rep has left for 24 rows (8 customers)**; 1 row has no owner. 17 rows file the
  pharmacy in a different area from the customer. 89 rows have nothing captured on either side.
- **Duplicate records surfaced, NOT merged:** on 5 rows (4 customer records — د.مصطفي شلش ×2,
  رضا سليمان, سيد البلاصي, صدر امبابة) a same-name or one-letter-off pharmacy is ALREADY approved for
  that same customer, so the pending row is likely a duplicate record. رضا سليمان is 4 customer
  records in one area; سيد البلاصي and د.سيد البلاصي are 2. Put pairs to the owner — never merge on
  a name (AGENTS.md §2.3).
- **The sheet never flags a `nursery`** — the owner's own filing (§4.1). A first draft did; removed.

**RETURNED 2026-09-17 20:10 Cairo** (same filename, overwritten; sent copy kept at
`F:\Claude Scratchpad Archive\xlsx\2026-09-17\customer-pharmacy-areas-addresses-2026-09-17.xlsx`, 19:11):

- 🔴 **He SORTED it, and the filter stopped at N, so the hidden O:Q stayed put** — reading B/H against
  P/Q by row gave "87 changed", all false. Match each returned row to the SENT copy by its visible
  non-answer cells instead (99/99 matched one to one). The filter now spans A:Q (5542620f1).
- 🔴 **He added a `Sheet1`: a pasted "Phoenix Area" list, VLOOKUP'd by pharmacy NAME and pasted into
  column H** (11 cells typed by hand where the list said "Unresolved"/"probable"). So his H is partly a
  NAME MATCH, which is exactly why 2 answers contradict the registration. Two pasted values, "Port Said -
  Domiat" (capital S), bypassed the dropdown; they are the same area.
- **Result:** customer areas 0 changed, notes 0. Pharmacy areas changed on 7 rows: 2 are case only,
  1 agrees with the registration (مينا مجدى - ببا ن Fayoum → Beni Suef, brick Biba). **4 contradict the
  distributor's registered brick:** الرومانى Heliopolis → Sohag1 (ramco, Midan El Hegaz); مستشفي زمزم
  Alex West → Alex Center (POS, Moharram Bek); غاده احمد – المندرة قبلى Assuit 1 → Assuit 2 (POS,
  Manfalut); عابدين فارما Sohag2 → Sohag1 (Ibn sina, Girga). The last two he typed to match the
  customer's area. Also مارتينا كميل, left at Assuit 2, has an Ibn sina code registered in Um Doma, on
  the Sohag-city brick (Sohag1), with no name on the map row. Registered territory versus his final
  answers: 90 agree, 5 disagree, 4 have no registration.
- 🔴 **The sent sheet MISSED registered addresses** on 7 rows. It joined the code cache's
  `mapped_*` pair, which stays null for a code the resolver once called `unresolved` (§2.3 trap). The
  builder now matches live, like the resolver: `marketing_roi_distributor_rollup` family codes, then
  the exact or zero-stripped code.

🔴 **OWNER RULING, in chat, 2026-09-17: "use the registered area for all 5 pharmacies".** Settled, so do not
re-ask. The 4 contradicted changes were NOT applied: الرومانى stays Heliopolis, مستشفي زمزم Alex West,
غاده احمد – المندرة قبلى Assuit 1, عابدين فارما Sohag2. **APPLIED TO PROD 2026-09-17 20:35 Cairo, 2 rows
in `marketing_pharmacies`** (`area_id`, `updated_at`, `updated_by_hr_id = 'B-10'`; the update was
guarded on the old area; the table has no triggers; each pharmacy has one pending link):
مينا مجدى - ببا ن `55f59882-87cb-4159-9d05-b0df6ed424b8` Fayoum 1118 → **Beni Suef 1145**;
مارتينا كميل `38c65891-7062-4217-978b-7dc10f40e621` Assuit 2 1126 → **Sohag1 1127**. **Exact undo:**
set `area_id` back to 1118 / 1126, `updated_by_hr_id = null`, and `updated_at` to
`2026-08-20T23:51:21.865Z` / `2026-08-20T23:48:16.522Z`. The full-row pre-image is at
`F:\Claude Scratchpad Archive\csv\2026-09-17\pharmacy-area-move-preimage-2026-09-17.csv`. The link
statuses were not touched. مارتينا كميل's customer ايهاب سمير لوقا stays in Assuit 2, so that pair is
now split across two areas.

**Reading any later return:** match rows to the sent copy by visible cells (never by position), find
columns by HEADER, and read the changed areas back in chat. **Area names are unique only among ACTIVE areas** — inactive line areas
reuse "Alex Center", "Minia 1" etc., so resolve a name with `is_active and line_id is null`. A record on
several rows given different areas is a question for him, never a pick. Any area write on production
is a bulk data change: announce it and take the pre-image first (§8), and his "change" is not an
approval of the pairing. **Each approve or reject is still his own click on
`/admin/customer-pharmacy-mapping` — never SQL, never a session, never suggested for him.**
⚠️ `approveCustomerPharmacyLink` writes **`system_validated`** — the "no human looked" label — with
the note `Approved by <hr id>` (or `Approved: <note>`), so today a human ruling is distinguishable only
by its note. A fix was offered as a separate task, not done.

**Two nudge gaps found the same day (offered as a task, not fixed):** `linkHasFieldEvidence`
(`validation-report.ts`) counts any link with neither marker as field evidence, so a 2026-09-08 link
silently removes its customer's "not field-validated" badge AND the daily nudge (≈16 customers). And
`groupFieldCaptureBacklog` routes to `owner_hr_id ?? manager_hr_id` without checking the owner still
works here — the active directory only feeds the AREA fallback — so ≈5 customers are nudged only to
a leaver.

The backfill wrote 303 links and split them by a note it stored in `validation_notes`:

- *"Inferred from **approved** historical marketing requests"* → **193 links `system_validated`**
- *"Inferred from **pending/rejected** historical marketing requests"* → **110 links `pending`**

**Those historical requests are not in this database.** `marketing_requests` held 10 rows, all
created 2026-08-02 or later; none predate the backfill and none name any of these pairs. The
approvals lived in the ROI sheet the `ROI-C-…` / `ROI-P-…` codes came from — so the split is not
reproducible from inside Phoenix, and the links stood in the request dropdown on **zero field
evidence**.

**Owner decision 2026-08-21: 39 of the 193 were held on `pending`.** **154 still stand.**

🔴 **APPLIED TO PROD 2026-08-21: the false "no CRM visit activity" clause was corrected on 30 of the
39 notes.** A backup table was taken and then **dropped at the owner's instruction the same night**,
so there is no rollback table — but the edit stays reversible **because it was a pure substring
substitution**: replace the `. Corrected 2026-08-21: …` sentence back with
` and the customer has no CRM visit activity.` and the original note returns exactly. Note prod has
**PITR OFF** ([[production-supabase-has-no-pitr-only-daily-backups]]), so a snapshot restore is a
blunt last resort, not a per-row undo. **Only the clause changed — `validation_status`, `active`, the
`by owner decision:` hold marker, the backfill provenance sentence, the "Release only once…"
condition and one row's `Re-pointed` suffix were all verified intact on 39/39 afterwards.** The
9 tier-C rows were **deliberately left untouched because the clause is TRUE for them** — do not
"finish the job" by rewriting those too. Corrected rows now carry a dated `Corrected 2026-08-21:`
sentence naming the in-area visit count and last visit date (tier A) or stating that visits exist
but none from that area, so identity is unconfirmed (tier B).

🔴 **RE-CONFIRMED 2026-08-21: the owner was shown all 39 in a dropdown workbook and answered
"leave them held" — ALL 39, no releases, no retirements.** **Do not re-ask this as an open question** and do not
offer to release them again unprompted. The rows' own note already states the condition that would
change the answer — *"Release only once the shop is captured or the pairing is confirmed"* — so the
next legitimate trigger is field evidence arriving, not another review. Note the hold survives
capture: the sweep skips all 39 on `MARKETING_MANUAL_HOLD_MARKER`, so even a fully photographed pair
stays `pending` until a human releases it.

🔴 **THREE THINGS IN THE ORIGINAL VERSION OF THIS NOTE WERE WRONG — re-measured on prod 2026-08-21
when the owner asked to see the 39. Do not trust the old phrasing if it resurfaces in a summary.**

1. ⚠️ **This point was itself WRONG and is corrected here (2026-08-21).** I searched for
   `Held 2026-08-21 by owner decision:` as a note **prefix**, got zero rows, and wrongly concluded
   the hold carried no annotation. **It does.** The text is **APPENDED** after the backfill's own
   sentence, so only an infix search finds it. All 39 read:
   ```
   Inferred from approved historical marketing requests — not GPS field-validated. Backfill
   script 2026-07-02. Held 2026-08-21 by owner decision: written by the 2026-07-02 backfill from
   an approved ROI-sheet request, but Phoenix holds no field evidence for it and the customer has
   no CRM visit activity. Release only once the shop is captured or the pairing is confirmed.
   ```
   **Match on `validation_notes ilike '%by owner decision:%'`, never on a prefix.** That substring is
   `MARKETING_MANUAL_HOLD_MARKER` (`types.ts`, value `"by owner decision:"`), and
   `refreshLinksAfterCustomerCompletion` skips any link whose notes contain it — verified on prod
   2026-08-21: **39/39 carry the marker, 0 would be auto-released.** So the hold is mechanically
   honoured, not merely conventional: field capture will NOT release these, exactly as the note's
   own last sentence says. **The release condition is written ON THE ROWS** — "once the shop is
   captured or the pairing is confirmed" — so that is the owner's standing rule for this set, not a
   question to re-ask from scratch.
2. **22 customers, not 23.**
3. **The stated basis — "their customer has no CRM visit either" — does not hold.** Live,
   **16 of the 22 have CRM visits** and **12 are corroborated by a rep who actually works that
   customer's area**, several within the last three weeks (67 visits, 33, 27, 23…). Whatever
   separated these 39 from the 154, it was not absence of field activity.

**The tiering that IS true, measured 2026-08-21** (fold Arabic names, join `ireports360_visits.contact_name`,
then join `employees.hr_id = agent_hr_id` and compare `e.area_id` to the customer's `area_id`):

| Tier | Links | Customers | Meaning |
| --- | --- | --- | --- |
| A — corroborated | **24** | 12 | visits logged by a rep on that customer's own patch |
| B — name match only | **6** | 4 | someone of that name visited, but never a rep from that area |
| C — no CRM trace | **9** | 6 | no visit under that name anywhere, ever |

**The in-area test is what makes tier A safe** — a bare name match is worthless for common Egyptian
names. Ten of the twelve tier-A customers match **100%** in-area (67/67, 33/33, 27/27, 23/23 …),
which is not what a name collision looks like. And **do not assume a `PD-####` agent is a national
Product Manager** whose area comparison fails structurally — PD-0004 and PD-0005 are both **Medical
Representatives** with real patches (UE6 Sohag2, AB2 Alex Center), so their mismatches are genuine
contradictions. I assumed the artifact and had to check; checking reversed the reading.

6 of the 39 links are cross-area (`DIFFERENT`), which is legitimate on its own.

🔴 **`تعاقد الكهرباء جليم` is NOT a junk row — the owner already ruled on it 2026-08-19, and the
ruling is written on the row itself.** I flagged it twice as suspicious (an electricity-contract
account typed `doctor`, zero CRM trace, three linked pharmacies in Alex East, **Menoufia 1** and
**Nasr City** at once) before reading its `validation_notes`, which say in as many words: *"NOT a bad
record and NOT to be deactivated"*. It is a **corporate-contract customer**; the owner assigned
`AB1 Alex East` by hand because the three codes resolve to three governorates and Glim is in eastern
Alexandria. The sibling `تعاقد شركة الكهرباء` (`ROI-C-25BD12B92D1E`, D12 Menoufia 1, owner B-55) is
the same shape and equally deliberate. Those are the **only two** such rows.

**Read `validation_notes` on a marketing row BEFORE calling it anomalous** — the odd-looking rows are
exactly the ones a previous session already investigated and annotated. Both are still
`customer_type = 'doctor'`, which is arguably wrong (an `other` type exists and holds 1 row), but the
owner did not ask for a retype and the records stand. Holding all 193 was measured first and
rejected: it would have cut usable customers from 124 to 19, and only a Super Admin / CEO can
release a pending link, so it meant 105 manual releases.

**Why:** the blocking governorate check shipped 2026-08-20 (#2231) holds a link when the capture
contradicts the code's region. It cannot help here — these rows have no capture at all. A 2026-08-21
audit asked whether the stuck customers could be resolved by SQL; they cannot.

**How to apply:**

- The 50 active customers with no usable link split cleanly: **39 have a contact and real CRM
  visits (428)** and are blocked only on field evidence; **11 had no contact, no visits, no request
  ever filed** and 10 of those no owner — dead ROI rows, **retired 2026-08-21** with their 18 links.
  Retiring them moved usable customers 101 → 101, i.e. cost nobody anything. After that night the
  live shape is **163 active customers, 101 usable, 62 not** — the 62 being the 39 awaiting field
  capture plus the 23 held above.
- **Retiring a customer does NOT cascade to its links.** The وليد كمال dedup left 4 links `active`
  and `system_validated` on a retired customer; deactivate both together or the orphan comes back.
- **A pending seed link needs evidence on BOTH sides.** `resolveMarketingSystemValidationStatus`
  requires customer AND pharmacy evidence `complete`. Every seed customer is `evidence_status =
  'missing'`, so fixing the pharmacy alone changes nothing — merging five duplicate pharmacies on
  2026-08-21 left the unusable-customer count at exactly 50. Do not promise that a merge unblocks a
  link without checking `marketing_customers.evidence_status` first.
- Releasing these by SQL would forge the evidence the check exists to require. The routes are field
  capture, or an SFE/Super Admin ruling via `approveCustomerPharmacyLink`.
- 🔴 **#2237 did NOT actually unblock these rows — it was rejected for every `doctor` customer,
  which is 130 of the 160 active ones and essentially all of the cohort described here.** Proved on
  staging 2026-08-21 against the deployed revision. **Fixed and LIVE on prod 2026-08-21 04:22 Cairo
  (`ad1dcba3`, PR #2249)** — from that revision on, Capture Evidence genuinely does work for this
  cohort, and 59 customers / 115 pending links became capturable for the first time. See
  [[capture-evidence-was-dead-on-arrival-for-doctor-customers]].
- **Field capture was IMPOSSIBLE for these rows until #2237** (LIVE on prod 2026-08-21 01:11 Cairo,
  squash `56a01af3`): the create path
  could only INSERT, so capturing a customer you already owned minted a duplicate. That PR adds
  "Capture Evidence" on the Not Usable Yet tab and re-decides the links afterwards — see
  [[marketing-link-status-is-frozen-at-write-time]], which is the half that actually empties the
  queue. It also skips and annotates the 39 links held above rather than releasing them.

See [[customer-pharmacy-link-grain-is-customer-plus-code]] for the grain trap in the same table, and
[[marketing-reference-raw-area-drifts-raw-region-does-not]] for which reference column is safe.
