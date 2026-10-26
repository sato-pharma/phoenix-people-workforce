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
the form again". **Print was the candidate for handing the password over with no email involved, and
it turned out not to be needed** — the invitation already carries the credential, and reading it is
what closed this (see "Wiring the invitation reader into the create path" at the end of this file).

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

**One door generates since 2026-10-08: the offer joining form.** The owner ruled that a candidate
who accepts through the offer email's button gets his address made for him — *"generate it
automatically but if it couldn't, it tell it couldn't … and if couldn't the HR can address
manual"*. `joiningFormMailboxAddress` is deliberately not the old generator: it builds only two
plain Latin words neither of which is a particle (so "El Sayed Rady" is refused, not split),
tries `first.second` then `first.last` against every address in use or queued, and otherwise
returns a reason. The address reaches the register as the hire's `work_email`, so
`openNewHireMailboxTasks` stores it through the same typed-address line above; a refused name
opens the task with no address and the robot waits, exactly as for a hire HR left blank.

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

## The fifth click, and the thing that was wrong the whole time

The fifth adoption click was the first to come back with a page reading instead of a bare refusal,
and the reading settled it in one line:

```
Signed in as hr.mailbox@satopharma.com but the expected page never appeared.
The page it was on — url [redacted]; title "Bizmail Login";
headings [World-class Web hosting, built for speed. | Business Mail Login];
inputs [text:email, password:password, checkbox:-];
buttons [Get Started for $0.99/mo | Hide password | Keep me logged in.
         | Login to Business Mail | Cookie Settings | Accept All]
```

Still on the login form, with both fields present and visible. So the proof was honest, the submit
had been pressed, and **the credential itself was being refused.** Not the URL, not the click, not
the proof — all three of those fixes were real, and none of them was the thing stopping the run.

### The one-time password read returned the mailbox address

`readOneTimePassword` revealed the password and then took its value from the page like this:

```js
const text = document.body ? document.body.innerText : "";
const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
const candidates = lines.filter((l) => l.length >= 8 && l.length <= 64 && !/\s/.test(l) && /[^a-z]/.test(l));
candidates.sort((a, b) => b.length - a.length);
return candidates[0] || "";
```

Two faults, compounding:

| | What it did | Why it is fatal here |
| --- | --- | --- |
| scored by **length** | `candidates.sort((a, b) => b.length - a.length)` | `hr.mailbox@satopharma.com` is **25** characters; the generated password is about **10**. The address wins, always. |
| read **`document.body`** | not the `.modal-container` it already knew about | the account list behind the modal supplies a whole column of addresses, several of them longer still |

And the address is not incidental to the dialog — it is **mandatory**. `dialogNamesAddress` refuses a
dialog that does not name the mailbox, precisely so a reset cannot be read off somebody else's row.
The identity guard that makes the dialog safe is what guarantees the length heuristic picks the
wrong thing.

So the robot typed `hr.mailbox@satopharma.com` into the password box, Turbify refused it, and the
step reported *"the expected page never appeared"* — **a complaint about a page that was telling the
truth.** That is why three correct fixes in a row changed nothing: every one of them was downstream
of a credential that was never going to work.

**Proved, not inferred.** Restoring the length sort and the body read makes the new test fail with
the actual old return value:

```
AssertionError [ERR_ASSERTION]
+ 'hr.mailbox@satopharma.com'
- 'Xk9mPq2wTz'
```

### The same read sat in `generateAppPassword`, and would have failed next

Grepping `b.length - a.length` after the first fix found the second copy immediately — the step this
doc had been describing as "uncalibrated, and the first click that reaches it settles it". It took
the longest space-free line of 12 characters or more, **on a page signed in as the mailbox**, so the
address (25) beats an app password (about 16). It would have reported "no app password could be read",
or stored the address as Phoenix's stored credential.

🔴 **An app password must NOT inherit the dialog read's shape test.** Turbify's are commonly 16 plain
lowercase letters, and `/[^a-z]/.test(value)` — which correctly rejects lowercase prose in the
dialog — rejects every real app password. The two reads differ on purpose, and a paired test asserts
each one refuses what the other accepts, so neither can be "simplified" into the other.

### What replaced both

`pickOneTimePassword` and `pickAppPassword` in `src/lib/turbify/resolve.ts`, sharing one rule:

- **length is not a signal at all** — it is a filter (8 or 12 minimum, 64 maximum) and nothing more
- **the address cannot be returned by construction** — nothing containing `@`, and nothing equal to
  the address, its local part or its domain, survives
- the dialog's and the page's own labels are excluded by name
- the value after the last colon is considered as well as the whole line, because the console prints
  `One-time password: Xk9mPq2w` on one line in some renderings and two in others
- **two plausible candidates REFUSE**, reporting how many and how long they were and never what they
  said, because the only thing worse than stopping is returning a credential that is an address

They are **pure functions**, which is the point: the whole rule is pinned in the unit suite, so it is
settled once here instead of one of the owner's clicks at a time. Both breaks were watched firing.

### The lesson that outranks the fix

Four clicks bought four guesses because a refusal carried no measurement. The fifth carried one and
answered immediately. **A robot step that can fail must report the page it failed on** — and when
three fixes in a row fail to change an outcome, the fault is upstream of all three, not a fourth
variant of the same one.

## Reading Turbify's own help, which no amount of clicking would have produced

After the fifth click the owner's instruction was to go into Chrome and finish it. His Chrome had no
live Turbify admin session, and typing the admin password is not something a session does — so the
console could not be read. What *could* be read, with no credential at all, was **Turbify's own
documentation**, and two articles produced more than five clicks had.

