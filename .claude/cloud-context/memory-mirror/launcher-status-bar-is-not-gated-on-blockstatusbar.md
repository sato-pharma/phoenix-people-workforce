---
name: launcher-status-bar-is-not-gated-on-blockstatusbar
description: "9 Nov 2026 — PROVEN on PHX-TAB-0009: the Phoenix launcher's clean status bar / disabled pull-down is NOT driven by Headwind's server blockStatusBar flag; setting it false and restarting the tablet did NOT bring the shade back. Restoring the pull-down needs a launcher rebuild."
metadata:
  node_type: memory
  type: project
  originSessionId: dd58f0ee-c080-4c4d-b6a3-efefe32f1614
  modified: 2026-11-09T03:25:21.895Z
---

9 Nov 2026 (~05:20 Cairo) the owner asked to bring the quick-settings pull-down back on the rep
tablets. Tested the cheap path first on PHX-TAB-0009 (in stock, he was holding it): a temp copy of the
Anti Infective rules (id 4) with **`blockStatusBar:false`**, moved only 0009 onto it, pushed, the tablet
synced (05:19:57), then **restarted** it. Result: **the shade still would not pull down**, before or
after the restart.

**What this proves:** the Phoenix launcher's `Utils.setStatusBarDisabled` + `StatusBarOverlayService`
run **unconditionally** — they are NOT gated on Headwind's server `blockStatusBar` flag. So no server
toggle can restore the pull-down (or show Android's "Privacy reminder" / "Location can be accessed"
lines) on a rep tablet. Only a **launcher rebuild** can — gate the overlay on a config/application
setting, or drop it — and that is BLOCKED behind the suspended fork
([[launcher-fork-account-suspended]]), the same wall as [[tablet-lock-screen-says-not-private]].

There is also no launcher application-setting that governs the bar: config-level `applicationSettings`
is null and app 46 carries none. The bar is pure launcher code.

Cleanup done the same turn: 0009 moved back to config 4, both temp configs (the earlier debugging-test
copy id 6 and this bar-test copy id 7) deleted; no other tablet was ever touched. Beside this:
[[rep-tablet-never-shows-tracking-golden-rule]] (the bar exists to honour Golden Rule #1).
