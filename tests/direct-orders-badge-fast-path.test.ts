import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveActiveStep } from "../src/lib/direct-orders/approval-flow.ts";
import type { DirectOrderStepState } from "../src/lib/direct-orders/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The Needs Action badge must be CHEAP and must AGREE with the screen.
//
// Those two pull in opposite directions, and that tension is the whole point of
// this file. The cheap way to count is to write a second query with its own idea
// of who may approve what — and a second copy of a visibility rule is precisely
// how `reverse` became reachable by every rep in the company (audit F5). The safe
// way to count is to build the workspace and read `.length` — which is what
// `countDirectOrderAwaiting` did, loading held/expired rows, decision history,
// pharmacies, caps, employee names and a live seat-model walk to produce one
// integer, on a 30-second poll, for every user with a sidebar open.
//
// `countDirectOrderAwaitingFast` takes neither. It loads two tables and six
// columns, and then routes the DECISION through the same `resolveActiveStep` +
// `viewerCanActOnStep` pair the workspace uses. This file locks both halves: the
// cheapness (so it cannot regress into a workspace load) and the shared rule (so
// the badge cannot start disagreeing with the list it summarises).
// ─────────────────────────────────────────────────────────────────────────────

const SERVICE = "../src/lib/direct-orders/service.ts";
const WORKSPACE = "../src/components/direct-orders/workspace/direct-orders-workspace.tsx";

