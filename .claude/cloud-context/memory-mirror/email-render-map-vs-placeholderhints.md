---
name: email-render-map-vs-placeholderhints
description: "Email tokens render ONLY if in contextVariables() (now render-core.ts) — placeholderHints is editor-only, not the renderer"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 8c826290-3610-4c5c-80f9-d84104d12c1c
---

Email tokens `{{x}}` resolve at send time from **`contextVariables()`** — the
authoritative render map. `placeholderHints` is a SEPARATE list used only for the
template-editor's validation UI. A token can be on the `EmailTemplateContext` type,
in `placeholderHints`, and used in a template body, yet still render **EMPTY** if it
is missing from `contextVariables()`.

This shipped the probation blank-token prod incident (2026-07-14): DV-snapshot +
milestone emails went out with blank DV date / evaluator / score / day. The first
hotfix (#1062) wrongly added the tokens to `placeholderHints` only — still blank.
The real fix (#1063, live commit `78d9acb2`) added them to `contextVariables()`.

Hardening (#1064, `render-core.ts`): the pure engine — `interpolate`,
`contextVariables`, `htmlBlockTokens` — is now extracted to
`src/lib/email-templates/render-core.ts` (zero non-type imports, so it runs under the
type-stripping test runner; `service.ts` still imports the `.tsx` layout and can't).
`tests/email-render-harness.test.ts` functionally renders tokens AND asserts, for
EVERY module, that each `{{token}}` used in a template body is in the render map.

Distinct from [[probation-email-no-data-token-gap]]: that gap was the *caller* not
supplying a token via `templateContext`. This one is deeper — the probation emails
DID carry every value in `templateContext` (verified in the prod outbox payload), but
`renderEmailTemplate` builds its variables from `contextVariables()`, a **closed
allowlist**, so a `templateContext` key absent from that map is silently dropped. Both
layers must have the token.

When adding a new email token: put it in `contextVariables()` (render-core.ts), not
just `placeholderHints`, and make sure the caller supplies it via `templateContext`.
See [[email-template-unification]].
