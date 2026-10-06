# CEO Email Composer

Built 2026-10-06. The screen where a letter from the chief executive is written, dictated or built
from a document, and sent to a distribution list or to named colleagues — on his letterhead and over
his signature.

Owner 2026-10-06: *"i want to make a module thats called ceo email composr exactly as sato email
composer copy paste but a more corporate templete a more capable ai assist that the ceo can type
what he wants any language or even open the mic and the assist is perfectly able to understand the
ceo if the ceo asked to type he understand if asked to polish he understand and tghe templete is
wiith the signature of the ceo"*

It sits **beside** the [Sato Email Composer](sato-email-composer.md), which is untouched: different
sender, different register, different letterhead, different seat. Nothing about that one changed
except the two shared pieces named below, both of which are additive.

## Where it lives

- **UI:** `/admin/ceo-email`. There is **no `/hr` twin** — `resolveNavigationMode` pins the CEO to
  the admin shell, so both seats that can open this screen render this exact address. (The Sato
  composer needs a `/hr/admin/...` row because an HR seat renders the HR shell.)
- **API:** `/api/admin/ceo-email/{assist,document,employees,media,preview,send,templates,transcribe}`.
  All eight are declared in [`access-registry.ts`](../src/lib/security/access-registry.ts).
- **Code:** [src/lib/ceo-email/](../src/lib/ceo-email/) — `access.ts` (the gate), `identity.ts` (who
  signs), `render.ts` (the letterhead), `assist.ts` (the assistant and its guards),
  `assist-limits.ts` and `dictation-limits.ts` (pure ceilings the browser may import),
  `dictation.ts` (the mic's server half), `service.ts` (templates, preview, send, the audit row).
- **Screen:** [`src/components/admin/ceo-email-composer.tsx`](../src/components/admin/ceo-email-composer.tsx)
  — a `ComposerVariant` over the Sato composer, plus
  [`assist-dictation.tsx`](../src/components/admin/assist-dictation.tsx) for the microphone.
- **Migration:** [`20261006143000_ceo_email_composer.sql`](../supabase/migrations/20261006143000_ceo_email_composer.sql)
  — `ceo_email_templates`, `ceo_email_sends`, and eight executive seed templates.

## Who may use it

`canUseCeoEmail(access)` — the **CEO**, and **Super Admin** via
`canAccessSystemAdministratorWorkspace`. It is deliberately **not** `canUseSatoEmail`, and must never
become it: the HR Business Partner seat may write an HR announcement and may not write a letter from
the chief executive.

Every route behind the page asserts the same predicate. The redirect on the page is presentation,
never the boundary.

**Settled by the owner, 2026-10-06 — asked and answered: TWO SEATS, the CEO and his own Super Admin
workspace.** He was offered the CEO alone, and a third seat for an assistant, and chose neither. So
the Super Admin seat is a decision now and not a convenience: somebody has to be able to open the
screen, correct a letter and fix the module, and that somebody is him. A later session narrowing
`access.ts` to `role === "CEO"` would be undoing his answer, not tightening a loose end.

## 🔴 The signature is resolved on the server and is never posted by the browser

This is the one structural decision in the module and the reason `identity.ts` exists rather than a
`signature` field on the draft.

The Sato composer has a free-typed **Signed** field, which is right there — an HR announcement is
signed by whoever wrote it. Here the letterhead prints a name under a signature rule, and the company
reads that name as the chief executive. Two seats can open the screen. If the browser could choose
the name, the Super Admin seat could mail a distribution list signed as somebody who never saw the
letter.

So:

- `resolveCeoSignature()` reads the live employee directory on **every render** and takes the person
  whose `jobTitle` is `CEO`. `pickCeoSignature()` is the pure half, and it is tested.
- It **never throws**. A directory read that fails returns the fallback name with
  `fromDirectory: false`, and the composer's load warnings say so — a letter that cannot be signed
  because of a failed read is worse than one signed from the fallback and reported.
- The letter prints `CEO_TITLE_EN` = "Chief Executive Officer", not the directory's `CEO`. The
  directory abbreviates the seat because every roster and payroll row does; a letter does not
  abbreviate the signatory's office. This is the one place in the system where the two differ on
  purpose.
- The sender's own field is the **closing line** — "Sincerely", "With appreciation" — which carries
  no identity and so does travel on the draft. The column is `closing_line` and its comment says it
  is not the signatory. `normalizeCeoClosing` strips markup, drops a trailing comma in either
  alphabet, and cuts to 60 characters.

**Settled by the owner, 2026-10-06 — asked and answered: TYPED NAME AND TITLE ONLY, no scan.** He was
shown both, with the cost of each: a scan reads as a signed letter, but it needs the image asset and
an image of a real signature then travels inside every letter and can be lifted out of one. The block
is still designed so a scan would drop in above the rule without moving anything else, so this is a
decision that can be revisited cheaply — but it is HIS decision, and it is made.

## The letterhead

`renderCeoEmail()` wears the house document identity `SATO-DIS-2026-01 v1.0`, like every other
company document ([AGENTS.md §4](../AGENTS.md)).

**The body pipeline is shared with the Sato renderer and must stay shared.** `prepareSatoEmailBody`
is what sanitizes the sender's markup, strips every coloured ground so THE INK RULE holds, writes the
house spacing onto his paragraphs, inks the list markers, and stamps the 6% zebra row by row because
Word's layout engine has no `:nth-child`. Each of those is a locked rule, and a second copy of that
pipeline is a second place for one of them to rot.

**The frame is deliberately not shared.** Three things make this a letter rather than a notice, and
all three are absent from the Sato frame by design:

1. **The masthead kicker** — "Office of the Chief Executive", in the label voice, over the document
   standard in mono.
2. **A date line** — `6 October 2026`, Cairo local, never an ISO stamp and never UTC. An executive
   letter is dated: it gets referred back to, quoted in a meeting and filed. An announcement is not.
3. **The signature block** — the closing line, then a 1px `HOUSE_COLORS.ink` rule **200px wide**
   (signature width, not column width — a full-width rule reads as another section starting), then
   the name, the office, the company, and the office in Arabic.

That signature block is **a rule and four lines of type**. Not a tinted card, not a bordered panel,
not two columns with a photograph. Every one of those puts a filled area into a document THE INK RULE
forbids one in, and every one of them is what a generic "corporate email signature" reaches for.

The body cell keeps `class="sato-message"` on purpose, so `unwrapSatoEmailFrame` can still strip the
frame when a sent letter is loaded back into the editor.

Everything is inline on the element it styles, for the Sato renderer's own reason: a `<style>` sheet
is the first thing mail clients throw away, and Outlook lays mail out with Word — no flex, no grid,
no `:nth-child`, no `::marker`.

## The assistant — one box, no mode buttons

The owner asked for an assistant that works out the intent itself: *"if the ceo asked to type he
understand if asked to polish he understand"*. So the Sato composer's two buttons (**Write it** /
**Rewrite what I wrote**) are gone, and the screen has one box and one **Do it**.

