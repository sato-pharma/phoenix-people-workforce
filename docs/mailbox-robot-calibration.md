# Calibrating and arming the Turbify revocation robot

The robot's engine, gates and two-phase logic shipped in #4325. This wiring (#<this PR>) connects it
to the daily mailbox-offboarding sweep so it can actually run. It stays inert until it is armed on
purpose. This is the order we arm it — the safe steps first, and each destructive step supervised.

## The three locks (why merging the wiring changed nothing)

1. **`PHOENIX_TURBIFY_ROBOT_ENABLED`** — unset or anything but `true`, and the robot reads not one
   row. This is the default. The sweep behaves exactly as it did before the wiring.
2. **Dry run is the default once enabled.** With the robot enabled it runs every gate against the
   real register and reports the *plan* — what it would reset, what it refused and why — touching
   nothing. A live run is opt-in: only `PHOENIX_TURBIFY_ROBOT_DRY_RUN=false` arms it.
3. **The console driver — RESET now calibrated (2026-09-25), DELETE still locked.** Two flags in
   `src/lib/mailbox-offboarding/robot/turbify-console.ts`: `TURBIFY_RESET_CALIBRATED` (now `true` —
   the reset flow was read from the live console) and `TURBIFY_DELETE_CALIBRATED` (still `false`).
   `createTurbifyConsoleDriver()` builds only when reset is calibrated and re-checks that no reset
   selector is still a placeholder; `deleteMailbox()` throws `TurbifyDeleteNotCalibratedError` until
   the delete flow is observed live. So a live run can reset, but any delete-due task fails loudly (a
   person looks) rather than guessing a permanent action. Dry run still touches nothing regardless.

## Environment variables (set in Railway `production`, never in the repo)

| Variable | Meaning | Set it to |
| --- | --- | --- |
| `PHOENIX_TURBIFY_ROBOT_ENABLED` | The kill switch | `true` to switch the robot on |
| `PHOENIX_TURBIFY_ROBOT_DRY_RUN` | Live vs. plan-only | leave unset (dry run) until we go live, then `false` |
| `PHOENIX_TURBIFY_ADMIN_USER` | The console login the robot uses | the admin username (owner sets it) |
| `PHOENIX_TURBIFY_ADMIN_PASSWORD` | Its password | the password (owner sets it) |

Two-step verification **must be off** on that login — Turbify only sends the code to a phone or
email, which a headless server cannot receive, so the driver stops loudly if it hits the challenge
page. (Decided 2026-09-24; it removes 2FA from the account that controls every mailbox.)

## Step 1 — dry run on production (safe now, no calibration needed)

Set `PHOENIX_TURBIFY_ROBOT_ENABLED=true` (leave dry-run unset) and trigger the sweep. The response's
`robot` block reports the plan over the real 13 overdue leavers: which it would reset, and any it
refuses (recycled address, reversed resignation, ambiguous holder). This proves the safety gates
against live data while touching nothing. Read it, then either leave it running in dry run or move to
step 2.

## Step 2 — calibrate the RESET flow ✅ done 2026-09-25 (with you)

Read from the live console via DevTools dumps while you were signed in (I never saw the credentials).
The row, when filtered to one mailbox, carries a **direct** reset button
`button[aria-label="Reset password"]` (bi-key icon) — no menu to open — and one click opens a
`div.modal-container` dialog headed **"One-time password"** naming the mailbox. That dialog, naming
the exact address, is the only success signal `resetPassword` trusts; anything else throws and the
sweep keeps alerting. The real selectors now live in `turbify-console.ts`:

| Purpose | Selector |
| --- | --- |
| Filter box | `input[placeholder="Search users..."]` |
| Reset (direct row button) | `button[aria-label="Reset password"]` |
| Success dialog | `div.modal-container` headed "One-time password", must name the mailbox |
| Close dialog | `button[aria-label="Close modal"]` |
| More actions (kebab — for DELETE later) | `button[aria-label="More actions"]` |

🔴 **A dry run does NOT prove these selectors.** Dry run uses the touch-nothing driver
(`createDryRunDriver`), so it exercises the register, gates and plan — never the browser. The reset
selectors are proven only on the **first live reset**, which is step 3, done on one mailbox and
watched.

## Step 3 — go live on RESET

