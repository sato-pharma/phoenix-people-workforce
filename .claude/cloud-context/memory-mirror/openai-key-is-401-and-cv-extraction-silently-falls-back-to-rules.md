---
name: openai-key-is-401-and-cv-extraction-silently-falls-back-to-rules
description: "The `/v1/models` probe this file relied on for months is a FALSE GREEN - it answers on authentication alone and cannot see a balance. On 2026-08-27 the key returned 200 there while every completion 429'd on an exhausted balance. Credits were restored the same day and completions are live again, but ALWAYS probe with a 1-token completion, never with /v1/models. Nothing in the app records an AI failure."
metadata: 
  node_type: memory
  type: project
  originSessionId: 5f6e15e1-d34d-44e7-957b-76b67e0453b9
  modified: 2026-10-01T00:00:00.000Z
---

**SUPERSEDED ON THE SAME DAY — A WORKING KEY IS BACK. Read this paragraph before acting on
anything below it.** 2026-08-21, ~10:30 Cairo: the owner restored a key, it was accidentally leaked
into a session transcript by a PowerShell alias collision (a helper named `H` resolved to
`Get-History`, which echoed the argument in its binding error — **never name a helper `H`, and never
pass a secret as a positional argument**), he revoked it and issued a third. The key now stored in
`HKCU:\Environment\OPENAI_API_KEY` is **VALID — `GET /v1/models` returns HTTP 200**, verified
2026-08-21. Its fingerprint is `sha256:469EBD3D56…` (first 10 hex of the UTF-8 digest) — compare
against that to tell whether the stored key has changed, and **never print the value**. The same
key was also set as the Railway `production` variable and **that side is PROVEN too**: read it back
with `railway variables --environment production --service phoenix-people-workforce --kv`, hashed
it, got the same `469EBD3D56`, and the same value returns HTTP 200 — then deployment
`bb5e4d71` started 10:42 Cairo (after the variable was set) and reached SUCCESS at 10:45, so the
running container carries it. **You do NOT need a live CV to verify a key** — that is handing the
owner manual work, and he called it out. Fingerprint-compare Railway against OpenAI directly.
`/api/recruitment/candidates/[id]/cv-extract` cannot be called from a session: it needs a real login
plus a same-origin check, and `PHOENIX_ENABLE_DEV_AUTH_HEADERS` is correctly absent from production.

Everything below describes the days when there was NO key. It is still the right guide to how the
system degrades, but "the key is dead" is no longer the current state.

**OWNER DECISION, not an incident — do not "restore" the key or treat this as an outage.** He deleted
the OpenAI API key on **2026-08-21** because it was consuming too much credit, and said so in plain
words. Discovered 08:40 Cairo while running the CV re-read for the 56 empty "Applying for" cells. The call logs `OpenAI request failed: 401 Incorrect API key provided` — twice per CV, once
per retry — and then **succeeds anyway**, because `extractCandidateFieldsFromCv` falls back to the
deterministic engine. The script prints `-> READ 11 fields (10 high)`. Nothing says the model was
never reached.

Proof it is PRODUCTION and not just `.env.local`, straight from `ats_candidate_cv_extractions`:

| Cairo day | `ai_model` | rows | avg fields |
| --- | --- | --- | --- |
| 14–18 Aug | `gpt-5.4` | 325 | **38** |
| 20 Aug | `phoenix-rules` | 2 | 15 |
| 21 Aug | `phoenix-rules` | 1 | 11 |

The two on **20 Aug carry `created_by = null`** — written by the running app, not by any hand-run
script. So the live intake path has been degraded since **18 Aug 21:54 Cairo**, quietly, for days.
**38 fields → 11–15 fields** is the size of the loss. `railway variables` is blocked from this session (reading secrets is outside the
§8 grant), so the DB evidence above is how to establish the key's state without ever touching it.

**THE TRAP, and it is the expensive one: a failed model read still writes a row, and that row is
indistinguishable from a real one to the re-read script's truth set.** The set is "candidates with
no extraction row at all", so a rules-only row **permanently removes** that candidate from every
future run. Read all 56 with a dead key and all 56 look done forever, at 11 fields each instead of
38, with no error anywhere. One row was written this way and **deleted again immediately**
(`28f4d052-…`, candidate `152d170d-…`), which restored the set to exactly 56 — verified by re-running
`--dry-run`.

**THE REAL BUG THIS EXPOSED, fixed in PR #2254.** `extractCandidateFieldsFromCv` threw
`ai_not_configured` **before it had even looked up the candidate** — so with no key, the free
deterministic engine inside `extractCvFieldsFromBytes` was never reached, even though that engine
checks the key only *after* its free rules pass and free OCR have had their turn (the owner's own
2026-08-19 cost design). Measured on the same 5 production CVs: **with the guard 0 read, all failing
in 0s having downloaded nothing; without it 3 read.** Across all 56: **30 read, 12 gained a job
title, 29 of 30 gained a phone**, column **467 → 481 of 555**, at zero API cost. A test pins that the
entry point never mentions `hasOpenAiApiKey` and that `runRuleCvExtraction` runs before the engine's
own key check.

