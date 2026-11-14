import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isTerminalDirectOrderStatus } from "../src/lib/direct-orders/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The HELD lane (spec B6/C3 — docs/specs/direct-orders-v2.md, owner design 2026-08-04).
//
// The rule under guard: an order whose pharmacy is not in the master database SUBMITS but stands
// OUTSIDE the approval flow — no steps, no approver queues, no sales path — and leaves `held`
// through exactly two doors: pharmacy validation (→ chain at step 1) or the 14-day clock
// (→ expired, terminal). The submit fork, the revival hook, the expiry sweep, and the Held Desk's
// notice recipients are each asserted against the source, because the live path is Supabase-bound.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Slice a top-level declaration out of a source file by its REAL end — the next top-level
 * declaration — instead of a fixed byte count. A magic window measures source LENGTH, not the
 * invariant it claims to guard: it false-FAILS the moment the pinned function grows past the
 * window (the regression fixed in PR #2288), and it false-PASSES when a function that genuinely
 * lost its marker spills into the next function's copy of it.
 */
function topLevelBlock(source: string, start: number): string {
  if (start < 0) return "";
  const rest = source.slice(start + 1);
  const next = rest.search(/^(?:export )?(?:async )?function |^(?:export )?(?:const|type|interface|class) /m);
  return source.slice(start, next >= 0 ? start + 1 + next : source.length);
}

export function runDirectOrdersHeldLaneTests() {
  const serviceSource = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
  const migrationSource = readFileSync(
    new URL("../supabase/migrations/20260804210000_direct_orders_held_lane.sql", import.meta.url),
    "utf8",
  );

  // ── THE HEADLINE: the submit fork exists, and is decided by EVIDENCE about the pharmacy ──
  // If someone re-unifies submit into a single always-pending_approval path, this is the
  // assertion that must fire first.
  //
  // RE-AIMED 2026-08-08. This pinned the literal line
  // `const submitAsHeld = pharmacy.verificationStatus === "pending_review";` — verification status
  // as the SOLE input. That is exactly what the owner changed: a hand-typed pharmacy whose
  // distributor code resolves in the master database, in the brick the request declares, is proven
  // real and no longer freezes outside the chain. The lane itself is untouched, and review is not
  // skipped — the chain's first rung is the SFE Manager either way.
  //
  // What must still hold, and is asserted below: the fork EXISTS, it is decided in the domain by a
  // shared pure rule rather than inline in the service, and an unproven pharmacy still submits HELD.
  assert.match(
    serviceSource,
    /const submitAsHeld = holdDecision\.hold;/,
    "HELD LANE GONE: submit must still fork — an unproven pharmacy submits HELD, never straight into the chain",
  );
  assert.match(
    serviceSource,
    /const holdDecision = decideDirectOrderHold\(\{/,
    "the fork must be decided by the shared pure rule (hold-decision.ts), never re-implemented inline",
  );
  // The pharmacy row is still an input — losing it would release rejected or unreviewed pharmacies.
  assert.match(
    serviceSource,
    /verificationStatus: pharmacy\.verificationStatus,/,
    "the hold decision must still read the pharmacy's verification status, not only its codes",
  );

  // The fork must reach all three write surfaces: registry action, request status, and the clock.
  assert.match(
    serviceSource,
    /actionKey: submitAsHeld \? "submit_held" : "submit",\s*\n\s*expectedNextStatus: submitAsHeld \? "held" : "pending_approval",/,
    "the registry gate must be told the truth about the destination status on both branches",
  );
  assert.match(
    serviceSource,
    /status: submitAsHeld \? "held" : "pending_approval",\s*\n\s*held_at: submitAsHeld \? new Date\(\)\.toISOString\(\) : null,/,
    "a held submit must stamp held_at (the 14-day clock) and a normal one must not",
  );

  // No approval chain on a held submit — seeded at REVIVAL so it names today's managers.
  assert.match(
    serviceSource,
    /const chain = submitAsHeld\s*\n\s*\? \[\]/,
    "a held submit must seed NO approval steps — the chain is built at revival, not submission",
  );
  assert.match(
    serviceSource,
    /if \(chain\.length > 0\) \{\s*\n\s*const \{ error: stepsError \}/,
    "the step insert must be guarded — PostgREST rejects an empty insert",
  );

  // ── Door 1 out of held: validation revives, automatically ───────────────────────────────
  assert.match(
    serviceSource,
    /await reviveHeldDirectOrdersForPharmacy\(access, input\.pharmacyId\);/,
    "confirming a pharmacy must revive its held orders — validation is the one door out, with no separate button to forget",
  );
  // The gate moved into the shared helper on 2026-08-08 (both doors out of held run it), so the
  // action key is passed in and the assertion below checks the SAME two facts at their new homes:
  // revive still names its registry action, and the helper still declares the destination status.
  assert.match(
    serviceSource,
    /actionKey: "revive_held",/,
    "revival must still name its registry action — a door that stops naming one is an ungated door",
  );
  assert.match(
    serviceSource,
    /actionKey: opts\.actionKey,\s*\n\s*expectedNextStatus: "pending_approval",/,
    "the shared held-lane helper must pass the registry gate the exact destination status",
  );
  // Fresh chain at revival, defensively replacing any stale steps.
  const reviveIdx = serviceSource.indexOf("async function moveHeldDirectOrdersIntoChain(");
  assert.ok(reviveIdx > 0, "the revival function must exist");
  const reviveBody = topLevelBlock(serviceSource, reviveIdx);
  assert.match(reviveBody, /await buildApprovalChain\(\{/, "revival must build the chain fresh (today's managers)");
  assert.match(reviveBody, /\.delete\(\)\s*\n\s*\.eq\("request_id", request\.id\)/, "revival must wipe stale steps before seeding");
  assert.match(
    reviveBody,
    /\.update\(\{ status: "pending_approval", held_at: null \}\)\s*\n\s*\.eq\("id", request\.id\)\s*\n\s*\.eq\("status", "held"\)/,
    "revival must move held → pending_approval guarded on the CURRENT status, and clear the clock",
  );

  // ── Door 2 out of held: the 14-day clock ────────────────────────────────────────────────
  assert.match(
    serviceSource,
    /actionKey: "expire_held",\s*\n\s*expectedNextStatus: "expired",/,
    "expiry must pass the registry gate with the exact destination status",
  );
  assert.match(
    serviceSource,
    /const holdDays = input\?\.holdDays \?\? 14;/,
    "the clock defaults to 14 days (owner spec B6)",
  );
  assert.ok(isTerminalDirectOrderStatus("expired"), "expired is terminal — a dead end, not a pause");
  // Three doors since 2026-08-05: validation revives it, the 14-day clock expires it, and the
  // requester can withdraw it (audit F3, cancel_held).
  assert.ok(!isTerminalDirectOrderStatus("held"), "held is NOT terminal — it has three live doors out");

  // The sweep is a guarded cron route, not an open endpoint.
  const cronSource = readFileSync(
    new URL("../app/api/cron/direct-orders-expire-held/route.ts", import.meta.url),
    "utf8",
  );
  // Repointed 2026-08-29 (A2): CRON_SECRET is now read inside assertCronAuthorized rather than by
  // the route, so the guard call is what proves the sweep is not an open endpoint.
  assert.match(cronSource, /assertCronAuthorized/, "the expiry sweep must be CRON_SECRET-guarded");
  assert.match(cronSource, /expireStaleHeldDirectOrders\(systemAccessContext\)/, "the sweep runs as the system context");

  // ── The Held Desk notice (spec C3): To the requester BY NAME, CC SFE + manager + CEO ────
  assert.match(
    serviceSource,
    /recipients: \[request\.requesterHrId, \.\.\.sfeHolders, managerHrId, \.\.\.ceoHolders\],/,
    "the held notice must lead with the requester (the email's To) and CC SFE, direct manager, CEO",
  );
  assert.match(
    serviceSource,
    /`\$\{requesterName\}, your direct order/,
    "the notice must address the requester by NAME, never by code (owner rule)",
  );
  const noticeIdx = serviceSource.indexOf("export async function sendHeldDirectOrderNotices(");
  assert.match(
    topLevelBlock(serviceSource, noticeIdx),
    /if \(request\.status !== "held"\) \{/,
    "a request that is no longer held must be SKIPPED — never email a stale demand",
  );

  // ── One email per event, not N copies (spec C4) ─────────────────────────────────────────
  // REC-032 (14 Nov 2026): approval notices go through the one door, raiseApproval, which hands them to
  // the same sender unchanged — so the door's form counts as the engine call it wraps.
  assert.match(
    serviceSource,
    /await raiseApproval\(approvalIdentity\("direct_order", input\.eventType\), \{ via: "notices"/,
    "notifyDirectOrder must use the consolidated To/Cc envelope helper (the door's notices delivery)",
  );
  assert.ok(
    !/recipientHrIds\.map\(\(recipientHrId\) =>\s*\n?\s*createSystemNotification\(/.test(serviceSource),
    "the per-recipient createSystemNotification loop must never return — it is the duplicate-copies bug (2026-07-22)",
  );

  // ── The migration: additive, idempotent, and silent about `version` ─────────────────────
  assert.match(migrationSource, /'held'::text,\s*\n\s*'expired'::text/, "the status constraint must gain held and expired");
  assert.match(migrationSource, /add column if not exists held_at timestamptz/, "the clock column must exist");
  assert.match(
    migrationSource,
    /and not \(actions @> '\[\{"key": "submit_held"\}\]'::jsonb\)/,
    "the registry update must be guarded so a re-run is a no-op, not a duplicate action set",
  );
  assert.ok(
    !/set\s+version/i.test(migrationSource),
    "workflow_registry_modules.version is TRIGGER-owned — a migration must never mention it",
  );
  const updateStatements = migrationSource.match(/update public\.workflow_registry_modules/g) ?? [];
  assert.equal(updateStatements.length, 1, "exactly ONE registry update — N updates = N version bumps");
}
