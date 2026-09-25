---
name: a-role-probe-cannot-trust-the-http-status-code
description: "A Next App Router redirect() that fires AFTER the layout has streamed returns 200 with a meta-refresh, not 307 — so a role sweep keyed on status code reads a correct redirect as a successful render"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 2660f573-67f5-4949-b3d2-31bccf171402
  modified: 2026-08-14T14:12:23.922Z
---

Measured 2026-08-14 verifying `/employee-portals/cv-field-settings` across roles.

`redirect()` in a server component only produces an HTTP **307** while the response headers are
still open. Once the enclosing layout has streamed its shell, Next cannot change the status, so it
falls back to embedding the redirect in the already-sent HTML:

```html
<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/recruitment/cv-field-settings">
```

The response is **200** with `NEXT_REDIRECT` in the flight payload. Super Admin hitting the portal
twin looked like "200, renders nothing" — no switches, and no `EmployeePortalEmptyState` either —
which reads as a broken page. It was the guard working exactly as written.

**So a role matrix built from status codes alone is wrong.** Three different outcomes all return
200: the page rendered, the page rendered a deny state, and the page redirected. Distinguish them by
grepping the body — a distinctive control label, the deny message, and `__next-page-redirect` /
`NEXT_REDIRECT` — never by `StatusCode`. This is the trap for the `role-sweeper` agent and any
`Invoke-WebRequest -MaximumRedirection 0` loop.

Two more counting traps from the same session:

- **Next dev HTML double-counts every element.** The RSC flight payload is embedded as escaped
  `<script>` data, so a raw `role="switch"` count came back 66 for 33 switches. Count **distinct**
  labels (`Extract <Field>`), not raw occurrences, or halve the number knowing why.
- **A locked field renders no switch at all.** `FieldControl` in
  `src/components/recruitment/cv-field-settings-view.tsx` returns an "Always on" badge for
  `field.locked` instead of a disabled `Switch`, so switch count ≠ field count by design
  (33 toggleable + 3 locked = the 36 in `src/lib/recruitment/cv-field-schemas.ts`).

Both headers are still required to get a page at all — see
[[dev-auth-is-header-only-browser-pane-cannot-use-it]].

## 2026-08-23 — it happened again, and the tell is that ONE route gives two different redirect kinds

Second confirmed occurrence, sweeping `/hiring-documents` across 8 roles. This file already existed
and already named the `role-sweeper` agent — it was not consulted, and the sweep shipped a wrong
table claiming CEO and SFE Manager could open a page they cannot.

The sharper diagnostic, new here: **on the same route, different roles return different KINDS of
redirect**, because the two guards live at different depths.

| Role | What came back | Why |
| --- | --- | --- |
| Talent Acquisition | real `307` + `Location: /employee-portals` | the admin **layout** redirects portal-mode roles before anything streams |
| CEO, SFE Manager | `200`, no `Location` | the **page** calls `redirect()` after the shell has flushed |

So a table built from status codes looks *internally inconsistent* (why does one denied role 307 and
another 200?) and the natural reading — "the 200s must be allowed" — is exactly backwards. Both are
denials. `curl` without `-L` does not save you: the meta-refresh 200 is a genuine 200.

**The cheapest reliable separator is response SIZE against a known-good control.** No parsing, one
number:

```
Super Admin  14,197,854 bytes   "Andaros" x57   <- rendered
CEO             239,498 bytes   "Andaros" x0    <- redirected
Medical Rep      37,660 bytes                   <- redirected, different shell
```

Grep the body for an employee name and it is unambiguous. **Always fetch the control in the same
sweep** — the first pass here grepped only denied roles, all returned 0 hits, and 0 looks like proof
until you learn the allowed role also returns 0 when the data loads client-side. It does not here,
but that was luck, not method.

Also worth pinning: the two role sets that govern such a page can be checked statically instead of
probed. For hiring documents, `hrAuthorityNavigationRoles` (sidebar) in `system-navigation.ts` and
`hrAuthorityRoles` (page gate) in `src/lib/auth/permissions.ts` are both exactly
`["Super Admin", "Talent Acquisition"]` — reading those two lines answers the whole matrix in
seconds and would have caught the wrong table before it was written.