Set `PHOENIX_TURBIFY_ROBOT_DRY_RUN=false`. Because a dry run cannot exercise the browser, the first
live sweep **is** the proof of the selectors — so watch it. It resets up to five overdue leavers per
run (`ROBOT_DEFAULT_MAX_PER_RUN`), and records each reset only after the "One-time password" dialog
named that mailbox; confirm the register moved those rows to `in_progress` and the mailboxes can no
longer log in. Reset is reversible; deletion is not, and cannot happen yet — the delete flow is still
uncalibrated, and a reset mailbox is not eligible to delete until 30 days after the robot reset it.
The 13 overdue clear over three runs.

## Step 4 — calibrate DELETE (about 30 days later, first supervised deletion)

The delete-confirmation behaviour was deliberately never guessed — the console executes destructive
actions with no "are you sure", and a delete is permanent with no backup. When the first
robot-reset mailbox reaches its 30-day grace, we calibrate the delete flow on that first supervised
deletion: run `phxDump("delete-confirm")` at the confirmation step and confirm the address is gone
from the list afterward. I then write the `deleteMailbox` implementation and its selectors.

**The calibration flags are split (done 2026-09-25).** `TURBIFY_RESET_CALIBRATED` (now `true`) and
`TURBIFY_DELETE_CALIBRATED` (still `false`) replace the single `TURBIFY_SELECTORS_CALIBRATED` boolean,
which is kept as a back-compat alias of the reset flag. Reset can go live in step 3 while delete stays
locked until step 4 — the two-phase reality the robot already models. `deleteMailbox()` throws
`TurbifyDeleteNotCalibratedError` until step 4 writes its selectors and flips the delete flag.

## The console's search is a SUBSTRING match, and a row count cannot see that

Measured on production, 2026-10-03, while finding out why the joiner robot created nothing.

Both drivers protected every row action with the same rule: filter the list to the address, then
refuse unless **exactly one row** remains. The rule is right; counting is not how to check it.

The console's search box matches **substrings of the whole address**. So a search for
`el.sayed@satopharma.com` returns the row for **`adel.sayed@satopharma.com`** — a different
employee, whose address literally contains the one asked about (`ad` + `el.sayed@satopharma.com`).
That is exactly **one** row, it is **Active**, and it carries its own `Reset password` button.

Three separate protections all passed it:

| Protection | What it asked | Why it passed |
| --- | --- | --- |
| `readExistence(rows, address)` | how many rows? | one row ⇒ "the mailbox exists" |
| `rowCountRefusal(count, address)` | how many rows? | one row ⇒ "safe to click" |
| the revocation driver's dialog check | `text.includes(addr)` | `adel.sayed@…` **contains** `el.sayed@…` |

The consequences differed by flow, and the harmless-looking one is the one that was observed:

- **The joiner** refused to create `el.sayed@satopharma.com` for ever, reporting "Phoenix's record
  disagreed with the console — reconcile before re-running" while **Phoenix's record was right**.
- **Adoption and the leaver reset** would have clicked `Reset password` on **`adel.sayed`** — a
  working employee locked out of their mail — and the dialog check would then have recorded it as the
  correct reset, because the same substring relation satisfies `includes` in both places. The
  revocation driver's own comment already named "an address that is a prefix of another" as the
  danger; a count simply cannot detect it.

The fix is to compare **identity**, in both places: `readExistenceFromRows` and `rowIdentityRefusal`
take the rows themselves and require one row whose **own address cell** equals the target, and
`dialogNamesAddress` compares whole tokens rather than running `includes` over the dialog's text.
`rowCountRefusal` and `readExistence` were deleted rather than left beside them — a caller reaching
for either would be reintroducing the defect.

## `Active mailboxes` excludes a PENDING mailbox, so "nothing was created" was wrong

The same investigation, same day, and this one had already produced real state on the live domain.

Turbify's **create** does not behave like its **reset**. A reset opens the `One-time password`
dialog; a create makes the mailbox **`Pending`** and hands the password over through an
**invitation**. The joiner was written expecting the dialog, so it submitted the form, found no
dialog, threw, and reported `provisioned: 0`.

The mailboxes were nevertheless there. `ahmed.mohamed@satopharma.com` and
`asmaa.zaghloul@satopharma.com` both existed, `Pending`, with the display names Phoenix holds and the
actions `Resend invitation` / `Delete`.

Every check that said otherwise was blind in the same way:

- the console shows **three** counters — `Total mailboxes 500`, `Active mailboxes 288`,
  `Available mailboxes 209` — and a `Pending` mailbox is in **none** of the first two. `288` did not
  move across any attempt, which read as proof that nothing had been created.
