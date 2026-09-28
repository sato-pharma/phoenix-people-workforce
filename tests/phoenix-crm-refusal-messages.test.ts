import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — every refusal the database can raise has words a person can act on.
 *
 * ## The gap this closes
 *
 * `db.ts` turns a Postgres exception into an `ApiError`:
 *
 *     const refusal = REFUSALS[match[1]] ?? { status: 409, message: "This entry could not be saved…" };
 *     return new ApiError(refusal.status, `phoenix_crm_${match[1]}`, refusal.message);
 *
 * 🔴 **The fallback is why this cannot be caught by reading either side alone.** A refusal missing
 * from REFUSALS does not crash, does not log, and does not look wrong anywhere — it quietly becomes
 * "This entry could not be saved. Reload the page and try again." The CODE is still right, so a
 * screen branching on it behaves correctly; only the sentence the rep reads is useless.
 *
 * Found 2026-09-28 with six missing, four of them the voice note's whole family. A rep whose
 * recording slot had lapsed was told to reload a page, when the thing to do was record it again.
 * That is squarely against Golden Rule #1 — the rep's app is the simplest thing he touches — and it
 * is invisible until someone compares the two lists, which is what this test does.
 *
 * ## What is deliberately NOT counted
 *
 * `phoenix_crm:` is also the prefix of the module's advisory-lock keys — `phoenix_crm:plan:…`,
 * `phoenix_crm:seat:…`, `phoenix_crm:monthly:…`. Those are not exceptions and need no message, so
 * this reads only what is actually RAISED, rather than every occurrence of the prefix. Matching the
 * prefix alone reports five false positives and teaches the next session to ignore the test.
 */

const ROOT = new URL("../", import.meta.url);

/** Every `raise exception 'phoenix_crm:<name>'` across the migrations, unique. */
function raisedRefusals(): string[] {
  const dir = new URL("supabase/migrations/", ROOT);
  const found = new Set<string>();
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".sql"))) {
    const sql = readFileSync(new URL(name, dir), "utf8");
    for (const match of sql.matchAll(/raise\s+exception\s+'phoenix_crm:([a-z_]+)'/gi)) found.add(match[1]);
  }
  return [...found].sort();
}

export function runPhoenixCrmRefusalMessagesTests(): void {
  const db = stripComments(readFileSync(new URL("src/lib/phoenix-crm/server/db.ts", ROOT), "utf8"));

  // The fallback this test exists because of. If it ever goes away, so does the silent failure.
  assert.ok(
    db.includes('REFUSALS[match[1]] ?? {'),
    "db.ts no longer falls back for an unknown refusal — if it now throws or logs instead, this test is obsolete rather than merely passing",
  );

  const start = db.indexOf("const REFUSALS");
  assert.notEqual(start, -1, "REFUSALS is still declared by that name");
  const table = db.slice(start, db.indexOf("\n};", start));
  const known = new Set([...table.matchAll(/(^|\n)\s{2}([a-z_]+):/g)].map((match) => match[2]));
  assert.ok(known.size >= 40, `REFUSALS was read as ${known.size} entries, so this test swept almost nothing`);

  const raised = raisedRefusals();
  assert.ok(raised.length >= 40, `only ${raised.length} raises were found in the migrations — the sweep is looking at the wrong place`);

  // ── 🔴 The comparison ──────────────────────────────────────────────────────────────────────────
  const unmessaged = raised.filter((name) => !known.has(name));
  assert.deepEqual(
    unmessaged,
    [],
    `🔴 the database raises ${unmessaged.length} refusal(s) with no message of their own — ${unmessaged
      .map((name) => `phoenix_crm:${name}`)
      .join(", ")}. Each one reaches a rep as "This entry could not be saved. Reload the page and try again.", which names nothing he can do. Add a line to REFUSALS saying what actually went wrong and what to do about it.`,
  );

  // ── The voice note's four, named, because they are what this test was written for ─────────────
  for (const name of ["voice_not_issued", "voice_used", "voice_expired", "voice_missing"]) {
    assert.ok(known.has(name), `${name} must keep its own message — a lapsed recording tells the rep to re-record, never to reload`);
  }

  // ── 🔴 Both screens drop a refused recording, or the rep cannot save the visit at all ─────────
  //
  // The message is only half of it. If the note stays attached, every press of Save hits the SAME
  // refusal and a real visit can never be entered. The web screen always did this; the phone did
  // not, and the phone is where the recording is made.
  for (const [what, path] of [
    ["the web visit form", "src/components/phoenix-crm/visits-tab.tsx"],
    ["the phone's visit form", "mobile/src/features/crm/visits-screen.tsx"],
  ] as const) {
    const source = stripComments(readFileSync(new URL(path, ROOT), "utf8"));
    const branch = source.indexOf('startsWith("phoenix_crm_voice_")');
    assert.notEqual(branch, -1, `🔴 ${what} does not handle a refused recording — the rep would be stuck on the same refusal for ever`);
    // To the NEXT branch, not a fixed number of characters: `stripComments` blanks a comment's text
    // but keeps its length, so a well-explained branch is mostly whitespace and a window measured in
    // characters reads past none of it. The end of this branch is where the next one begins.
    const nextBranch = source.indexOf("} else if", branch);
    const body = source.slice(branch, nextBranch === -1 ? source.length : nextBranch);
    assert.ok(
      body.includes("setVoiceNote(null)"),
      `🔴 ${what} must DROP the refused recording, or Save keeps hitting the same wall`,
    );
    // The photo is a separate piece of evidence and the visit is still good without the note.
    assert.equal(
      body.includes("setPhoto(null)"),
      false,
      `${what} must not throw the photo away over a recording — that would send him back to the door for nothing`,
    );
  }

  console.log(`phoenix-crm refusal messages: OK (${raised.length} raised, all with their own words)`);
}
