# The incentive figure a person was shown

Audit REC-066 (findings F-PAY-007 and F-PAY-008), 14 November 2026.

## What it answers

The Incentive tab works out a person's semester incentive every time it opens. Until this change, the figure was kept nowhere. After a price fix or a restated closing, nobody could say what the person had actually seen last month.

The owner chose on 14 November 2026 to store the figure **when it is first shown**:

- the first time a person's own Incentive tab shows them a figure, it is stored with the inputs it came from;
- it is stored again only when the figure changes;
- he reads the history; nobody else does;
- nothing pays from it.

## What is stored

Table `public.incentive_shown_figures` holds one row per person and distinct figure. Each row has:

- the semester and the months it counted;
- the line and the sales scope;
- the semester achievement, sales and target;
- the basic;
- the payout in EGP;
- on a Pedia split, both halves, the Sato achievement and whether the Sato half was withheld;
- any notice the tab printed beside the figure, such as a semester not fully loaded;
- the running commit;
- when the figure was first and last shown.

A fingerprint of the figure and its inputs keys the row. The same figure shown again only moves `last_shown_at`, and the figure columns are never rewritten. A changed figure gets a new row, so a past figure always reads back unchanged.

The record is read off the tab's own payload (`shownIncentiveFigure`, `src/lib/incentives/shown-figures.ts`). Nothing recalculates it. The locked scheme (`scheme-2026.ts`) and the Pedia split are not touched.

No row is stored when the tab shows no figure:

- the profile is not linked;
- a manager's closing could not be read;
- there is no semester target yet ("No target yet").

## Who stores it, and who reads it

The figure is written from the person's own tab only: `/employee-portals/incentive` and the admin shell's `/workspace/incentive`. It is never written from:

- Employee 360, where a manager or the CEO is looking at someone else;
- a test account;
- the Super Admin's View as Seat;
- a preview session.

If a write fails, the failure is logged and the tab still loads.

The Super Admin reads the history under the Incentive card on Employee 360, newest first. No other viewer receives a row. The table is service-role only: row security is on, and neither browser role has a grant.

## A rep's figure and the closing (F-PAY-008)

This was checked on 14 November 2026. A rep's own incentive rows come from the closing engine (`loadAchievementRange`) and are filtered to published months, line by line (`portal-sales-canonical.ts`). A manager scored on a line or region reads the published closing for his whole reach. No change was needed. `tests/incentive-shown-figures.test.ts` pins both, together with everything above.
