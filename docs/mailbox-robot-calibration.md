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
