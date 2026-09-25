---
name: a-server-component-cannot-pass-a-function-to-a-client-one
description: "PortalResponsiveDataList lives in a \"use client\" module, so a SERVER component that renders it 500s on every load — this took both Doctor Coverage routes down for an hour on 2026-08-21. Check the import graph, not the directive: a file with no \"use client\" is still a client component when its only parents are."
metadata: 
  node_type: memory
  type: project
  originSessionId: 391647f9-8f7a-4e5f-a51e-3371c51627f0
  modified: 2026-08-21T09:47:39.635Z
---

**`src/components/employee-portal/portal-primitives.tsx` starts with `"use client"`.** Anything
it exports — `PortalResponsiveDataList`, `PortalDesktopTable`, `PortalRecordCard` — is a client
component. `PortalResponsiveDataList` takes `getKey` / `renderCard` / `renderTable`, and React
cannot serialise a function across the boundary:

```
⨯ Error: Functions cannot be passed directly to Client Components unless you explicitly
  expose it by marking it with "use server".
  {empty: Null, getKey: function getKey, items: ..., renderCard: ..., renderTable: ...}
```

**One digest per function prop, not per route** — `1878765947` (getKey), `3180310587`
(renderCard), `923360379` (renderTable), all from a single call site. Never infer blast radius
from how many digests appear.

PR #2264 moved `src/components/crm/doctor-coverage-board.tsx` onto the primitive. That board has
**no `"use client"`** and is mounted by both `app/(admin)/admin/doctor-coverage/page.tsx` and
`app/employee-portals/doctor-coverage/page.tsx`, so both routes died. Fixed in #2275 by inlining
what the primitive emits (it is pure layout — a `md:hidden` card map plus `renderTable()`), which
keeps the board server-rendered. Adding `"use client"` would also work but ships the whole board
to the phone.

**The trap that made the CI guard hard:** `tests/crm-mobile-table-cards.test.ts` *required* the
board to use `PortalResponsiveDataList` by name — the test was mandating the crash. It now checks
the outcome (`md:hidden` + `PortalRecordCard` + `hidden … md:block`) for that one file. Its two
siblings, `doctor-coverage-tables.tsx` and `rep-doctor-lists-tables.tsx`, keep the by-name pin
because both are client modules.

**Judge by the import graph, never by the directive.** A file with no `"use client"` is a *client*
component whenever its only parents are client components — that is how `src/components/ui/switch.tsx`
legally takes `onChange` from `payroll-history.tsx`. A directive-only version of this check flags
seven such pairs across payroll and outstation that have shipped and worked for months.
`tests/rsc-client-function-props.test.ts` walks out from every `app/**/{page,layout,template,default,route}`
and stops at each `"use client"` file, so only genuinely server-reachable modules are flagged.

Nothing else in the repo was affected: all 24 other users of the primitive already declare
`"use client"`. Verified by digest probe, not status code —
[[a-broken-rsc-page-still-returns-http-200]].
