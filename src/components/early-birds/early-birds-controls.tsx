import type { EarlyBirdsPeriod } from "@/lib/early-birds/period";
import type { EarlyBirdsDistrict } from "@/lib/early-birds/permissions";
import { EarlyBirdsDistrictSwitcher } from "./early-birds-district-switcher";
import { EarlyBirdsPeriodSwitcher } from "./early-birds-period-switcher";

// The board's two questions — WHOSE reps, and WHICH fortnight — in one object.
//
// They were separate bars, one of which did not exist. Putting them in a single hairline-divided
// card is the point rather than decoration: a ranking is only meaningful once both are pinned, and
// two floating bars invite reading the ranking while having answered only one of them.

export function EarlyBirdsControls({
  basePath,
  districts,
  selectedDistrict,
  scopeLabel,
  periods,
  selectedPeriodKey,
  livePeriodKey,
  repHrId,
}: {
  basePath: string;
  districts: EarlyBirdsDistrict[];
  selectedDistrict: EarlyBirdsDistrict;
  scopeLabel?: string;
  periods: EarlyBirdsPeriod[];
  selectedPeriodKey: string;
  livePeriodKey: string;
  repHrId?: string | null;
}) {
  return (
    <div className="border border-slate-200 bg-white">
      <EarlyBirdsDistrictSwitcher
        basePath={basePath}
        districts={districts}
        periodKey={selectedPeriodKey}
        repHrId={repHrId}
        scopeLabel={scopeLabel}
        selectedHrIdKey={selectedDistrict.hrIdKey}
      />
      {/* The house hairline — a 1px rule, not a bordered box around each row. */}
      <div className="h-px bg-slate-200" />
      <EarlyBirdsPeriodSwitcher
        basePath={basePath}
        district={selectedDistrict.hrId}
        livePeriodKey={livePeriodKey}
        periods={periods}
        repHrId={repHrId}
        selectedPeriodKey={selectedPeriodKey}
      />
    </div>
  );
}
