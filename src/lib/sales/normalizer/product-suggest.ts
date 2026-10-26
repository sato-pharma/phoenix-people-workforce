import type { AiCandidate, AiSuggestion, AiUnknown } from "@/lib/sales/normalizer/ai-suggest";
import { normalizeAliasKey, normalizeCodeKey, numericCanonicalKey } from "@/lib/sales/normalizer/resolvers";
import { IGNORE_PRODUCT_CODE } from "@/lib/sales/normalizer/types";

// Product suggestions for an unknown or ignored distributor item. Free evidence runs first, in order of
// strength, and the AI is asked only about what is left:
//   1. the same item code is already mapped at a sister distributor (Ibn Sina and Ibn Sina Tender share
//      one item-code system; so do every "<root>-<suffix>" family), and every sister agrees;
//   2. the cleaned item name is already mapped at another distributor (price/hospital tags stripped);
//   3. the same medicine, form, variant and strength in the catalog, and only one product fits;
//   4. the AI, shown every product with the names distributors already use for it.
// A suggestion whose strength contradicts the item's own strength (40 mg item → a 120 mg product) is
// dropped wherever it came from. Suggest-only: nothing here writes a mapping.

export type CatalogProduct = { code: string; name: string; family?: string; line?: string };
export type KnownProductAlias = { alias: string; distributorCode: string; productCode: string };
export type ProductSuggestSource = "sister_code" | "known_name" | "same_strength" | "ai";
export type ProductSuggestion = {
  raw: string;
  code: string | null;
  confidence: number;
  source: ProductSuggestSource | null;
  reason: string;
};
export type ProductItem = { raw: string; rawName?: string };

export type ProductSuggestContext = {
  distributorCode: string;
  catalog: CatalogProduct[];
  aliases: KnownProductAlias[];
  distributorNames?: Map<string, string>;
};

const VARIANT_WORDS: Record<string, string> = {
  advance: "advanced",
  advanced: "advanced",
  basic: "basic",
  fort: "forte",
  forte: "forte",
  intens: "intens",
  intense: "intens",
  max: "max",
  upa: "upa",
};
const LIQUID_WORDS = new Set(["drop", "drops", "syp", "syrup", "solution", "susp", "suspension", "sol"]);
const PACK_WORDS = /^(tab|tabs|tablet|tablets|cap|caps|capsule|capsules|sachet|sachets|ml|gm|g|fct|amp|amps)\b/;

// The distributor family a code belongs to: "IS-T" → "IS", "EG-HOS" → "EG", "IS" → "IS".
export function sisterRoot(distributorCode: string): string {
  return normalizeCodeKey(distributorCode).split("-")[0] ?? "";
}

// A distributor's item name without the tags that never change the medicine: "(O.P)", "(OLD PRICE)",
// "(HOSP)", "(--ماركيرل--)" and the tender "TN " prefix.
export function cleanProductName(value: string): string {
  const stripped = String(value ?? "")
    .replace(/\((?:[^)]*)\)/g, " ")
    .replace(/^\s*tn\s+/i, " ");
  return normalizeAliasKey(stripped);
}

export type ProductSignature = { strengths: number[]; liquid: boolean; variants: string[] };

function splitUnits(text: string): string {
  return String(text ?? "").toLowerCase().replace(/(\d)([a-z])/g, "$1 $2").replace(/([a-z])(\d)/g, "$1 $2");
}

// What a name says about the medicine: its mg strengths, whether it is a liquid, and its variant words.
// A catalog name may carry a bare strength ("Tebofortine Forte 80"); a distributor name's bare numbers
// are pack counts ("30TAB", "400 GM"), so only "<n> mg" counts there.
export function productSignature(text: string, opts: { catalogName?: boolean } = {}): ProductSignature {
  const spaced = splitUnits(text).replace(/[^a-z0-9./]+/g, " ");
  const strengths = new Set<number>();
  const mg = /(\d+(?:\.\d+)?)\s*mg\b/g;
  for (let m = mg.exec(spaced); m; m = mg.exec(spaced)) strengths.add(Number(m[1]));
  if (opts.catalogName && strengths.size === 0) {
    const bare = /(\d+(?:\.\d+)?)(?!\s*(?:\d|\.))(\s*[a-z]*)/g;
    for (let m = bare.exec(spaced); m; m = bare.exec(spaced)) {
      const value = Number(m[1]);
      if (value >= 5 && !PACK_WORDS.test(m[2]!.trim())) strengths.add(value);
    }
  }
  const words = spaced.split(/[\s./]+/).filter(Boolean);
  const variants = new Set<string>();
  for (const word of words) if (VARIANT_WORDS[word]) variants.add(VARIANT_WORDS[word]);
  const liquid = words.some((w) => LIQUID_WORDS.has(w)) || /mg\s*\/\s*ml/.test(spaced);
  return { liquid, strengths: [...strengths], variants: [...variants].sort() };
}

