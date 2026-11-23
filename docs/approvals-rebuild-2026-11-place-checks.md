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
only the Google check held when the photographed sign names the customer: after the door's reply,
once the sign is read (see "The pass to 9.5" below: as first built the door could never do this), and
hourly for the ones the door left (at most 25 a run). It never takes a clinic
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

**On a phone a waiting place is closed until it is pressed.** The first build of the rebuild paged the
lanes by ten and stopped there. Measured at 375 px in the preview of pull request 700 (23 Nov 2026) the
page was still 50,990 px long, the first Approve sat 2,432 px down and one polyclinic ran 14,000 px,
because every card drew its photographs, its evidence and its controls whole. A card now says who and
what in a few lines (`place-checks/phone-fold.tsx`), and a press opens the same evidence and the same
controls under it. Nothing is drawn a second way, so there is still one way to decide. A closed card's
photographs are not fetched. The desktop table is unchanged.

**The top of the page is shorter on a desktop.** Measured at 1440 px in the same preview, the first
waiting place sat 775 px down: the page title 75, the top line 107, the filters 50, the tabs 70, the
"Why these are your call" box 123, then the section head, the pick bar and the table head. Two of those
are trimmed. The reasons box is one line until it is pressed (the commonest reason and its count, then
"All N reasons"), and the sentence about the SFE Manager's recommendations sits beside the headline on a
wide screen instead of in a band of its own. The plan's figure of 400 px is not reached: the page title,
the filters and two rows of tabs alone end at 474 px, and those are the sibling pages' own look.

