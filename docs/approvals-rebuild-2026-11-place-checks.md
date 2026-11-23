# The approvals rebuild, Part 2 — Place checks

*23 November 2026*

Place checks is the page where the Super Admin decides whether a customer's captured place is
validated. The owner had it audited on 23 November 2026 together with Expense Approvals, and then
ordered both rebuilt. This is the account of the Place checks half. Part 1, Expense Approvals, is the
account that arrives with its own pull request (699). The rules themselves live in
`.claude/rules/phoenix-crm-place-check-desk.md`; this file holds the evidence and the reasons.

## His words

- The audit, 23 Nov: "THEIR APPROVALS PAGE IS VERY TIME CONSUMING AND HARD", "DEEP AUDIT THE BOTH AND
  GIVE ME A VERY DETAILED HONEST SCORE PER ITEM THEN PER MODULE OUT OF 10".
- The order, 23 Nov about 02:30 Cairo, refusing a plan of fixes: "REBUILD FROM SCRATCH LESS THAN
  9.5/10 PER ITEM IS NOT ACCPETED".
- His choices for this page, asked as multiple choice the same night: "Approve the proven ones", then
  "Yes, the sign wins".
- Earlier words the rebuild keeps: "Approve it after all" and "Reject it after all" (14 Nov 2026) for
  taking a decision back; "Validate again" reaches the rep in the app, on Telegram and on the phone,
  never by email (8 Oct 2026).

## What the audit found (4.7 of 10)

Read on production on 23 Nov 2026, as the Super Admin, at 1440 px and 375 px.

| Item | Score | What was wrong |
| --- | --- | --- |
| The idea | 8 | Sound: no place is validated without a photo. |
| Trust in the evidence | 8 | Sound: the photo's own position leads. |
| Accuracy of the advice | 3 | The page said Reject, with the reason filled in, on evidence he mostly approved. |
| Automating the obvious | 3 | He approved every one of 117 places that only the Google check had held and whose sign named the customer. Each was a press that decided nothing. |
| The "waiting" number | 2 | Four figures on the page counted "waiting" four ways. |
| Presses to decide | 7 | One press on a row, but no way to clear the obvious rows together. |
| Waiting time | 5 | The slowest tenth waited 415 hours or more. |
| Speed | 4 | The page read every list before drawing the first row. |
| Desktop layout | 3 | The first waiting place sat about 1,700 px down the page. |
| Phone | 2 | The page was 51,062 px long. |
| The reviewer | 7 | Good, but a second way to decide. |
| A building's row | 3 | Building advice and customer advice sat side by side, unlabelled and sometimes opposite. |
| Wording | 4 | "Refuse", "Reject", "Not validated" and "Send back" named one action on four screens. |
| One page, several jobs | 3 | A scorecard, name checks and links stood above the decisions. |
| What the page remembers | 4 | A reload opened the first tab with every filter gone. |
| Rules against code | 5 | Notes and comments disagreed with what the code did. |
| Telling the rep | 7 | Sound. |
| Tests | 8 | Wide, but pinned to one 1,015-line file. |
| Code health | 4 | Six files over 500 lines; the board was 1,015. |

## What he agreed with, counted

The advice table is his own 2,353 decisions, read on production on 23 Nov 2026.

| What the system saw | What he did | What the advice says now |
| --- | --- | --- |
| A sign naming somebody else, held at the door | approved 135 of 182 | Check it yourself |
| A sign naming somebody else, held by Google | approved 46 of 49 | Check it yourself |
| No sign naming the customer | approved 21 of 34 | Check it yourself |
| A timetable without the customer's name | approved 10 of 16 | Check it yourself |
| A building whose sign names another place | approved 20 of 33 | Check it yourself |
| A photo with no sign in it at all | rejected 20 of 21 | Reject, opened on its reason |
| A building with no sign naming it | rejected 15 of 15 | Reject, opened on its reason |
| A photo that is not a timetable | rejected 57 of 68 | Reject, opened on its reason |
| A sign naming the customer, only Google held it | approved 117 of 117 | Approve, and confident |
| A timetable naming the customer | approved 116 of 143 | Approve, not confident |
| A building whose sign names it | approved 100 of 120 | Approve, not confident |

