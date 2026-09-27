import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the save button actually reaches the queue (A1, the last step).
 *
 * The queue, its rules and the server's offline save path all shipped before this: what did not
 * exist was any caller. `drainOutbox` even takes its rules as an argument so there would be one
 * definition of them — and since `@/*` resolves to `mobile/src/*` and nothing else, no mobile file
 * could supply those rules, so the queue was not merely unwired but UNCALLABLE. This file pins the
 * wiring that closes it.
 *
 * ## What would be wrong quietly, and is therefore asserted here
 *
 *   1. **A dropped connection still costing a rep his visit.** Two separate requests can fail — the
 *      photo upload and the save — and each has to end in the queue rather than in a message.
 *   2. **Inventing evidence.** A visit with no photo is not a visit. Holding one whose stamped bytes
 *      the phone does not have would queue something that can never be sent.
 *   3. **Reading the wall clock.** The whole of A1 rests on the elapsed reading coming from a clock
 *      a "change my time" app cannot move.
 *   4. **Telling the rep he failed.** Golden Rule #1: a waiting visit is SAFE, and that is all the
 *      words he sees may say.
 *   5. **Queueing a PLACE.** A place's brick, area, region and address are resolved server-side from
 *      the coordinates at capture, so unlike a visit it cannot wait on the phone.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

/** The body of `async function save(` in the visits screen, to its closing brace. */
function saveBody(screen: string): string {
  const at = screen.indexOf("async function save(savedAt: number)");
  assert.notEqual(at, -1, "the visit save is still `async function save(savedAt: number)` — this test reads it by that text");
  const open = screen.indexOf("{", at);
  let depth = 0;
  for (let index = open; index < screen.length; index += 1) {
    if (screen[index] === "{") depth += 1;
    else if (screen[index] === "}") {
      depth -= 1;
      if (depth === 0) return screen.slice(open + 1, index);
    }
  }
  assert.fail("the visit save has an unbalanced body");
}

