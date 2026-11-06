import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describeAlreadyLocked, isActiveLockConflict } from "../src/lib/sales/monthly-closing-lock-conflict.ts";
import { stripComments } from "./support/comment-strip.ts";

// A LOCK REQUEST FOR A MONTH THAT IS ALREADY LOCKED IS NOT AN ERROR.
//
// Production, 2026-11-04: the owner PUBLISHED Anti Infective 2026-10 and the publication trigger
// locked the month in the same transaction (lock and publication both stamped 17:36:45.851168 UTC).
// The screen did not re-read the lock after Publish, so it still offered "Lock month"; his press 14
// seconds later lost to the unique index `monthly_closing_locks_one_active` (23505), he was told
// "Lock request failed." and two app_error_events rows were written about a month that was exactly
// as locked as he wanted it.
//
// Pinned here: the conflict is recognised; it is answered "already locked, by whom, when" with a
// 200 and no error row; the screen re-reads the lock after a Publish; and a second press cannot send
// a second request while the first is in flight.

function code(relativePath: string): string {
  return stripComments(readFileSync(join(process.cwd(), relativePath), "utf8"));
}

export function runMonthlyClosingLockAlreadyLockedTests() {
  // ── 1. The production error is recognised as "already locked" ─────────────
  // The shape PostgREST returned on 2026-11-04 (a plain object, not an Error).
  const productionConflict = {
    code: "23505",
    details: "Key (normalized_line, period)=(anti infective, 2026-10) already exists.",
    hint: null,
    message: 'duplicate key value violates unique constraint "monthly_closing_locks_one_active"',
  };
  assert.equal(isActiveLockConflict(productionConflict), true, "the 2026-11-04 23505 must read as already locked");
  assert.equal(
    isActiveLockConflict({ code: "23505", message: 'duplicate key value violates unique constraint "monthly_closing_locks_pkey"' }),
    false,
    "a unique violation on any other constraint is a real failure, not an already-locked month",
  );
  assert.equal(
    isActiveLockConflict({ code: "57014", message: "monthly_closing_locks_one_active" }),
    false,
    "only a unique violation means the month already holds a lock",
  );
  assert.equal(isActiveLockConflict(null), false);
  assert.equal(isActiveLockConflict(new Error("Lock request failed.")), false);

  // ── 2. The answer names the month, the person and the Cairo time ───────────
  assert.equal(
    describeAlreadyLocked({
      line: "Anti Infective",
      lockedAt: "2026-11-04T17:36:45.851168+00:00",
      lockedByName: "Omar Gawish",
      period: "2026-10",
    }),
    "October 2026 Anti Infective is already locked, by Omar Gawish at 04 Nov 2026 · 19:36 Cairo time.",
    "the sentence is the month, the line, the display name and the Cairo time — never an HR id or UTC",
  );
  assert.equal(
    describeAlreadyLocked({ line: "Anti Infective", lockedAt: "", lockedByName: null, period: "2026-10" }),
    "October 2026 Anti Infective is already locked.",
    "a name or time that could not be read is left out, never replaced by an id, a dash or 'now'",
  );

  // ── 3. The service answers it as success and writes no error row ───────────
  const service = code("src/lib/sales/monthly-closing-lock.ts");
  const lockBody = service.slice(service.indexOf("export async function lockClosing("), service.indexOf("export async function unlockClosing("));
  const precheck = lockBody.indexOf("await getClosingLock(line, period)");
  const rpc = lockBody.indexOf('rpc("phx_lock_monthly_closing"');
  assert.ok(precheck > 0 && rpc > 0 && precheck < rpc, "an existing lock is read BEFORE the RPC, which would otherwise build a whole snapshot to lose to the index");
  // The exact condition, so a branch disabled in place (`if (false && …)`) still reads as missing.
  const conflict = lockBody.indexOf("if (error && isActiveLockConflict(error)) {");
  const logged = lockBody.indexOf('logError("Failed to lock a monthly closing"');
  assert.ok(conflict > rpc, "the RPC's 23505 (two requests racing) must be recognised");
  assert.ok(logged > conflict, "the already-locked branch must return BEFORE the error is logged — that log is the app_error_events row");
  assert.match(
    lockBody.slice(conflict, logged),
    /return alreadyLocked\(/,
    "the conflict branch must RETURN the existing lock, not fall through to the error path",
  );
  assert.ok(!/unlock|phx_unlock_monthly_closing/.test(lockBody), "answering an already-locked month must never release or replace its lock");

  // ── 4. The route answers 200 with the sentence, not "Lock request failed." ──
  const route = code("app/api/sales/monthly-closing/lock/route.ts");
  const post = route.slice(route.indexOf("export async function POST("), route.indexOf("export async function DELETE("));
  assert.match(post, /if \(result\.alreadyLocked\)/, "the route must branch on an already-locked month");
  assert.match(post, /alreadyLocked: true,[^}]*message: result\.message/, "the already-locked answer carries the sentence");

  // ── 5. The screen: no second request in flight, and Publish re-reads the lock ──
  const screen = code("src/components/sales/monthly-closing-workspace.tsx");
  const toggle = screen.slice(screen.indexOf("async function toggleLock("), screen.indexOf("async function togglePublish("));
  const guard = toggle.indexOf("if (lockRequestInFlight.current) return;");
  const fetchAt = toggle.indexOf("await fetch(");
  assert.ok(guard > 0 && guard < fetchAt, "a press while a lock request is in flight must return before any fetch");
  assert.ok(toggle.indexOf("lockRequestInFlight.current = true;") < fetchAt, "the in-flight mark is set before the first await");
  assert.match(toggle, /finally \{[\s\S]*lockRequestInFlight\.current = false;/, "the mark is cleared however the request ends");
  assert.match(toggle, /payload\.alreadyLocked && payload\.message\) setLockNotice\(payload\.message\)/, "already locked is shown as a notice, never through setError");
  const publish = screen.slice(screen.indexOf("async function togglePublish("), screen.indexOf("async function reload("));
  assert.match(publish, /if \(method === "POST"\) setLockReadVersion\(/, "a Publish locks the month in the database, so the screen must read the lock again");
  assert.match(
    screen,
    /fetch\(`\/api\/sales\/monthly-closing\/lock\?[\s\S]*?\}, \[canPublish, selectedLine, selectedPeriod, lockReadVersion\]\);/,
    "the lock read must re-run when lockReadVersion moves",
  );

  // ── 6. A database outage (2026-11-06 03:27 Cairo) ─────────────────────────
  // The sign-in check met Cloudflare 521, the lock read's error body became "not locked", the
  // screen offered "Lock month" on a month locked since 4 Nov, and the press printed raw JSON.
  const mapError = route.slice(route.indexOf("function mapError("), route.indexOf("export async function GET("));
  const outage = mapError.indexOf("if (isSessionVerificationUnavailable(error)) {");
  assert.ok(outage > 0, "a sign-in check the database could not answer must be recognised");
  assert.ok(outage < mapError.indexOf('"Lock request failed."'), "the outage is answered before the generic 500");
  assert.match(mapError.slice(outage), /DATABASE_UNREACHABLE_MESSAGE \}, \{ status: 503 \}/, "an outage is a 503 with a sentence, never a masked 500");
  assert.match(route, /nothing was changed/, "the outage sentence says the month was not changed");

  const lockRead = screen.slice(
    screen.indexOf("fetch(`/api/sales/monthly-closing/lock?"),
    screen.indexOf("[canPublish, selectedLine, selectedPeriod, lockReadVersion]"),
  );
  const okCheck = lockRead.indexOf("if (!response.ok) throw");
  assert.ok(okCheck > 0 && okCheck < lockRead.indexOf("setLocked(Boolean(payload.locked))"), "a failed lock read is UNKNOWN, never read as 'not locked'");

  const failed = toggle.slice(toggle.indexOf("if (!response.ok) {"), toggle.indexOf("const payload ="));
  assert.match(failed, /JSON\.parse\(text\) as \{ error\?: unknown \}\)\.error/, "a failed press shows the route's sentence, never the raw JSON");
  assert.match(failed, /setLockReadVersion\(/, "a failed press reads the lock again so the button tells the truth");
}
