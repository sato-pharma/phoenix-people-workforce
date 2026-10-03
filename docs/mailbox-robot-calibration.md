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
