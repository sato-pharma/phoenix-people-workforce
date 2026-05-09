# I18n Plan

## Why This Is Needed

The repository already stores Arabic employee data, but the application is still effectively English-only at the presentation layer.

Observed gaps:
- `app/layout.tsx` hardcodes `lang="en"`
- many formatters use hardcoded `en`, `en-US`, or `en-GB`
- there is no centralized locale resolver or text-direction helper
- there is no documented fallback strategy for Arabic display fields such as `name_ar`

## Initial Scope

Target locales:
- English (`en`)
- Arabic (`ar`)

Target regions for formatting:
- English Egypt (`en-EG`)
- Arabic Egypt (`ar-EG`)

## Phase Plan

### Phase 1: Baseline Locale Infrastructure

- keep a single locale configuration module in `src/lib/i18n/config.ts`
- define supported locales, fallback behavior, and text direction
- add tests so locale assumptions stay stable in CI

### Phase 2: Formatting Consolidation

- replace scattered `Intl.*("en-US")` and `toLocaleString("en-US")` usage with shared helpers
- standardize date, currency, and numeric formatting by app locale
- stop introducing new hardcoded formatter locales in feature code

### Phase 3: UI Metadata and Direction

- move page shell metadata from hardcoded English toward resolved locale values
- support `dir="rtl"` for Arabic
- review charts, tables, badges, and form layouts for bidi safety

### Phase 4: Content Strategy

- define which labels are static product copy versus operational data
- add translation dictionaries for static UI strings
- establish fallback rules for employee names:
  - Arabic-first screens should prefer `name_ar` when present
  - English-first screens should retain current Latin-name behavior

### Phase 5: Data Entry and Import Safety

- normalize Unicode handling for Arabic spreadsheet imports
- validate that exports preserve Arabic text without mojibake
- test search and sorting behavior for mixed Arabic/English employee records

## Acceptance Criteria

- locale selection is centralized
- Arabic pages can render with RTL direction safely
- financial and date formatting no longer depend on scattered hardcoded English locale strings
- employee Arabic names survive import, display, search, and export workflows

## Immediate Follow-Up

- migrate one small shared formatter path first
- then replace hardcoded locale formatting incrementally by domain, starting with payroll and employee directory screens
