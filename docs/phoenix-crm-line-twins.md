# Validated on one line is validated on all three

**Owner, 12 November 2026 (Cairo, about 22:00–22:40):** if a doctor is on the CNS, Anti Infective and Pedia
lists of the same area — different reps, same area — and he is validated on one of them, he is validated on
all three. Only customers **validated in Phoenix CRM** are compared (never the old CRM's contacts), and where
two validated rows of the same doctor disagree on where he is, they are **merged** onto one point. Asked which
of the two halves he wanted ("Waiting ones join it" / "Merge validated twins only" / "Both"), he answered
**"Both"**.

Rules: `src/lib/phoenix-crm/line-twins.ts` (pure). Doors: `src/lib/phoenix-crm/server/line-twins.ts`.
Database: `supabase/migrations/20261112221819_phoenix_crm_line_twin_validation.sql`. Pinned by
`tests/phoenix-crm-line-twins.test.ts`. One-off country pass: `scripts/phoenix-crm-line-twins.ts`.

## Who is a twin of whom — `areLineTwins`

Two customer rows are the same doctor on two lines when ALL of these hold:

- same world (real with real, test with test), **different seats on different lines**;
- the two seats share an **area code** (every area has one seat per line — CNS, Anti Infective, Pedia);
- the same list (AM with AM, PM with PM — pharmacies are never compared);
- each name has **at least three words** (two words — "Ahmed Mohamed" — is a hundred doctors), and
  `sameName` (the Customer matches board's own comparison: Arabic letter forms, spacing, the doctor prefix)
  says they are one name;
- no speciality clash (`specialityFamily`), when both rows name one.

## The two halves

### 1. Merge — two validated rows, two points within 150 m

When both rows are validated and their places sit apart (more than 1 m, at most `AGREE_METERS` = 150 m), the
weaker one is moved onto the stronger one's stored point and location, through the audited
`phoenix_crm_move_place` with the reason `LINE_TWIN_MOVE_REASON`. Strength (`compareAnchors`): a place the
Super Admin moved > a shared place > a trusted point > a photo's own reading > a pin; then the one more of the
twins agree on, then the better accuracy, then the earlier capture. Only photo and pin places are ever moved —
a moved, shared or trusted place is someone's decision and is never overwritten. Two points farther apart
than 150 m are left alone: they may be two clinics.

### 2. Share — one waiting row, a validated twin

A row still **To validate** (`status = pending`) whose twin is validated is validated with the twin's places
(up to five, never two within 150 m), by `phoenix_crm_share_line_validation`. Each copy is a place row with
`point_source = 'line_twin'`, **no photo**, and `trusted_basis = {source: "line_twin", source_place_id, …}`.
The validation is recorded in the name of the source's validator. It is never shared when:

| Skip reason | Why |
| --- | --- |
| `in_review` | his own capture is waiting for the Super Admin — that decision comes first |
| `drop_requested` | a drop is asked for him |
| `full_name_held` / `needs_full_name` | his full name is held or still needed |
| `two_on_one_line` | two different validated doctors of this name on one line — whose place is it? |
| `two_doctors` | the validated twins disagree by more than 150 m — two clinics, or two doctors |
| `twice_on_this_list` | he is on his own list twice — the same-seat duplicate merge comes first |

The RPC re-checks under the row's lock and answers `{skipped: …}` if the row stopped waiting in the meantime.

## The copy follows its source — `phoenix_crm_places_line_twin_follow`

A trigger on `phoenix_crm_places`: when a source place is **moved**, its active copies take the new point;
when it is **retired** (removed, refused, rejected), its copies are retired and any customer left with no
active place goes back to To validate. The app then re-measures those customers' visits
(`followLineTwinCopiesQuietly`), and a doctor sent back is offered again to any twin still validated.

## Where it runs

After every validation, through `afterResponse` so no rep waits for it (`shareAcrossLinesQuietly`): a rep's
own validation (`list.ts`), an approved review, a restored validation and a confirmed place
(`validation-reviews.ts`), a held signboard the system approves (`signboard-holds.ts`), a trusted point
(`trusted-point.ts`) and an approved polyclinic's seated doctors (`shared-places.ts`). A move or a removal
(`place-move.ts`) and a rejection or refusal (`validation-reviews.ts`) carry the copies with them.

## What it partly supersedes

- "A validated location is fixed; only the Super Admin moves it" — the system now also moves a validated
  place, and only onto a twin's stronger point within 150 m, through the same audited move.
- The master list "never moves a rep's place" — the same exception.
- "A venue is visible only to the seat that captured it" — unchanged: a copy is a place row on the twin's own
  seat, never a shared venue.

## The boards skip the copies

A copy has no evidence of its own: Place checks (`loadValidatedPlaces`), the Place matches and Customer
matches boards and Places to recheck all read `.neq("point_source", "line_twin")`. Its source is on them.
The night signboard sweep never sees one (it reads only places with a photo), and the silent integrity
filers skip them too — the coverage pass and the visit-against-photograph pass (`silent-detectors.ts`) and the
replayed-point read (`location-integrity.ts`): a copy repeats its source's exact point under the system's name,
so it would file a second flag on the same evidence, or read as a replay.

## The country pass

Dry by default (`--apply` to write, `--test` for the test world). The dry run on 12 November 2026 planned
179 merges (179 doctors), 277 rows validated across the lines, and 11 left waiting (10 on their own list
twice, 1 with two validated doctors of the name on one line). A bulk production change: announce the counts
before `--apply` (AGENTS.md §8).