- **SLN29262** — "Reset your business email password", updated 2026-07-29
- **SLN29264** — "Manage app passwords", updated 2026-07-24

### 1. The password rules, and the one that must NOT be enforced

Quoted five times in SLN29262:

> Your new password must be between 8 and 20 characters and include an uppercase letter, a lowercase
> letter, a number, a special character, and no repeated characters.

The first four are unambiguous and are now checked **before the reset**, in
`src/lib/turbify/password-policy.ts`, because setting a password Turbify rejects leaves the mailbox
reachable only through a one-time password nothing captured — the identical disaster to resetting
with no password at all, which `evaluateInviteInboxAdoption` has always refused up front.

🔴 **"No repeated characters" is deliberately NOT enforced, and that was a close call I got wrong
first.** My initial implementation read it as "no character twice anywhere" and refused on it. But
the sentence does not say which it means, and the two readings disagree about ordinary passwords:
`Company-Pass-1!` fails the global reading on its `a`, and the consecutive reading on its `ss`.
Enforcing either would **refuse an adoption Turbify would have accepted** — inventing a new blocker
out of an ambiguity, on the one flow whose entire problem has been getting blocked.

So the rule is answered by the only authority that actually knows: **the form.** `describePage` now
reads the page's own error text (`[role=alert]`, `[aria-live]`, error-ish class names) and reports it
verbatim, so whatever the rule really is, it arrives in Turbify's words. A rejected password is
recoverable — `mayBeReset` says a one-time password is outstanding, and the next run resets again —
whereas a false refusal stops the work dead on a coin flip.

**How it is pinned, which is subtler than an assertion.** The suite's own company password contains a
repeated character, so the moment anything starts enforcing that rule the happy path goes red at its
call-order check. The dedicated assertion can therefore never be the first to fire; what protects the
behaviour is an explicit check that `COMPANY` *keeps* a repeat, so nobody tidies it into a
repeat-free value and silently deletes the pin.

### 2. The dialog contains the login URL

> In the One-time password dialog, you will see the user's email address, the one-time password, and
> the login URL.

A URL passes every filter the new credential reader applies — no spaces, no `@`, the right length —
and the after-the-last-colon split yields a *second* candidate from it (`//mail.turbify.com`). It
lost to the password only because the password happened to carry a digit and the URL did not.

Excluded explicitly now, by scheme and by domain suffix. **The test uses a digit-free password on
purpose:** with a digit, the letters-and-digits preference picks the password even with the scheme
rule deleted, so the case could not fail and would not have been a pin at all. Deleting the scheme
rule now fails the suite.

### 3. The app-password path, where the robot was missing a step entirely

Turbify's steps:

1. Sign in to your business email account.
2. Click your profile icon on the top-right. *"Mobile users: Go to this link instead: https://mail.turbify.com/accountinfo"*
3. Click **Manage your account**.
4. Under Security & Privacy, click **Manage App Passwords**.
5. **From the dropdown menu, select the appropriate app.** *"If you do not see your application, select Other, then enter the application's name."*
6. Click **Generate**.

Three findings, in order of how badly each would have hurt:

| Finding | Why it mattered |
| --- | --- |
| **Step 5 did not exist in the robot** | Phoenix will never be in Turbify's app list, so the answer is always **Other** plus a name. Pressing Generate with nothing selected was never going to mint anything — this step would have failed even with all three wordings right. |
| **Steps 2–3 were unreachable by any wording** | The profile menu is revealed by a HOVER ("Mouse over your name's initial on the top-right"), and `clickOneOf` presses — it does not hover. Turbify publishes the destination as a plain URL, so `ACCOUNT_INFO_URL` replaces both clicks and the menu stops mattering. |
| **"Manage your account" is REAL** | Correcting my own correction. Earlier the same day I replaced it with "Account info" and wrote that it "does not exist", citing two independent write-ups. Turbify's article says the link reads **Manage your account**; "Account info" is the mobile deep-link *path*. Both write-ups were paraphrasing that URL — **two sources describing the same URL are not two sources.** |

### 4. And the app password stopped being able to fail the adoption

The deeper problem was structural: `generateAppPassword` sat on the **critical path** of the invite
inbox adoption while being the one step nothing had ever reached. So its failure reported
*"MAY ALREADY HAVE BEEN RESET"* over work that had actually succeeded — the reset done, the company
password set — and sent the owner back to click again.

It now falls back to the company password, and the fallback **cannot fake a success**: `addMonitor`
runs `testMailboxConnection` and refuses a credential it cannot log in with (422, nothing stored), so
`adopted: true` still means a real IMAP login happened against that mailbox.

🔴 **Scoped on purpose.** The one thing an app password buys over a mailbox password is that it
survives a later password change. For an **employee** that is decisive — they change the password at
handover and Phoenix loses access — so `runner.ts` and `adopt-runner.ts` still require it, pinned by
a source assertion that neither carries a `?? companyPassword`. For an inbox Phoenix owns and nobody
rotates, it buys nothing.

### What this cost, and what it bought

Nine breaks were applied across the three changes and all nine were watched firing, two of them only
after the break or the test was rebuilt — the login-URL case could not fail until the password lost
its digit, and the repeated-character break turned out to be caught by the happy path rather than by
its own assertion. Both of those are recorded above rather than quietly fixed, because "the test
passed after I broke it" is the exact shape that ships a defect.

## The sixth click: the sign-in worked, and the refusal withheld the one fact needed

