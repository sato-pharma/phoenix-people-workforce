---
name: portal-responsive-data-list-renders-every-row-twice
description: "PortalResponsiveDataList emits the card markup AND the table markup for every item and hides one half in CSS — so an uncapped list costs 2x full renders. Doctor Coverage shipped 18.8MB of HTML to phones this way. Window any list before putting it on the primitive."
metadata: 
  node_type: memory
  type: project
  originSessionId: 391647f9-8f7a-4e5f-a51e-3371c51627f0
  modified: 2026-09-05T06:31:03.596Z
---

**The primitive does not choose a half — it renders both.** `PortalResponsiveDataList` emits the
mobile card list *and* the desktop table for every item it is handed, and CSS hides one. So the
markup cost is **2× the row count at every screen width**, and the phone downloads the desktop half
it can never see.

Measured on production 2026-08-21, `/admin/doctor-coverage` **18.8 MB**, `/employee-portals/doctor-coverage`
**18.6 MB**:

| part | size | share |
| --- | --- | --- |
| rendered markup — 7,175 `<article>` + 7,127 `<tr>` + 49,875 `<td>` | 16.5 MB | **88%** |
| serialised RSC props | 2.3 MB | 12% |

**This matters module-wide**, not just here: 44+ files under `src/components` use the primitive and
the CRM conversion is still rolling out. **Check the row count before putting a list on it.** Bounded
lists are fine — the Doctor Coverage call list is capped at `DOCTOR_COVERAGE_CALL_LIST_SIZE` (50) in
`src/lib/crm/sfe-doctor-coverage.ts`, the rep table is one row per rep.

**Confirmed on production after #2282 shipped (revision `1a9dcd4a`), same probe, same routes:**

| | before | after |
| --- | --- | --- |
| `/admin/doctor-coverage` | 18.8 MB | **2.8 MB** |
| `/employee-portals/doctor-coverage` | 18.6 MB | **2.7 MB** |
| rendered markup | 16.5 MB | **0.6 MB** |
| serialised props | 2.3 MB | **2.3 MB — unchanged** |
| `<article>` / `<tr>` | 7,175 / 7,127 | 144 / 96 |

The props line is the important one: windowing is client-side, so **the server still computes and
serialises every row.** Cutting that last 2.3 MB needs server-side pagination.

**Open, unrelated to the payload:** both doctor-coverage routes answer in **~15 s** (15.0 / 15.3 /
15.4 s on three consecutive reads) against **985 ms** for `/admin/brick-coverage` as control. Always
just over 15 s, which is a boundary smell, not a query curve — see
[[supabase-client-15s-timeout-commits-anyway-half-applies]]. No before-baseline was captured, so this
is NOT known to be a regression; it was simply never measured until 2026-08-21.

Fixed in #2282 by windowing at 25 (`PortalPagination` + a `PAGE_SIZE` constant — the house pattern in
`marketing-customer-database.tsx`, `my-visits-workspace.tsx` and 6 more). **Windowing is display-only:
search, sort, filter and the xlsx export must keep spanning the full `rows` prop** — a windowed export
is a silent drop.

> 🔴 **THE GUARD FOR THAT IS GONE — measured 2026-09-05.** This line said
> `tests/crm-doctor-coverage-pagination.test.ts` "has an assertion for exactly that". That file no
> longer exists: it was deleted along with the Rep Doctor Lists board it covered
> ([[crm-month-over-month-does-not-compare-the-same-reps]], PR #2938, 2026-09-02) — reasonable, since
> the board went. **What went with it was the only test naming this invariant.** Measured against
> `git ls-files`: **0 tests reference `PortalPagination`**, while **6 files under `src`/`app` still
> use it. So the rule above is now enforced by nothing.** (11 tests mention `PAGE_SIZE`, but none was
> confirmed to assert the export spans the full `rows` prop — do not read that count as coverage.)
>
> **This is the dangerous shape of a dead path: not a broken link, but a claimed protection.** A
> session reading the old sentence believes a regression test will catch a windowed export, so it
> ships one without checking. The invariant is still correct and still matters — it simply has to be
> verified by hand until a test is written against a component that still exists.
Reset the page from explicit handlers, never a `setState` in `useEffect` ([[set-state-in-effect-is-a-lint-error-here]]).

**Payload composition probe** — inline scripts hold the flight props, everything else is markup:

```js
const t = await (await fetch(path, {credentials:"same-origin"})).text();
let s = 0; for (const m of t.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) s += m[1].length;
({ totalKB: t.length>>10, scriptKB: s>>10, markupKB: (t.length-s)>>10,
   articles: (t.match(/<article\b/g)||[]).length, trs: (t.match(/<tr\b/g)||[]).length })
```

Same tab-based probe as [[a-broken-rsc-page-still-returns-http-200]]; the primitive's other trap is
[[a-server-component-cannot-pass-a-function-to-a-client-one]].