export function runPhoenixCrmOfflineWireTests(): void {
  const screen = source("mobile/src/features/crm/visits-screen.tsx");
  const list = source("mobile/src/features/crm/list-screen.tsx");
  const photo = source("mobile/src/lib/crm/photo.ts");
  const anchor = source("mobile/src/lib/crm/time-anchor.ts");
  const save = saveBody(screen);

  // ── 1. The queue is reachable at all ───────────────────────────────────────────────────────────
  {
    // The defect this whole file exists to close: rules the phone can supply.
    const rules = source("mobile/src/lib/crm/outbox-rules.ts");
    for (const exported of ["outboxVerdict", "outboxOrder", "outboxIsStale", "outboxHasRoom", "describeOutbox"]) {
      assert.ok(rules.includes(`export function ${exported}`), `the phone's rules mirror must export ${exported}`);
    }
    assert.ok(
      /const OUTBOX_RULES = \{[^}]*verdict: outboxVerdict/.test(screen),
      "🔴 the drain must be handed the shared rules — re-implementing them in the screen is the drift this mirror exists to stop",
    );
    assert.ok(screen.includes("drainOutbox(token, OUTBOX_RULES)"), "the drain is called with those rules");
  }

  // ── 2. 🔴 Both failure points end in the queue, not in a message ───────────────────────────────
  {
    // The upload never landed, so there is no path: hold it without even trying the save.
    assert.ok(
      /if \(!\(placePhoto \?\? photo\)\?\.path\) \{\s*if \(hold\(\)\) return;/.test(save),
      "🔴 a photo that never reached Phoenix must be HELD, not refused — the rep is at the door and the evidence is already stamped",
    );
    // The photo landed and the save did not.
    assert.ok(
      /caught instanceof NetworkError && hold\(\)/.test(save),
      "🔴 a dropped connection on the save must hold the visit — he did the work and must not be sent back to the door",
    );
    // And the camera has to have been told to keep the bytes, or there is nothing to hold.
    assert.ok(/<CrmLivePhoto\b[\s\S]{0,400}?allowOffline/.test(screen), "the visit camera keeps a photo the connection would not carry");
  }

  // ── 3. 🔴 Nothing is queued that cannot be sent ────────────────────────────────────────────────
  {
    assert.ok(
      /function hold\(\): boolean \{\s*if \(!evidenceBytes\) return false;/.test(save),
      "🔴 a visit is never held without its stamped photo — a queued visit with no evidence can never be sent and never leaves",
    );
    // Full means the newest is refused at the door, and nothing is written.
    const holdBody = save.slice(save.indexOf("function hold(): boolean"));
    const fullBranch = holdBody.slice(holdBody.indexOf("outboxHasRoom"), holdBody.indexOf("queueVisit("));
    assert.ok(fullBranch.includes("OUTBOX_FULL_MESSAGE"), "a full queue tells him the one thing he can act on");
    assert.ok(fullBranch.includes("return true"), "and stops, rather than falling through to the generic failure");
    assert.equal(fullBranch.includes("forget("), false, "🔴 nothing older is discarded to make room");
  }

  // ── 4. 🔴 The elapsed reading never comes from the wall clock ──────────────────────────────────
  {
    assert.equal(
      anchor.includes("Date.now()"),
      false,
      "🔴 the anchor module must never read the wall clock — an app that changes the phone's time is the whole reason A1 exists",
    );
    assert.ok(anchor.includes("monotonicNow()"), "it measures with the monotonic clock");
    // 🔴 The phone sends a duration and never a timestamp. Three fields, no fourth.
    const claim = anchor.slice(anchor.indexOf("export function offlineClaimNow"));
    assert.ok(/return \{ anchorId: held\.anchorId, bootId: held\.runId, elapsedMs: [^}]+\};/.test(claim), "the claim is an id, a run id and a duration");
    for (const banned of ["capturedAt", "issuedAt", "timestamp", "toISOString"]) {
      assert.equal(claim.includes(banned), false, `🔴 the claim must not carry \`${banned}\` — the server adds the elapsed time to its OWN record`);
    }
    // Read at the press, for the same reason the form's stopwatch is: a re-render must not move it.
    assert.ok(save.includes("offlineClaimNow(seatId, test)"), "the claim is taken inside the save handler");
    assert.equal(screen.slice(0, screen.indexOf("async function save(savedAt: number)")).includes("offlineClaimNow("), false, "and nowhere a render can reach");
  }

  // ── 5. 🔴 Golden Rule #1 — every word he reads says the visit is safe ─────────────────────────
  {
    assert.ok(screen.includes("describeOutbox(waiting)"), "the waiting line is the shared wording, not a sentence written here");
    // The queued confirmation is worded like the saved one, in the same place, with the same tone.
    assert.ok(/queued \? <CrmNote title=\{`Visit saved: \$\{queued\}`\} tone="good">/.test(screen), "a held visit is confirmed as saved, in green");
    for (const word of ["fail", "error", "retry", "offline mode", "no connection", "not sent", "unsent", "stuck", "pending upload"]) {
      const line = /queued \? <CrmNote[\s\S]*?<\/CrmNote> : null\}/.exec(screen)?.[0] ?? "";
      assert.equal(line.toLowerCase().includes(word), false, `🔴 the rep is never told "${word}" about a visit waiting on his phone`);
    }
  }

  // ── 6. 🔴 A place is never queued ──────────────────────────────────────────────────────────────
  {
    assert.ok(photo.includes("export type CrmStoredPhoto"), "a photo Phoenix is holding has its own type");
    assert.ok(
      /function payloadFor\(photo: CrmStoredPhoto/.test(list),
      "🔴 validating a place takes a STORED photo — the server resolves its brick and area from the coordinates at capture",
    );
    assert.ok(list.includes("!isStoredPhoto(photo)"), "and the place save narrows to one before building the payload");
    // The place camera must not be handed the visit camera's licence.
    const placeCamera = /<CrmLivePhoto[\s\S]*?purpose="place"/.exec(list)?.[0] ?? "";
    assert.ok(placeCamera.length > 0, "the place camera is still a CrmLivePhoto");
    assert.equal(placeCamera.includes("allowOffline"), false, "🔴 a place can never be held on the phone");
  }

  console.log("phoenix-crm offline wire: OK");
}
