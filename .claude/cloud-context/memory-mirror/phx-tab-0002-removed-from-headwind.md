---
name: phx-tab-0002-removed-from-headwind
description: "PHX-TAB-0002 (the retired pilot Lenovo) was deleted from the Headwind console on 23 Oct 2026 at the owner's word; reusing it needs a factory reset and a fresh enrolment."
metadata:
  node_type: memory
  type: project
  originSessionId: d7735760-c9fb-428e-8421-9749d472f157
  modified: 2026-10-23T02:20:13.300Z
---

PHX-TAB-0002 was removed from the Headwind console on 2026-10-23 ~05:30 Cairo (owner: "remove the retired PHX-TAB-0002 from the tablet console"). It was Headwind device id 6 on configuration 3, and its custody row had been retired on 22 Oct. `DELETE /rest/private/devices/6` returned HTTP 200, and the fleet now lists only PHX-TAB-0007 and PHX-TAB-0008. A pre-image of the device record is in that session's scratchpad (`headwind-device-PHX-TAB-0002-pre-image.json`), which is ephemeral.

**Why it matters:** the server has `createNewDevices=false`, so if this tablet is switched on it cannot sync or re-create itself. The agent stays device owner on it, but nothing manages it.

**How to apply:** to reuse the tablet, factory-reset it (Power+VolUp recovery) and enrol it again with the configuration 3 QR code. Never treat its silence as a fault.

Related: [[rep-tablet-never-shows-tracking-golden-rule]], [[phx-tab-0007-is-the-first-rep-held-tablet]].
