---
paths:
  - "src/lib/auth/{server,session,session-bundle-cache,session-heartbeat,session-lifecycle,session-token,app-sessions,client-session}.ts"
  - "src/lib/session-pulse-store.ts"
  - "src/components/auth/session-security-guard.tsx"
  - "app/api/auth/{pulse,heartbeat,login,logout}/**"
  - "tests/*{session,pulse}*"
---

# Module memory — Platform — the login check, the session copy, the heartbeat and the open tab's pulse

**Scope:** How a signed-in person stays signed in and what it costs: the phx_auth_session_bundle read and the one live read that requests arriving together share, the ten-minute outage copy, the session heartbeat and its outage answer, the session pulse an open tab sends, and the audit rows a sign-in and a rejected session leave.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

### The login check and what it costs

- 🔴 **THE LAST ACCEPTED SESSION MAY STAND IN FOR A FAILED LOGIN CHECK FOR TEN MINUTES — LIVE FIRST, ACCEPTED SESSIONS ONLY, NEVER STORED AGAIN FROM A COPY** (owner, 18 Oct 2026; the Talent Acquisition seat met "Session verification is temporarily unavailable" at 10:57 Cairo). `src/lib/auth/session-bundle-cache.ts`, recalled in ONE place in `server.ts`: only after the live `phx_auth_session_bundle` call and its retry both fail, under 10 minutes old, through every check a live bundle gets. A live answer forgets it, serving never resets the age, no copy still throws `SessionVerificationUnavailableError`. 🔴 **A copy READS ONLY**: never a non-GET/HEAD API request, never a server action (a POST to a page — `next-action` header or a body, `pageRequestMayUseRecentCopy`; it used to slip through `resolveAccessContextFromPage` until 19 Oct 2026), never the passkey or password routes (`allowRecentCopy: false`); logout and forced logout forget it, and a read begun before that cannot re-store it. Accepted exposure: a role change or deactivation made elsewhere can go unseen up to 10 minutes while the live check fails. Account: `docs/observability.md`, "18 October 2026". Pinned by `tests/session-bundle-cache.test.ts`.
- 🔴 **READ-ONLY REQUESTS THAT ARRIVE TOGETHER SHARE ONE LIVE LOGIN CHECK — NEVER A KEPT ANSWER** (31 Oct 2026). Opening a portal page prefetches ~15 pages to their loading screens and each ran `phx_auth_session_bundle` for the same person: 861 calls in 9 minutes, 18% of every Supabase request. `shareLiveBundleRead` (`src/lib/auth/session-bundle-cache.ts`) lets a GET/HEAD API call or a page render that is not a server action wait for that session's live read already in flight, under 1 s old. Nothing outlives the read, each request checks its own token on its own deep copy, and a logout here ends the sharing. 🔴 **Never pass `shareLiveRead` from a write, the heartbeat (`refreshIdle`), a passkey or a password route, and never turn it into a time-based cache** — that is the fast path the copy rule above forbids. Pinned by `tests/session-bundle-cache.test.ts` §13. Account: `docs/observability.md`, "One live login check per burst".

### The heartbeat and the open tab's pulse

- 🔴 **BOTH OF THE HEARTBEAT’S DATABASE STEPS ANSWER AN OUTAGE WITH 503, NEVER A CRASH** (System Audit root cause APP-20D39617, 23 Oct 2026). The request-counting step (`assertApiRateLimit`) runs before the session read and rethrew its timeout, so every open page crashed with a 500 during each database restart — 106 times for 50 people, mostly 22 Oct 12:00–15:00 Cairo. Both catches now share `isSessionServiceOutage` → `sessionServiceUnavailable()` in `app/api/auth/heartbeat/route.ts`; never 401 (the client signs out on it). Pinned by `tests/system-audit-root-cause-fixes.test.ts`.
- 🔴 **THE SIDEBAR BADGES ARE REFRESHED ONCE A MINUTE, NOT ON EVERY 30 s TICK** (owner, 31 Oct 2026: "badges up to 1 minute old"). Every tick paid a full badge read because the server's per-viewer memory lasts 20 s: about 2,743 reads and 50,000–57,000 Supabase requests on Wednesday 28 Oct, about 8% of the day. `BADGES_GAP_MS` (55 s, equal to `NOTICES_GAP_MS`) in `src/lib/session-pulse-store.ts`; a tab shown again, a badge mounted with nothing cached and a failed read still ask at once. Never put the badges back on every tick, and never lengthen the gap past a minute without his word. Pinned by `tests/session-pulse.test.ts` §6, §9, §12. Account: `docs/observability.md`, "Cut 3".
- 🔴 **A HEARTBEAT WITH NOTHING TO CARRY WAITS UP TO 3 s FOR THE BELL OR A BADGE TO RIDE WITH IT** (31 Oct 2026). The session guard reported activity the moment a page opened and the pulse sent a bare POST; the bell mounted a moment later and sent its own GET: 14 of 67 pulse requests in 9 minutes, 0.4–2.5 s apart. `HEARTBEAT_GATHER_MS` in `src/lib/session-pulse-store.ts` holds only a heartbeat that would travel empty; a badge or the bell is never delayed, and the heartbeat goes alone when the wait ends. Never "fix" it back to an immediate POST. Pinned by `tests/session-pulse.test.ts` §11. Account: `docs/observability.md`, "One live login check per burst".

### Sign-in and session audit rows

- 🔒 **EVERY REJECTED SESSION REQUEST KEEPS ITS OWN `audit_logs` ROW — do not de-duplicate them** (owner, 2026-10-04, asked directly after the performance review measured 1,728 rejection rows in 14 days, 92% repeats of one session and reason). `auditSessionRejection` in `src/lib/auth/server.ts` stays one row per rejection; the Operations page's 24-hour auth count reads them. Never re-propose a per-session window.
- 🔴 **A SUCCESSFUL SIGN-IN'S "Login succeeded" AUDIT ROW IS AWAITED BEFORE THE REPLY — NEVER BEHIND `afterResponse`** (owner, 23 Oct 2026). #6353 deferred all of the sign-in's bookkeeping for speed; a task deferred past the response is lost when the process stops in between, and a deploy swaps the container exactly then, so a person could be signed in with no row saying so. Only the audit row moved back (one insert; `writeAuditLog` queues a slow write in the outbox and never throws); the success attempt row and the lockout reset stay after the reply. Account: `docs/agents-owner-rules.md`, "Sign-in runs its checks side by side". Pinned by `tests/login-success-audit-before-reply.test.ts`.
<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (0)

_No notes filed under this module yet._
<!-- module-memory:notes:end -->
