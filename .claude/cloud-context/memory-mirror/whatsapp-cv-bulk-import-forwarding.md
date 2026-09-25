---
name: whatsapp-cv-bulk-import-forwarding
description: "Bulk-forwarding an old WhatsApp's CV archive needs CV-first identity + the RECRUITMENT_WHATSAPP_IMPORT_SENDERS env var, or all CVs merge onto one profile"
metadata: 
  node_type: memory
  type: project
  originSessionId: 820271d2-c66c-429a-a073-8f5a420383ff
  modified: 2026-07-26T07:49:19.441Z
---

Owner wants to forward 100+ CVs from an old WhatsApp handset into the business
number, one profile per applicant. PR #1357 (branch `codex/whatsapp-cv-bulk-import`,
worktree `F:/Phoenix Workforce/_wt-whatsapp-cv-bulk-import`), opened 2026-07-26, OPEN.

**Why plain forwarding fails:** every forwarded WhatsApp message reports the
FORWARDING account as its sender. `ingestInboundCv` built the candidate from that
sender *before* opening the attachment, so `findMatchingCandidate` saw one identical
phone number N times and merged all of them onto a single profile. Same flaw applies
to email forwarding (a forwarded email's From is the forwarder) — not yet fixed.

**The fix shipped in #1357:** `identitySource: "sender" | "cv"`. Under `"cv"` the CV
is read first (`extractCvFieldsFromBytes`, split out of `extractCandidateFieldsFromCv`)
and the candidate built from the CV's own fullName/email/phone. A failed read yields
NO match keys — deliberately never falls back to the sender's number, since that
fallback is the merge bug itself.

**Deployment requirement — the whole feature is inert without it:**
`RECRUITMENT_WHATSAPP_IMPORT_SENDERS` must be set on Cloud Run to the old WhatsApp's
number before forwarding, and removed after. Number matching is format-tolerant
(local `01…` vs international `201…`) on the last 9 digits.

**Why:** without the env var the imports silently take the normal sender path and
merge exactly as before — a silent wrong-result failure, not a visible error.

**How to apply:** set the env var, forward 2–3 CVs, verify three distinct profiles
with names read off the CVs, then do the rest. Each CV costs 2 OpenAI calls
(is-this-a-CV check + extraction); rate limits degrade to "profile created, fields
blank, re-run extraction from the review board", never lost data.

Also fixed here: `claimIntakeEvent` wrote a `processing` row before doing any work,
so a run that died mid-message made every Meta redelivery return `ignored_duplicate`
and that CV vanished with no error. Stale claims (>15 min) are now re-claimable and
the webhook `maxDuration` went 60s → 300s. See [[keyset-pagination-orderby-id-trap]]
for the same class of silent-wrong-result bug.

Related: [[ireports360-crm-integration]], [[email-template-unification]].
