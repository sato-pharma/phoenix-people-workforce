---
name: a-careers-cards-english-title-routes-the-apply-form
description: "A satopharma.com careers card routes its Apply button to a Phoenix role by matching its ENGLISH TITLE, so the panel title must match the route regex — \"District Sales Manager\" fails /district\\s*manager/i and silently falls back to email"
metadata:
  node_type: memory
  type: reference
  originSessionId: e1b23ac6-5f7b-4d02-a735-40455cc04d5a
  modified: 2026-10-16T15:09:43.009Z
---

`frontend/src/lib/phoenix-apply.ts` in `Sato-Pharma-Website` holds `PHOENIX_ROLE_ROUTES`, and
`phoenixApplyRoleForJob` tests each route's regex against the job's **English title** — not the
slug, not the location. First match wins. The live routes (16 Oct 2026): `hr_section_head`,
`office_coordinator`, `talent_acquisition_specialist`, `product_manager`, `national_sales_manager`,
`district_manager` (`/district\s*manager/i`), `medical_representative`,
`regulatory_affairs_specialist`, `quality_control_analyst`.

**How to apply:** when the owner adds an opening in the panel (Careers → Post a job), give the
English title in the spelling the regex matches and say so — `District Manager`, never
`District Sales Manager`, because `\s*` matches whitespace only and the word "Sales" between them
breaks the match. A title that matches nothing still posts a perfectly valid card; the Apply button
just drops to the email fallback, which looks like a working page. Verify by fetching
`/{en,ar}/careers/apply?slug=<slug>` (the card links there; there is no `/careers/<slug>` page) and
checking the real questions render and the phrase "email us instead" does not. An area belongs in
the title after the role (`District Manager — Alexandria & Behira`), which keeps the match and makes
the slug unique.

Related: [[recruitment-automation-spec-before-build]]
