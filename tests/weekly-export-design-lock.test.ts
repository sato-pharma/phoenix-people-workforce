import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { LOCKED_EXPORTS } from "../scripts/weekly-export-design-fixtures.ts";
import { designFingerprint, describeDrift } from "../scripts/weekly-export-design-fingerprint.ts";
import type { DesignFingerprint } from "../scripts/weekly-export-design-fingerprint.ts";

// 🔒 THE WEEKLY BI AND NSM/DSM EXPORT DESIGNS ARE PASSWORD-LOCKED.
//
// Owner instruction, 2026-09-08: *"template design never change unless set this password"*, naming
// those two exports. Earlier the same day the BI design was pinned by literals sitting in a test
// file — real protection against an accidental restyle, and no protection at all against a session
// meeting the red and editing the literals to match. This is the version with a key.
//
// HOW IT WORKS. The pins live in `src/lib/sales/weekly/export-design.pins.json`, and the ONLY
// sanctioned way to rewrite them is `scripts/weekly-export-design-unlock.ts --unlock`, which asks
// for a password it verifies against a committed scrypt verifier. The password is not in this
// repository and cannot be derived from it.
//
// 🔴 IF THIS TEST IS RED, EDITING THE PINS FILE IS THE WRONG ANSWER. It is exactly the move the
// lock exists to catch. Either revert the design change, or take it to the owner and let him unlock.
// Hand-editing the pins is not a shortcut past that — it is the failure.
//
// WHAT IS LOCKED: the sheet set with its order and visibility, every column width, row height,
// merge, freeze pane, autofilter and conditional format, the style index on every cell, the whole
// style table, and the chart inventory.
//
// WHAT IS NOT, deliberately: cell VALUES and FORMULAS. A corrected number, a fixed formula or a
// re-worded label is not a design change and must never need the owner's password to ship.

const PINS_PATH = fileURLToPath(new URL("../src/lib/sales/weekly/export-design.pins.json", import.meta.url));
const LOCK_PATH = fileURLToPath(new URL("../src/lib/sales/weekly/export-design.lock.json", import.meta.url));

export async function runWeeklyExportDesignLockTests() {
  // ── the lock must be ARMED ──────────────────────────────────────────────────
  //
  // An unarmed lock reads exactly like an armed one from inside a session — the pins still compare,
  // the suite still goes green — while `--unlock` would have nothing to check a password against.
  // The Office golden rule carries the same hazard: before 2026-09-05 no verifier existed at all,
  // and a session reading the docs would have believed a password was in place when none was.
  assert.ok(existsSync(LOCK_PATH), "the design lock's scrypt verifier must exist — an unarmed lock is not a lock");
  const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
  assert.equal(lock.algorithm, "scrypt", "the verifier is scrypt");
  assert.ok(lock.N >= 131_072, `the work factor must stay at or above 2^17; found N=${lock.N}`);
  assert.ok(/^[0-9a-f]{32}$/.test(lock.salt ?? ""), "a 16-byte random salt");
  assert.ok(/^[0-9a-f]{128}$/.test(lock.verifier ?? ""), "a 64-byte derived key");
  // The password must not be recoverable from what is committed.
  assert.ok(
    !("password" in lock) && !("secret" in lock) && !("plain" in lock),
    "the lock file must hold a VERIFIER and never the password itself — a plaintext passphrase in a " +
      "committed file was tried here on 2026-07-31 and removed because it authenticated nobody",
  );

  assert.ok(existsSync(PINS_PATH), "the design pins must exist");
  const pins = JSON.parse(readFileSync(PINS_PATH, "utf8")) as Record<string, DesignFingerprint>;

  // ── every locked export still builds the design that is pinned ──────────────
  for (const item of LOCKED_EXPORTS) {
    const expected = pins[item.key];
    assert.ok(expected, `${item.label}: no pin recorded — the lock covers it, so it must be pinned`);

    // A positive control before judging: an empty workbook satisfies "nothing drifted" vacuously.
    assert.ok(
      expected.sheets.length > 1,
      `${item.label}: the pin itself must describe a real multi-sheet workbook`,
    );

    const actual = await designFingerprint(await item.build());
    assert.ok(
      actual.sheets.length > 1,
      `${item.label}: the fixture must build a real workbook before its design can be judged`,
    );

    const drift = describeDrift(expected, actual);
    assert.deepEqual(
      drift,
      [],
      `${item.label}: THE DESIGN IS LOCKED by owner instruction (2026-09-08).\n` +
        drift.map((line) => `    - ${line}`).join("\n") +
        `\n    Re-pinning is NOT the fix. Revert the change, or have the owner run:\n` +
        `      node --experimental-strip-types --experimental-specifier-resolution=node \\\n` +
        `        --experimental-loader ./tests/alias-loader.mjs \\\n` +
        `        scripts/weekly-export-design-unlock.ts --unlock`,
    );
  }

  // ── and the lock covers BOTH exports the owner named ────────────────────────
  assert.deepEqual(
    LOCKED_EXPORTS.map((item) => item.key).sort(),
    ["bi", "nsmDsm"],
    "the owner named the weekly BI export and the weekly NSM/DSM export — dropping one from the " +
      "locked set would silently unlock it while every assertion above still passed",
  );
}
