# Phoenix Ranks counted no place case at all — the key, and who actually moves

**12 Oct 2026.** Gap 10 of the second-pass CRM audit widened the Integrity pillar to the strong
cases filed against a **place** the rep validated (`signboard`, `capture_trust`), shipped in #5771.
The rule, the scoring and the pinned fixtures were all correct. The **reader's key was not**, so the
widened pillar counted nothing on production from the hour it shipped.

## The defect

`readIntegrityPlaceCases` (`src/lib/rep-ranks/server/compute.ts`) built its rep key as
`String(row.rep_hr_id ?? "").toUpperCase()`, and its own comment claimed that matched the roster.
It does not. Every other per-rep index in that file goes through `keyOf` —
`normalizeHrIdForAccess`, which lower-cases and strips every dash and symbol:

| index | key it produces |
| --- | --- |
| roster, field saves, starts | `ai0020`, `b170`, `b100` |
| place cases (before the fix) | `AI-0020`, `B-170`, `B-100` |

Nothing threw. A `RankPlaceCase` was emitted for every row, with a key no rep on the roster could
ever carry, and `field-quality.ts` added it to nobody.

**Why the pin could not catch it.** `tests/rep-ranks.test.ts` hands `factsForWindow` a fixture
whose `repKey` is already canonical (`"r1"`), which is the right way to test the pure rule — so the
one thing still wrong was the reader's own key, which only the source can pin.

## Measured on production, before the fix

The nightly had last written `rep_rank_standings` at **04:17 Cairo**, before #5771 was live, so no
rep had yet seen a moved score. Running the nightly's own read and scoring as a dry run (read-only,
nothing written) over the five live windows: **9 strong place cases in the span, 0 score changes** —
all 9 keys matched no roster rep.

## Who moves, with the key fixed

Same dry run, same production data, anchor **2026-10-11**: **42 movements** — 15 in the month
window, 13 in the quarter, 13 in the semester, 1 in the week, **none in the day**. Eight reps carry a
case of their own; the rest only change places as those eight fall past them.

The **month** window (2026-10-01 → 10-11), the one the portal and the admin board open on:

| Rep | Line | Integrity | Total | Company position | The case behind it |
| --- | --- | --- | --- | --- | --- |
| Sara Mohy Eldeen | CNS | 100 → 95 | 89.47 → 89.05 | 3 → 3 | 03 Oct `sign_other_name` |
| Mohamed Ahmed | Pedia | 100 → 94 | 88.17 → 87.67 | 7 → 8 | 03 Oct `sign_other_name` |
| Nada Saied | CNS | 94 → 83 | 88.18 → 87.27 | **6 → 11** | 03 Oct `sign_other_name`, 06 Oct `coordinate_replay` |
| Esraa fotooh | Anti Infective | 100 → 92 | 85.83 → 85.17 | 14 → 15 | 03 Oct `sign_other_name` |
| Khaled Saied | Pedia | 100 → 93 | 84.87 → 84.28 | 16 → 18 | 03 Oct `sign_other_name` |
| Ahmed Farag | Anti Infective | 100 → 91 | 77.17 → 76.42 | 24 → 24 | 03 Oct `sign_other_name` |
| Ebtissam Alaa | Pedia | 100 → 90 | 73.97 → 73.13 | 26 → 26 | 03 Oct `sign_other_name` |
| Mahmoud Abdelreheem | Anti Infective | **100 → 0** | unranked | — | 10 Oct `coordinate_replay` |

Seven reps with no case of their own rise a place or two as those eight fall: Samir Saad 8 → 6,
Hadeer Abdelnaser 9 → 7, Ali Hassan 10 → 9, Mostafa Galal 11 → 10, Yasmeen Samy 15 → 14,
Aya Ibrahim 17 → 16, Mostafa Mahmoud 18 → 17.

The **quarter** and **semester** windows hold the same eight reps and the same integrity figures —
Phoenix CRM's data begins in October, so the longer windows carry the same saves. On the
**semester** ladder Nada Saied goes 5th → 9th and Mostafa Galal 9th → 8th. The **week** window moves
only Mahmoud Abdelreheem, and the **day** window does not move at all.

**One rep clamps to 0.** A case costs five saves' worth, so Mahmoud Abdelreheem's single
`coordinate_replay` against 4 saves in the window takes the pillar to 0. That is the pillar's
existing design, not this change; he is unranked in every window either way.

## The lesson, already paid for once this week

A measurement taken beside the pipeline is not a measurement of the pipeline. The earlier
who-moves figures (10 cases, 7 reps on the month ladder) were derived correctly from the data and
told nobody that the shipped reader keyed its rows differently. **Run the production reader, not a
replica of it**, and check its output joins to something before reporting what it will do.
