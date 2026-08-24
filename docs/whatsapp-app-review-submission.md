# WhatsApp App Review — submission pack

Everything needed to submit Phoenix HR Workforce for **Advanced Access** on
`whatsapp_business_management` and `whatsapp_business_messaging`, which is the gate standing between us
and WhatsApp **Coexistence** (linking the owner's handset number into the recruitment intake without
disconnecting WhatsApp on the phone).

Written 2026-08-24, after the coexistence flow was built, shipped and then refused by Meta.

## Why this is needed (read this before anything else)

`/whatsapp-connect` is **live and working** — it loads Meta's SDK and opens Meta's dialog. Meta itself
refuses the onboarding step with *"Phoenix HR Workforce can't onboard customers at the moment."*

The cause is a Meta policy gate, not our code. Meta's own requirements page for onboarding an existing
WhatsApp Business app number states: **"You must already be a Solution Partner or Tech Provider."**
Tech Provider status in turn requires App Review for **Advanced Access** on the two permissions above.
We currently hold **Standard Access**.

> An earlier session recorded that Tech Provider was "almost certainly not required" for our own number,
> inferred from a dashboard tooltip. **That was wrong**, and the live run disproved it. Do not re-derive
> it from tooltips — the requirements page for the specific flow is the authority.

**Honest risk on this submission.** "Tech Provider" is designed for companies that onboard *other*
businesses onto WhatsApp. Sato Pharma is an end business onboarding *its own* number, which is an
awkward fit for the category, and Meta may push back on that basis. This submission is worth making —
it is the only route to the goal that keeps WhatsApp working on the handset — but it is **not a
formality, and approval is not guaranteed.** If it is refused, the fallback positions are unchanged:
keep the already-connected business number `+20 10 98500699` as the automated funnel (this works today
and needs nothing), or migrate the handset number to Cloud API (**rejected by the owner** — it signs
WhatsApp out of the phone).

## Prerequisites checklist

| # | Item | State |
| --- | --- | --- |
| 1 | Business verification — SATO PHARMA (`2447906605705551`) | ✅ Done (2026-08-23) |
| 2 | App published / Live — Phoenix HR Workforce (`1725159208692148`) | ✅ Done |
| 3 | App icon, category, privacy URL | ✅ Done |
| 4 | **Terms of Service URL** — was the `facebook.com` placeholder | ⏳ `/terms` page built; set the URL after it deploys |
| 5 | WABA + connected number — "Sato Pharma HR Team", `+20 10 98500699` | ✅ Live, webhook receiving |
| 6 | Screencast 1 — sending/receiving a message via the API | ⏳ Owner records (script below) |
| 7 | Screencast 2 — creating a message template | ⏳ Owner records (script below) |
| 8 | Written justifications | ✅ Below, ready to paste |

Do **not** retry the phone onboarding flow until access is granted — it cannot succeed, and Meta counts
onboarding attempts (default cap 10 per rolling 7 days).

## Written justifications (paste verbatim)

### `whatsapp_business_messaging`

> Sato Pharma Egyptian Pharmaceutical Company uses this permission to operate the recruitment inbox of
> its internal HR platform, Phoenix HR Workforce.
>
> Job candidates apply for advertised positions by sending their CV to our WhatsApp Business number. We
> use this permission to receive those inbound messages and their document attachments through our
> webhook, so each application is filed automatically against the correct vacancy in our recruitment
> module instead of being transcribed by hand, and to reply to the candidate about the status of their
> own application within the customer service window.
>
> All messaging is one-to-one and application-related: acknowledging that a CV was received, asking a
> clarifying question about the application, and arranging interviews. We do not send marketing or
> promotional messages, we do not send bulk or unsolicited messages, and we do not share or sell
> candidates' phone numbers. The candidate initiates every conversation by contacting us to apply, and
> can end it at any time. Our handling of this data is described at
> https://phoenix-hr.satopharma.com/privacy and https://phoenix-hr.satopharma.com/terms.
>
> The platform is used only by Sato Pharma's own HR and Talent Acquisition personnel. It is not offered
> to other businesses.

