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
- **API:** `/api/admin/sato-email/{templates,employees,polish,preview,send,media}`, plus the one
  unauthenticated route `/api/sato-email/media/[token]` that serves a body picture to a mail client.
- **Code:** [src/lib/sato-email/](../src/lib/sato-email/) — `service.ts` (the server half),
  `plan.ts` (who it reaches and how it is cut into emails), `render.ts` (the house body),
  `draft.ts` (one parser shared by preview and send), `polish.ts` (the rewrite), `access.ts` (the gate),
  `media.ts` (storing and reading files — server only) and `media-limits.ts` (the ceilings and the
  allowlist, split out so the composer can import them without dragging Node crypto and the
  service-role key into the browser bundle).
- **Migrations:** [`20260912070000_sato_email_composer.sql`](../supabase/migrations/20260912070000_sato_email_composer.sql)
  and [`20260912160000_sato_email_media.sql`](../supabase/migrations/20260912160000_sato_email_media.sql).

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

## The toolbox

Owner 2026-09-12: *"ADD A TOOLBOX EXACTLY LIKE THE ONE IN THE EMAIL COMPOSER TO FEEL LIKE USING
GMAIL OR OUTLOOK AND TRAIN THE AI TOOL ON IT IN WHICH IT UNDERSTANDS WHAT I WANT AND CAN USE EVERY
TOOL"*.

The body is a rich editor with a Gmail-style toolbar — `EmailBodyEditor`, the same component with
the same props the HR reply composer and the email template manager use, so the three screens are
one editor and stay that way. Font, size, **Heading**, line spacing, letter spacing, Arabic
right-to-left, English left-to-right, text colour, highlight, bold, italic, underline,
strikethrough, bulleted and numbered lists, align left / center / **right**, **quote**, link,
**remove link**, table, **insert image**, divider, clear formatting, **undo** and **redo**. The six
in bold were added on 2026-09-12; the rest were there from the start. **Insert image** opens the
file picker on this screen rather than asking for an address — see *Attachments and pictures* below.

Two things about it are not obvious:

- **Heading writes a styled paragraph, not an `<h2>`.** The email sanitizer discards heading tags
  and rebuilds them as `font-size:18px;font-weight:bold`, and the house renderer reads that size
  back to draw the section device — a rule across the page with a small uppercase label under it.
  Setting the style directly means the canvas already shows what will be sent.
- **Paste is plain text, deliberately.** Word and Outlook paste carries markup the sanitizer would
  strip unpredictably, so what you see after pasting is what survives the save.

### The AI presses the same buttons

