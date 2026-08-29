import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { getNavigationSections } from "../src/config/system-navigation.ts";
import { permissionAllowed } from "../src/lib/navigation/active-path.ts";
import {
  buildPermissionLookup,
  permissionActions,
  permissionMatrix,
  permissionResources,
  phoenixRoles,
  type NavigationMode,
  type PermissionAction,
  type PermissionResource,
} from "../src/lib/auth/permissions.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The navigation permission lookup is TOTAL, and nothing has grown a second
// copy of the loop that builds it.
//
// WHY THIS FILE EXISTS
//
// `permissionAllowed` (src/lib/navigation/active-path.ts) treats a key it has
// never seen as PERMITTED. That is deliberate and it is pinned in
// tests/navigation-active-path.test.ts — six render sites default the lookup to
// `{}`, so failing closed would turn "someone forgot the prop" from a full
// navigation rail into a blank one, on a live product, with no error to explain
// it. Flipping the boolean is the wrong fix.
//
// The right fix is to make the branch unreachable: if the lookup is TOTAL —
// every resource crossed with every action, `false` where the matrix does not
// grant it — then no key is ever missing and the fail-open can never fire.
//
// That property held only by convention. Twenty-one files across app/ and src/
// each hand-wrote the same six-line double loop, and three comment blocks in
// permissions.ts warn future editors that omitting a resource from the runtime
// array "leaks the tab to every role". Those comments are correct and the hole
// is closed today — but nothing was testing that it stays closed, and a comment
// is not a check. The resources those comments guard are Mailbox Monitor,
// Clearance and the Retention Register, which holds what people said in
// confidence about their manager and their pay.
//
// So this file asserts the property directly, in five parts:
//
//   1. The `PermissionResource` / `PermissionAction` unions and their runtime
//      arrays are SET-EQUAL. A resource in the union but not the array is
//      exactly the leak those three comments describe.
//   2. `buildPermissionLookup` returns a total lookup for every role, and its
//      answers match the matrix exactly.
//   3. Every navigation permission names a resource and action inside that
//      vocabulary — so no nav entry can reach the fail-open branch.
//   4. No hand-rolled copy of the loop survives in app/ or src/, and every copy
//      remaining in tests/ is SEMANTICALLY IDENTICAL to the shared builder.
//   5. The fail-open branch is unreachable on both surfaces that render
//      navigation — proven from the two call sites, not asserted.
//
// WHAT THIS FILE DOES NOT DO
//
// It does not delete the fail-open branch, and it does not assert that the
// branch is dead code. The branch is reached only if some future render site
// passes a partial lookup; today none does, and part 5 pins the reason. Leaving
// a documented, tested-dead branch in place is cheaper than removing the last
// backstop under a live product's navigation on the strength of one `??`
// operator in one file.
//
// Measured 2026-08-29 on this branch: 17 roles, 47 resources, 7 actions, 329
// keys per role, 20 test-local copies, 0 production copies, 0 nav permissions
// naming anything out of vocabulary.
// ─────────────────────────────────────────────────────────────────────────────

const PERMISSIONS_SOURCE_PATH = "src/lib/auth/permissions.ts";
const NAVIGATION_SOURCE_PATH = "src/config/system-navigation.ts";
const HORIZONTAL_ROWS_PATH = "src/components/layout/horizontal-nav-rows.tsx";
const PORTAL_LAYOUT_PATH = "src/components/employee-portal/employee-portal-layout.tsx";
const APP_SHELL_PATH = "src/components/layout/app-shell.tsx";

// The one file allowed to contain the double loop: it IS the shared builder.
const BUILDER_HOME = "src/lib/auth/permissions.ts";

// And this file, which quotes the pattern verbatim in its own detector
// self-check. Skipped by exact path rather than by a rule that could also hide
// a real offender — a guard that stops seeing a whole directory is how these
// sweeps quietly become decorative.
const GUARD_HOME = "tests/permission-lookup-totality.test.ts";

// Two-sided ratchet on the copies that remain inside tests/. They are not
// migrated in this change on purpose — see the note above part 4 — but they are
// held at their exact count AND checked for semantic drift, so a 21st copy or a
// copy that starts answering differently both fail here.
const TEST_LOCAL_COPY_BASELINE = 20;