**The sign wins never approves a place with no photograph.** The Phoenix Camera rules of 20 to 23 Nov
2026 were read before the merge (eleven rules, all live, none of them on this page's code). The one that
binds this page is his "must have a photo except i tell u": a sign reading can only come off a
photograph today, and `signWinsVerdict` now says so in its own line (`hasPhoto`, read from the place),
so no later source of a sign reading can make the system approve a place nobody photographed. A
trusted-point place has no photograph and stays his alone. A place validated with his own upload or a
sealed Phoenix Camera photo raises no review, so the rule never meets one.

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

The three long files left over were split the same way afterwards (23 Nov 2026, after pull request
710): the server's reviews, the bulk bar and the system's advice.

| File | Was | Now | Its parts |
| --- | --- | --- | --- |
| The server's reviews (`server/validation-reviews.ts`) | 2,059 | 38 | 10 files under `server/validation-reviews/`: shared 188, types 300, location checks 251, notices 124, capture marks 110, queue 287, decisions 177, decided 218, place-in-use decisions 223, reopened 281 |
| The bulk bar (`place-check-bulk.tsx`) | 429 | 281 | picks 159 |
| The system's advice (`place-check-advice.ts`) | 430 | 304 | kinds 138 |

Every statement moved unchanged: 1,981 lines of the reviews, 388 of the bulk bar and 382 of the
advice, the rest being headers and imports. The only edits are an `export` on a name another part now
uses, and the imports each part needs. Each original path re-exports exactly the names it did (33, 9
and 15). The tests that pinned those files read them through
`tests/support/place-check-split-source.ts`, and the lanes test fails on a part that helper does not
name.

## The pass to 9.5 (owner, 23 Nov 2026, 14:40 Cairo: "Fix them")

The page was scored again on production after pull requests 700 and 707 were live. The module read
7.3 out of 10. He asked for every item under 9.5 that code can fix, in one pull request. What that
pull request changes, each with the figure that showed the fault:

- **The system approved nothing on its first day, because the door never read the sign.** This
  account said the rule ran "at the door once the sign is recorded". That path could not happen: the
  door reads no sign for a place Google already holds (`held_elsewhere`, `signboardCheckForSave`), so
  the only reader of such a place was the 03:35 pass. All 4 Google holds of 23 Nov carried
  `unjudged / held_elsewhere`, and the rule approved 0. After its reply the door now makes the
  night's own read of that one place (`readPlaceSignboardNow`: the night's query plus the place's id,
  the night's own body) and then asks the rule (`signWinsAfterGoogleHold`). It is the night's next
  read of that place made early, never one more (his word of 18 Oct 2026): a verdict takes the place
  out of the night's backlog, and an answer the night would have read again the night after (a lost
  call, a flag the second reading did not confirm, a fallback reader's "unreadable") is read again by
  the night, one try sooner, under the same count of tries. Known limit: nothing claims a place
  between this read and a pass already running, so a capture made during the few minutes of the 03:35
  pass could be read by both.
- **Reject is two presses.** With no reason chosen it was three: open the list, choose, Reject.
  Reject now opens the reasons as buttons and the one pressed is the rejection, sent with that
  reason. A reason the advice already chose still rejects in one press. The same on a waiting clinic,
  a building and a building's customer.
- **The first waiting place stands higher.** A lane's head was a title over a sentence (81 px) with a
  38 px line above it. The title, that line and the Pick rows slot now stand in one row, and the
  page's title band is drawn around the board's top line, so the waiting number is beside the title.
  Set on the live page's own elements with nothing pressed: 546 px to 376 px at 1440 by 900, and
  637 px to 326 px on his 2,390 px screen, where Approve went from 918 px to 525 px. The plan's
  400 px is reached in that measurement. The branch itself has not been opened in a browser.
- **A building's customers are rows of the building's table.** They were a table nested in the
  building's cell, each customer's photograph over his timetable: one polyclinic's row was 8,410 px
  tall at 1440 (9,956 px on his screen). Each customer is now a row under the building's row, his
  photograph and his timetable side by side.
- **A list draws its table or its cards, not both.** Both were always in the page, one hidden by its
  width class: 5,937 KB of HTML, about 7,600 elements and 118 photographs for 16 waiting places and
  their buildings. The page guesses the layout from the request and the browser corrects it from its
  own width. Only the Super Admin's page is handed a guess; a district manager's page and every other
  screen draw both, as before.
- **The decisions of single clinics wait for the click.** Of the 991 decisions of the last 14 days,
  609 were single clinics', drawn only by History and Approved by the system; 382 were seated in a
  building. The page sends the 382-kind (recent, seated in a building on the board), the server
  counts the two tabs, and their rows come with the click.
- **The server reads more of its lists together.** The reopened customers, the held full names and
  the two passes that mark earlier captures each ran one after another; each pair now runs together.
  The seated customer's timetable thumbnail is fetched when it nears the screen.
- **The review says everything held.** "Waiting for you" leaves out the held photographs nobody can
  read, which stand in Not readable by his word of 19 Oct 2026. The review's header now says the
  whole number and how many stand there, and the end of the first tab points at the second. On a
  phone only a place still waiting pins its decision bar.

**Corrections to the re-score itself.** The search box, the rep and the decider are kept out of the
address by rule (`PLACE_CHECK_PRIVATE_FILTERS`: no person's name is written to it), so "What the page
remembers" was marked down for something it does on purpose. A filter kept in the address has still
not been checked on the live page. The review's Not readable tab is his own word, not a fault.

**What this pull request does not do, and why.**

- **No file is split.** `server/validation-reviews.ts` is 2,059 lines, read by path by 26 tests and
  imported by 20 files; `place-check-bulk.tsx` and `place-check-advice.ts` are 429 and 430. Moving
  them with no typecheck on this laptop risks a red required check for nothing he would see. Code
  health stays under 9.5 and is its own piece of work.
- **Two pending reviews of a retired place are not closed.** Rejecting a building retires its seats,
  but `phoenix_crm_decide_shared_place` never closes the reviews still pending on them (2 real rows:
  19 Nov 11:37 and 21 Nov 20:21 Cairo; one of them is the only real row over 72 hours). That is a
  database function change and its own piece of work.
- **Photo signing was already one batch.** One call per territory, 120 paths, a 30 ms window.
- **Not built:** streaming the page in parts, and narrowing the private-notes index.
- **Only time can lift:** the waiting time (median 143 hours), the advice agreeing with him over 30
  days, and the take-back share of the sign-wins rule.

## The first read (owner, 23 Nov 2026, 15:46 Cairo: "Fix speed next")

Scored again after the pass to 9.5 was live, the module read 8.0 out of 10. Three items held it
there: Speed 4.5, Phone 7.5 and the Reviewer 8.5. He asked for the three in one pull request.

**Speed: the page reads only what it sends.** On production the first waiting place was drawn 12.2 s
after the page was asked for. 9.75 s of that was two reads the page did not draw: every place in use
(7,124 that day, 13 MB as read, against 513 seated in a building) and every decision ever made
(2,377, against 997 in the last 14 days). The page made both only to count the figures on its tabs
and to keep the rows for a click.

- The page now reads the 14-day reviews, the buildings, the customers sent back and the places in
  use that are SEATED in a building (`loadValidatedPlaces(viewer, { seatedOnly: true })`; the filter
  is in the query, in `server/validation-reviews/decided.ts`). It reads notes and evidence for those
  rows and no others.
- Once the board is on screen it asks `PLACE_CHECKS_SUMMARY_ROUTE`
  (`/api/phoenix-crm/validation-reviews/summary`). That route runs the wide read
  (`server/place-checks-wide-read.ts`), answers the figures alone, and leaves the rows in
  `server/place-checks-handoff.ts`. The first click that needs the rows (`/everything`) takes them
  from there, so the wide lists are still read once.
- The figures are counted from the same rows the click is handed, by the board's own functions
  (`placeChecksSummary`), over the page's own split of the reviews. That split (waiting, decided,
  buildings, with what the SFE Manager recommended on taken off the Super Admin's board) moved into
  one pure function, `placeChecksBoardSets` (`src/lib/phoenix-crm/place-checks-board-sets.ts`), which
  the page and the wide read both call.
- Until the figures answer, a tab whose count needs them shows no count, and a Figures card shows the
  word "Counting" (`in-use-figures.tsx`), or "Not counted" when the read failed. Never 0, and never a
  number taken from the seated places alone.
- The click waits for the figures' read to end before it asks for the rows (`summarySettled` in
  `use-everything.ts`), so the two never run the wide read side by side.
- The handoff keeps the newer of two reads. The clock is read BEFORE the read starts
  (`startedAt`), and an entry that started later is never replaced by one that started earlier, so a
  read begun before his decision cannot be served after it.
- The click now answers every decision (the wide read does not know what the page chose to send);
  the board keeps the page's copy of a row in both (`mergeDecided`, `mergedNoteIndex`).
  `decidedLeftForTheClick` is gone with its only caller.
- Both routes check `approve`, then the company board's readers, before a row is read. A district
  manager's board is drawn whole by its own page and asks neither.

**Phone: the top is the title, the board's one line and the lane's name.** At 375 by 812 the first
card stood at 870 px, under the fold: the lane heads were 241 px and 221 px and the title band
309 px. On a phone the pick line now folds to one button, "Answer several together (N)"
(`foldedOnPhone` in `place-check-bulk.tsx`); the sentence under the title, a lane's first reason, the
plain lane sentence and the SFE sentence are drawn on a desktop only; the Ready lane keeps the half
that is a rule, "Nothing is approved until you press." The title band is its own small component,
`PlaceChecksTitle`, and its phone classes reach the title row alone: the band's second child is the
hairline rule, which a first draft would have padded to 8 px. A desktop is drawn as before.

**Reviewer: it opens on the press.** "Review one by one" waited for every place in use before it
opened at all: 3.1 s on production, for a first tab that needs none of them. It now opens at once on
Waiting for you (the rows the page sent) and Integrity cases (which reads for itself). Every other
tab, Not readable included, shows no count and says it is being read, and is listed when every place
in use is in (`deckTabNeedsEveryPlace`). What was held at opening keeps the same slides in the same
order when the rest arrives (`deckSourcesOpenedThenWhole`, `deckRankerOpenedThenWhole`, all three in
`src/lib/place-review-deck/opened-then-whole.ts`); the whole board is taken once. If the read fails the review says so, with Try again and a way back to Waiting
for you.

**What the two reviews of this pull request found.** Neither found a fault in access, in what a
manager receives, or in how a place is decided. What changed because of them:

- A figures re-read that failed after a decision was silent: the last numbers stayed on the tabs
  with no notice. The board now says they stand as they were before his last decision, with Try
  again (`summaryStale`).
- The phone's one button was 40 px tall beside a 44 px one; it is 44 px.
- A Figures card's line while counting was longer than the line that replaces it, so the card
  changed height when the number landed. It is now one short line.
- The two files this work had pushed over 400 lines are back under it: the three functions of the
  review's opening live in `src/lib/place-review-deck/opened-then-whole.ts`, and two of the review's
  whole-screen messages are drawn by `review-deck-frame.tsx`.

Left as it is, with the reason:

- **The wide read loads the notes for every place before it answers the figures.** Read on
  production from this laptop (23 Nov 2026): the notes for all 8,746 places took 0.84 s against
  0.71 s for 600, so answering the figures first would give back about 0.1 s. The evidence read
  beside it was not timed.
- **The filter lists are short for the first seconds.** Until the figures answer, Rep, Line and
  Decided by list what the page sent. Picking any filter asks for every row.
- **Rows kept for the click can be a decision old.** A click inside the 30 quiet seconds after a
  decision takes rows read before it; the saved marks hide the decided row and the next re-read
  corrects it. This was already so when the page kept the rows.
- **A re-read after a run of decisions is the whole wide read again**, as the page's own re-read
  was. The server's work is the same; it now runs behind the board and not in front of it.

**Not measured, and said plainly.** The branch was not opened in a browser: the spare laptop was not
answering, and this laptop had under 3 GB free. The page's new time to its first row, the phone
top's new heights and the review's opening are read on the live page after the merge, and the three
items are scored again from those readings. The whole suite did not run anywhere before the push
for the same reason; the pull request's `validate` and `checks` are the verdict.

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
- **The first waiting place was not inside 400 px until the pass to 9.5 (above).** The plan said 400 px on a 1440-wide page; the
  rebuild left it at 660 px. On the live page on 23 Nov 2026, on the Super Admin's own screen
  (2,390 px wide), it stood at 737 px: the shell 104, the title 77, the top line 77, the boxed Filters
  bar 62 and its 20 px gap, the tabs 44, "Why these are your call" 48, the section head 101, the
  "Pick rows to answer together" line 61 and the table head 39. The folded Filters line now ends the
  tab strip (`PlaceCheckFilterLine` with `inStrip`). That gives back 82 px where the line fits beside
  the last tabs (a 1,126 px column with no filter on) and 39 px where it takes a row of its own (his
  screen, and any filter on); it is never taller than the bar it replaced. Read by setting the same
  layout on the live page's own elements, nothing pressed. The branch itself was not opened in a
  browser: this laptop's free memory fell to 1,553 MB while the page compiled.
- **The "Pick rows" line stands in the section's title row** (owner, 23 Nov 2026: "Add Pick rows to
  707"). On a board with lanes each list's bar draws its first line into a slot in its section's title
  row (`BulkPickLineSlot`); with nothing ticked and nothing said by the last run the bar draws no box.
  Set on the live page's own elements, nothing pressed, against the 61 px box it replaces: his own
  screen (1,760 px column) 61 px given back with none, one or two quick picks (737 → 676 px); a
  1,126 px column 37 px, because the description takes one more line beside the buttons, and 9 px
  with two quick picks, which wrap under the title; 900 px 37 px with none, 9 px with one or two;
  700 px 9 px. Never a loss. A 576 or 672 px cap on the slot was measured and refused: 41 px on his
  screen and a 35 px LOSS at 900 px with one quick pick. The two files were then run as they stand in a
  browser on a test page (React 18.3.1, stand-in buttons and rows, so its pixels are not the page's):
  idle, both lines stood in their title rows and no box was drawn; a tick opened the box with the
  reason, the note and the buttons; Pick all pressed in the title row kept its focus; Clear closed the
  box; a run that saved one row and failed one drew the box again with both lines; a board with no
  lanes drew the bar whole and no slot; at 375 px nothing scrolled sideways. The branch inside the real
  app has still not been opened in a browser. Still standing above the first place: the section head
  (101 px on his screen) and the table head (39 px).
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
- The pass to 9.5: `tests/phoenix-crm-place-checks-on-demand.test.ts` (what the page sends and the two
  server counts), `tests/place-review-deck.test.ts` (the held split, the pinned bar),
  `tests/phoenix-crm-shared-place-groups.test.ts` (a building's rows), `tests/phoenix-crm-validation-feedback.test.ts`
  (Reject in two presses), and the lanes and sign-wins tests above (the lane head, the layout guess,
  one layout drawn, the sign read after the door). 14 of 14 fired when their fixes were broken.
- The first read: `tests/phoenix-crm-place-checks-first-read.test.ts` (what the page reads, the
  figures route's order, the handoff's newer read, the board's sets, no count before the figures,
  the phone top), `tests/place-review-deck.test.ts` (the review opening on what waits) and the
  on-demand test (the click waiting for the figures, every decision once). 23 of 23 fired when their
  fixes were broken.

## Migration

`20261123052511_place_check_system_advice` — four nullable columns on
`phoenix_crm_validation_reviews` and two on `phoenix_crm_shared_places`, three CHECK constraints and
one partial index. No backfill and no data change. Applied to staging and production on 23 Nov 2026
and read back from the catalogue on both.