**2026-10-03, after #5264 shipped.** The owner clicked, and for the first time the robot got *past*
the thing that had beaten five previous attempts:

```
The password form for hr.mailbox@satopharma.com was filled and submitted but is still on screen.
url https://mail.turbify.com/login; title "Bizmail Login";
headings [Set up your mailbox password];
inputs [password:password, password:confirmPassword, checkbox:-];
buttons [Hide password | Hide password | Generate mailbox password | Cookie Settings | Accept All];
the page says [Very Strong]
```

**Read what that proves before reading what it does not.** Standing on "Set up your mailbox
password" means the one-time password was located in the dialog, typed into the login form, and
*accepted by Turbify*. The credential read is fixed. Five clicks' worth of failure is over, and the
remaining fault is one step further down.

### `Very Strong` is the evidence, and it arrived by accident

The error reader picks up `[role=alert]` and `aria-live` regions. A password strength meter is
normally an `aria-live` region, so the meter's own verdict landed in the errors list — and **that
reading is what ruled the password out as the cause.** The page's validator had looked at the typed
password and called it Very Strong. Turbify was not refusing it.

Which makes the deliberate over-breadth of that selector a feature: a narrower `[role=alert]`-only
reader would have reported no errors at all, and the password would still have been a live suspect.
Do not narrow it.

### Three causes, and a refusal that could not tell them apart

With the password cleared, exactly three things could leave that form on screen:

