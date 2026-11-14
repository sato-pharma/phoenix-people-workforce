---
name: the-enterprise-refuses-a-github-token-with-no-expiry
description: "The sato-pharma-phoenix enterprise answers 403 to any fine-grained GitHub token whose lifetime is over 366 days (a no-expiry token included), so every token made for sato-pharma needs an expiry of a year or less; this stranded the workflow watch and the synthetic journeys on 13 Nov 2026."
metadata:
  node_type: memory
  type: project
  originSessionId: 661e96bd-04fa-4b4f-97cc-a593ea9ea6f6
  modified: 2026-11-14T01:07:14.235Z
---

Measured 14 Nov 2026, 03:10 Cairo, with production's own `GITHUB_ACTIONS_DISPATCH_TOKEN` (a fine-grained token, no expiry, token id 22336216 on the owner's account):

- `GET /user` answers 200, so the token itself is alive.
- Any read of `sato-pharma/phoenix-people-workforce` answers **403** with GitHub's words: "The 'sato-pharma-phoenix' enterprise forbids access via a fine-grained personal access tokens if the token's lifetime is greater than 366 days."
- A dispatch answers 403 "Resource not accessible by personal access token".

The limit began to bite between 17:21 and 18:21 Cairo on 13 Nov 2026 (last good read 17:21:01, first refusal 18:21). Who or what switched it on is unread: the enterprise audit log needs `admin:enterprise`, which the laptop's `gh` login does not hold. The organization audit log shows no token or policy event in that hour.

What it stranded: `phoenix-github-workflow-watch` (every hourly read 403) and `phoenix-run-synthetic-journeys` (the 20:17 dispatch 403). The alert's own wording, "the token may be dead, the account suspended or a workflow renamed", names none of this, because the routes never store GitHub's body.

**Why:** a 403 here reads like the 2 Nov suspension or a dead token and is neither. The token is fine; its lifetime is what GitHub refuses.

**How to apply:**
- Any new fine-grained token for `sato-pharma` gets an expiry of 366 days or less. "No expiration" works until the enterprise limit is on, then fails with no warning.
- Changing a fine-grained token's expiry REGENERATES it: the value changes and must be stored again, GitHub secret first (`PHOENIX_ACTIONS_DISPATCH_TOKEN`), then Railway, because the sync overwrites Railway from GitHub. See [[github-actions-cron-secret-went-stale-after-a-railway-rotation]].
- To read GitHub's real reason without printing the token: `railway run --service phoenix-people-workforce --environment production node <script>` from the primary checkout (it is linked to production), with a script that prints only the status and `message`. A dispatch to a ref that does not exist starts nothing: 422 means allowed, 403 means refused.
- While the watch is blind, read the nine checks by hand with `gh api .../actions/workflows/<file>/runs?branch=main&status=success&per_page=1`.

Related: [[github-move-to-omar-3-xx-2026-11-04]].
