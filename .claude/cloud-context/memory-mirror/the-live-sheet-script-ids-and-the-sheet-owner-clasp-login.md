---
name: the-live-sheet-script-ids-and-the-sheet-owner-clasp-login
description: "The four live sheets' Apps Script ids (proven 22 Oct 2026 by pulling each and finding it byte-identical to its repo copy) and the laptop's `clasp -u sheet-owner` login as achieverrr303; `clasp list-scripts` cannot see sheet-bound projects; Script Properties are shared by every version, so a temporary HEAD push whose timer sets a property rotates a secret with no editor."
metadata:
  node_type: memory
  type: reference
  originSessionId: 03486b16-34ba-44b4-af4e-c44a32696de1
  modified: 2026-10-22T01:21:04.756Z
---

**Ids, proven 22 Oct 2026 ~04:10 Cairo** by `clasp pull` of each candidate and a byte-compare with the repo copy (never by project name):

| Sheet | Script id | Repo copy |
| --- | --- | --- |
| Master Map ("Master Map sync") | `1kK8DaDPXJvwG6vM1x_gv9X7zxqbvvAbEco9bnsGc4xLD2dHK_SzYN3SS` | `google-apps-script/master-map/Code.gs` |
| Direct Orders ("Untitled project", owned by another account, shared) | `1pfWmzGrFFZk2XO_8EolyBh4Mz7IQ9baxh2mDPkV3nc60WTvJDgH6U31h` | `docs/direct-orders-live-sheet.gs` |
| Marketing Requests ("Phoenix Marketing Sheet") | `1TfJn-2C3I1DmLqcmetkeAPpaGzvu7_YLOiDelTAykGGC1jhapUU_cj2h` | `docs/marketing-request-live-sheet.gs` |
| CV Lifecycle ("CV Lifecycle") | `1cB4GjLX0-IZsabC48Opuyc2uwz91tBfwFvZ3XEG-MRz6-LchFoumzkER` | `docs/cv-lifecycle-live-sheet.gs` |

**The login.** The owner signed clasp 3.4.1 in on 22 Oct as **achieverrr303@gmail.com** under the user name `sheet-owner` (`node %APPDATA%/npm/node_modules/@google/clasp/build/src/index.js -u sheet-owner …`). The `default` user is omarrr.g.3003@gmail.com, which gets "The caller does not have permission" on these projects. Its scopes have no `script.processes`, so the recent-runs list is refused.

**Finding an id.** `clasp list-scripts` lists only standalone Drive scripts, never a sheet-bound project; it showed 3 unrelated ones. The ids are in the row markup of script.google.com/home/my and /home/shared, read through Claude in Chrome (his session). List order there matches the row order.

**How a secret was rotated with no editor.** Script Properties are shared by every version of a project: the deployed web app (`doPost`, a frozen version) and the time-driven trigger (runs HEAD) read the same store. So:
1. Push a temporary HEAD whose timer function first stores the new value.
2. Wait until the web app accepts it.
3. Switch Phoenix.
4. Push the original back. The property stays.

Used for the Master Map token and the three `*_SHEET_REFRESH_WEBHOOK_SECRET`s.

**Traps from that night:**
- **The Direct Orders web app runs an OLDER version than HEAD.** A correct-secret POST crashes with "You can't merge frozen and non-frozen columns", but only after the secret check, so "accepted" = "ok" OR an `Exception:` page. Phoenix's instant ping has been dead since then, and the 1-minute timer covers it. A fix session was opened (the pusher never updates the web app deployment).
- **A pristine folder's `.clasp.json` vanished mid-run** (cause unknown), and the restore push failed with "Project settings not found", leaving the temporary script, with the token written into its code, live for 2 minutes. Always re-check `.clasp.json` and read the live script back after restoring.

Related: [[master-map-sheet-live-on-prod-2026-08-17]], [[a-google-apps-script-caller-cannot-be-traced-to-an-account]].