- a `Pending` row carries **no `Reset password` button**, so counting those buttons reports it absent.
- reading the address out of the row's **concatenated text** fails too: the display name runs
  straight into it, so `Ahmed Mohamed Abd-Elnaim` + `ahmed.mohamed@satopharma.com` parses as
  `Abd-Elnaimahmed.mohamed@satopharma.com`, an address belonging to nobody. The address must come
  from its **own cell**.

What the submit actually does, measured with request interception aborting every non-GET so nothing
could be created: clicking `Save` fires
`PUT https://platform-api.turbify.com/api/bm/accounts/create?domainId=…` with
`{"vanity_name":…,"acct_user_role":"member","acct_type":"web","display_name":…}`. The click is
genuinely delivered (`document.elementFromPoint` reports the button topmost at 1400×900), the form
reports `checkValidity() === true`, and the page carries exactly one `button[type="submit"]`, reading
`Save`. The optional `Send invite to` field is **not in the payload at all**, so leaving it empty is
not what stops the flow.

So `createMailbox` now says what it left behind — `describeCreateWithoutPassword` re-reads the row
and states whether the mailbox **WAS CREATED** and in what state — and reports the controls the
post-save view offered, through `buildControlReport`'s redaction. The dialog's own blurb points at
where the rest of the flow lives: "use Add more mailbox (+) next to **send invite and print** to open
the form again". **Print** is the candidate for handing the password over with no email involved, and
it is the next thing to calibrate.

### A probe that drives this console must pass real functions to `page.evaluate`

Two instrumentation bugs in one session, both of which produced confident wrong readings:

- A probe reported the console's button as `Email u er` and its counter as `Active mailboxe 288`,
  which looked like a font or ligature problem on Turbify's page. It was not: the probe's in-page
  code was a **string** written in a shell heredoc, so `\\s+` arrived as `/s+/g` and replaced every
  literal `s` with a space. Only the fields that went through that replace lost one; `Add alias` and
  `Search users...`, read from attributes, kept theirs. The page's real bytes are
  `69,109,97,105,108,32,117,115,101,114` — `Email user`.
- The same escaping chain earlier turned a production fix into a no-op: in-page code passed as a
  string to `page.evaluate(expr, handle)` never binds the handle, so every click became a no-op that
  reported success.

A real function has neither layer. `readMailboxRowCells`, `readHitTest`, `clickNode` and `clearField`
are therefore real exported functions, unit-tested against fake elements, and passed to
`$$eval`/`evaluate` directly.

## The address is typed, never derived

Owner's instruction, 2026-10-03: *"I will enter the email of the hired in the employee master in his
record, you take what I enter and make his email with it"*, and then *"make the @satopharma.com in the
emp master data entry greyed out by default and I only enter ex elsayed.ramdan"*.

What it replaced: `src/lib/new-hire-mailbox/address.ts` generated the address from the name —
`first.second`, then `first.third`, then `first.last`, nickname before full name, measured against the
house shape (of 173 company mailboxes on 2026-09-18, 107 were `first.second`). It was a reasonable
shape and it is the wrong mechanism, because the robot creates what it is handed on a **live mail
domain**:

- `"El Sayed Rady"` → `el.sayed@satopharma.com`. His first name is **Elsayed**, one word. The
  generator split it and the register carried the wrong address from the moment the hire was saved.
- The robot then created that mailbox for real, and the only way back was a deletion in the console.
- The register row said `source: manual_add`, which reads as "a human typed this". Nobody had.

What it is now, in three places that have to agree:

| Place | Behaviour |
| --- | --- |
| Employee Master form | the local part is typed against a fixed, greyed `@satopharma.com`; a pasted full address has its domain dropped rather than doubled |
| `openNewHireMailboxTasks` | stores the typed company address, or **null** — `isCompanyAddress(typed) && !taken.has(typed) ? typed : null` |
| `loadJoinerCandidates` | a task with no address is **skipped**, so the robot waits one sweep instead of inventing one |

`mailboxAddressCandidates` and `proposeMailboxAddress` are deleted, not deprecated, and
`tests/new-hire-mailbox.test.ts` asserts both names are absent from the module — a generator
reintroduced "as a suggestion the person can edit" is exactly the shape the old one had.

