---
name: dependabot-security-updates-stay-on
description: "Dependabot security-fix pull requests are ON by the owner's decision (13 Nov 2026, reaffirmed 19 Nov 2026 01:30 Cairo \"Keep them on\") — never report them as against an older \"leave them off\" choice, never switch them off unasked"
metadata:
  node_type: memory
  type: project
  originSessionId: 669bc661-aa40-43c4-8dc4-5df31508390c
  modified: 2026-11-18T23:28:48.106Z
---

Dependabot security updates (`repos/<repo>/automated-security-fixes`) read `enabled: true` on purpose.

- **13 Nov 2026, about 16:00 Cairo:** the owner's audit decisions included "Security-fix pull requests on"
  (`docs/audits/phoenix-crm-integration-audit/16_IMPLEMENTATION_PLAN.md`, ISS-024 · INT-089, read back `enabled: true`).
- **19 Nov 2026, about 01:30 Cairo:** a GitHub audit wrongly reported them as ON "against his 7 Nov decision to
  leave them off", and he said "Turn them off". When shown the 13 Nov decision, he chose **"Keep them on"**. Nothing changed.
- The old reason to keep them off was that a failed Dependabot run withheld the production deploy
  ([[a-failed-dependabot-run-withholds-the-production-deploy]]). That ended on 20 Oct 2026, when Railway's
  Wait for CI went off and `ci.yml`'s release gate (which reads only `checks`) took over.

**Why:** a superseded decision was presented as current, and he nearly reversed his own later choice on it.
**How to apply:** before calling any setting "against his decision", find his LATEST decision on it (the audit
implementation plan's decision table counts) and quote its date.
