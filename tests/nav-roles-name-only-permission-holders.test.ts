import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  getNavigationSections,
  hubPageItemGroups,
  navigationHomePathByMode,
  type NavigationPermission,
} from "@/config/system-navigation";
import {
  buildPermissionLookup,
  permissionMatrix,
  phoenixRoles,
  type NavigationMode,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import { permissionAllowed } from "@/lib/navigation/active-path";

/**
 * A `roles:` name the permission matrix refuses everywhere its list is used.
 *
 * ## The shape, and the trap in stating it too simply
 *
 * `navigationItemVisible` refuses on `permissions` BEFORE it looks at `roles` — permissions are
 * "never waived", roles are waived only for Super Admin. So a role named beside a grant it does not
 * hold is admitted by nothing. The obvious rule to write from that — "every named role must hold
 * that entry's permission" — is WRONG here, and measuring it is what proved so. On 2026-08-29 it
 * reported 11 findings, and 8 of them were a deliberate, documented design:
 *
 *     const hrAuthorityNavigationRoles = ["Super Admin", "HR Advisory", "HR Operations"]
 *
 * That one list has 11 consumers, and its comment in system-navigation.ts states the intent
 * plainly: every consumer also carries a `permissions:` clause, so the matrix separates the two HR
 * bundles for free — the recruitment tools reach HR Advisory (who holds `recruitment`), vacation
 * control reaches HR Operations (who holds `leave:update`), from ONE list. Verified against the
 * live matrix the same day: both halves are exactly as described. Under the naive rule every
 * recruitment entry "names HR Operations inertly" and every leave entry "names HR Advisory
 * inertly", and the only ways to satisfy it would be to split the list in two — duplicating it,
 * which is the defect this whole program exists to remove — or to allowlist eight entries, which
 * is just somewhere to file the next one.
 *
 * ## The rule this file actually enforces
 *
 *   A role named in a `roles:` list must hold the needed permission on at least ONE consumer of
 *   that same list.
 *
 * A name that works nowhere across every entry sharing its list is doing nothing anywhere, and no
 * shared-list argument can explain it. Grouping is by ARRAY IDENTITY, not by contents: `roles:
 * hrAuthorityNavigationRoles` hands every consumer the same object, so the group is exact and free.
 * An inlined copy — `roles: [...hrAuthorityNavigationRoles]` — is deliberately treated as its own
 * single-use list, because a copy is a new list and a dead name inside it is dead.
 *
 * That identity assumption is load-bearing, so it is asserted rather than trusted: if some future
 * refactor clones these arrays, the grouping silently degrades back to the naive rule and eight
 * deliberate names start failing with a confusing message. The floor below catches that instead.
 *
 * ## The thing a config-only reader cannot see, and why this file goes and looks
 *
 * A hub page may decide one card's visibility for itself, and when it does, that card's
 * `permissions:` field stops governing who sees it. Exactly one such override exists today:
 * `app/(admin)/attendance/page.tsx` returns `canAccessFingerprintReport(access)` for the Fingerprint
 * Report card instead of calling `navigationItemVisible` at all. Reading the config alone reports
 * that card's CEO name as dead — and the CEO in fact sees the card and can open the page.
 *
 * That false positive was not a curiosity; acting on it would have widened real access. The
 * "obvious" repair was to grant the CEO `employees:read`, and `employees` is a HARD BOUNDARY
 * (`hardBoundaryAllowedActions` in permissions.ts) that `tests/ceo-account-contract.test.ts` pins
 * shut in the required `validate` job — "CEO must not be grantable employees:read by role
 * overrides". The codebase had already solved this deliberately, with a page-scoped exception that
 * leaves the boundary where it is. So this file scans the hub sources for the override pattern and
 * declines to judge what it finds, and then asserts the set it found is EXACTLY the set it expects,
 * so a new override announces itself instead of quietly widening the exemption.
 *
 * ## Why the backlog is empty, and what it costs to add a row
 *
 * It went to zero on 2026-08-29 and the three ways it got there are the three honest outcomes:
 *
 *   /attendance/fingerprint-report    NOT A DEFECT — the hub override above. Excluded by
 *                                     measurement, not by an allowlist entry.
 *   /leave-management/vacation-request GRANTED. The owner was asked directly and said yes; the CEO
 *                                     now holds `leave:create` and the row renders. `leave` carries
 *                                     no hard boundary, so this was a real one-line grant.
 *   /attendance/monthly-summary       NAME DELETED. The page gates on employees:read and nothing
 *                                     else, the boundary above forbids granting it, so the name
 *                                     could never have rendered a row. Giving the CEO that page
 *                                     means moving a segregation-of-duties boundary and re-pinning
 *                                     the CEO contract — an owner decision, not a navigation fix.
 *
 * A row here needs a reason, a date, and the decision it waits on — never "known failure". A name
 * that works nowhere is a missing grant, a false positive, or a name to delete, and the assertion
 * below fails a row that has stopped describing a real finding, so the list cannot rot quietly.
 */

/**
 * The only names exempt from the rule above. Each needs a reason, a date, and a decision it is
 * waiting on — not "known failure". Do NOT add an entry to make a build green: a name that works
 * nowhere is either a missing grant or a name to delete, and both repairs are one line.
 */
const NAME_ONLY_BACKLOG: readonly {
  readonly href: string;
  readonly reason: string;
  readonly recorded: string;
  readonly role: PhoenixRole;
}[] = [];

type GatedEntry = {
  readonly excludedRoles?: readonly PhoenixRole[];
  readonly href?: string;
  readonly label?: string;
  readonly permissions?: readonly NavigationPermission[];
  readonly roles?: readonly PhoenixRole[];
};

type ScannedEntry = { entry: GatedEntry; where: string };

/** Every `page.tsx` that filters nav items itself — the hubs, found by what they do, not by a list. */
function hubPageSourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "page.tsx" && readFileSync(full, "utf8").includes("navigationItemVisible")) {
        files.push(full.replace(/\\/g, "/"));
      }
    }
  };
  walk(path.join("app", "(admin)"));
  return files.sort();
}