**A free rules row is NOT a substitute for a model read — 11–15 fields against 38** — and the
re-read script now excludes `phoenix-rules`/`phoenix-ocr` rows from its "already read" set for
exactly that reason.

**BUT THAT EXCLUSION HAS A TYPO AND IT LEAKS — confirmed 2026-08-21 10:20 Cairo.** The set in
`scripts/recruitment-reread-never-read-cvs.ts:152` is `["phoenix-rules", "phoenix-ocr"]`, but the
code writes **`"phoenix-rules+ocr"`** (`OCR_EXTRACTION_MODEL`, `src/lib/recruitment/cv-extraction.ts`).
`"phoenix-ocr"` appears **nowhere in `src/`**. So an OCR row is treated as a real model read and the
candidate is removed from the re-read set **permanently**. 4 candidates are already frozen this way.
Fix the string, do not add a second entry. **FIXED — verified live 2026-08-27.**
`scripts/recruitment-reread-never-read-cvs.ts:219` now builds the set from the CONSTANTS
(`new Set([RULE_ONLY_EXTRACTION_MODEL, OCR_EXTRACTION_MODEL])`), so it can no longer drift from what
the writer writes; `tests/recruitment-reread-model-constants.test.ts` pins it and is registered. The
only surviving `"phoenix-ocr"` string in the repo is a comment explaining this history. Production
holds **5 `phoenix-rules+ocr` rows across 5 candidates** and they are back in the held-back bucket,
so the freeze is undone. Do NOT act on the paragraph above as an outstanding task. **The rules engine is also noisier at job titles**: three cells now read an
employer or a boast rather than a role (`Anvil Security Services Cairo`, `HR & Personnel Specialist:
Elite Contracting`, `Professional Certified Trainer, MBA holder`).

**A CV that "cannot be read" may be a FORMAT bug, not a key or a spend problem — check the magic
bytes before concluding anything.** On 2026-08-27 both remaining `--unresolved-only` candidates
failed with *"Could not find the body element: are you sure this is a docx file?"*, which reads like
a corrupt file and is actually a router bug: `detectCvFileKind` answered `"docx"` for
`application/msword` and mammoth reads only the OOXML ZIP, so a Word 97-2003 binary threw on every
run forever. **The MIME label is wrong in BOTH directions in this corpus** — 4 stored CVs labelled
`application/msword` are genuine OLE2 `.doc` (`d0cf11e0a1b11ae1`), and a 5th labelled the same way
is a genuine `.docx` (`504b0304`) that reads fine. So routing on the MIME type would have broken a
file that works. Fixed in #2450 by sniffing the bytes (`isLegacyDocBytes`); `word-extractor` reads
the legacy format. A failure like this costs NOTHING — it dies before any model call — so a run
reporting `Failed` with `Read: 0` has spent nothing and frozen nobody.

**What no key cannot do at all: a photograph.** 23 of the 56 are WhatsApp image imports with no text
layer; free OCR did not rescue them. Those need the vision model or nothing.

**Before any bulk CV extraction, check `ai_model` on the first row written** and decide deliberately
whether a free shallow read is what you want for that batch. `phoenix-rules` means the model was
never reached — which is now the NORMAL state, not a fault to escalate.

`scripts/recruitment-reread-never-read-cvs.ts` now takes **`--unresolved-only`**, which narrows the
263 never-read CVs to the 56 whose column is actually empty and who actually have a file — the other
207 are already answered from their subject line, so reading them is spend that changes nothing on
screen. It runs the shipped resolver, so its set is exactly what the page shows as "Not stated".

Also: that script needs **`./tests/alias-loader.mjs`, not `./scripts/alias-loader.mjs`** — a
transitive import now reaches `next/cache`, which only the tests loader stubs. Same trap as
[[running-vacation-service-standalone-needs-an-extended-loader]].

Related: [[applying-for-is-derived-and-the-residue-is-genuinely-silent]] ·
[[recruitment-intake-works-pipeline-never-used]] · [[railway-token-expired-breaks-all-secret-sync]]

**Re-verified live 2026-08-24 — the two keys have SWAPPED roles since this note was written.**
Probed by fingerprint against `GET /v1/models`, never printed:

| Source | Fingerprint | Result |
| --- | --- | --- |
| Windows shell env `OPENAI_API_KEY` | `469ebd3d` | **200 OK**, 124 models, `gpt-5.4` present |
| `.env.local` `OPENAI_API_KEY` | `b835891b` | **401 Unauthorized** |