function familyKey(word: string): string | null {
  const w = normalizeAliasKey(word).split(" ")[0] ?? "";
  return /^[a-z]{5,}/.test(w) ? w.slice(0, 5) : null;
}

function activeCatalog(catalog: CatalogProduct[]): CatalogProduct[] {
  return catalog.filter((p) => p.code && p.code !== IGNORE_PRODUCT_CODE);
}

function catalogSignature(product: CatalogProduct): ProductSignature {
  return productSignature(product.name, { catalogName: true });
}

// True when the item names a strength and the product names a different one — never the same medicine.
export function strengthConflicts(itemName: string, product: CatalogProduct | undefined): boolean {
  if (!product || !itemName) return false;
  const item = productSignature(itemName).strengths;
  const own = catalogSignature(product).strengths;
  if (item.length === 0 || own.length === 0) return false;
  return !item.some((s) => own.includes(s));
}

function productFamilyKey(product: CatalogProduct): string | null {
  return familyKey(product.family || product.name) ?? familyKey(product.name);
}

// Step 3: the catalog products of the item's family that match its form, variant and strength.
export function sameStrengthMatches(itemName: string, catalog: CatalogProduct[]): { family: CatalogProduct[]; fits: CatalogProduct[] } {
  const words = normalizeAliasKey(itemName).split(" ");
  const keys = new Set(words.map(familyKey).filter((k): k is string => Boolean(k)));
  const family = activeCatalog(catalog).filter((p) => {
    const key = productFamilyKey(p);
    return key !== null && keys.has(key);
  });
  if (family.length === 0) return { family, fits: [] };
  const item = productSignature(itemName);
  let fits = family;

  const sigs = new Map(family.map((p) => [p.code, catalogSignature(p)]));
  const hasLiquid = family.some((p) => sigs.get(p.code)!.liquid);
  const hasSolid = family.some((p) => !sigs.get(p.code)!.liquid);
  if (hasLiquid && hasSolid) fits = fits.filter((p) => sigs.get(p.code)!.liquid === item.liquid);

  // A variant word only decides between products that differ by one: a family of one is never filtered.
  const familyVariants = new Set(family.flatMap((p) => sigs.get(p.code)!.variants));
  const variantKey = (p: CatalogProduct) => sigs.get(p.code)!.variants.join(",");
  if (familyVariants.size > 0 && new Set(family.map(variantKey)).size > 1) {
    const itemVariants = item.variants.filter((v) => familyVariants.has(v)).join(",");
    fits = fits.filter((p) => sigs.get(p.code)!.variants.filter((v) => familyVariants.has(v)).join(",") === itemVariants);
  }

  if (item.strengths.length > 0) {
    const exact = fits.filter((p) => sigs.get(p.code)!.strengths.some((s) => item.strengths.includes(s)));
    fits = exact.length > 0 ? exact : fits.filter((p) => sigs.get(p.code)!.strengths.length === 0);
  }
  return { family, fits };
}

function nameOf(ctx: ProductSuggestContext, code: string): string {
  if (code === IGNORE_PRODUCT_CODE) return "ignored (not a Phoenix product)";
  return ctx.catalog.find((p) => p.code === code)?.name ?? code;
}

function distributorLabel(ctx: ProductSuggestContext, code: string): string {
  return ctx.distributorNames?.get(normalizeCodeKey(code)) ?? code;
}

function isCodeLike(value: string): boolean {
  return /^[0-9][0-9\-/.]*$/.test(String(value ?? "").trim());
}

function codeKeys(value: string): string[] {
  const keys = [normalizeCodeKey(value)];
  const numeric = numericCanonicalKey(value);
  if (numeric && !keys.includes(numeric)) keys.push(numeric);
  return keys.filter(Boolean);
}

type Vote = { code: string; distributors: Set<string> };

function tally(votes: Map<string, Vote>, code: string, distributorCode: string) {
  const vote = votes.get(code) ?? { code, distributors: new Set<string>() };
  vote.distributors.add(distributorCode);
  votes.set(code, vote);
}

