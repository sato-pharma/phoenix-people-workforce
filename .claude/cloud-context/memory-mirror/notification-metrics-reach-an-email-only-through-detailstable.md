---
name: notification-metrics-reach-an-email-only-through-detailstable
description: "A sender's notification `metrics` reach the delivered email through `{{detailsTable}}` and nothing else — and an explicitly pinned AUTH template key is VETOED by `migratedTemplateKeyForNotification`, so the first fix for this shipped inert and the codes went out empty twice while every layer reported delivered."
metadata:
  node_type: memory
  type: project
  originSessionId: c4f3871d-39c1-40de-aeda-79c67e3b8667
  modified: 2026-10-08T05:40:00.000Z
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

#5484 gave that send its own key (`password_reset_code`), whose default body the repo
controls — a brand-new key has no stored row, so `mapTemplate` falls back to
`templateDefaults` and production renders the repo's body with no template-data edit.

🔴 **AND IT SHIPPED INERT.** `migratedTemplateKeyForNotification` VETOES an explicitly
pinned auth key — `if (explicit && !isAuthTemplateKey(explicit) && ...)` — so a wording
override can never move account-recovery mail onto another template's recipient expansion.
#5484 added `password_reset_code` to `isAuthTemplateKey` (so a live credential carries no
List-Unsubscribe) and thereby silenced its OWN pin: the send fell straight back through to
`notificationType === "password_reset"` → the link template, and the email went out empty a
second time. Measured by executing the resolver on 2026-10-08: it returned `password_reset`
for the code notification, pin and all.

**Every assertion in #5484 passed, because every one of them read SOURCE TEXT** — the
sender's `templateKey:` line, the registry entries, the template default's own body. Not one
could see that the function in between discarded the pin. The resolver is now exported and
the test calls it; the rule and the shape test (`isPasswordResetCodeNotification`) live in
`.claude/rules/notifications.md` (Templates and the outbox).

The lesson that generalises past email: **when a fix is "pass a value through", the test must
run the thing that routes it.** A chain of source-pattern assertions proves intent at both
ends and nothing about the middle.

Two generalisations worth keeping:

- **Never route a payload the email cannot do without through an admin-editable body.** An
  edit in /admin/email-templates can delete a token with no warning and no test.
- **`NotificationEmailInput.templateKey` beats the notificationType mapping**, so a send
  with its own shape asks for its own key rather than borrowing a sibling's.

Related: [[every-automated-email-also-mirrors-to-the-admin-telegram]],
[[never-fire-bulk-emails-ever]].