🔴 **The guard assertion is scoped to the candidate loop on purpose.** An unrelated
`if (!address) continue;` already guards the holder map higher in `sweep-deps.ts`, so an unscoped
source match passed with the real guard deleted. Break-and-watch caught it; that is the only reason
the assertion slices the loop out by hand.

## The invitation carries the password, and that is the whole provisioning flow

Measured on production 2026-10-03, from the real message after the robot created
`hr.mailbox@satopharma.com`.

Turbify's **create** hands back nothing. It makes the mailbox `Pending` and emails the credential:

```
Subject: An administrator for [satopharma.com] has invited you to activate
         [hr.mailbox@satopharma.com]
From:    Turbify <no-reply@turbify.com>

  Username: hr.mailbox@satopharma.com
  Temp Password: <15 characters>
  Activate your account <https://mail.turbify.com/login?>
```

So the `One-time password` dialog the robot waited for was never coming on the create path — it
belongs only to a RESET. Three real mailboxes were created and stranded `Pending` while the sweep
reported `provisioned: 0`, and `TURBIFY_INVITE_RECIPIENT` was `""`, so the email that carried their
only credential went nowhere at all.

### What the reader refuses, and why each refusal exists

| Refusal | The failure it prevents |
| --- | --- |
| the message is not from `no-reply@turbify.com` | anything else claiming to be an invitation |
| the invitation activates a different mailbox | **one invite inbox receives every hire's invitation**, and `adel.sayed@satopharma.com` contains `el.sayed@satopharma.com` — matched loosely, the robot would set a password it then recorded against the wrong person |
| the invitation names more than one mailbox | no way to tell which one its temp password opens |
| no `Temp Password:` line | Turbify reworded it; refuse and re-calibrate rather than guess at another label |
| the inbox could not be read | an unreadable inbox is not an empty one |

Two traps the body itself sets. Its help section prints `*Password:* {The password you create during
the activation...}`, so a reader that accepted the plain `Password:` label returns `{The` as the
credential. And the subject carries `[satopharma.com]` in its own brackets — a **domain**, not a
mailbox — so the address parse has to reject it.

**No refusal may quote the credential.** These strings reach the production log and the sweep's own
report, where a temp password would outlive the mailbox. A test asserts it for every refusal path.

### Why the recipient is a constant, not an env var

`railway variables --set` triggers a redeploy that **bypasses the CI deploy gate** (AGENTS.md §2.3),
and the address this points at decides where every new hire's credential is delivered. That belongs
in a reviewed diff. It is `hr.mailbox@satopharma.com` — a mailbox Phoenix owns and reads, never an
employee and never the owner's personal address, so no person receives a new hire's credential.

### Still to calibrate

The activation page at `mail.turbify.com/login` is **unmeasured**: signing in with a temp password and
being asked to choose a password is a flow no session has read off the live page yet. It is
deliberately not written blind — a guessed selector produces a driver that clicks nothing and reports
a clean run, which is how three flows in this module already shipped doing nothing. The next real
invitation lands in `hr.mailbox@`, and that is the one to read it from.

## Adopting the invite inbox, and why the monitor is the proof

The invitation reader needs an inbox it can open. `hr.mailbox@satopharma.com` is `Active`, but
nothing stored a credential for it — and `/app/node_modules` in the production image holds 36 entries
with no `imap*`, because the image keeps only what Next bundles, so no throwaway script can test an
IMAP login either. It has to go through the app.

`addMonitor` is the seam, and it already fits: its `employeeHrId` is **optional**, so a mailbox
belonging to no employee is a shape it supports, and it runs `testMailboxConnection` and refuses to
store a credential that cannot open the mailbox. So "adopted" means an IMAP login really succeeded —
not that a password was typed somewhere and assumed to work. In a module where three flows have
already shipped reporting success over a step that did nothing, that distinction is the feature.

### The one safety property

The chain is `resetAndCapture` → `setMailboxPassword` → `generateAppPassword` → `addMonitor`, and the
first step is a password **reset**. The same chain pointed at an employee's address locks that person
out of their mail with nobody told — the state `adopt-runner.ts` reports as `locked_out`.

So the address is **not a parameter the caller chooses**. `evaluateInviteInboxAdoption` compares it
against `TURBIFY_INVITE_RECIPIENT` by identity and refuses everything else, the route passes the
constant rather than anything from the request body, and the card has no address field at all. There
is deliberately no `force`, `override` or `allowAnyAddress` — a flow that can reset ANY mailbox is a
far more dangerous feature than this one, and it would arrive by someone adding exactly that
parameter.