| Candidate | How it would be distinguished |
| --- | --- |
| A **required consent checkbox**, unticked — and nothing may tick it | its `required` flag and `checked` state |
| The **confirm box empty or mismatched** (`type()` appends, `clearField` fails silently) | the two boxes' value **lengths** |
| The **submit click never landing** (incident one's signature) | the form reporting itself *valid* |

The refusal distinguished none of them. It printed **`checkbox:-`**.

🔴 **And the code had promised otherwise.** `setMailboxPassword`'s own comment read: *"a box that
proves to be a consent or terms box is the owner's to tick and never the robot's — so the form is
submitted as it stands, and if it does not move the refusal below prints the checkbox for him to act
on."* It printed a dash: no label, no required flag, no ticked state. The owner was pointed at a
control and then denied every fact about it.

**A promise in a comment is not an emitted diagnostic.** When a comment says the refusal will show
something, check that the refusal shows it — this module had written the intention down and shipped
the opposite, and it cost a real click.

### What was ruled out by reading, not by clicking

Two hypotheses were killed in the source before any change was made, which is the only reason this
did not become two more clicks:

- **The cookie banner covering the submit.** `Cookie Settings | Accept All` are on that page, and
  that banner is exactly what ate the clicks in incident one. But `openMailboxPage` already sets
  `CONSOLE_VIEWPORT` on the mailbox's own context, and `submitOpenForm` ends in the hit-tested
  `clickResolved`. Both halves were already fixed.
- **The wrong button being pressed.** `CHANGE_PASSWORD_WORDINGS[0]` is `"Generate mailbox password"`,
  which is on the page verbatim.

### What now gets reported

`PageShape.controls` carries, per control: `required`, `disabled`, ticked state, the **length** of
its value, which constraint the browser says is unsatisfied plus its `validationMessage`, and — for
the unnamed checkbox — its **label**, read from `label[for]`, `aria-label`, `aria-labelledby`, a
wrapping `<label>`, `title`, then the parent's text. Plus `formValid` from `form.checkValidity()`,
which does not submit and changes no value.

🔴 **Lengths, never values.** `filled` is `value.length`. That separates the only two readings that
matter — an empty confirm box from a matching pair — and cannot carry a credential out of the
container. A test asserts `filled` can never be the value itself.

And the typing is now **proven before anything is pressed**: if any password box does not hold
exactly the expected number of characters, the run refuses with the lengths and submits nothing.

### The test flaw this uncovered, which is not about Turbify at all

Eight breaks were applied. Three did not fire, and all three were weak *tests*, not weak code:

| Break | What happened | Why |
| --- | --- | --- |
| `form.checkValidity()` → `return null` | **stayed GREEN** | the assertion was `driver.includes("checkValidity()")`, and this module's own comment *explaining the call* contains that string |
| the control selector gutted | **stayed GREEN** | the assertion looked for the key `controls:`, which a gutted selector keeps while reporting an empty form |
| a hidden field made to emit a line | red on the right assertion, unmatchable | `assert.equal` carried no message, so the break could not be tied to it |

🔴 **A SOURCE ASSERTION ABOUT A CALL MUST READ COMMENT-STRIPPED SOURCE.** In a module this heavily
commented, the prose documenting a call keeps passing the test for the call — the test becomes
self-satisfying, and the more carefully the code is explained the less its tests prove. `driverCode
= stripComments(driver)` now backs every assertion that something *runs*; `driver` stays only for
assertions genuinely about wording. Negative assertions (`must NOT appear`) are safe either way,
because a comment mentioning a banned pattern fails loudly rather than passing quietly.

Six pre-existing positive assertions in this suite had the same flaw and were repointed. All six
still pass, so the calls were genuinely there — but they were not being proved.

After fixing the three tests: **8 of 8 breaks fire on their own named assertion.**


## Wiring the invitation reader into the create path

2026-10-03, after the sixth click. The gap this closes is a specific and slightly embarrassing one:
`invitation.ts` could read a Turbify invitation correctly — matched by identity, refusing a changed
label, refusing a near-miss address, never quoting the credential — and **nothing called it**.
`readInvitation`, `readTempPassword` and `pickInvitation` had zero callers in `src/` or `app/`. The
inbox was readable, the reader was tested, and the two were not connected, so a created mailbox still
ended as a PENDING row with its password sitting unread in a mailbox Phoenix owns and monitors.

The wiring is two files and one seam.

`src/lib/new-hire-mailbox/robot/invite-inbox-reader.ts` turns "a monitored mailbox" into "the
messages those three functions judge". It resolves the monitor for `TURBIFY_INVITE_RECIPIENT` by
address, lists headers, narrows, opens the plausible ones newest-first, and stops at the first that
yields credentials. `createMailbox`'s no-dialog branch consumes it and returns the invitation's temp
password in the one-time password's place — both are one-use, and both are spent the same way one
step later, by signing in as the mailbox and setting the company password.

### Five decisions, and what each one is defending against

**The dialog still wins where it exists.** The invitation is the fallback inside the `!hasHeading`
branch, never read ahead of it: the dialog is immediate and touches no mailbox. A test pins the
ordering by index, because "reads the invitation" and "reads the invitation *first*" are different
programs and only one of them is right.

**The order is imposed by the reader, not trusted from IMAP.** `pickInvitation` returns the FIRST
match and documents that it is handed messages newest-first — so a mailbox re-invited after a failed
activation gets its latest temp password rather than a spent one. Nothing satisfied that contract
until something sorted. 🔴 **And the undated case is subtler than it looks.** The hazard is not 1970:
substituting `0` for `-Infinity` was tried as a break and the suite **stayed green**, because 1970 is
older than every real date anyway. The hazard is `NaN` — `Date.parse` of a missing header returns it,
every comparison with `NaN` is false, so an unguarded comparator is inconsistent and the sort is free
to leave the array exactly as IMAP gave it, with an undated message first and taken as the newest
invitation. The guard is against that, and the comment in the module said the wrong thing until
break-and-watch corrected it.

**Only a plausible invitation is opened.** A listing is headers; each body is another fetch, and each
fetch is an audited `mailbox_access` row written by `withMonitorRead`. So narrowing on headers is a
privacy property before it is a cost one: Phoenix does not open mail it has no business opening, even
in a mailbox it owns. The recipient test is identity for the usual reason — `adel.sayed@` contains
`el.sayed@`. The subject test is the one containment test, and it only promotes a message to being
*opened*, after which `readInvitation` matches by identity and refuses the near miss.

**Every read is attributed to the robot.** `ROBOT_ACTOR`, never a null actor: the audit row is the
only account of Phoenix having opened a mailbox and read a message out of it, and a null actor records
it as nobody's.

**An unreadable inbox is never read as an empty one, and that distinction is what the poll is for.**
The reader returns `retryable`, true only when the inbox was genuinely read and simply held nothing
for this mailbox yet — the one refusal a delivery can change. Everything else (no invite inbox
configured, the inbox not connected, a lookup or listing that threw, a listing that is not a list)
says the same thing on the sixth pass as the first, so the poll stops dead rather than sleeping out a
minute while the browser session ages. And there is deliberately **no "only invitations newer than
this create" filter**: it would defend against a spent invitation for an address `readExistingRow`
has already refused one step earlier, while silently dropping the real invitation on any clock skew
between the mail server and the container — trading an honest, retryable failure for the exact
confusion this whole flow exists to end.

### The refusal that had to stop being true

`describeCreateWithoutPassword` ended with "so this half of the flow is not calibrated yet". That was
true while nothing read the invitation and is a lie the moment something does — and the owner acts on
that sentence. It now takes the inbox's refusal and says the invitation **was** looked for and what
stopped it, which is a different job for a different person: a mailbox to connect, or a wording of
Turbify's to re-read. Either way the mailbox's own state — **WAS CREATED / is PENDING** — stays the
first fact in the message, because burying it is how "was created" got read as "failed".

### What this does NOT finish

Step 2 still signs in as the new mailbox and lands on the same `Set up your mailbox password` page
whose unlabelled, non-`required` checkbox stopped `hr.mailbox@satopharma.com` — typing landed
(`filled=9` in both boxes), the password was rated `Very Strong`, the form reported itself valid, and
the cookie banner was not covering the button. The invitation closes the credential gap. It does not
close that one.

**16 of 16 breaks fired on their own named assertion**, including the two that had to be corrected
first: the `0`-for-`-Infinity` break that proved nothing, and a break whose red came from an earlier
helper's message rather than the assertion below it.


## The setup page is Yahoo's Terms of Service, so step 2 is a boundary and not a bug

2026-10-04, 00:20 Cairo. This is the answer to the six dead clicks, and it is not a defect anywhere
in Phoenix.

The control reader shipped in #5275 was built for exactly one job: name the unlabelled checkbox on
`Set up your mailbox password`, because every link of its label chain came back empty. On the next
live run it returned this, verbatim:

```
checkbox:- UNTICKED
  near:"By continuing, you agree that Turbify will create a profile, and for use of Business Mail
        service. You agree to Yahoo's Terms of Service and Privacy Policies."
  markup:<input aria-hidden="true" tabindex="-1" type="checkbox"
          style="position: absolute; pointer-events: none; opacity: 0; margin: 0px;
          transform: translateX(-100%);">
```

Three readings, and together they close the question:

**It is a consent to a third party's terms.** That had been the standing assumption and the reason
nothing ticked it. It is now a measurement rather than a precaution.

**The box cannot be ticked by anything — including the owner.** `pointer-events: none`, `opacity: 0`,
`aria-hidden="true"`, `tabindex="-1"`, pushed off-screen by `translateX(-100%)`: a visually-hidden
native input acting as a value carrier behind a custom control. So every refusal that told him to
tick it was giving advice nobody could follow, and had been since the page was first reached.

🔴 **The consent is "By CONTINUING", not by ticking — so the SUBMIT ITSELF is the acceptance.** This
is the part that settles it. There is no sequence of clicks an automation can perform here that is
not the act of agreeing to Yahoo's Terms of Service on the company's behalf. The step is not
uncalibrated; it is **not automatable, by its nature**, and no further measurement will change that.

It also means the checkbox was never what held the submit back: it carries no `required` flag and the
form reports itself valid, which was already measured on 2026-10-03 at 23:10:35. Why Turbify's own JS
does not advance is now moot — whatever the reason, the robot may not be the thing that advances it.

### What changed in the code

- `createMailbox`'s sibling step, `setMailboxPassword`, keeps submitting the form (Phoenix may
  legitimately try), but its refusal now states that the mailbox's password was **NOT** changed, that
  re-running cannot get past a terms page, and what the four manual clicks are.
