import { foldArabicDigits } from "@/lib/sales/normalizer/header-normalize";
import type { BrickRef, Crosswalks } from "@/lib/sales/normalizer/types";

// Pure resolvers — no I/O, fully unit-tested. They translate a distributor's raw codes/text into
// Phoenix Product ID + Brick ID and derive the Area/Region hierarchy. Matching is done on a
// normalized key so spacing / case / Arabic punctuation differences don't break a lookup.

// Normalize a free-text alias for matching: trim, lowercase, collapse whitespace, drop Arabic
// tatweel + common separators so "الدقى / بين السريات" == "الدقي/بين السريات".
export function normalizeAliasKey(value: unknown): string {
  return foldArabicDigits(String(value ?? ""))
    .replace(/ـ/g, "") // tatweel
    .replace(/[إأآا]/g, "ا") // unify alef forms
    .replace(/ى/g, "ي")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function normalizeCodeKey(value: unknown): string {
  return foldArabicDigits(String(value ?? "")).trim().toUpperCase();
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

// item name / code -> Phoenix product code. NAME-FIRST (owner rule): pass 1 tries every value as a
// product NAME (master productByName index, then this distributor's learned name aliases); pass 2
// falls back to CODE (exact, numeric-canonical, then per-distributor code alias). Two passes so the
// name always wins over a colliding code regardless of the order values are supplied. Product aliases
// are per-distributor: the key is `${distributor} ${normalized alias}` (see crosswalks.loadCrosswalks).
export function resolveProduct(rawValues: (string | null | undefined)[], maps: Crosswalks, distributorCode = ""): string | null {
  const dist = normalizeCodeKey(distributorCode);
  // Pass 1 — NAME-FIRST
  for (const raw of rawValues) {
    const text = String(raw ?? "").trim();
    if (!text) continue;
    const nameKey = normalizeAliasKey(text);
    if (!nameKey) continue;
    const byName = maps.productByName?.get(nameKey);
    if (byName) return byName;
    if (dist) {
      const byNameAlias = maps.productAliasByKey.get(`${dist} ${nameKey}`);
      if (byNameAlias) return byNameAlias;
    }
  }
  // Pass 2 — CODE fallback
  for (const raw of rawValues) {
    const text = String(raw ?? "").trim();
    if (!text) continue;
    const code = normalizeCodeKey(text);
    if (maps.productByCode.has(code)) return code;
    const canon = numericCanonicalKey(code);
    if (canon) {
      const byCanon = maps.productByCanonicalCode.get(canon);
      if (byCanon) return byCanon;
    }
    if (dist) {
      const byCodeAlias = maps.productAliasByKey.get(`${dist} ${normalizeAliasKey(code)}`);
      if (byCodeAlias) return byCodeAlias;
    }
  }
  return null;
}

export type BrickResolution = { areaCode: string; brickId: string; regionCode: string; source: string } | null;

// Resolve the Phoenix Brick ID (and hence Area/Region). Priority (owner rule, confirmed 2026-07-07):
//  1. a direct Phoenix brick id the sheet already carries (most reliable — the sheet says so directly),
//  2. a territory text (brick name / district / street / governorate) via the territory alias,
//  3. an area text via the area alias (gives area+region, brick stays empty),
//  4. a customer code already mapped to a brick — when the sheet gave no BRICK-level signal.
// The sheet naming a BRICK always wins over a previously-stored customer mapping; a stored mapping
// never silently overrides what the current sheet says at the same precision. An AREA-only signal
// is coarser than a customer→brick mapping, so it does NOT win: the stored brick is used when it
// lies inside that area, and the area is kept when it does not (never move a sale across areas on a
// stored mapping). See engine.ts's customerBrickCorrections for the self-heal that keeps the stored
// mapping in sync when the sheet disagrees with it.
export function resolveBrick(
  input: { brickIdValues?: (string | null | undefined)[]; customerKey?: string | null; customerCanonicalKey?: string | null; territoryValues?: (string | null | undefined)[] },
  maps: Crosswalks,
): BrickResolution {
  // 1) direct brick id
  for (const raw of input.brickIdValues ?? []) {
    const id = normalizeCodeKey(raw);
    if (id && maps.brickById.has(id)) {
      const b = maps.brickById.get(id)!;
      return { areaCode: b.areaCode, brickId: id, regionCode: b.regionCode, source: "direct" };
    }
  }
  // 2) territory text -> brick / area (via the territory alias)
  //
  // An AREA-only hit is remembered, NOT returned. The sheet naming a brick outranks a stored
  // customer mapping — but the sheet naming only an AREA does not: the customer map may hold the
  // exact brick INSIDE that area, and taking the area instead throws that precision away. Returning
  // here is what put 3,282 of January's rows (1,356 customers) at area level while their exact
  // brick sat in source_of_sales_customer_map, active and valid — 733 of them the same customers
  // that failed the same way in June. It also contradicts the standing rule: always map on the
  // smallest brick available.
  // First area signal wins, preserving the old column-order behaviour.
  let areaOnly: NonNullable<BrickResolution> | null = null;

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
        if (a && !areaOnly) {
          areaOnly = { areaCode: a.areaCode, brickId: "", regionCode: a.regionCode, source: "territory-area" };
        }
      }
    }
    // 3) area alias
    const areaHit = maps.areaAliasByKey.get(key);
    if (areaHit && !areaOnly) {
      areaOnly = {
        areaCode: normalizeCodeKey(areaHit.areaCode),
        brickId: "",
        regionCode: normalizeCodeKey(areaHit.regionCode),
        source: "area",
      };
    }
  }

  // 4) customer -> brick (exact key, then numeric-canonical fallback for leading-zero drift)
  if (input.customerKey) {
    const brickId = maps.customerBrickByKey.get(input.customerKey)
      ?? (input.customerCanonicalKey ? maps.customerBrickByCanonicalKey.get(input.customerCanonicalKey) : undefined);
    if (brickId && maps.brickById.has(brickId)) {
      const b = maps.brickById.get(brickId)!;
      // Only sharpen WITHIN the area the sheet named. If the stored brick sits in a different area,
      // the sheet wins and we keep the area — moving a sale across areas on a stored mapping is
      // exactly the cross-area auto-apply that is never allowed, and it would silently shift a
      // rep's numbers.
      if (!areaOnly || areaOnly.areaCode === b.areaCode) {
        return { areaCode: b.areaCode, brickId, regionCode: b.regionCode, source: "customer" };
      }
    }
  }

  // The sheet's area, used only once the customer map had nothing better to offer inside it.
  return areaOnly;
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
