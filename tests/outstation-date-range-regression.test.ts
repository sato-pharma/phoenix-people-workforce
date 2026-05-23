import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runOutstationDateRangeRegressionTests() {
  const calculateRouteSource = readFileSync("app/api/outstation/calculate/route.ts", "utf8");
  const wizardSource = readFileSync("src/components/outstation/mobile-outstation-wizard.tsx", "utf8");

  assert.match(
    calculateRouteSource,
    /const tripStartDate = String\(body\.tripStartDate\s*\?\?\s*""\);\s*\n\s*const tripEndDate = String\(body\.tripEndDate\s*\?\?\s*""\);/,
    "calculate API should parse tripStartDate and tripEndDate before calculation",
  );

  assert.match(
    calculateRouteSource,
    /Number\.isFinite\(parsedTripStartDate\)\s*&&\s*Number\.isFinite\(parsedTripEndDate\)\s*&&\s*parsedTripEndDate < parsedTripStartDate/, 
    "calculate API should compare tripStartDate and tripEndDate for reversed ranges",
  );

  assert.match(
    calculateRouteSource,
    /\{\s*error:\s*"invalid_date_range"\s*,\s*message:\s*"End date cannot be before start date"\s*\},\s*\{\s*status:\s*400\s*\}/,
    "calculate API should return invalid_date_range 400 payload when end date precedes start date",
  );

  assert.ok(
    wizardSource.includes('const parsedTripStartDate = useMemo(() => {'),
    "wizard should parse trip start date for date-range comparison",
  );
  assert.ok(
    wizardSource.includes("return parsedTripEndDate < parsedTripStartDate ? \"End date cannot be before start date\" : \"\";"),
    "wizard should emit the specific reversed date-range message",
  );
  assert.ok(
    wizardSource.includes("const isTripDateRangeInvalid = tripDateRangeError.length > 0;"),
    "wizard should expose a boolean invalid-range flag",
  );
  assert.ok(
    wizardSource.includes("!isTripDateRangeInvalid"),
    "wizard should gate range-dependent behavior on reversed date detection",
  );
  assert.ok(
    wizardSource.includes("const calculationKey = useMemo(() => {") &&
      wizardSource.includes("if (!captured || !tripStartDate || !tripEndDate || isTripDateRangeInvalid) return \"\";"),
    "wizard should prevent calculation key generation when date range is invalid",
  );
  assert.ok(
    wizardSource.includes("isTripDateRangeInvalid"),
    "wizard source should include invalid-range handling in submit disabling logic",
  );
  assert.ok(
    wizardSource.includes('<p className="mt-1 text-xs font-bold text-red-700">{tripDateRangeError}</p>'),
    "wizard should render inline reversed-range error next to To Date input",
  );
}
