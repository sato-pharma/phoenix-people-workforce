// Source of Sales — auto-detect the distributor from a raw file's header row (PURE, no I/O,
// unit-tested). Each distributor profile declares which raw column headers carry what; this scores
// the uploaded file's headers against every profile so the importer can pre-select the right
// distributor instead of making the user pick (and catch a wrong manual pick).
//
// A profile is a CANDIDATE only when ALL its required column groups are present (product, qty,
// customer code) — that keeps generic headers like "Qty" from matching the wrong distributor.
// Optional groups (customer name/address, value, discount, date, bonus) break ties, because those
// aliases are highly distributor-specific (e.g. "Address_En", "ORDERACCOUNT", "العميل").

export type DetectionProfile = {
  distributorCode: string;
  distributorName: string;
  // Each entry is one logical column group; the group MATCHES if ANY of its header aliases is present.
  requiredGroups: string[][];
  optionalGroups: string[][];
};

export type DistributorDetection = {
  distributorCode: string;
  distributorName: string;
  isCandidate: boolean; // every required group matched
  matchedOptional: number;
  matchedRequired: number;
  requiredTotal: number;
  score: number; // matchedRequired*10 + matchedOptional — required dominates, optional breaks ties
};

export type DetectionResult = {
  ambiguous: boolean; // 2+ candidates tied at the top score
  best: DistributorDetection | null; // top candidate when unambiguous, else null
  confidence: "high" | "low" | "none";
  matches: DistributorDetection[]; // all candidates, best-first
};

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function detectDistributor(headers: string[], profiles: DetectionProfile[]): DetectionResult {
  const headerSet = new Set(headers.map(normalizeHeader).filter(Boolean));
  const groupMatches = (group: string[]) => group.some((alias) => headerSet.has(normalizeHeader(alias)));

  const detections: DistributorDetection[] = profiles.map((profile) => {
    const required = profile.requiredGroups.filter((g) => g.length > 0);
    const optional = profile.optionalGroups.filter((g) => g.length > 0);
    const matchedRequired = required.filter(groupMatches).length;
    const matchedOptional = optional.filter(groupMatches).length;
    return {
      distributorCode: profile.distributorCode,
      distributorName: profile.distributorName,
      isCandidate: required.length > 0 && matchedRequired === required.length,
      matchedOptional,
      matchedRequired,
      requiredTotal: required.length,
      score: matchedRequired * 10 + matchedOptional,
    };
  });

  const candidates = detections
    .filter((d) => d.isCandidate)
    .sort((a, b) => b.score - a.score || a.distributorCode.localeCompare(b.distributorCode));

  if (candidates.length === 0) {
    return { ambiguous: false, best: null, confidence: "none", matches: [] };
  }

  const top = candidates[0];
  const tiedAtTop = candidates.filter((d) => d.score === top.score);
  const ambiguous = tiedAtTop.length > 1;

  // High confidence only when a single candidate clearly beats the rest (or is the only one).
  const confidence: DetectionResult["confidence"] = ambiguous
    ? "low"
    : candidates.length === 1 || top.score > candidates[1].score
      ? "high"
      : "low";

  return { ambiguous, best: ambiguous ? null : top, confidence, matches: candidates };
}