- The comment above the submit no longer describes the label as unread. It carries the measured text.
- `invite-inbox-runner.ts` stopped claiming **"Phoenix cannot read the mailbox until an adoption
  completes"**, which was measured FALSE the same night. A reset rotates the MAILBOX's password; an
  app password already stored with the monitor survives it. `hr.mailbox@satopharma.com` passed a real
  IMAP login at **00:19:54 Cairo**, minutes after a failed run had told the owner access was gone. He
  was sent to rescue something that had never been lost, which is the costliest kind of wrong refusal
  — it spends his time on a problem that does not exist while the real one goes unmentioned.

### The shape the flow actually has

The robot takes a new mailbox as far as a credential and no further:

1. create the mailbox — **automated**;
2. read its invitation out of the invite inbox and take the temp password — **automated** (#5280);
3. first sign-in and set the company password — **one human sign-in per mailbox**, because continuing
   accepts Yahoo's terms;
4. mint the app password inside the mailbox and connect it — **manual**, inside the window step 3
   opens.

That is the honest deliverable: not hands-off provisioning, but every mailbox brought to the point
where one sign-in and one password entry finish it.

## The app-passwords page can be captured without resetting anything (2026-10-04)

`APP_PASSWORD_REVOKE_CONTROLS` in `src/lib/mailbox-offboarding/robot/clear-app-passwords.ts` holds
four placeholders — `existingList`, `removeOne`, `removeConfirm`, `emptyState` — all literally
`__UNCALIBRATED__`. Until they are real text, `APP_PASSWORD_CLEAR_CALIBRATED` cannot honestly be
flipped, and a leaver's phone and Outlook keep syncing mail after their password is reset. That is
the `isHalfRevoked` state the register already reports and nothing can close.

**Why nobody had ever seen those controls.** They exist only inside a mailbox's own security pages,
which an admin session cannot reach — confirmed against the live console 2026-09-24 and still true.
The single read that existed sat *after* minting, at the end of `generateAppPassword`, gated on
`PHOENIX_TURBIFY_REPORT_CONTROLS`. And `generateAppPassword` is reachable only through a flow that
**resets** the mailbox first, which lands on `Set up your mailbox password` — whose submit IS the
acceptance of Yahoo's Terms of Service and is therefore not an automation's to give. So the capture
had no path at all: every route to the page went through a wall.

**The way through.** A mailbox that is already past its first sign-in opens straight into its account
pages when signed into with the password Phoenix holds. No reset, so no setup screen, so no wall.
`describeAppPasswords` in `src/lib/new-hire-mailbox/robot/turbify-joiner.ts` does exactly that and
nothing else:

- it signs in with the password it is handed, and resets nothing
- it navigates — `Manage your account`, then `Manage App Passwords`, both tolerated on failure with
  the page carried in the refusal; a page cannot be read without being reached
- it never calls `selectAppForPassword` and never presses `APP_PASSWORD_WORDINGS.generate`, so no app
  password is minted onto a live mailbox
- it never names `APP_PASSWORD_REVOKE_CONTROLS`, because identifying those four is the point
- it reads `CONTROL_READ_EXPRESSION` and reports through `buildControlReport`, which drops a
  secret-shaped label whatever it is — this page lists credentials by nature

**The setup screen is an answer, not a missing control.** If the sign-in lands on
`Set up your mailbox password`, the password Phoenix holds for that mailbox is a one-time password:
the mailbox has never completed a first sign-in, or a later reset rotated it. The capture returns
`reached: false` with that sentence and the page, rather than reporting a control it never looked
for. The unblock is the four manual clicks, once, for that mailbox.

**The route is `POST /api/new-hire-mailboxes/app-password-controls`.** Super Admin only
(`canReadInitialPassword`, the same audience as adoption, because it signs in as a mailbox with the
company password), same-origin, rate-capped at 3/hour, `dryRun` unless the body says `false`. The
address is `INVITE_INBOX_ADDRESS` and is never read from the request — the same chain pointed at an
employee signs into their mail. The controls come back **in the response** and go to the audit row,
not only to the log: the two live runs of 2026-10-03 stored `adopted: false, refusal: null` and
nothing else, and the diagnostic had to be copied out of a browser by hand.

🔴 **Shipping the capture calibrates nothing.** `APP_PASSWORD_CLEAR_CALIBRATED` stays `false` and all
four placeholders stay placeholders until a live run replaces them with observed text.
`tests/new-hire-mailbox-app-password-capture.test.ts` asserts both, and flipping the flag on the
strength of this route existing is one of the seven breaks it catches (7 of 7 fired on their own
messages).

## The first live capture: the invite inbox is itself behind the terms wall (2026-10-04)

The capture ran on production at **07:16 Cairo**, on revision `3d84bf395`. It did not reach the App
Passwords page, and the reason is the finding.

It refused inside `signInAs`, quoting the page it was actually on:

> Signed in as hr.mailbox@satopharma.com but the expected page never appeared, so the robot stopped
> rather than act on an unknown page. The page it was on — url `https://mail.turbify.com/login`;
> title "Bizmail Login"; … controls [text:email filled=25 "Business Email Address" |
> password:password filled=9 "Password"]; the form reports itself valid, so the submit is not being
> refused by validation

Read it in order. The email field held 25 characters, which is exactly
`hr.mailbox@satopharma.com`. The password field held 9, which is the company initial password. The
form reported itself valid, so nothing was being refused by client-side validation. And the page was
still `Bizmail Login`. The credentials were delivered correctly and the sign-in simply did not
happen.

The reason is in this file already, one section up: on **3 October at 21:53** the attempt to SET
that 9-character password ended on the `Set up your mailbox password` screen, submitted, and stayed
there — the submit is the acceptance of Yahoo's terms, which no automation may give. So the password
was never actually set. Phoenix holds a password for `hr.mailbox@satopharma.com` that the mailbox
has never had.

**The trap this closes.** `hr.mailbox@satopharma.com` reads mail perfectly well:
`mailbox_monitors` has it `active`, `last_ok_at` **2026-10-04 00:19:54 Cairo**, with a stored
credential. That is an **app password**, and an app password survives a password change — so a green
monitor says nothing whatever about whether the mailbox can be signed into on the web. The two are
independent, and conflating them is what makes "the mailbox works" sound like "the capture should
work". The App Passwords page lives behind the web sign-in, so it is unreachable until a human
completes that first sign-in.

So the invite inbox — the one mailbox the capture is hardcoded to target, deliberately, so the same
chain can never be pointed at an employee — is itself one of the mailboxes waiting on the four
manual clicks. Four clicks on that one mailbox unblock the whole leaver-side clear.

### A run that threw left no record at all

The throw went past `writeAuditLog`, which sat after the driver call on the success path only. So
`audit_logs` held **nothing** for that run: the only account of the finding above was the text
rendered on the card, and one reload would have destroyed it — the same loss a `router.refresh()`
caused on 2026-10-03, arriving by a different route.

The failure is recorded now, in its own `catch` around the run:

- `failed: true`, and the success row carries `failed: false`. Written on **both** paths on purpose:
  if only the failure row had it, its absence would mean both "an older row" and "a run that did not
  throw", and a query for the failures would quietly answer with a mix of the two.
- `why` is the error message, which is what carries the value — the measured page, with every
  `filled` already reduced to a length and every secret-shaped value dropped by `describePage`. It
  is the same string the card renders, so storing it is exactly as safe as showing it.
- The browser closes **before** the audit write, not after. The audit has its own bounded timeout,
  and a slow or failing insert must never hold a signed-in mailbox session open behind it.
- The error is **rethrown**, so the HTTP status still comes from the handler's own catch. Recording
  a failure must never convert it into a success.
- The access refusals — forbidden, rate-limited — are raised before a driver exists and are
  deliberately *not* recorded as capture attempts, or the audit would overstate how often the robot
  actually ran.

Seven breaks, seven fired on their own messages. One of them is worth keeping in mind: the first
version of the assertion sliced the route from the driver down to the response, and the **success**
path's own `writeAuditLog` sat inside that window — so deleting the failure audit entirely left the
suite green. The slice now ends at the rethrow. A source assertion is only as good as the region it
reads, and the wrong call site satisfying it is the same defect as a comment satisfying it.

## The wording the live page actually carries (2026-10-04, 07:44 Cairo)

The second capture run — the first after the owner completed `hr.mailbox`'s own first sign-in by hand
— **signed in, reached `https://mail.turbify.com/accountinfo` ("Update User Profile"), and refused at
the section lookup.** That refusal is the whole return on the step: because every wording list fails
closed and `describePage` prints the page, the run handed back the button's own text instead of
pressing something unknown inside a live mailbox's security settings.

The button reads:

```
APP Password Manage App Passwords
```

The section **heading** is inside the button, run straight into its label — `textContent` with no
separator, which is the third time this console has done it (a table row glued a display name to an
address; the one-time-password dialog glued an address to the next label). The sibling control on the
same page has the identical shape, `Account Password Change Password`, so expect `<heading> <label>`
for anything else read off these account pages.

`matchesLocator` compares a text locator **exactly**, after trimming and collapsing whitespace, and
never as a substring — deliberately, because a substring match on `App Passwords` would also match
the heading, and a wrong click here lands inside a live mailbox's security settings. So the label on
its own could never have matched, however many spellings of it were listed, and the measured
composite has to be listed verbatim.

What changed in `APP_PASSWORD_WORDINGS.appPasswords`:

- `"APP Password Manage App Passwords"` leads the list — the measured wording, tried first.
- The four earlier guesses stay **below** it rather than being deleted. They cost one failed match
  each, and they are what still works if Turbify ever drops the heading back out of the button.

Pinned in `tests/new-hire-mailbox-app-password-capture.test.ts`, which asserts the composite is
present, that it is first, that the documented label is still behind it, and — against
`src/lib/turbify/resolve.ts` — that the text comparison is still `===` and not a substring. Four
breaks, four fired on their own messages.

Two things about that verification are worth carrying:

- **The sibling suite had pinned the old wording.** `tests/new-hire-mailbox-robot.test.ts` asserted
  `appPasswords[0] === "Manage App Passwords"`, so the corrected list would have gone red in CI on a
  suite the new assertion cannot see. `git grep` for the retired wording before pushing — the same
  shape that reddened #5285.
- **A break harness that re-imports is measuring its own module cache.** Run each break in its own
  child process. The first attempt ran all four in one process, ESM kept `locators.ts` from break A,
  and breaks B, C and D all fired on A's message while the restore "failed" against a file that was
  correct on disk. And a short break anchor edits the wrong line: `.trim() === value;` matched the
  `aria` case three lines above the `text` case, so `String.replace` patched a sibling and the break
  scored NOT CAUGHT against an assertion that was right all along.

### And the refusal itself had to be made readable

The sentence a failed capture hands back is the step's whole deliverable, and it said:

> No the App Passwords section was found on the Turbify page. … It looked for a button reading one
> of: …

Two defects in one line. `purpose` is written with its article because that is how it reads inside
`describeLocator`'s parentheses (`button reading "Generate" (the button that mints a new app
password)`), so interpolating it after "No" produces "No the". And `clickOneOf` accepts a link **or**
a button on these pages — a refusal claiming it looked for a button sends the next reader to check
the wrong element type, which is exactly the kind of misdirection that cost four clicks earlier in
this chain. It now strips the leading article and names the tags it actually searched.

🔴 **`submitOpenForm` raises the same sentence and is CORRECT — do not "fix" it.** Its purposes are
written without an article (`submit button for the new-mailbox form`), so "No submit button for the
new-mailbox form was found" reads properly. The pin is therefore sliced to `clickOneOf`'s body: a
repo-wide ban on the article-bearing form would have demanded a change next door that makes its
message worse. Seven breaks, seven fired on their own messages — and break E had to **shadow** rather
than replace, because swapping the stripped subject back out fires the positive assertion one line
earlier, which is the right assertion under a different wording rather than a misaim.

## The structural path, and why the first live run could only fill one placeholder of four

The 2026-10-04 10:30 Cairo run is the first that ever reached the App Passwords page of
`hr.mailbox@satopharma.com` and read it. It succeeded — `failed: false`, `reached: true`, 22
controls, 0 dropped as credential-shaped — and the audit row carries the lot. The section opener it
had been failing on, `APP Password Manage App Passwords`, worked on the first attempt.

What it found:

```
button: APP Password | APP [redacted] App Passwords
button: Account Password | Account [redacted] Password
button: Generate          button: Remove           button: Skip for now
a: iPhone & iPad (iOS Mail) · Mac Mail Client · Android Email Setup · Microsoft Outlook / Office 365
input: Text Input   input: mobileNum   a: Skip   button: save | Save
a: Manage Cookies   button: Cookie Settings   button: Accept All
```

Against the four placeholders in `APP_PASSWORD_REVOKE_CONTROLS`, that fills exactly one:

| placeholder | outcome |
| --- | --- |
| `removeOne` | `button: Remove` — observed |
| `removeConfirm` | not observed; it exists only after a removal is actually pressed |
| `existingList` | **unobservable by this capture, by design** |
| `emptyState` | **unobservable by this capture, by design** |

The last two are not a bad run and no amount of re-running fixes them.
`CONTROL_READ_EXPRESSION` reads `button, a, [role], input, [aria-label]` and nothing else, under an
explicit rule against reading a container's rendered text — because on a page that lists
credentials, the container's text **is** the credential. Both of those controls are plain text. The
rule that makes the capture safe is precisely the rule that blocks them.

🔴 **So the absence of an entry row in that report proves nothing about whether the mailbox has an
app password.** A reader who treats it as an empty-state reading is reading the scraper's blind
spot as a fact about Turbify.

### The path reads no text, which is why it was a safe way through

`ObservedControl` now also carries a `selector` — a CSS path of at most three segments, built from
**attributes only**: tag, id, class, `nth-of-type` position. Plus `siblings`, the count of
same-tag siblings. Neither reads a character of text, so the capture gained no new way for a
displayed password to escape, and `tests/turbify-control-report.test.ts` pins that `textContent`
is still read exactly once.

That is enough to name both missing controls without reading them: the entry rows are whatever
contains the `Remove` buttons, and the empty state is that same container with none underneath. It
is also what the four fields actually store — `{ label, selector }` — so a path, rather than a
wording, is what they were waiting for all along.

### Two things that had to be got right, both found by breaking them

**`looksLikeSecret` is wrong about a path.** Its rule is "12 or more characters with no
whitespace", which is the shape of every ordinary CSS identifier — `app-password-row` is 16, and
`notifications` is 13. Applied to a path it redacts exactly the class names that make the path
worth having. So a path token is split on `-` and `_` and each word judged separately, and a word
that is spelled like English (all lower case, no digits, vowels at a normal rate) is exempt:
`looksLikePathWord`. A minted password is vowel-starved or mixes case and digits, so it is not.

**A dropped part is removed, not marked.** `div#[redacted] > button.rm` names a class that does not
exist, so substituting a marker turns the path into a selector that can never match — at the exact
moment somebody pins it as one. Dropping the part and its punctuation leaves `div > button.rm`,
which is shorter, honest and still resolves.