function productByCode(ctx: ProductSuggestContext, code: string): CatalogProduct | undefined {
  return ctx.catalog.find((p) => p.code === code);
}

// Steps 1-3 for one item. Returns null when no free evidence settles it (the AI is asked next).
export function freeProductSuggestion(item: ProductItem, ctx: ProductSuggestContext): ProductSuggestion | null {
  const current = normalizeCodeKey(ctx.distributorCode);
  const root = sisterRoot(ctx.distributorCode);
  const name = String(item.rawName || (isCodeLike(item.raw) ? "" : item.raw) || "").trim();
  const others = ctx.aliases.filter((a) => normalizeCodeKey(a.distributorCode) !== current && a.productCode);
  const known = new Set(ctx.catalog.map((p) => p.code).concat(IGNORE_PRODUCT_CODE));
  const fitsName = (code: string) => code === IGNORE_PRODUCT_CODE || !strengthConflicts(name, productByCode(ctx, code));

  // 1. The same item code at a sister distributor.
  const itemCodes = [item.raw, item.rawName ?? ""].filter((v) => isCodeLike(v)).flatMap(codeKeys);
  if (itemCodes.length > 0) {
    const votes = new Map<string, Vote>();
    for (const alias of others) {
      if (sisterRoot(alias.distributorCode) !== root || !isCodeLike(alias.alias)) continue;
      if (!codeKeys(alias.alias).some((k) => itemCodes.includes(k))) continue;
      if (!known.has(alias.productCode)) continue;
      tally(votes, alias.productCode, alias.distributorCode);
    }
    const codes = [...votes.values()];
    if (codes.length === 1 && fitsName(codes[0]!.code)) {
      const vote = codes[0]!;
      const where = [...vote.distributors].map((d) => distributorLabel(ctx, d)).join(" and ");
      const reason = vote.code === IGNORE_PRODUCT_CODE
        ? `${where} already ignores item ${item.raw} — not a Phoenix product.`
        : `${where} already maps item ${item.raw} to ${nameOf(ctx, vote.code)}.`;
      return { code: vote.code, confidence: 97, raw: item.raw, reason, source: "sister_code" };
    }
  }

  // 2. The same cleaned name, already mapped at another distributor (or the catalog's own name).
  const cleaned = cleanProductName(name);
  if (cleaned) {
    const votes = new Map<string, Vote>();
    for (const alias of others) {
      if (isCodeLike(alias.alias) || cleanProductName(alias.alias) !== cleaned) continue;
      if (!known.has(alias.productCode) || !fitsName(alias.productCode)) continue;
      tally(votes, alias.productCode, alias.distributorCode);
    }
    for (const product of activeCatalog(ctx.catalog)) {
      if (cleanProductName(product.name) === cleaned) tally(votes, product.code, "catalog");
    }
    const ranked = [...votes.values()].sort((a, b) => b.distributors.size - a.distributors.size);
    const total = ranked.reduce((sum, v) => sum + v.distributors.size, 0);
    const top = ranked[0];
    if (top && (ranked.length === 1 || top.distributors.size * 3 >= total * 2)) {
      const where = [...top.distributors].filter((d) => d !== "catalog").map((d) => distributorLabel(ctx, d));
      const source = where.length > 0 ? `${where.slice(0, 3).join(", ")}${where.length > 3 ? ` and ${where.length - 3} more` : ""}` : "the product list";
      const reason = top.code === IGNORE_PRODUCT_CODE
        ? `The same name is already ignored at ${source} — not a Phoenix product.`
        : `The same name is already mapped to ${nameOf(ctx, top.code)} at ${source}.`;
      return { code: top.code, confidence: ranked.length === 1 ? 92 : 85, raw: item.raw, reason, source: "known_name" };
    }
  }

  // 3. One catalog product with the same medicine, form, variant and strength.
  if (name) {
    const { fits } = sameStrengthMatches(name, ctx.catalog);
    if (fits.length === 1) {
      return {
        code: fits[0]!.code,
        confidence: 88,
        raw: item.raw,
        reason: `Same medicine, form and strength as ${fits[0]!.name}.`,
        source: "same_strength",
      };
    }
  }
  return null;
}