He may type in any language, or dictate in one of seven (see the microphone, below). The model
reports back what it read him as, and the screen
says so — *Read as: write it · Arabic*, *Translated into Arabic, your figures unchanged*, *Read as:
your own words, tightened* — so he can see it understood before he reads the draft.

### 🔴 The buttons were carrying a safety decision, and a structural floor replaced it

Those two buttons chose which guard set judged the draft: **Write** was judged leniently (a new
letter legitimately states facts from his instruction), **Rewrite** strictly (nothing may appear that
he did not write). With the buttons gone, the obvious replacement — the model's own declared intent —
is exactly the wrong thing to rely on: a model that rewrote his draft while calling it a "write"
would buy itself the lenient guard.

So `effectiveCeoGuard()` reads the declared intent **and then falls back to a floor**:

```
figuresLostFromBody(candidate, bodyHtml)
```

— the numeric tokens his own body stated, minus the ones the draft still states. **Any loss forces
the strict guard**, whatever the model called the request. It depends on nothing about language,
wording or the model's honesty, and it needs no network to test.

A figure of his going missing is also an **unconditional refusal**, under either guard and in every
intent: it is a fact of his the draft silently contradicts, and it is what proves a "write" was
really a rewrite.

The route **takes no `mode`**. A mode on the wire would hand the browser the choice of how carefully
his own figures are checked.

### The rest of the guards

Unconditional: an empty body, an empty subject, text that names the assistant, a figure he wrote
going missing, a link or image address nobody wrote.

Strict only: figures nobody wrote, and `[square bracket]` gaps filled in by the model.

**Translation compares the gap COUNT, not the gap TEXT.** A correct Arabic translation translates
`[effective date]` into `[تاريخ السريان]`, so comparing text would refuse every honest translation —
while a gap the model decided for him still lowers the count, which is the thing worth catching.

### What it is told