Eight breaks, eight fired on their own assertion. Two of them changed the code rather than
confirming it: the English-word exemption exists because breaking the naive rule showed
`notifications-panel` losing its class, and a guard for "something was dropped and no letters
survive" was **deleted** when breaking it changed no test — it was unreachable, because a path
always keeps its tag names and the empty case is caught one line earlier. A dead branch in a
redactor is worse than no branch: it reads like a protection while never running.

### What is still not calibrated

`APP_PASSWORD_CLEAR_CALIBRATED` stays `false`. The next live run fills `existingList`, `removeOne`
and `emptyState` from the paths. `removeConfirm` needs one real removal to be observed at all,
which is a decision about a live mailbox and not a thing a session takes on its own.

## The rehearsal: why the fourth placeholder needs a credential minted to be seen

`removeConfirm` is not a wording nobody looked up. It is a control that **does not exist on the page
until Remove has been pressed**. So the 2026-10-04 10:30 capture filling three of four was not a
shortfall in that run — every future read of an untouched page would fill exactly the same three.

`rehearseAppPasswordRemoval` is the only way through: mint one app password on Phoenix's own invite
inbox, capture the page at four stages, then remove it.

| stage | what it is for |
| --- | --- |
| `before` | the empty state |
| `listed` | the entry row and its remove control |
| `confirming` | captured **between** pressing Remove and answering it — the only place the confirm exists |
| `after` | should read like `before` again |

