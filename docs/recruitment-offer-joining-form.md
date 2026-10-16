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
- The candidate UPLOADS a photo of each side of the national ID card — both required (owner,
  2026-10-08: "make in the form also required to upload a photo of his national ID"). The browser
  shrinks each to 2,000px JPEG before sending, so every photo fits the proxy's 10 MB body; the server
  caps each at 3 MB (three at the cap still fit) and accepts JPG, PNG or WEBP (`validateJoiningIdPhotos`), judged with the answers
  BEFORE the claim. After the record exists they are filed into the Hiring Documents slot whose
  `hiring_document_definitions.joining_form_upload` is `national_id` (migration
  `20261008230000`, which marks the "National ID copy" slot once — never matched on the name
  afterwards), uploaded by the new hire, and the slot is ticked. A filing failure never fails the
  acceptance: the HR alert says the photos could NOT be filed and to ask for them.
- The candidate MAY upload a photo, labelled just "Photo" — never "personal photo" (owner,
  2026-10-08: "upload a photo for him"). His three rulings the same evening: it is OPTIONAL; it
  becomes the new record's Phoenix profile photo (`uploadEmployeePhoto`, `employees.photo_path`)
  AND is filed on Hiring Documents into the slot `joining_form_upload = 'photo'` marks (migration
  `20261009001000`, which marks "(6) personal photos" once); and that slot is NOT ticked
  (`markSubmitted: false` on `attachHiringDocumentFiles`), because it asks for six prints for the
  paper file and HR still collects them. Same type and size checks as the ID
  (`validateJoiningFacePhoto`), judged before the claim; either half failing after the record exists
  is logged and never fails the acceptance.
- English or Arabic (owner, 2026-10-08: "make him able to change language between English and
  Arabic"). A switch in the header bar turns the whole page into Arabic, right to left, in Cairo,
  remembered on that phone (an Arabic phone opens in Arabic). The words live in
  `src/components/offers/joining-form-copy.ts`; values (titles, areas, names, emails) are never
  translated. The Arabic never assumes the reader's gender — "يُرجى" plus a verbal noun, never a
  command form. Every message the check, the submit and the route send is English, translated by its
  exact text (`AR_MESSAGES`), and the test refuses a message with no Arabic.

Opening the link changes nothing — a mail scanner follows every link. Only the POST
(`/api/public/offer-acceptance/[token]`, rate limited) creates the employee, through HR's own Add
Employee chain in its order (`src/lib/offers/joining-form-service.ts`): `upsertEmployee`,
`provisionNewHireAccess`, `openAndAnnounceCrmAccountSetup`, `openAndAnnounceNewHireMailboxes`.

## Who is told when an offer is accepted

Owner, 2026-10-09: *"send the notification to SFE and HR and manager and manager of manager"*, his
example being "Omar Arwa (Sohag 1) accepted the offer. Hire date: 11-1-2026."

- HR (the `accepted_offer_alert` audience — Super Admin, HR Operations and, since 2026-10-16, the
  Talent Acquisition seat `HR Resourcing`, by default) keeps the fuller
  notice it always had — the record, the seat, the Sato email, what is left to do.
- A second, short notice (`announceAcceptedOfferToTeam`, event `offer_accepted_team`) goes to the
  **SFE Manager** (by role, so no policy row and no migration), the hire's **manager** and that
  manager's **manager**. Anyone already in the HR audience is left out, so nobody is told twice.
- The manager is the new record's `manager_hr_id` once the joining form made it; before that (HR marked
  the offer accepted by hand) it is the offer's seat, `position_vacancies.manager_hr_id`. A seatless
  offer has no manager to name, and only the SFE Manager is told. A departed manager is skipped.
- In-app, push and Telegram, never email. One per offer (`accepted-offer-team:<offer id>`), fired on
  whichever acceptance comes first. It also fires when the HR audience resolves to nobody.
- Pinned by `tests/accepted-offer-alert.test.ts`, section 6.

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
- An offer with no readable start date: the page says "Your start date is being confirmed" and the
  submit is refused, and HR is told.
- 🔴 **No offer is SENT without a start date** (owner, 2026-10-08). One went out without one that
  evening and its button could only say "Your position is being confirmed". The send refuses it
  (`OFFER_START_DATE_REQUIRED_MESSAGE`, `src/lib/offers/send.ts`) and the composer says why before
  saving. A sent offer cannot be edited, so one already out without a date is withdrawn and reissued.

Pinned by `tests/offer-joining-form.test.ts`.
