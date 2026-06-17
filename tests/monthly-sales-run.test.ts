import assert from "node:assert/strict";

import { orderDistributors } from "../src/lib/sales/monthly-sales-run.ts";

export function runMonthlySalesRunTests() {
  // Brick-carrying distributors first (alphabetical by name), then Direct, then Office last —
  // regardless of the input order, so Office is always the final computed step.
  const ordered = orderDistributors([
    { code: "Office", name: "Office" },
    { code: "PS", name: "overseas" },
    { code: "Direct", name: "Direct (Company)" },
    { code: "IS", name: "Ibn sina" },
    { code: "EG", name: "EGD" },
  ]);

  assert.deepEqual(ordered.map((d) => d.code), ["EG", "IS", "PS", "Direct", "Office"]);

  // Direct and Office always sit at the tail in that order.
  const last = ordered[ordered.length - 1];
  const secondLast = ordered[ordered.length - 2];
  assert.equal(last.code, "Office");
  assert.equal(secondLast.code, "Direct");

  // When Direct/Office are absent, only the brick-carrying head is returned (no phantom tail rows).
  const headOnly = orderDistributors([
    { code: "SF", name: "sofico" },
    { code: "RM", name: "ramco" },
  ]);
  assert.deepEqual(headOnly.map((d) => d.code), ["RM", "SF"]);
  assert.ok(!headOnly.some((d) => d.code === "Office" || d.code === "Direct"));
}