### `whatsapp_business_management`

> Sato Pharma uses this permission to manage its own WhatsApp Business Account ("Sato Pharma HR Team"),
> which serves as the recruitment inbox for the Phoenix HR Workforce platform.
>
> Specifically, we use it to: subscribe our application to the WhatsApp Business Account so inbound
> candidate messages are delivered to our webhook endpoint; read the status and configuration of our own
> registered phone numbers so the platform can surface an accurate health check when message delivery
> fails; and create and manage the message templates used to acknowledge applications and arrange
> interviews.
>
> We are additionally requesting this permission to complete WhatsApp Coexistence onboarding for a second
> number that our company already owns and operates on the WhatsApp Business app. Candidates have applied
> to that number for years, and we need those applications to reach the same recruitment inbox
> automatically, without disconnecting WhatsApp on the handset our HR team uses daily.
>
> This permission is used exclusively against WhatsApp Business Accounts owned by Sato Pharma. We do not
> access, manage, or onboard any other business's account or data.

### If asked "who are your customers / which businesses do you onboard?"

> Sato Pharma is an end business, not a reseller. We do not onboard other businesses. We are requesting
> Tech Provider status solely because Meta requires it to run WhatsApp Coexistence onboarding for a
> phone number our own company already owns, so that number can join the WhatsApp Business Account we
> already operate. All access is scoped to our own assets.

## Screencast scripts

Both are short. Record the browser window at 1280×800 or larger, with the URL bar visible so the domain
is legible. No narration is required; on-screen actions are what Meta scores. Keep each under ~2 minutes.

### Video 1 — sending and receiving a message through the API

Demonstrates `whatsapp_business_messaging` end to end.

1. Open the WhatsApp Manager for **Sato Pharma HR Team** and let the connected number `+20 10 98500699`
   be visible on screen for a moment.
2. On a phone (or a second WhatsApp account), send a message to that number with a CV attached — a PDF
   is ideal, since that is the real candidate behaviour. **Show the phone screen sending it.**
3. Cut to Phoenix HR Workforce and open the recruitment inbox. Show the message and its attachment
   arriving — this is the inbound webhook working.
4. Reply to the candidate from the platform. Show the reply.
5. Cut back to the phone and show the reply **received** in WhatsApp.

That round trip — inbound received, outbound delivered — is the whole point of the video.

### Video 2 — creating a message template

Demonstrates `whatsapp_business_management`.

1. Open WhatsApp Manager → **Message templates** for Sato Pharma HR Team.
2. Click **Create template**. Choose category **Utility** (not Marketing — our use is transactional, and
   picking Marketing here would contradict the written justification above).
3. Name it something plainly recruitment-related, e.g. `application_received`.
4. Body text — something honest and non-promotional, for example:
   *"Hello {{1}}, we have received your application for the {{2}} position at Sato Pharma. Our Talent
   Acquisition team will review it and contact you about next steps."*
5. Submit it and show the template appearing in the list with its status.

## After approval

1. Set the Terms of Service URL to `https://phoenix-hr.satopharma.com/terms` (if not already done).
2. Confirm both permissions read **Advanced Access** in the app dashboard.
3. **Free the WABA slot**: delete the *Unverified* `+20 11 59888247` entry, which currently occupies the
   second of two number slots. This is reversible and does **not** affect WhatsApp on the handset.
4. Owner opens `https://phoenix-hr.satopharma.com/whatsapp-connect` **on the handset** and runs the
   ~2-minute confirm (enter number → WhatsApp sends a code → **Connect** → **Connect to the Business
   Platform** → **Confirm** to sync history → enter the code). Requires WhatsApp Business app 2.24.17+.
5. Verify a test CV sent to the handset reaches the webhook and lands in recruitment intake.
