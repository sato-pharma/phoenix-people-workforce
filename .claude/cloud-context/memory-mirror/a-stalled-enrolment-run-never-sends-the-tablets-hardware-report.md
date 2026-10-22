---
name: a-stalled-enrolment-run-never-sends-the-tablets-hardware-report
description: "A new Headwind tablet that long-polls but shows lastUpdate \"never\" has a stalled first run; only a restart (or the MDM agent's own home screen) sends the serial/IMEI report Phoenix's Add to custody needs — the hourly update never does."
metadata:
  node_type: memory
  type: project
  originSessionId: c29197d2-a532-44ff-a422-13b4f76de2d7
  modified: 2026-10-22T03:51:11.469Z
---

PHX-TAB-0008 (enrolled 22 Oct 2026 06:32 Cairo) long-polled every ~66 s but its device row kept
lastUpdate "never" and no model/serial, so Phoenix's **Add to custody** button (it needs
`row.unregistered && serialNumber ?? imei`) never appeared.

The device log ended the enrolment run at "Silently installing app com.carriez.flutter_hbb" — no
"installed successfully", no "Update flow completed". In the launcher source (fork and upstream):
- the hardware report (`SendDeviceInfoTask`) and the 15-minute report worker
  (`SendDeviceInfoWorker.scheduleDeviceInfoSending`) are started ONLY by the background
  `onConfigUpdateComplete` in `Initializer.startServicesAndLoadConfig` (enrolment and boot) or by
  the agent's own `MainActivity`;
- the install loop advances only when the install-complete broadcast arrives, so a lost broadcast
  stalls the run before `lockRestrictions()` (restrictions + FRP are not re-applied either);
- the hourly `PushNotificationWorker.forceConfigUpdateWork` and a pushed configUpdated run
  `ConfigUpdater` with a NULL notifier, so they never send the report.

**Why:** under the stock home (Quickstep) MainActivity never runs, so a stalled first run means the
tablet never reports, however long you wait.
**How to apply:** a new tablet with lastUpdate "never" after ~15 min → have it restarted (hold power →
Restart). Boot reruns the full run; with every config-3 app already installed or filtered, the loop
ends at once and the report lands within a minute. Related: [[phx-tab-0007-is-the-first-rep-held-tablet]].
