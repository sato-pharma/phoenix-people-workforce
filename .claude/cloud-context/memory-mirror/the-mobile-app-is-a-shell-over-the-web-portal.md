---
name: the-mobile-app-is-a-shell-over-the-web-portal
description: "OWNER DIRECTION 2026-09-29: the Expo app is a SHELL over the web portal, not a second UI. Home + every module render the production /employee-portals pages in a WebView; only CRM/login/Profile are native. Never rebuild a portal screen natively — that is the drift this exists to stop."
metadata:
  node_type: memory
  type: project
  originSessionId: ad19fe4d-689f-439a-a7a2-fab162bd5049
  modified: 2026-09-29T00:03:24.911Z
---

🔴 **OWNER DIRECTION, 2026-09-29: "make the app a shell over the web portal."** He saw that the
native app wore the portal's colours over hand-drawn screens (one 310-line `mobile/src/components/ui.tsx`
against the web portal's 24 shared primitives and ~46,000 lines) and called it "a poor awful app while
the web app is SaaS." The resolution is a shell, not a rebuild.

**The rule going forward: NEVER rebuild a portal screen natively.** A native copy of a portal module
is a second implementation of a payroll/leave/sales number, and two implementations of one figure is
exactly the drift `open-module.ts` and the domain-first rule exist to prevent. A module with no native
screen is opened as the production page itself.

**What is native, and stays native:** login, Phoenix CRM (camera, GPS, dictation, and the **offline
outbox** — a web page cannot queue a visit with no signal), and Profile. Everything else is the portal
in a WebView.

**How it works (PR #4701, 2026-09-29):**
- The **Home tab** and a single opened **module** both render through one component,
  `mobile/src/components/portal-web-view.tsx` (extracted from the old `module.tsx`). It mints the
  one-trip hand-off, pens navigation to this server's `/employee-portals` space, and rests on
  `credentials: "omit"` in `mobile/src/lib/api.ts` (the cookie-jar safety; pinned by
  `tests/native-web-handoff.test.ts`).
- **App mode / no double nav:** the GET half of `/api/auth/web-session` sets a non-secret cookie
  `NATIVE_WEB_APP_SHELL_COOKIE` (`phoenix_app_shell=1`, [[src/lib/auth/native-web-handoff.ts]]). The
  portal server shell reads it and `EmployeePortalChrome` drops its own fixed header + bottom nav (and
  their spacers). 🔴 **An ordinary browser never carries the cookie — the web portal is byte-identical
  without it, gate defaults false.** Do not "simplify" by removing the gate; that strips the web
  portal's chrome for everyone.

🔴 **WHAT HOME-AS-PORTAL TRADED:** the old native Home showed a read-only cache of the rep's own numbers
OFFLINE; a web page needs signal, so that offline READ is gone. Reversible in one file (`index.tsx`).
The offline WORK (CRM outbox) is untouched. See [[managed-play-cannot-reach-the-rep-tablets]] for the
delivery side and [[headwind-rep-tablet-custom-launcher-build-required]] for the launcher.
