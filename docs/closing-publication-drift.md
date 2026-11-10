# Has a published closing moved — and which areas hold the difference?

The account behind the `sales-closing` module rule *"HAS A PUBLISHED MONTH MOVED" TAKES BOTH LAYERS*.
The rule in `.claude/rules/sales-closing.md` is the cue; this is the evidence, kept out of the
auto-loaded files because they are re-sent on every request (AGENTS.md §2.2).

## What was already there, and why it said nothing

`phx_closing_drift_status` has answered this question all along, in three numbers: `drifted_cells`,
a net units delta and a net value delta. **Both deltas are SUMS over the drifted cells**, so a
redistribution *between areas* cancels to zero in each of them. Read on production 2026-10-09 for
Anti Infective 2026-09, which was published:

```
drifted_cells 27   net_units_delta 0.000000   net_value_delta 0.000000   verdict unreviewed
```

At that same moment **Menoufia 2 had lost 1,111.50 EGP** and Giza Centers had gained 858.45, across
25 areas and 3,476.40 EGP of movement in total. The one surface that could have spoken said nothing,
and the summary did not merely understate the move — it read exactly like a clean month.

## The blind spot is the LAYER, not the grain

The obvious fix — add area columns to the drift status — would have surfaced nothing new. It already
compares per area × product × `is_direct`, units **and** value. Its snapshot is built from
`source_of_sales_fact_rollup`, which holds the **as-invoiced** geography, so
`au.monthly_store_split_net` never enters it at all. The two layers have to be read together:

| Layer | Source | Measured cost, 2026-09 |
| --- | --- | --- |
| published lines | `monthly_closing_publications` | 328 ms |
| publication cell drift | `phx_closing_drift_status` per line | 743 ms |
| fact-rollup area moves | the drift cells, aggregated per area | 424 ms |
| **store-split** | `loadStoreSplitDrift` — recomputes the whole period | **17,282 ms** |

`src/lib/sales/closing-publication-drift.ts` reads all four and
`scripts/check-closing-publication-drift.ts` prints them with area **names**. It reuses
`loadStoreSplitDrift` rather than rebuilding the recompute: a hand-built row set once reported 43
drifted pairs against a real 6. The two implementations agree to the cent — both report
1,030,551.19 EGP over 76 line × area pairs and 347 cells for 2026-09.

## The freeze cuts the other way too

> **Fixed 2026-11-10 — a published closing now freezes its own line only** (owner: "Unfreeze Pedia +
> CNS only"; migration `20261110103127_freeze_only_the_published_line.sql`, pinned by
> `tests/closing-freeze-per-line.test.ts`). The section below is the history that led there: on
> 2026-11-10 the same shape read the Qalubeya Pedia rep at 648% for October, because Anti Infective
> October was published on 4 November and El Qema's October book landed on the 8th into a frozen
> month. Rebuilt per line, Qalubeya read EGP 73,405 against 178,241 (41%), and Anti Infective's
> published rows kept their fingerprints exactly. A published line with no `line_code` still freezes
> the whole period (fail closed).

Until then `isFrozenStoreSplitPeriod` matched `monthly_closing_publications` by **period, with no line
filter** (PR 4848 had closed an earlier per-line version). So publishing *one* line froze
`au.monthly_store_split_net` for **every** line in that month. An unpublished line's frozen net then
goes stale with nothing announced for it, and the exposure runs in the opposite direction: it is what
the month will be published **onto** unless the net is rebuilt first.

Measured 2026-10-09 on 2026-09, with only Anti Infective published: **1,030,551.19 EGP** across Pedia
and CNS sitting on a different area than today's rule gives it, Qalubeya alone at −624,623.51. The
figure grew through the day — an earlier read the same afternoon was 839,283.83 — because the
September distributor books were still landing against a net frozen 2026-10-04 16:52. The report
keeps these lines apart from the announced ones (`frozenNotPublished`), because none of it is a
restatement yet.

## Why the Needs You board reads only three of the four layers

The board gives every source 8 seconds and renders a slower one amber forever, which is how a reader
learns to ignore amber — `src/lib/needs-you/types.ts` records the org-wide vacation source that was
left out for exactly this reason. At 17.3 s the store-split layer cannot be in a live source, so
`loadPublicationDriftWithoutSplitLayer` reads the other three and sets `splitLayerRead: false` —
for the latest published period only, for the measured reason in the next section.

That flag exists because **an empty `split.byArea` and a split that genuinely did not move produce
the same report**. Without it a caller would take the partial for the whole:

- `publicationDriftProvenClean(report)` is the only way to assert a period is clean, and it is false
  whenever `splitLayerRead` is false. `!report.drifted` is precisely the assertion that would turn an
  unread layer into a calm month.
- `mergePublicationDrift` throws if `splitLayerRead` is false while `split.byArea` carries rows — a
  real read mislabelled as a partial.
- Every board row names the script, so a partial row is never read as a whole-month verdict.
- `check-closing-publication-drift.ts` refuses a report whose `splitLayerRead` is false: it exists to
  print the half the publication check cannot see.

The board row counts **areas and cells, never EGP** — the same rule the payroll row follows. The
money is on the Monthly Closing screen, which is also the only place this is decided.

## What the live run taught, and the two defects it caught

The first end-to-end run of the board source against production, 2026-10-09, read all three published
periods. It exposed two things no unit test had:

**1. It took 15,352 ms, not the 1.5 s one period had suggested.** Three periods, seven line × period
pairs. So the source reads the **latest published period only** — the month whose books are still
landing and the only one where rebuilding is a live choice. Re-issuing a month announced long ago
restates a number nobody is still deciding, and a row that appears every day forever is wallpaper.
Scoped that way it measures **1,670 ms**. The script answers for any other month.

**2. A statement timeout was arriving as a quieter row.** `phx_closing_drift_status` for CNS 2026-07
and 2026-08 answered `canceling statement due to statement timeout` — intermittently; a later run of
2026-08 read all three lines and reported CNS at **285 drifted cells with both nets 0.00**, the same
cancelling shape. `loadPublicationCellDrift` caught that and returned `null`, which is *also* what a
line with no publication row looks like, so the board row rendered one sentence shorter and otherwise
identical to a complete one. A failed read presented as a calmer answer is the precise failure the
board exists to prevent.

Both loaders now reject instead of swallowing, and the two callers differ on purpose:

| Caller | On a failed line | Why |
| --- | --- | --- |
| `loadClosingPublicationDrift` (the script) | names it in `linesNotRead` and prints the rest | a person is watching; the split half for every other line is still worth printing |
| `loadPublicationDriftWithoutSplitLayer` (the board) | lets the rejection travel | no reader to notice a partial, so `service.ts` renders the amber "could not be read" row |

`publicationDriftProvenClean` is false while `linesNotRead` holds anything, and the script prints the
unreadable lines **before** any figure — Telegram slices from the end, and a section rendered last is
one that silently disappears.

## What nothing here does

Re-issuing a published closing restates an announced number, and rebuilding a frozen net changes the
geography a published month was announced on. **Both are the owner's decision on the publication
screen**, so the detector reports and never writes, never acknowledges a drift, and exits 0 even when
it finds one. `--fail-on-drift` exists for a caller that deliberately wants a gate, with the warning
that this is expected to be non-empty while a month is still receiving uploads — and a check that
fires at the normal working level becomes wallpaper.

For the store-split half specifically, the sequence is his: he unpublishes the period, then
`scripts/backfill-attribution-store-split.ts --apply <period>`, then
`select au.f_refresh_monthly_attribution('<period>')`, then he re-publishes.

Pinned by `tests/closing-publication-drift.test.ts`.