A missing company password is refused **before** the reset rather than discovered after it, because a
reset with no password set afterwards leaves the mailbox unreachable. A company password the robot
could not *read* is treated as absent, never as empty-but-fine.

### Not on a schedule

Like adoption, the only caller is a Super-Admin route. The invite inbox is adopted once; a sweep that
re-ran it would reset the inbox the robot is mid-way through reading and rotate a credential the
monitor had just proved. The test fails if anything scheduled so much as names the runner.

### A test that asserted on prose

The first version of the no-escape-hatch check searched the whole module for the words `force` and
`override` — and the module's own comment explaining that there are none made it fail. It now strips
comment lines and matches `force\s*[?:=]` against code only. Worth remembering as the mirror of the
usual failure: an assertion can be fooled by a comment in either direction.

## `textContent` glued the address to the next label, and the owner was told it was somebody else's

The adoption's first real run stopped with a sentence that was wrong twice over:

> `hr.mailbox@satopharma.com` **was not reset**: The "One-time password" dialog is open but does not
> name `hr.mailbox@satopharma.com`, so it belongs to a different mailbox.

The dialog named it. The mailbox had been reset. Both halves were defects in the reporting, not in
Turbify.

### Half one — the glue

Read off the live dialog in the production container on 2026-10-03, with every credential-shaped
token masked:

```
headings                : ["One-time password","How do you want to inform the user?"]
tokens containing '@'   : ["hr.mailbox@satopharma.comone-time"]
FULL ADDRESS as a token : false
LOCAL PART as a token   : false

…Email account:hr.mailbox@satopharma.comOne-time password: ••••••••••••••• Login at:https://mail.turbify.com/login…
```

`textContent` runs the address straight into the *following label* with no separator. The only
`@`-bearing token was `hr.mailbox@satopharma.comone-time`, so neither the address nor its local part
survived tokenisation, and `dialogNamesAddress` refused — correctly, on mush.

**This is the same concatenation that made a console row parse as
`Abd-Elnaimahmed.mohamed@satopharma.com`,** met a second time in a different element after being
fixed for rows. The lesson that did not generalise the first time: in this console, an element's
concatenated text is never a list of fields. Read from the element's **own** text, or put the
boundary back.

The fix puts it back, at a lowercase→uppercase transition. That is where the glue always falls here,
because what follows an address is the next label's capitalised first word. The property that makes
it safe is that **inserting a boundary can only ever SPLIT a token** — it can never join two, so it
cannot turn a near miss into a match, and the substring trap above stays shut:
`adel.sayed@satopharma.comOne-time` yields `adel.sayed@satopharma.com`, which still does not equal
`el.sayed@satopharma.com`. Both directions are pinned in
`tests/new-hire-mailbox-robot.test.ts`, with the real dialog as the fixture.

### Half two — "was not reset" was the opposite of the truth

`invite-inbox-runner.ts` armed its `reset` flag *after* `resetAndCapture` returned. But the reset is
**clicked inside** that step, before the dialog is read. So a failure while reading the dialog — a
failure that only exists *because* Turbify had already reset the mailbox — reported the mailbox as
untouched.

That is the worse of the two bugs. The owner read "was not reset", went looking for the wrong
problem, and was not told that a one-time password was outstanding on a mailbox Phoenix needs to
read. The flag is armed before the call now and named `mayBeReset`: it can only ever **overstate**
the damage, which is the right way round for a mailbox Phoenix owns — nobody is locked out either
way, and the next run has to know a password may be hanging. A test asserts that a failure in the
reset step can never report the mailbox as untouched.

### What this left behind

`hr.mailbox@satopharma.com` holds an **uncaptured one-time password** — three resets, the owner's
click and two measurements, each invalidating the last. Nothing has to be unwound: the adoption
resets *and* captures in one pass, so whatever is outstanding stops mattering the moment it runs
successfully.

### The same copy, on the path nobody had run

`src/lib/mailbox-offboarding/robot/turbify-console.ts` carried its **own** copy of the tokenisation,
written for the same reason and with the same shape — and therefore with the same defect: it
lowercased the dialog's text before splitting, so the glue was unbreakable there too. The leaver
reset would have clicked Reset, then refused its own confirmation with "the dialog naming
`<address>` never appeared", on the first live leaver. Nobody had run one yet, so nothing had
revealed it.

