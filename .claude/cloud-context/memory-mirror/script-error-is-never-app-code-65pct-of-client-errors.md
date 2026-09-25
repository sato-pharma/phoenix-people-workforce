---
name: script-error-is-never-app-code-65pct-of-client-errors
description: "A client \"Script error.\" row is the browser's placeholder for a cross-origin script and is never app code — 1,972 rows, 65% of every client error, and it reads exactly like a page crashing in a loop."
metadata:
  type: project
---

`message = "Script error."` in `app_error_events` is the placeholder a browser substitutes when a
**cross-origin** script throws: the spec empties the filename, the line/column and the `Error`
object first. It is **never this app's code**: it serves its own chunks same-origin.

**Corrected 2026-09-09 — "the app loads no third-party scripts" is no longer true.**
`src/lib/google-maps/browser.ts` injects the Maps API on every page with a map, and OneSignal's SDK
loads on the admin profile. Both serve CORS headers, so their throws arrive UNMASKED, with a real
stack — 148 Maps rows and 2 OneSignal rows in the 60 days to that date. A third-party error is
therefore no longer always the masked kind, and `describeThirdPartyStack()` labels the attributable
ones. See [[census-client-errors-by-stack-not-message]].

Measured 2026-09-03 on production: **1,972 rows, 65% of every client error ever recorded, 0 with any
stack**, while the app's own errors carry `/_next/` frames 239 times. Firefox iOS reports it for 32
of its 37 errors.

**Why:** it reads exactly like a crash. One 20-minute session by Maha Metwally (`AI-0015`) wrote 24
rows with `seq` climbing 1→10, which looks like a page failing in a loop. The page was working the
whole time — `readyState=complete`, visible, still in use minutes later. This cost most of a session
before the signature was recognised.

**How to apply:** before treating a burst of these as an outage, check for a stack. No stack, no
filename, `error: null` = unattributable browser noise (extension, content blocker, reader script);
close it. Since PR #3047 only the first per page load is written, and `decodeErrorMessage` relabels
the stored rows in plain English. Its sibling `~#!#~0~#!#~Script error.~#!#~` is the same thing in an
extension's envelope. **Not to be confused with React #418**, which is a real (self-recovering)
app-wide hydration mismatch across 35+ routes. See [[ireports360-timestamps-cairo-local-mislabeled-utc]]
for the zone rule that fix also applied.