"Confident" means he agreed at least 19 times in 20. Only a confident Approve can be Ready.

## What was built

**The advice, re-tabled** (`src/lib/phoenix-crm/place-check-advice.ts`). Every advice carries its
kind (`code`) and whether the page may call it confident. Reject opens on a reason only where he
rejected almost every time.

**The advice is kept with the decision** (`place-check-stored-advice.ts`, `server/stored-advice.ts`,
migration `20261123052511`). A decision on a waiting review or a held building keeps what the system
had said. The page reads its own agreement over the last 30 days from those values. "Check it
yourself" is counted and never scored. A place the system approved by itself is not his agreement.

**The sign wins** (`sign-wins-rules.ts`, `server/sign-wins.ts`). The system approves a place that
only the Google check held when the photographed sign names the customer: at the door once the sign
is recorded, and hourly for the ones the door left (at most 25 a run). It never takes a clinic
customer short of a full name, a place with an open integrity case, a place the SFE Manager
recommended on, a customer seated in a building, a hold the sign or the timetable raised, a test
entry, or anything already decided. It approves through the same path the held-signboard re-read
uses, as the system. It only ever says yes. If he takes back more than 1 in 20 of what it approved in
30 days it stops by itself and the page says so; it starts again once those take-backs are older
than 30 days.

**Two lanes and one number** (`place-check-lanes.ts`). A waiting decision is Ready only when the
advice is Approve, that kind is confident, and Approve can be pressed. Everything else is Your call,
with the one reason it is his. A place or a building with an integrity case nobody has settled is
never Ready, whatever the advice says: one press on the lane never approves what the sign-wins rule
itself would leave. Once a kind has 20 of his decisions in the last 30 days, those
outrank the table. A building is one decision however many customers wait behind it, and it is
Ready only if everything open in it is. The header, the lanes, the review button and Needs You read
the same count.

**One press for Ready.** It answers each building, then its waiting customers, then the single
clinics, through the two routes a row's own Approve already posts to.

**The page opens on the decisions** (`src/components/phoenix-crm/validation-reviews-board.tsx`, a
190-line frame, and `src/components/phoenix-crm/place-checks/`). The scorecard, what the system
approved by itself, the places in use, the buildings, the comparisons and the held full names are
tabs. On a phone the tabs are one dropdown and a lane shows ten at a time.

**The address remembers the view** (`place-check-address.ts`). The tab, the filters and how far a
list was opened are in the address, so a reload, the Back button and a shared link open the same
view. No person's name is written to it: the rep, the decider and the search box stay in the
browser's session store.

**One vocabulary.** Approve and Reject, and the same two verbs "after all" to take a decision back.
No place-check screen says Refuse; the stamp on a decided row reads "Rejected by".

**No long files.** The board and the five long list screens are split into parts of at most 400
lines each; each original path still exports what it did.

| Screen | Was | Now | Its parts |
| --- | --- | --- | --- |
| The board (`validation-reviews-board.tsx`) | 1,015 | 190 | 17 files under `place-checks/`, the longest 311 |
| The waiting queue (`validation-review-queue.tsx`) | 587 | 191 | evidence 170, decision 272 |
| Places in use (`validated-place-list.tsx`) | 615 | 233 | evidence 183, decision 242 |
| The buildings (`shared-place-list.tsx`) | 704 | 197 | evidence 237, decision 314 |
| A building's customers (`shared-place-customers.tsx`) | 533 | 99 | evidence 172, decision 306 |
| The one-by-one review (`review-deck.tsx`) | 840 | 355 | words 41, browser 31, lookup 60, slides 333, frame 143 |

The five list screens were split by moving lines, not rewriting them: every line of each original is
in its new files, counted against the commit before. One piece is not a verbatim move — the review's
top bar became a component of its own (`DeckHeader`), the same markup fed by the review. The tests
that pinned a rule by reading one of those files now read the list through
`tests/support/place-check-list-source.ts`, and a new part file the helper does not name fails the
lanes test.

## What is deliberately not there

- **No "New photo" button and no "Take back" button.** The plan named five verbs. A rejection with
  its reason already is the ask for a new photo: the rep validates again from his own list. And a
  decision is taken back with his own words of 14 Nov, "Approve after all" and "Reject after all",
  which say what the row becomes. A third and fourth name for the same two actions would have been
  the wording fault the audit found.
