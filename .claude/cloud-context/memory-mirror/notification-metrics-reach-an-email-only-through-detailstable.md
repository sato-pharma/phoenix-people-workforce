---
name: notification-metrics-reach-an-email-only-through-detailstable
description: "A sender's notification `metrics` reach the delivered email through `{{detailsTable}}` and nothing else, so a template body missing that token drops the payload while the code row, the outbox and the provider all report success — three reset codes were `delivered` into Sato mailboxes with no code inside them."
metadata:
  node_type: memory
  type: project
  originSessionId: c4f3871d-39c1-40de-aeda-79c67e3b8667
  modified: 2026-10-08T01:22:31.924Z
---

`createSystemNotification({ email: { metrics: [...] } })` hands its label/value pairs to
exactly one template token: `{{detailsTable}}` (`renderPhoenixMetadataTable` in
`src/lib/notifications/email.ts`). No other token carries them. So a template body that
does not contain `{{detailsTable}}` sends the email WITHOUT the data the sender put in it,
and nothing anywhere goes red.

Measured on production 2026-10-07/08. The self-service reset code (#5418) passed its six
digits as the `"Your code"` metric and let the `notificationType` mapping pick the template,
which resolves to the SHARED `password_reset` key. That key's stored row — last edited
2026-08-19, months before the feature existed — is the admin LINK email: *"To create a new
password, please click the link below"*, `{{ctaUrl}}`, `{{expiryText}}`. No
`{{detailsTable}}`, and the repo default for that key has none either.

Every layer reported health: 3 `password_reset_codes` rows written, 3 `notification_outbox`
rows `sent`, and the Resend webhook recorded `email.delivered` to each Sato mailbox. The
tell was one column — `attempts = 0` on all three, nobody had entered a code — and the one
row with a `consumed_at` had been superseded by a resend, not used. **An email the provider
calls delivered can still be empty of the only thing it exists to carry.**

Fixed in #5484 by giving that send its own key (`password_reset_code`), whose default body
the repo controls: a brand-new key has no stored row, so `mapTemplate` falls back to
`templateDefaults` and production renders the repo's body with no template-data edit. The
rule now lives in `.claude/rules/notifications.md` (Templates and the outbox), and
`tests/password-reset-code-email-carries-the-code.test.ts` renders the real body through
`interpolate` + `contextVariables` and asserts the digits appear.

Two generalisations worth keeping:

- **Never route a payload the email cannot do without through an admin-editable body.** An
  edit in /admin/email-templates can delete a token with no warning and no test.
- **`NotificationEmailInput.templateKey` beats the notificationType mapping**, so a send
  with its own shape asks for its own key rather than borrowing a sibling's.

Related: [[every-automated-email-also-mirrors-to-the-admin-telegram]],
[[never-fire-bulk-emails-ever]].