Every stage is returned even when a later one fails, because a run that minted but could not remove
still carries three of the four placeholders, and discarding them to report a failure would waste
the credential it spent.

### The three things that had to be right

**The address guard is the first statement in the function, before a browser exists.** A guard after
the sign-in would still be correct and still be wrong: by then the run has committed a live session
to a mailbox. It compares against `TURBIFY_INVITE_RECIPIENT` and refuses everything else — the route
never passes an address at all, and a test reads the call's actual argument rather than banning two
spellings of reading one off the body. That matters: the first version of that test banned
`body.address` and `body?.address`, and a break using `(body as { address?: string }).address`
sailed straight through it.

**`outstanding` means a working credential is adrift.** Two failures look alike and are not: failing
to press Generate leaves nothing behind, failing to answer the confirm leaves a live app password on
the mailbox. Reporting only `removed: false` would read as "nothing happened" — the opposite of the
truth. The flag, the audit summary and the card all say it in words, and a test pins that the prose
and the flag agree in every early return, because prose is read once by a person and the flag is
read for ever by everything else.

**A throw records `outstanding: null`, never `false`.** If the run threw after minting, claiming
nothing is outstanding is a claim that path cannot support.

### What the first run is expected to do

🔴 **Fail at the confirm, and that is a success.** Every wording in `removeConfirm` is a guess —
nothing has ever seen that control — so the fail-closed list will probably match nothing, leaving a
live app password on the invite inbox and saying so loudly. The `confirming` reading is what the run
is buying, and it is what replaces the guesses. Phoenix's own inbox is the one mailbox where that
outcome costs nobody their mail.