- **The "Validate again" notice is unchanged.** The plan said it would stop going to the phone. His
  word of 8 Oct 2026 is that it does reach the phone, and never email. The note that said otherwise
  was the stale one, and it is corrected.
- **No pass over what waited before.** The sign-wins rule takes only a place captured from 23 Nov
  2026 on (`SIGN_WINS_STARTED_AT`). On the day he chose it, none of the waiting places was in the
  group, so nothing was approved in bulk. An older backlog would be a bulk change to announce to him
  first. The start is that day's midnight, not the deploy instant: a place captured from then that
  still waits when the rule goes live is approved by the first hourly runs. That count is read on
  production and put to him before the merge (0 at 07:26 Cairo on 23 Nov 2026; the 8 Google holds
  then waiting were all older, and none of them had a sign naming the customer).

## What stays exactly as it was

The Super Admin alone decides everything the system does not. The SFE Manager recommends on his own
page and decides nothing here; his board has one waiting list and no lanes. A district manager's
board is read-only, names no decider, draws no advice and still opens with its scorecard. One review
row per place. No short-name customer is ever approved. Private notes never reach a manager. Test
entries are drawn nowhere. The nine fixed rejection reasons, a role and never a name, and the rep's
own photo. Photo rotation. The trusted point and "Validate with my photo".

## Earlier rulings this replaces

- 17 Oct 2026, "a report of six tabs with the scorecard heading it": the scorecard is a tab on the
  company board. It still heads a district manager's board.
- 17 Oct 2026, "the system's recommendation decides nothing": still true for everything except the
  sign-wins group he chose on 23 Nov.

## What the reviews found, and what changed

Two reviews read the pull request before any merge was asked for (23 Nov 2026).

- **The Ready lane ignored open integrity cases.** The system's own rule left such a place to him; the
  lane did not, so one press could have approved it. Fixed: it is his call, with the reason.
- **The Ready sentence said "19 times in 20" as a fixed figure.** It now says "at least".
- **An approval whose mark failed was invisible to the switch.** The mark is now written up to three
  times before it is logged as missing.
- **The start date is a midnight, not the deploy instant.** Kept, and said plainly above and in the
  rule, with the count read on production.
- **Left as it is:** if the work after a rep's reply is cut off before the rule is asked (the server
  stopping mid-request), the place waits with no notice sent to him. It is still on the page and in
  the Needs You count, and the hourly run meets it again. A held signboard has always had the same
  gap.

## Honest limits

- **Ready will be nearly empty at first.** A timetable naming the customer and a building whose sign
  names it say Approve but are not confident (116 of 143 and 100 of 120). Only a clinic's own sign
  match is, and most of those the system now approves itself. The 30-day count is what promotes a
  kind, and it can demote one too.
- **Three items only time can prove.** The advice agreeing with him, the take-back share of the
  sign-wins rule, and the waiting time. The page carries the meter for the first two; the third
  depends on the page being opened.
- **A table's own panel has no table.** The four panels use a titled card (`place-checks/section.tsx`)
  and each list inside owns its table and its phone cards. The lanes test proves the phone cards on
  each of those lists, because the table ratchet reads files with a table in them.

## Tests

- `tests/phoenix-crm-place-check-advice.test.ts` — the table above, kind by kind.
- `tests/phoenix-crm-sign-wins.test.ts` — every reason the rule leaves a place, and the switch.
- `tests/phoenix-crm-place-check-lanes.test.ts` — the lanes, the one number, the Ready press, the
  address, the four verbs, the phone cards, and that every file of the board is in the list the
  source pins read (`tests/support/place-check-board-source.ts`).
- Each new assertion was proven by breaking its fix: 21 of 21, 43 of 43 and 49 of 49 fired.

## Migration

`20261123052511_place_check_system_advice` — four nullable columns on
`phoenix_crm_validation_reviews` and two on `phoenix_crm_shared_places`, three CHECK constraints and
one partial index. No backfill and no data change. Applied to staging and production on 23 Nov 2026
and read back from the catalogue on both.
