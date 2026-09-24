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
3. **The console driver is uncalibrated.** `createTurbifyConsoleDriver()` throws
   `TurbifyConsoleNotCalibratedError` while `TURBIFY_SELECTORS_CALIBRATED` is `false` in
   `src/lib/mailbox-offboarding/robot/turbify-console.ts`. A live run builds the driver first, so it
   fails closed there and the runner is never reached.

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

## Step 2 — calibrate the RESET flow (supervised, with you)

The reset controls can only be read from the live console, and the success dialog only appears after
a real reset. So we calibrate it while you reset one real overdue leaver — a mailbox that should be
reset anyway. You are logged in; I never see the credentials. Paste this into the console's DevTools
(F12 → Console) and run `phxDump("label")` at each screen state below; send me the output.

```js
// Paste once. Then call phxDump("...") at each step.
window.phxDump = (label) => {
  const sel = (el) => {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const da = [...el.attributes].find(a => /^data-(test|qa|id|automation)/i.test(a.name));
    if (da) return `[${da.name}="${CSS.escape(da.value)}"]`;
    const nm = el.getAttribute("name");
    if (nm) return `${el.tagName.toLowerCase()}[name="${CSS.escape(nm)}"]`;
    const al = el.getAttribute("aria-label");
    if (al) return `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(al)}"]`;
    return el.tagName.toLowerCase() + (el.className ? "." + [...el.classList].map(CSS.escape).join(".") : "");
  };
  const rows = [...document.querySelectorAll('button,a,input,[role="button"],[role="dialog"],[role="menuitem"]')]
    .filter(el => el.offsetParent !== null)
    .map(el => ({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || "",
      text: (el.innerText || el.value || el.placeholder || "").trim().slice(0, 40),
      selector: sel(el),
    }));
  console.log("=== phxDump: " + label + " ===");
  console.table(rows);
  return rows;
};
```

Run it at:

- **a. list filtered.** Type a leaver's address into "Search users…", then `phxDump("list")`.
  — gives the search box and the filtered row's action controls (Reset password, More actions).
- **b. reset dialog.** Click "Reset password" on that row (this resets it — it is a real overdue
  leaver, so that is the intended action), then `phxDump("reset-dialog")`.
  — gives the "One-time password" dialog (the reset success signal) and its "Close modal" control.
- **c. more-actions menu.** Open "More actions" on a row, then `phxDump("more-actions")`.
  — gives the "Delete" menu item. **Do not click Delete** — that flow is step 4.

I take those three dumps, write the real selectors and the puppeteer `resetPassword` implementation
into `turbify-console.ts`, and we run one dry-run pass to confirm the sign-in and the reset selectors
resolve before anything live.

## Step 3 — go live on RESET

Once step 2's dry run confirms the reset flow, set `PHOENIX_TURBIFY_ROBOT_DRY_RUN=false`. The next
sweep resets up to five overdue leavers per run (`ROBOT_DEFAULT_MAX_PER_RUN`), clearing the 13 over
three runs. Reset is reversible; deletion is not, and cannot happen yet — the delete flow is still
uncalibrated, and a reset mailbox is not eligible to delete until 30 days after the robot reset it.

## Step 4 — calibrate DELETE (about 30 days later, first supervised deletion)

The delete-confirmation behaviour was deliberately never guessed — the console executes destructive
actions with no "are you sure", and a delete is permanent with no backup. When the first
robot-reset mailbox reaches its 30-day grace, we calibrate the delete flow on that first supervised
deletion: run `phxDump("delete-confirm")` at the confirmation step and confirm the address is gone
from the list afterward. I then write the `deleteMailbox` implementation and its selectors.

**Note the calibration flag.** `TURBIFY_SELECTORS_CALIBRATED` currently gates *both* methods with one
boolean. When we implement reset (step 2) I will split it into reset- and delete-calibrated flags so
reset can go live in step 3 while delete stays locked until step 4 — the two-phase reality the robot
already models. That structural change I will run past you before making it.
