import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { phoenixRoles, type PhoenixRole } from "../src/lib/auth/permissions.ts";
import {
  mapPhoenixRoleToAccessScopeType,
  mapPhoenixRoleToCoarseAccessRole,
} from "../src/lib/auth/supabase-identity.ts";

// Regression coverage for the fix that makes `user_access_profiles` always get created and stay
// in sync with an account's role. Root cause: upsertAccessUserCore (src/lib/admin/access-control.ts)
// only wrote the profile `if (authUserId)` — with no else, a falsy authUserId meant app_auth_users
// was written and user_access_profiles was silently skipped. That produced real accounts with a
// login row and no profile: CN-0006 (active Medical Rep) and PD-0007 (inactive Medical Rep), both
// with a NULL app_auth_users.auth_user_id.
const accessControlSource = readFileSync("src/lib/admin/access-control.ts", "utf8");

export function runAccessProfileSyncTests() {
  // ── (a) Every role has a real, defined profile derivation ──────────────────────────────
  // The user_access_profiles row is built purely from these two mapping functions (role ->
  // coarse role, role -> scope type). If either ever returned undefined for a real PhoenixRole,
  // the profile upsert would still "succeed" but carry a broken column. Pin every role resolves
  // to one of the documented enum values, and spot-check both ends of the privilege range so a
  // refactor cannot silently flatten every role into the same bucket.
  const coarseRoles = new Set(["company_reader", "employee", "finance", "manager", "super_admin"]);
  const scopeTypes = new Set(["COMPANY_READ", "FINANCE", "HIERARCHY", "LINE", "SELF", "SUPER_ADMIN", "TEAM"]);
  for (const role of phoenixRoles as readonly PhoenixRole[]) {
    const coarse = mapPhoenixRoleToCoarseAccessRole(role);
    const scope = mapPhoenixRoleToAccessScopeType(role);
    assert.ok(coarseRoles.has(coarse), `${role} must derive a known coarse access role, got ${coarse}`);
    assert.ok(scopeTypes.has(scope), `${role} must derive a known scope type, got ${scope}`);
  }
  assert.equal(mapPhoenixRoleToCoarseAccessRole("Super Admin"), "super_admin");
  assert.equal(mapPhoenixRoleToAccessScopeType("Super Admin"), "SUPER_ADMIN");
  assert.equal(mapPhoenixRoleToCoarseAccessRole("Employee"), "employee");
  assert.equal(mapPhoenixRoleToAccessScopeType("Employee"), "SELF");
  assert.equal(mapPhoenixRoleToCoarseAccessRole("District Manager"), "manager");
  assert.equal(mapPhoenixRoleToAccessScopeType("District Manager"), "TEAM");

  // ── (a) upsertAccessUserCore writes user_access_profiles from those same two functions ──
  // Exactly one LIVE-WRITE upsert into user_access_profiles exists in this file, keyed on the
  // account's freshly-resolved authUserId and shared by BOTH "create a brand new account"
  // (requiresInitialPassword) and "update an existing account's role/metadata" — a new account
  // can never take a different code path than an edited one. A second, DIFFERENT upsert also
  // exists on the failure path (`catch (mutationError) { ... upsert(previousProfile.data ...`),
  // restoring the prior snapshot as part of the compensation saga — that one is intentional and
  // must not be confused with a diverging duplicate of the live write, so match on the live
  // write's distinctive `auth_user_id: authUserId,` shape rather than counting every upsert call.
  const liveWriteUpsertMatches =
    accessControlSource.match(/\.from\("user_access_profiles"\)\s*\.upsert\(\{\s*auth_user_id: authUserId,/g) ?? [];
  assert.equal(
    liveWriteUpsertMatches.length,
    1,
    "upsertAccessUserCore must have exactly one LIVE-WRITE user_access_profiles upsert shared by create and update, not a diverging per-branch copy",
  );
  const totalProfileUpsertMatches = accessControlSource.match(/\.from\("user_access_profiles"\)\s*\.upsert\(/g) ?? [];
  assert.equal(
    totalProfileUpsertMatches.length,
    2,
    "expected exactly 2 total user_access_profiles upserts: the one live write plus the one rollback-restore inside the compensation saga's catch block — a different count means the saga shape changed",
  );
  assert.ok(
    accessControlSource.includes("phoenix_role: role,") &&
    accessControlSource.includes("role: mapPhoenixRoleToCoarseAccessRole(role),") &&
    accessControlSource.includes("scope_type: mapPhoenixRoleToAccessScopeType(role),"),
    "the user_access_profiles write must derive phoenix_role/role/scope_type from the account's role via the shared mapping functions",
  );
  assert.match(
    accessControlSource,
    /\.from\("user_access_profiles"\)\s*\.upsert\(\{\s*auth_user_id: authUserId,[\s\S]{0,1200}onConflict: "auth_user_id",/,
    "the profile upsert must be keyed on auth_user_id so re-saving the same account updates its row instead of duplicating it",
  );

  // ── (b) The silent-skip path is now observable ──────────────────────────────────────────
  // Before this fix, `if (authUserId) { ...write profile... }` had no else. Pin that the branch
  // now exists and logs a dedicated, greppable event with the loginId — not a generic message.
  assert.match(
    accessControlSource,
    /if \(authUserId\) \{[\s\S]{0,2500}logError\(\s*"Access control profile write skipped: no auth_user_id",\s*\{\s*labels: \{ event: "access_control_profile_write_skipped_no_auth_user_id" \},\s*context: \{ loginId \},\s*\}\s*\);/,
    "the missing-auth_user_id case must call logError with a dedicated event label and the loginId, not fail silently",
  );

  // ── Every path that mints a new account's auth identity precedes the profile write ──────
  // provisionSupabaseAuthIdentity always returns a real authUserId or throws (never resolves
  // with an empty one), so a genuinely NEW account (requiresInitialPassword) can only reach the
  // profile write with authUserId populated. Guard that this call still exists on the create
  // branch: if a future edit deleted it, brand-new accounts could start hitting the else branch
  // instead of getting a real profile.
  assert.match(
    accessControlSource,
    /if \(requiresInitialPassword\) \{[\s\S]{0,800}provisionSupabaseAuthIdentity\(/,
    "a brand-new account must mint its Supabase auth identity before the profile write is reached",
  );

  // ── The one-time backfill script exists and follows this repo's ops-script contract ─────
  // scripts/backfill-missing-access-profiles.ts is authored but never run automatically. This
  // repo's convention for a production-touching one-off (see
  // scripts/provision-missing-employee-accounts.ts) is: dry-run by default, an explicit --apply
  // flag, and a matching --confirm-production token before any write reaches production. Pin
  // the same contract here so the script can't be invoked into a live write by accident.
  const backfillSource = readFileSync("scripts/backfill-missing-access-profiles.ts", "utf8");
  assert.match(backfillSource, /--apply/, "the backfill must require an explicit --apply flag to write");
  assert.match(
    backfillSource,
    /--confirm-production/,
    "the backfill must require a confirm-production token before any production write",
  );
  assert.match(
    backfillSource,
    /dry.run/i,
    "the backfill must print a dry-run summary before writing anything",
  );
  assert.match(
    backfillSource,
    /provisionSupabaseAuthIdentity/,
    "the backfill must provision a real GoTrue identity for NULL-auth_user_id accounts before it can write their profile (raw SQL cannot mint one)",
  );
  assert.match(
    backfillSource,
    /mapPhoenixRoleToCoarseAccessRole/,
    "the backfill must derive the coarse role the same way the live provisioning path does",
  );
  assert.match(
    backfillSource,
    /mapPhoenixRoleToAccessScopeType/,
    "the backfill must derive the scope type the same way the live provisioning path does",
  );
  assert.match(
    backfillSource,
    /user_access_profiles/,
    "the backfill must write user_access_profiles",
  );

  // The backfill must never re-touch AI-0007 — the owner's instruction was explicit: it was
  // already fixed in production and must not be re-processed by this script. The script's
  // header comment is allowed to document that AI-0007 is intentionally excluded (context the
  // owner asked to see in the PR body); what must actually hold is that the login_id is hard
  // -excluded from the discovery/apply loop itself, via the neverTouchLoginIds set.
  assert.match(
    backfillSource,
    /const neverTouchLoginIds = new Set\(\["AI-0007"\]\);/,
    "AI-0007 must be hard-excluded via neverTouchLoginIds, not merely documented",
  );
  assert.match(
    backfillSource,
    /neverTouchLoginIds\.has\(loginId\.toUpperCase\(\)\)\) continue;/,
    "buildPlan must actually skip any login_id in neverTouchLoginIds before it can be added to the plan",
  );

  // ── The backfill must never attempt a write that would violate the hr_id FK ─────────────
  // user_access_profiles.hr_id is NOT NULL and a case-sensitive FK to employees.hr_id. An
  // account with no matching employees row must be skipped and reported, never allowed to
  // crash the whole run on a 23503, and never allowed to sneak an unverified value into the
  // write path.
  assert.match(
    backfillSource,
    /\.from\("employees"\)\s*\.select\("hr_id"\)/,
    "the backfill must load the real employees.hr_id set before writing any profile",
  );
  assert.match(
    backfillSource,
    /no_matching_employee_row/,
    "an account with no matching employees row must be skipped with a greppable reason, not silently dropped or fatal",
  );
  assert.match(
    backfillSource,
    /resolveVerifiedHrId/,
    "the backfill must resolve hr_id through a verified lookup, not a blind casing guess, before it can be used in a write",
  );

  // ── Leaver safety: an inactive/resigned account must never get a usable login ───────────
  // PD-0007 is INACTIVE/resigned with a NULL auth_user_id. provisionSupabaseAuthIdentity
  // already bans the GoTrue user at creation when isActive is false (ban_duration is set
  // directly in its admin.createUser() call — see src/lib/auth/supabase-identity.ts), so the
  // identity minted for an inactive account is born already-banned. On top of that, the
  // backfill must not additionally hand out a password-setup link for an inactive account —
  // pin that createSetupLink is gated on isActive, not called unconditionally.
  assert.match(
    backfillSource,
    /isActive \? await createSetupLink\(/,
    "the backfill must only generate a password-setup link for an ACTIVE account, never for a resigned/inactive one",
  );
  assert.doesNotMatch(
    backfillSource,
    /const setupLink = await createSetupLink\(/,
    "createSetupLink must not be called unconditionally — an inactive account must never receive a usable setup link",
  );
}
