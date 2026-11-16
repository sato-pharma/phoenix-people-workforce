# The same customer on another line — the list the Super Admin confirms

**Owner, 16 November 2026 (Cairo, about 23:00):** "Deep audit and find similar customers in different reps,
same area, different lines. Deep audit them and find them." Then "same customer diff rep same area diff
line". Asked as a choice after the audit, he picked **"Fix rule + review list"**:

> Make the same fix, and also put the 89 ready groups on a list for the Super Admin to confirm one by one.
> Nothing is validated without that confirmation.

The fix is the facility-kind guard in the three-lines rule (`docs/phoenix-crm-line-twins.md`, "Two
facilities of different kinds are never one"). The list is this page.

Rules: `src/lib/phoenix-crm/line-lookalikes.ts` (pure). Doors: `src/lib/phoenix-crm/server/line-lookalikes.ts`.
Route: `app/api/phoenix-crm/validation-reviews/line-lookalikes/route.ts`. Screen: the Place checks tab
**"Same customer, other line"** (`src/components/phoenix-crm/line-lookalike-board.tsx`). Database:
`supabase/migrations/20261116234831_phoenix_crm_line_lookalike_answers.sql`. Pinned by
`tests/phoenix-crm-line-lookalikes.test.ts`.

## Why a list, and not the rule

The three-lines rule (`areLineTwins`) validates a waiting row by itself only when the two names are **the same
name of three words or more**. The audit of 16 November found the same customer written another way on another
line of the same area — a word spelled differently (محمد / محمود is NOT that: a long vowel added or dropped
makes two men), the words in another order, a middle name left out, a two-word name, the same phone number, the
same old-CRM contact — validated on one line and still waiting on the other. Those are close enough to be
worth his look and not close enough to validate blind, so the system never validates them: each is one card,
and only his **Same customer** validates the waiting row.

## Who is listed — `planLineLookalikes`

A pair is one waiting row and one validated row when ALL of these hold:

- one world (real with real, test with test), **different seats on different lines**, one **area code**, one
  list (AM with AM, PM with PM — pharmacies are never compared: no line shares a pharmacy's validation);
- the validated row is active, validated in Phoenix CRM, with a place of its own (never a `line_twin` copy);
- the waiting row could be validated now (`waitingRefusal` — still waiting, no active place, no review or
  drop waiting, its full name not held; a PM customer written with all three names);
- **the rule does not already pair them** — a pair `areLineTwins` accepts is the rule's to share, never this
  list's;
- the Super Admin has not answered the pair **Not the same**;
- the match is **Certain** or **Very likely**. Anything looser never reaches the list.

### How sure

| Confidence | PM (a clinic) | AM (a hospital or an account) |
| --- | --- | --- |
| **Certain** | the same phone (last ten digits) or the same old-CRM contact, and the names agree or at least open with the same word | the same phone or old-CRM contact, and the names agree |
| **Very likely** | the same name spelled another way, more of the name on one list, one word spelled differently, the words reordered — or a middle name left out when the family name is rare (15 or fewer on the PM lists) | the same name spelled another way, a same two-word name, one word spelled differently, reordered, more of the name on one list — or the same one-word name when that word is rare (12 or fewer on the AM lists) |

- **A common given name never carries a match by itself** — a first word that 15 or more PM customers share.
- **Two specialities of different families** (neither GP nor unknown) lower a PM pair one step: a Very
  likely pair with a clash drops off the list, a Certain one shows as Very likely. Any pair whose two rows
  name specialities of different families carries the warning "specialities differ".
- **Two facilities of different kinds are never listed** (`sameFacilityKind`, the rule's own guard).
- A card also warns when the waiting rep's own list matches the validated row **more than once** (the
  same-seat duplicate merge comes first).

Certain pairs come first, then Very likely. The waiting row may appear on several cards (one per validated
row that looks like it); once one card validates it, the others leave the list.

## The answer — `answerLineLookalike`

Two buttons on each card, nothing else acts:

- **Same customer — validate it.** `planLookalikeConfirm` asks every guard again on a fresh read (the row is
  still waiting, the source still validated with a place, the rule still does not pair them, the pair was not
  answered Not the same), then validates the waiting row through the three-lines rule's own
  `phoenix_crm_share_line_validation`: up to five of the source's places (`pickSharePlaces` — best point first,
  never two within 150 m) are copied as `point_source = 'line_twin'` places, with no photo. **The Super Admin
  is the actor; the validation stays in the name of the line that validated the customer.** After the answer,
  through `afterResponse`: the "validate again" notice is withdrawn and the visits are re-measured, as for any
  other validation.
- **Not the same.** Kept, and the pair is never asked again.

Either answer is one row in `phoenix_crm_line_lookalike_answers` (the pair, the answer, who, when), upserted on
the pair — no foreign key on purpose (an answer about a customer merged away is inert). service_role only; the
rep never reads it.

A refusal names its reason in words (`LOOKALIKE_REFUSAL_TEXT`), never a code.

## Who sees it

**The Super Admin alone, never as a test persona** (`canReviewLineLookalikes`: Super Admin, approver, not a test
account). The tab is drawn on his Place checks board only, read the first time he opens it, and the route
refuses everyone else before a row is read (`read` for the list, `approve` plus the same-origin check for an
answer). The shared filter bar narrows the tab: a pair stays when either of its two rows passes.

## What the replay found

On the read-only pull of 16 November 2026: **115 pairs over 112 waiting rows** — AM 14 Certain and 48 Very
likely, PM 2 Certain and 51 Very likely; 10 pairs warn "on one rep's list twice" and 20 "specialities differ".
With the facility-kind guard, the rule itself merges none of the Kom Hamada account rows it used to.
