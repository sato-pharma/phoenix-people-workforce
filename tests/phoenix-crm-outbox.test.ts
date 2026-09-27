import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  OUTBOX_FULL_MESSAGE,
  OUTBOX_MAX_AGE_HOURS,
  OUTBOX_MAX_ITEMS,
  OUTBOX_SETTLED_CODES,
  describeOutbox,
  outboxHasRoom,
  outboxIsStale,
  outboxOrder,
  outboxVerdict,
  type OutboxItem,
} from "../src/lib/phoenix-crm/outbox-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the visits waiting on a rep's phone (A1, the last piece).
 *
 * The app used to refuse to hold a CRM write at all, and `client.ts` still carries the reason: a visit
 * could not be DATED without the server. The owner's ruling of 2026-09-27 and the three phases behind
 * it removed that, so the only thing left of the old rule was a rep in a dead spot losing real work.
 *
 * ## The four things that would be wrong quietly
 *
 *   1. **Throwing a rep's work away.** The queue must delete an item only when the server ACCEPTED it
 *      or refused it for a reason that can never change. A network failure that drops a visit is a
 *      lie about a rep's day, and he would never know it happened.
 *   2. **Discarding the oldest to make room.** When the queue is full the NEWEST capture is refused at
 *      the door — an instruction he can act on — rather than yesterday's visit vanishing.
 *   3. **Telling him he failed.** Golden Rule #1: a waiting visit is SAFE. No error, no count of
 *      attempts, no explanation, no red.
 *   4. **Re-uploading a photo on retry.** The path is recorded the moment an upload succeeds, or a
 *      retry burns a second upload slot and the rate limit eventually refuses him.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

function item(patch: Partial<OutboxItem> = {}): OutboxItem {
  return { visitId: "V-1", queuedAtIso: "2026-09-27T08:00:00Z", photoPath: null, attempts: 0, ...patch };
}

