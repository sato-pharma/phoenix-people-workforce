---
name: recruitment-cv-viewer-and-extraction-accuracy-2026-07-26
description: "Two recruitment PRs from 2026-07-26 session — inline PDF CV viewer (pdf.js canvas, not iframe) and a candidate-pool redesign + CV-extraction accuracy overhaul. Both OPEN, not merged."
metadata: 
  node_type: memory
  type: project
  originSessionId: 4dc462ab-253f-442c-8cc9-11e9e94d98fb
  modified: 2026-08-22T22:16:46.536Z
---

Owner drove a long 2026-07-26 session (after the WhatsApp-intake + pdfjs-worker fixes) that produced two SEPARATE branches, split from one worktree because they're unrelated deliverables:

**Branch `feat/recruitment-cv-inline-pdf-render`** — the CV viewer stopped putting the PDF in an `<iframe>` (which defers to the browser's PDF handling; a desktop Chrome set to "download PDFs instead of opening" downloaded the CV instead of previewing it, with correct headers and NO detectable error — reproduced locally against prod data via dev-auth). Now renders the PDF page-by-page onto `<canvas>` with **pdfjs-dist**, so it displays identically for every user + works on mobile.
- pdf.js lib + worker are committed under `public/pdfjs/` and loaded via a NATIVE `import(/* webpackIgnore */ "/pdfjs/pdf.min.mjs")` — letting webpack bundle pdfjs-dist's prebuilt ESM throws `TypeError: Object.defineProperty called on non-object` (confirmed for BOTH `build` and `legacy/build`). `scripts/sync-pdfjs-assets.mjs` (+ `pnpm run sync:pdfjs-assets`) regenerates them on a version bump; `eslint.config.mjs` ignores `public/pdfjs/**`.
- `isEvalSupported: false` on getDocument keeps it inside prod CSP (no 'unsafe-eval' outside dev — so the dev test did NOT exercise the prod path; reasoned + safe, not browser-verified under prod CSP because local prod build can't dev-auth).
- Verified working end-to-end in the in-app browser against Esraa's real CV (renders inline + fields beside, scrolls all pages, zero errors).

**Branch `feat/recruitment-pool-and-extraction-accuracy`** — candidate-pool table redesign + CV-extraction accuracy:
- Pool columns: Name · Status · **Source** (email addr for email / phone for WhatsApp) · **Applying for** (email subject / WA message, else AI-read role from CV) · **CV sent** (TRUE send time — email Date header / WA `message.timestamp` captured at intake, NOT record-creation) · **Subject/messages** · Actions. Both desktop table + mobile card.
- Extraction (`cv-extraction.ts`): when the cheap pdf-parse text pass is empty/garbled (<200 chars) or ≥2 key fields (fullName/email/phone/appliedPosition) are null/low-confidence → **second read of the actual PDF via OpenAI `input_file`** (GPT reads text + every page's layout natively — NO server-side canvas rasterization, which the standalone build can't do — see [[pdfjs-worker-tracing-gap-fix]]), then a field-by-field merge keeping the better value. `RECRUITMENT_CV_HIGH_ACCURACY_READ=true` makes the document read the PRIMARY pass (off by default, cost-gated).
- `cv-extraction-normalize.ts` (new, pure, unit-tested): Arabic-Indic/Persian digits → ASCII, Egyptian phone + email canonicalization. Also improves dedup matching (keys off email/phone — see [[whatsapp-cv-bulk-import-forwarding]]).
- New `appliedPosition` shared extraction field (storage jsonb → position_specific_fields), read back per candidate for the pool fallback.
- Intake send-time capture: email `mail.date` (email-message-parser.ts) + WA `message.timestamp` (whatsapp-payload-parser.ts) → `raw_metadata.sentAt`; surfaced via `describeCandidateSource` → `CandidateSourceContext.cvSentAt` (falls back to intake `created_at`). No new migration (reuses the existing `ats_candidate_source_context` view).

**Both are FORWARD-LOOKING**: existing candidates won't backfill the true send-date or AI position until re-processed/re-extracted (dev session did NOT trigger prod re-extraction — AI cost + prod writes). New CVs get everything.

**Roadmap decision (owner-approved):** Tier 1 (#1 weak-text→document fallback, #2 normalization, #3 low-confidence second look) + Tier 2 (#4 hybrid high-accuracy toggle, #5 all-pages via whole-PDF read) SHIPPED in branch B. **Tier 3 (#6 Google Document AI) DEFERRED** — it's an OCR pre-processor that's ADDED on top of a GPT call (not a replacement), GPT vision already OCRs, ~$0.0015/page but redundant; only add if the CV-extraction accuracy analytics show GPT vision missing on real CVs. Needs owner GCP setup (enable Document AI API + processor + creds) — not built.

**How to apply:** push each branch, open 2 PRs, DO NOT merge (separate approval). *Corrected 2026-08-23 — this line used to open with "run `pnpm run check:harden` on each branch". That gate was retired 2026-08-18 and no longer exists; AGENTS.md §7 now says push and let the PR's required checks answer ([[local-validation-gates-are-gone-ci-is-the-gate]]). The **DO NOT merge** half is unchanged and still binding — merging is a protected action needing the owner's separate approval, and since 2026-08-01 it ships to production immediately.* Related: [[recruitment-cv-viewer-and-source-context]] (the earlier #1359 viewer this builds on).