/**
 * Hub cards whose visibility the hub page decides for itself, so `permissions:` does not govern them.
 *
 * Discovered, never hard-coded. A hard-coded href stops matching the day someone renames the route,
 * and the failure mode is a false accusation against a name that is doing its job — which is exactly
 * the mistake this function exists to prevent, so it must not be able to make it silently.
 *
 * Both spellings are resolved: a literal `item.href === "/x"`, and the indirection this repo
 * actually uses — `item.href === SOME_CONST` with `const SOME_CONST = "/x"` in the same file.
 * Comments are not stripped first, deliberately: `blankOut` is length-preserving but blanks STRING
 * literals too, which would erase the very hrefs being read. The exactness assertion in the run
 * function is the safety net instead — a match picked up from a comment changes the set and fails.
 */
const HUB_OVERRIDE_PATTERN = /item\.href\s*===\s*(?:"([^"]+)"|([A-Za-z_$][\w$]*))/g;

function hubCardsOverriddenByTheirPage(): Map<string, string> {
  const overrides = new Map<string, string>();
  for (const file of hubPageSourceFiles()) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(HUB_OVERRIDE_PATTERN)) {
      const literal = match[1];
      if (literal) {
        overrides.set(literal, file);
        continue;
      }
      const identifier = match[2]!;
      const bound = new RegExp(`\\b${identifier}\\s*=\\s*"([^"]+)"`).exec(source);
      assert.ok(
        bound,
        `${file} overrides visibility for \`item.href === ${identifier}\`, but no ` +
          `\`${identifier} = "…"\` binding exists in that file, so this test cannot tell which ` +
          `route is exempt. Guessing would either accuse a working name or hide a broken one — ` +
          `bind the href to a string constant in the same file, or compare against a literal.`,
      );
      overrides.set(bound![1]!, file);
    }
  }
  return overrides;
}

