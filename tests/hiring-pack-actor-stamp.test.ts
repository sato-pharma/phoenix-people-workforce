import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { updatedByStamp } from "../src/lib/hiring-pack/service.ts";

/**
 * A hiring profile must not forget who last edited it.
 *
 * ── THE INCIDENT ────────────────────────────────────────────────────────────────────────────
 *
 * Measured on production 2026-09-05: `employee_hiring_profile.updated_by_hr_id` for Nada Saed
 * (B-129) held Omar's id at 14:05 Cairo and was EMPTY by 15:27. Nobody deleted it. An ordinary
 * save wrote NULL over it, with no error and no history.
 *
 * Both savers take the actor as OPTIONAL, both routes pass `access.hrId ?? null`, and the column
 * was written on every save. So any signed-in person with no linked HR id — the `admin-HR` account
 * carries a NULL `hr_id` BY DESIGN — erased whoever was recorded before them.
 *
 * ── WHY AN EMPTY OBJECT AND NOT A FALLBACK ──────────────────────────────────────────────────
 *
 * An absent key is left out of the upsert's SET clause, so the stored value survives. That is the
 * same mechanism `versionStamp` in the same file already relies on to stamp a contract's template
 * version once and never rewrite it — this is not a new trick, it is the one already in use here.
 *
 * A marker such as "system" would be WORSE than the erase: an empty column reads as "not
 * recorded", but SYSTEM reads as a fact, and the claims screen would answer "who edited this" with
 * a shouty non-person. The same reasoning already guards outstation's approved_by.
 *
 * ── THE ASSERTION THAT MATTERS MOST IS THE LAST ONE ─────────────────────────────────────────
 *
 * It is not about these three call sites. An optional field written unconditionally is a silent
 * erase, and the PATTERN regenerates: the next satellite table with an actor column gets written
 * by somebody copying one of these upserts. So the sweep refuses a direct write anywhere in the
 * file, which is what a copy would produce.
 */
export function runHiringPackActorStampTests() {
  // ── nobody known: stamp NOTHING, so the upsert leaves the stored value alone ───────────────
  for (const nobody of [null, undefined, "", "   ", "\t"]) {
    assert.deepEqual(
      updatedByStamp(nobody),
      {},
      `an actor of ${JSON.stringify(nobody)} must produce NO key at all. A key holding null is `
        + "written into the upsert's SET clause and erases the previous editor - which is exactly "
        + "what happened to B-129 at 15:27 Cairo on 2026-09-05",
    );
    assert.equal(
      "updated_by_hr_id" in updatedByStamp(nobody),
      false,
      "the key must be ABSENT, not present-and-empty - present is what does the damage",
    );
  }

  // ── somebody known: stamp them, canonically ────────────────────────────────────────────────
  assert.deepEqual(
    updatedByStamp("b-10"),
    { updated_by_hr_id: "B-10" },
    "a real editor must be recorded in the casing employees.hr_id stores - AccessContext.hrId holds "
      + "the lowercase comparison key, and storing that is the bug this file's sibling test guards",
  );
  assert.deepEqual(updatedByStamp("  B-10  "), { updated_by_hr_id: "B-10" }, "surrounding whitespace never reaches storage");
  assert.deepEqual(updatedByStamp("aaa"), { updated_by_hr_id: "AA" }, "the legacy alias resolves to the live id");

  // A marker must never be substituted for a missing person.
  for (const stamped of [updatedByStamp(null), updatedByStamp(undefined)]) {
    assert.equal(
      JSON.stringify(stamped).toLowerCase().includes("system"),
      false,
      "no marker may stand in for an unknown editor - an empty column reads as 'not recorded', "
        + "SYSTEM reads as a fact",
    );
  }

  // ── THE PATTERN, not the three call sites ─────────────────────────────────────────────────
  const service = readFileSync("src/lib/hiring-pack/service.ts", "utf8");

  const direct: string[] = [];
  service.split("\n").forEach((line, index) => {
    // The helper's own return object is the one legitimate literal in the file.
    if (/^\s*return stored \? \{ updated_by_hr_id: stored \} : \{\};/.test(line)) return;
    if (/^\s*updated_by_hr_id:/.test(line)) direct.push(`${index + 1}: ${line.trim()}`);
  });
  assert.deepEqual(
    direct,
    [],
    "no upsert in this file may write updated_by_hr_id directly - spread `...updatedByStamp(actor)` "
      + "instead, so an unknown editor stamps nothing rather than erasing the last known one. This "
      + `is the assertion that survives the next satellite table:\n${direct.join("\n")}`,
  );

  // And every saver must actually carry the stamp - a sweep that only forbids the bad form would
  // pass just as happily on a file that stopped recording the editor at all.
  assert.equal(
    (service.match(/\.\.\.updatedByStamp\(/g) ?? []).length,
    3,
    "all three writers - the hiring profile, the offboarding profile and the document signature - "
      + "must stamp the editor. A dropped call would silently stop recording who edited a hiring record",
  );
}