`CEO_ASSIST_INSTRUCTIONS` carries the voice (first person where he is deciding, measured and short,
never the HR register, and **never a greeting or a sign-off** — the letterhead already prints the
closing, the name and the office, so a "Dear colleagues" inside the text signs the letter twice), the
facts rule (nothing invented; an unknown date, figure or name becomes a `[square bracket]` gap), the
language rule, and the toolbox — the same `toolboxPromptLines()` the Sato assistant is taught, so the
model presses the buttons the sender has and nothing the sanitizer would drop.

The language rule is the half the owner asked for by name:

- The letter is written in the language of his instruction, reading as a native executive letter in
  it rather than a translation of an English one.
- A **named** language wins over the language he typed in.
- Both languages means paragraph-by-paragraph, never two halves and never a summary instead of a
  translation; a table is built once with both languages in the header cell.
- Arabic is Egyptian corporate Modern Standard, Western digits, English product and job-title terms
  left in English.
- **Dictation is read as speech.** It arrives unpunctuated, with false starts and a mid-sentence
  correction ("...on Sunday, no, on Monday") — take the correction, drop what it replaced, and never
  transcribe his spoken filler into the letter.
- An instruction **about** the letter is never content **in** it.

`/document` is the same assistant with the facts coming out of a file he uploaded, and it never calls
the model for verbatim HTML. One model call, medium reasoning effort; 120s budget when a document is
in play, the standard route budget otherwise.

## The microphone

The mic records with `MediaRecorder` and posts the clip to `/api/admin/ceo-email/transcribe`, which
transcribes it with Groq Whisper and appends the text into the instruction box — **appends, never
replaces**, so a second thought adds to the first.

🔴 **The language is NAMED, not detected — and that is this module's one deliberate narrowing of
what the owner asked for.**

The obvious design was to send no `language` field and let Whisper detect it, which is what "any
language, just open the mic" asks for. It was built that way first and then withdrawn, on this
repo's own measurement: **with the field left off, Whisper translates the speech into fluent
English.** That is why `src/lib/ai/groq-transcription.ts` hardcoded `ar` for the CRM, and
`tests/phoenix-crm-voice-transcribe.test.ts` is the guard that caught the CEO mic repeating the
mistake. A letter he dictated in Arabic arriving as an English instruction is the worst outcome
available here, because nothing on the screen would look wrong.

So a one-tap control sits beside the button — `CEO_DICTATION_LANGUAGES`: العربية (the default),
English, Français, Deutsch, Italiano, Español, Türkçe — and the code is posted with the clip. The
route re-reads it against that list, so an unrecognised code becomes Arabic rather than being
refused by the API and losing a three-minute dictation. `form.set("language", …)` in the shared
client is now **unconditional**: `ar` is its default rather than its only value, and no caller can
ask for none.

**Auto-detect is not refused for ever — it is refused until somebody measures it**, against a real
Arabic clip with the production speech key. That cannot be done from the laptop, which has no
`GROQ_API_KEY`.

**The typed box is unaffected.** The assistant's language rule answers in whatever language he
writes in, in any script, with no list involved — that half of "any language" is complete.

It also sends **no `prompt`**, which removes the prompt-echo failure mode rather than mitigating it.

**The browser's own engine is not the alternative.** `SpeechRecognition.lang` is mandatory there too
and has no auto value, so it would need this same control — and Firefox has no engine that does
Arabic at all.

Caps: 180 seconds, 6 MB, and a seven-entry container allowlist (`dictationExtension` cuts the codec
parameter before the lookup, because a browser sends `audio/webm;codecs=opus`). A clip that cannot be
transcribed comes back as a `problem` with HTTP 200, not a 5xx — nothing was stored, so there is
nothing to apologise for except the words.

**Nothing is stored.** The bytes arrive, are transcribed and are dropped: no bucket, no row, no path,
no retention. This is dictation, not the CRM's voice note, which is a stored artefact with its own
columns — the two must not be described as one another.

## Sending

The audience, the plan, the draft parser, the attachment handling and the typed-address policy are
**the Sato composer's own code**, unchanged: `resolveSatoEmailAudience`, `buildSatoEmailSendPlan`,
`parseSatoEmailDraft`, `loadSatoEmailAttachments`, `satoTypedAddressPolicy`. The recipient count on
the preview can therefore never describe a different email from the one that sends.

- **From:** `ceo@send.satopharma.com`, display name `<name>, Chief Executive Officer`. 🔴 The address
  must stay on the `send.` subdomain. An apex `@satopharma.com` From was reported verified and every
  send came back delivered, while `email_delivery_events` showed **0% opens over 36 sends** — the
  recipients' own mailboxes live on that apex domain, so mail claiming the same identity from a
  different relay matches the shape of a spoofed sender and is filed as bulk. SPF, DKIM and DMARC all
  passing does not prevent it.