## The read that could never have worked: asking the redactor for the thing it redacts

The rehearsal's first draft read the minted app password like this:

```ts
const shownAfterMint = await describePage(mailbox, secrets);
const mintedValue = pickAppPassword(shownAfterMint, address);
```

It typechecked as far as the picker's own return type, and it could never have succeeded.

`describePage` exists to produce a sentence safe to put in a refusal, a log line and an audit row on
a page that may be displaying credentials. It does that by redacting — against every secret in hand,
**and against anything secret-shaped whatever it is**. A freshly minted app password is about sixteen
space-free characters, which is exactly the shape it drops. So the password was gone from the text
before `pickAppPassword` ever saw it.

**The reason this is worth a doc entry is the shape of the failure, not the bug.** `pickAppPassword`
refuses with a count rather than guessing, so the run would have reported:

> No app password could be read

which is **the same sentence a changed console gives**. A session reading that would have gone
looking at the page — new wording, a moved control, a layout change — and found nothing wrong,
because nothing was wrong with the page. The redactor was working correctly. Meanwhile the real cost
sits one line further on: `secrets.push(mintedValue)` never runs, so a **live credential on the
mailbox** is in neither the redactor's list nor anybody's attention, and every reading taken
afterwards is redacted against a list that does not contain it.

The provisioning path never had this problem because it reads the page's own text directly:

```ts
const shown = await mailbox.evaluate<string>(`(() => {
  const scope = document.body;
  if (!scope) return "";
  return scope.innerText || scope.textContent || "";
})()`).catch(() => "");
```

So the rule is narrow and mechanical: **`describePage` is for the `why` of a refusal, and for nothing
a caller must still parse.** Anything that has to be read as a value is read from raw page text.

Two smaller things were settled in the same fix:

- **`pickAppPassword` returns `{ password } | { refusal }`, not a string.** Pushing the reading itself
  into `secrets` is what the typecheck actually caught — a union where a `string[]` was expected.
- **An unreadable minted value is not a reason to stop.** The credential exists by the time this read
  happens, so returning early leaves it live on the mailbox, which is the single outcome the
  rehearsal is built to avoid. It carries on to the removal and keeps the refusal's sentence out of
  the redactor's list rather than pushing it in as though it were a password.

**Pinned on what `pickAppPassword` is handed**, in
`tests/new-hire-mailbox-app-password-rehearsal.test.ts` — the assertion resolves the identifier the
picker is given and reads the `const` that declares it. That is deliberate: `describePage` sits two
lines away in the same function and reads like a tidy-up waiting to happen. Broken to confirm it
fires on exactly that substitution:

```
FIRED:: the minted value must NOT be read from describePage, which redacts the very thing being read
```
