# A vacant area is not the line's Others bucket

The account behind the rule in `.claude/rules/sales-closing.md`. Fixed 12 October 2026 in
PR #5810.

## The two halves that disagreed

`linkSalesRecordAgainstDirectory` (`src/lib/sales/employees.ts`) recognises a `V-*` area code,
moves it to the lookup key, nulls the HR id, and **deliberately leaves the uploaded display name
alone**. That is pinned, in words, by `tests/sales-linkage.test.ts`:

- `vacantAreaCodesWinOverOthersBucket` — *"V-AF codes must be treated as vacancies even when the
  display name is Others"*, and *"display name can stay as uploaded"*.

So a vacant area whose sheet reads "Others" reaches the read path **still carrying its code**. And
`isSalesOthersBucket` (`src/lib/sales/others.ts`) matched on the display name, which made that area
the line's aggregate bucket. `src/lib/sales/service.ts` acts on that verdict three ways:

| Where | What it does to an Others record |
| --- | --- |
| `:240` | drops it from every scoped read |
| `:438` | labels it "Unassigned DSM" |
| `:455` | excludes it from district attribution |

A vacant area that a matched open vacancy gave a manager would therefore vanish from the manager who
owns the vacancy — the exact outcome the linker's pinned test was written to prevent. The test could
never catch it, because it asserts the linker's output and stops there.

## Why the first reading of this was wrong

The investigation began from production's stored shape — `employee_lookup_key = 'V-AF-11'`,
`employee_hr_id = null`, `employee_name = 'Others'` — and read it as the Others branch having
**erased** the vacancy identity. It had not. Running the linker on the sheet shape
(`employeeHrId: 'V-AF-11'`, `employeeName: 'Others'`) returns exactly that stored shape: the
vacancy branch ran and did its job. The defect was one layer later, in the read path.

**The lesson: a stored row is the output of a pipeline, not evidence of which branch produced it.**
Two branches of `linkSalesRecordAgainstDirectory` can write a similar-looking row. Run the function
on the input shape before naming the branch that ran.

## Measured scope — it was latent, not live

Read on production (`ozucdzovmcqvepbozvqf`) on 12 October 2026. The five vacant Anti Infective
territories, batch `af33ab06-f905-4248-83ae-e83b37b04367` (`sales_import_batches`: line
Anti Infective, `status: approved`, `replaced_by_batch_id: null`, approved by B-10 on 5 July 2026 at
01:19 Cairo — so it is the Anti Infective line's live import, and the two 17-July batches are Pedia
and CNS and replace nothing here):

| Lookup key | Territory | Rows | Sales value (Jan–May 2026) |
| --- | --- | --- | --- |
| `V-AF-13` | Qal | 20 | 11,191.04 |
| `V-AF-11` | Fayoum | 20 | 7,159.20 |
| `V-AF-12` | Main Store | 20 | 5,636.38 |
| `V-AF-9` | Ismailia–Suez | 20 | 2,441.78 |
| `V-AF-14` | Luxor–Aswan | 20 | 0.00 |

All 100 rows carry `manager_hr_id = null` and `target_value = 0`. Both callers of
`linkSalesRecords` are import paths (`import-workflow.ts:191`, `service.ts:1248`) — **no read path
re-links stored rows** — so those rows keep a null manager for good and no stored number moved.

What makes it live going forward: production holds **43 open vacancies**. The next import whose
sheet carries a `V-*` code in a territory with an open vacancy gets a manager from
`matchVacancyForSource`, and that row would have been dropped from its own manager's reads.

## The fix, and what must not be "simplified" back

`isSalesOthersBucket` refuses any row carrying a vacancy area code in **either** column, through the
same `isSalesVacancyAreaCode` (`src/lib/workforce-classification.ts`) that the sibling guard at
`employees.ts:526` already uses. No import cycle: `workforce-classification.ts` imports only
`@/lib/hr-id`, and `others.ts` imported nothing before this.

- The aggregate bucket is unchanged — a genuine line total carries no area code, and
  `tests/sales-others-bucket.test.ts` passes untouched.
- Do not chase this in `employees.ts`. Its vacancy branch was always correct.
- Pinned by `vacantAreaRowsStayOutOfTheOthersBucketOnRead` in `tests/sales-linkage.test.ts`, which
  asserts the **linked** record rather than the sheet row. Removing the guard makes it fire with
  *"a linked vacant area must not read as the line's Others bucket, however the sheet named it"*,
  while `sales others bucket` stays green — which is the proof the older pin could not catch this.
