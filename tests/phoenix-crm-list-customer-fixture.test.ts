import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { LIST_CUSTOMER_BASE, listCustomer } from "./support/phoenix-crm-list-customer.ts";

/**
 * Holds the ONE `ListCustomer` fixture in place.
 *
 * `tsc` went red three times on 2026-09-30 — `sharedWith` + `observed`, then `planPattern`, then
 * `referenceHistory` — because two test files each restated the whole type and both had to be
 * remembered. Each round was a full CI run on a PR whose real change was fine. Both files carried a
 * pasted comment telling the next person to keep two copies in step; it was ignored three times, so
 * it was never a control.
 *
 * This is the control. It fails if either file grows its own field list again, which is the only way
 * the drift can come back.
 */

/** The two files that build a `ListCustomer`, and the shared builder they must go through. */
const CONSUMERS = [
  "tests/phoenix-crm-customer-list-board.test.ts",
  "tests/phoenix-crm-validate-next.test.ts",
] as const;

/**
 * Fields no consumer needs to care about. If one of these is named in a consumer, that file has
 * started restating the type again — which is precisely the state this test exists to prevent.
 * They are chosen to be fields a *test* would never legitimately set: the three that caused the
 * three red runs, plus two more from the tail of the type.
 */
const FIELDS_ONLY_THE_BASE_SHOULD_NAME = [
  "sharedWith",
  "observed",
  "planPattern",
  "referenceHistory",
  "pendingDropRequestId",
] as const;

export function runPhoenixCrmListCustomerFixtureTests(): void {
  // ── 1. The builder returns the base, and an override replaces exactly one field ──────────────
  {
    const plain = listCustomer();
    assert.deepEqual(plain, LIST_CUSTOMER_BASE, "listCustomer() with no overrides is the base");
    assert.notEqual(plain, LIST_CUSTOMER_BASE, "and it is a COPY — a shared object would leak between tests");

    const named = listCustomer({ name: "Dr Who", visitsThisMonth: 7 });
    assert.equal(named.name, "Dr Who");
    assert.equal(named.visitsThisMonth, 7);
    assert.equal(named.status, LIST_CUSTOMER_BASE.status, "untouched fields keep the base's value");
    assert.equal(LIST_CUSTOMER_BASE.name, "Dr Test", "and the base itself is not mutated");
  }

  // ── 2. No field is left undefined ───────────────────────────────────────────────────────────
  // `tsc` accepts `foo: undefined` for a nullable field, so a hole can be added that typechecks and
  // then reads as "absent" to any code doing `in` or `Object.keys`. Null is the answer, never absent.
  {
    const holes = Object.entries(LIST_CUSTOMER_BASE)
      .filter(([, value]) => value === undefined)
      .map(([key]) => key);
    assert.deepEqual(
      holes,
      [],
      `these fields are \`undefined\` in the base fixture: ${holes.join(", ")}. Use null — a field `
        + "set to undefined typechecks but behaves as absent.",
    );
  }

  // ── 3. Neither consumer restates the type ───────────────────────────────────────────────────
  // The regression guard. A file that names these fields has grown its own full literal again, and
  // the next widening of ListCustomer will cost two red CI runs instead of one clear error.
  for (const file of CONSUMERS) {
    const source = readFileSync(file, "utf8");
    assert.match(
      source,
      /from "\.\/support\/phoenix-crm-list-customer\.ts"/,
      `${file} must build its customers through the shared fixture, not its own literal.`,
    );
    for (const field of FIELDS_ONLY_THE_BASE_SHOULD_NAME) {
      assert.doesNotMatch(
        source,
        new RegExp(`^\\s*${field}:`, "m"),
        `${file} names \`${field}\`, which only the shared base should set. That is the drift this `
          + "test exists to catch: two copies of a ~30-field type, and tsc went red three times in one "
          + "afternoon because only one of them was remembered.",
      );
    }
  }
}
