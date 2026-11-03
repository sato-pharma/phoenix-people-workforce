---
name: dependabot-alerts-first-scan-takes-thirty-minutes
description: "Dependabot alerts went on for gawishtheit/phoenix-people-workforce on 3 Nov 2026; the first scan took about 30 minutes, and until it ended the check said OK on a zero that meant nothing."
metadata:
  node_type: memory
  type: project
  originSessionId: f80f59a1-ff71-4d51-9c13-53b50580ed82
  modified: 2026-11-03T19:30:34.401Z
---

Dependabot alerts on `gawishtheit/phoenix-people-workforce` were switched on by the owner on 3 Nov 2026, seen true at 15:43 Cairo. The new account started with them off, and the settings page briefly still read Off after the API read true.

How the first scan went, all Cairo: alerts true at 15:43, SBOM 404 at 15:43, 1,812 packages by 16:00, 0 alerts until the first ones at 16:11, then 20 open and stable from 16:12 to 16:16.

- GraphQL `dependenciesCount` read 0 on all 33 manifests at 16:00 while the SBOM already held 1,812 packages, so it is not a progress signal. Read the SBOM.
- `scripts/check-dependabot-alerts.mjs` printed "OK — no open alerts (and alerts are switched ON, so the zero was looked for)" at 15:43, before any scan. Pull request 64 makes a zero read the SBOM too: empty or 404 exits 1, unread is "not a pass". A filled SBOM still reads OK with a warning, because 16:00 to 16:11 cannot be told from a finished scan.
- A settled list can still be short: on 16:16 the public advisory database matched `braces`, `sprintf-js`, `uuid`, `esbuild` and `express`, all in the lockfiles at those versions, and none had an alert. Cause unknown.

**Why:** a zero read in that window looks like a clean bill, which is the failure the check was written to prevent.

**How to apply:** after alerts are switched on, on this or any repository, wait for alerts or a filled SBOM before reporting a zero, and cross-check against `gh api advisories?ecosystem=npm&affects=...`. Related: [[github-account-suspended-2026-11-02]].