// When the item's family is ours but no product of it has the item's strength or form, say so: the
// usual answer is another company's pack or a strength Phoenix does not sell.
export function noMatchReason(item: ProductItem, ctx: ProductSuggestContext): string {
  const name = String(item.rawName || (isCodeLike(item.raw) ? "" : item.raw) || "").trim();
  if (!name) return `No name in the sheet and no sister distributor knows item ${item.raw} — pick it by hand.`;
  const { family, fits } = sameStrengthMatches(name, ctx.catalog);
  if (family.length > 0 && fits.length === 0) {
    return `Phoenix sells ${family.map((p) => p.name).join(", ")} — none has this item's strength or form. Likely not a Phoenix product.`;
  }
  if (fits.length > 1) return `Could be ${fits.map((p) => p.name).join(" or ")} — pick the right one.`;
  return "No confident match — pick it by hand.";
}

// The candidate list the AI sees: every product with the names distributors already use for it, and
// IGNORE with the names already set aside, so "not ours" is an answer it can give.
export function buildAiProductCandidates(catalog: CatalogProduct[], aliases: KnownProductAlias[], perProduct = 5): AiCandidate[] {
  const namesByCode = new Map<string, string[]>();
  for (const alias of aliases) {
    if (isCodeLike(alias.alias)) continue;
    const list = namesByCode.get(alias.productCode) ?? [];
    const cleaned = cleanProductName(alias.alias);
    if (cleaned && !list.some((n) => cleanProductName(n) === cleaned)) list.push(alias.alias.trim());
    namesByCode.set(alias.productCode, list);
  }
  const products = activeCatalog(catalog).map((p) => {
    const known = (namesByCode.get(p.code) ?? []).filter((n) => cleanProductName(n) !== cleanProductName(p.name)).slice(0, perProduct);
    const facts = [p.family ? `family ${p.family}` : "", p.line ? `line ${p.line}` : ""].filter(Boolean).join(", ");
    return { code: p.code, label: [p.name, facts ? `(${facts})` : "", known.length ? `— distributors call it: ${known.join("; ")}` : ""].filter(Boolean).join(" ") };
  });
  const ignored = (namesByCode.get(IGNORE_PRODUCT_CODE) ?? []).slice(0, 20);
  products.push({
    code: IGNORE_PRODUCT_CODE,
    label: `Not a Phoenix product (another company's medicine, or a strength or form Phoenix does not sell)${ignored.length ? ` — already set aside: ${ignored.join("; ")}` : ""}`,
  });
  return products;
}

export type AskAi = (unknowns: AiUnknown[], candidates: AiCandidate[]) => Promise<AiSuggestion[]>;

// The whole pipeline: free evidence for every item, then the AI for the named items still open, with
// every AI answer held to the item's own strength. Items the AI cannot settle come back with no code
// and the reason, so the page says why instead of leaving a silent blank.
export async function suggestProducts(items: ProductItem[], ctx: ProductSuggestContext, askAi: AskAi | null): Promise<ProductSuggestion[]> {
  const out = new Map<string, ProductSuggestion>();
  const open: ProductItem[] = [];
  for (const item of items) {
    if (!item?.raw) continue;
    const free = freeProductSuggestion(item, ctx);
    if (free) out.set(item.raw, free);
    else open.push(item);
  }
  const askable = open.filter((item) => /\p{L}{3,}/u.test(String(item.rawName || item.raw || "")));
  if (askAi && askable.length > 0) {
    const candidates = buildAiProductCandidates(ctx.catalog, ctx.aliases);
    const answers = await askAi(askable.map((i) => ({ raw: i.raw, rawName: i.rawName || i.raw })), candidates);
    for (const answer of answers) {
      const item = askable.find((i) => i.raw === answer.raw);
      if (!item || out.has(item.raw)) continue;
      const name = String(item.rawName || item.raw);
      if (answer.code !== IGNORE_PRODUCT_CODE && strengthConflicts(name, productByCode(ctx, answer.code))) continue;
      const confidence = typeof answer.confidence === "number" ? answer.confidence : 70;
      const why = answer.reason?.trim();
      const reason = answer.code === IGNORE_PRODUCT_CODE
        ? why || "Not a Phoenix product."
        : why || `Looks like ${nameOf(ctx, answer.code)}.`;
      out.set(item.raw, { code: answer.code, confidence, raw: item.raw, reason, source: "ai" });
    }
  }
  return items.filter((i) => i?.raw).map((item) => out.get(item.raw) ?? { code: null, confidence: 0, raw: item.raw, reason: noMatchReason(item, ctx), source: null });
}
