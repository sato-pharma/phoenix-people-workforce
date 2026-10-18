import { hasGoogleServerKey } from "@/lib/google-maps/server";
import { loadMovedBricks } from "@/lib/sales/master-data/moved-bricks";
import { aiSuggest, aiSuggestModel, type AiReferenceAlias, type AiUnknown } from "@/lib/sales/normalizer/ai-suggest";
import type { PropagationEvidence } from "@/lib/sales/normalizer/auto-apply";
import { loadBrickCentroids } from "@/lib/sales/normalizer/brick-centroids";
import { readStoredAiAnswers, storeAiAnswers } from "@/lib/sales/normalizer/customer-ai-answers";
import { answerFromFreeSteps, buildFreeStepIndexes, groupIdenticalPharmacies } from "@/lib/sales/normalizer/customer-free-steps";
import { teachesFreeSteps } from "@/lib/sales/normalizer/customer-map-teaching";
import { normalizeCustomerNameKey } from "@/lib/sales/normalizer/customer-normalize";
import type { MappedCustomerRow, PropagatedSuggestion } from "@/lib/sales/normalizer/customer-propagate";
import { NO_KEY_CONFIDENCE, scoreCustomerBrick, type GeoSignals } from "@/lib/sales/normalizer/geo-validate";
import { pharmacyGeoKey, resolvePharmacyGeo } from "@/lib/sales/normalizer/pharmacy-geocode";
import { loadSalesReferenceData, type SalesBrickReference } from "@/lib/sales/monthly-distributor-import";
import { fetchAllRowsKeyset, keysetRanges } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// The full customer suggestion pipeline, shared by the suggest-only ai-suggest route and the
// auto-map route (which additionally partitions + saves). Server-side end to end — the client
// never gets to assert a confidence.
//
//   1. the free steps (customer-free-steps.ts): identical pharmacies grouped, then the same address
//      as mapped pharmacies, a twin already mapped, and one of our brick names in the pharmacy name
//   2. AI answers already paid for (customer-ai-answers.ts)
//   3. the AI for the rest, with historical mappings as reference context — only when the caller
//      asks for it. The workspace first sends every customer for the free answers alone, then sends
//      the AI only what that pass left unanswered
//   4. geographic scoring for EVERY suggestion (geo-validate.ts) — cache-first pharmacy
//      geocoding + brick centroid distance tiers replace the AI's self-reported confidence

// Where a suggestion came from. "propagated" is a twin; "address" and "place" are the other two
// free steps; "ai" is the AI, asked now or answering from before.
export type CustomerSuggestionSource = "ai" | "address" | "place" | "propagated";

export type CustomerSuggestion = {
  raw: string;
  code: string;
  confidence?: number;
  source: CustomerSuggestionSource;
  matchedFrom?: PropagatedSuggestion["matchedFrom"];
  signals?: GeoSignals;
  propagation?: PropagationEvidence;
};

type CustomerMapDbRow = {
  id: number;
  customer_name: string | null;
  address: string | null;
  brick_id: string | null;
  customer_code: string | null;
  distributor_code: string | null;
  // Read so a weak saved suggestion can be kept from teaching - customer-map-teaching.ts.
  source: string | null;
  confidence: number | null;
};

/**
 * Every active customer→brick mapping.
 *
 * This used to stop after 20,000 rows (`for (from = 0; from < CUSTOMER_MAP_MAX_ROWS; …)`). Production
 * holds 49,745 active mappings, every one with a brick, so 29,745 of them — 59.8% — never reached
 * the resolver. Because the walk is ordered by ascending id, the discarded rows were always the
 * NEWEST: every mapping an admin had recently corrected was invisible, and the customer fell through
 * to the AI branch or stayed unmapped, sending that customer's sales to the wrong area or nowhere.
 *
 * It also treated a query error as end-of-data (`if (error || !data …) break`), which turned a
 * transient failure into a silently short map that looked complete.
 *
 * It is read by CUSTOMER_MAP_READERS keyset walks at once. One walk is 70 round trips of up to 1,000
 * rows — about 4 seconds, of which the database spends ~6 ms a page — and AI suggest and Auto-map
 * repeat the load for every group of customers the workspace sends. The walks hand over at the ids
 * a quarter, half and three quarters of the way through the map, not at even id steps, because the
 * ids are bunched: on 2026-09-15 four rows in five sat in the lowest and highest eighths of the id
 * span. Those cut points only balance the work. The ranges are contiguous and the last is open-ended
 * (keysetRanges), so a stale count or a row written mid-read can slow one walk but never lose a row.
 */
