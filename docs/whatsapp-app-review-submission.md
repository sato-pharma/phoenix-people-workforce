# WhatsApp App Review — submission pack

Everything needed to submit Phoenix HR Workforce for **Advanced Access** on
`whatsapp_business_management` and `whatsapp_business_messaging`, which is the gate standing between us
and WhatsApp **Coexistence** (linking the owner's handset number into the recruitment intake without
disconnecting WhatsApp on the phone).

Written 2026-08-24, after the coexistence flow was built, shipped and then refused by Meta.

> ## 🟢 OUTCOME — APPROVED 2026-09-06, ~13:02 Cairo
>
> **This pack did its job and is now history.** Meta approved the submission: all three requests —
> `whatsapp_business_messaging`, `whatsapp_business_management`, `public_profile` — read
> **Approved**, and both WhatsApp permissions moved from *Pending App Review* to **Ready to publish**
> on *Permissions and features*. The row's Actions menu now offers **"Reduce access"** where it used
> to offer *"+ Add to App Review"* — that wording, not the status label, is what shows the app holds
> advanced access. **Never click it.** The app is Published and Required actions is empty.
>
> Read the rest of this file as the record of how it was assembled. **The checklist below is frozen
> at its 2026-08-24 state except where a row says otherwise** — do not act on a ⏳ in it.
>
> **The handset is still not linked.** Approval removed the gate; nobody has run the flow. What
> remains is § *After approval* at the bottom of this file.

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
| 4 | **Terms of Service URL** — was the `facebook.com` placeholder | ✅ `/terms` live and set in the dashboard |
| 5 | WABA + connected number — "Sato Pharma HR Team", `+20 10 98500699` | ✅ Live, webhook receiving |
| 6 | Screencast 1 — sending/receiving a message via the API | ✅ Recorded, uploaded, **approved 2026-09-06** |
| 7 | Screencast 2 — creating a message template | ✅ Recorded, uploaded, **approved 2026-09-06** |
| 8 | Written justifications | ✅ **Pasted into the live submission**, all three permissions |
| 9 | **Payment method on the WABA** | ❌ **Still not added** (re-read 2026-09-06). Does **not** block CV receipt — inbound is free and the auto-reply is off — so it is not a coexistence blocker |
| 10 | An **approved template we created** | ✅ *Next steps* now reads `Approved message template · Created` (re-read 2026-09-06) — `application_received` was approved. `hello_world` never counted; it is Meta's seeded sample |
| 11 | **Access verification (Tech Provider)** | ✅ **Verified 2026-08-24** — alert *"Your business has been verified as a Tech Provider"*. The end-business-fit risk below did not materialise |

Items 9 and 10 were read live from **Use cases → Customize → Basic setup → Next steps** on 2026-08-24.
Item 10 is why screencast 2 is not busy-work: creating the template *is* the missing prerequisite,
and recording it costs nothing extra.

**Items 6 and 7 were the last blockers, and they are now done** (submitted 2026-08-28, approved 2026-09-06). The
wizard treats the screencast as a required row, not a nice-to-have — proof in the next section. Every
other field in all five steps is green.

Do **not** retry the phone onboarding flow until access is granted — it cannot succeed, and Meta counts
onboarding attempts (default cap 10 per rolling 7 days).

## The submission is built and waiting on two videos

Submission `1750808742793861` exists and is filled in. Read live 2026-08-24 from
*Review → App Review*. It is a five-step wizard that **auto-saves each step** (a `saved` indicator
appears top-right), so it survives a reload and can be resumed.

| Step | State |
| --- | --- |
| Verification | ✅ |
| App settings | ✅ |
| **Allowed usage** | ⬜ **the only incomplete step** |
| Data handling | ✅ |
| Reviewer instructions | ✅ |

The footer reads *"You must complete all steps before you can submit for review"* and **`Submit for
review` is disabled.**

