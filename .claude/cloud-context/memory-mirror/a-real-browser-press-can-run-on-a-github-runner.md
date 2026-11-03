---
name: a-real-browser-press-can-run-on-a-github-runner
description: "When the laptop's memory floor stops a dev server, a one-off job on a throwaway branch runs next dev and Playwright on a GitHub runner against staging only."
metadata:
  node_type: memory
  type: reference
  originSessionId: 0c04efb3-07cb-4951-a5b4-067a48ed21f3
  modified: 2026-11-03T19:38:56.502Z
---

The laptop's safety stop ended a local page compile twice on 3 Nov 2026 (free memory fell to 2,018 MB), and hosted staging serves an old revision with `/api/dev-auth` answering 404. A workflow on a throwaway branch with no pull request did the press instead, about 10 minutes a run. Copies of both files: `~/.claude/docs/visit-press-2026-11-03/` (`visit-press.yml`, `press.mjs`). Used for [[visit-retry-post-deploy-reads-owed-2026-11-03]].

**What keeps it safe:** `STAGING_SUPABASE_SERVICE_ROLE_KEY` and no email, Telegram or WhatsApp keys. A step decodes the anon key and refuses unless its ref is staging and its role is anon. Read that key from `ci.yml` at run time; written into a commit it trips gitleaks' `jwt` rule. Merge the code under test into the throwaway branch, and delete the branch afterwards.

**What made it work:**
- `PHOENIX_DEV_HEAP_MB: "5632"`. At the launcher's 4,096 MB cap the server restarted mid-run and pages stalled.
- A warm-up step that compiles the pages with curl before the press.
- One rep per day of off-plan presses: two are allowed, then the form stops. `dev-auth` answers 409 when the role and hr id disagree; read `app_auth_users` on staging first.
- `context.setOffline(true)` to cut the network; `page.route` to stage a refusal, so no visit is saved.
- Decide a landing from local storage and the day's own count. "The text went away" also happens while the page reloads, and that gave one false "landed".

**Reading what it says (3 Nov 2026, the HR Operations Specialist's account):**
- A `/hr/...` page answering plain-text 500 with `Failed to proxy ... socket hang up` in the server log is `next dev`'s proxy dropping during a slow compile or a heap restart. The same page answered 200 through `/hr` once compiled. It cost three runs and a wrong first explanation, so read that log line before calling a page broken, and prove it by opening the page again after it compiled.
- `ERR_CONNECTION_REFUSED` or `chrome-error://chromewebdata/` is the server restarting at its heap cap, even at 5,632 MB, after about four heavy pages. Press few pages per run.
- A permission `redirect()` after the `(admin)` loading shell answers 200 and moves on the client, more than 6 seconds later on a cold server. Use `page.waitForURL` with a long timeout; a fixed wait read Milestones and Spotlight as open when both send her home.

**The SFE press, 3 Nov 2026, nine runs and no feature defect** (copy: `~/.claude/docs/sfe-press-2026-11-03/press.mjs`). Each of these stopped a run:
- `dev-auth` without `loginId=` signs in as `dev.preview`, and a write with a foreign key to `app_auth_users` answers 500 (23503). Pass the real login id.
- `dev-auth` with no `hrId` gets no CRM viewer, so a Super Admin preview is sent home. Pass a real HR id. `next=/admin` for a Super Admin is the heaviest page there is and restarted the server; send `next` to the page under test.
- Waiting for "a hydrated button" passes on the sidebar before the page's own table is ready. Wait on the control you are about to click.
- A page draws a hidden phone card and a desktop row, and the card comes first in the DOM. Use `table:visible`.
- A filter on a row's buttons moves to the next person when a question replaces them. Hold a row with `nth`.
- `innerText` returns CSS uppercase, so "Prepared" reads "PREPARED". Match case-insensitively.
- `CrmSelect` is a search box, so it has no `option` list to read.
- Staging holds no polyclinics. Seed one for the run and delete it in `finally`.

**Tooling traps:**
- Commit and push in separate commands so the secret scan sees the commit.
- Removing the press's worktree (3 Nov 2026): `git worktree remove` left the folder behind, holding a `node_modules` junction to the PRIMARY's `node_modules`. Never delete that folder recursively. `cmd /c rmdir` on the junction takes the link only; then check the primary's `node_modules` is still whole.