function read(rel: string) {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

function step(over: Partial<DirectOrderStepState> = {}): DirectOrderStepState {
  return {
    order: 1,
    kind: "role",
    role: "SFE Manager",
    approverHrId: null,
    label: "SFE Manager",
    status: "pending",
    ...over,
  };
}

export function runDirectOrderBadgeFastPathTests() {
  const service = read(SERVICE);

  // ── 1. The shared eligibility rule, EXECUTED ────────────────────────────────
  //
  // `viewerCanActOnStep` is private to service.ts and reads a step; the step it
  // reads is chosen by `resolveActiveStep`, which is pure and exported. So the
  // part that can be proven here is the part that actually decides WHICH step the
  // badge is judging — and it is the same function the workspace calls.
  assert.strictEqual(resolveActiveStep([]), null, "no steps means nothing to act on, not step 1");

  const chain = [
    step({ order: 1, status: "approved" }),
    step({ order: 2, kind: "person", role: null, approverHrId: "B-7", status: "pending" }),
    step({ order: 3, kind: "role", role: "CEO", status: "pending" }),
  ];
  assert.strictEqual(
    resolveActiveStep(chain)?.order,
    2,
    "the active rung is the LOWEST pending one — counting every pending rung would show a CEO a count for orders three managers below them",
  );
  assert.strictEqual(
    resolveActiveStep(chain)?.approverHrId,
    "B-7",
    "the active rung must carry its approver, or the badge cannot tell whose queue it is",
  );

  // Order in the array must not decide the answer: the fast path builds its map
  // from a batched query, and PostgREST returns rows per batch, not globally sorted.
  const shuffled = [chain[2], chain[0], chain[1]];
  assert.strictEqual(
    resolveActiveStep(shuffled)?.order,
    2,
    "resolveActiveStep must sort by rung, not trust arrival order — the fast path fills its map from 100-row batches",
  );

  // A fully-decided chain is nobody's outstanding work.
  assert.strictEqual(
    resolveActiveStep([step({ order: 1, status: "approved" }), step({ order: 2, status: "approved" })]),
    null,
    "an approved chain must leave no active rung, or approved orders keep counting against somebody",
  );

  // ── 2. The fast path must not become a workspace load again ────────────────
  const start = service.indexOf("export async function countDirectOrderAwaitingFast");
  assert.ok(start > -1, "countDirectOrderAwaitingFast must exist — the badge depends on it");
  const end = service.indexOf("\nexport ", start + 1);
  const fastFn = service.slice(start, end > -1 ? end : undefined);

  assert.doesNotMatch(
    fastFn,
    /getDirectOrderWorkspaceData/,
    "THE BADGE IS LOADING THE WHOLE WORKSPACE AGAIN: it polls every 30s, and building the workspace to produce one integer is what this function exists to stop",
  );
  for (const forbidden of ["loadListDecorations", "loadPharmaciesByIds", "loadDirectOrderCaps", "nameLookup"]) {
    assert.doesNotMatch(
      fastFn,
      new RegExp(forbidden),
      `the badge must not call ${forbidden} — none of it changes the number, and it runs on every poll`,
    );
  }
  assert.doesNotMatch(
    fastFn,
    /\.select\("\*"\)/,
    "the badge must select named columns: select(*) on a company-wide pending set is the cost this replaces",
  );

  // ── 3. …and must not grow its own copy of the rule ─────────────────────────
  assert.match(
    fastFn,
    /resolveActiveStep\(/,
    "the badge must resolve the active rung with the SHARED function, not its own idea of which rung is live",
  );
  assert.match(
    fastFn,
    /viewerCanActOnStep\(/,
    "THE BADGE HAS ITS OWN ELIGIBILITY RULE: a second copy of a visibility rule is exactly how `reverse` became reachable by every rep in the company (audit F5)",
  );
  assert.match(
    fastFn,
    /assertPermission\(access, "direct_orders", "read"\)/,
    "the badge must assert its own permission — it is reachable as a bare endpoint, not only through the batched poll",
  );

  // ── 4. Every badge consumer uses it ────────────────────────────────────────
  const consumers = [
    ["the dedicated endpoint", "../app/api/direct-orders/needs-action-count/route.ts"],
    ["the batched poll", "../src/lib/approvals-hub/badge-counts-payload.ts"],
    ["the legacy per-src endpoint", "../app/api/approvals/direct-orders/pending-count/route.ts"],
  ] as const;
  for (const [label, path] of consumers) {
    const source = read(path);
    assert.match(
      source,
      /countDirectOrderAwaitingFast\(access\)/,
      `${label} must use the fast count — a consumer left on the slow one puts the workspace load back on the poll`,
    );
  }

  // The slow sibling is gone. Left in place with zero callers it is an invitation:
  // this module has already shipped one count function that nothing called.
  assert.doesNotMatch(
    service,
    /export async function countDirectOrderAwaiting\(/,
    "the slow count must stay deleted — an exported workspace-loading counter with no callers is how the 30s poll gets its cost back",
  );

  // ── 5. The badge must count EVERY queue the inbox counts ───────────────────
  //
  // Measured live 2026-08-11: the badge summed approvals + Finance and read 9, while the Needs
  // Action inbox it opens summed approvals + Finance + pharmacy validations and read 12. The badge
  // was not wrong about any queue — it was silent about a whole one, and the queue it omitted was
  // the only one with no other chaser behind it. A badge that disagrees with the screen behind it
  // teaches people to distrust both numbers.
  //
  // `buildDirectOrderNeedsAction` decides what the inbox counts, so the badge must carry one term
  // per kind it can emit for a viewer. `finish_draft` and `correct` and `verify_customer` are the
  // viewer's OWN orders, already inside the approvals term's scope; the three summed here are the
  // three the endpoint can independently source.
  const badgeRoute = read("../app/api/direct-orders/needs-action-count/route.ts");
  for (const [term, why] of [
    ["countDirectOrderAwaitingFast", "orders waiting on this viewer's approval rung"],
    ["getDirectOrderUnbookedBadge", "approved orders waiting on a Finance sales month"],
    ["countDirectOrderPendingValidations", "pharmacies waiting to be confirmed"],
  ] as const) {
    assert.match(
      badgeRoute,
      new RegExp(term),
      `THE BADGE DROPPED A QUEUE (${why}): the inbox still counts it, so the two numbers now disagree on screen`,
    );
  }
  assert.match(
    badgeRoute,
    /awaiting \+ unbooked\.count \+ validations/,
    "the badge must SUM all three queues — the sets are disjoint, so anything less under-reports the viewer's own work",
  );
  // The validation term must stay a count. Listing the claims loads their pharmacies, requesters
  // and evidence rows on a 30-second poll.
  const validationSource = read("../src/lib/direct-orders/pharmacy-validation.ts");
  const countStart = validationSource.indexOf("export async function countDirectOrderPendingValidations");
  assert.ok(countStart > -1, "countDirectOrderPendingValidations must exist");
  // Slice to the END of the function, not a fixed byte count — a byte count measures source
  // length, not whether the count still sends `head: true`.
  const countRest = validationSource.slice(countStart + 1);
  const nextDecl = countRest.search(/^(?:export )?(?:async )?function |^(?:export )?(?:const|type|interface|class) /m);
  const countFn = validationSource.slice(countStart, nextDecl >= 0 ? countStart + 1 + nextDecl : validationSource.length);
  assert.match(
    countFn,
    /head: true/,
    "the validation count must send no rows — listing every claim with its evidence on a 30s poll is the cost this whole change removes",
  );
  assert.match(
    countFn,
    /canDecideDirectOrderPharmacyValidations\(access\)/,
    "it must return 0 to anyone who cannot work the desk — a badge you cannot clear teaches people to ignore badges",
  );

  // ── 6. Search covers what the placeholder promises, and only that ──────────
  const workspace = read(WORKSPACE);
  const matcherStart = workspace.indexOf("function matchesQuery");
  const matcher = workspace.slice(matcherStart, workspace.indexOf("function searchPlaceholder"));
  for (const field of ["pharmacyCode", "medicalRepName", "pharmacyName", "requesterName", "productName"]) {
    assert.match(matcher, new RegExp(`row\\.${field}`), `search must cover ${field}`);
  }
  assert.match(
    matcher,
    /\.filter\(Boolean\)/,
    "optional fields must be dropped before joining, or an absent rep name injects 'undefined' into the haystack and matches the literal search 'undefined'",
  );
  // The placeholder is DERIVED on TWO axes now, because it can be wrong in two ways. Rep names
  // exist on My Orders rows and not on All Orders rows (the report path never resolves reps), and
  // the SERVER search reaches pharmacy and person but not area or region. A fixed string would
  // either hide a working field or advertise a dead one.
  assert.match(
    workspace,
    /placeholder=\{searchPlaceholder\(rows, Boolean\(server\)\)\}/,
    "the placeholder must be derived from the rows on screen AND from whether the server is answering — " +
      "rep search works on My Orders and not on All Orders, and area search works only off-server",
  );
  assert.match(
    workspace,
    /const hasRep = rows\.some\(\(row\) => Boolean\(row\.medicalRepName\)\)/,
    "the placeholder must decide on the actual rows, so it cannot promise a field this tab cannot match",
  );
}