async function loadActiveCustomerMap(): Promise<CustomerMapDbRow[]> {
  const supabase = getSupabaseAdmin();
  const ranges = keysetRanges(await customerMapCuts());
  const walks = await Promise.all(
    ranges.map((range) =>
      fetchAllRowsKeyset<CustomerMapDbRow>(
        () => {
          let query = supabase
            .from("source_of_sales_customer_map")
            .select("id,customer_name,address,brick_id,customer_code,distributor_code,source,confidence")
            .eq("active", true)
            .not("brick_id", "is", null);
          if (range.from !== null) query = query.gte("id", range.from);
          if (range.below !== null) query = query.lt("id", range.below);
          return query;
        },
        { cursorColumn: "id", cursorOf: (row) => row.id },
      ),
    ),
  );
  // The ranges are in ascending id order, so the rows come back in the order one walk returned them.
  return walks.flat();
}

// How many keyset walks read the customer map at once — see loadActiveCustomerMap.
const CUSTOMER_MAP_READERS = 4;

/**
 * Where the concurrent walks hand over: the ids of the rows a quarter, half and three quarters of the
 * way through the map. Each probe reads ONE row by position (~55 ms at the deepest), never a page, so
 * it is not the offset walk the keyset pager replaced. A map too small to gain from splitting is read
 * by one walk, and a probe that finds no row (rows deleted between the count and the probe) returns
 * NaN, which keysetRanges drops.
 */
async function customerMapCuts(): Promise<number[]> {
  const supabase = getSupabaseAdmin();
  const { count, error } = await supabase
    .from("source_of_sales_customer_map")
    .select("id", { count: "exact", head: true })
    .eq("active", true)
    .not("brick_id", "is", null);
  if (error) throw error;
  const total = count ?? 0;
  if (total < CUSTOMER_MAP_READERS * 1000) return [];
  return Promise.all(
    Array.from({ length: CUSTOMER_MAP_READERS - 1 }, async (_, index) => {
      const position = Math.floor(((index + 1) * total) / CUSTOMER_MAP_READERS);
      const { data, error: probeError } = await supabase
        .from("source_of_sales_customer_map")
        .select("id")
        .eq("active", true)
        .not("brick_id", "is", null)
        .order("id", { ascending: true })
        .range(position, position);
      if (probeError) throw probeError;
      return Number(data?.[0]?.id);
    }),
  );
}

export type CustomerSuggestOptions = {
  // false: the free steps and the stored AI answers only. No AI call, so no AI key is needed.
  ai?: boolean;
};

