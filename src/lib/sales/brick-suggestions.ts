// Source of Sales — smart brick suggestions (PURE, no I/O, unit-tested).
//
// When a customer in an upload has no mapping yet, we can often infer its brick from an ALREADY-mapped
// customer that has the SAME name + address — even under a different distributor (cross-distributor
// carry-over). This never resolves a brick on its own (the mapping sheet stays the sole source of
// truth); it only proposes a brick the admin confirms with one click, which then writes to the sheet.
//
// Confidence:
//   • high  — exact normalized NAME + ADDRESS match, and all matches point to ONE brick.
//   • low   — name-only match (no usable address), and all matches point to ONE brick.
//   • (skipped) — matches point to MORE THAN ONE distinct brick (ambiguous), or no match at all.

export type MappedCustomer = {
  address: string;
  brickId: string;
  customerCode: string;
  customerName: string;
  distributorCode: string;
};

export type UnmappedCustomer = {
  address: string;
  customerCode: string;
  customerName: string;
};

export type BrickSuggestion = {
  address: string;
  confidence: "high" | "low";
  customerCode: string;
  customerName: string;
  matchType: "name+address" | "name";
  sourceCustomerCode: string;
  sourceDistributorCode: string;
  suggestedBrickId: string;
};

// A suggestion enriched for the UI: the pure match + the brick's display name + the distributor the
// accepted mapping will be written under (the UPLOAD distributor, not the source of the match). Lives
// here (a pure, client-safe module) so the preview modal can import the type without pulling server code.
export type BrickSuggestionView = BrickSuggestion & { brickName: string; distributorCode: string };

function norm(value: string): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // drop punctuation (keep letters/numbers across scripts incl. Arabic)
    .replace(/\s+/g, " ")
    .trim();
}

type BrickHit = { brickId: string; sourceCustomerCode: string; sourceDistributorCode: string };

// One bucket = one normalized key → the distinct bricks seen for it (first sample kept per brick).
class KeyIndex {
  private readonly map = new Map<string, Map<string, BrickHit>>();

  add(key: string, hit: BrickHit): void {
    if (!key) return;
    let bricks = this.map.get(key);
    if (!bricks) { bricks = new Map(); this.map.set(key, bricks); }
    if (!bricks.has(hit.brickId)) bricks.set(hit.brickId, hit);
  }

  // A key resolves to a suggestion only when EXACTLY ONE distinct brick was seen for it.
  resolve(key: string): BrickHit | null {
    const bricks = this.map.get(key);
    if (!bricks || bricks.size !== 1) return null;
    return bricks.values().next().value ?? null;
  }
}

export function buildBrickSuggestions(
  unmapped: UnmappedCustomer[],
  mapped: MappedCustomer[],
): BrickSuggestion[] {
  const nameAddr = new KeyIndex();
  const nameOnly = new KeyIndex();

  for (const m of mapped) {
    if (!m.brickId) continue;
    const n = norm(m.customerName);
    if (!n) continue;
    const hit: BrickHit = { brickId: m.brickId, sourceCustomerCode: m.customerCode, sourceDistributorCode: m.distributorCode };
    nameOnly.add(n, hit);
    const a = norm(m.address);
    if (a) nameAddr.add(`${n}|${a}`, hit);
  }

  const suggestions: BrickSuggestion[] = [];
  const seen = new Set<string>(); // de-dupe by unmapped customer code (first suggestion wins)

  for (const u of unmapped) {
    const code = String(u.customerCode ?? "").trim();
    if (!code || seen.has(code.toUpperCase())) continue;
    const n = norm(u.customerName);
    if (!n) continue;
    const a = norm(u.address);

    // Prefer the precise name+address match; fall back to name-only.
    let hit: BrickHit | null = null;
    let matchType: BrickSuggestion["matchType"] = "name+address";
    let confidence: BrickSuggestion["confidence"] = "high";
    if (a) hit = nameAddr.resolve(`${n}|${a}`);
    if (!hit) {
      hit = nameOnly.resolve(n);
      matchType = "name";
      confidence = "low";
    }
    if (!hit) continue;

    seen.add(code.toUpperCase());
    suggestions.push({
      address: u.address,
      confidence,
      customerCode: code,
      customerName: u.customerName,
      matchType,
      sourceCustomerCode: hit.sourceCustomerCode,
      sourceDistributorCode: hit.sourceDistributorCode,
      suggestedBrickId: hit.brickId,
    });
  }

  // High-confidence first, then by customer code for a stable order.
  suggestions.sort((a, b) =>
    (a.confidence === b.confidence ? 0 : a.confidence === "high" ? -1 : 1) ||
    a.customerCode.localeCompare(b.customerCode),
  );
  return suggestions;
}