Inside *Allowed usage* there is one card per permission — three cards, not one form. Each card has
four rows, and every row must go green before the card closes:

| Permission | Description | Screencast | API test calls | Allowed-usage agreement |
| --- | --- | --- | --- | --- |
| `whatsapp_business_messaging` | ✅ | ⬜ | ✅ | ✅ |
| `public_profile` | ✅ | — | — | ✅ **card complete** |
| `whatsapp_business_management` | ✅ | ⬜ | ✅ | ✅ |

`public_profile` needs only the agreement; it collapsed to a green check and an *Edit* button as soon
as that box was ticked, which is what a finished card looks like. The two WhatsApp cards still show
*Get started* rather than *Edit* — **the screencast row is the only thing keeping them open.**

So the whole submission now rests on two screen recordings. That is worth stating plainly because it
had been assumed the screencast was optional: it is not, and no amount of further form-filling will
enable the Submit button. The click-by-click scripts for both videos are below.

### Access verification — SUBMITTED 2026-08-24, now in review

*Review → Verification* lists **two** processes, and both are now actioned:

- **Business verification** — Phoenix HR Workforce (`2447906605705551`) · **Verified**
- **Access verification** — *"Verify that your business is a Tech Provider"* · **Submitted → In review**.
  The page shows a three-stage tracker (**Submitted ✅ → In review ◐ → Verified**) and *"We're reviewing
  your submission and will reach out within 5 days if we need more information"* — so a decision is
  expected by **~2026-08-29**. This actions the 10/23/2026 deadline that page had carried.

**How it was answered — honestly, and it may well be refused for exactly that reason.** The form is
built solely for Tech Providers who serve *other businesses' clients*: every question presumes clients,
multiple portfolios, and a public service website. Sato Pharma has none of those. It was answered as
what it is, not reshaped to fit:

- **Q1 "which describes your business"** → *Other*: "In-house HR and recruitment platform used only by
  our own company (end business, not a service provider to other businesses)."
- **Q2 "how will you use Platform Data on behalf of clients"** → stated plainly that there are **no
  clients**; own internal recruitment use only; Tech Provider requested solely because Meta requires it
  to run Coexistence for a number the company already owns.
- **Q3 "manage multiple business portfolios"** → **No**.
- **Q4 website** → **`https://satopharma.com`** — the real corporate site (About, products, Careers),
  chosen over `phoenix-hr.satopharma.com`, which is login-gated and would show a reviewer nothing.

The owner pressed Submit himself: the auto-mode classifier had blocked the agent from ticking the Q3
radio and from the final submit, which was the correct call — this is a legal declaration on the real
verified Meta business account, and **it must never be forced through by misrepresenting the company as
a reseller or SaaS vendor**. That line was held.

Two things still follow. First, the App Review submission's green *Verification* step is satisfied by
**business** verification alone — it is **not** evidence access verification has *passed*, only that it
was submitted. Second, because a refusal is a real possibility (the form has no lane for an end
business), **hold the two screencasts until this comes back** — they are only worth recording if the
Tech Provider claim is accepted. If refused, nothing breaks: the automated funnel on the connected
`+20 10 98500699` keeps working exactly as today. See
*Where the submission actually happens* for why those are two separate things.

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

## Screencasts — click by click

Every screen below was opened and read live on 2026-08-24, so the labels are what is actually on the
page, not what the docs say should be. Where a screen surprised us, it is called out.

Record the browser at 1280×800 or larger with the **URL bar visible** so the domain is legible. No
narration is needed — Meta scores the on-screen actions. Keep each video under ~2 minutes.

### Video 2 first — creating a message template

Do this one **before** video 1. It is the missing prerequisite (item 10 above), and the template it
produces is what video 1 then sends.

Demonstrates `whatsapp_business_management`.

1. Open **`https://business.facebook.com/wa/manage/message-templates/?business_id=2447906605705551`**
   (it redirects and appends `asset_id=2265574670642375` — that is normal).
