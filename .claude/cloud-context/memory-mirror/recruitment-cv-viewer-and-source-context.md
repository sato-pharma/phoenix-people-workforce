---
name: recruitment-cv-viewer-and-source-context
description: "Two recruitment-candidate UX PRs from 2026-07-26 — the CV viewer/docx-render/no-AI-labels PR #1359, and the email-subject/WhatsApp-first-messages \"Source\" column (needs a migration applied or it stays blank)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 820271d2-c66c-429a-a073-8f5a420383ff
  modified: 2026-07-31T16:32:30.684Z
---

Owner drove a sequence of Talent-Acquisition candidate-UX improvements on 2026-07-26.
Two separate PRs (both recruitment-candidate area, kept apart because the second carries
a migration):

⚠️ **The iframe half of PR #1359 below was superseded later the same day** — a desktop Chrome set
to "download PDFs instead of opening" downloaded the CV instead of previewing it, so the viewer was
rebuilt to render page-by-page onto `<canvas>` with pdfjs-dist. The scoped `X-Frame-Options`
override is still the reason same-origin embedding works at all, but do not treat the `<iframe>` as
the current viewer. See [[recruitment-cv-viewer-and-extraction-accuracy-2026-07-26]].

**PR #1359** (branch `codex/recruitment-cv-viewer-no-ai-labels`, worktree
`_wt-recruitment-cv-viewer`): "View CV" side-by-side (original document + saved fields),
Word docs rendered faithfully via **docx-preview** (not raw text), and **every user-facing
"AI" string removed** from the recruitment UI ("AI Populate"→"Populate", etc.).
- Fixed a real pre-existing bug: `next.config.ts` applied `X-Frame-Options: DENY` +
  `frame-ancestors 'none'` globally, which blocked the CV `<iframe>` even same-origin — so
  the PDF preview was silently broken before this. Fix = scoped header override on the two
  file-download routes only (`SAMEORIGIN` / `frame-ancestors 'self'`).
- **Why:** owner asked to see the CV as the actual PDF/Word, not extracted text.
- **How to apply:** docx-preview only reads modern .docx (OOXML zip, `PK\x03\x04`); a
  magic-byte guard routes legacy binary .doc (`d0cf11e0`, `application/msword`) to a
  "use Download" message. docx-preview's painted output was NOT screenshot-confirmed (the
  local preview kept wiping React state — see [[local-browser-verify-gotchas]]); PDF render
  + side panel WERE confirmed. Worth a human eyeball of a .docx before full trust.

**Source column PR** (branch `codex/recruitment-source-context-column`, worktree
`_wt-recruitment-source-context`): new "Source" column in the candidate pool table + full
detail in the profile, showing the **email subject** (already stored in
`ats_cv_intake_events.subject`) or the **first 2-3 WhatsApp messages** (owner's explicit
choice over caption-only), shown in both table and profile (owner's choice).
- WhatsApp text arrives as separate webhook events, so a new buffer table
  `ats_whatsapp_inbound_messages` parks them per wa_id until the CV document arrives; then
  caption + last 2-3 preceding messages attach to the candidate via
  `raw_metadata.sourceContext`. Bulk forward-imports deliberately get **caption only** (the
  preceding texts are the forwarder's chatter, not the applicant's).
- **Migration `20260726154207_ats_whatsapp_message_buffer_and_source_context.sql`** (buffer
  table + `ats_candidate_source_context` view) MUST be applied to staging+prod or the whole
  feature is inert — the code degrades gracefully (Source column shows "—", buffering
  no-ops) so nothing breaks, but nothing populates either. Migrations don't auto-apply on
  merge (see [[notification-recipients-and-migration-backlog-2026-07-19]]).
- **BOTH migrations APPLIED to STAGING + PRODUCTION 2026-07-26** (base + hardening, in order).
  Hardening PR #1365 MERGED. Prod: view returns 59 candidates with real source context (prod
  has 372 intake events, mostly email subjects), advisor 0 ERRORs, anon+authenticated both
  can't SELECT the view. Feature LIVE end-to-end. Note: MCP recorded prod versions as
  20260726134508/134518 (NOT the repo file timestamps 154207/163045) — [[mcp-apply-migration-version-drift]];
  harmless because both migrations are fully idempotent.
- **Hardening PR #1365** (`20260726163045_ats_candidate_source_context_security_invoker.sql`):
  the base view was a plain (definer) view → advisor flagged `security_definer_view` ERROR on
  apply (would leak applicant PII to authenticated via PostgREST, since public schema
  default-grants authenticated — see [[public-schema-default-acl-grants-authenticated]]). Fix =
  `security_invoker = true` + `revoke all from anon, authenticated`. Confirmed on staging: 0
  ERROR advisors, `has_table_privilege('authenticated', view, SELECT)=false`. **Apply BOTH
  migrations to prod together, in order** — base first, then hardening. Lesson: any new public
  view needs security_invoker + revoke from the start (see [[supabase-advisor-by-design]]).
- Staging has **0 ats_cv_intake_events** rows (no inbound CV ever processed there), so the
  Source column shows "—" on staging even with the migration applied — that's correct, not a
  bug. Real data needs an inbound email/WhatsApp CV to flow.

Both build on the merged WhatsApp bulk-import work ([[whatsapp-cv-bulk-import-forwarding]]).
The pdfjs-dist worker prod bug flagged mid-session was fixed+merged separately as #1362.