/**
 * Every gated entry the product offers: sidebar rows in all three modes, plus every hub card.
 *
 * The mode list is derived from `navigationHomePathByMode` rather than written out, so a fourth
 * shell joins this sweep by existing. A hand-written list is one more copy to forget to update,
 * and the failure would be silent: a mode nobody scans reports no findings.
 *
 * Hub cards their own page overrides are dropped here rather than in `deadNames`, because they are
 * genuinely not config-governed entries — judging them at all is the category error.
 */
function scanNavigationEntries(overriddenHrefs: ReadonlySet<string>): ScannedEntry[] {
  const scanned: ScannedEntry[] = [];

  for (const mode of Object.keys(navigationHomePathByMode) as NavigationMode[]) {
    for (const section of getNavigationSections(mode)) {
      for (const item of section.items) {
        scanned.push({ entry: item as GatedEntry, where: `${mode} rail · ${section.label}` });
      }
    }
  }

  for (const group of hubPageItemGroups) {
    for (const item of group.items) {
      if (item.href && overriddenHrefs.has(item.href)) continue;
      scanned.push({ entry: item as GatedEntry, where: `${group.label} hub` });
    }
  }

  return scanned;
}

/** Group entries by the IDENTITY of their `roles` array — see the header on why identity, not contents. */
function groupByRolesListIdentity(
  scanned: readonly ScannedEntry[],
): Map<readonly PhoenixRole[], ScannedEntry[]> {
  const groups = new Map<readonly PhoenixRole[], ScannedEntry[]>();
  for (const entry of scanned) {
    const roles = entry.entry.roles;
    if (!roles?.length || !entry.entry.permissions?.length) continue;
    const existing = groups.get(roles);
    if (existing) existing.push(entry);
    else groups.set(roles, [entry]);
  }
  return groups;
}

function describePermission(permission: NavigationPermission): string {
  return `${permission.resource}:${permission.action ?? "read"}`;
}

type DeadName = { href: string; report: string; role: PhoenixRole };

/**
 * Names that earn their place on NO consumer of their own list.
 *
 * The permission question is answered by calling `permissionAllowed` — the production function —
 * rather than re-deriving it. The rule has two edges a reimplementation gets wrong, and both were
 * nearly got wrong while writing this: an omitted `action` means "read", and a list of permissions
 * is satisfied by ANY one of them (`.some`, not `.every`). A test carrying its own subtly different
 * copy of the rule it polices is worse than no test — it reports confidently against a rule the
 * product does not use.
 */
function deadNames(scanned: readonly ScannedEntry[]): DeadName[] {
  const dead: DeadName[] = [];
  for (const [roles, uses] of groupByRolesListIdentity(scanned)) {
    for (const role of roles) {
      const lookup = buildPermissionLookup(permissionMatrix, role);
      if (uses.some((use) => permissionAllowed(lookup, use.entry.permissions))) continue;
      const first = uses[0]!;
      dead.push({
        href: first.entry.href ?? "no href",
        report:
          `${role} is named on a list used by ${uses.length} ` +
          `entr${uses.length === 1 ? "y" : "ies"}, and holds the permission on none of them: ` +
          uses
            .map(
              (use) =>
                `${use.where} · ${use.entry.label ?? "(unlabelled)"} (${use.entry.href}) wants ` +
                `${(use.entry.permissions ?? []).map(describePermission).join(" / ")}`,
            )
            .join("; "),
        role,
      });
    }
  }
  return dead;
}

