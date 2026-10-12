---
name: nosiba-b1-elevated-to-district-manager-2026-08-15
description: "Nosiba Salah B-1 (Medical Rep acting as DM) elevated to District Manager role in prod on 2026-08-15 to activate her ACTING_DM seat scope; do NOT undo"
metadata: 
  node_type: memory
  type: project
  originSessionId: e871ae7f-c99e-4d10-ab4e-d4f8cffd8863
  modified: 2026-08-15T12:55:43.361Z
---

**LIVE prod 2026-08-15 — do NOT revert.** Nosiba Salah Hussenin Moussa (`B-1`, auth_user_id
`e43698f4-f278-4f3c-879c-04a409cff464`) is the org's ONLY `ACTING_DM` — she holds seat
`SEAT-AIF-ADM-UE-1` (anti_infective, label "rep acting as DM - reports to NSM") which owns areas
**UE1, UE2, UE9** (UE9 sits in region GZ/Giza, outside her own "Upper Egypt 1" label). Her HR
`job_title` stays **Medical Representative** and her PAY is unchanged (basic 14,700 / net 23,500) —
only ACCESS changed.

**Root cause of the gap:** the seat-area resolver (`src/lib/sales/seat-area-scope.ts`) gates on
ROLE first — `SEAT_AREA_SCOPED_ROLES = {District Manager, Manager, Regional Manager}`. A "Medical
Rep" occupying an ACTING_DM seat gets `getSalesScope`=SELF and the resolver returns null before the
ACTING_DM handling ever runs, so her seat's UE1/UE2/UE9 (esp. Giza UE9 + her rep Aisha B-79 in UE2)
were invisible. **An ACTING_DM only works if the app role is District Manager.**

**Fix = the four-write role change** ([[changing-a-user-role-needs-four-writes]]), applied in one
tx: `app_auth_users` role→District Manager + session_version 1→2 + manager_hr_id AA→AI-0008;
`user_access_profiles` phoenix_role→District Manager, role→manager, scope_type→TEAM; `auth.users`
metadata MERGED (`||`) phoenix_role/coarse_access_role=manager/access_scope=TEAM; `app_sessions`
revoke (0 live rows — she wasn't logged in, so no forced logout; she gets DM on next login). Audit
row written (id eb9e21d8). Verified: seat resolver now returns UE1/UE2/UE9; rep B-79 (Minia 2/UE2)
covered_by_her_district=true. Related: [[account-creation-defaults-role-to-employee]],
[[field-force-provisioning-live-and-guard-relaxed-2026-08-14]].

**Direct-order submission audit 2026-08-15 (owner: "can she submit direct orders?") — she CAN, no
change needed.** Submission gates on the app role in `app_auth_users.role`, NOT `employees.job_title`
(still "Medical Representative" — cosmetic, irrelevant here). Every gate passes now: DM holds
`direct_orders:[read,create,...]`; DM ∈ `DIRECT_ORDER_REQUESTER_ROLES` (Medical Rep is NOT — that was
her blocker BEFORE the elevation, `submitDirectOrder` badRequest "Role Medical Rep cannot submit");
line resolves to "Anti Infective" via `app_auth_users.line` (`employees.line_id` null — same pattern
as all 17 other DMs, so 2 active AIF products show in her dropdown); approval chain resolves SFE →
Magdy El Senosey (NSM, AI-0008, active) → CEO; area scope UE1/UE2/UE9 feeds the pharmacy picker;
session consistent v4 (fresh login 12:00:25). She has 0 direct orders ever. If she still reports a
failure, capture the exact on-screen error — it names the failing gate.

**"Direct Order still not appearing" 2026-08-15 → the LAST title-driven gate was the portal
SIDEBAR, fixed in PR #2159 (branch `codex/portal-nav-follows-app-role`, OPEN, awaiting CI+merge —
merge ships to prod).** Backend all keyed on app role and already passed (page gate
`assertDirectOrdersPageAccess`→`canAccess`, submit route→`submitDirectOrder`), but
`resolvePortalRole` in `src/lib/employee-portal/navigation.ts` gave the job-title-derived `roleLabel`
PRECEDENCE over the app `accessRole`, so her title "Medical Representative" classified her as Medical
Rep and hid `showDirectOrdersTab` (+ every other DM tab). Fix flips the loop to
`[accessRole, roleLabel]` and returns a strict parse only when it isn't `"Employee"` — app role wins
when definite, title stays the FALLBACK for un-upgraded (`role="Employee"`) accounts. **General
lesson: the app role gates PERMISSIONS but the portal nav classified VISIBILITY from job title — two
layers, and an acting-role account with a mismatched title trips the nav layer even when every
server-side guard passes.** One intended side effect: any account whose access role differs from its
title in the non-Employee direction now follows the access role (nav matches real permissions). Do
NOT change her `job_title` to fix this — the code fix is the owner's chosen path.

