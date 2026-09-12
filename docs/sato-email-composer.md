# Sato Email Composer

Shipped 2026-09-12. The one screen in Phoenix where a person writes an email to a named audience and
sends it wearing **the company's** identity rather than the app's.

Owner 2026-09-11: *"Create a new email composer. Link it. The templates... and link to those
distribution lists. This module would be accessible for HR business partner and the system
administrator... the identity, you will use the Sato identity, not the phoenix."*

It sits **beside** the older HR reply composer at `/admin/email-reply-composer`, which is deliberately
untouched — different job, different audience, different identity. Nothing about that one changed.

## Where it lives

- **UI:** `/admin/sato-email` (Super Admin) or `/hr/admin/sato-email` (HR Advisory — the same page,
  rewritten into the HR shell by `isHrRewritablePath`, so there is no second page file).
- **API:** `/api/admin/sato-email/{templates,employees,preview,send}`.
- **Code:** [src/lib/sato-email/](../src/lib/sato-email/) — `service.ts` (the server half),
  `plan.ts` (who it reaches and how it is cut into emails), `render.ts` (the house body),
  `draft.ts` (one parser shared by preview and send), `access.ts` (the gate).
- **Migration:** [`20260912070000_sato_email_composer.sql`](../supabase/migrations/20260912070000_sato_email_composer.sql).

## Who may use it

`canUseSatoEmail(access)` — **Super Admin** (via `canAccessSystemAdministratorWorkspace`) and
**HR Advisory**, which is the role key for the job title "HR Business Partner". Nobody else, and
every route behind the page asserts the same predicate: the redirect on the page is presentation,
never the boundary.

Both seats may address **any switched-on distribution list**, the owner's explicit answer when asked
whether the big lists should be restricted. Editing a list's *rules* is a separate and much narrower
right — see [Distribution Lists](distribution-lists.md).

## Writing the email

**Two modes, one toggle**, which is what the owner asked for — *"I'm able to also flip that so I can
use a fixed email template or I can free type the email I want"*:

- **From a fixed template** — one of the Sato templates in `sato_email_templates`. These are a fresh
  set belonging to this module; they are **not** the admin email-template catalogue that automated
  notifications render from, and no system event ever sends one. Six ship seeded (general
  announcement, public holiday, policy update, meeting invitation, welcome a new colleague,
  reminder), with `[square-bracketed]` parts for the sender to fill in. Both seats can edit them
  from the Templates panel on the same screen; every edit writes a **required** audit row
  (`sato_email_template`), because it happens before any mail and a lost edit would be invisible.
- **Free-typed** — the sender writes the subject and body themselves.

Either way the body is rendered into the Sato house design before it goes.

## Choosing the audience

Any mix of **distribution lists** (checkboxes, switched-on lists only) and **named individuals**
(search by name, added as chips). Duplicates across the two are collapsed once, by lowercased email.

**Recipients never see each other.** The owner was asked and answered *"No, keep them hidden"* — so
every send goes out Bcc-style via `fanoutToBcc: true`. A leaver is never on a list: the directory the
resolver reads has already dropped leavers and system consoles.

## Sending

Nothing sends on one click. The flow is **Preview → see the exact recipient count → confirm → Send**,
and any edit to the draft invalidates the preview so the count on screen can never describe a
different email from the one that goes out (preview and send parse the draft through the same
`parseSatoEmailDraft`).

| | |
|---|---|
| **From** | `Sato Pharma <…>` — the display name is the company; the address stays on the verified sending subdomain, because an apex-domain From is rejected or filed as spam. |
| **Reply-To** | the sender's own seat address — HR Advisory replies land on `hrbp@satopharma.com`. |
| **Batching** | at most **25 recipients per email** (`SATO_EMAIL_MAX_PER_EMAIL`). Not an arbitrary number: it is what `validateManualEmailRecipientPolicy` already caps a hand-written email at, so every message this composer sends passes that existing check unchanged. The alternative — raising the cap for this screen — would have raised it for the older HR reply composer too, and nobody asked to widen that one. |
| **Audit** | one best-effort `sato_email_send` audit row plus a `sato_email_sends` table row, both written *after* the mail has gone. Deliberately not `writeRequiredAuditLog`: the mail is already out, and throwing at that point would report a failure for a send that succeeded. |

### It does not bypass the Notification Confidence Gate, and it does not trip its fan-out check

The gate still runs on every send and still records. What the send does **not** pass is an `origin`,
which is what the gate's fan-out check keys on — so that check is not applicable rather than
suppressed. And `bypassConfidenceGate` is **never** set here; that flag is internal to
`confidence-gate.ts`, for a Super Admin re-sending already-reviewed held content.

That split is the owner's ruling, in his words: *"i meant in automated emails must be a guard but in
composer its manual email by human."* The brake exists to stop an **automated** job silently mailing
hundreds of people; a human who has just read the recipient count and pressed a confirm button has
already done what the brake is for.

Both halves are pinned by `tests/sato-email-lists-only-composer.test.ts`, which fails if the send
call ever gains an `origin`, gains `bypassConfidenceGate`, or loses `fanoutToBcc: true`.

## The distribution lists belong to this module and nothing else

Owner 2026-09-11: *"I don't want this distribution list to be linked with anything except the email
composer that you will build."* Two things were unhooked the same day, and **neither changed who
receives anything**:

- The **Monthly Closing publish Cc** reads its three fixed roles (CEO, Marketing Manager, SFE
  Manager) from code again rather than from the `closing_fixed_cc` list, which is dropped by this
  module's migration.
- The **older HR reply composer's** "HR Team" and "Finance Team" groups are back on their original
  job-title substring match.

The same test pins that: a file outside its allowlist calling a distribution-list resolver fails the
suite. See [Distribution Lists](distribution-lists.md).

## When the deploy lands before the migration

`sato_email_templates` and `sato_email_sends` are read behind a missing-table guard that treats
`PGRST205` and `42P01` as one state, and the page catches a failed options load. In that window the
composer still works on free-typed wording and says why the templates are absent, rather than 500ing
the whole screen — see `AGENTS.md` §2.1, *a missing TABLE answers `PGRST205`, NOT `42P01`*.
