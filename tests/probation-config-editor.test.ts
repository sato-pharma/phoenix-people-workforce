import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_PROBATION_CONFIG,
  ProbationConfigValidationError,
  saveProbationConfig,
  type ProbationConfigInput,
} from "../src/lib/probation/intelligence/config.ts";

function src(p: string) { return readFileSync(p, "utf8"); }

function validInput(): ProbationConfigInput {
  const d = DEFAULT_PROBATION_CONFIG;
  return {
    requirements: { ...d.requirements },
    roleWeights: { ...d.roleWeights },
    scoringScale: { ...d.scoringScale },
    sla: { ...d.sla },
    scorecardDimensions: [...d.scorecardDimensions],
    hrAssessmentEnabled: d.hrAssessmentEnabled,
  };
}

async function expectReject(input: ProbationConfigInput, needle: string) {
  await assert.rejects(
    () => saveProbationConfig(input, { loginId: "tester" }),
    (e: unknown) => e instanceof ProbationConfigValidationError && e.issues.some((i) => i.toLowerCase().includes(needle)),
    `expected validation error mentioning "${needle}"`,
  );
}

export function runProbationConfigEditorTests() {
  // Validation rejects bad input BEFORE any DB write (pure validation path).
  return (async () => {
    await expectReject({ ...validInput(), requirements: { dm: -1, tm: 1, pm_gpm: 1, nsm: 1 } }, "requirement");
    await expectReject({ ...validInput(), roleWeights: { dm: 0, tm: 0, pm_gpm: 0, nsm: 0, sfe: 0, hr: 0 } }, "weight");
    await expectReject({ ...validInput(), scoringScale: { min: 5, max: 5 } }, "scale");
    await expectReject({ ...validInput(), sla: { dueHours: 72, escalateHours: 48, overdueHours: 24 } }, "non-decreasing");
    await expectReject({ ...validInput(), scorecardDimensions: [] }, "dimension");

    // Wiring guarantees (source assertions — save touches the DB).
    const cfg = src("src/lib/probation/intelligence/config.ts");
    assert.match(cfg, /clearProbationConfigCache\(\);/, "save clears the config cache");
    assert.match(cfg, /entityType: "probation_config"/, "save writes an audit entry");
    assert.match(cfg, /scorecard_dimensions: input\.scorecardDimensions/, "save persists scorecard dimensions");
    assert.match(cfg, /hr_assessment_enabled: input\.hrAssessmentEnabled/, "save persists the HR toggle");

    // Route: GET/PATCH gated at probation:update + CSRF on PATCH.
    const route = src("app/api/probation/config/route.ts");
    assert.match(route, /assertPermission\(access, "probation", "update"\)/, "config route is admin-only");
    assert.match(route, /assertSameOriginMutation/, "config PATCH is CSRF-guarded");
    // Admin page gated to probation administrators.
    const page = src("app/(admin)/admin/probation-settings/page.tsx");
    assert.match(page, /isProbationAdministrator\(access\)/, "settings page is admin-only");
  })();
}