export function runPhoenixCrmOutboxTests(): void {
  // ── 1. 🔴 What may and may not throw a rep's work away ─────────────────────────────────────────
  {
    assert.equal(outboxVerdict({ ok: true }), "sent");

    // Every network failure retries, for ever. This is the whole safety of the queue.
    assert.equal(outboxVerdict({ ok: false, kind: "offline" }), "retry", "🔴 a dead connection never costs a rep a visit");
    assert.equal(outboxVerdict({ ok: false }), "retry", "nor does an unrecognisable failure");

    // A 5xx REACHED the server, but the server broke rather than judged — the same distinction the
    // read cache already draws.
    assert.equal(outboxVerdict({ ok: false, kind: "api", status: 500, code: "internal" }), "retry", "a broken server is not a verdict");
    assert.equal(outboxVerdict({ ok: false, kind: "api", status: 502 }), "retry");

    // Only a refusal that can never change is final.
    for (const code of OUTBOX_SETTLED_CODES) {
      assert.equal(outboxVerdict({ ok: false, kind: "api", status: 409, code }), "settled", `${code} is final`);
    }
    // 🔴 And anything the server says that is NOT on that short list is kept, not dropped. A code this
    // release has never heard of is the commonest way a queue quietly eats work.
    assert.equal(
      outboxVerdict({ ok: false, kind: "api", status: 409, code: "phoenix_crm:something_new" }),
      "retry",
      "🔴 an unknown refusal is KEPT — a code this build does not know must never delete a visit",
    );
    assert.equal(outboxVerdict({ ok: false, kind: "api", status: 429, code: "rate_limited" }), "retry", "a rate limit is temporary by definition");
  }

  // ── 2. Oldest first, so a day drains in the order it happened ─────────────────────────────────
  {
    const ordered = outboxOrder([
      item({ visitId: "C", queuedAtIso: "2026-09-27T11:00:00Z" }),
      item({ visitId: "A", queuedAtIso: "2026-09-27T09:00:00Z" }),
      item({ visitId: "B", queuedAtIso: "2026-09-27T10:00:00Z" }),
    ]);
    assert.deepEqual(
      ordered.map((entry) => entry.visitId),
      ["A", "B", "C"],
    );
    // A tie is broken by id rather than left to the file system's ordering, so a drain is repeatable.
    const tied = outboxOrder([item({ visitId: "Z" }), item({ visitId: "A" })]);
    assert.deepEqual(
      tied.map((entry) => entry.visitId),
      ["A", "Z"],
    );
  }

  // ── 3. 🔴 Full means the NEWEST is refused, never the oldest discarded ─────────────────────────
  {
    const full = Array.from({ length: OUTBOX_MAX_ITEMS }, (_unused, index) => item({ visitId: `V-${index}` }));
    assert.equal(outboxHasRoom(full.slice(0, OUTBOX_MAX_ITEMS - 1)), true);
    assert.equal(outboxHasRoom(full), false, `${OUTBOX_MAX_ITEMS} waiting is the ceiling`);
    // The message is an instruction he can act on, not a complaint and not an error.
    assert.match(OUTBOX_FULL_MESSAGE, /find signal/i);
    for (const word of ["error", "failed", "fail", "cannot save", "lost"]) {
      assert.equal(OUTBOX_FULL_MESSAGE.toLowerCase().includes(word), false, `the full message must not say "${word}"`);
    }
  }

  // ── 4. Stale stops the retrying; it does NOT delete ────────────────────────────────────────────
  {
    const fresh = item({ queuedAtIso: "2026-09-27T08:00:00Z" });
    assert.equal(outboxIsStale(fresh, "2026-09-27T20:00:00Z"), false, "half a day is nothing");
    assert.equal(
      outboxIsStale(fresh, new Date(Date.parse("2026-09-27T08:00:00Z") + (OUTBOX_MAX_AGE_HOURS + 1) * 3600_000).toISOString()),
      true,
      `past ${OUTBOX_MAX_AGE_HOURS / 24} days it stops being plausible that the phone is simply away`,
    );
    // 🔴 Deliberately LONGER than the anchor's own 20 hours: past the anchor the visit is dated at
    // arrival instead, which is worse but is still a real visit that must not be thrown away.
    assert.ok(OUTBOX_MAX_AGE_HOURS > 20, "the queue outlives the anchor on purpose");
    assert.equal(outboxIsStale(item({ queuedAtIso: "nonsense" }), "2026-09-27T20:00:00Z"), false, "an unreadable date is never grounds to give up");

    const drain = source("mobile/src/lib/crm/outbox.ts");
    const staleBranch = drain.slice(drain.indexOf("if (rules.isStale("), drain.indexOf("try {", drain.indexOf("if (rules.isStale(")));
    assert.equal(staleBranch.includes("forget("), false, "🔴 a stale item is kept on disk, never deleted");
  }

  // ── 5. 🔴 Golden Rule #1 — a waiting visit is SAFE, never failed ───────────────────────────────
  {
    assert.equal(describeOutbox(0), null, "nothing waiting, nothing said");
    assert.equal(describeOutbox(1), "1 visit is saved on this phone. It will send itself when there is signal.");
    assert.equal(describeOutbox(4), "4 visits are saved on this phone. They will send themselves when there is signal.");
    for (const count of [1, 3, 50]) {
      const text = String(describeOutbox(count)).toLowerCase();
      for (const word of ["fail", "error", "retry", "attempt", "stuck", "problem", "unable"]) {
        assert.equal(text.includes(word), false, `🔴 the rep is never told "${word}" — a held visit is safe, not broken`);
      }
      assert.match(String(describeOutbox(count)), /saved on this phone/);
    }
  }

  // ── 6. The photo is uploaded ONCE, and the drain can never crash a screen ─────────────────────
  {
    const drain = source("mobile/src/lib/crm/outbox.ts");
    // 🔴 The path is written the moment the upload succeeds, so a retry after a failed SAVE does not
    // burn a second slot — SLOTS_PER_HOUR would eventually refuse him for his own retries.
    assert.ok(
      drain.includes("writeManifest({ ...item, photoPath, attempts: item.attempts + 1 })"),
      "🔴 the photo path is recorded immediately, so a retry never re-uploads",
    );
    assert.ok(drain.includes("if (!photoPath)"), "and a second attempt skips the upload entirely");
    // 🔴 The upload sends exactly what the live path sends — the slot is issued from these three and
    // nothing else, so spreading a whole visit payload into it would be noise the next change trips on.
    assert.ok(drain.includes('purpose: "visit"'), "the slot is asked for as a visit photo");
    assert.ok(drain.includes("seatId: item.payload.seatId"), "for this territory");
    assert.equal(drain.includes("{ ...item.payload, imageDataUrl"), false, "and not by spreading the whole visit into the upload");

    // It runs where nobody is watching, so it must never throw.
    assert.ok(/export async function drainOutbox[\s\S]*?\n}/.test(drain));
    const body = drain.slice(drain.indexOf("export async function drainOutbox"));
    assert.equal(/\n  throw /.test(body), false, "a background drain must not throw onto a screen the rep did not touch");
    assert.ok(body.includes("catch"), "every attempt is wrapped");

    // The wall clock is never the source of an elapsed reading.
    assert.ok(drain.includes("performance.now()"), "elapsed time comes from the monotonic clock");
    const monotonic = drain.slice(drain.indexOf("export function monotonicNow"), drain.indexOf("export type OutboxAnchor"));
    assert.equal(monotonic.includes("Date.now()"), false, "🔴 never the wall clock, which a rep can move");
  }

  // ── 7. The phone's copies match the web's originals ────────────────────────────────────────────
  //
  // `mobile/` is its own TypeScript project and cannot import the web module, so the constants are
  // transcribed. A drift here is silent: a phone holding 500 visits the server's rules never agreed to.
  {
    const drain = source("mobile/src/lib/crm/outbox.ts");
    // The phone does not re-implement the verdict — it is handed in, so there is one definition.
    assert.ok(drain.includes("rules.verdict("), "the verdict is the shared rule, passed in rather than copied");
    assert.ok(drain.includes("rules.order("), "and so is the ordering");
    assert.ok(drain.includes("rules.isStale("), "and the staleness");
    assert.equal(drain.includes("OUTBOX_SETTLED_CODES"), false, "so the phone holds no second copy of the settled list to drift from");
  }

  // ── 8. 🔴 Every settled code is one the SERVER can actually send ──────────────────────────────
  //
  // This is the check that would have caught the defect #4560 shipped. The list was written in the
  // DATABASE's spelling (`phoenix_crm:already_visited`) while the phone receives the API's
  // (`phoenix_crm_already_visited`), so not one entry matched: every permanent refusal read as
  // "retry", and a visit the server would never accept sat in the queue for a week. It failed safe
  // — nothing was deleted — but the queue could not drain and the rep's line would never clear.
  //
  // Resolving against `db.ts`'s own REFUSALS table rather than a second hard-coded list is what
  // makes this a pin and not a restatement: rename a refusal there and this goes red.
  {
    const db = source("src/lib/phoenix-crm/server/db.ts");

    // The prefix is built, not written, so read it from the line that builds it.
    assert.ok(
      /new ApiError\(refusal\.status, `phoenix_crm_\$\{match\[1\]\}`/.test(db),
      "🔴 db.ts no longer builds the wire code as `phoenix_crm_<name>` — the settled list's spelling is derived from that line",
    );

    const start = db.indexOf("const REFUSALS");
    const table = db.slice(start, db.indexOf("\n};", start));
    const known = new Set([...table.matchAll(/(^|\n)\s{2}([a-z_]+):/g)].map((match) => `phoenix_crm_${match[2]}`));
    assert.ok(known.size >= 20, `REFUSALS was read as ${known.size} entries, so this test swept almost nothing`);

    for (const code of OUTBOX_SETTLED_CODES) {
      assert.ok(
        known.has(code),
        `🔴 "${code}" is not a refusal the server can send — a settled code the server never emits deletes nothing and settles nothing`,
      );
      assert.ok(code.startsWith("phoenix_crm_"), `"${code}" must be the API spelling, underscore and not colon`);
      assert.equal(code.includes(":"), false, `🔴 "${code}" uses the database's colon spelling, which never reaches the phone`);
    }
  }

  console.log("phoenix-crm outbox: OK");
}
