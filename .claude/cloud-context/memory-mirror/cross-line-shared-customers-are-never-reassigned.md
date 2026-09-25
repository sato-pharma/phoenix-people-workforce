---
name: cross-line-shared-customers-are-never-reassigned
description: "OWNER RULE: a customer called on by two lines is a SHARED customer to highlight, never a conflict to fix by moving ownership"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9f9d1d5e-92b5-4eaa-a238-ad2fc773fd35
  modified: 2026-08-19T18:50:37.332Z
---

**OWNER RULE, stated 2026-08-19: "never shift, never shift. You just select and highlight."**

When two reps in the **same area but different lines** both call on the same customer, that is
**normal and expected** — both can legitimately have that customer. It is **not** a data conflict, not
a duplicate, and not something to resolve by reassigning `owner_hr_id`.

**Why:** he explicitly wants to KNOW which customers are shared between lines — his word for it was
**"a treasure"**. Cross-line overlap is commercial intelligence (one doctor, several product lines).
Reassigning ownership to "settle" the overlap **destroys the very signal he is looking for**, because
`owner_hr_id` holds exactly one person and the second line then disappears from view.

**How to apply:** surface the overlap as a flagged/highlighted list. Leave every ownership column
alone. Only a **same-line** rival is a genuine "pick one" question worth putting to him. Before
treating two candidate reps as competing, **compare `employees.line_id` — different line means SHARED,
same line means contested.**

**This was learned by getting it wrong.** On 2026-08-19 three marketing customers were reassigned
across a line boundary and all three had to be reverted on his ruling:

| Customer | Wrongly moved | Back to | The two reps |
| --- | --- | --- | --- |
| `هشام حسن` | B-105 Mariem Hany | **B-59 Mostafa Galal** | Giza - Giza Centers, Pedia vs Anti Infective |
| `هاني الخولي` | B-7 Aya Ibrahim | **B-126 Sara Mohy Eldeen** | Menoufia 2, CNS vs Anti Infective |
| `بيتر فتحي` | B-13 Rana Adel | **B-23 Yehya Mohamed** | Pedia (Sohag 1) vs Anti Infective (Assuit 2) |

Each row's `validation_notes` records the revert and the rule. **Do not re-apply those flips.**

**Measured on prod 2026-08-19** (active reps only, `employees.line_id` for the line, Arabic-normalized
`ireports360_visits.contact_name`): **8,072 CRM contacts, of which 899 are shared across 2+ lines —
558 within a SINGLE area, 341 spanning areas, and 88 called on by all three lines.** The same-area 558
are the strongest set: same patch, different lines, unambiguously the thing he wants to see.

See [[marketing-customer-ownership-gap-is-by-design]] for the ownership backfill this came out of, and
[[owner-sheet-vocabulary-stores-is-office-upa-is-a-channel]] for his other vocabulary rules.

## A MERGE collapses the same shape, and a name check cannot see it — 2026-09-06

The 2026-08-19 cases above were all `owner_hr_id` **reassignments**. A **duplicate merge** does the
same damage by another route, and the guard that catches a reassignment does not fire on it.

Found on production: marketing customer `MKT-HCP-20260812-A26BF1C7` "Hossam bosraty" (**Pedia**,
owner B-94 Taha AboElftouh, a Pedia DSM) was retired 2026-08-21 into `ROI-C-CF7662DC8FAF`
"حسام البصراتي" (**CNS**, owner B-136 Fatma Gharib, a CNS Medical Rep). Both reps active, both in
area **1117 Helwan-Maadi**. Same area, different lines — by the rule above that is a SHARED
customer, not a duplicate. Recorded in `validation_notes` as "Owner decision", so it is **an open
question for him, not a proven error** — but it must not be deepened without his ruling.

🔴 **The reason nothing caught it: the two names are in DIFFERENT SCRIPTS.** `hossam bosraty` in
Latin, `حسام البصراتي` in Arabic, so `normalized_name` differs and a normalized-name duplicate sweep
pairs them NEVER. Measured the same day: exactly **1** name group spans multiple lines
(`رضا سليمان`, lines 1 and 3). That 1 is not the true count of cross-line pairs — it is the count a
name check can SEE. **Never conclude "no cross-line duplicates" from a name-based sweep.**

**What it cost:** the merge moved the customer→venue link to the survivor and left request
`MKT-REQ-20260814-6CD456E4` — approved, live, **11,200 EGP of Pedia spend** — pointing at the
retired row. Re-pointing it to the survivor would move that Pedia money onto a CNS customer, which
is why the re-point was approved by the owner and then **held**: the line question outranks it.

**There is no customer-merge code path** — a customer merge here is hand SQL, which is how the
request was left behind. `marketing_customers.merged_into_customer_id` / `merged_at` /
`merged_by_hr_id` were added 2026-09-06 so a retirement names its successor in a column instead of
in prose; they ship **empty**, because backfilling this pair would machine-record the cross-line
merge as settled. See [[marketing-customers-belong-to-areas-not-people]].
