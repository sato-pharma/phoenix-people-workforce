---
name: bilingual-bodies-need-direction-per-line-not-per-block
description: "Arabic+English text in one value: dir=auto on the block is the WRONG fix and breaks the English half. Direction must be per line. Single-language free text is the opposite — block-level dir=auto is correct there."
metadata: 
  node_type: memory
  type: project
  originSessionId: e33bc510-fa9c-48dd-9f02-36e8d91f528d
  modified: 2026-08-30T00:44:35.889Z
---

**Two different bugs that look like one.** Arabic free text rendered in this app's default
left-to-right container displays against the reader. The reflex fix is `dir="auto"` on the block,
and it is already house style here — 57 files use it (e.g.
`src/components/approvals-hub/direct-order-request-detail.tsx`). For a **single-language** value —
a name, a note, a reason, an address — that is correct and sufficient. Do not over-engineer it.

**But `dir="auto"` reads only the FIRST strong character**, and applies that direction to the whole
block. Give it a value that is Arabic *and then* English — which every WhatsApp recruitment reply
is, and which any bilingual template will be — and it finds Arabic, turns the entire block RTL, and
renders the **English** half backwards: `Thanks for contacting Sato Pharma.` becomes
`.Thanks for contacting Sato Pharma`. That is the exact mirror image of the bug being fixed, so a
session that "fixes" it this way has moved the defect rather than removed it, and both states look
plausible in a diff.

**The fix for a bilingual body is direction PER LINE**, because a line is the unit these messages
are actually composed in, and per-line is what WhatsApp itself showed the recipient. Worked example:
`MessageBody` in `src/components/recruitment/whatsapp-replies-view.tsx` — split the body on `\n`,
one `<span dir="auto" class="block whitespace-pre-wrap break-words">` per line, and render an empty
line as `" "` or the blank the sender put between the two halves collapses. Pinned by
`tests/whatsapp-replies-panel.test.ts` section 3b, which counts `dir="auto"` occurrences against the
**code with comments stripped** — the component's own comment names the wrong fix in order to warn
against it, and a naive count reads that warning as the defect.

**NEITHER bug is visible in source, or to any check this repo runs.** Both shipped through four
green CI checks. Only rendering the real strings in a real browser shows it. Measured 2026-08-30 at
375px on the real wrapper chain, per [[verify-a-mobile-layout-without-a-dev-server]] — note that
memory says the app font is DM Sans; it is **Aptos** (`src/styles/tokens.css:262`), and a wrong font
makes every width fiction.

**Where it is live, measured in production 2026-08-30 (`ozucdzovmcqvepbozvqf`)** — check the data
before "fixing" a screen, because most of these are English-only:

- `outstation_expense_requests.notes` — Arabic in **17 of 48** filled rows, rendered at
  `src/components/outstation/outstation-requests-admin.tsx:588` with no `dir`. Single-language, so
  block-level `dir="auto"` is the right fix here.
- Same table: `residence_address` / `residence_area` / `residence_city` Arabic in **70 of 70**;
  `to_label` in 31 of 70.
- `coaching_reports` — **0 Arabic in 112 rows**. `employee_plan_comments` — **0 in 8**. Not
  affected; do not touch them to make things look consistent.

Ten multi-line text blocks app-wide carried no direction handling at that date. Find them with
`git grep -l "whitespace-pre-wrap" -- 'src/**/*.tsx'` and check each against production data rather
than assuming — the counts above will drift, the method will not.

Related: [[arabic-name-search-needs-orthographic-normalization]] ·
[[tailwind-merge-strips-custom-named-font-sizes]]
