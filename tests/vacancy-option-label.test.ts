import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { formatVacancyOptionLabel } from "../src/lib/employees/vacancy-option-label.ts";

// The Employee Master "Operating Area" picker lists OPEN vacancies, and a vacancy carries the
// area the leaver personally sat in -- for a manager seat, one arbitrary area out of the district
// the seat runs. The Pedia district manager post covering Alex East / Alex Center / Alex West /
// Behira 1 / Behira 2 / Kafr El-Sheikh 1 opened as plain "Behira 1", so the owner (who knows that
// seat as Alex-BHR-KFS) read the list as not holding it at all and could not hire the replacement.
// The region was on the vacancy row the whole time and was simply never printed.

export async function runVacancyOptionLabelTests() {
  // The real production row: vacancy VAC-B74-D2K, opened for the Pedia district manager seat.
  const districtManagerVacancy = {
    areaName: "Behira 1",
    managerName: "Hany Saad Mohamed Omar",
    positionTitle: "District Sales Manager",
    regionName: "Alex-BHR",
  };

  const label = formatVacancyOptionLabel(districtManagerVacancy);
  assert.equal(
    label,
    "Behira 1 (Alex-BHR) - District Sales Manager - Manager: Hany Saad Mohamed Omar",
    "a district vacancy must name its district, not only the leaver's own area",
  );
  assert.ok(
    label.includes("Alex-BHR"),
    "the headline assertion: the district name must be findable in the option text",
  );

  // A single-area district must not print its own name twice.
  assert.equal(
    formatVacancyOptionLabel({
      areaName: "Cairo",
      managerName: "Ali Mohamed Ali Elsayed",
      positionTitle: "District Sales Manager",
      regionName: "Cairo",
    }),
    "Cairo - District Sales Manager - Manager: Ali Mohamed Ali Elsayed",
    "a region identical to the area adds nothing and must be dropped",
  );

  assert.equal(
    formatVacancyOptionLabel({
      areaName: "cairo",
      managerName: null,
      positionTitle: "Medical Representative",
      regionName: "  Cairo  ",
    }),
    "cairo - Medical Representative",
    "the same-name check ignores casing and padding, and a manager-less vacancy drops that segment",
  );

  // Older rows carry no region at all; they must read exactly as they did before.
  assert.equal(
    formatVacancyOptionLabel({
      areaName: "Haram - Faisal",
      managerName: "Mahmoud Eldaly",
      positionTitle: "Medical Representative",
      regionName: null,
    }),
    "Haram - Faisal - Medical Representative - Manager: Mahmoud Eldaly",
    "a vacancy with no region keeps its previous label",
  );

  // An area-less vacancy (production holds one) still has to say where it is.
  assert.equal(
    formatVacancyOptionLabel({
      areaName: null,
      managerName: "Sara Samir Jacoub Yohana",
      positionTitle: "Medical Representative",
      regionName: "Alex-BHR",
    }),
    "Alex-BHR - Medical Representative - Manager: Sara Samir Jacoub Yohana",
    "with no area the region carries the placement rather than printing an empty segment",
  );

  assert.equal(
    formatVacancyOptionLabel({ areaName: null, managerName: null, positionTitle: null, regionName: null }),
    "",
    "an empty vacancy yields an empty label, never stray separators",
  );

  // The picker must render through the helper -- an inline template literal in the component is
  // exactly how the region went missing, and a pure-function test alone would not see it come back.
  const componentPath = path.join(
    process.cwd(),
    "src",
    "components",
    "employees",
    "employee-management.tsx",
  );
  const component = fs.readFileSync(componentPath, "utf8");
  assert.ok(
    component.includes("formatVacancyOptionLabel(v)"),
    "the vacancy picker must build its option text with formatVacancyOptionLabel",
  );
  assert.ok(
    !/label: v\.managerName/.test(component),
    "the inline vacancy label must not come back into the component",
  );
}
