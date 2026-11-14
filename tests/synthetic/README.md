# Synthetic User Journeys

A small, read-only Playwright smoke suite that logs in as a Super Admin and
visits the most critical Phoenix Workforce admin pages to catch broken
flows early. It never creates, edits, approves, rejects, deletes, uploads,
or sends anything — it only confirms pages render.

This suite is completely separate from `tests/e2e/` (its own Playwright
config, its own auth/storage state, its own report output). Neither suite
affects the other.

## Safety rules

- **Read-only by default.** Every journey only navigates and asserts —
  no mutations.
- **Refuses to run against production** (`phoenix-hr.satopharma.com`)
  unless `SYNTHETIC_ALLOW_PRODUCTION=true` is set. Even then, journeys stay
  read-only.
- **Never enables staging on its own** — you point it at whatever
  `SYNTHETIC_BASE_URL` you choose (local dev server, a preview deployment,
  a staging-connected preview, or production with the flag above).
- **Fails fast with a clear message** if required env vars are missing —
  it will not silently skip or produce a misleading "all green" report.
- Any future journey that needs to mutate data must set `mutates: true` on
  its `JourneyDefinition` and be gated behind `SYNTHETIC_ALLOW_MUTATION=true`
  (see "How to add a new journey" below). No current journey does this.

## Required environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `SYNTHETIC_BASE_URL` | yes | URL of the environment to test, e.g. `http://localhost:3000`. |
| `SYNTHETIC_ADMIN_HR_ID` | yes | HR_ID of a Super Admin test account (Phoenix Workforce login is HR_ID + password — there is no email login). |
| `SYNTHETIC_ADMIN_PASSWORD` | yes | Password for that account. |
| `SYNTHETIC_ADMIN_TOTP_SECRET` | yes | That account's authenticator key (base32). A Super Admin's password sign-in also asks for a 6-digit code (`docs/security/second-sign-in-step.md`); the setup makes the current code from this key and types it. For production it was set up on the server on 14 Nov 2026 and exists only as the repository secret. |
| `SYNTHETIC_ALLOW_PRODUCTION` | no | Set to `true` to allow `SYNTHETIC_BASE_URL` to point at `phoenix-hr.satopharma.com`. Unset/anything else refuses to run. |
| `SYNTHETIC_ALLOW_MUTATION` | no | Reserved for future mutating journeys. Has no effect today — none of the current journeys mutate data. |

If any of the four required variables are missing, or `SYNTHETIC_BASE_URL`
points at production without the flag, the run aborts immediately with a
plain-English error before any browser opens — see `helpers/global-setup.ts`.

Never commit real credentials. Set these in your shell or an untracked
`.env.local` (see the commented block in `.env.example`).

## How to run locally

```bash
# 1. Start the app you want to test (in another terminal)
pnpm run dev

# 2. One-time: install browsers if you haven't already
pnpm exec playwright install chromium

# 3. Set env vars and run
export SYNTHETIC_BASE_URL=http://localhost:3000
export SYNTHETIC_ADMIN_HR_ID=<a real local Super Admin HR_ID>
export SYNTHETIC_ADMIN_PASSWORD=<its password>
export SYNTHETIC_ADMIN_TOTP_SECRET=<its authenticator key>
pnpm run synthetic:test
```

Other scripts:

- `pnpm run synthetic:test:headed` — same, with a visible browser window.
- `pnpm run synthetic:report` — opens the Playwright HTML report from the
  last run (`tests/synthetic/report/html`).

Every run also writes:

- `tests/synthetic/report/latest.json` — the typed results (see below),
  one entry per journey.
- `tests/synthetic/report/latest.md` — the same data as a readable table.
- A console summary table printed at the end of the run.

## The typed result format

Each journey produces a `JourneyResult` (`helpers/types.ts`):

```ts
interface JourneyResult {
  journeyId: string;
  journeyName: string;
  route: string;
  role: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  errors: string[];
  consoleErrors: string[];
  networkErrors: string[];
  screenshotPath?: string;   // set automatically on failure
  recommendation?: string;   // plain-English suggested next action, set on failure
  skipReason?: string;       // the reason a check gave when it skipped itself
}
```

### How a run is filed: healthy, warning or failed

`src/lib/synthetic-journeys/overall-status.ts` decides it when the report is saved:

| What the run recorded | The run reads |
| --- | --- |
| Any check failed | failed |
| A check was skipped and gave no reason | warning |
| Nothing passed at all | warning |
| Every check that ran passed, and every skip said why | healthy |

A check that skips itself must say why in the same call — `test.skip(condition, "why")` — and that
sentence is what keeps the run healthy. It is printed under the check on the Synthetic Journeys page
as "Skipped on purpose: …". Until 14 November 2026 any skip made the run a warning, and the one
deliberate skip (the Outstation Expenses export) made every clean run read warning.