// Anti-vacuity floors. Every sweep below runs over a set it discovers at
// runtime, so a rename that empties the set would otherwise make this whole
// file pass on zero matches. Each floor is comfortably under the measured
// value, so ordinary growth never trips it.
const MIN_ROLES = 15; // measured 17
const MIN_RESOURCES = 40; // measured 47
const MIN_ACTIONS = 7; // measured 7
const MIN_SOURCE_FILES = 1000; // measured 2915 .ts/.tsx under app/ + src/
const MIN_BUILDER_IMPORTERS = 20; // measured 21 (20 call sites + the definition)
const MIN_NAV_PERMISSION_OBJECTS = 120; // measured 143 across the three modes
const MIN_NAV_RESOURCE_LITERALS = 200; // measured 266 in system-navigation.ts
const MIN_NAV_ACTION_LITERALS = 100; // measured 125 in system-navigation.ts

const NAVIGATION_MODES: readonly NavigationMode[] = ["admin", "employee-portal", "hr"];

// ── source helpers ───────────────────────────────────────────────────────────

/**
 * Blank out `//` line comments, length-preserving is not needed here — this is
 * only ever applied to a slice of a union declaration, whose comments carry
 * prose that would otherwise be mistaken for union members.
 */
function stripLineComments(source: string): string {
  return source.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Read the string members of a union type declaration, between its `=` and the
 * next top-level `export` that follows it. Anchoring on the next `export`
 * rather than on the terminating `;` matters: the union bodies here carry
 * multi-sentence comments, and a `;` inside one of those would truncate the
 * parse silently — a shorter list that still looks like a valid answer.
 */
function readUnionMembers(source: string, unionName: string, nextExportAnchor: string): string[] {
  const start = source.indexOf(`export type ${unionName} =`);
  assert.ok(start >= 0, `could not find "export type ${unionName} =" in ${PERMISSIONS_SOURCE_PATH}`);
  const end = source.indexOf(nextExportAnchor, start);
  assert.ok(
    end > start,
    `could not find the anchor "${nextExportAnchor}" after "export type ${unionName}" in ${PERMISSIONS_SOURCE_PATH} — ` +
      "the union parser has lost its footing and would report a short list rather than fail",
  );
  const body = stripLineComments(source.slice(start, end));
  return [...body.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
}

/**
 * Walk a directory for .ts/.tsx, skipping the folders that make a naive walk on
 * this checkout unusable: sibling worktrees hold ~1.9M gitignored paths between
 * them, and a walk that wanders into one takes minutes rather than seconds.
 */
function walkSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".") || entry.name.startsWith("_wt-")) continue;
      walkSources(path.posix.join(dir, entry.name), out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(path.posix.join(dir, entry.name));
    }
  }
  return out;
}

function listSourceFiles(): string[] {
  return [...walkSources("app"), ...walkSources("src")];
}

function listTestFiles(): string[] {
  return readdirSync("tests")
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => `tests/${name}`);
}

// The anti-pattern: a hand-rolled iteration over the resource vocabulary,
// which in every observed case is the outer half of the lookup-building double
// loop. Anchored on `permissionResources` specifically, so an unrelated loop
// over some other array is not swept up.
const HAND_ROLLED_LOOP = /for\s*\(\s*const\s+\w+\s+of\s+permissionResources\s*\)/;

/**
 * Reduce one hand-rolled copy's assignment expression to a canonical form, so
 * copies that are spelled differently but MEAN the same thing compare equal —
 * and one that means something else does not.
 *
 * The five spellings in the tree today differ only in how they reach the role's
 * permission bag (`permissionMatrix[role]`, `permissionMatrix.CEO`, or a local
 * `rolePermissions` binding) and in where they put optional chaining. All five
 * reduce to the same tail.
 */
const ACCEPTED_MATRIX_HEADS = [
  /^permissionMatrix\[[^\]]+\]/,
  /^permissionMatrix\.\w+/,
  /^rolePermissions/,
];

const CANONICAL_TAIL = "[resource].includes(action)??false";

function canonicaliseCopy(rhs: string): string | null {
  let text = rhs.replace(/\s+/g, "");
  const head = ACCEPTED_MATRIX_HEADS.find((pattern) => pattern.test(text));
  if (!head) return null;
  text = text.replace(head, "");
  text = text.replace(/\?\./g, ".");
  text = text.replace(/^\.\[/, "[");
  return text;
}

function extractCopyExpression(source: string): string | null {
  const loopAt = source.search(HAND_ROLLED_LOOP);
  if (loopAt < 0) return null;
  const assignment = /lookup\[[^\]]*\]\s*=\s*([\s\S]*?);/.exec(source.slice(loopAt));
  return assignment ? assignment[1] : null;
}

