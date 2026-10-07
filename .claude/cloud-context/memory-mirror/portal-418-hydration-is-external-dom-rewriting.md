---
name: portal-418-hydration-is-external-dom-rewriting
description: "Portal React #418 hydration errors are external DOM rewriting (Google/Microsoft/Samsung translate + extensions), NOT an app bug — settled by the app's own domRewriter detector and an exhaustive import-graph sweep. The translate=no opt-out was shipped (#3487) and REMOVED by the owner 2026-09-11; app/layout.tsx:98 forbids re-adding it. Do not re-investigate or re-apply the opt-out."
metadata:
  node_type: memory
  type: project
  originSessionId: 148528c7-4ca8-47cc-89bf-d72e4ed85da6
  modified: 2026-10-07T20:36:20.517Z
---

**React #418 (`args[]=text` = text-content hydration mismatch) on `/employee-portals*` is caused by
the reader's browser rewriting the page's text between SSR and hydration — not by app code.** The
workforce is Arabic-speaking, so browser machine-translation is constant.

Verified live on production 2026-10-07 (`ozucdzovmcqvepbozvqf`, `app_error_events`):
- Of 55 #418 rows in 30 days, **37 carry a `domRewriter=` marker** (27 `google-translate`, 10 other);
  **every #418 in the last 9 days carries one.**
- The 18 marker-less #418 rows were **7 routes × 5 people and stopped 2026-09-28** — "people, not
  pages," i.e. one reader's translator following them across unrelated routes, exactly what
  `src/lib/error-monitor/dom-rewriter.ts` documents.
- #418 recovers (React client-regenerates the subtree) — a reflow, not a dead screen.

**The fix was already tried and the owner removed it.** `translate="no"` + a `google: notranslate`
meta shipped in #3487 (2026-09-08) and were removed 2026-09-11: they stripped the translate offer
from every Arabic reader and did not even stop Samsung Internet's own translator, which honours
neither signal. `app/layout.tsx:128` already sets `suppressHydrationWarning` on `<html>`;
`app/layout.tsx:98` carries a block comment forbidding re-adding the opt-out without reading it.

**How to apply.** Read `domRewriter=` in the stack before anyone proposes a fix. Do NOT re-add
`translate="no"`, do NOT re-run the import-graph sweep (done twice, 154/155 files, no app cause),
and do NOT suppress the rows — the owner deliberately keeps them annotated for evidence. A genuine
app mismatch would show as ONE route × MANY users with NO rewriter marker and would be ONGOING; no
such cluster exists for #418. Related: [[script-error-is-never-app-code-65pct-of-client-errors]],
[[census-client-errors-by-stack-not-message]], [[a-broken-rsc-page-still-returns-http-200]].

**A DISTINCT, still-open question (NOT #418):** `/employee-portals` also shows a **React #412**
cluster (~23 rows, 30 days, mostly with NO rewriter marker and `readyState=complete`). #412 is a
different failure (Suspense boundary updated before it finished hydrating / a from-outside-React DOM
change) and has not been investigated to a verdict yet — it may or may not be app-side. Do not fold
it into the #418 conclusion above.
