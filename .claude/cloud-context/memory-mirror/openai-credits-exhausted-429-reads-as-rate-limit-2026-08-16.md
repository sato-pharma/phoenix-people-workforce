---
name: openai-credits-exhausted-429-reads-as-rate-limit-2026-08-16
description: "The OpenAI account ran out of credits 2026-08-16 and the app reports it as a retryable rate limit — CV extraction is dead until credits are added, and 'wait a minute and try again' is a lie."
metadata: 
  node_type: memory
  type: project
  originSessionId: 2660f573-67f5-4949-b3d2-31bccf171402
  modified: 2026-08-16T02:29:20.401Z
---

## UPDATE ~05:20 Cairo: credits RESTORED, but a SECOND blocker took over

Owner added billing. Error class moved `429 no credits` → `Request timed out` / `520` — proof the
account can reach OpenAI again. But the remaining large-PDF re-reads still fail, for a DIFFERENT
reason: **each attempt is capped at `OPENAI_ROUTE_BUDGET_MS = 60_000` (60s), and the client retries
to ~240s total** (`60s × (1 + OPENAI_MAX_RETRIES)`). The observed failure is a dead-exact **241.7s**
every time. These specific CVs are large/scanned PDFs at `reasoning.effort: "high"` whose single
attempt genuinely exceeds 60s, so all retries burn out. **Alaa Hamdy read** (one attempt happened to
land under 60s) and her fields were applied — `never_read 10 → 9`. The other 5 readable ones
(Yasmine Hamamza, Bahaa Abd El Azim, Nada Hefnawy, Ahmed Adel, Hassanalabd336) are a coin-flip per
4-min attempt. **Do NOT raise the 60s budget to force them** — `OPENAI_ROUTE_BUDGET_MS` governs the
whole live intake path (and cron-job.org caps at 30s anyway), so it is a production SLO change, not a
one-off knob. Grinding 4-min timeout calls also burns the credits just added. Leave the 5 for a
lighter-loaded machine or accept them as-is — old July CVs, and new intake reads fine.

**Background re-reads keep dying mid-run**: each OpenAI call is ~4 min and the local session recycles
faster than that, so a detached run never survives to finish. Run these FOREGROUND (`--limit 1`,
awaited inside the turn) if attempting at all.

---

**The OpenAI account had NO CREDITS REMAINING as of 2026-08-16 ~03:00 Cairo (restored ~05:00).** Raw
response on every call while exhausted:

> `429 You have no credits remaining. Add credits to continue using the API at
> https://platform.openai.com/settings/organization/billing/`

**CV extraction is therefore dead in production.** Last successful read: **08-15 22:46 Cairo** (Omar
Atef). No CV has arrived since, so nothing has visibly failed yet — but the next arrival will.
Intake still CREATES the candidate when extraction fails, so the symptom is not an error anybody
sees: it is a candidate carrying the **sender's** name and a NULL phone, which is exactly the mess
the 2026-08-16 name fix and field apply spent the night undoing. Adding credit is OWNER ACTION —
a billing action no session can perform.

Plausible cause: the 2026-08-16 re-read burned 40 extractions at high reasoning effort against
multi-MB PDFs, plus the 19 per-file forwarded-CV reads. Budget the spend before any future bulk
re-read.

## The 429 is MISCLASSIFIED as retryable — this cost two wrong answers to the owner

`src/lib/ai/openai-client.ts:118` and `:136` both decide:

```ts
code === "insufficient_quota" ? "quota_exceeded" : "rate_limited"
```

`cv-extraction.ts:410-416` then maps `quota_exceeded` to the CORRECT sentence ("The OpenAI account is
out of credit. Add billing/credit on platform.openai.com") and `rate_limited` to **"The OpenAI rate
limit was reached for now. Wait a minute and try again."**

The message that actually printed was the *rate limit* one, which proves the returned `code` was NOT
`insufficient_quota` — OpenAI's no-credits 429 carries some other code (or none). So the one branch
written specifically for this situation never fires, and the app tells everyone to wait for a
condition that will never clear. **I told the owner twice that a delayed retry would fix it. Both
were wrong.** Both error codes collapse to `ai_rate_limited` downstream too, so the intake health
screen cannot distinguish them either.

Fix (still OPEN, not written): classify a 429 as `quota_exceeded` when the message mentions credits
or quota, not only when `code === "insufficient_quota"`.

## Reading the failure correctly next time

`ai_rate_limited` with **~6-12 s per call and EVERY call failing** is credit exhaustion, not
throttling. A real rate limit clears and lets some calls through. Read the raw `openai_request_failed`
log line for the actual message before believing the mapped one.

Related: [[recruitment-intake-works-pipeline-never-used]] ·
[[candidate-name-fix-and-field-apply-prod-2026-08-16]] ·
[[intake-candidates-never-get-phone-applied]]