2. Confirm the account picker top-right reads **Sato Pharma HR Team**. Let it sit on screen a second.
3. If a **"Enhanced metric sorting"** tip pops up, click **Done** to dismiss it before recording.
4. Click the blue **Create Template** button (right of the filter row).
5. **Set up template** step. ⚠️ **Marketing is selected by default.** Click **Utility**. Leave the
   radio on **Default** ("Send messages about an existing order or account"). Picking Marketing here
   would directly contradict the written justification above — this is the one click that must not be
   missed.
6. Click **Next** (bottom right).
7. **Edit template** step:
   - **Name your template** → `application_received`
   - **Select language** → English (leave as-is)
   - **Header · Optional** → leave empty
   - **Body** → it is pre-filled with the word `Hello`. Select all and replace with:
     *"Hello, we have received your application at Sato Pharma. Our Talent Acquisition team will
     review your CV and contact you about the next steps."*
     Keep it variable-free — the `+ Add variable` button exists, but a template with no variables has
     nothing for Meta to reject, and the auto-reply code sends no parameters.
   - **Footer**, **Buttons**, **Message validity period** → leave all untouched.
8. Click **Submit for Review** (bottom right; it stays greyed out until the name and body are filled).
9. Show the template appearing in the list with its status (`In review`, then `Active`).

Backing out mid-flow pops **"Changes will be lost if you go back"** — nothing is created until step 8,
so abandoning is safe.

### Video 1 — sending and receiving a message through the API

Demonstrates `whatsapp_business_messaging`. The inbound half already works in production; only the
outbound half needs a decision (below).

**Inbound — real, works today, no setup:**

1. On any phone, send a message to **`+20 10 98500699`** with a **PDF CV attached** — that is exactly
   what a real candidate does. Film the phone sending it.
2. Cut to **`https://phoenix-hr.satopharma.com/recruitment`** and show the new candidate appearing,
   carrying the green **WhatsApp** source badge. Open the candidate and show the attached CV and the
   **"First WhatsApp messages"** panel.
3. Optional but strong: **`https://phoenix-hr.satopharma.com/recruitment/intake-health`** shows the
   WhatsApp channel and its last-received time — visible proof the webhook is live.

**Outbound — pick one:**

- **Option A (recommended, real).** Once `application_received` is approved, set three Railway
  production variables and the platform replies to every applicant by itself:
  `RECRUITMENT_WHATSAPP_AUTOREPLY_ENABLED=true`,
  `RECRUITMENT_WHATSAPP_AUTOREPLY_TEMPLATE=application_received`,
  `RECRUITMENT_WHATSAPP_AUTOREPLY_LANG=en`
  (see [`src/lib/recruitment/inbound/whatsapp-reply.ts`](../src/lib/recruitment/inbound/whatsapp-reply.ts)
  — it is a strict no-op until all three are set). Then step 1 above produces the reply on the phone
  by itself, and the video shows a genuine round trip. **This messages real candidates from then on,
  so it is the owner's call, not a recording trick.**
- **Option B (no production change).** Use Meta's own tester:
  **Use cases → Customize → Basic setup → Step 1. Try it out**. A test sender **+1 555 675 2725** is
  already claimed. The **Recipient** dropdown is **empty** — click **Manage phone number list**, add
  the handset, and confirm the code WhatsApp sends. Then pick a **Message** template and click
  **Send message**, and film it arriving. Honest, but it sends from a US test number rather than ours.

## Where the submission actually happens

The old `/app-review/permissions/` URL now **redirects to Use cases** — App Review is folded into the
use-case flow, and there is **no "App Review" item in the app's left nav** until a permission is added
to it. The path:

1. `https://developers.facebook.com/apps/1725159208692148/use_cases/` → the **Connect with customers
   through WhatsApp** card → **Customize** (pencil button).
