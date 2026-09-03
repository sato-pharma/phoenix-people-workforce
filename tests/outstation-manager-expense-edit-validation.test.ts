import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildManagerExpenseAdminPatch,
  isOutstationExpenseType,
  isOutstationTransportationType,
} from "../src/lib/outstation/manager-expense-input.ts";

// The PATCH admin route (app/api/admin/outstation/manager-expenses/[id]/route.ts) used to build
// its service input as `{ ...body, ...overrides }` — every request body field, whatever it was,
// landed on the service call untouched. The sibling POST route rejected an expenseType/
// transportationType outside the two taxonomies; the PATCH route never looked at either field.
// There is no CHECK constraint behind the columns either (added alongside this fix in
// supabase/migrations/20260903143000_outstation_expense_taxonomy_check_constraints.sql), so an
// edit could silently write any string into outstation_expense_requests.expense_type /
// .transportation_type — and updateManagerExpenseAsAdmin branches the fuel calculation on
// transportationType === "car", so an unrecognised mode quietly zeroed the fuel line with nothing
// on screen to say why.
//
// This pins the fix at both ends: the shared validator's own behaviour, and that both routes
// actually route through it instead of a route-local list that can drift or get skipped again.

export function runOutstationManagerExpenseEditValidationTests() {
  // ── buildManagerExpenseAdminPatch refuses an unknown expenseType ──────────────────────────
  {
    const result = buildManagerExpenseAdminPatch({ expenseType: "flight" });
    assert.equal(result.ok, false, "an expenseType outside the taxonomy must be refused, not forwarded");
    assert.equal(
      !result.ok && result.error,
      "invalid_expense_type",
      "the refusal must be the same error code the create route already used",
    );
  }

  // ── and an unknown transportationType ──────────────────────────────────────────────────────
  {
    const result = buildManagerExpenseAdminPatch({ transportationType: "helicopter" });
    assert.equal(result.ok, false, "a transportationType outside the taxonomy must be refused, not forwarded");
    assert.equal(
      !result.ok && result.error,
      "invalid_transportation_type",
      "the refusal must be the same error code the create route already used",
    );
  }

  // ── case variants are refused too — the stored value is what the dashboard groups on ──────
  {
    const result = buildManagerExpenseAdminPatch({ expenseType: "Traveling" });
    assert.equal(
      result.ok,
      false,
      "a case variant must be refused, not silently accepted — accepting it would let two spellings " +
        "of the same value split into two dashboard buckets",
    );
  }

  // ── valid values pass through by name ──────────────────────────────────────────────────────
  {
    const result = buildManagerExpenseAdminPatch({
      expenseType: "meeting",
      transportationType: "train",
    });
    assert.equal(result.ok, true, "a valid expenseType and transportationType must be accepted");
    assert.equal(result.ok && result.input.expenseType, "meeting");
    assert.equal(result.ok && result.input.transportationType, "train");
  }

  // ── the raw body is never spread — an unexpected field cannot reach the service input ─────
  {
    const result = buildManagerExpenseAdminPatch({
      employeeHrId: "A99",
      notes: "kept",
      somethingUnexpected: "should not appear",
      transportationType: "car",
    });
    assert.equal(result.ok, true);
    const input = result.ok ? result.input : {};
    assert.equal(
      "somethingUnexpected" in input,
      false,
      "a field this validator does not know about must not reach the service input — the whole " +
        "point of building the patch by field name instead of spreading the body",
    );
    assert.equal(
      "employeeHrId" in input,
      false,
      "employeeHrId must never be forwarded from an edit — an edit reprices a trip, it never " +
        "moves it to another employee",
    );
    assert.equal(input.notes, "kept", "a field the validator does know about is still forwarded");
  }

  // ── partial-update semantics: a field absent from the body stays absent from the patch ────
  {
    const result = buildManagerExpenseAdminPatch({ notes: "only this changed" });
    assert.equal(result.ok, true);
    const input = result.ok ? result.input : {};
    assert.equal(
      "expenseType" in input,
      false,
      "a key the caller never sent must not appear in the patch at all — " +
        "updateManagerExpenseAsAdmin reads `\"x\" in input` to decide whether to keep the stored " +
        "value, so an injected key (even set to undefined) would look like an explicit edit",
    );
    assert.equal(
      "transportationType" in input,
      false,
      "same guarantee for transportationType",
    );
  }

  // ── an explicit null on an optional text field is preserved, not upgraded to a stored value ─
  {
    const result = buildManagerExpenseAdminPatch({ hrNotes: null });
    assert.equal(result.ok, true);
    const input = result.ok ? result.input : {};
    assert.equal("hrNotes" in input, true, "an explicitly-sent field must be present in the patch");
    assert.equal(input.hrNotes, null, "an explicit null clears the field rather than being dropped");
  }

  // ── isOutstationExpenseType / isOutstationTransportationType agree with the builder ────────
  assert.equal(isOutstationExpenseType("traveling"), true);
  assert.equal(isOutstationExpenseType("flight"), false);
  assert.equal(isOutstationTransportationType("bus"), true);
  assert.equal(isOutstationTransportationType("helicopter"), false);

  // ── wiring: the PATCH route calls the shared validator and never spreads the body again ────
  const patchRoute = readFileSync(
    new URL(
      "../app/api/admin/outstation/manager-expenses/[id]/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    patchRoute,
    /buildManagerExpenseAdminPatch\(/,
    "the PATCH route must build its service input through buildManagerExpenseAdminPatch",
  );
  assert.doesNotMatch(
    patchRoute,
    /\.\.\.\s*body/,
    "the PATCH route must never spread the raw request body into the service input again — " +
      "that is the exact defect this test exists to catch",
  );

  // ── wiring: the POST route shares the same taxonomy instead of its own hardcoded list ──────
  const postRoute = readFileSync(
    new URL("../app/api/admin/outstation/manager-expenses/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    postRoute,
    /isOutstationExpenseType\(/,
    "the POST route must validate expenseType through the shared helper, not a route-local list " +
      "that can drift out of sync with the PATCH route",
  );
  assert.match(
    postRoute,
    /isOutstationTransportationType\(/,
    "the POST route must validate transportationType through the shared helper for the same reason",
  );
}
