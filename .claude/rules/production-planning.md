---
paths:
  - "src/lib/production-planning/**"
  - "src/components/production-planning/**"
  - "app/**/production-planning/**"
  - "app/api/cron/production-planning-*/**"
  - "tests/production-planning-*"
  - "supabase/migrations/*production_planning*"
---

# Module memory — Production Planner (toll manufacturing — Ivyronc)

**Scope:** Run geometry and the buy list for a toll-manufactured product, stock in two locations, the cost layer and its dollar rate, the consumption learner, and the reorder alarm.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

### The owner's decisions (asked and answered 2026-10-05, in his own words where it matters)

- 🔒 **THE RUN VOLUME IS FIXED AND SAMPLES COME OUT OF IT** — one run is 1,250 L whatever is asked for, so a free 40 ml sample REDUCES the 100 ml bottle count rather than adding to it: `good_units = (runs × run_volume_ml − samples × sample_ml) / good_unit_ml`. But a sample still consumes a FULL packaging set, so samples RAISE packaging per run: one run with 10,000 samples is 8,500 bottles and 18,500 sets, against 12,500 and 12,500 with none. Never model a sample as an addition to the order.
- 🔒 **HIS HEADLINE NUMBER IS THE TOTAL, NOT THE SALEABLE COUNT** — "انا 100 الف اقول لك 100 الف وعايز 10000 فده معناه انك هتديني 90 و100": 100,000 with 10,000 samples means 90,000 saleable plus 10,000 samples, not 110,000 boxes. `total_boxes` is the default request mode for exactly that reason.
- 🔒 **RUNS ARE WHOLE, ROUNDED UP, AND THE SURPLUS IS REPORTED** — never silently answer for the number he asked for. 100,000 boxes with 10,000 samples is 7.52 runs → **8 runs, 96,000 good units, 106,000 boxes, 6,000 surplus**, and the planner also shows the one-run-fewer figure so undershooting is his choice. A planner asked for 150,000 that answers for 150,000 is the likeliest way to get this screen wrong while every number in it is right.
- 🔴 **THE CORRECTED BUY LIST IS ivy 72.1 kg / sorbitol 4,120 kg / packaging 109,180 for that order** — the earlier **74.984 / 4,284.8 / 113,300** was computed on a superseded reading (samples ON TOP, a fractional 8.32 runs) before he fixed the volume, and must never be quoted or compared again. The 9-run, zero-sample figures are unaffected: ivy 81.1125 needed and 38.1125 to send against 43 held.
- **"Boxes" means bottles, 1:1** — his `12500 ازازة في 100 ملي` and his `150 الف علبه` are the same count. `units_per_box` exists and defaults to 1 so the engine stays right if that ever stops being true.
- 🔒 **ACCESS IS A NAMED LIST OF PEOPLE, NOT A ROLE** — full control Dr. Sahar Khalil (`AB`), the CEO (`AA`) and the owner (`B-10`); READ ONLY the Finance and Admin Manager (`B-185`) and Reham Elwiy (`OF-0004`), whose upgrade is a Settings row and not a deployment. Granting `Manager` or `Employee` the resource would open the module to the QPPV and the whole company, so the gate is `resolveProductionPlanningLevel` plus `guard: "domain-helper"`. Compare ids with `hrIdsMatch`, never `===`.
- 🔒 **THE UI IS EGYPTIAN ARABIC, RIGHT-TO-LEFT, WITH LATIN DIGITS AND NO GENDER** — "طبعا اللغه دي عربي عربي عربيك ايجيبشن عربيك", and Latin digits by his own choice, so `Intl` is asked for `en-EG` and never `ar-EG` (which emits ٠١٢٣ and `ج.م.`). Both daily users are women: verbal nouns for actions (`حساب الاحتياج`, not `اِحسب`), no second person, no `ـك`. One catalogue, `strings.ts`, imported by the screen AND the workbook so they cannot drift.
- 🔒 **EVERYTHING IS EDITABLE FROM THE SCREEN AND STORED IN THE DATABASE** — no hard-coded geometry, composition, overage, threshold, price or rate; an edit must reach the database, the engine and the cron. A constant added "just for now" is the defect this rule exists to prevent.
- 🔒 **THE EXCEL EXPORT CARRIES THE FORMULAS, NOT THE ANSWERS** — "فيها برضو الفورمولاز". Yellow cells are his inputs and every other cell is a live formula over them, so he can change a figure in Excel and watch the buy list move. A printout of computed values is not this export.

### The arithmetic and the money

- 🔴 **QUANTITIES ARE BigInt MICRO UNITS AND EVERY READ CASTS `::text`** — `select("qty::text")` is mandatory, not hygiene: PostgREST serialises `numeric` as a JSON number, so the value is a double before our code sees it, and potassium sorbate for 9 runs then prints `15.527250000000002` where the screen and the Excel formula must agree to the digit. Everything on the wire is a decimal STRING. Money is 1/10,000ths, percentages 1/10,000ths, quantities 1e6.
- 🔴 **`balanceAfter` LEAVES THE SATO STORE OUT, AND DOES NOT REDUCE A MATERIAL SATO DOES NOT SUPPLY** — it is `heldAtFactory + willSend − (satoSupplies ? needed : 0)`, because the balance answers "what is left AT EGPI after the run". Adding the own store back, or subtracting a factory-supplied material, both read as plausible and are both wrong; `tests/production-planning-workbook.test.ts` is the only thing that can tell the two stock columns apart.
- **The three shared-unsettled materials contribute NOTHING to the buy list** — xanthan gum, potassium sorbate and lemon flavour read a dash in the purchase column, never a zero, because "not agreed with the factory yet" is a different statement from "nothing to buy". A committed plan line may not carry `shared_unsettled` at all: the database CHECK enforces that he decided before he ordered.
- **A price is append-only, typed in ONE currency, and the other figure is DERIVED** — there is no stored second-currency column, because two stored currencies are two truths for one number. The effective rate is `manual ?? fetched`, derived at read, and a failed daily fetch records `fetch_ok = false` without ever overwriting a good rate.
- **Cost is computed on what he BUYS, not on what the run needs** — `toBuy` after the minimum order and the purchase increment, so the total is the money that leaves, not a theoretical consumption value.

### The reorder email

- 🔴 **IT SENDS NOTHING UNTIL HE ARMS IT, THROUGH FOUR INDEPENDENT FAIL-SAFE SWITCHES** — `alarm_enabled` must be explicitly true, `alarm_dry_run` explicitly false, the `production_planning_reorder` template is shipped INACTIVE, and `EMAIL_NOTIFICATIONS_ENABLED` gates every send in the app. A disabled sweep answers `skipped: "disabled"` and writes nothing; a dry run writes the rows a real pass would with `email_sent = false`, and the table's CHECK refuses a dry-run row marked as sent. Pinned by `tests/production-planning-silent-until-armed.test.ts`.
- 🔴 **THE RECIPIENTS ARE FOUR ADDRESSES HE NAMED, NEVER A ROLE** — To Dr. Sahar Khalil, Cc the CEO and the Finance and Admin Manager, Bcc the owner. Routing by role would reach every `Manager`, which is also the QPPV's role. The threshold is about one run of cover because the imported material needs roughly six months of lead time, and the email exists at all because "ما انا كده هنسى".
<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (0)

_No notes filed under this module yet._
<!-- module-memory:notes:end -->