It calls `dialogNamesAddress` now — the in-page function only waits for the heading, and WHICH
mailbox the dialog names is decided in node, where the shared resolver can be reached — and
`tests/mailbox-offboarding-robot.test.ts` refuses a re-implementation outright. The in-page reader
is a real function rather than a string, and `ConsolePage.evaluate` is typed to accept nothing else.

Two copies of one judgement is how a fix lands on one path and silently leaves the other broken.

## Two Turbify login pages, and the 45 seconds the adoption spent on the wrong one

The owner pressed **Reset it and take the app password** and the card span. Twice — 14:58 and 15:13
Cairo on 2026-10-03 — and both runs landed in `app_error_events` as:

```
TimeoutError: Waiting for selector `input[type="email"]` failed
  at async Object.setMailboxPassword (/app/.next/server/chunks/src_lib_0rwhnfi._.js:13:3358)
```

The frame is what makes this readable: **`setMailboxPassword`**, not the console sign-in. So the
chain had already got past the hard part — the mailbox WAS reset and the one-time password WAS read
out of the dialog, which is the fix that shipped hours earlier working. It then died on the next
step, and threw the captured password away with the error.

### What the pages actually are

Measured in the production container, both pages read in one run:

```
A) FRESH login page  emailInputs=1 pwInputs=1  title=Turbify Login Page
B) after admin sign-in, url=https://ecp.turbify.com/satopharma.com
C) MAILBOX login on the SAME page
   url          : https://mail.turbify.com/login
   title        : Bizmail Login
   emailInputs  : 0   <-- the selector signInAs waits 45s for
   pwInputs     : 1
   inputs       : ["text name=email visible","password name=password visible","checkbox visible"]
   form action  : (none)   submits in form: ["button type=submit text=Login to Business Mail visible"]
```

`MAILBOX_LOGIN_URL` is a `login.turbify.com` URL whose `.done` points at mail — and Turbify
**redirects it to `https://mail.turbify.com/login`**, a different page with a different form. Its
email field is `input#email[name="email"][type="text"]`. There is no `input[type="email"]` on it at
all, so the wait could only ever time out.

`MAILBOX_EMAIL_FIELD` is the union of both shapes. The union is safe in the strong sense: neither
page carries the other's field, so it cannot select the wrong input on either one. The submit
control is `button[type="submit"]` on both, which is why only the one line was wrong.

🔴 **A first hypothesis was wrong and worth recording.** The obvious read was that the driver reuses
ONE page, already signed in as the administrator, so Turbify saw a live session and skipped the
form. Reading `B)` and `C)` in the same run killed that: the page genuinely navigated to a login
form, it was simply a form with different markup. The probe was built to measure both pages rather
than to confirm the guess, which is the only reason the real cause surfaced in one pass.

### The second defect in the same four lines

The sign-in proof read `!page.url().includes("login.turbify.com")`. The page this sign-in lands on
is `mail.turbify.com/login` — which does **not** contain that string. So a **refused** login, still
sitting on the form, satisfied the proof and the robot carried on as though signed in. A wrong
one-time password would have been reported as a successful sign-in and failed later somewhere
innocent-looking, which is the shape of defect this module keeps producing.

`LOGIN_PAGE_URL` replaces it: a proof asks whether we left the form, never which host we are on.
Both pages end in `/login`; everything past one does not.

### Cost

Three outstanding one-time passwords on `hr.mailbox@satopharma.com` by the end of it — the earlier
measurements, and one per spun click. None of it is damage: the mailbox belongs to Phoenix, nobody
reads it, and the adoption resets *and* captures in one pass, so a run that gets through makes every
earlier password irrelevant. The real cost was the owner's time, twice, on a card that gave him no
error until the request finally returned.

### And no URL could answer the question either — the correction to the correction

The selector fix got the sign-in working, and the owner's third click then stopped on:

> Signed in as hr.mailbox@satopharma.com but the expected page never appeared, so the robot stopped
> rather than act on an unknown page.

That is the proof I had just rewritten, failing on a success. Measured with a one-time password
captured in the same run:

```
4) LANDING PAGE after a GOOD one-time password
   url        : https://mail.turbify.com/login
   title      : Bizmail Login
   headings   : ["Set up your mailbox password"]
   inputs     : ["password:password","password:confirmPassword","checkbox:-"]
   buttons    : ["Generate mailbox password","Cookie Settings","Accept All"]
   body       : … Set up your mailbox password You'll use this password to access your Business Mail
                account Create password Confirm Password By continuing, you agree that Turbify will
                create a profile …
```

