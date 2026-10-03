---
paths:
  - "src/lib/turbify/**"
  - "src/lib/{new-hire-mailbox,mailbox-offboarding}/**"
  - "tests/*{turbify,mailbox}*"
  - "app/**/mailbox-offboarding/**"
---

# Module memory — Turbify mailbox console — the shared browser driver

**Scope:** The Turbify admin console both mailbox robots drive: its confirmed on-screen wordings, row resolution and refusals, click delivery, and the two robots themselves (new-hire adoption and leaver offboarding). Email delivery and templates stay in `notifications`; the HR lifecycle around a joiner or leaver stays in `employees`.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

🔴 **`employees.md` (the joiner's HR lifecycle) and `notifications.md` (email delivery) load BESIDE
this file, not instead of it** — this module's globs add to theirs. The four rules below were filed
under `employees` on 2026-10-02, before this module existed; they are the CONSOLE's rules, so the
leaver side needs them too, and they moved here the same day rather than being copied.

- 🔴 **TURBIFY HAS NO AUTHENTICATOR-APP 2FA — its only second factors are a code to a mobile or to an email address** (its own help, SLN29023, read 2026-10-02). There is no TOTP secret to hold, so unattended console automation needs two-step verification OFF on the admin account, which it is. A session told to make this robot unattended reaches for TOTP because that is the right answer nearly everywhere else; it was built here, proved against RFC 6238, and then deleted unused. **Check the platform before building the second factor.**
- 🔴 **AN APP PASSWORD SURVIVES A LATER PASSWORD CHANGE, and that one fact decides two opposite things.** It is why resetting a leaver's password does NOT revoke their mailbox (`a-password-reset-does-not-revoke-a-turbify-mailbox` — delete the app passwords or suspend it), and equally why adopting a joiner's existing mailbox is safe: once Phoenix holds its app password the employee can change their own password immediately and Phoenix keeps working. Never reason from one half without the other.
- 🔴 **THE CONSOLE'S SEARCH IS A SUBSTRING MATCH, SO "EXACTLY ONE ROW" MUST BE AN IDENTITY CHECK AND NEVER A COUNT.** Every one of the 288 rows carries the same `aria-label="Reset password"`, so a first-match click resets the WRONG employee — and filtering does not fix it: searching `el.sayed@satopharma.com` returns the single ACTIVE row for `adel.sayed@satopharma.com`, with its own Reset password button, so a count answered "safe to click" and the leaver driver's `includes()` dialog check then confirmed the wrong reset as the right one (2026-10-03). Use `rowIdentityRefusal`, `readExistenceFromRows` and `dialogNamesAddress` in `src/lib/turbify/resolve.ts`; `rowCountRefusal` and `readExistence` were DELETED so nobody reaches for them. 🔴 **And only the FIRST search after a page load actually filters** — a second search in the same page answers from the previous one, which once reported 34 of 35 addresses absent when 28 existed. One page load per address, with a positive control. Account: `docs/mailbox-robot-calibration.md`.
- 🔴 **ADOPTION NEVER RUNS ON A SCHEDULE** — it resets a mailbox somebody reads every day, so its only caller is the Super-Admin-only route behind the New Hire Mailboxes card, and `tests/new-hire-mailbox-adopt.test.ts` fails if a cron route or the sweep so much as names it. Wiring it into the daily sweep is the obvious-looking way to "finish the remaining mailboxes" and would lock people out overnight with nobody told. The joiner robot is the scheduled one, because a mailbox it has just created belongs to nobody yet.
- 🔴 **A COORDINATE CLICK THAT REPORTS SUCCESS IS NOT EVIDENCE THE CONTROL WAS CLICKED** (measured in the production container, 2026-10-02). The joiner ran at puppeteer's default 800×600 with no viewport set; the console's cookie banner — fixed, `z-index: 99999`, 188px — covered everything below y=412, the "Email user" button sat at y=430, and `handle.click()` hit the banner, reported no error, and failed a later step naming an innocent selector. Every click now hit-tests with `document.elementFromPoint` first and re-delivers on the node when covered (`src/lib/turbify/click-delivery.ts`), failing open.
- 🔴 **`handle.type()` APPENDS, and the driver reuses one page per candidate** — the search box once read `adel.srour@satopharma.comasmaa.zaghloul@satopharma.com`. That is worse than a bad search: `createMailbox`'s "does this address already exist?" check reads the filtered page, so it can answer about a string nobody searched for. Clear the field before typing, and treat an existence answer as belonging to the address you can prove is in the box.

- 🔴 **A MAILBOX TURBIFY CREATES LANDS IN `Pending`, AND `Active mailboxes` DOES NOT COUNT IT — so "the count did not move" is NOT proof nothing was created.** Create does not behave like reset: it makes the mailbox Pending and hands the password over by INVITATION, never through the `One-time password` dialog a reset opens, so the robot threw and reported `provisioned: 0` while `ahmed.mohamed@` and `asmaa.zaghloul@` really existed (2026-10-03). A Pending row carries NO `Reset password` button, so counting those reports it absent, and its address must be read from its OWN cell — the display name runs straight into it, so the row's text parses as `Abd-Elnaimahmed.mohamed@satopharma.com`. The post-save view offers `send invite` and `print`; **print** is what still needs calibrating. Account: `docs/mailbox-robot-calibration.md`.
- 🔴 **IN-PAGE CODE IS A REAL FUNCTION, NEVER A STRING — in the driver and in a throwaway probe alike.** A string crosses the template-literal and shell-heredoc layers and arrives changed: one lost a backslash, turning `/\s+/g` into `/s+/g`, which replaced every literal `s` and made the console's `Email user` button read `Email u er` — read for an hour as a Turbify rendering bug, when the page's bytes spell `Email user`. An earlier one passed in-page code to `page.evaluate(expr, handle)`, which never binds the handle, so every click became a silent no-op that reported success. `readMailboxRowCells`, `readHitTest`, `clickNode` and `clearField` are real exported functions, unit-tested against fake elements. Account: `docs/mailbox-robot-calibration.md`.
<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (0)

_No notes filed under this module yet._
<!-- module-memory:notes:end -->