export async function runNavRolesNameOnlyPermissionHoldersTests(): Promise<void> {
  // Which hub cards their own page decides for itself — see the header. Pinned EXACTLY, in both
  // directions. Growing the set silently would let a page opt any card out of this guard by adding
  // one line; shrinking it means an override was removed and some card's `permissions:` field is
  // now load-bearing again, which is precisely when its `roles:` list needs re-checking.
  const overrides = hubCardsOverriddenByTheirPage();
  assert.deepEqual(
    [...overrides.keys()].sort(),
    ["/attendance/fingerprint-report"],
    `the set of hub cards whose visibility their own page overrides has changed — found ` +
      `${[...overrides.entries()].map(([href, file]) => `${href} (${file})`).join(", ") || "none"}. ` +
      `Such a card's permissions: field does not govern who sees it, so this guard must skip it; ` +
      `an unreviewed change here either exempts a card that should be checked or resumes judging ` +
      `one that should not be. Confirm the new override is intended, then update this list.`,
  );

  const scanned = scanNavigationEntries(new Set(overrides.keys()));

  // Anti-vacuity. Every number was measured on 2026-08-29; the floors sit well under the real
  // values so ordinary growth never trips them, but a walk that silently stops finding entries —
  // a renamed export, a restructured hub, a mode list that resolves empty — collapses this into a
  // test that passes by checking nothing. Which is how a guard becomes decoration.
  assert.ok(
    scanned.length >= 250,
    `expected the real navigation surface, scanned ${scanned.length} entries (measured 300 on ` +
      `2026-08-29, being 301 less the one page-overridden card excluded above) — a collapsed walk ` +
      `must fail here rather than pass by having nothing to check`,
  );

  const groups = groupByRolesListIdentity(scanned);
  assert.ok(
    groups.size >= 100,
    `only ${groups.size} DISTINCT roles lists carry both roles and permissions (measured 108 ` +
      `lists holding 123 entries on 2026-08-29) — those are the only entries that can show this ` +
      `defect, so a low count means the scan broke rather than that the config got cleaner`,
  );

  assert.equal(
    phoenixRoles.length,
    // 18 since 2026-10-08: HR Resourcing, the Talent Acquisition seat. 19 since 2026-10-20: HR
    // Administration, the HR Operations Specialist seat.
    19,
    `expected 19 roles; got ${phoenixRoles.length}. If a role was genuinely added or retired, ` +
      `update this number — it is here so a truncated role list cannot quietly shrink the sweep`,
  );

  // The identity assumption, asserted rather than trusted — and asserted about the SPECIFIC list
  // the exemption rests on, not about sharing in general. hrAuthorityNavigationRoles reaches 11
  // consumers as ONE object; if a refactor ever clones these arrays that drops to 1, the rule
  // silently degrades to the naive per-entry one, and eight deliberate names start failing with a
  // message that sends the reader after entirely the wrong thing.
  //
  // A generic "some list is shared by >= N entries" floor does NOT catch that, which was measured
  // rather than reasoned: cloning every `roles: hrAuthorityNavigationRoles` still left the
  // 5-consumer ["Super Admin"] list standing, so a >= 5 floor passed while the mechanism was
  // broken. Identify the list by its contents and check ITS sharing.
  const hrAuthorityList = [...groups.entries()]
    // Identified by HR Operations + HR Resourcing since 2026-10-08, when HR Advisory left the list
    // with its retired seat and the Talent Acquisition seat took its place.
    .filter(([roles]) => roles.includes("HR Operations") && roles.includes("HR Resourcing"))
    .sort((a, b) => b[1].length - a[1].length)[0];
  assert.ok(
    hrAuthorityList && hrAuthorityList[1].length >= 8,
    `the shared HR-authority roles list reaches only ${hrAuthorityList?.[1].length ?? 0} entries ` +
      `(measured 11 on 2026-08-29). Shared lists are grouped by ARRAY IDENTITY, so a collapse here ` +
      `means those arrays are being cloned somewhere between the config and this test — fix the ` +
      `cloning rather than this number, or the rule silently becomes a stricter one nobody chose. ` +
      `Note more than one list carries both HR roles (an inlined copy sits on ` +
      `/workspace/leave-management/vacation-request), so this picks the most-shared one.`,
  );

  // Detector self-checks. Medical Rep holds no `vacancies` grant and DOES hold
  // `payroll: [read, export]` — both verified against the live matrix on 2026-08-29, rather than
  // assumed, because an assumed-unheld permission that turns out to be held makes the positive
  // check vacuous while still passing.
  const inertRoles: readonly PhoenixRole[] = ["Medical Rep"];
  const syntheticInert: ScannedEntry = {
    entry: {
      href: "/synthetic",
      label: "Synthetic",
      permissions: [{ resource: "vacancies" }],
      roles: inertRoles,
    },
    where: "synthetic",
  };
  assert.equal(
    deadNames([syntheticInert]).length,
    1,
    "the detector failed to flag a role named beside a permission it does not hold — it cannot be " +
      "trusted against the real config until this passes",
  );

  const holderRoles: readonly PhoenixRole[] = ["Super Admin"];
  assert.equal(
    deadNames([{ entry: { ...syntheticInert.entry, roles: holderRoles }, where: "synthetic" }])
      .length,
    0,
    "the detector flagged a role that DOES hold the grant — a false positive here would make the " +
      "zero-tolerance rule unmaintainable, and an unmaintainable rule grows an allowlist",
  );

  // It must honour `.some`: a role holding EITHER listed permission is admitted. A copy of that
  // rule reading as ALL would invent findings against entries that work perfectly today.
  assert.equal(
    deadNames([
      {
        entry: {
          href: "/synthetic",
          label: "Synthetic",
          permissions: [{ resource: "vacancies" }, { resource: "payroll" }],
          roles: inertRoles,
        },
        where: "synthetic",
      },
    ]).length,
    0,
    "the detector flagged a role holding one of two listed permissions — permissionAllowed is an " +
      "ANY test, and a copy of it that reads as ALL would fail entries that work today",
  );

  // And the shared-list exemption itself: one list, two entries, a role that works on exactly one
  // of them. This is the hrAuthorityNavigationRoles shape in miniature, and a rule that flags it
  // is the naive rule wearing this one's name.
  const sharedList: readonly PhoenixRole[] = ["Medical Rep"];
  assert.equal(
    deadNames([
      {
        entry: { href: "/a", label: "A", permissions: [{ resource: "vacancies" }], roles: sharedList },
        where: "synthetic",
      },
      {
        entry: { href: "/b", label: "B", permissions: [{ resource: "payroll" }], roles: sharedList },
        where: "synthetic",
      },
    ]).length,
    0,
    "the detector flagged a role that earns its place on ANOTHER consumer of the same shared list " +
      "— that is the documented hrAuthorityNavigationRoles pattern and must not fail",
  );

  const backlogKeys = new Set(NAME_ONLY_BACKLOG.map((row) => `${row.role} @ ${row.href}`));
  const dead = deadNames(scanned);
  const unexpected = dead
    .filter((row) => !backlogKeys.has(`${row.role} @ ${row.href}`))
    .map((row) => row.report)
    .sort();

  assert.deepEqual(
    unexpected,
    [],
    `${unexpected.length} navigation entries name a role that holds the entry's permission on no ` +
      `consumer of its own roles list, so the name grants nothing anywhere:\n\n  ` +
      `${unexpected.join("\n  ")}\n\n` +
      `Two repairs, and which is right is a business question: grant the permission in ` +
      `defaultPermissionMatrix (making the name real), or drop the name (it was never doing ` +
      `anything). Check the destination page's OWN gate before choosing — if the page admits the ` +
      `role and only the nav refuses, dropping the name writes the worse state in permanently. ` +
      `Do not add a backlog row to go green.`,
  );

  // The backlog must shrink, never quietly rot. A row whose finding is gone is a repair someone
  // made without deleting the note, and a stale exemption is how the next real one hides.
  const stillDead = new Set(dead.map((row) => `${row.role} @ ${row.href}`));
  const resolved = [...backlogKeys].filter((key) => !stillDead.has(key)).sort();
  assert.deepEqual(
    resolved,
    [],
    `${resolved.length} backlog rows no longer describe a real finding:\n\n  ${resolved.join("\n  ")}\n\n` +
      `Someone repaired these and left the note behind. Delete the rows — a stale exemption is ` +
      `exactly where the next real dead name hides.`,
  );
}