**Turbify serves the forced password-setup page at the same URL and under the same title as the login
form it came from.** So:

- the original proof, `!url.includes("login.turbify.com")`, **accepted a refusal**;
- its replacement, `url` no longer matching `/login`, **rejected a success**.

Two opposite wrong answers from one mistake: asking the address bar a question only the form can
answer. The discriminator is right there in the measurement — **the setup page has no address field,
and a refused login still asks for one.** The proof is now `(await page.$$(MAILBOX_EMAIL_FIELD)).length === 0`.

The same reading caught the step after it before it could cost a fourth click:
`CHANGE_PASSWORD_WORDINGS` held `["Change password", "Update password", "Save password", "Save"]` —
four guesses, and the live button reads **"Generate mailbox password"**. None of them matched, so
that step would have failed the instant the sign-in began working. The measured wording goes first;
the guesses stay behind it for the change-password screen inside an established mailbox, which is a
different page and still unread. Despite its wording, that button submits the two fields the robot
has already filled.

**Still unmeasured, and the honest edge of this calibration:** the checkbox on that page (its label,
and whether the submit requires it), and where App Passwords live once the password is set —
`APP_PASSWORD_PAGE`'s three wordings are still guesses, and only `"Generate"` appears anywhere on
the setup page. The probe that would have walked those two steps was refused by the permission
classifier as a remote shell write, so they stay unknown rather than guessed. Nothing ticks that
checkbox: a consent control is never clicked on the owner's behalf.

## The fourth dead click, and the three things that were actually wrong

The sign-in was fixed, shipped, and failed again — this time with `Signed in as
hr.mailbox@satopharma.com but the expected page never appeared`. That is the fourth click this one
step has taken from the owner, and the reason it kept happening is worth more than the fix: **every
previous calibration was bought with a click that reported only which selector was missing.** One
click, one guess. The step was never asked what was actually on the screen.

So this round began in the owner's own Chrome, signed out, reading both login pages with no
credentials involved at all:

| | `login.turbify.com/login` | `mail.turbify.com/login` |
| --- | --- | --- |
| title | Turbify Login Page | Bizmail Login |
| heading | — | "Business Mail Login" |
| address box | `input[type="email"]` | `input#email[name="email"][type="text"]` |
| password box | `input[type="password"]`, **same page** | `input#password[name="password"]`, **same page** |
| checkbox | one, unnamed | one, unnamed — the button beside it is `aria-label="Keep me logged in."` |
| submit | **one**, "Log in to My Account" | **one**, "Login to Business Mail" |

Three things fell out of that table, and all three were wrong in the shipped code.

**One — both pages are ONE-STEP, and the "Next" branch was never real.** `signInAs` carried a
two-step path (type the address, press submit, wait for a password box). Neither page needs it. The
branch is kept because a change to that is survivable, but it is dead today, and it was noise in
every attempt to reason about what the step was doing.

**Two — the submit was the last control in the whole driver still delivered blind.**
`page.click('button[type="submit"]')`, no hit test, on pages that carry Turbify's fixed cookie
banner — the exact mechanism of incident one in `click-delivery.ts`, where a blind click landed on
the banner and reported success. And its failure shape is the cruel one: nothing throws, the form is
simply still sitting there afterwards, which every check downstream reads as *the credentials were
refused*. It goes through `submitOpenForm` now, like everything else, so it is resolved by
`type="submit"`, refused if there is more than one, sanity-checked against the measured wordings, and
delivered through the hit test.

**Three — `MAILBOX_LOGIN_URL` could not be calibrated at all, because it depended on a cookie.** It
pointed at `login.turbify.com/login?.done=mail.turbify.com`, and by the time `setMailboxPassword`
runs, the browser has been holding the **administrator's** session since step one. A Turbify login
url with a live session does not render a form — it forwards to `.done`. So which page the mailbox
sign-in landed on was a function of what the admin had done three steps earlier, which is not
something a selector can be pinned against. Two changes close it: the url is now
`https://mail.turbify.com/login` directly, and the mailbox signs in inside **its own browser
context** — its own cookie jar, its own blank page. That also removes a second hazard for free, since
`type()` appends and the admin's page had already been typed into.

### The proof was wrong three times, and all three were the same mistake