The rewrite model has no toolbar. The only way it can use a tool is to write the markup that tool
produces, so [`src/lib/email/toolbar-tools.ts`](../src/lib/email/toolbar-tools.ts) holds that
translation once — every control, the phrases a sender uses for it (*"bold the deadline"*, *"put
the dates in a table"*, *"make it Arabic"*), and the exact markup — and the rewrite prompt is built
from it. So a nudge that names a tool works, and the toolbar and the model cannot drift apart:
`tests/sato-email-toolbox.test.ts` reads the editor's own source, extracts every control it
renders, and fails if one of them is not in the catalogue.

The same test sanitizes every taught markup string and asserts it survives. A tool taught markup
the sanitizer throws away would look to the sender like the model ignoring him, which is worse than
a missing feature because nothing reports it.

**Restraint is the instruction.** Colour, highlight, font and font size are used only when the
sender asks for them; a heading only when the announcement genuinely has two sections; a table only
when the draft already holds something with two dimensions. Left alone, a rewrite comes back as
plain paragraphs, one list, and bold on the single thing that must not be missed.

## Rewrite it — the draft in the company's voice

Owner 2026-09-12: *"add ai tool is the new sato composer in which i write what i want and it enhance
rephrase more to the point more corporate"*.

Under the body there is one button. The sender writes the email however it comes out — rough,
half-Arabic, three paragraphs where one would do — presses **Rewrite it**, and gets the same email
back shorter, plainer and in a formal corporate register. An optional one-line nudge beside the
button ("shorter", "lead with the deadline") is passed through on top of the house voice.

It is not a draft generator. There is no "write me an email about X" on this screen, and that is
deliberate: the sender owns what the email says, and the button only owns how it reads.

- **Code:** [src/lib/sato-email/polish.ts](../src/lib/sato-email/polish.ts) — the pure guards at the
  top, the one model call at the bottom. The toolbox it is allowed to use is
  [src/lib/email/toolbar-tools.ts](../src/lib/email/toolbar-tools.ts).
  **API:** `/api/admin/sato-email/polish`, gated by the same
  `canUseSatoEmail` as every other route behind this screen and limited to 10 calls a minute per
  person, because each one holds a server slot for up to a minute of upstream time.
- **Model:** the copilot tier (`gpt-5.4`), not the cheap nano tier the one-sentence rewrites use.
  This is a whole announcement going to a distribution list under the company's name, pressed a
  handful of times a day; holding a multi-paragraph meaning steady while rewriting it is not the
  job the nano tier is calibrated for.
- **Headings become the house section device.** The sanitizer already turns `<h2>`/`<h3>` into the
  bold paragraph that `render.ts` converts into a rule plus a small uppercase label, so a rewrite
  that finds two real sections in the draft gets the journey paper's section device for free.

### It rewrites and formats. It never adds a fact.

🔴 **This is the whole safety story, and it fails closed.** A model asked to make a thin note sound
corporate will reach for the effective date, the policy number, the deadline and the link. On the
one screen that mails a whole distribution list at once, a fabricated date written in confident
prose is far worse than the clumsy sentence it replaced. So the rewrite is measured against what the
sender actually wrote — his subject and his body, markup stripped — and **rejected**, not patched,
when any of these is true:

| Refused | Why |
|---|---|
| a figure that is not in his draft | an invented deadline, amount or time reads as company policy |
| a `[square bracket]` gap that disappeared | those are gaps he fills himself; a filled one states as fact something nobody decided |
| a link he did not write | an invented URL in a company-wide email is phishing-shaped |
| an image address he did not write | a picture loads without a click, so a minted `src` needs the same guard as a minted `href` |
| any mention of AI, GPT or a model | owner rule 2026-08-04 — a user never learns a model was involved |
| an empty subject or body | a blank email is a worse answer than a button that says "try again" |

A refusal names what it caught and tells the sender to press it again or send his own words. He is
standing in front of the button; nothing is lost.

Two more things are cleaned rather than refused, because neither changes meaning: a sign-off the
**sender did not write** is stripped (the composer has its own Signed field and the house frame
prints it, so a second one signs the email twice), and the body goes through
`sanitizeEmailTemplateHtml` like every other body, so a rewrite can only ever carry markup the
design knows how to render.

**Nothing is saved and nothing is sent.** The rewritten wording lands back in the same two fields
the sender was already editing, the preview is invalidated with it — so a recipient count on screen
can never belong to the older draft — and **Put my words back** restores his own text exactly,
because it never left the browser. The panel closes the moment he edits anything, since undoing
past his own edits would throw them away.

All of it is pinned by `tests/sato-email-polish.test.ts`, and the toolbox half by
`tests/sato-email-toolbox.test.ts`.

## Attachments and pictures

Owner 2026-09-12: *"make an option to attach pic or file and to put pic in message body"*.

Two different things, built as two different things, because their exposure is not remotely the same.

| | **Attach a file** | **Put a picture in the body** |
|---|---|---|
| How it travels | inside the message, base64'd into the provider call at send time | it does **not** travel — the recipient's mail app fetches it over plain HTTP, days later |
| Who can reach it | only the people the email went to | **anybody holding the link**, for as long as the email exists |
| Address | none | a permanent `/api/sato-email/media/<token>` URL, unauthenticated by construction |
| Accepts | pictures, PDF, Word, Excel, PowerPoint, CSV, plain text | pictures only — JPEG, PNG, GIF, WebP |

🔴 **A body picture is public. That is not a shortcut, it is how email works.** Gmail fetches a body
image through its own proxy, carrying nobody's cookie; Outlook fetches it straight from the web. There
is no session to check and never will be, and a signed URL is the wrong instrument because it expires
while the email does not — the picture would quietly become a broken box in a mail already sent. So
the composer says so on screen, beside the button: **put company documents in the attachments, not in
the body.**

The bucket itself is private and the caller never names a path. The only input the public route takes
is a token, and the lookup states `kind = 'inline'` — an attached contract has no token at all, and
could not be opened even if a future bug minted it one. That is the same rule the marketing
share-file route already states: accepting a path, even a signed one, would turn a file route into a
read primitive over the bucket.

**SVG and HTML are refused, in both halves.** Both carry script, and the token route serves from this
application's own origin.

### The limits, and why they refuse rather than drop

**10 MB per file, 10 MB per email, 10 files.** Not arbitrary: Resend carries the mail normally and
takes 40 MB, but mail fails over to Brevo on a quota or auth error — the bad day — and Brevo rejects
any message over 10 MB. Taking the smaller of the two means a send behaves identically whichever
provider carries it, and `tests/sato-email-attachments.test.ts` fails if the constant ever rises
above Brevo's limit.

🔴 **Over budget REFUSES the send. It does not drop a file and send anyway.** `guardAttachments()` in
`send-phoenix-email.ts` silently omits an over-budget attachment and sends the mail regardless, which
is a reasonable default for a system notification and the worst possible behaviour here: *"the new
policy is attached"* reaching a whole distribution list with nothing attached cannot be recalled, and
nothing on screen would ever have said so. On this screen the budget is checked at **preview** time,
beside the recipient count, and the **Send** button is disabled — not warned beside — while it is
over. It is checked again at send, because the preview is a courtesy and the server is the boundary.

A file whose row has gone is a refusal too, never a quiet skip, and the refusal lists **which** files
so the sender can see what to remove.

### The rest of the handling

- **Filenames are rebuilt, never trusted.** Path separators and control characters are stripped and
  the extension is forced to the one the content type maps to, so `salary.pdf.exe` leaves as
  `salary.pdf`.
- **The attachment list is part of the idempotency key.** A send that failed, had a file removed and
  was pressed again is a different email, and must not be swallowed as a duplicate.
- **Uploading writes an audit row** (`sato_email_media`) — its own entity type rather than a field on
  the send row, because an inline picture is handed a permanent public address before any mail exists
  at all, and who minted it should be answerable later.
- **Rate limited** to 30 uploads a minute per person, and the per-file ceiling is checked before the
  bytes are read into memory.
- **A body picture cannot be tested on a local dev server.** `sanitizeEmailTemplateHtml` allows
  `<img>` on the `https` scheme only, and localhost is `http`, so the tag is stripped on save. That is
  the rule working, not a bug — verify it on staging or production.

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
| **From** | `Sato Pharma <hrbp@satopharma.com>` — the display name is the company, and the address is the HR Business Partner's mailbox whoever pressed Send (owner 2026-09-12). It is the one apex-domain From in the system, and it delivers only because `satopharma.com` is itself verified in Resend. |
| **Reply-To** | `omar.anwar@satopharma.com`, the owner's mailbox, for every sender (owner 2026-09-17). Never keyed on the sender's seat: a seat with no entry fell through to the suppressed `phoenix@satopharma.com` and its replies bounced (2026-09-13). |
| **Visible To** | with more than one recipient everyone real is on Bcc, and the To line reads `hrbp@satopharma.com` — the From mailbox, passed as `fanoutVisibleTo`, *not* the Reply-To that `sendPhoenixEmail` otherwise puts there. So a reply reaches the owner while the To line a recipient reads stays HR's. |
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
