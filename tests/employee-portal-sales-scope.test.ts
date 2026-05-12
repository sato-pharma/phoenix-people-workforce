import assert from "node:assert/strict";

import {
  createPortalSalesLineScope,
  employeeMatchesPortalSalesScope,
  portalSalesLinesMatch,
  salesRecordMatchesPortalSalesScope,
} from "../src/lib/employee-portal/sales-scope.ts";

export function runEmployeePortalSalesScopeTests() {
  assert.equal(portalSalesLinesMatch("Pedia", "Pedia line"), true);
  assert.equal(portalSalesLinesMatch("Anti-Infective", "Anti Infective line"), true);
  assert.equal(portalSalesLinesMatch("Anti Inf", "Anti Infective"), true);
  assert.equal(portalSalesLinesMatch("CNS", "Pedia"), false);

  const pediaScope = createPortalSalesLineScope({
    fallbackLine: "Pedia",
    lineId: 7,
    lineName: "Pedia line",
  });

  assert.equal(
    employeeMatchesPortalSalesScope({ lineId: 7, lineName: "Wrong display" }, pediaScope),
    true,
  );
  assert.equal(
    employeeMatchesPortalSalesScope({ lineId: null, lineName: "Pedia" }, pediaScope),
    true,
  );
  assert.equal(
    employeeMatchesPortalSalesScope({ lineId: 8, lineName: "CNS" }, pediaScope),
    false,
  );

  assert.equal(salesRecordMatchesPortalSalesScope({ line: "Pedia" }, pediaScope), true);
  assert.equal(salesRecordMatchesPortalSalesScope({ line: "CNS" }, pediaScope), false);
  assert.equal(salesRecordMatchesPortalSalesScope({ line: null }, pediaScope), true);
}
