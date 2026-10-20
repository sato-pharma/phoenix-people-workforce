---
name: a-managers-own-visit-never-requires-gps-or-a-live-photo
description: "owner 2026-10-20 \"NO NEVER 1 OR 3 IN MANAGERS VISIST\" - a district manager's own single visit (phoenix_crm_manager_visits, vacant area included) is NEVER refused for a missing GPS point and NEVER made to carry a live photo; the typed-address-or-location rule of 2026-10-19 stands. Never re-propose either."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 04c0876e-2229-41d6-bfdc-417e49af5390
  modified: 2026-10-19T23:56:57.549Z
---

A district manager's own visit in Phoenix CRM (My single visits, `phoenix_crm_manager_visits`, vacant-area
visits included) must NEVER be made to require a phone GPS point, and NEVER be made to require a live
camera photo. The 2026-10-19 rule stays: a vacant-area visit needs a typed address OR a captured
location, one or the other.

**Why:** owner, 2026-10-20 ~00:30 Cairo, after reviewing Mina Farouk's (B-116) five vacant-area visits of
19 Oct — four carried GPS, the fifth (نرمين عفت, 23:03) only a typed address. Offered three options
(require GPS on DM visits · stamp IP and phone browser · live photo when no GPS), he answered: "NO NEVER
1 OR 3 IN MANAGERS VISIST".

**How to apply:** never propose, plan or build a GPS requirement or a live-photo requirement on a
manager's own visit, and never put either in a `Next step:` line. Option 2 (IP + browser stamp) was not
ruled on — and it adds little: `app_sessions` already records `ip` and `user_agent` per login, so the
login and phone behind any visit are read by joining the visit's `captured_at` to the session window.
Egyptian mobile IPs are carrier-shared (one IP served 5 employees in 30 days), so an IP is never a
location. Related: [[the-evidence-photo-is-the-primary-source-of-trust]].
