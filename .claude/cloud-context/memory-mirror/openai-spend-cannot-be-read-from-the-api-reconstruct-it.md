---
name: openai-spend-cannot-be-read-from-the-api-reconstruct-it
description: "You cannot read this account's OpenAI bill from the API - /v1/organization/costs is 403 (Admin key required, ours is sk-proj-) and legacy /v1/usage returns HTTP 200 with an EMPTY result, which reads as 'no usage' and is not. Reconstruct spend from ats_candidate_cv_extractions instead: CV extraction was the only premium-tier caller in the codebase, and #2451 moved its text route to nano and gave a Word CV a model-tier retry."
metadata: 
  node_type: memory
  type: project
  modified: 2026-08-27T09:17:41.605Z
  originSessionId: e7f88217-2a8b-4598-b043-5afd26b36bd5
---

**Asked "what is draining my OpenAI credits" on 2026-08-27, and the honest answer is that no API
this account can reach will tell you.** Both probes, run live with the production key:

| Endpoint | Result | Why |
| --- | --- | --- |
| `GET /v1/organization/costs` | **HTTP 403** | needs an **Admin** key (`sk-admin-`); ours is `sk-proj-` |
| `GET /v1/usage?date=YYYY-MM-DD` | **HTTP 200**, `{"data": [], …}` | answers, but empty for every day 12-27 Aug |

**The second one is the trap.** A 200 with an empty `data` array is indistinguishable from "this
account spent nothing that day", and it is the endpoint a session naturally reaches for. It returned
empty for 16 consecutive days that provably had billed traffic. Do not read it as evidence.

Only the owner can see the real figures, in the dashboard. Everything below was reconstructed from
the app's own tables — which is the method to reuse, not a one-off.

## The metrics that were built for exactly this question record nothing

`recordAiCall` (`src/lib/observability/ai-metrics.ts`) captures `input_tokens` / `output_tokens` on
every call and writes them to GCP Cloud Monitoring. `GCP_PROJECT_ID` is **not set on Railway
production** (verified via `railway variables`), so `writeAiCallMetrics` returns on its first line
and every token count since launch is discarded. Also pointless if it were set: the GCP project's
billing closed 2026-08-01. Same fact from the failure side in
[[openai-key-is-401-and-cv-extraction-silently-falls-back-to-rules]].

## How to reconstruct it instead

`ats_candidate_cv_extractions` on production (`ozucdzovmcqvepbozvqf`) is the usable proxy, because
CV extraction was **the only premium-tier consumer in the whole codebase**. Group by day, `ai_model`
and `created_by`: `phoenix-rules` / `phoenix-rules+ocr` rows cost nothing, everything else was billed,
and `created_by` separates a bulk re-read script from ordinary intake.

Measured 24 Jul - 26 Aug: **514 billed rows, 252 free.** Steady state is **2-4 calls a day**. Four
days carry 383 of the 514 (**75%**) — 14 Aug (129, email import flood), 21 Aug (91, `ops:cv-reread-20260816`),
18 Aug (85, WhatsApp flood of 304 candidates), 24 Aug (78, `ops:cv-reread-legacy-schema-20260824`).
**It is never the app's daily traffic; it is bulk re-reads and import floods.**

**514 is a FLOOR, not a count.** The SDK runs `maxRetries: 1`, so a timed-out call bills twice, and
`cv-extraction.ts` fires a second full vision pass when a text read comes back thin. Failed calls
bill and write no row at all.

## The tier map, and what changed

Prices read live from OpenAI 2026-08-27: **gpt-5.4 $2.50 / $15.00** per million input / output,
**gpt-5.4-nano $0.20 / $1.25**, **gpt-4o-mini $0.15 / $0.60**. Premium output is **12x** nano.

Of 11 `createOpenAiResponseText` call sites, only CV extraction and the payroll copilot passed a
model at all; the other nine inherit the nano default, and all sales AI is `gpt-4o-mini`. **No
`OPENAI_MODEL` / `AI_MODEL` override exists in Railway or `.env.local`** — check that first if the
cheap paths ever look expensive, because that one variable silently upgrades every default.

**#2451 (2026-08-27) split CV extraction by route**, the way `cvReasoningEffortForRoute` already
split the effort: `cvModelForRoute("text")` -> nano, both vision routes stay gpt-5.4. Measured
shares from `ats_files` (636 rows): **563 PDF (88.5%) + 40 Word (6.3%)** take the text route,
**33 images (5.2%)** take vision. The PDF majority still escalates to a gpt-5.4 vision pass when the
cheap read comes back thin, so the ladder is cheap-then-premium rather than premium-always.

