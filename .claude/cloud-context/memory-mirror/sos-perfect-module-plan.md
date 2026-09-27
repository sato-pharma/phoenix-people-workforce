---
name: sos-perfect-module-plan
description: "The Source-of-Sales upload module is BUILT and live on /sales (upload, import, normalizer, truth-check, diagnostics, missing-data, customer-mapping, database-mapping, closing-corrections, monthly-closing, distributor-profiles, targets, territory-management). Read this for the owner's locked design DECISIONS — WHY it is shaped this way — not as remaining work: detection verifies the picked distributor AND cross-checks (warn, never block), AI fires only when recognition is stuck (header text only), and new distributors are onboarded through a governed DB-backed profile store. Monthly onboards a new distributor by mapping; weekly is edit-only and a new weekly distributor needs an ADAPTER."
metadata:
  node_type: memory
  type: project
  originSessionId: 33188cea-8df8-4c8b-b41a-3129969f44d0
  modified: 2026-09-26T01:53:23.856Z
---

## This is the rationale, not a backlog — the module is built

The owner asked (2026-06-20) to build SoS ingestion into a "perfect module"; **it is built and live.**
The `/sales` surface carries `upload/`, `import/`, `normalizer/`, `truth-check/`, `diagnostics/`,
`missing-data/`, `customer-mapping/`, `database-mapping/`, `closing-corrections/`, `monthly-closing/`,
`monthly-dashboard/`, `distributor-profiles/`, `customer-directory/`, `targets/` and
`territory-management/`. Read this file for the **reasoning behind the design**, not as work to do. The
operative rules have since moved into standing form (the monthly closing is the only sales truth; the
closing golden rule forbids publishing during the month it covers; the old monthly-closing export is
frozen; the normalizer is Super Admin only). Page context: [[sales-upload-two-pages-weekly-wizard]].

## The owner's locked decisions (the WHY)

- **Scope = the whole pipeline** — `/sales/upload` monthly + weekly, Mapping Database, Diagnostics, the
  shared normalizer, validation, governance.
- **Detection is BOTH-and:** verify against the distributor the user picked (primary) AND run an
  independent auto-detect cross-check ("did you pick the wrong one?"). The cross-check **warns, never
  blocks** — it raises `detector_disagrees_with_pick` as a blocks-until-ack WARNING only when its
  confidence is high and the detected code differs, and it flows through the existing ValidationPanel.
- **AI is a last resort, not the normal path:** rule-based normally; the LLM fires **only** when a header
  is unrecognized/ambiguous, to explain and suggest a mapping. **Header/column titles ONLY — never row
  data or products** — and it excludes `LA003`/`LA004`/`SS001`. **With no API key it is a silent no-op
  that never throws.**
- **A new distributor is onboarded in-app** ("map it & save") through a **governed, DB-backed, editable
  profile store merged OVER the code defaults** (DB-first merge, fails-closed), with service-role-only
  writes, RLS and an audit trail — deliberately reversing the earlier migration that had dropped it.
- **Baseline recognition:** scan the first 30 header rows (`HEADER_SCAN_ROWS`), across ALL worksheets,
  with Arabic normalization and validation-noise reduction.
- **Cadence the owner chose:** ship each phase as its own gate-green PR and **ask before EVERY production
  merge.**

## The durable architecture that resulted

- **One shared header normalizer** — `src/lib/sales/normalizer/header-normalize.ts` (`normalizeHeaderKey`,
  `foldArabicDigits`, `HEADER_SCAN_ROWS`); all three readers (engine header map/validation,
  detect-distributor, distributor-detection's all-sheets header extract) go through it, and the resolvers
  fold Arabic digits. Header-row pick prefers the row with the most KNOWN headers, not the widest row.
- 🔴 **Monthly vs weekly distributor editors differ fundamentally:**
  - **MONTHLY** (`source_of_sales_distributor_profile`, Sales Operations) — the monthly engine is a
    generic name-alias matcher, so a **NEW monthly distributor can be onboarded by mapping alone.**
  - **WEEKLY** (`weekly_sales_distributor_column_profile`, Weekly Sales) — the weekly parser was made
    **contract-driven** (it reads column index / header row / matrix from a resolved contract, defaulting
    to the code contract so **"no override == byte-identical"**). But it is **EDIT-ONLY for the 6 built-in
    distributors (EG / RM / IS / IS-S / SF / PS)** — **a NEW weekly distributor needs an ADAPTER, not just
    a mapping.** Locked boundary: only the **column index + header row** are editable; role, form field,
    semantics and the PS matrix are fixed in code. The AI-verify path resolves the SAME contract, so it
    cannot green-lie about an override.
- Both editors are **edit-only safety surfaces** — they carry a live header preview (a sample file is read
  for headers only, never persisted) and a recent-changes audit panel — and they do not weaken the
  parser's byte-identical guarantee.
