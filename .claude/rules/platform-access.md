---
paths:
  - "src/lib/auth/{permissions,password-strength,leaked-password,change-password,password-setup,password-setup-no-script,password-setup-whatsapp,password-reset-code,temporary-password,seat-page-fences,seat-page-guard,signed-out-refusal}.ts"
  - "app/api/auth/{change-password,password-reset,password-setup}/**"
  - "tests/*{permission-matrix-cold-start,password-reset,password-setup,temporary-password,weak-password,leaked-password,seat-fence,signed-out}*"
---

# Module memory — Platform — passwords and access control

**Scope:** A password a person chooses and a reset code, the permission matrix and what it serves on a cold start, the per-seat page fences, the signed-out refusal, and the retired seats.

This file is loaded because this session opened a file of this module (or the module-memory hook matched the work to it). **It binds exactly like AGENTS.md.** First the module's rules, then every memory note filed under it: each note line is the cue, and the whole note is `.claude/cloud-context/memory-mirror/<name>.md` (identical to the laptop memory folder). **Before acting on a line that bears on your change, open its note.**

**Keeping it current:** a rule or fact you learn while working in this module goes into **Rules** below, in the same PR as the work. If a rule changed, EDIT its line — never add a second line that contradicts it. The notes block is generated (`node scripts/module-memory/build.mjs`); a new note reaches it through the fold, which runs three times a day — 09:00, 15:00 and 21:00 Cairo (docs/module-memory.md).

🔴 **A RULE BULLET OVER 1,200 BYTES MUST NAME ITS `docs/` ACCOUNT, or the required `validate` job goes RED** — `tests/agents-long-hooks-cite-docs.test.ts` measures every line starting `- ` inside the Rules block below, and this module file can sit far under its size cap while one bullet is over this limit. **Relocate FIRST, trim second:** write the evidence into a `docs/` file, then cut the bullet to the cue plus that pointer. Trimming first destroys the account while reading as a tidy-up. 🔴 **AND CITING docs/ IS NOT ENOUGH — the same test caps HOW MANY bullets may be over 1,200 at a tenth of all of them, which has about ONE bullet of slack**, so a long bullet reddens `validate` with its pointer in place (2026-10-04: 26 of 263 against a limit of 26.3). The fix is to shorten YOUR OWN long bullet, never to delete anyone's rule.

🔴 **PUT THE OPERATIVE CLAIM IN THE BULLET'S FIRST `**bold**` SPAN.** A session that never opens this file sees only that one span: `ruleHeadlines()` in `.claude/hooks/module-memory-injector.mjs` takes the FIRST `**…**` match per bullet (`/\*\*(.+?)\*\*/`) and nothing else, so a boundary, an exception or a date written in a later bold clause of the same bullet does not travel. A first span that states an absolute the rest of the bullet then qualifies is the worst case — it is read as the whole rule. 🔴 **Those spans are also the only thing that grows the pointer, which `tests/module-memory.test.ts` caps at 4,000 bytes (hard cliff 4,500) — a module that passes it is SPLIT, never trimmed** (`phoenix-crm` → `phoenix-crm-approvals`, 2026-10-03).

<!-- module-memory:rules:begin — hand-written; add this module's rules here -->
## Rules

### The permission matrix

- 🔴 **A COLD START WITH `role_permission_overrides` UNREADABLE FAILS CLOSED — NEVER BACK TO THE COMPILED DEFAULTS** (REC-058, 13 Nov 2026). With no last-known matrix, `coldStartPermissionMatrix()` gives every role nothing except the Super Admin, who keeps the defaults to repair the table (it carries no override). Not cached, so the next readable load serves the real matrix. CI has no database, so `tests/run-tests.ts` calls `seedPermissionMatrixWithDefaultsForTests()` before every test — never from `app/` or `src/`. Pinned by `tests/permission-matrix-cold-start.test.ts`.

### Login and password reset