// ── the test ─────────────────────────────────────────────────────────────────

export function runPermissionLookupTotalityTests() {
  const permissionsSource = readFileSync(PERMISSIONS_SOURCE_PATH, "utf8");
  const navigationSource = readFileSync(NAVIGATION_SOURCE_PATH, "utf8");

  // ── 0 · detector self-checks ───────────────────────────────────────────────
  // Everything below sweeps sets discovered at runtime. Prove the two detectors
  // actually discriminate before trusting either across ~2,900 files.
  assert.ok(
    HAND_ROLLED_LOOP.test("  for (const resource of permissionResources) {"),
    "the hand-rolled-loop detector does not match the very pattern it exists to find",
  );
  assert.ok(
    !HAND_ROLLED_LOOP.test("for (const resource of someOtherArray) {"),
    "the hand-rolled-loop detector matches an unrelated loop — it would report false offenders",
  );
  assert.equal(
    canonicaliseCopy("permissionMatrix[role]?.[resource]?.includes(action) ?? false"),
    CANONICAL_TAIL,
    "the copy canonicaliser does not reduce the commonest spelling to the canonical tail",
  );
  assert.equal(
    canonicaliseCopy("rolePermissions[resource]?.includes(action) ?? false"),
    CANONICAL_TAIL,
    "the copy canonicaliser does not reduce the local-binding spelling to the canonical tail",
  );
  assert.notEqual(
    canonicaliseCopy("permissionMatrix[role]?.[resource]?.includes(action) ?? true"),
    CANONICAL_TAIL,
    "the copy canonicaliser accepts a fail-OPEN default as equivalent — it cannot detect drift",
  );
  assert.equal(
    canonicaliseCopy("somethingElse[resource]?.includes(action) ?? false"),
    null,
    "the copy canonicaliser accepts an unrecognised source of truth as a matrix read",
  );

  // ── 1 · the union and the runtime array are set-equal ───────────────────────
  // This is the assertion the three comment blocks in permissions.ts ask for. A
  // resource declared in the union but missing from the runtime array produces
  // a lookup with a hole in it, and `permissionAllowed` shows the link.
  const unionResources = readUnionMembers(
    permissionsSource,
    "PermissionResource",
    "export const permissionResources",
  );
  const unionActions = readUnionMembers(permissionsSource, "PermissionAction", "export type PermissionResource");

  assert.ok(
    unionResources.length >= MIN_RESOURCES,
    `parsed only ${unionResources.length} members out of the PermissionResource union — expected at least ` +
      `${MIN_RESOURCES}. The parser has lost its footing; do not trust the comparison below.`,
  );
  assert.ok(
    unionActions.length >= MIN_ACTIONS,
    `parsed only ${unionActions.length} members out of the PermissionAction union — expected at least ${MIN_ACTIONS}`,
  );

  const runtimeResources = new Set<string>(permissionResources);
  const declaredResources = new Set(unionResources);
  const missingFromRuntime = [...declaredResources].filter((name) => !runtimeResources.has(name));
  const missingFromUnion = [...runtimeResources].filter((name) => !declaredResources.has(name));

  assert.deepEqual(
    missingFromRuntime,
    [],
    "these resources are declared in the PermissionResource union but ABSENT from the runtime " +
      "`permissionResources` array, so buildPermissionLookup never emits a key for them. The navigation " +
      "permission lookup FAILS OPEN on a key it has never seen, which means every one of these is offered " +
      `to every role in the company, silently: ${missingFromRuntime.join(", ")}`,
  );
  assert.deepEqual(
    missingFromUnion,
    [],
    "these entries are in the runtime `permissionResources` array but not in the PermissionResource union, " +
      `so they cannot be a valid key anywhere: ${missingFromUnion.join(", ")}`,
  );
  assert.equal(
    new Set(permissionResources).size,
    permissionResources.length,
    "the runtime `permissionResources` array contains a duplicate",
  );

  const runtimeActions = new Set<string>(permissionActions);
  const declaredActions = new Set(unionActions);
  assert.deepEqual(
    [...declaredActions].filter((name) => !runtimeActions.has(name)),
    [],
    "an action is declared in the PermissionAction union but missing from the runtime `permissionActions` array",
  );
  assert.deepEqual(
    [...runtimeActions].filter((name) => !declaredActions.has(name)),
    [],
    "an entry in the runtime `permissionActions` array is not a member of the PermissionAction union",
  );

  // ── 2 · buildPermissionLookup returns a TOTAL lookup for every role ─────────
  assert.ok(
    phoenixRoles.length >= MIN_ROLES,
    `expected at least ${MIN_ROLES} roles, found ${phoenixRoles.length} — the sweep below would prove nothing`,
  );

  const expectedKeyCount = permissionResources.length * permissionActions.length;
  let anyGranted = 0;
  let anyDenied = 0;

  for (const role of phoenixRoles) {
    const lookup = buildPermissionLookup(permissionMatrix, role);
    const keys = Object.keys(lookup);

    assert.equal(
      keys.length,
      expectedKeyCount,
      `buildPermissionLookup("${role}") returned ${keys.length} keys, expected ${expectedKeyCount} ` +
        `(${permissionResources.length} resources x ${permissionActions.length} actions). A lookup with holes ` +
        "in it is exactly what the navigation fail-open branch turns into visible links.",
    );

    for (const resource of permissionResources) {
      for (const action of permissionActions) {
        const key: `${PermissionResource}:${PermissionAction}` = `${resource}:${action}`;
        const value = lookup[key];
        assert.equal(
          typeof value,
          "boolean",
          `buildPermissionLookup("${role}")["${key}"] is ${String(value)}, not a boolean. Any non-boolean — ` +
            "`undefined` above all — makes permissionAllowed fall through to its permit-by-default branch.",
        );
        const expected = permissionMatrix[role]?.[resource]?.includes(action) ?? false;
        assert.equal(
          value,
          expected,
          `buildPermissionLookup("${role}")["${key}"] answered ${String(value)} but the permission matrix says ` +
            `${String(expected)}`,
        );
        if (value) anyGranted += 1;
        else anyDenied += 1;
      }
    }
  }

  // Non-degeneracy: a builder that returned all-false, or all-true, would pass
  // every assertion above and be useless.
  assert.ok(anyGranted > 0, "no role holds any permission at all — the matrix or the builder is degenerate");
  assert.ok(anyDenied > 0, "every role holds every permission — the builder is not reading the matrix");

  // ── 3 · every navigation permission is inside that vocabulary ───────────────
  // Two passes on purpose. The runtime walk proves what `getSections` actually
  // gates; the source scan catches permission objects that live in structures
  // `getNavigationSections` does not return (hub cards among them) — measured
  // 143 through the walk against 266 resource literals in the file.
  let navPermissionObjects = 0;
  const badNavResources: string[] = [];
  const badNavActions: string[] = [];

  for (const mode of NAVIGATION_MODES) {
    for (const section of getNavigationSections(mode)) {
      for (const item of section.items) {
        for (const permission of item.permissions ?? []) {
          navPermissionObjects += 1;
          const action: PermissionAction = permission.action ?? "read";
          if (!runtimeResources.has(permission.resource)) {
            badNavResources.push(`${mode} · ${section.id} · ${item.href} → "${permission.resource}"`);
          }
          if (!runtimeActions.has(action)) {
            badNavActions.push(`${mode} · ${section.id} · ${item.href} → "${action}"`);
          }
        }
      }
    }
  }

  assert.ok(
    navPermissionObjects >= MIN_NAV_PERMISSION_OBJECTS,
    `walked only ${navPermissionObjects} navigation permission objects across ${NAVIGATION_MODES.length} modes, ` +
      `expected at least ${MIN_NAV_PERMISSION_OBJECTS} — the walk found nothing to check`,
  );
  assert.deepEqual(
    badNavResources,
    [],
    "these navigation entries name a resource that is not in the runtime vocabulary, so their lookup key is " +
      "never built and the fail-open branch offers them to everyone:\n" + badNavResources.join("\n"),
  );
  assert.deepEqual(
    badNavActions,
    [],
    "these navigation entries name an action that is not in the runtime vocabulary:\n" + badNavActions.join("\n"),
  );

  const navResourceLiterals = [...navigationSource.matchAll(/resource:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  const navActionLiterals = [...navigationSource.matchAll(/action:\s*"([a-z_]+)"/g)].map((m) => m[1]);

  assert.ok(
    navResourceLiterals.length >= MIN_NAV_RESOURCE_LITERALS,
    `found only ${navResourceLiterals.length} \`resource: "…"\` literals in ${NAVIGATION_SOURCE_PATH}, expected at ` +
      `least ${MIN_NAV_RESOURCE_LITERALS} — the source scan has stopped seeing the config`,
  );
  assert.ok(
    navActionLiterals.length >= MIN_NAV_ACTION_LITERALS,
    `found only ${navActionLiterals.length} \`action: "…"\` literals in ${NAVIGATION_SOURCE_PATH}, expected at ` +
      `least ${MIN_NAV_ACTION_LITERALS}`,
  );
  assert.deepEqual(
    [...new Set(navResourceLiterals)].filter((name) => !runtimeResources.has(name)),
    [],
    `a \`resource: "…"\` literal in ${NAVIGATION_SOURCE_PATH} is not in the runtime permission vocabulary`,
  );
  assert.deepEqual(
    [...new Set(navActionLiterals)].filter((name) => !runtimeActions.has(name)),
    [],
    `an \`action: "…"\` literal in ${NAVIGATION_SOURCE_PATH} is not in the runtime permission vocabulary`,
  );

  // ── 4 · no copy has grown back, and no copy has drifted ────────────────────
  const sourceFiles = listSourceFiles();
  assert.ok(
    sourceFiles.length >= MIN_SOURCE_FILES,
    `swept only ${sourceFiles.length} .ts/.tsx files under app/ and src/, expected at least ${MIN_SOURCE_FILES} — ` +
      "the file listing is broken and this sweep proves nothing",
  );

  const productionCopies: string[] = [];
  let builderImporters = 0;
  for (const file of sourceFiles) {
    const source = readFileSync(file, "utf8");
    if (source.includes("buildPermissionLookup")) builderImporters += 1;
    if (file === BUILDER_HOME) continue;
    if (HAND_ROLLED_LOOP.test(source)) productionCopies.push(file);
  }

  assert.ok(
    builderImporters >= MIN_BUILDER_IMPORTERS,
    `only ${builderImporters} files under app/ and src/ reference buildPermissionLookup, expected at least ` +
      `${MIN_BUILDER_IMPORTERS}. Either the shared builder has been abandoned or this sweep is looking in the ` +
      "wrong place — both make the zero-tolerance assertion below meaningless.",
  );
  assert.deepEqual(
    productionCopies,
    [],
    "these files build a navigation permission lookup with their own copy of the double loop instead of calling " +
      `buildPermissionLookup from ${BUILDER_HOME}. Twenty-one such copies existed before this guard; they were all ` +
      "correct, which was the problem — nothing forced them to stay that way, and a copy that omits a resource " +
      "hands that resource's links to every role. Call the shared builder:\n" + productionCopies.join("\n"),
  );

  const testCopies: string[] = [];
  const driftedCopies: string[] = [];
  for (const file of listTestFiles()) {
    if (file === GUARD_HOME) continue;
    const source = readFileSync(file, "utf8");
    if (!HAND_ROLLED_LOOP.test(source)) continue;
    testCopies.push(file);
    const expression = extractCopyExpression(source);
    if (expression === null) {
      driftedCopies.push(`${file} — could not read the assignment expression`);
      continue;
    }
    const canonical = canonicaliseCopy(expression);
    if (canonical !== CANONICAL_TAIL) {
      driftedCopies.push(`${file} — reduces to ${canonical ?? "an unrecognised shape"}, expected ${CANONICAL_TAIL}`);
    }
    if (/rolePermissions/.test(expression)) {
      assert.ok(
        /rolePermissions\s*=\s*permissionMatrix/.test(source),
        `${file} builds its lookup from a local \`rolePermissions\` binding that does not come from permissionMatrix`,
      );
    }
  }

  assert.deepEqual(
    driftedCopies,
    [],
    "these test-local copies of the lookup loop no longer answer the same question as the shared builder. A test " +
      "asserting against a lookup that production never produces is worse than no test:\n" + driftedCopies.join("\n"),
  );
  assert.ok(
    testCopies.length <= TEST_LOCAL_COPY_BASELINE,
    `${testCopies.length} test files still build the lookup by hand, up from the ${TEST_LOCAL_COPY_BASELINE} that ` +
      "existed when this guard was written. Call buildPermissionLookup(permissionMatrix, role) instead — the " +
      `newcomers are:\n${testCopies.join("\n")}`,
  );
  assert.ok(
    testCopies.length >= TEST_LOCAL_COPY_BASELINE,
    `only ${testCopies.length} test files still build the lookup by hand, down from ${TEST_LOCAL_COPY_BASELINE}. ` +
      "That is good news and this baseline should be lowered to match in the same commit that removed them — " +
      "leaving it high lets a copy come back unnoticed.",
  );

  // ── 5 · the fail-open branch is unreachable on both rendering surfaces ──────
  // With a total lookup, permissionAllowed's undefined-key branch cannot fire.
  // Prove it rather than assume it: every key of every role, both directions.
  const sampleRole = phoenixRoles[0];
  const totalLookup = buildPermissionLookup(permissionMatrix, sampleRole);
  for (const resource of permissionResources) {
    for (const action of permissionActions) {
      const key: `${PermissionResource}:${PermissionAction}` = `${resource}:${action}`;
      assert.equal(
        permissionAllowed(totalLookup, [{ action, resource }]),
        totalLookup[key],
        `permissionAllowed disagreed with the total lookup on ${key} for "${sampleRole}" — the only way that ` +
          "happens is the permit-by-default branch firing on a key that should exist",
      );
    }
  }
  // The branch itself is still there, and still permits. Kept deliberately: six
  // render sites default the lookup to `{}`, so failing closed would blank the
  // rail rather than fail loudly. This asserts the CURRENT behaviour so that
  // changing it is a decision someone makes on purpose.
  assert.equal(
    permissionAllowed({}, [{ resource: "sales" }]),
    true,
    "permissionAllowed no longer permits an unknown key. That may well be right, but six render sites default the " +
      "lookup to {} — check every one of them before landing it, and update tests/navigation-active-path.test.ts",
  );

  // The employee portal is the one surface that renders navigation without a
  // permission lookup, and this is why that is safe: it hands in ALREADY-GATED
  // sections, and the `sections ??` short-circuit means getSections — and so
  // permissionAllowed — is never reached. If that `??` goes, the portal starts
  // gating a config it does not use against an empty lookup.
  const rowsSource = readFileSync(HORIZONTAL_ROWS_PATH, "utf8");
  assert.ok(
    /const\s+gated\s*=\s*\n?\s*sections\s*\?\?/.test(rowsSource),
    `${HORIZONTAL_ROWS_PATH} no longer short-circuits on a caller-supplied \`sections\` list. That short-circuit is ` +
      "the entire reason the employee portal can render navigation without a permission lookup; without it the " +
      "portal gates against `permissionLookup = {}` and every permission-gated entry falls through the " +
      "permit-by-default branch.",
  );

  const portalSource = readFileSync(PORTAL_LAYOUT_PATH, "utf8");
  const portalMount = /<HorizontalNavProvider([\s\S]*?)>/.exec(portalSource);
  assert.ok(portalMount, `${PORTAL_LAYOUT_PATH} no longer mounts HorizontalNavProvider`);
  assert.ok(
    /\bsections=/.test(portalMount[1]),
    `${PORTAL_LAYOUT_PATH} mounts HorizontalNavProvider without \`sections\`, so it now falls through to getSections ` +
      "with no permission lookup — every gated entry would be permitted by default",
  );
  assert.ok(
    !/\bpermissionLookup=/.test(portalMount[1]),
    `${PORTAL_LAYOUT_PATH} now passes a permissionLookup as well as \`sections\`. That is not unsafe, but the ` +
      "reasoning pinned here no longer describes the code — re-read this block before deleting the assertion.",
  );

  const shellSource = readFileSync(APP_SHELL_PATH, "utf8");
  assert.ok(
    /buildPermissionLookup\(matrix,\s*access\.role\)/.test(shellSource),
    `${APP_SHELL_PATH} no longer builds its permission lookup with the shared builder. It is the admin shell — ` +
      "every admin and HR page renders through it, so a partial lookup here reaches the whole product.",
  );
  const shellMount = /<HorizontalNavProvider([\s\S]*?)>/.exec(shellSource);
  assert.ok(shellMount, `${APP_SHELL_PATH} no longer mounts HorizontalNavProvider`);
  assert.ok(
    /\bpermissionLookup=/.test(shellMount[1]),
    `${APP_SHELL_PATH} mounts HorizontalNavProvider without a permissionLookup, so the admin rail would be gated ` +
      "against an empty lookup and show every permission-gated entry to every role",
  );
}