**Owner CONFIRMED 2026-08-15: keep her on FULL District Manager authority — do NOT cap it to an
"acting" subset.** There is no scoped acting-DM permission tier in the app (ACTING_DM is only a
`seat_tier` in the AU/organogram; every access decision gates on `app_auth_users.role`). All FOUR
role-store writes are present + consistent: `app_auth_users` (District Manager, active, v4),
`user_access_profiles` (phoenix_role=District Manager / role=manager / scope_type=TEAM), `auth.users`
raw_app_meta_data (phoenix_role=District Manager / coarse=manager / access_scope=TEAM), live session
v4. Exercisable: 1 active report, Aisha `B-79` (Minia 2/UE2), routes approvals through her; B-106
resigned. Her `employees.job_title` stays "Medical Representative" (cosmetic only — makes her
approver-rung label read "Medical Representative"; org chart already shows DM via seat_tier). Nothing
to change.

## TWO OPEN SEATS IS CORRECT — owner confirmed 2026-10-12: "leave Nosiba on both seats"

**She is the only person in the org holding two open seats, and it is deliberate.** Read live from
production on 12 Oct 2026:

- `SEAT-AIF-ADM-UE-1` (`ACTING_DM`, parent `SEAT-AIF-NSM`) — the whole Anti Infective Upper Egypt 1
  region: UE1, UE2, UE9.
- `SEAT-AIF-REP-UE1` (`REP`, area UE1 = Minia 1, **parent `SEAT-AIF-ADM-UE-1`**) — she kept her own
  territory when she began acting as DM, so her rep seat's manager IS herself.

Both seats were re-created `effective_from` **2026-07-13** and neither has an `effective_to`.
**Never close one to make the count read one, and never report the pair as a defect** — a session's
audit flagged it on 12 Oct and his answer was to leave both.

**`au_v_employee_seat_drift` has an explicit self-manager exception** that exists for exactly this
shape: `manager_drifted` is forced false when the parent seat's occupant is the employee herself
(`lower(parent_occ.occupant_hr_id) is distinct from lower(e.hr_id)`). Both her rows report no drift.

**No double counting.** `au.f_monthly_attribution` carries `rep_hr_id` and `dm_hr_id` on every row,
so she is scored twice over DIFFERENT scopes, the same as any DM whose region contains a rep:
September 2026 — as Minia 1 rep **29,515.00**; as acting DM **64,918.90** (Minia 1 29,515.00 +
Minia 2 27,105.45 + Beni Suef 8,298.45). Comparing the two numbers as if one contained an error is
the mistake.

**Three facts above this line are now STALE** (live 12 Oct 2026): her `employees.job_title` is
**District Sales Manager**, not "Medical Representative" (changed 9 Oct); her active reports are
**Ahmed Mohamed Abd-Elnaim AI-0026** (Minia 2 / UE2) and **Hanan Safwat SalahEldeen Hassan AI-0012**
(Beni Suef / UE9), not Aisha B-79; and her manager is **Magdy El Senosey Helmy AboElsebh AI-0008**,
National Sales Manager. The access half of this note still holds.
