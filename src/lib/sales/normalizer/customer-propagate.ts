import { addressTokenOverlap, customerAddressTokens, normalizeCustomerNameKey } from "@/lib/sales/normalizer/customer-normalize";
import { detectChain, sameChainBranch, type ChainMatch } from "@/lib/sales/normalizer/pharmacy-chains";

// Deterministic cross-distributor propagation: when a pharmacy unknown at distributor A has a
// near-identical twin already mapped (any distributor), suggest the twin's brick BEFORE spending
// AI tokens. Pure — no I/O. Matching is conservative by design: only exact normalized-name keys
// (with chain-aware branch discrimination) propagate; anything weaker falls through to the AI.

export type MappedCustomerRow = {
  customerName: string;
  address: string;
  brickId: string;
  distributorCode: string;
  customerCode: string;
};

export type PropagationUnknown = {
  raw: string;
  rawName?: string;
  rawAddress?: string;
};

export type PropagatedSuggestion = {
  raw: string;
  code: string;
  confidence: number;
  source: "propagated";
  matchedFrom: { distributorCode: string; customerCode: string; customerName: string };
  // The address tokens agreed (overlap >= 0.5) on top of the unambiguous name match. This is the
  // second independent TEXTUAL signal, and it is what lets auto-apply.ts accept the suggestion
  // when the pharmacy has no geocode — which is the case for ~97% of them.
  addressCorroborated: boolean;
};

type IndexEntry = {
  row: MappedCustomerRow;
  chain: ChainMatch | null;
  addressTokens: Set<string>;
};

export type PropagationIndex = {
  // normalized name key → entries (non-chain names)
  byNameKey: Map<string, IndexEntry[]>;
  // chainKey + "\u0000" + branchToken → entries (chain names with a branch)
  byChainBranch: Map<string, IndexEntry[]>;
};

export function buildPropagationIndex(rows: MappedCustomerRow[]): PropagationIndex {
  const byNameKey = new Map<string, IndexEntry[]>();
  const byChainBranch = new Map<string, IndexEntry[]>();
  for (const row of rows) {
    const brick = String(row.brickId ?? "").trim();
    const name = String(row.customerName ?? "").trim();
    if (!brick || !name) continue;
    const chain = detectChain(name);
    const entry: IndexEntry = { addressTokens: customerAddressTokens(row.address ?? ""), chain, row };
    if (chain && chain.branchToken) {
      const key = `${chain.chainKey}\u0000${chain.branchToken}`;
      const list = byChainBranch.get(key);
      if (list) list.push(entry);
      else byChainBranch.set(key, [entry]);
      continue;
    }
    if (chain) continue; // unbranched chain name — could be any branch, never index it
    const nameKey = normalizeCustomerNameKey(name);
    if (!nameKey || nameKey.split(" ").length < 2) continue; // single-token names are too generic
    const list = byNameKey.get(nameKey);
    if (list) list.push(entry);
    else byNameKey.set(nameKey, [entry]);
  }
  return { byChainBranch, byNameKey };
}

function distinctBricks(entries: IndexEntry[]): string[] {
  return Array.from(new Set(entries.map((e) => e.row.brickId)));
}

export function propagateSuggestions(unknowns: PropagationUnknown[], index: PropagationIndex): PropagatedSuggestion[] {
  const out: PropagatedSuggestion[] = [];
  for (const unknown of unknowns) {
    const name = String(unknown.rawName ?? unknown.raw ?? "").trim();
    if (!name) continue;
    const chain = detectChain(name);

    let entries: IndexEntry[] | undefined;
    if (chain) {
      // Chain names ONLY match same chain + same branch; an unbranched chain unknown never matches.
      if (!chain.branchToken) continue;
      entries = index.byChainBranch.get(`${chain.chainKey}\u0000${chain.branchToken}`)?.filter((e) => e.chain != null && sameChainBranch(chain, e.chain));
    } else {
      const nameKey = normalizeCustomerNameKey(name);
      if (!nameKey || nameKey.split(" ").length < 2) continue;
      entries = index.byNameKey.get(nameKey);
    }
    if (!entries || entries.length === 0) continue;

    // Ambiguity suppression: the same name mapped to different bricks proves the name is not a
    // unique identity — emit nothing and let the AI (with geo) take it.
    const bricks = distinctBricks(entries);
    if (bricks.length !== 1) continue;

    // Address overlap boosts confidence; the base match alone is already high-signal.
    const unknownAddress = customerAddressTokens(unknown.rawAddress ?? "");
    const bestOverlap = entries.reduce((best, e) => Math.max(best, addressTokenOverlap(unknownAddress, e.addressTokens)), 0);
    const addressCorroborated = bestOverlap >= 0.5;
    const confidence = addressCorroborated ? 93 : 90;

    const matched = entries[0].row;
    out.push({
      addressCorroborated,
      code: bricks[0],
      confidence,
      matchedFrom: {
        customerCode: matched.customerCode,
        customerName: matched.customerName,
        distributorCode: matched.distributorCode,
      },
      raw: unknown.raw,
      source: "propagated",
    });
  }
  return out;
}
