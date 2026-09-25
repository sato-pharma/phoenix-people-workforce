---
name: whatsapp-intake-counts-are-not-applicant-counts
description: "WhatsApp CV intake events are dominated by two bulk-forwarding handsets, so a raw count of ats_cv_intake_events overstates real applicants by ~20x — always split by sender before quoting any WhatsApp recruitment number"
metadata: 
  node_type: memory
  type: project
  originSessionId: e33bc510-fa9c-48dd-9f02-36e8d91f528d
  modified: 2026-08-29T20:05:00.000Z
---

**A raw count of WhatsApp intake events is not a count of applicants, and the gap is roughly 20x.**
Measured on production 2026-08-29: `ats_cv_intake_events` held **461** rows for `channel='whatsapp'`
since 25 July, from **18** distinct `sender_identifier` values — and **two of those numbers carried
439 of them (95%)**, because they are bulk-forwarding handsets, not people applying. One is the
configured import line in `RECRUITMENT_WHATSAPP_IMPORT_SENDERS`; the other is the owner's OWN
second handset (WhatsApp profile name "Omar Anwar", 349 events), forwarding without being listed.
Strip both and the publicly advertised line shows **22 events from 16 people in five weeks** — and
on a rolling 30 days, **10 events from 8 people**.

**Why this misleads rather than merely rounding.** 461 reads as a healthy channel and 22 reads as a
dead one, and the honest answer is the second. The owner reached the right conclusion by instinct
("I think it is losing CVs") while every number available to him said the opposite. Any report,
digest or dashboard that counts WhatsApp intake rows without partitioning by sender will tell him
the channel is working at roughly twenty times its real volume.

**How to count it properly.** Group by `sender_identifier` first and look at the distribution before
quoting a total — a channel where two senders hold 95% is a forwarding channel, not an applicant
channel. `isWhatsAppImportSender()` (`whatsapp-payload-parser.ts`) matches on the last 9 digits, so
it catches the configured handset in either local or international form; the *unlisted* forwarder it
cannot catch, which is exactly why the distribution has to be eyeballed rather than trusted to a
filter. Note the raw column is `+<wa_id>` (e.g. `+201234567890`), not the local `01…` form.

**Since 2026-08-29 the denominator finally exists.** Before that date a text-only message left no
durable row at all — it went to a 24-hour buffer and was deleted — so "how many people messaged and
sent no CV" was unanswerable, not merely unmeasured. PR #2696 records those as
`outcome='ignored_no_attachment'` with `raw_metadata->>'textOnly' = 'true'`, which is the flag that
separates them from the pre-existing meaning of that outcome (a document whose download failed).
So from that date forward, real reach on this channel = text-only rows + CV rows, minus forwarders.
Verified end to end on production 2026-08-29 22:39 Cairo: a text-only message recorded, the Arabic
reply sent, and in-app + Telegram + push delivered to the owner in **two seconds**, with no email row
at all.

**The unlisted handset also disarms the silence alarm, which is the expensive half.**
`isPublicWhatsAppArrival()` (`whatsapp-health.ts`) excludes a sender only if it is on the import
list, and the comment there records that a forward carries TODAY's timestamp and so RESETS the
inbound-silence clock. That fix works for the listed handset and not for the unlisted one: at ~10
forwards a day the gap never reaches the 24-hour threshold (`RECRUITMENT_WHATSAPP_SILENCE_ALERT_HOURS`
is unset, so 24 is live), so **the alarm that exists to say "the public line has gone quiet" cannot
fire while he is forwarding.** `measurePublicReach` is inflated by the same rows. Adding the second
handset to the import list arms both — but check the other three things that flag gates first
(buffer clearing, pending-classification apply, and the owner's own Telegram mirror in
`intake-worker.ts`), because listing it silences the mirror for every CV he forwards.

**CORRECTION 2026-08-30 — the second handset IS on the import list now; re-read the variable, never
this paragraph.** The two paragraphs above say the "Omar Anwar" handset (+201280955558) forwards
*without being listed*, and that this disarms the inbound-silence alarm. Measured live on Railway
production 2026-08-30 01:20 Cairo, `RECRUITMENT_WHATSAPP_IMPORT_SENDERS` reads
`01159888247,01280955558` — **both** handsets. `isWhatsAppImportSender` compares
`phoneTail` (digits, leading zeros stripped, last 9), so `01280955558` → `280955558` matches the
sender `201280955558` → `280955558`. It is listed, so the alarm is armed and the "expensive half"
above no longer describes live state.

The original was not wrong when written. At **22:39:45 on 2026-08-29** that handset was still being
treated as an ordinary applicant: it fired `recruitment_whatsapp_text_only` and Phoenix auto-replied
to it — the stored notification body reads *"Omar Anwar (+201280955558) wrote: \"Hello\" — Phoenix has
asked them to send it as a file"*, with `asked: true`. `handleTextOnlyMessage` returns
`reason: "import_sender"` before any of that for a listed sender, so the value it read did not
contain the number at that moment. The value changed between then and 01:20; who changed it was not
established, and the `isImportSender: false` at whatsapp-text-only-applicant.ts:335 is a correct
short-circuit after the early return, **not** a bypass — do not "fix" it.

**The general rule this cost:** an env-var membership claim is live configuration, not a durable
fact. Read the variable before asserting whether a handset is listed — a memory saying "unlisted"
was repeated to the owner as current truth and was an hour out of date.

**The conflation has already shipped a defect once, and this is what it cost.** On 2026-08-15 a
measurement of 628 `recruitment_inbound_cv` deliveries over 30 days was read as proof that the
per-CV alert was noise, and it was replaced by one 18:00 Cairo digest — a defensible call against
that number. But the number was this same undivided total: of 437 WhatsApp arrivals in 30 days,
**427 were forwards and 10 were real applicants**, so the flood being suppressed was never the
applicants. The gate became `!fileAttached`, meaning a CV that arrived *successfully* was silent
for up to 24 hours while a text with no CV pinged in one second. The owner reported it exactly as it
looks from outside — "when someone sends the text and then sends the CV, the CV does not appear" —
and production agreed: four Telegram sends on the night of 2026-08-29 (22:39, 22:51, 23:03, 23:14),
every one a text-only alert, not one a CV; `recruitment_inbound_cv` had last fired 2026-08-15.
Fixed 2026-08-30 by keying the gate on `bulkArrival` (import sender or history replay) instead of
on success — so the forwards stay quiet and an applicant's CV interrupts. **The lesson is the
general one: before concluding a notification stream is noise, split it by sender and check that
the population you are about to silence is the one generating the volume.**

Related: [[a-whatsapp-apply-link-cannot-be-attributed-yet]] (the same channel's *attribution* is
separately blind — 434 events, 11 senders, for the same reason),
[[whatsapp-import-images-return-nothing-from-vision]] (the photographed-CV loss sitting on top of
this one), [[cv-intake-6h-digest-emails-the-manager-not-talent-acquisition]].
