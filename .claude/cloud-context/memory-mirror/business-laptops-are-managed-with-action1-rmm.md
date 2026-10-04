---
name: business-laptops-are-managed-with-action1-rmm
description: "The owner provisions business/company laptops with Action1 cloud RMM — enroll the agent, then run a deep audit (Action1's inventory + patch + vulnerability reports) as a setup step."
metadata:
  node_type: memory
  type: user
  originSessionId: e2748ca7-a0e2-4635-90ba-a7b600355103
  modified: 2026-10-04T13:32:23.365Z
---

When the owner sets up a business laptop he uses **Action1** (cloud RMM / patch management /
endpoint inventory). His remembered method includes enrolling the Action1 agent and then running a
**"deep audit"** — Action1's reports: full hardware + installed-software inventory, missing patches,
and the vulnerability scan. So a "set up a business laptop" request from him should fold Action1
enrollment + deep audit into the steps, not a generic MDM.

This is laptop/fleet provisioning, unrelated to the Phoenix web app or its tablet fleet (which is
Headwind MDM — do not confuse the two).