Two consequences worth knowing. `ai_model` now reads **`gpt-5.4-nano+rules`** for text reads —
nothing branches on that string (the re-read hold-back set is derived from the `phoenix-*` constants
by identifier, pinned by `tests/recruitment-reread-model-constants.test.ts`), and it makes the tier
split countable from the table afterwards. And a text read now has TWO rungs to escalate
by, not one: a different ROUTE where one exists (a PDF re-read as rendered pages), and otherwise a
stronger MODEL on the same text — `cvTextRetryModel`, added in the same PR. That second rung exists
because the 40 Word CVs have no image form and so no route to escalate to, and `is_cv` follows the
MODEL, not the rules: once the accepted read was the cheap one, a wrong "this is not a CV" would have
buried a real applicant with nothing left to overturn it. It is self-disabling — put the text route
back on gpt-5.4 and `cvTextRetryModel` returns null instead of paying twice for the same answer.

## A rules-only row means the GATE DECLINED, not a bad read

**Measured on production 2026-08-27, pricing a re-read of every remaining rules-only CV.** The
answer was not a price, it was that the run is a **no-op**: of **59** candidates whose only
extraction row is free/rules, the shipped gate would send exactly **1** to the model.

| `shouldEscalateToAi` verdict | candidates |
| --- | --- |
| "rules answered every field worth asking about" | **35** |
| "only 1 field(s) missing - not worth a model call" | **20** |
| "only 2 field(s) missing - not worth a model call" | 3 |
| "rule read is too thin to accept" -> **escalates** | **1** |

So `scripts/recruitment-reread-never-read-cvs.ts --include-rules-only` costs about **$0.004** and
moves one candidate. That also explains the attempt histogram - 30 candidates already carry 2 rows,
12 carry 3, 14 carry 4, one carries 7. Every run re-writes the same free row forever, because a
rules row deliberately does not count as "read" (that hold-back is correct and protects a real
failure mode - see the script's own comment).

## The script's premise is wrong for this pool

Its comment calls these "the CVs that were read WORST (~11-15 fields against 38)". Measured, the
rules rows carry **18 keys** on average against 24 for `gpt-5.4+rules`. They are not the worst-read
CVs; they are the ones the rules read **well enough that the module refused to spend on them.**

## `phoenix-rules` has TWO causes and the table cannot tell them apart

Both write the same label and `is_cv = NULL` (`cv-extraction.ts`, the `is_cv:
isRuleOnlyExtractionModel(...) ? null : ...` write):

1. **the gate declined** - `if (!decision.escalate) return ruleOnly()`. **No model call. Free.**
2. **the AI threw** - the outer `catch` around `runAiExtraction()` returns `ruleOnly()`. Billed.

**Tell them apart by ROW TIMING, not by the row.** A declined row lands in ~2s (download + parse);
a real model call is 14-50s. In the 2026-08-27 run: 58 rules rows averaged **2.2s** (never called
the model), 15 model rows averaged 26.3s, and only 3 rules rows were slow enough to be a failure.
A burst of 22 rules rows in one minute is the gate working, **not** credits exhausted - which is
what it looks like, and the wrong conclusion to jump to.

## Measured price per CV extraction (real API `usage`, universal schema, 38 fields)

| CV text | input tok | output tok | (reasoning) | nano | gpt-5.4 |
| --- | --- | --- | --- | --- | --- |
| 2,000 ch | 1,790 | 1,826 | 310 | $0.0026 | $0.0319 |
| 4,500 ch | 2,379 | 3,188 | 513 | $0.0045 | $0.0538 |
| 9,000 ch | 3,444 | 3,598 | 275 | $0.0052 | $0.0626 |
| 20,000 ch | 6,047 | 2,968 | 479 | $0.0049 | $0.0596 |

**Mean $0.0043 nano / $0.052 gpt-5.4 - a 12.1x ratio measured end to end**, which independently
confirms the tier gap in [[openai-spend-cannot-be-read-from-the-api-reconstruct-it]]. Instructions
alone are 6,019 chars, so input never drops far below ~1,800 tokens however short the CV.

Useful totals at the post-#2451 nano tier: **59 forced through = $0.25** (was $3.07), **the whole
431-candidate corpus = $1.85** (was $22.40). Re-reading everything is now cheaper than one of the
old bulk bursts.

Related: [[openai-key-is-401-and-cv-extraction-silently-falls-back-to-rules]] ·
[[an-empty-cv-extraction-is-the-designed-answer-to-a-non-cv]]

Related: [[openai-credits-exhausted-429-reads-as-rate-limit-2026-08-16]] ·
[[windows-env-var-shadows-every-env-local-key]] ·
[[a-cron-that-fails-nightly-can-do-so-forever-unwatched]]
