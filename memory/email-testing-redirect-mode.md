---
name: email-testing-redirect-mode
description: Email delivery is intentionally redirected to test addresses during the user's editing/testing phase
metadata:
  type: project
---

As of 2026-05-27 the user is in an editing/testing phase and wants ALL outgoing email
redirected to test addresses, not real recipients.

This is controlled by `systemEmail.forceTestingDelivery` in `src/config/system-settings.ts`:
- `true`  → every email (notifications, password-setup links, HR replies, internal
  messages, excuse decisions) goes ONLY to `systemEmail.testingRecipientFallback`
  (omar.anwar@satopharma.com, achieverrr303@gmail.com, phoenix@satopharma.com).
- `false` → normal delivery to real recipients.

The single send chokepoint is `sendPhoenixEmail` in `src/lib/email/send-phoenix-email.ts`
(`resolveTestingRecipients()` applies the redirect; env `PHOENIX_EMAIL_TEST_RECIPIENTS`
overrides the fallback list when set, and `PHOENIX_EMAIL_DELIVERY_MODE=testing` is an
alternate trigger).

**Why:** if real users ever report "not receiving emails," check this switch FIRST —
it is likely intentionally `true`, not a bug.
**How to apply:** the user will say when testing is done; then flip `forceTestingDelivery`
to `false`. Do not flip it without their go-ahead.
