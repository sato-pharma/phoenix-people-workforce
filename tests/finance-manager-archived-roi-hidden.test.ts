import assert from "node:assert/strict";

import { archivedMarketingPageItems, hubPageItemGroups, payrollManagementPageItems } from "../src/config/system-navigation.ts";
import type { PhoenixRole } from "../src/lib/auth/permissions.ts";
import { permissionActions, permissionMatrix, permissionResources } from "../src/lib/auth/permissions.ts";
import { permissionAllowed, roleAllowed, roleNotExcluded, type PermissionLookup } from "../src/lib/navigation/active-path.ts";

const FINANCE: PhoenixRole = "Finance Manager";

/**
 * Pins the fix shipped in #2008 (46b8e8bf), which landed without a test of its own.
 *
 * The owner asked TWICE (2026-08-10) for "Archived ROI Tracking" to be off the Finance Manager's
 * account. The first attempt hid the parent hub row and looked done — but `hubPageItemGroups`
 * re-admits every card a viewer's ROLE allows, regardless of whether the parent hub is visible,
 * so the card kept folding into his Cmd+K palette one keystroke away. Hiding a hub is therefore
 * NOT a way to hide a card; removing the role is.
 *
 * Written after an account audit read a stale checkout and reported this card as still exposed.
 * It was not — the fix was already live — but nothing in the suite could say so, and that is the
 * real gap this file closes: the state becomes assertable in 2ms instead of inferable from
 * whichever branch the reader happens to be standing on. It pins the MECHANISM, not just the
 * outcome, so a future "hide the hub" fix for a similar request fails here instead of shipping.
 */
function lookupFor(role: PhoenixRole): PermissionLookup {
  const lookup: PermissionLookup = {};
  for (const resource of permissionResources) {
    for (const action of permissionActions) {
      const key = `${resource}:${action}` as const;
      lookup[key] = permissionMatrix[role]?.[resource]?.includes(action) ?? false;
    }
  }
  return lookup;
}

function cardVisibleTo(item: { permissions?: unknown; roles?: readonly PhoenixRole[]; excludedRoles?: readonly PhoenixRole[] }, role: PhoenixRole) {
  return (
    permissionAllowed(lookupFor(role), item.permissions as never) &&
    roleAllowed(role, item.roles) &&
    roleNotExcluded(role, item.excludedRoles)
  );
}

export function runFinanceManagerArchivedRoiHiddenTests() {
  const archived = archivedMarketingPageItems.find((item) => item.href === "/admin/archived-marketing-requests");
  assert.ok(archived, "the Archived ROI Tracking card must still exist for the roles that DO use it");

  // The headline. If this fails, the Finance Manager can reach Archived ROI Tracking again.
  assert.equal(
    cardVisibleTo(archived, FINANCE),
    false,
    "Archived ROI Tracking must NOT be visible to the Finance Manager — the owner removed it twice; " +
      "he executes LIVE marketing payments from the Marketing Inbox and has no duty in the legacy Excel set",
  );

  // Removing the role is the fix. Hiding the hub is not — prove the hub-hiding escape hatch is
  // still open, so anyone tempted to use it sees why it does not work.
  const group = hubPageItemGroups.find((entry) => entry.items === archivedMarketingPageItems);
  assert.ok(
    group,
    "archivedMarketingPageItems must still be listed in hubPageItemGroups — this test's whole point is " +
      "that Cmd+K re-admits cards by ROLE regardless of hub visibility, so the role list is the only real gate",
  );

  // The card must keep working for everyone the owner did NOT remove.
  for (const role of ["Super Admin", "CEO", "SFE Manager", "Financial Advisor"] as PhoenixRole[]) {
    assert.equal(
      cardVisibleTo(archived, role),
      true,
      `${role} must still see Archived ROI Tracking — this change removed one role, not the card`,
    );
  }

  // The paired item from the same 2026-08-10 sweep. It was fixed correctly at the time; pin it so
  // the two never drift apart again.
  const deductions = payrollManagementPageItems.find((item) => item.href === "/admin/deductions");
  if (deductions) {
    assert.equal(
      cardVisibleTo(deductions, FINANCE),
      false,
      "/admin/deductions must stay hidden from the Finance Manager — same sweep, same reason",
    );
  }
}