2. Left panel → **Other tools → Permissions and features**.
3. Find the row **`whatsapp_business_messaging`**. Status reads **"Ready for testing"** — that is
   Standard Access, i.e. what we are trying to leave.
4. **Actions ▾ → `+ Add to App Review`**. (The second entry, *Required for use case*, is greyed out.)

**Stop at step 4. It is not what its label says.**

Clicking it does **not** open a request form. It opens a modal titled **"To add a permission or
feature to App Review, become a Tech Provider"**, whose third line reads verbatim:

> **This decision cannot be reversed after you've been identified as a Tech Provider.**

It also warns that Tech Provider status *"involves additional reviews and stricter data access
requirements"*, and lists three gates: Business verification (done), **Access verification**
— *"Verify that your business is allowed to access another business portfolio's data"* — and App
Review.

So there is **no way to request Advanced Access on these two permissions without accepting an
irreversible Tech Provider identification on the company's Meta app.** That is a materially larger
commitment than submitting an App Review, and it is the owner's call, made knowingly — never a step
an agent takes because it was told to "add the permissions".

**It was reached, backed out of, put to the owner, and then accepted — all on 2026-08-24.** He read
the trade-off and answered *"accept Tech Provider"*; **Continue** was pressed on that modal. That is
what produced everything this file now describes: the **Review** group (Testing / Verification / App
Review) in the left nav, `whatsapp_business_management`'s Actions menu reading *"Go to App Review"*,
and submission `1750808742793861` itself. The decision is done and is not revisitable — the value of
the wording above is now historical: it is why an agent must never click that button on its own.

Note where the risk at the top of this file becomes concrete: the Access-verification gate is
literally about accessing **another business portfolio's** data. Sato Pharma only ever touches its
own. That is the mismatch Meta may act on, and it now has a named checkpoint rather than being a
worry.

The same flow is reachable at **Become a Partner → Become Tech Provider**, which opens an *"Onboard
as a Tech Provider"* splash (*"Send messages on behalf of your customers"* / *"Onboard customers from
your website"*) before the same decision. **Third door, same room:** *Review → Verification →
Access verification → `Start verification`* — the one with the 2026-10-23 date on it. All three lead to
the irreversible identification; none of them is the harmless-sounding one its label suggests.

**"Tech Provider" is two things, and only the first has happened.** This is worth separating carefully,
because the two look like one item in every summary written so far:

1. **The identification** — accepting the modal above. **Done**, owner-approved, irreversible. This is
   what unlocked the submission wizard.
2. **Access verification** — the actual form that proves the claim, at *Review → Verification*.
   **Submitted 2026-08-24, now in review** (Meta replies ≤5 days). It was answered honestly as an end
   business with no clients — see *Access verification — SUBMITTED* above for the verbatim answers and
   the website choice.

So pressing `Submit for review` cannot trip anything irreversible that has not already been accepted —
that worry is spent. What is still open is the **outcome** of (2), which is the step where the
awkward-fit risk at the top of this file actually gets adjudicated. Because it may be refused, hold the
two screencasts until it comes back.

## After approval

1. Confirm both permissions read **Advanced Access** in the app dashboard.
2. **Free the WABA slot**: delete the *Unverified* `+20 11 59888247` entry, which currently occupies the
   second of two number slots. This is reversible and does **not** affect WhatsApp on the handset.
3. Owner makes a **connect link** on Recruitment → Inbound CV Intake Health ("Connect a WhatsApp
   number" → **Make connect link**, Super Admin only; since 13 Nov 2026, S01 F-PLT-008). It opens
   `/whatsapp-connect` and works **once, for 30 minutes**; the page refuses to finish without one.
   He opens that link **on the handset** and runs the ~2-minute confirm (enter number → WhatsApp sends a code → **Connect** → **Connect to the Business
   Platform** → **Confirm** to sync history → enter the code). Requires WhatsApp Business app 2.24.17+.
4. Verify a test CV sent to the handset reaches the webhook and lands in recruitment intake.
