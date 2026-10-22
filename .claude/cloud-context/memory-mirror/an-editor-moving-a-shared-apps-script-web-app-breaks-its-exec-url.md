---
name: an-editor-moving-a-shared-apps-script-web-app-breaks-its-exec-url
description: "A sheet's /exec URL runs a saved VERSION, not HEAD — and moving the Direct Orders web app (owned by another Google account) as achieverrr303, an editor, turned it into HTTP 403 'Access denied' for every caller on 22 Oct 2026; moving it back did not undo it, so only the owning account's own redeploy repairs it (PR #6244 makes the push read-only there)."
metadata:
  node_type: memory
  type: project
  originSessionId: 8c6131ff-1e7d-4e7e-9413-f7aa4840d87e
  modified: 2026-10-22T01:38:52.460Z
---

On 22 Oct 2026 the three live-sheet web apps were read: Direct Orders on version 5 (5 Aug),
Marketing Requests on version 3, CV Lifecycle on version 1. `push-apps-script.mjs` had only ever
written HEAD, which the sheets' one-minute triggers run; Phoenix's instant pings hit the `/exec`
URLs, which run the saved version. PR #6244 makes the push create a version and move the ONE
versioned web-app deployment (same id, same URL), needing `script.deployments` in the CI grant.

**The trap:** at 04:28 Cairo the Direct Orders deployment was moved 5 -> 6 with this laptop's clasp
login `sheet-owner` = achieverrr303@gmail.com, an EDITOR on that project (its owner is 303.xxxx.303@gmail.com, read from the Drive owner of the bound spreadsheet "Direct Orders by PHX"; a third
account — neither local clasp login, `default` is omarrr.g.3003@gmail.com). The `/exec` at once
answered HTTP 403 "Access denied — you need permission" (Drive page) to the right secret and to a
wrong one. Moving it back to version 5 the same way did not restore it. Marketing (achieverrr303's
own project) moved 3 -> 4 the same minute and answered "ok".

**Why:** the deployment's identity follows whoever updated it, and Google refuses that web app when
the updater is not the owner.
**How to apply:** never move a deployment in a project the acting account does not own — the
manifest's `moveWebApp: false` on direct-orders enforces it in the push. The repair is the OWNING
account's Deploy -> Manage deployments -> Edit -> Version: New version -> Deploy. Deployment reads
are briefly inconsistent after an update (a list can show the old version for a minute); trust the
update's own response. Related: [[a-google-apps-script-caller-cannot-be-traced-to-an-account]],
[[live-sheet-gs-is-pasted-by-hand-and-needs-a-style-bump]].

Resolved 22 Oct 2026 04:50 Cairo: the owner redeployed from 303.xxxx.303 as version 7 (same deployment id); the /exec answered "ok" to the live secret and the push --check read all three web apps current.