- **Reply-To and the visible To:** `anwar.gaweesh@satopharma.com` — apex, which is fine, because
  DMARC keys off the From header and never the To. Verified healthy in `email_delivery_events` before
  being wired. Note that the visible To also means **he receives a copy of every letter**.
- Recipients are **hidden from each other**: `fanoutToBcc: true` behind the neutral visible To, 25
  per email.
- **An over-budget attachment refuses the whole send.** `guardAttachments` in `send-phoenix-email.ts`
  silently drops one and sends anyway — a defensible default for a system notification and completely
  wrong here: "the paper is attached", over the chief executive's signature, with nothing attached,
  cannot be recalled and nothing on his screen would have said so. So the files are loaded **before**
  any mail leaves and a problem fails the send.
- Idempotency keys are the Sato builder's, under the `ceo-email` scope — the one change to `plan.ts`,
  an optional `scope` that defaults to `sato-email`.
- `media` writes into the **same** object store as the Sato composer's upload, keeping
  `/api/sato-email/media/[token]` the only anonymous address in this area. Its audit row carries
  `composer: "ceo"`.
- Rate limits: `send` 5/min, `document` 6/min, `assist` 10/min, `templates` POST 20/min,
  `transcribe` 20/min, `media` 30/min, `preview` 60/min.

Every send writes a `ceo_email_sends` row and an audit log entry (`ceo_email_send`), best-effort, so
a logging failure can never be the reason a letter did not go.

**Settled by the owner, 2026-10-06 — asked and answered: the three addresses stand as built.** From
`ceo@send.satopharma.com`, replies and the visible To line to `anwar.gaweesh@satopharma.com`, which
also means a copy of every letter lands in the CEO's own inbox. He was offered the Phoenix care inbox
for replies, and the CEO mailbox without the copy to him, and chose neither. So this is no longer the
measured-correct shape awaiting a decision: it IS the decision, and the measurement behind the
sending domain (0% opens over 36 sends from the apex) is the reason it is the right one.

## The templates

Eight executive seed templates, none of which carries a greeting or a sign-off: a company decision, a
performance update, an organisational change, recognition, an occasion, a position statement, a
condolence, and a call to action.

The migration adds **nothing** to `distribution_lists` — the lists belong to that module and the
composer only reads them.

## 🔴 The screen IS the Sato composer, with a variant

[`sato-email-composer.tsx`](../src/components/admin/sato-email-composer.tsx) now takes a
`ComposerVariant`, and `CEO_COMPOSER_VARIANT` is the only place the two screens differ: `apiBase`,
`assist: "understood"`, `dictation: true`, the instruction cap, the request-id prefix, and the
closing-line label, default and hint.

The owner asked for a composer *"exactly as sato email composer copy paste"*, and **the only way a
second screen stays exactly like the first is for it to BE the first.** A literal copy of 1,500 lines
drifts on the first fix applied to one of them, and the one left behind would be the one that mails
the company over the chief executive's signature.

Two bundle leaks were caught while building it, and the two `*-limits.ts` modules exist because of
them: a client component importing `assist.ts` pulls in the OpenAI client and its key reader, and one
importing `dictation.ts` pulls in the Groq client. Both are pinned by the test.

## When the deploy lands before the migration

A merge ships to production before the migration is applied, and a missing table answers `PGRST205`
rather than `42P01`. So the page degrades: `getCeoEmailComposerOptions` catches it, the composer loads
with an empty template set and a warning, and free-typed letters still work. A page that let it throw
would 500 for the whole window.

## What pins it

[`tests/ceo-email-composer.test.ts`](../tests/ceo-email-composer.test.ts), registered in
`tests/run-tests.ts` and therefore inside the required `validate` check. Five groups: the structural
floor and the refusals, the signature's provenance, the letterhead's locked look (ink rule, square
edges, document standard, Cairo date, the RTL line's alignment), the mic's any-language path and the
container allowlist, and the variant — including that all eight routes are declared in the access
registry and that no API-key reader can reach the browser bundle.

Both halves of the floor were verified by breaking them and watching their own assertions fire:
removing the `figuresLostFromBody` fallback from `effectiveCeoGuard`, and making the figure-loss
refusal conditional on the strict guard.

## Module memory

The four rules a session needs before changing any of this are in
[`.claude/rules/notifications.md`](../.claude/rules/notifications.md), under "The two composers —
Sato and CEO". The module's globs cover `src/lib/ceo-email/**` and `app/**/ceo-email/**`.
