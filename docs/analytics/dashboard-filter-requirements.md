# Dashboard Filter Requirements

This documents the filter model that actually drives the analytics dashboards under
`app/(analytics)/admin/analytics/**` — what filter types the registry supports, which
concrete filters are wired into each page today, and how to add a new one. It
describes reality, not an aspirational checklist: every filter listed below is live
and reachable from a URL query param on the corresponding page.

## The filter registry (`src/lib/analytics/filter-registry.ts`)

One typed `FilterDescriptor` config drives every dashboard — no page hardcodes its own
filter UI or query-param parsing. A descriptor is `{ key, label, type, source,
staticOptions?, placeholder?, multiple?, pipeline? }`.

**Supported `FilterType`s:**

| Type | UI | Used for |
|---|---|---|
| `single-select` | dropdown | period, week, year, channel |
| `multi-select` | multi-pick chips | distributor, line, region, area, product, family, customer, batch status |
| `date-range` | reserved for future calendar-range filters (not yet consumed by a page) | — |
| `text-search` | free-text input | employee HR ID, territory, batch ID |
| `boolean` | toggle | reserved for future flag filters |

**`FilterSource`** says where a filter's options come from: `static` (inline list),
or one of `periods` / `weeks` / `distributors` / `products` / `families` / `lines` /
`regions` / `areas` / `employees` / `territories` / `customers` / `batchStatuses` —
each loaded from the corresponding `analytics.dim_*` view or fact table via
`loadAnalyticsDimensions()` in `service.ts`.

`parseAnalyticsFilters(searchParams, descriptors)` turns the page's URL query params
into a typed `FilterValues` object using each descriptor's `type` to decide
single-vs-array parsing; `serializeFilters()` does the reverse for building filter-bar
links. `getFilterValue` / `getFilterArray` are the read helpers RPC callers use to pull a
value back out.

## Filters wired into each dashboard today (`src/lib/analytics/sales-filter-config.ts`)

| Filter | Key | Type | `/admin/analytics/source-sales` (`SOS_FILTERS`) | `/monthly-closing` (`CLOSING_FILTERS`) | `/weekly-sales` (`WEEKLY_FILTERS`) | `/executive-comparison` + `/reconciliation` (`EXECUTIVE_FILTERS`) |
|---|---|---|:-:|:-:|:-:|:-:|
| Period (month) | `period` | single-select | ✓ | ✓ | — | — |
| Period from / to | `periodFrom`/`periodTo` | single-select | ✓ | ✓ | — | ✓ |
| Year | `year` | single-select | ✓ | ✓ | ✓ | ✓ |
| Week | `week` | single-select | — | — | ✓ | — |
| Distributor | `distributors` | multi-select | ✓ | — | ✓ | ✓ |
| Line | `lines` | multi-select | ✓ | ✓ | ✓ | ✓ |
| Region | `regions` | multi-select | ✓ | — | ✓ | ✓ |
| Area | `areas` | multi-select | ✓ | — | — | — |
| Product | `products` | multi-select | ✓ | ✓ | ✓ | — |
| Product family | `families` | multi-select | ✓ | ✓ | ✓ | — |
| Channel (Distributor/Direct) | `channel` | single-select | ✓ | — | — | — |
| Customer | `clientCodes` | multi-select | ✓ | — | — | — |
| Employee (HR ID) | `employeeHrId` | text-search | — | ✓ | — | — |
| Territory | `territory` | text-search | — | ✓ | — | — |
| Batch status (staged/approved/rejected) | `batchStatus` | multi-select | — | ✓ | — | — |
| Batch (UUID) | `batchId` | text-search | — | ✓ | — | — |

A filter only appears on the pages whose `*_FILTERS` array imports it — enforcement is the
hand-curated arrays in `sales-filter-config.ts`, not per-page conditionals. The optional
`pipeline: "sos" | "closing" | "weekly" | "all"` field on a descriptor is documentation of
intent only; nothing reads it at runtime, so it must be kept consistent with the arrays by
hand (it does not itself gate visibility).

**Why employee/territory/batch filters are closing-only:** SoS and Weekly have no
employee attribution (geography/product-centric pipelines — see
`sales-analytics-model.md`); batch status as a real workflow state (staged → approved
→ rejected) only exists for Monthly Closing. Customer presence filtering is SoS-only
because `analytics.sos_by_customer` is presence data, not invoice rows, and isn't
modeled for Closing or Weekly.

## Comparison support

`src/lib/analytics/compare.ts` provides the period-over-period math every page needs
on top of these filters: `computePeriodDelta` (current vs prior value + null-safe
%), `shiftPeriod`/`shiftWeek` (month/week rollover at year boundaries, used to compute
"previous period" from whatever period filter is active). The executive-comparison and
reconciliation pages combine this with `EXECUTIVE_FILTERS`' `periodFrom`/`periodTo`
range to drive month-vs-month and source-vs-source comparisons.

## Extending the filter model

To add a new filter dimension: add one `FilterDescriptor` to
`sales-filter-config.ts`, add it to whichever `*_FILTERS` array(s) it applies to, and
— if it needs a new options source — add a case to `loadAnalyticsDimensions()` in
`service.ts` and a `FilterSource` value in `filter-registry.ts`. Every page consuming
that `*_FILTERS` array picks the new filter up automatically via `AnalyticsFilterBar`;
no page-level changes are needed.
