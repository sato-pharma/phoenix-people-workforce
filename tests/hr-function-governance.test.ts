import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  composeHrRoleGrants,
  getHrFunction,
  HR_FUNCTIONS,
  HR_ROLE_BOUNDARIES,
  HR_ROLE_BUNDLES,
  type HrBundleName,
  type HrFunctionKey,
} from "../src/lib/auth/hr-functions.ts";
import {
  canAccess,
  normalizeRole,
  permissionMatrix,
  phoenixCompanyJobTitles,
  phoenixRoles,
  scopeForRole,
  type AccessContext,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";

/**
 * HR FUNCTION GOVERNANCE
 *
 * Two mistakes are pinned here, and both have already been made in this repository.
 *
 * The FIRST is naming a permission role after whoever currently holds the job. "HR Specialist"
 * was retired in 2026-06 and "Talent Acquisition" on 2026-08-28, and each retirement cost a
 * rename across the codebase plus a multi-table migration, because a job title is a fact about a
 * person and a permission key is a fact about a capability. The owner named this explicitly on
 * 2026-08-28 as the second time the same mistake had been made. Rule 1 below is that instruction
 * made mechanical, so the third time turns a PR red instead of costing a day.
 *
 * The SECOND is a role quietly growing past what its job description says it may do. A permission
 * matrix records what a role HAS; drift lives in what nobody noticed it GAINED. Both job
 * descriptions end with a "Role Boundaries & Approval Authority" section, and HR_ROLE_BOUNDARIES
 * turns those lines into resource:action pairs that must stay ABSENT. Rule 4 asserts them against
 * the composed matrix, and rule 5 against each function on its own, so a boundary cannot be
 * breached either by widening a function or by adding it to a bundle it was never written for.
 */

/**
 * A role name that is ALSO a company job title. Each of these predates the rule and is left alone
 * deliberately: renaming a live sales role touches the organogram, the AU seat model, every stored
 * profile and years of historical records, for no security gain. The list is CLOSED and frozen at
 * 2026-08-28. It is not a precedent and nothing may be added to it, because a NEW collision is the
 * exact mistake this file exists to stop.
 */
const GRANDFATHERED_NAME_COLLISIONS: readonly string[] = [
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "SFE Manager",
  "Training Manager",
  "Marketing Manager",
  "Finance Manager",
  "Financial Advisor",
  "CEO",
];

/** Retired as permission roles. Neither may return as one, under any spelling. */
const RETIRED_HR_ROLE_NAMES: readonly string[] = ["HR Specialist", "Talent Acquisition"];

/**
 * Indent for a multi-line assertion message. Built from a char code on purpose: this file is
 * edited through shells that eat backslashes in a heredoc (AGENTS.md 2.1), and a swallowed
 * escape here turns join("<newline>") into a syntax error that takes the whole suite down
 * before a single test runs. A constant cannot be mangled that way.
 */
const BREACH_SEP = String.fromCharCode(10) + '  ';

export async function runHrFunctionGovernanceTests() {
  const bundleNames = Object.keys(HR_ROLE_BUNDLES) as HrBundleName[];

  // --- Rule 1: a permission role is never a job title ------------------------------------------
  for (const role of phoenixRoles) {
    if (GRANDFATHERED_NAME_COLLISIONS.includes(role)) continue;
    assert.ok(
      !(phoenixCompanyJobTitles as readonly string[]).includes(role),
      `"${role}" is BOTH a phoenixRoles member and a phoenixCompanyJobTitle. A permission key ` +
        "must describe a capability, not a seat, or it goes stale the day its holder leaves. " +
        "Name the role for what it lets someone DO and keep the job title in " +
        "phoenixCompanyJobTitles. Do not add it to GRANDFATHERED_NAME_COLLISIONS: that list is " +
        "closed at 2026-08-28.",
    );
  }
  // ...and the grandfather list must not rot into cover for a name that no longer collides.
  for (const name of GRANDFATHERED_NAME_COLLISIONS) {
    assert.ok(
      (phoenixRoles as readonly string[]).includes(name) &&
        (phoenixCompanyJobTitles as readonly string[]).includes(name),
      `"${name}" is grandfathered as a role/title collision but is no longer both. Remove it from ` +
        "GRANDFATHERED_NAME_COLLISIONS rather than leaving a stale exemption behind.",
    );
  }

  // --- Rule 2: the retired HR seats stay retired, and fail CLOSED ------------------------------
  for (const retired of RETIRED_HR_ROLE_NAMES) {
    assert.ok(
      !(phoenixRoles as readonly string[]).includes(retired),
      `"${retired}" is back in phoenixRoles. It is a job title; the access it carried lives in ` +
        "HR_ROLE_BUNDLES.",
    );
    // normalizeRole is what a stored profile and a stale JWT's app_metadata both pass through.
    // Resolving a retired seat to its SUCCESSOR reads as continuity and is really a privilege
    // carry-forward: production on 2026-08-28 held exactly one row still naming Talent
    // Acquisition, belonging to A-16, is_active false, employment_status resigned.
    assert.equal(
      normalizeRole(retired),
      "Employee",
      `"${retired}" must resolve DOWN to Employee, never sideways to an HR bundle`,
    );
    assert.equal(normalizeRole(retired.toLowerCase()), "Employee");
    assert.equal(normalizeRole(retired.replace(/[^A-Za-z]/g, "")), "Employee");
  }

  // --- Rule 3: every function is real, cited, and used -----------------------------------------
  const seenKeys = new Set<HrFunctionKey>();
  for (const fn of HR_FUNCTIONS) {
    assert.ok(!seenKeys.has(fn.key), `duplicate HR function key "${fn.key}"`);
    seenKeys.add(fn.key);
    assert.ok(fn.label.trim().length > 0, `${fn.key} has no label`);
    assert.ok(fn.summary.trim().length > 0, `${fn.key} has no summary`);
    // Every grant must trace to a line the owner signed off, not to a session's judgement.
    assert.ok(
      fn.jdSections.length > 0,
      `${fn.key} cites no job-description section. Every function must name where it came from, ` +
        "or the catalogue becomes a place to park a grant nobody asked for.",
    );
    for (const cite of fn.jdSections) {
      assert.ok(cite.trim().length > 0, `${fn.key} has an empty jdSections entry`);
    }
    assert.ok(
      Object.keys(fn.grants).length > 0,
      `${fn.key} grants nothing, which is a label pretending to be a capability`,
    );
    assert.equal(getHrFunction(fn.key).key, fn.key, `getHrFunction("${fn.key}") does not round-trip`);
  }

  // No orphans: a function held by no bundle is dead code that reads as live policy.
  const heldByABundle = new Set<HrFunctionKey>();
  for (const name of bundleNames) {
    for (const key of HR_ROLE_BUNDLES[name]) heldByABundle.add(key);
  }
  for (const fn of HR_FUNCTIONS) {
    assert.ok(
      heldByABundle.has(fn.key),
      `HR function "${fn.key}" is in no bundle. Either give it to a seat or delete it: an unheld ` +
        "function looks like policy and grants nothing.",
    );
  }
  // ...and the reverse, so a bundle cannot name a function that does not exist.
  assert.deepEqual(
    [...heldByABundle].sort(),
    HR_FUNCTIONS.map((fn) => fn.key).sort(),
    "the union of both bundles must be exactly the function catalogue: at the end of the day, " +
      "everything (owner, 2026-08-28)",
  );

  // --- Rule 4: no bundle breaches a job-description boundary -----------------------------------
  // Asserted against BOTH the composition and permissionMatrix, because they are not the same
  // object and only the second one governs access. permissions.ts runs applyHardPermissionBoundaries
  // over the composed matrix, and for `support_requests` that pass SETS the actions outright
  // (matrix[role][resource] = [...allowedActions]) rather than filtering them, so it is a path that
  // can WIDEN a grant after composition. Checking the catalogue alone would not see that.
  assert.ok(HR_ROLE_BOUNDARIES.length > 0, "the boundary list is empty, so the JD limits are unenforced");
  const breaches: string[] = [];
  for (const name of bundleNames) {
    const sources: [string, Record<string, string[] | undefined>][] = [
      ["composition", composeHrRoleGrants(HR_ROLE_BUNDLES[name]) as Record<string, string[] | undefined>],
      ["permissionMatrix", permissionMatrix[name as PhoenixRole] as Record<string, string[] | undefined>],
    ];
    for (const [where, grants] of sources) {
      for (const boundary of HR_ROLE_BOUNDARIES) {
        if (grants[boundary.resource]?.includes(boundary.action)) {
          breaches.push(`${name} holds ${boundary.resource}:${boundary.action} in ${where} (${boundary.why})`);
        }
      }
    }
  }
  assert.deepEqual(breaches, [], `HR role boundaries breached:
  ${breaches.join(BREACH_SEP)}`);

  // --- Rule 5: no INDIVIDUAL function can breach one either ------------------------------------
  // Rule 4 only sees the two bundles that exist today. The owner's design is that bundles get
  // recomposed, so a function carrying a forbidden pair is a landmine for the next composition.
  const functionBreaches: string[] = [];
  for (const fn of HR_FUNCTIONS) {
    const grants = fn.grants as Record<string, string[] | undefined>;
    for (const boundary of HR_ROLE_BOUNDARIES) {
      if (grants[boundary.resource]?.includes(boundary.action)) {
        functionBreaches.push(`${fn.key} grants ${boundary.resource}:${boundary.action} (${boundary.why})`);
      }
    }
  }
  assert.deepEqual(
    functionBreaches,
    [],
    `an HR function breaches a boundary, so ANY bundle holding it would too:
  ${functionBreaches.join(BREACH_SEP)}`,
  );

  // --- Rule 6: the matrix is the composition NARROWED, never widened ---------------------------
  // If someone edits permissionMatrix directly, the catalogue stops describing reality while still
  // reading as though it does, and every assertion above would be testing a fiction. A plain
  // deepEqual cannot express this: applyHardPermissionBoundaries legitimately caps a composed
  // grant afterwards (HR Advisory composes employees read+export and is hard-capped to exactly
  // that; HR Operations is capped to read/create/update/export/import with delete withheld from
  // both). Narrowing is the safe direction and is allowed. WIDENING is what must never happen.
  const SET_NOT_FILTERED: readonly string[] = [
    // The one resource applyHardPermissionBoundaries assigns rather than intersects, so it is the
    // only place a post-composition grant can appear. Pinned below rather than waved through.
    "support_requests",
  ];
  for (const name of bundleNames) {
    assert.ok(
      (phoenixRoles as readonly string[]).includes(name),
      `bundle "${name}" is not a phoenixRoles member, so nothing can be assigned it`,
    );
    const composed = composeHrRoleGrants(HR_ROLE_BUNDLES[name]) as Record<string, string[] | undefined>;
    const live = permissionMatrix[name as PhoenixRole] as Record<string, string[] | undefined>;

    for (const [resource, actions] of Object.entries(live)) {
      if (SET_NOT_FILTERED.includes(resource)) continue;
      assert.ok(
        composed[resource],
        `permissionMatrix["${name}"] grants "${resource}", which no HR function contributes. A ` +
          "bundle may only be narrowed after composition, never given something new. Add it to a " +
          "function in hr-functions.ts so it traces to a job-description line.",
      );
      for (const action of actions ?? []) {
        assert.ok(
          composed[resource]?.includes(action),
          `permissionMatrix["${name}"].${resource} holds "${action}" but the composition does not. ` +
            "Something widened this after hr-functions.ts composed it.",
        );
      }
    }
    // ...and the one widening path, pinned explicitly so a second one cannot be added quietly.
    assert.deepEqual(
      live.support_requests?.slice().sort(),
      ["create", "export", "read", "update"],
      `${name} must hold the HR support-staff action set. This one resource is SET by ` +
        "applyHardPermissionBoundaries rather than filtered, so it is the only grant in the matrix " +
        "that hr-functions.ts does not fully control.",
    );
  }
  const permissionsSource = readFileSync("src/lib/auth/permissions.ts", "utf8");
  for (const name of bundleNames) {
    // A plain substring check, not a regex: the escapes in a RegExp built from a template
    // literal do not survive every editing path used on this repo, and a half-eaten pattern
    // does not throw - it silently stops matching and reads as a real failure.
    assert.ok(
      permissionsSource.includes(`"${name}": hrBundleGrants("${name}")`),
      `permissions.ts must build "${name}" via hrBundleGrants, so the job description stays ` +
        "the source of truth rather than a hand-maintained matrix block.",
    );
  }

  // --- Rule 7: both seats keep a self-service floor ---------------------------------------------
  // Composing a role purely from HR functions produced a seat that could administer everyone
  // else's leave and payslip and not reach her own. /payslips throws an uncaught Forbidden rather
  // than rendering an empty state, so this is a broken page, not a missing convenience.
  for (const name of bundleNames) {
    const grants = permissionMatrix[name as PhoenixRole] as Record<string, string[] | undefined>;
    assert.ok(grants.payslips?.includes("read"), `${name} cannot open her own payslip`);
    assert.ok(grants.leave?.includes("create"), `${name} cannot request her own vacation`);
    assert.ok(grants.employee_profile?.includes("read"), `${name} cannot open her own profile`);
    assert.ok(grants.overview?.includes("read"), `${name} has no landing page`);
    assert.ok(grants.report_it?.includes("create"), `${name} cannot report a problem`);
  }

  // --- Rule 8: the split is real ----------------------------------------------------------------
  // The owner's correction on 2026-08-28: the business partner is not only recruiting, and the two
  // seats are different subsets of one catalogue. If a future change collapses them back into a
  // single role holding everything, the catalogue still type-checks and this is what refuses.
  assert.ok(bundleNames.length >= 2, "there must be at least two bundles, or this is one role again");
  for (const name of bundleNames) {
    const held = new Set<HrFunctionKey>(HR_ROLE_BUNDLES[name]);
    assert.ok(
      held.size < HR_FUNCTIONS.length,
      `"${name}" holds every function in the catalogue, which makes it the monolithic HR role the ` +
        "function split exists to replace",
    );
    assert.ok(held.size > 0, `"${name}" holds no functions`);
  }
  const [first, ...rest] = bundleNames;
  for (const other of rest) {
    const a = [...HR_ROLE_BUNDLES[first]].sort();
    const b = [...HR_ROLE_BUNDLES[other]].sort();
    assert.notDeepEqual(a, b, `"${first}" and "${other}" hold identical functions`);
  }

  // --- Rule 9: every boundary is REFUSED BY THE GATE, not merely absent from a table -------------
  // Rules 4 and 5 read the grants. This one asks canAccess — the function the route handlers and
  // the page gates actually call — because a matrix entry is not the last word on access. canAccess
  // short-circuits to true on `context.scope === "system"` before it consults any matrix, and it
  // merges role_permission_overrides from the database on top of the composed one. Both seats
  // resolve to scope "self" today, which is why the boundaries hold; that is a fact worth asserting
  // rather than a note worth trusting, since scopeForRole falls through to a default and a future
  // seat added to the wrong branch would open all 17 at once with no grant having changed.
  const refusalFailures: string[] = [];
  for (const name of bundleNames) {
    const role = name as PhoenixRole;
    const access = {
      role,
      scope: scopeForRole(role),
      hrId: "HR-BOUNDARY-TEST",
      source: "session",
    } as AccessContext;

    assert.notEqual(
      access.scope,
      "system",
      `"${name}" resolves to scope "system", and canAccess returns true for that before it reads ` +
        "any matrix — every job-description boundary below is open, whatever the grants say",
    );

    for (const boundary of HR_ROLE_BOUNDARIES) {
      if (await canAccess(access, boundary.resource, boundary.action)) {
        refusalFailures.push(
          `${name}: canAccess allows ${boundary.resource}:${boundary.action} — ${boundary.why}`,
        );
      }
    }

    // The control. Without it a canAccess that returned false for everything — a broken import, a
    // matrix that failed to load — would satisfy every assertion above by refusing the whole seat.
    assert.ok(
      await canAccess(access, "overview", "read"),
      `"${name}" is refused overview:read, so canAccess is refusing everything and the boundary ` +
        "checks above passed by accident rather than by boundary",
    );
  }
  assert.deepEqual(
    refusalFailures,
    [],
    `a job-description boundary is not actually refused at the gate:
  ${refusalFailures.join(BREACH_SEP)}`,
  );
}
