---
name: admin-hr-null-super-admin-is-the-health-check-service-account
description: "The second Super Admin row (login admin-HR, hr_id NULL) is the owner's own hourly health-check/synthetic-journey service account — SETTLED, leave active, do not re-raise or deactivate."
metadata:
  node_type: memory
  type: project
  originSessionId: 7017a072-95df-4e50-9533-277a9034cea1
  modified: 2026-10-05T20:50:06.716Z
---

Production `app_auth_users` has TWO active `Super Admin` rows. B-10 is the owner. The second —
login `admin-HR`, name "Phoenix System Administrator", `hr_id` NULL, `email` NULL,
`is_test_persona` false (so the [[a TEST- login is a test account]] explanation does NOT apply) —
is the platform's own **system/automation Super Admin principal**, NOT a human and NOT an orphan.

**Owner ruling 2026-10-05:** "yes, admin-HR is my health-check login — leave it active." Do not
re-raise it as a finding in a Super Admin / access audit, and never deactivate or delete it.

Evidence that makes it unmistakable (read-only investigation, production ref `ozucdzovmcqvepbozvqf`):
- `auth.users.email` = `phx-61646d696e2d6872@auth.phoenix.local` — the hex decodes to "admin-hr"
  (same synthetic scheme as B-10's `phx-...` = "b-10"); not a real mailbox.
- `raw_user_meta_data` carries `merged_into: "B-10"`, `merged_on: 2026-08-19` — the human identity
  was folded into B-10 on 19 Aug; the credential was kept as a pure service principal (hr_id blanked).
  auth.users created 2026-05-09; the current `app_auth_users` row (re)created 2026-08-22.
- 1,527 audit_logs entries, of which **1,250 are "Login succeeded"** — ~27 logins/day, roughly
  hourly, ~1-minute sessions, each from a **different Microsoft Azure egress IP** with a headless
  Chrome UA. (B-10's real sessions come from Egyptian ISP IPs 197.36.x / 102.40.x on real browsers
  incl. the Claude desktop app — a completely different fingerprint.) The 260 "Login failed" rows are
  all in the 19–22 Aug bootstrap window, before the credential was finalized.
- Near-zero mutations: one "Created login account AI-0014" (28 Aug) and a few "Super Admin
  dev-preview: switched into <role>" preview actions. No payroll/sales/bulk writes.

Standing caveat (flagged, owner chose to leave active): it is a real, password-authenticating
Super Admin credential (bcrypt hash, `force_password_reset` false, never locked) logging in from
external cloud IPs dozens of times a day. Its IPs rotate every login (Azure), so IP-allowlisting is
not feasible; the only hardening that survives "leave active" is rotating its password in lockstep
with the runner's secret. Not done — owner's call.