- 🔴 **A CHOSEN PASSWORD GOES THROUGH `passwordWeakness`** (REC-058, 13 Nov 2026) — 8+ characters, not a well-known one, a straight run, a word dressed with digits and symbols ("Phoenix2026!") or the person's own login id. Both doors call it: `changeUserPassword` (a `WeakPasswordError`, answered 400 `weak_password`) and `completePasswordSetup`. Generated passwords never pass through it. Pinned by `tests/permission-matrix-cold-start.test.ts`.
- 🔴 **A CHOSEN PASSWORD FOUND IN A PUBLISHED LEAK IS REFUSED — ONLY THE FIRST FIVE CHARACTERS OF ITS FINGERPRINT LEAVE, AND AN UNREACHABLE SERVICE ACCEPTS THE PASSWORD AND SAYS SO** (INT-006; owner, 13 Nov 2026: "Refuse it when chosen"). `checkLeakedPassword` (`src/lib/auth/leaked-password.ts`) asks `api.pwnedpasswords.com/range/<5>` with `Add-Padding` and a 3-second deadline, after `passwordWeakness`, in both doors, BEFORE anything is written and before a set-password link is spent. Unknown means accepted with `leakedPasswordCheck: "not_checked"` on the audit row. Never check at sign-in (passwords in use are left alone, his choice), never fail closed, never add a header that names Phoenix. Account: `docs/security/second-sign-in-step.md`, "Leaked passwords". Pinned by `tests/leaked-password.test.ts`.
- 🔒 **A PASSWORD RESET CODE GOES ONLY TO THE EMPLOYEE'S `work_email` ON RECORD — NEVER A PERSONAL ADDRESS, AND NEVER AN ADDRESS TAKEN FROM THE REQUEST** (owner, 2026-10-07, asked before the self-service flow shipped: *"yes, Sato work email only, never a personal address"*). Measured on production that night: 208 employees, 188 carry a `work_email` and **all 188 are `@satopharma.com`**, zero other domains — so the rule excludes nothing that exists today. But `work_email` is NULLABLE and 20 rows have none: 15 `historical_payroll_record`, 2 `system_placeholder`, 1 `resigned`, and **2 ACTIVE Medical Representatives**, who therefore cannot self-reset and need an admin reset until HR fills their address. A flow that reads the destination from the request body, or falls back to any other column, is the defect this forbids. Account: `docs/agents-owner-rules.md`, "The reset code goes to the work email".
- 🔴 **A PASSWORD SUPABASE REFUSES AS WEAK IS REPLACED THERE BY A RANDOM SECRET, AND THAT PERSON'S SUPABASE SESSION IS MINTED WITHOUT THE PASSWORD** (23 Oct 2026). Phoenix accepts 8+ characters that pass `src/lib/auth/password-strength.ts`; production GoTrue refuses leaked ones. `provisionSupabaseAuthIdentity` then writes a random secret ONCE (marked `bridge_password_replaced`; a later login refreshes metadata only) and returns `weakPasswordReplaced`, and the caller uses `createSupabaseAuthSessionWithoutPassword(loginId)` — `generateLink` + `verifyOtp`, which SENDS NOTHING. Never store the weak password, never leave the OLD Supabase password live (the anon key signs in with it), and never call the password-free mint before Phoenix has verified the person. A weak refusal still reaching the login route is of the secret itself and IS reported. Pinned by `tests/weak-password-bridge.test.ts`.

### Access control — per-seat page fences

- 🔒 **A PAGE THE OWNER LEAVES OUT OF A SEAT WHOSE KEY WOULD OPEN IT IS FENCED IN `src/lib/auth/seat-page-fences.ts` — never a new permission key, never a role check on that page** (owner, 2026-10-08, building the Talent Acquisition seat from his ticks). Four readers, all required: `navigationItemVisible` hides the row, `AppShell` sends a typed or bookmarked address to the seat’s landing page, **every fenced page calls `guardSeatPage(access, "<its route>")` itself — the layout does not re-render on in-app navigation, so AppShell alone let a followed link through** (audit, 2026-10-23), and the fenced page’s own API routes call `assertPageOpenForRole`. A command-centre tile or task that links a fenced page goes through `hrefOutsideSeatFence` (sibling page or dropped). Pinned by `tests/hr-resourcing-seat.test.ts` and `tests/access-boundaries.test.ts`.

### Access control — the signed-out refusal

- 🔒 **`assertPermission` MARKS A GUEST REFUSAL `SignedOutRefusal` AND KEEPS THE `Forbidden:` WORDING — never change the wording, never move the mark above `canAccess`** (2026-10-26). The guest context is what `resolveAccessContext` returns for a missing, expired or rejected session. The prefix keeps every `isForbiddenError` route at 403; the mark lets a module's one failure handler answer 401 "sign in again" (Phoenix CRM's `phoenixCrmFailure` does). It can never widen access: it is thrown only where the request is already refused. Per-route alternative: `unauthenticatedSessionResponse` in `src/lib/auth/api-session-response.ts`.

### Access control — retired seats

- 🔒 **A RETIRED SEAT STAYS IN `phoenixRoles` AS A DORMANT KEY — `retiredPhoenixRoles` in `src/lib/auth/permissions.ts` — and is never deleted from the union** (owner, 2026-10-08, retiring the HR Business Partner, `HR Advisory`: "no more HR business partner"; its other work "Leave it for system administrator now"). The key holds an empty matrix entry (the universal self-service floor still applies), keeps its RESTRICTIONS (salary redaction), and leaves every seat set, nav list and rank case. Every picker lists `assignablePhoenixRoles`; `upsertAccessUserCore` and `upsertRolePermissionOverride` refuse a retired key by name. Its functions move to `UNASSIGNED_HR_FUNCTIONS` (the Super Admin's), never deleted, so handing them out later is a move. Pinned by `tests/hr-advisory-module-access.test.ts`.

<!-- module-memory:rules:end -->

<!-- module-memory:notes:begin — generated by scripts/module-memory/build.mjs; do not edit -->
## Memory notes (0)

_No notes filed under this module yet._
<!-- module-memory:notes:end -->
