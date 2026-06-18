import type { BrickRef, Crosswalks } from "@/lib/sales/normalizer/types";

// Pure resolvers — no I/O, fully unit-tested. They translate a distributor's raw codes/text into
// Phoenix Product ID + Brick ID and derive the Area/Region hierarchy. Matching is done on a
// normalized key so spacing / case / Arabic punctuation differences don't break a lookup.

// Normalize a free-text alias for matching: trim, lowercase, collapse whitespace, drop Arabic
// tatweel + common separators so "الدقى / بين السريات" == "الدقي/بين السريات".
export function normalizeAliasKey(value: unknown): string {
  return String(value ?? "")
    .replace(/ـ/g, "") // tatweel
    .replace(/[إأآا]/g, "ا") // unify alef forms
    .replace(/ى/g, "ي")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function normalizeCodeKey(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

// Numeric-canonical key for leading-zero / number-vs-text drift. A code like "0001502731" (text)
// and "1502731" (read back as a number by Excel) must resolve to each other. Returns the digits
// with leading zeros stripped for a PURELY numeric code, else null (so alphanumeric codes such as
// "TE001" or "B100-11" are never collapsed). Used only as an additive fallback after the exact key.
export function numericCanonicalKey(value: unknown): string | null {
  const code = normalizeCodeKey(value);
  if (!/^\d+$/.test(code)) return null;
  return code.replace(/^0+(?=\d)/, "");
}

// item code OR item name -> Phoenix product code. Tries a direct (global) product-code match first,
// then this DISTRIBUTOR's alias table (by code then by normalized name). Product aliases are
// per-distributor: the key is `${distributor} ${normalized alias}` (see crosswalks.loadCrosswalks).
export function resolveProduct(rawValues: (string | null | undefined)[], maps: Crosswalks, distributorCode = ""): string | null {
  const dist = normalizeCodeKey(distributorCode);
  for (const raw of rawValues) {
    const text = String(raw ?? "").trim();
    if (!text) continue;
    const code = normalizeCodeKey(text);
    if (maps.productByCode.has(code)) return code;
    // Leading-zero / number-vs-text fallback for numeric product codes (exact miss only).
    const canon = numericCanonicalKey(code);
    if (canon) {
      const byCanon = maps.productByCanonicalCode.get(canon);
      if (byCanon) return byCanon;
    }
    if (!dist) continue;
    const byCodeAlias = maps.productAliasByKey.get(`${dist} ${normalizeAliasKey(code)}`);
    if (byCodeAlias) return byCodeAlias;
    const byNameAlias = maps.productAliasByKey.get(`${dist} ${normalizeAliasKey(text)}`);
    if (byNameAlias) return byNameAlias;
  }
  return null;
}

export type BrickResolution = { areaCode: string; brickId: string; regionCode: string; source: string } | null;

// Resolve the Phoenix Brick ID (and hence Area/Region). Priority:
//  1. a customer code already mapped to a brick (most reliable),
//  2. a direct Phoenix brick id the sheet already carries,
//  3. a territory text (district/street/governorate) via the territory alias,
//  4. an area text via the area alias (gives area+region, brick stays empty).
export function resolveBrick(
  input: { brickIdValues?: (string | null | undefined)[]; customerKey?: string | null; customerCanonicalKey?: string | null; territoryValues?: (string | null | undefined)[] },
  maps: Crosswalks,
): BrickResolution {
  // 1) customer -> brick (exact key, then numeric-canonical fallback for leading-zero drift)
  if (input.customerKey) {
    const brickId = maps.customerBrickByKey.get(input.customerKey)
      ?? (input.customerCanonicalKey ? maps.customerBrickByCanonicalKey.get(input.customerCanonicalKey) : undefined);
    if (brickId && maps.brickById.has(brickId)) {
      const b = maps.brickById.get(brickId)!;
      return { areaCode: b.areaCode, brickId, regionCode: b.regionCode, source: "customer" };
    }
  }
  // 2) direct brick id
  for (const raw of input.brickIdValues ?? []) {
    const id = normalizeCodeKey(raw);
    if (id && maps.brickById.has(id)) {
      const b = maps.brickById.get(id)!;
      return { areaCode: b.areaCode, brickId: id, regionCode: b.regionCode, source: "direct" };
    }
  }
  // 3) territory text -> brick / area (via the territory alias)
  for (const raw of input.territoryValues ?? []) {
    const key = normalizeAliasKey(raw);
    if (!key) continue;
    const hit = maps.territoryAliasByKey.get(key);
    if (hit) {
      if (hit.targetType === "brick") {
        const b = maps.brickById.get(normalizeCodeKey(hit.targetCode));
        if (b) return { areaCode: b.areaCode, brickId: b.brickId, regionCode: b.regionCode, source: "territory" };
      } else if (hit.targetType === "area") {
        const a = maps.areaByCode.get(normalizeCodeKey(hit.targetCode));
        if (a) return { areaCode: a.areaCode, brickId: "", regionCode: a.regionCode, source: "territory-area" };
      }
    }
    // 4) area alias
    const areaHit = maps.areaAliasByKey.get(key);
    if (areaHit) return { areaCode: normalizeCodeKey(areaHit.areaCode), brickId: "", regionCode: normalizeCodeKey(areaHit.regionCode), source: "area" };
  }
  return null;
}

// Brick id (or area code) -> full hierarchy names. Area/Region are NEVER typed by the user.
export function deriveHierarchy(
  resolution: BrickResolution,
  maps: Crosswalks,
): Pick<BrickRef, "areaCode" | "areaName" | "brickId" | "brickName" | "regionCode" | "regionName"> | null {
  if (!resolution) return null;
  if (resolution.brickId) {
    const b = maps.brickById.get(resolution.brickId);
    if (b) return { areaCode: b.areaCode, areaName: b.areaName, brickId: b.brickId, brickName: b.brickName, regionCode: b.regionCode, regionName: b.regionName };
  }
  // area-only resolution (no brick)
  const a = maps.areaByCode.get(resolution.areaCode);
  if (a) return { areaCode: a.areaCode, areaName: a.areaName, brickId: "", brickName: "", regionCode: a.regionCode, regionName: a.regionName };
  const r = maps.regionByCode.get(resolution.regionCode);
  if (r) return { areaCode: resolution.areaCode, areaName: resolution.areaCode, brickId: "", brickName: "", regionCode: r.regionCode, regionName: r.regionName };
  return null;
}