| Proof | Verdict | What it actually did |
| --- | --- | --- |
| `!url.includes("login.turbify.com")` | accepted a **refusal** | the page it lands on is `mail.turbify.com/login` |
| `url` no longer matching `/login` | rejected a **success** | the setup page is served at `/login` too |
| `$$(MAILBOX_EMAIL_FIELD).length === 0` | rejected a **success** | `$$` finds **hidden** inputs, and a form that never submitted still has its own |

Each one asked indirectly: *is the thing I don't want gone?* An absence has a dozen causes. The
proof is now positive and names what it found — the setup form's own `confirmPassword` field, or no
**visible** address box (`getClientRects().length > 0`). The setup form's confirm field has exactly
one cause.

### A refusal is now a measurement

The change that should outlive this fix: every refusal on this path prints the page it was looking
at — `describePage` gives the url (path only, so a one-time password cannot ride out in a query
string), the title, the headings, the inputs as `type:name` with hidden ones **marked**, and the
visible button wordings. It reads no field values.

It deliberately does **not** use `redactLabel`. That function also drops every space-free token of
twelve characters or more, which is the right rule for a control's name and exactly the wrong one
here: it would redact `https://mail.turbify.com/login`, `password:confirmPassword` and the mailbox
address — the three things the description exists to show. `withoutSecrets` removes the credentials
the run is holding by exact, case-insensitive match and guesses at nothing further, which is safe
because what is read cannot contain a credential by construction.

The three `APP_PASSWORD_PAGE` wordings are still guesses, and they are now the only uncalibrated
step left. Each of those refusals carries the page too, so the first click that reaches them settles
all three at once instead of buying one more guess. **And nothing ticks the setup page's checkbox** —
on the login form that shape turned out to be "Keep me logged in.", on the setup form its label has
still never been read, and a consent or terms box is the owner's click and never the robot's.

### And the step after it had a wording that does not exist

Reading Turbify's own documentation costs no credentials, and it should have been done before those
three locators were written. `APP_PASSWORD_PAGE.manageAccount` read **"Manage your account"**.
Turbify's documented path is **Account info → Manage App Passwords**, corroborated by two
independent write-ups of Business Mail on 2026-10-03. So the *first* of the three steps would have
missed, while `Manage App Passwords` — the second — was correct all along. That is the worst shape a
chain can fail in: one wrong wording in the middle of a right sequence, refusing with a message
about the wrong control.

The three steps are ordered candidate lists now (`APP_PASSWORD_WORDINGS`), documented wording first
and the old guesses kept behind rather than deleted, and they are pressed as **a link or a button** —
`Account info` is an `<a>`, and the list was restricted to `button`, so it would have missed every
candidate and still blamed the wording.

**A wording taken off a web page is not a measurement.** It is a better-ordered guess, and it is only
safe because each list fails closed and prints the page it was looking at. Nothing in Phoenix has
stood on that page yet.

One more thing came out of this: `clear-app-passwords.ts` stated that `APP_PASSWORD_PAGE` "proves the
page is reachable and that `Generate` works, because the joiner presses it in production." **It does
not and never did** — every run so far died at the mailbox sign-in, and the page's own first wording
was wrong. A future session reading that sentence would have armed the leaver side on the strength of
a step that has never run. It is corrected in place. The rule it leaves behind: **a downstream step
is not proven because the code that calls it shipped.**

### A third copy, in my own diff

Reviewing the change before pushing it turned up a hang I had just written. Both copies of the
secret-stripping loop did this:

```
let index = value.toLowerCase().indexOf(needle.toLowerCase());
while (index !== -1) {
  value = `${value.slice(0, index)}[redacted]${value.slice(index + needle.length)}`;
  index = value.toLowerCase().indexOf(needle.toLowerCase());   // from 0, every time
}
```

For any secret that is a substring of the marker it is replaced with — `"redact"` becomes
`"[redacted]"`, which contains `"redact"` — that loop never ends. The passwords actually in play
would not trigger it, but that is luck, not design, and **a redactor that hangs hangs the whole
provisioning run with no output at all** — the same silent shape that made four of today's clicks
unreadable. Both now resume at `index + marker.length`, and the new test cases are the ones that
would hang, so the regression surfaces as a timeout rather than an assertion. Watched it: with the
loop restored to searching from 0 the suite is killed by its timeout.

**That is the third second-copy in a single day** — the dialog tokenisation, the missing viewport,
and this loop. The rule it earns: in this module, when you fix something, grep for the pattern before
you commit. The other copy is always on the path nobody has run.
