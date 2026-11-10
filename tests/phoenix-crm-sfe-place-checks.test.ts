import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * Place checks for the SFE Manager (owner, 2026-10-19: "show check place to sfe manager exactly as it
 * in the admin account to be able validate approve and refuse").
 *
 * The Super Admin was the only decider since 2026-10-03. The SFE Manager now sees the same page and
 * takes the same decisions — approve, refuse, restore, a polyclinic's approve and reject, the
 * same-place answer — and NOTHING else moves. The rulings this widening must leave alone are pinned
 * here beside it, because each is a one-line edit away from being widened by accident:
 *
 *   1. who the decider admits is a BEHAVIOUR, pinned by evaluating the predicate itself;
 *   2. the SFE Manager holds `phoenix_crm` read + approve and no `update`, so the seven decision routes
 *      are gated on `approve` — and he was not handed `update`, which would open every other `update`
 *      route in the module to him;
 *   3. seating a customer in a polyclinic (2026-10-10) and settling an integrity case (2026-10-09) stay
 *      the Super Admin's alone;
 *   4. the position cases and the phone's mock-location answer ARE in his evidence on this screen
 *      (2026-10-19, "show the mock-location evidence to the SFE Manager too") and stay out of the
 *      integrity board and the visit report (2026-10-02);
 *   5. the email, in-app and Telegram notice of a new hold is still the Super Admin's alone.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

/** `export (async )?function name(...) { ... }` — from its signature to the closing brace at column 0. */
function functionText(source: string, name: string): string {
  const match = new RegExp(`export (?:async )?function ${name}\\([\\s\\S]*?\\n\\}`).exec(source);
  assert.ok(match, `${name} is declared as an exported function — this test resolves it by that name`);
  return match[0];
}

type Viewer = {
  isSuperAdmin: boolean;
  isSfeManager: boolean;
  isTestPersona: boolean;
  canUpdate: boolean;
  canApprove: boolean;
};

const NOBODY: Viewer = { isSuperAdmin: false, isSfeManager: false, isTestPersona: false, canUpdate: false, canApprove: false };

/** A predicate from the source, evaluated: the behaviour is pinned, not the way it happens to be spelled. */
function predicate(source: string, name: string): (viewer: Viewer) => boolean {
  const text = functionText(source, name);
  const body = text.slice(text.indexOf("{", text.indexOf("): boolean")));
  return new Function("viewer", body) as (viewer: Viewer) => boolean;
}

const DECISION_ROUTES = [
  "",
  "/refuse",
  "/approve",
  "/restore",
  "/shared-place",
  "/shared-place/restore",
  "/same-place",
] as const;

export function runPhoenixCrmSfePlaceChecksTests() {
  const access = read("src/lib/phoenix-crm/server/access.ts");

  // ── 1. WHO DECIDES ───────────────────────────────────────────────────────────
  const decides = predicate(access, "canDecideValidationReviews");
  assert.equal(decides({ ...NOBODY, isSuperAdmin: true, canUpdate: true, canApprove: true }), true, "the Super Admin decides");
  assert.equal(decides({ ...NOBODY, isSuperAdmin: true, canApprove: true }), false, "a Super Admin without `update` does not — his own grant is unchanged");
  assert.equal(decides({ ...NOBODY, isSfeManager: true, canApprove: true }), true, "🔴 the SFE Manager decides on `approve` alone — he holds no `update`");
  assert.equal(decides({ ...NOBODY, isSfeManager: true, canUpdate: true }), false, "and a role named SFE Manager without `approve` does not");
  assert.equal(decides({ ...NOBODY, isSfeManager: true }), false, "nor one with no grant at all");
  assert.equal(decides({ ...NOBODY, isSuperAdmin: true, isTestPersona: true, canUpdate: true, canApprove: true }), false, "a test account never decides — Super Admin");
  assert.equal(decides({ ...NOBODY, isSfeManager: true, isTestPersona: true, canApprove: true }), false, "a test account never decides — SFE Manager");
  assert.equal(decides({ ...NOBODY, canUpdate: true, canApprove: true }), false, "🔴 a district manager, a regional or national manager or the CEO holding `approve` does NOT decide");

  // ── 1b. TAKING A REJECTION BACK IS THE SUPER ADMIN'S ALONE (owner, 2026-11-10) ──────────────────
  // "make the administrator able to approve a rejected validation from the SFE in place checks but the SFE
  // cannot; the administrator is never blocked".
  const restores = predicate(access, "canRestoreValidation");
  assert.equal(restores({ ...NOBODY, isSuperAdmin: true, canUpdate: true, canApprove: true }), true, "the Super Admin takes a rejection back");
  assert.equal(restores({ ...NOBODY, isSfeManager: true, canApprove: true }), false, "🔴 the SFE Manager does NOT, though he still approves and rejects");
  assert.equal(restores({ ...NOBODY, isSfeManager: true, canApprove: true, canUpdate: true }), false, "not even if he were ever given `update`");
  assert.equal(restores({ ...NOBODY, isSuperAdmin: true, isTestPersona: true, canUpdate: true }), false, "a test account never does");
  assert.equal(restores({ ...NOBODY, canUpdate: true, canApprove: true }), false, "nor a manager holding the grants");

  // The grant the whole design leans on: if someone "fixes" a red gate by handing the SFE Manager
  // `update`, every other `update` route in the module opens to him with it.
  const permissions = read("src/lib/auth/permissions.ts");
  const sfeBlock = /\n  "SFE Manager": \{[\s\S]*?\n  \},/.exec(permissions)?.[0] ?? "";
  assert.ok(sfeBlock.length > 0, "the SFE Manager's grants are found");
  assert.match(sfeBlock, /phoenix_crm: \["read", "approve"\],/, "🔴 the SFE Manager holds phoenix_crm read + approve and NO update — the decision routes are gated on approve for that reason");

  // ── 2. THE ROUTES ARE GATED ON `approve`, AND THE REGISTRY SAYS SO ───────────
  const registry = read("src/lib/security/access-registry.ts");
  for (const suffix of DECISION_ROUTES) {
    const pattern = `/api/phoenix-crm/validation-reviews${suffix}`;
    const file = `app/api/phoenix-crm/validation-reviews${suffix}/route.ts`;
    const route = read(file);
    assert.match(route, /assertSameOriginMutation\(request\)/, `${pattern}: the origin is checked`);
    assert.ok(route.includes('assertPermission(access, "phoenix_crm", "approve")'), `${pattern}: the write is behind \`approve\`, which both deciders hold`);
    assert.ok(!route.includes('assertPermission(access, "phoenix_crm", "update")'), `${pattern}: and no longer behind \`update\`, which the SFE Manager does not hold`);
    const entry = new RegExp(`methods: \\["POST"\\], pattern: "${pattern}", permission: \\{ resource: "phoenix_crm", action: "(\\w+)" \\}`).exec(registry);
    assert.ok(entry, `${pattern}: the POST is declared in the access registry`);
    assert.equal(entry[1], "approve", `${pattern}: and the registry agrees with the route`);
  }

  // ── 3. THE PAGE AND THE CARD ─────────────────────────────────────────────────
  const page = read("app/(admin)/admin/field-crm/validation-reviews/page.tsx");
  assert.ok(page.includes('canAccess(access, "phoenix_crm", "approve")'), "the page's first gate is `approve`");
  assert.match(page, /if \(!viewer \|\| !canDecideValidationReviews\(viewer\)\) redirect\("\/admin"\);/, "and its second is the decider, by redirect");

  const navigation = read("src/config/system-navigation.ts");
  const card = /href: "\/admin\/field-crm\/validation-reviews",[\s\S]*?\n  \},/.exec(navigation)?.[0] ?? "";
  assert.ok(card.length > 0, "the Place Checks hub card is found");
  assert.ok(card.includes('permissions: [{ resource: "phoenix_crm", action: "approve" }]'), "the card's permission is `approve`");
  assert.ok(card.includes('roles: ["Super Admin", "SFE Manager"]'), "🔴 and it is drawn for the SFE Manager as well as the Super Admin");

  // ── 4. THE POLYCLINIC DECISION FOLLOWS THE DECIDER; SEATING DOES NOT ─────────
  const shared = read("src/lib/phoenix-crm/server/shared-places.ts");
  for (const name of ["decideSharedPlace", "restoreSharedPlace"]) {
    const text = functionText(shared, name);
    const gate = name === "restoreSharedPlace" ? "canRestoreValidation" : "canDecideValidationReviews";
    assert.ok(text.includes(`if (!${gate}(viewer)) throw forbiddenError(`), `${name} asks ${gate}`);
    assert.ok(!text.includes("canDecideSharedPlaces"), `${name} no longer asks the seating gate`);
  }
  const seating = predicate(shared, "canDecideSharedPlaces");
  assert.equal(seating({ ...NOBODY, isSuperAdmin: true, canUpdate: true, canApprove: true }), true, "the Super Admin still seats a customer in a polyclinic");
  assert.equal(seating({ ...NOBODY, isSfeManager: true, canApprove: true }), false, "🔴 the SFE Manager does NOT (owner, 2026-10-10: never the SFE Manager)");
  assert.equal(seating({ ...NOBODY, isSfeManager: true, canApprove: true, canUpdate: true }), false, "not even if he were ever given `update`");

  // ── 5. SETTLING AN INTEGRITY CASE STAYS THE SUPER ADMIN'S ────────────────────
  const board = read("src/lib/phoenix-crm/server/integrity-board.ts");
  const settles = predicate(board, "canSettleIntegrityCases");
  assert.equal(settles({ ...NOBODY, isSuperAdmin: true, canUpdate: true }), true, "the Super Admin still settles a case");
  assert.equal(settles({ ...NOBODY, isSfeManager: true, canApprove: true }), false, "🔴 the SFE Manager reads that board and does not settle on it (owner, 2026-10-09)");

  // ── 6. HIS EVIDENCE ON THIS BOARD IS THE SUPER ADMIN'S: THE DEVICE'S TOO (2026-10-19) ──────────
  // "Show the mock-location evidence to the SFE Manager too" — the one place this board still differed.
  // The audience is the seat scope, which throws for anybody who may not open the board, so there is no
  // tier left inside the read: every viewer it admits is served the position cases and the mock answer.
  const evidence = functionText(board, "loadPlaceCheckIntegrity");
  assert.ok(evidence.includes("const seats = placeChecksSeatScope(viewer);"), "🔴 the audience is the seat scope, asked first — it throws for anybody who may not open this board");
  assert.ok(/strong, device_mocked, accuracy_meters/.test(evidence), "🔴 `device_mocked` is in the select for everybody this read admits — the SFE Manager included");
  assert.ok(!evidence.includes("SFE_SOURCES"), "🔴 and no detector is cut out of his evidence on a place check — position and mock-location cases are read for him");
  assert.ok(!evidence.includes("deviceEvidence"), "and there is no second tier inside the read to be widened or narrowed by accident");
  assert.ok(evidence.includes("row.device_mocked === true"), "and the phone's mock answer is worded for him, in words");

  // ── 6b. NOTHING ELSE MOVED: THE INTEGRITY BOARD AND THE VISIT REPORT STILL NARROW HIM (2026-10-02) ──
  const positions = predicate(board, "readsPositionCases");
  assert.equal(positions({ ...NOBODY, isSuperAdmin: true }), true, "the Super Admin reads the position cases");
  assert.equal(positions({ ...NOBODY, isSfeManager: true, canApprove: true }), false, "🔴 the SFE Manager still does NOT on the integrity board or the visit report — this widening is the Place Checks screen only");
  for (const name of ["loadVisitReportEvidence"]) {
    const text = functionText(board, name);
    assert.ok(text.includes('.in("source", SFE_SOURCES)'), `${name} still narrows everybody but the Super Admin to the photo cases`);
    assert.ok(text.includes('positions ? ", device_mocked" : ""'), `${name} still leaves \`device_mocked\` out of his select`);
  }

  // ── 7. A NEW HOLD IS STILL TOLD TO THE SUPER ADMIN ALONE ─────────────────────
  const reviews = read("src/lib/phoenix-crm/server/validation-reviews.ts");
  assert.ok(
    functionText(reviews, "notifyValidationReviewWaiting").includes('resolveHrIdsForRole("Super Admin"'),
    "🔴 the email, in-app and Telegram notice of a hold goes to the Super Admin — the SFE Manager was not given a message he did not ask for",
  );

  // ── 8. THE SFE MANAGER'S DECISIONS ARE STILL THE SYSTEM'S, NEVER A PERSON'S, TO THE REP ──
  for (const name of ["decideValidationReview", "refuseValidatedPlace", "approveValidatedPlace"]) {
    assert.ok(functionText(reviews, name).includes("if (!canDecideValidationReviews(viewer)) throw forbiddenError("), `${name} asks the one decider before it reads or writes anything`);
  }
  assert.ok(functionText(reviews, "restoreValidation").includes("if (!canRestoreValidation(viewer)) throw forbiddenError("), "restoreValidation asks for the Super Admin before it reads or writes anything");

  // ── 9. HIS BOARD DRAWS NO TAKE-BACK (owner, 2026-11-10) ──────────────────────
  assert.ok(page.includes("<PlaceCheckRestoreProvider canRestore={canRestoreValidation(viewer)}>"), "the page says who takes a rejection back, from the server's own gate");
  const restoreScreen = read("src/components/phoenix-crm/place-check-restore.tsx");
  assert.ok(restoreScreen.includes("const RestoreContext = createContext(false);"), "🔴 and the screen defaults to NO take-back, so a board that forgets the provider draws none");
  assert.ok(restoreScreen.includes("if (!canRestore || !reviewId) return null;"), "the take-back draws nothing for anybody else");
  const queue = read("src/components/phoenix-crm/validation-review-queue.tsx");
  assert.ok(queue.includes('DECIDED_ACTIONS.filter((action) => action.key !== "approve-after-all")'), "the bulk take-back is left out of his bar");
  assert.ok(queue.includes("row.refusable || (canRestore && row.restorable)"), "and he cannot tick a rejected row");
  const venues = read("src/components/phoenix-crm/shared-place-list.tsx");
  assert.ok(venues.includes('VENUE_ACTIONS.filter((action) => action.key !== "restore")'), "nor bring a rejected building back in bulk");
  assert.ok(venues.includes("{canRestore ? ("), "nor on its own row");
}
