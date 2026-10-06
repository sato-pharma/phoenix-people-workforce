---
name: a-main-only-check-makes-a-prs-green-meaningless
description: the Playwright login smoke runs ONLY on main, a dispatch and a schedule — never on a pull request — so a PR that renames a label is fully green and the breakage appears after the merge, where it is the production deploy gate; measured 2026-10-07, #5418 renamed the login field to "HR ID, Login ID or Sato email" and three setup files still located it by /HR_ID or Login ID/i, so main went red and THREE merges were withheld
metadata:
  type: project
---

`ci.yml`'s `detect` step emits `heavy`, which is false for `pull_request` — it gates the Build
and the nine heavy steps including **Run Playwright login smoke test**. So a PR can be green on
both required checks (`validate`, `checks`) while carrying a change that breaks sign-in, and the
first run that exercises it is the push run on `main` — which is the Railway deploy gate.

Measured 2026-10-07 (Cairo): #5418 renamed the login field's label from `HR_ID or Login ID` to
`HR ID, Login ID or Sato email`. Three files located that input by its label text —
`tests/e2e/auth.setup.ts`, `tests/e2e/auth.data-user.setup.ts`,
`tests/synthetic/helpers/auth.setup.ts` — so `getByRole("textbox", { name: /HR_ID or Login ID/i })`
matched nothing, the smoke failed on `main`, and Railway marked the deploy **SKIPPED**. #5417 and
#5420 merged behind it and were withheld the same way: **three merges, no production movement**,
production left serving #5416 while `/api/healthz` still answered `status: ok`.

**Why:** a check that cannot run on a PR gives a PR's green a scope the reader assumes is total.
The copy change looked trivial and was reviewed as trivial; nothing on the PR could have caught it.
And the synthetic production smoke passed on that same commit **because production was still
serving the old page** — a green production smoke confirmed the stale revision, not the new code.

**How to apply:** renaming or rewording any label, button or placeholder that a Playwright setup
file touches is a `main`-risk change, not a copy change — grep `tests/e2e/` and `tests/synthetic/`
for the old string before merging it. Locate a form field by its `id` (`page.locator("#login-id")`),
never by label text: the `id` is what `<label htmlFor>` already points at and is the one handle a
wording change cannot move. To prove a fix to a `main`-only step BEFORE merging, dispatch `ci.yml`
on the branch (`gh workflow run ci.yml --ref <branch>`) — a dispatch sets `heavy`, a PR never does.
And when a merge reports green, read `/api/healthz` `revision`: a withheld deploy looks exactly
like a shipped one. See [[verify-the-emitted-artifact-never-the-source]].