Both are 164 chars, so length tells you nothing. **The shadowing described in
[[windows-env-var-shadows-every-env-local-key]] is the only reason local AI extraction works at
all** — the file's key is dead, and the Windows variable overrides it. Anything that loads
`.env.local` WITHOUT that shell variable present (a fresh terminal, a cloud session, a service) gets
the 401 key and silently degrades to the free rules engine. It will not error; it will just quietly
stop reading job titles.

Every other variable that matters comes ONLY from `.env.local` — `NEXT_PUBLIC_SUPABASE_URL`
(production `ozucdzovmcqvepbozvqf`), the service-role key and the anon key are all absent from the
shell env. So the correct precedence for a local script is **shell wins for `OPENAI_API_KEY`, file
wins for everything else**: parse `.env.local` and only set what `process.env` does not already
have. Do not use `--env-file` blindly for this — verify which side wins before you trust the run.

---

**RESOLVED 2026-08-26 — the two keys no longer disagree.** Windows was reinstalled in place that
morning (InstallDate 06:19 Cairo); the audit that followed re-probed both sides and found the split
still exactly as the 08-24 table describes: shell env `469ebd3d56ab` -> **200**, `.env.local`
`b835891bed46` -> **401**. `railway variables --environment production` was fingerprinted too and
returns **`469ebd3d56ab`** — so production was never degraded, only the laptop's file was.

The file was then rewritten to carry the valid key (backup at
`.env.local.bak-before-openai-sync-20260826`) and re-verified: `.env.local` fingerprint
`469ebd3d56ab`, live `GET /v1/models` -> **HTTP 200**, still 34 keys, still gitignored. **The
precedence workaround described above is no longer needed for `OPENAI_API_KEY`** — both sides now
hold the same value, so a fresh terminal, a cloud session or a service that reads only the file gets
a working key instead of silently degrading to `phoenix-rules`.

Two things this does NOT change. The Windows variable is persisted at **User** scope, not Machine —
`reg query HKCU\Environment` printed nothing useful, but
`[Environment]::GetEnvironmentVariable('OPENAI_API_KEY','User')` returns it; trust the .NET call, not
the `reg` grep. And the shadowing rule in [[windows-env-var-shadows-every-env-local-key]] still
applies to every other key — it is only harmless here because the two values are now identical. If
the owner rotates the key again, **rotate all three places** (Windows User env, `.env.local`, Railway
production) or the split comes straight back.


---

**RESOLVED THE SAME DAY — the owner added credits at 11:5x Cairo and completions work again.**
Re-probed immediately after: `POST /v1/chat/completions` -> **HTTP 200**, `gpt-4o-mini` answered, 15
tokens billed. So the *outage* below is over. **The lesson under it is not** — the probe this file
used for months still cannot see a balance, and nothing in the app still records an AI failure.
Keep reading.

**2026-08-27 — THE `/v1/models` PROBE THIS WHOLE FILE RELIES ON NOW GIVES A FALSE GREEN.** Every
verification above uses `GET /v1/models` -> 200 as proof the key works. Measured 11:40 Cairo on the
one key all three places now share (`469ebd3d56ab`):

| Probe | Result |
| --- | --- |
| `GET /v1/models` | **HTTP 200** |
| `POST /v1/chat/completions` | **HTTP 429** `insufficient_quota` / `credit_balance_exhausted` |

The key is valid and un-revoked; **the account has no credits.** A read endpoint answers on
authentication alone, so it cannot see a balance — 200 there proves only that the key exists.
**Probe with a 1-token completion, never with `/v1/models`.**

Nothing in the app distinguishes the two. `normalizeOpenAiError`
(`src/lib/ai/openai-client.ts:118,134`) maps `insufficient_quota` to `quota_exceeded`, and
`cv-extraction.ts:492` turns that into **"The OpenAI rate limit was reached for now. Wait a minute
and try again."** — advice that is wrong forever: no wait refills a zero balance. Everything on the
key is affected, not just CVs: email AI Assist, and the sales monthly + weekly normalizer
`ai-suggest` / `auto-map` routes.

**And nothing records it.** `recordAiCall` writes to GCP Cloud Monitoring, `GCP_PROJECT_ID` is not
set on Railway production, so `writeAiCallMetrics` returns at its first line. Every AI failure in
production is counted nowhere. The only signal is the `ai_model` column going back to
`phoenix-rules` — check it, per the rule above, before trusting any batch.

Only the owner can fix an exhausted balance: credits at
`platform.openai.com/settings/organization/billing`. **Never rotate the key for this** — a 429 is not
an auth problem, and rotating re-opens the three-place split described above for nothing. He added
credits on 2026-08-27 within minutes of being told, so the fix is fast once it is actually named.
