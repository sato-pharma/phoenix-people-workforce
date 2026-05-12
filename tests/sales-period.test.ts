import assert from "node:assert/strict";

import {
  extractSalesPeriodFromFileName,
  salesPeriodLabel,
  salesPeriodsMatch,
} from "../src/lib/sales/period.ts";

export function runSalesPeriodTests() {
  assert.deepEqual(extractSalesPeriodFromFileName("CNS JAN 2026 closing.xlsx"), {
    month: 1,
    year: 2026,
  });
  assert.deepEqual(extractSalesPeriodFromFileName("Pedia 2026-04 closing.xlsx"), {
    month: 4,
    year: 2026,
  });
  assert.deepEqual(extractSalesPeriodFromFileName("Anti Inf 02_2026.xlsx"), {
    month: 2,
    year: 2026,
  });
  assert.equal(extractSalesPeriodFromFileName("closing sheet.xlsx"), null);
  assert.equal(salesPeriodLabel({ month: 1, year: 2026 }), "2026-01");
  assert.equal(
    salesPeriodsMatch({ month: 1, year: 2026 }, { month: 1, year: 2026 }),
    true,
  );
  assert.equal(
    salesPeriodsMatch({ month: 1, year: 2026 }, { month: 3, year: 2026 }),
    false,
  );
}
