# How a table renders inside an email template body

The account behind the module-memory hook in `.claude/rules/notifications.md`, "A TABLE INSIDE A
TEMPLATE BODY OWNS ITS FILLS AND NOT ITS INK". Measured in the Browser pane on 2026-10-09 against
the production planner's reorder alarm, rendered from that day's live `prodplan_alarm_events` rows.

## The two mechanisms that bite

`{{detailsTable}}` is interpolated into the **stored** template body, and the whole interpolated
body then goes through `sanitizeEmailTemplateHtml` (`src/lib/email/email-safety.ts`) before the
layout wraps it. Two consequences, neither visible in the source:

1. **The sanitizer drops `class`.** Every `.phoenix-*` rule in
   `src/emails/phoenix-email-layout.tsx` — including both dark-mode blocks — therefore misses the
   table completely. A rule written for `.phoenix-grid-head` can never match.
2. **The table does not own its ink.** `.phoenix-text td, .phoenix-text span { color: … !important }`
   exists in BOTH colour schemes and beats an inline `color:` declaration, while an inline
   `!important` is itself stripped here (the value stops matching the allowed-value pattern). So a
   cell cannot set its own text colour at all.

Measured outcome before the fix: a dark header band with white headings rendered **blank in light
mode**, and white body cells rendered **blank in dark mode** — in both cases the fill came through
and the text did not, because the fill was inline and opaque while the ink was inherited.

## What the grid therefore does

- **Translucent `rgba()` fills over inherited ink** — the same wash reads on a white body and on a
  dark one, so no scheme needs its own text colour.
- **The opaque `bgcolor` attribute is kept** on every row and cell, because Outlook's Word engine
  ignores CSS backgrounds (and has no dark mode to reconcile).
- **The dark-mode blocks re-tint by the `bgcolor` ATTRIBUTE selector** — `td[bgcolor="#f1f5f9"]`
  and friends, in both the `@media (prefers-color-scheme: dark)` block and the `[data-ogsc]` one.
  That attribute is the only handle on a sanitised table that survives.

## The allowed-style list is narrower than it looks

`border-bottom`, `text-transform`, `vertical-align`, `white-space`, `border-radius` and
`box-shadow` are all dropped. So a hairline is a whole-cell `border`, and a heading is written in
the case it must appear in rather than upper-cased by CSS. `-webkit-text-fill-color` was ADDED to
`allowedStyles` on 2026-10-09: the layout writes every colour as the `color` /
`-webkit-text-fill-color` pair, and this half used to be stripped, which also quietly affected the
existing metadata table on the same path.

## The two renderers

| Renderer | Shape | Used by |
| --- | --- | --- |
| `renderPhoenixDataGrid` / `renderPhoenixDataGridText` | columnar zebra grid, built to the limits above | the production planner's reorder and expiry alarms |
| `renderPhoenixMetadataTable` / `…Text` | label/value summary | every older email that carries a details table |

Pinned by `tests/email-zebra-survives-sanitizer.test.ts`, which asserts behaviourally against the
real sanitizer and then reads the layout source for the rules a sanitiser cannot be asked about
(no `background` shorthand, no hard-coded text colour, both dark-mode `bgcolor` rules present).
