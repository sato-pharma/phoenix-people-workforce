# The offer joining form — Submit is the acceptance

Owner rules, 2026-10-08. Module memory carries the one-line rule (`.claude/rules/recruitment.md`);
this is the account.

## The email

The offer email carries ONE button — "Accept the offer — complete your joining form" — and one line:
"If you wish to decline the offer, simply reply to this email." There is no decline button; declines
stay manual on the Offers screen. In the email only, the print-sign-and-return wording is replaced
by "To accept this offer, press the Accept button below."; the attached PDF keeps its signature page.

## The page

The button opens `/join/[token]`, a 100% Sato Pharma page with no login. The token is an HMAC on
`PHOENIX_AUTH_SECRET` (`src/lib/offers/accept-token.ts`), but the offer row is the authority:
`joiningFormState` opens the form only while the offer is `sent`, or `accepted` with no
`employee_hr_id`.

- The candidate READS name, HR ID, job, department, line, area, region, manager, hire date, contract
  type, Sato email and the six pay lines.
- The candidate TYPES only mobile, private email, national ID, gender, birth date, education and
  residence (area from the seat's own bricks, cascading to the governorate, then free-text address).

Opening the link changes nothing — a mail scanner follows every link. Only the POST
(`/api/public/offer-acceptance/[token]`, rate limited) creates the employee, through HR's own Add
Employee chain in its order (`src/lib/offers/joining-form-service.ts`): `upsertEmployee`,
`provisionNewHireAccess`, `openAndAnnounceCrmAccountSetup`, `openAndAnnounceNewHireMailboxes`.

## The seat

A Medical Representative or District Manager offer cannot be SENT without its AU organogram seat
(`offerRequiresSeat`); other titles may go out seatless. A record made without a seat is announced
to HR as "created WITHOUT a seat — set the department, line and manager on the Employee Master".

## Pay and payment mode are fixed by title

The owner, asked whether the letter's basic or the Employee Master's basic applies: *"the extra cost
of living and the fuel allowance is fixed per title. And the pay mode is also fixed by title."*

- The allowances come from payroll's own `resolveStandardSalaryAllowances`, fed into
  `deriveSalaryFromNet` with the offer's net (`offers.total_monthly`). The Employee Master's title
  table falls back to 1,500 for an unlisted title, which would have paid a District Manager over the
  agreed net (risk review, 2026-10-08).
- Payment mode (`joiningFormPaymentMode`): two parts for Medical Representatives and District
  Managers, Senior included; one part for every other title. Before this the record took Add
  Employee's "two parts" default. Production on 2026-10-08, among people still employed: Medical
  Representative 75 two parts / 1 one part, District Sales Manager 17 / 0, office titles almost all
  one part. The exceptions (Financial Advisor, HR Section Head) are existing records, left as they are.

## What blocks a submit

- A joiner already on the Employee Master: the national ID or mobile on any record, or the same name
  on a record created since the offer went out (Add Employee never stamps the offer, so the ID alone
  is not enough). A failed read blocks rather than passes.
- An offer with no readable start date: the page does not open and the submit is refused, and HR is
  told.

Pinned by `tests/offer-joining-form.test.ts`.
