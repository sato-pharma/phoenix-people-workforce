# A district manager is credited by either id, on his own single visit or on a double

The account behind the module rule in `.claude/rules/payroll.md` ("A DISTRICT MANAGER'S CRM DAY IS
CREDITED BY EITHER ID"). The rule is the cue; this file is the evidence.

## What the owner reported, 2026-10-09

In his own words: *"the deductions is not reading dm did a single visits and came it deduction it
must read both dm single or double visit"*.

Asked which tab, he answered **both** — the CRM no-record tab and the Half Day (CRM) tab. Asked
whether a DM's own single visits should clear the whole day when they all sit in one half, he
answered **no**: a visit still fills only the half it is tagged to. So the halving rule is
unchanged; what was wrong was the **reading** of who was on a visit.

## The defect

The CRM mirror resolves the `*_hr_id` columns **asynchronously** and leaves them NULL for weeks,
while `*_crm_id` is on the row from the moment it is written. `half-day-rule.ts` records 2,050 such
rows since June 2026, 601 of them one rep's, and that is why its own `resolveSlot` falls back to the
crm id.

`connectors/dsm-no-record.ts` had no such fallback. It built its activity set from
`agent_hr_id`, `double_hr_id` and `double2_hr_id` alone:

```ts
for (const raw of [row.agent_hr_id, row.double_hr_id, row.double2_hr_id]) {
```

So inside the backfill window a manager who was in the field read as **absent** — and absent in this
category means a **full day** charged, with **no approval step**, because these rows publish
themselves unless somebody marks them "Do Not Take Action".

The Half Day (CRM) connector had a narrower version of the same gap: `buildHalfDayEvidence` resolves
slot 2, but `half-day.ts` fed only the `agent` and `double` pairs into the identity map, so a chain
visit's **second** manager could be found by his hr id alone.

## Measured on production, 2026-10-09

Of **52** flagged DSM no-record days, **three** are days the manager is now provably credited on as
a double partner:

| Manager | Day | Rows crediting him | On whose visits |
| --- | --- | --- | --- |
| Sameh Shabaan El Hoseiny El Hoseiny | 2026-07-06 | 7 | B-147 |
| Taha Mohamed Taha Elsayed AboElftouh | 2026-07-13 | 8 | B-52 |
| Yehya Mohamed Kamal eldeen Saad Mohamed | 2026-07-21 | 10 | B-112 |

Every one of those visit rows carries `synced_at = 2026-09-20 17:17 UTC` — **five weeks after** the
candidates were created on 2026-08-11. That is the hr id backfill arriving too late to matter.

The three candidates were all still **Pending**, unlocked, with no publication line, so no money had
been paid on them. What they hold between them: **10,677.42 EGP** over 11 flagged days
(Sameh 2 days / 1,741.94 · Taha 2 days / 1,935.48 · Yehya 7 days / 7,000.00), of which the three
days above are the provably wrong ones. Correcting them is a re-collect of July **after this change
is deployed**, which is the owner's own click on the Deductions page.

What the data also showed, and which ruled out every other explanation:

- A DM's own single visits **do** reach the feed — 1,580 agent-slot rows since 1 August.
- The engine **does** count them: the half-day evidence on Ahmed Mohamed Nagy's 5 August row reads
  `visitsTaggedPm: 9`, `creditedAsDoubleVisitPartner: 0` — nine of his own singles, no doubles.
- For the four live September no-record days there is no CRM row of any kind, in either source, in
  any slot, by hr id or crm id — those charges stand.
- No row today identifies a DM by crm id alone, and no DM has ever sat in slot 2. The September
  re-sync is what closed that window; the fallback is what stops the next one.

## The fix

`resolveSlot` is now exported from `half-day-rule.ts` and used by the no-record connector for all
three slots, so the two connectors cannot disagree about who was on a visit. The agent slot is the
manager's **own single visit**; the other two are the visits he is credited on as a partner.

An **ambiguous** crm id (two people claim it) credits **every** claimant's day rather than nobody's.
A day in this connector can only ever *remove* a charge, so on a contested identity not charging is
the safe direction to be wrong in.

## 🔴 The one thing this must not do

It must never pair a crm id to a person through **`employees.crm_id`**.
`tests/deductions-dsm-no-record.test.ts` has forbidden that since 2026-08-04, and the reason is
earned: on 3 reused CRM logins that column names a **resigned** person while the feed resolves the
current holder correctly (1391 Soad Atef vs Tayseer Khaled, 1399 Mohamed Yasser vs Nada Elsharkawy,
1536 Essam Youssef vs Mayar Tarek), so joining it attributes a working rep's day to a leaver.

The identity map is therefore built from the **feed's own rows**: a row carrying both ids teaches the
pairing, and the rows carrying only the crm id are resolved from it. The directory read does not
fetch `crm_id` at all.

That old assertion was a blanket ban on the substring `crm_id`, which the fix would have tripped on
`agent_crm_id`. It was narrowed to what it actually protects — no `employees.crm_id`, and no `crm_id`
in the directory `select` — and both halves were proven by breaking them.

## Proof

`tests/deductions-dm-visit-identity.test.ts`, registered in `tests/run-tests.ts`. Four assertions
were broken one at a time and each fired:

1. the agent slot reverted to hr-id-only → *"the agent_hr_id slot must carry agent_crm_id beside it"*;
2. `resolveSlot`'s crm fallback removed → *"a slot carrying ONLY the crm id must still credit the manager"* (`null !== 'b117'`);
3. the slot-2 pair dropped from the half-day identity map → *"its pairs must reach the identity map"*;
4. `crm_id` added back to the directory `select` → *"the employee directory read must not fetch crm_id"*.

Then every file was restored from a copy and `deductions-dm-visit-identity`,
`deductions-dsm-no-record` and `deductions-half-day` all passed again.