export async function suggestCustomerBricks(
  unknowns: AiUnknown[],
  options: CustomerSuggestOptions = {},
): Promise<{ suggestions: CustomerSuggestion[]; bricks: Map<string, SalesBrickReference> }> {
  const useAi = options.ai !== false;
  // Only the brick master is read from the reference data. The customer→brick crosswalk that
  // loadSalesReferenceData() pages by default is a second pass over the whole customer map — 70
  // offset pages, ~3.5 s — that nothing here reads, and it was paid again for every group sent.
  const [refs, customerMapRows, movedBricks] = await Promise.all([
    loadSalesReferenceData({ includeCustomerBricks: false }),
    loadActiveCustomerMap(),
    loadMovedBricks(),
  ]);
  // A brick kept only as history after a move is no answer: its pharmacies would credit the area it
  // left. It is not translated to the brick it moved to either — a pharmacy still on it is one the
  // owner kept there, and that does not say where a
  // new pharmacy belongs. So every step below sees the live bricks only.
  const liveBricks = (refs.bricks ?? []).filter((b) => !movedBricks.has(b.brickId));
  const brickMap = new Map(liveBricks.map((b) => [b.brickId, b]));
  const candidates = liveBricks.map((b) => ({
    code: b.brickId,
    label: [b.brickName, [b.areaName, b.regionName].filter(Boolean).join(", ")].filter(Boolean).join(" — "),
  }));
  // Only bricks that still exist in the master, and have not moved — the map can hold retired ids.
  const isLiveBrick = (code: string) => brickMap.has(code);

  // Only mappings a person made, or that cleared the auto-accept bar, may TEACH: a weak suggestion
  // saved unreviewed would otherwise come back as a confident "same address" or "known twin" answer
  // for the next pharmacy, and a wrong guess would copy itself (customer-map-teaching.ts). The free
  // steps' indexes and the AI's reference list both read this, never the raw map.
  const teaching = customerMapRows.filter((row) => teachesFreeSteps(row));

  // 1. The free steps, once per distinct pharmacy.
  const groups = groupIdenticalPharmacies(unknowns);
  const representatives = groups.map((g) => g.representative);
  const mapped: MappedCustomerRow[] = teaching.map((r) => ({
    address: String(r.address ?? ""),
    brickId: String(r.brick_id ?? "").trim(),
    customerCode: String(r.customer_code ?? ""),
    customerName: String(r.customer_name ?? ""),
    distributorCode: String(r.distributor_code ?? ""),
  }));
  const indexes = buildFreeStepIndexes(
    mapped,
    liveBricks.map((b) => ({ areaCode: String(b.areaCode ?? "").trim().toUpperCase(), brickId: b.brickId, brickName: b.brickName })),
  );
  const answered = new Map<string, CustomerSuggestion>();
  for (const [raw, answer] of answerFromFreeSteps(representatives, indexes, isLiveBrick)) {
    answered.set(raw, answer.source === "propagated"
      ? {
          code: answer.code,
          confidence: answer.confidence,
          matchedFrom: answer.matchedFrom,
          // Carried so auto-apply.ts can accept a deterministic twin that has no geocode to judge.
          propagation: { addressCorroborated: answer.addressCorroborated } satisfies PropagationEvidence,
          raw,
          source: "propagated",
        }
      : { code: answer.code, confidence: answer.confidence, raw, source: answer.source });
  }

  // 2. AI answers already paid for, keyed by pharmacy text. A customer with no name (the AI was
  // shown only its code) has an empty key, so it is never stored and never read back.
  const model = aiSuggestModel();
  const keyOf = new Map(groups.map((g) => [g.representative.raw, g.key]));
  let rest = representatives.filter((u) => !answered.has(u.raw));
  if (model && rest.length > 0) {
    const stored = await readStoredAiAnswers(rest.map((u) => keyOf.get(u.raw) ?? ""), model);
    for (const u of rest) {
      const code = stored.get(keyOf.get(u.raw) ?? "");
      if (code && isLiveBrick(code)) answered.set(u.raw, { code, raw: u.raw, source: "ai" });
    }
    rest = rest.filter((u) => !answered.has(u.raw));
  }

  // 3. The AI, for what is left, only when the caller asks for it.
  if (useAi && rest.length > 0) {
    // Reference aliases for the AI: historical import rows + the customer map, deduped on the
    // normalized pharmacy name so respellings don't eat the limited reference budget.
    const supabase = getSupabaseAdmin();
    const referenceAliases: AiReferenceAlias[] = [];
    const seen = new Set<string>();
    const push = (raw: string, code: string) => {
      const r = String(raw ?? "").trim();
      const c = String(code ?? "").trim();
      // An example pointing at a brick the AI may not answer (moved, or gone) would only steer it
      // toward an answer that is then thrown away.
      if (!r || !c || !isLiveBrick(c)) return;
      const dedupText = normalizeCustomerNameKey(r.split("|")[0]) || r.toLowerCase();
      const key = `${dedupText}:${c}`;
      if (!seen.has(key)) { seen.add(key); referenceAliases.push({ raw: r, code: c }); }
    };
    try {
      const { data } = await supabase
        .from("source_of_sales_import_rows")
        .select("client_name,client_address,brick_id")
        .not("brick_id", "is", null)
        .not("client_name", "is", null)
        .limit(800);
      for (const row of data ?? []) {
        const r = row as Record<string, unknown>;
        const text = [String(r.client_name ?? "").trim(), String(r.client_address ?? "").trim()].filter(Boolean).join(" | ");
        push(text, String(r.brick_id ?? ""));
      }
    } catch { /* reference context is optional */ }
    for (const row of teaching) {
      const text = [String(row.customer_name ?? "").trim(), String(row.address ?? "").trim()].filter(Boolean).join(" | ");
      push(text, String(row.brick_id ?? ""));
    }

    const aiSuggestions = await aiSuggest("customer", rest, candidates, referenceAliases.length ? referenceAliases : undefined);
    for (const s of aiSuggestions) answered.set(s.raw, { ...s, source: "ai" });
    // Filed under the model that answers FIRST now, read after the call: if OpenAI ran out of credit
    // during it, the planner has just learned that and names Claude, who answered the rest. (A call that
    // straddles the failover files its earlier batches under Claude too — cached suggestions only.)
    const answeredBy = aiSuggestModel() ?? model;
    if (answeredBy) await storeAiAnswers(aiSuggestions.map((s) => ({ brickId: s.code, pharmacyKey: keyOf.get(s.raw) ?? "" })), answeredBy);
  }

  // Every customer code gets its pharmacy's answer.
  let suggestions: CustomerSuggestion[] = [];
  for (const group of groups) {
    const answer = answered.get(group.representative.raw);
    if (!answer) continue;
    for (const member of group.members) suggestions.push({ ...answer, raw: member.raw });
  }

  // 4. Geographic scoring — replaces AI self-reported confidence and validates every free answer
  // (blend: geo confirms → boost capped at 97, geo contradicts → demote to 45).
  if (suggestions.length > 0) {
    const unknownMap = new Map(unknowns.map((u) => [u.raw, u]));
    if (!hasGoogleServerKey()) {
      suggestions = suggestions.map((s) => (s.source === "ai" ? { ...s, confidence: NO_KEY_CONFIDENCE } : s));
    } else {
      const geoEntries = suggestions
        .map((s) => unknownMap.get(s.raw))
        .filter((u): u is AiUnknown => u != null)
        .map((u) => ({ address: u.rawAddress ?? "", name: u.rawName ?? u.raw }));
      const [pharmacyGeoByKey, centroids] = await Promise.all([
        resolvePharmacyGeo(geoEntries),
        loadBrickCentroids(),
      ]);
      suggestions = suggestions.map((s) => {
        const brick = brickMap.get(s.code);
        const u = unknownMap.get(s.raw);
        if (!brick || !u) return s;
        const geo = pharmacyGeoByKey.get(pharmacyGeoKey(u.rawName ?? u.raw, u.rawAddress ?? "")) ?? null;
        const { confidence, signals } = scoreCustomerBrick(geo, brick, centroids.get(s.code));
        if (s.source !== "ai") {
          const base = s.confidence ?? 90;
          const blended = confidence >= 80
            ? Math.min(97, Math.max(base, confidence))
            : confidence <= 20
            ? 45
            : base;
          return { ...s, confidence: blended, signals };
        }
        return { ...s, confidence, signals };
      });
    }
  }

  return { bricks: brickMap, suggestions };
}