### Example report output

```
Synthetic User Journeys — summary

[PASS] Admin shell loads (/admin) — 812ms
[PASS] People Management loads (/employees) — 1204ms
[FAIL] Leave Management (Vacation Control) loads (/leave-management/vacation-control) — 10032ms
   error: Timeout 10000ms exceeded waiting for locator('heading[level=1]:has-text("Vacation Control")') to be visible
   next: The page opened, but something this check looks for never appeared on it. Either that part of the screen is broken or missing, or it was renamed or moved and the check is out of date.
[PASS] Payroll Report loads (/payroll) — 950ms
[PASS] Sales Upload loads (/sales/upload) — 1101ms
[PASS] Sales Normalizer loads (/sales/normalizer) — 980ms
[PASS] Email Templates loads (/admin/email-templates) — 890ms

6 passed, 1 failed, 0 skipped
Full report: tests/synthetic/report/latest.md
```

### The `next:` line — what a failed journey is told to do

The same sentence is stored with the run and printed under the failure on the Synthetic Journeys
page. It is chosen by `helpers/recommend.ts`, first match wins:

| What the run recorded | The advice says |
| --- | --- |
| `page.goto` timed out, or the connection failed | The page did not open in time |
| The app itself answered 401 or 403 | A request was rejected as unauthorized/forbidden |
| The app itself answered 404 | A route or an API it depends on moved or was removed |
| Any other failed call to the app | One or more API calls failed |
| An assertion found two where it expects one (strict mode violation) | The screen gained a second copy; the check is out of date |
| An assertion's element was never found | Something the check looks for never appeared |
| An assertion found a different value (Expected / Received) | The page showed something else |
| A click or fill timed out | A control never became ready |
| The test's own time limit, naming no step | The check ran out of time |

"Timeout: 10000ms" is printed on every failed assertion and means only how long it waited. Until
14 November 2026 that word alone chose "The page did not respond in time", so every failed
assertion was reported as a server that was down. Two things are never counted as the app failing:
a request the browser cancelled itself on navigation (`net::ERR_ABORTED`, a dozen prefetches per
admin page), and an answer from another host. `tests/synthetic-journey-advice.test.ts` holds the
function to the real messages production has recorded.

## How to add a new journey

1. Create `tests/synthetic/journeys/<name>.spec.ts`:

   ```ts
   import { test, expect } from "@playwright/test";
   import { runJourney } from "../helpers/run-journey";

   test("My new page loads", async ({ page }, testInfo) => {
     await runJourney(
       page,
       testInfo,
       { id: "my-new-page", name: "My new page loads", route: "/my-route", role: "Super Admin" },
       async (page) => {
         await expect(page.getByRole("heading", { name: "My Page" })).toBeVisible();
       },
     );
   });
   ```

2. Keep the `check` callback read-only — only assertions, no clicks that
   create/edit/approve/reject/delete/upload/send.
3. If a journey genuinely must mutate something, gate it explicitly:

   ```ts
   test.skip(
     process.env.SYNTHETIC_ALLOW_MUTATION !== "true",
     "Mutating journeys are disabled by default; set SYNTHETIC_ALLOW_MUTATION=true to enable.",
   );
   ```

   and set `mutates: true` in its `JourneyDefinition` for clarity. Always give the reason: a skip
   with no sentence files the whole run as a warning.
4. Run `pnpm run synthetic:test` and confirm it shows up in the summary and
   in `tests/synthetic/report/latest.json`.

## Troubleshooting

- **"Missing required env var SYNTHETIC_BASE_URL" / HR_ID / PASSWORD / TOTP_SECRET** — set
  the missing variable(s) and re-run; nothing ran yet.
- **"SYNTHETIC_BASE_URL points at production. Refusing to run."** — you're
  targeting `phoenix-hr.satopharma.com`. Only set
  `SYNTHETIC_ALLOW_PRODUCTION=true` if you explicitly intend a read-only
  smoke run against production.
- **The `setup` project (authenticate as synthetic admin) fails/times out**
  — usually wrong `SYNTHETIC_ADMIN_HR_ID`/`SYNTHETIC_ADMIN_PASSWORD`, a
  `SYNTHETIC_ADMIN_TOTP_SECRET` that is not the account's current key (its second
  step was reset or set up again), or the account isn't Super Admin, or `SYNTHETIC_BASE_URL` isn't reachable. All
  journeys depend on this step and will show as skipped if it fails.
- **A single journey fails** — check its entry in
  `tests/synthetic/report/latest.md` for the error, console/network errors,
  the screenshot path, and the suggested next action.
