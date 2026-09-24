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
