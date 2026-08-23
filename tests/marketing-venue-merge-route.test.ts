import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";

// The half of the venue merge that was missing.
//
// `mergeMarketingVenue` shipped on 2026-08-23 in #2323, its three columns were applied to the
// production database the same day, and `tests/marketing-venue-merge.test.ts` pinned the formula.
// None of that gave anyone a way to run it: a repo-wide search for the function found exactly one
// occurrence, its own definition. The service was reachable only from a hand-written SQL statement.
//
// So the assertions here are about REACHABILITY, not about the merge rules — those are pinned next
// door. What has to stay true is that the route exists, that it is registered as the mutation it
// is, that it delegates authorization rather than re-deciding it, and that the screen carrying the
// action is the one whose own gate already matches the service's.

const ROUTE = "app/api/marketing-requests/venue-merge/route.ts";
const COMPONENT = "src/components/employee-portal/marketing-customer-database.tsx";
const SERVICE = "src/lib/marketing-requests/service.ts";
const NAVIGATION = "src/lib/employee-portal/navigation.ts";

function read(path: string) {
  return readFileSync(path, "utf8");
}

export function runMarketingVenueMergeRouteTests() {
  const route = read(ROUTE);

  // 1. The route calls the service. This is the whole point of the change: before it, nothing did.
  assert.match(
    route,
    /import \{ listMarketingVenueMergeCandidates, mergeMarketingVenue \} from "@\/lib\/marketing-requests\/service"/,
    "the venue-merge route must import both halves from the marketing service",
  );
  assert.match(route, /await mergeMarketingVenue\(access, \{/, "POST must call mergeMarketingVenue with the access context");
  assert.match(
    route,
    /await listMarketingVenueMergeCandidates\(access\)/,
    "GET must call listMarketingVenueMergeCandidates with the access context",
  );

  // 2. Authorization is the service's, not the route's. A route that re-decides who may merge is a
  //    second gate to keep in step with the first, which is how the two drift apart.
  assert.doesNotMatch(
    route,
    /assertPermission\(|access\.role !== |access\.role ===/,
    "the venue-merge route must delegate authorization to assertMarketingControlAccess, not re-check the role itself",
  );
  assert.match(
    route,
    /const csrf = assertSameOriginMutation\(request\);/,
    "the mutating half must assert same-origin before doing anything",
  );

  // 3. A forbidden caller must get 403 and not the service error's own status, which for a
  //    forbiddenError would otherwise surface as a generic failure the UI cannot label.
  assert.match(route, /isForbiddenError\(error\) \? 403 :/, "both handlers must map a forbidden error to 403");

  // 4. Registered — and registered as a MUTATION with CSRF required. The blanket
  //    /api/marketing-requests/** entry would have accepted this route silently, inheriting no
  //    audit classification and no CSRF requirement, which is precisely the fall-through the
  //    Source Normalizer routes suffered.
  const post = findAccessRegistryEntry("/api/marketing-requests/venue-merge", "POST");
  assert.equal(post?.pattern, "/api/marketing-requests/venue-merge", "POST must resolve to its own entry, not the blanket");
  assert.equal(post?.audit.classification, "mutation", "a venue merge rewrites four child tables and must be classified as a mutation");
  assert.equal(post?.audit.required, true, "a venue merge must require an audit row");
  assert.equal(post?.csrf.required, true, "the venue merge must require same-origin");

  const get = findAccessRegistryEntry("/api/marketing-requests/venue-merge", "GET");
  assert.equal(get?.pattern, "/api/marketing-requests/venue-merge", "GET must resolve to the same dedicated entry");

  // 5. The picker reads the venue TABLE, not the Customer Database rows. Those rows are customer
  //    links, so a duplicate venue that was created and never linked to anybody — the easiest
  //    duplicate to make — would be absent from the one list that exists to retire it.
  const service = read(SERVICE);
  const candidates = service.slice(service.indexOf("export async function listMarketingVenueMergeCandidates"));
  const body = candidates.slice(0, candidates.indexOf("\n}\n") + 3);
  assert.match(body, /assertMarketingControlAccess\(access\)/, "the venue list must be gated by the same check as the merge");
  assert.match(body, /\.from\("marketing_pharmacies"\)/, "the venue list must read marketing_pharmacies directly");
  assert.doesNotMatch(
    body,
    /\.eq\("active", true\)/,
    "inactive venues are the merge backlog — filtering them out hides the rows this screen exists to retire",
  );
  assert.match(
    body,
    /mergedIntoPharmacyId: venue\.mergedIntoPharmacyId/,
    "each candidate must carry mergedIntoPharmacyId so an already-merged venue can be labelled rather than offered",
  );

  // 6. The action sits on the Customer Database screen, whose own gate is already the exact pair
  //    assertMarketingControlAccess admits. If that ever widens, the panel becomes a control that
  //    403s for whoever was added — so pin the equivalence rather than trusting it.
  const navigation = read(NAVIGATION);
  const gate = navigation.slice(navigation.indexOf("export function canUseEmployeePortalMarketingCustomerDatabase"));
  const gateBody = gate.slice(0, gate.indexOf("\n}\n") + 3);
  assert.match(
    gateBody,
    /role === "Super Admin" \|\| role === "SFE Manager"/,
    "the Customer Database gate must stay Super Admin / SFE Manager — the pair assertMarketingControlAccess admits",
  );

  const component = read(COMPONENT);
  assert.match(component, /<MergeVenuesPanel onMerged=\{\(\) => void loadWorkspace\(\)\}/, "the merge panel must be rendered on the Customer Database screen");
  assert.match(
    component,
    /fetch\("\/api\/marketing-requests\/venue-merge", \{\s*body: JSON\.stringify\(\{ loserId, reason: reason\.trim\(\), survivorId \}\)/,
    "the panel must post the survivor, the duplicate and the written reason",
  );

  // 7. The reason is not optional in the UI either. The service rejects a blank one, but a button
  //    that is enabled and then fails is how a reason like "duplicate" gets typed to get past it.
  assert.match(
    component,
    /const canMerge = Boolean\(survivorId && loserId && survivorId !== loserId && reason\.trim\(\) && !isMerging\)/,
    "the merge button must stay disabled until both venues and a written reason are present",
  );

  // 8. A merge deactivates a venue and moves four kinds of child row. It must not be one misclick.
  assert.match(component, /window\.confirm\(/, "the merge must be confirmed before it is sent");
}
