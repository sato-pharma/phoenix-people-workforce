import type { BrickRef, Crosswalks } from "@/lib/sales/normalizer/types";

// THE ADDRESS IS THE FIRST SOURCE OF TRUST (owner, 2026-10-13: "source of trust number 1 a brick
// name in the customer address" … "make the importer read the address first"). A brick named in the
// customer's own address outranks the distributor's territory label and the stored customer mapping;
// only an owner ruling (confidence 100) and a direct brick id stand above it (resolvers.resolveBrick).
//
// Pure, no I/O. It is the matcher the 13 Oct 2026 audit ran over all 81,016 active map rows and
// hand-read at 57 of 60 on a fresh sample of wrong-AREA flags: a TOWN named in the address, inside
// the region the row already sits in, naming ONE brick. Every rule below cost a false flag in that
// sample, so none of them is decoration:
//   - a street, or the words after a street / owner marker (ش, شارع, بملك, بم…), is never a place;
//   - a name inside a longer one (ميت X, كفر X, منشاة X, ابو X, مسجد X…) is not that place;
//   - a governorate CITY alone (مدينة سوهاج, المنصورة…) says nothing about the area;
//   - a hit outside the row's region, or outside every governorate the address states, is a namesake;
//   - the 30-character Overseas / Ibn Sina address is cut at BOTH ends, so its last word is forgiven
//     and a first word that is the tail of a place name still counts as naming it.
// It moves a row only when the address does NOT name the brick the row would otherwise get, names
// exactly ONE other brick, and — across areas — names nothing at all in the current area.

export type AddressBaseline = { areaCode: string; brickId: string; regionCode: string } | null;

/** The only two maps the matcher reads, so the wrong-town scan need not load every alias table. */
export type AddressMaps = Pick<Crosswalks, "brickById" | "movedBrickIds">;

// Feeds the matcher never reads: tenders, hospitals, El Qema and the Egydrug branch sheet carry an
// institution or a depot, not a pharmacy's street address.
const NO_ADDRESS_DISTRIBUTORS = new Set(["QM", "PS-T", "RM-T", "SF-T", "IS-T", "EG-HOS", "EG-BR"]);

// Fixed-width address columns: [shortest, longest] length that means "the sheet cut it".
const CAP: Record<string, [number, number]> = {
  PS: [29, 30], IS: [29, 30], "IS-S": [29, 30], "IS-L": [29, 30], SF: [34, 35], "EP-PHS": [34, 35],
};

export function foldAddress(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ئ/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/(\d)(\p{L})/gu, "$1 $2")
    .replace(/(\p{L})(\d)/gu, "$1 $2")
    // glued admin / landmark words: "مركزالفيوم", "بملكسامي"
    .replace(/(^|[^\p{L}])(مركز|مدينه|محافظه|قريه|بندر|بجوار|امام|خلف|بملك|ناحيه)(?=\p{L})/gu, "$1$2 ")
    // the owner marker glued to the END of a village: "امشولبم فتح الله" is "امشول بم فتح الله"
    .replace(/(\p{L}{3,})بم(?=\s|$)/gu, "$1 بم")
    .replace(/(\p{L}{3,})بملك/gu, "$1 بملك");
}

function stripAl(t: string): string {
  if (t.length >= 4 && t.startsWith("ال")) return t.slice(2);
  if (t.length >= 6 && (t.startsWith("بال") || t.startsWith("وال"))) return t.slice(3);
  return t;
}
const toks = (s: string) => s.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(stripAl);
// spelling skeleton: long vowels dropped, and a final ه too ("زفته" = "زفتى")
const skel = (t: string) => t.replace(/(.{2,})ه$/, "$1").replace(/[اوي]/g, "");
const baseName = (n: string) => String(n).split(/\s*-\s*/)[0];

// a street marker — or an owner marker (بملك / ملك / بم: the words after it are a PERSON) — ends the
// place part of a segment
const STREET = new Set(["ش", "شارع", "طريق", "ميدان", "كوبري", "قنال", "ترعه", "حاره", "زقاق", "عطفه", "ممر", "محور", "كورنيش", "شياخه", "بملك", "ملك", "بم"]);
// single-word village prefixes: "منشأة X", "كفر X", "ميت X" name a DIFFERENT village than the bare word
const VILLAGE_PREFIX = new Set(["منشاه", "منشيه", "عزبه", "كفر", "نجع", "ميت", "منيه", "كوم", "تل", "دير", "ساحل", "جزيره", "شبرا", "طوخ"]);
// a hit preceded by one of these is part of a longer name (village, person, building) — not the place
const REJECT_BEFORE = new Set(["ميت", "محله", "منيه", "كفر", "نجع", "عزبه", "ابو", "سيدي", "بني", "عبد", "هارون", "شيخ", "تل", "ام", "ابن", "بنت", "اولاد", "ولاد", "منشاه", "دار", "برج", "مسجد", "جامع", "مجمع", "مشروع", "روضه", "عماره", "عمارات", "مدرسه", "مول", "كنيسه", "نادي", "فندق", "شركه", "مصنع", "بنك", "صيدليه", "تقسيم", "عرب", "شباب", "حوض", "مستشفي", "مستوصف", "مكتب", "سنترال", "جمعيه", "مخبز", "بنزينه", "معهد", "كليه", "جامعه", "عياده", "شرق", "غرب", "شمال", "جنوب", "شباس", "محكمه", "نيابه"]);
const REJECT_AFTER = new Set(["شرقي", "غربي", "بحري", "قبلي", "جديد", "جديده", "كبير", "كبري", "صغير", "صغري", "عبد", "ابو", "بني", "بن", "باشا", "بك", "شرقيه", "غربيه", "بحريه", "قبليه", "اولي", "ثانيه", "ثالثه", "رابعه", "خامسه", "سادسه", "سابعه", "شماليه", "جنوبيه", "ام", "له", "الله"]);
// common nouns that name a place only WITH the article ("الحمام", never "حمام")
const NEEDS_AL = new Set(["حمام", "رياض", "رحاب", "فتح"]);
// too common to name one place (kindergarten; a village name in every governorate)
const NEVER_EVIDENCE = new Set(["روضه"]);
// brick names that are also common PERSON names: a place only right after an admin word ("مركز بدر")
const PREFIXED_ONLY = new Set(["بدر", "شريف", "رشدي"]);
const PREFIX_WORDS = new Set(["مركز", "م", "مدينه", "قسم", "حي", "قريه", "مديريه", "تحرير"]);
// Keys that pointed at the WRONG area for most of the customers naming them in the 13 Oct 2026 audit
// (five or more customers, under half in the key's own area). Never evidence.
const UNRELIABLE = new Set(["حي سادس", "توفيقيه", "منيه سندوب", "بني رافع", "ميت كرما", "طوه", "اولاد ياس", "دير", "كفر غاب", "اشراف", "تله", "منشاه سلطان", "ابو مندور", "عزبه سكينه"]);
const GENERIC = new Set(["مدينه", "مركز", "قسم", "قريه", "حي", "شرق", "غرب", "شرقي", "غربي", "شرقيه", "غربيه", "بحري", "قبلي", "جديد", "جديده", "اول", "ثاني", "ثالث", "رابع", "كبير", "كبري", "صغير", "صغري", "منطقه", "ناحيه", "عزبه", "كفر", "نجع", "ميت", "منيه", "ابو", "بني", "سيدي", "شارع", "طريق", "جنوب", "شمال", "وسط", "بلد", "عرب", "مصر", "بحريه", "قبليه", "محطه", "مساكن", "عمارات", "اسكان", "تقسيم", "جزيره", "اخر", "اخري"]);
const ADMIN_PREFIX = new Set(["مدينه", "مركز", "قسم", "قريه", "ناحيه"]);

const GOV_TOKENS: Array<[string[], string]> = [
  [["اسكندريه"], "ALEX"], [["بحيره"], "BEHEIRA"], [["دمنهور"], "BEHEIRA"], [["قاهره"], "CAIRO"],
  [["جيزه"], "GIZA"], [["قليوبيه"], "QALYUBIA"], [["بنها"], "QALYUBIA"], [["منوفيه"], "MENOUFIA"],
  [["شبين", "كوم"], "MENOUFIA"], [["غربيه"], "GHARBIA"], [["طنطا"], "GHARBIA"], [["كفر", "شيخ"], "KAFRSHEIKH"],
  [["دقهليه"], "DAKAHLIA"], [["منصوره"], "DAKAHLIA"], [["شرقيه"], "SHARKIA"], [["زقازيق"], "SHARKIA"],
  [["دمياط"], "DAMIETTA"], [["بور", "سعيد"], "PORTSAID"], [["بورسعيد"], "PORTSAID"], [["اسماعيليه"], "ISMAILIA"],
  [["سويس"], "SUEZ"], [["فيوم"], "FAYOUM"], [["بني", "سويف"], "BENISUEF"], [["منيا"], "MINIA"],
  [["اسيوط"], "ASSIUT"], [["سوهاج"], "SOHAG"], [["قنا"], "QENA"], [["اقصر"], "LUXOR"], [["اسوان"], "ASWAN"],
  [["غردقه"], "REDSEA"], [["مطروح"], "MATROUH"],
];
const GOV_SINGLE = new Set(GOV_TOKENS.filter(([t]) => t.length === 1).map(([t]) => t[0]));
// The governorate(s) each area serves — the veto that drops a namesake village in another governorate.
const AREA_GOV: Record<string, string[]> = {
  AB1: ["ALEX"], AB2: ["ALEX"], AB3: ["ALEX", "MATROUH"], AB4: ["BEHEIRA"], AB5: ["BEHEIRA"],
  CA1: ["CAIRO"], CA2: ["CAIRO"], CA3: ["CAIRO"], CA4: ["CAIRO", "QALYUBIA"], CA5: ["CAIRO"], CA6: ["CAIRO", "QALYUBIA"],
  D11: ["QALYUBIA"], D12: ["MENOUFIA"], D13: ["MENOUFIA"], D14: ["GHARBIA"], D15: ["GHARBIA"], D16: ["KAFRSHEIKH"], D17: ["KAFRSHEIKH"],
  D21: ["DAKAHLIA"], D22: ["DAKAHLIA"], D23: ["DAKAHLIA"], D24: ["SHARKIA"], D25: ["SHARKIA"], D26: ["PORTSAID", "DAMIETTA"],
  GZ1: ["GIZA"], GZ2: ["GIZA"], GZ3: ["GIZA"], GZ4: ["GIZA"], GZ5: ["CAIRO", "GIZA"], GZ6: ["FAYOUM"], GZ7: ["GIZA"],
  OT1: ["NSINAI"], OT10: ["SSINAI"], OT2: ["SUEZ"], OT4: ["NEWVALLEY"], OT5: ["REDSEA"], OT6: ["LUXOR"], OT7: ["ASWAN"], OT8: ["REDSEA"], OT9: ["ISMAILIA"],
  UE1: ["MINIA"], UE2: ["MINIA"], UE3: ["ASSIUT"], UE4: ["ASSIUT"], UE5: ["SOHAG"], UE6: ["SOHAG"], UE7: ["QENA"], UE8: ["QENA"], UE9: ["BENISUEF"],
};
const CAPITAL_KEYS = new Set(["منصوره", "طنطا", "كفر شيخ", "بنها", "زقازيق", "دمنهور", "منيا", "اسيوط", "سوهاج", "قنا", "فيوم", "بني سويف", "اسوان", "اقصر", "دمياط", "اسماعيليه", "بور سعيد", "سويس", "شبين كوم", "اسكندريه", "قاهره", "جيزه", "محله كبري", "مطروح", "مرسي مطروح", "عريش", "غردقه"]);

type Entry = { brick: BrickRef; city: boolean; street: boolean };
type Gazetteer = {
  byFirst: Map<string, string[][]>;
  bricksByArea: Map<string, BrickRef[]>;
  keyIndex: Map<string, Entry[]>;
};

// One gazetteer per crosswalk load — an import scans tens of thousands of rows against it.
const gazetteerCache = new WeakMap<AddressMaps, Gazetteer>();

function gazetteer(maps: AddressMaps): Gazetteer {
  const cached = gazetteerCache.get(maps);
  if (cached) return cached;
  const keyIndex = new Map<string, Entry[]>();
  const byFirst = new Map<string, string[][]>();
  const bricksByArea = new Map<string, BrickRef[]>();
  const addKey = (tokens: string[], brick: BrickRef, city: boolean, street: boolean) => {
    if (!tokens.length) return;
    const key = tokens.join(" ");
    if (key.replace(/ /g, "").length < 3) return;
    if (tokens.length === 1 && GENERIC.has(tokens[0])) return;
    if (tokens.every((t) => /^\d+$/.test(t) || GENERIC.has(t))) return;
    const entries = keyIndex.get(key) ?? [];
    if (!entries.some((e) => e.brick.brickId === brick.brickId)) entries.push({ brick, city, street });
    keyIndex.set(key, entries);
    const firsts = byFirst.get(tokens[0]) ?? [];
    if (!firsts.some((x) => x.join(" ") === key)) firsts.push(tokens);
    byFirst.set(tokens[0], firsts);
  };
  for (const brick of maps.brickById.values()) {
    if (maps.movedBrickIds?.has(brick.brickId)) continue;
    const list = bricksByArea.get(brick.areaCode) ?? [];
    list.push(brick);
    bricksByArea.set(brick.areaCode, list);
    const t = toks(foldAddress(baseName(brick.brickName)));
    const street = t[0] === "ش" || t.some((x) => ["شارع", "طريق", "كوبري", "ميدان", "محور", "كورنيش", "ترعه"].includes(x));
    const city = t[0] === "مدينه" || CAPITAL_KEYS.has(t.join(" ")) || (ADMIN_PREFIX.has(t[0]) && CAPITAL_KEYS.has(t.slice(1).join(" ")));
    addKey(t, brick, city, street);
    if (ADMIN_PREFIX.has(t[0]) && t.length > 1) addKey(t.slice(1), brick, city, street);
  }
  for (const list of byFirst.values()) list.sort((a, b) => b.length - a.length);
  const built = { byFirst, bricksByArea, keyIndex };
  gazetteerCache.set(maps, built);
  return built;
}

type Hit = {
  before: string | undefined;
  compound: boolean;
  /** The hit is the last thing in its segment: "ش محمد كامل حسين النزهة الجديدة" ends on the place. */
  endsSegment: boolean;
  entries: Entry[];
  inStreet: boolean;
  key: string;
  /** Straight after the street marker, so it IS the street's name: "ش النزهة الجديدة". */
  namesStreet: boolean;
  tokens: string[];
};

function scan(address: string, distributorCode: string, gaz: Gazetteer) {
  const folded = foldAddress(address)
    .replace(/(^|[\s\d])ش\s*[/.]/g, "$1ش ")
    // building letter glued to the street marker: "14أش شريف" is "14 أ ش شريف"
    .replace(/(\d)\s*اش(?=\s)/g, "$1 ش");
  const cap = CAP[distributorCode];
  const truncated = !!cap && address.length >= cap[0] && address.length <= cap[1];
  const segments = folded.split(/[-–—/\\,،؛;_|().:+#*"]+/).map(toks).filter((s) => s.length);
  if (truncated && segments.length) {
    // the last word may be cut mid-word — drop it unless it is a complete known place / governorate
    const lastSeg = segments[segments.length - 1];
    const last = lastSeg[lastSeg.length - 1];
    if (!(gaz.keyIndex.has(last) || GOV_SINGLE.has(last))) lastSeg.pop();
  }
  const hits: Hit[] = [];
  const govs = new Set<string>();
  for (const st of segments) {
    let streetFrom = st.findIndex((t) => STREET.has(t));
    if (streetFrom === -1) streetFrom = st.length;
    for (let i = 0; i < st.length;) {
      const matched = (gaz.byFirst.get(st[i]) ?? []).find((kt) => i + kt.length <= st.length && kt.every((x, j) => st[i + j] === x));
      if (!matched) {
        if (i < streetFrom) for (const [gt, g] of GOV_TOKENS) if (gt.every((x, j) => st[i + j] === x)) govs.add(g);
        i += 1;
        continue;
      }
      const key = matched.join(" ");
      const before = st[i - 1];
      const after = st[i + matched.length];
      const compound = (before !== undefined && REJECT_BEFORE.has(before))
        || (after !== undefined && REJECT_AFTER.has(after))
        || (matched.length === 1 && VILLAGE_PREFIX.has(matched[0]) && after !== undefined);
      const personName = matched.length === 1 && PREFIXED_ONLY.has(key) && !PREFIX_WORDS.has(before ?? "");
      const inStreet = i >= streetFrom;
      hits.push({
        before,
        compound: compound || personName,
        endsSegment: i + matched.length === st.length,
        entries: gaz.keyIndex.get(key) ?? [],
        inStreet,
        key,
        namesStreet: inStreet && i === streetFrom + 1,
        tokens: matched,
      });
      if (!inStreet) for (const [gt, g] of GOV_TOKENS) if (gt.join(" ") === key) govs.add(g);
      i += matched.length;
    }
  }
  return { folded, govs, hits, truncated };
}

// Does the address name this brick (or block) — in any spelling? `strict` is the area-wide test.
function namesPlace(tokensAll: string[], name: string, lastPrefix: string | null, strict: boolean): boolean {
  const t = toks(foldAddress(baseName(name)));
  if (!t.length) return false;
  const core = ADMIN_PREFIX.has(t[0]) && t.length > 1 ? t.slice(1) : t;
  if (strict && core.length === 1 && GENERIC.has(core[0])) return false;
  const phrase = (arr: string[], hay: string[]) => arr.length > 0 && hay.some((_, i) => arr.every((x, j) => hay[i + j] === x));
  if (phrase(core, tokensAll) || phrase(t, tokensAll)) return true;
  const sk = core.map(skel);
  if (sk.join("").length >= (strict ? 3 : 2) && phrase(sk, tokensAll.map(skel))) return true;
  const joined = core.join("");
  if (joined.length >= (strict ? 5 : 4) && tokensAll.join("").includes(joined)) return true;
  if (core.some((x) => x.length >= (strict ? 5 : 4) && !GENERIC.has(x) && tokensAll.includes(x))) return true;
  if (strict) return false;
  return !!lastPrefix && lastPrefix.length >= 3 && core.some((x) => x.length > lastPrefix.length && x.startsWith(lastPrefix));
}

// Does the address name ANY place in this area? Only then may it NOT move the row out of it.
function namesArea(tokensAll: string[], areaCode: string, distributorCode: string, truncated: boolean, gaz: Gazetteer): boolean {
  const list = gaz.bricksByArea.get(areaCode) ?? [];
  const names = [...list.map((b) => b.brickName), ...list.map((b) => b.blockName ?? "").filter(Boolean)];
  if (names.some((n) => namesPlace(tokensAll, n, null, true))) return true;
  // "مركز طامية" names the brick "طميه": after an admin word, a same-skeleton token is the place
  const afterAdmin = tokensAll.filter((t, i) => i > 0 && ADMIN_PREFIX.has(tokensAll[i - 1]) && t.length >= 4).map(skel);
  if (afterAdmin.length && names.some((n) => toks(foldAddress(baseName(n))).some((t) => t.length >= 3 && afterAdmin.includes(skel(t))))) return true;
  // a fixed-width sheet cuts BOTH ends: "فرالدوار" is كفر الدوار, "قوس قرية" is فاقوس
  if (!CAP[distributorCode]) return false;
  // "… ترسا – مركز س": the markaz itself was cut to one letter. When that stub begins a place in this
  // area, the address may well be naming it — never move the pharmacy out on the village name alone.
  const stub = tokensAll[tokensAll.length - 1] ?? "";
  if (truncated && stub && PREFIX_WORDS.has(tokensAll[tokensAll.length - 2] ?? "")
    && names.some((n) => toks(foldAddress(baseName(n))).some((t) => !ADMIN_PREFIX.has(t) && t.startsWith(stub)))) return true;
  const joined = tokensAll.join("");
  return names.some((n) => {
    const t = toks(foldAddress(baseName(n)));
    const core = (ADMIN_PREFIX.has(t[0]) && t.length > 1 ? t.slice(1) : t).join("");
    if (core.length < 5) return false;
    for (const k of [1, 2]) if (core.length - k >= 3 && joined.startsWith(core.slice(k))) return true;
    return truncated && [4, 5, 6].some((k) => k < core.length && joined.endsWith(core.slice(0, k)));
  });
}

/**
 * The brick the customer's address names, when it should replace `baseline` (what the territory
 * label or the stored mapping would otherwise give). Null means "keep the baseline" — the address
 * agrees with it, names nothing usable, or is ambiguous. With no baseline at all, the address must
 * also state the governorate the brick sits in.
 */
export function addressBrick(
  input: { addressValues: (string | null | undefined)[]; baseline: AddressBaseline; distributorCode: string },
  maps: AddressMaps,
): BrickRef | null {
  const dist = String(input.distributorCode ?? "").trim().toUpperCase();
  if (NO_ADDRESS_DISTRIBUTORS.has(dist)) return null;
  // The matcher reads Arabic: Ibn Sina sends an English column first and the Arabic one second.
  const address = input.addressValues.map((v) => String(v ?? "").trim()).find((v) => /[؀-ۿ]/.test(v));
  if (!address) return null;

  const gaz = gazetteer(maps);
  const s = scan(address, dist, gaz);
  const fullTokens = toks(foldAddress(address));
  const lastPrefix = s.truncated ? fullTokens[fullTokens.length - 1] ?? null : null;
  const baseline = input.baseline;
  const mapped = baseline?.brickId ? maps.brickById.get(baseline.brickId) : undefined;
  if (mapped && namesPlace(fullTokens, mapped.brickName, lastPrefix, false)) return null;
  // Naming the current brick's BLOCK keeps the row in its area, but a brick inside it may still win.
  const blockNamed = !!mapped?.blockName && namesPlace(fullTokens, mapped.blockName, lastPrefix, false);

  const region = baseline?.regionCode || mapped?.regionCode || "";
  const areaCode = baseline?.areaCode || mapped?.areaCode || "";
  const tokensWithAl = s.folded.split(/[^\p{L}\p{N}]+/u);
  const evidence: Entry[][] = [];
  for (const h of s.hits) {
    if (h.inStreet || h.compound || NEVER_EVIDENCE.has(h.key) || UNRELIABLE.has(h.key)) continue;
    if (NEEDS_AL.has(h.key) && !tokensWithAl.some((t) => ["ال", "بال", "وال"].some((p) => t === p + h.key))) continue;
    // owner ruling: a منفلوط ADDRESS legitimately sits in Assuit 1 (the brick) OR Assuit 2
    if (h.key === "منفلوط" && (areaCode === "UE3" || areaCode === "UE4")) continue;
    const inRegion = h.entries.filter((e) => !e.street && (region ? e.brick.regionCode === region : s.govs.size > 0));
    // governorate veto: a hit outside every governorate the address states is a namesake
    const ok = inRegion.filter((e) => !s.govs.size || (AREA_GOV[e.brick.areaCode] ?? []).some((g) => s.govs.has(g)));
    if (ok.length) evidence.push(ok);
  }
  if (!evidence.length) return null;
  if (mapped && evidence.some((ev) => ev.some((e) => e.brick.brickId === mapped.brickId))) return null;

  // Towns only: a governorate city alone never places a pharmacy in an area.
  const townBricks = new Map<string, BrickRef>();
  for (const ev of evidence) for (const e of ev) if (!e.city) townBricks.set(e.brick.brickId, e.brick);
  if (townBricks.size !== 1) return null;
  const [target] = townBricks.values();
  if (mapped && target.brickId === mapped.brickId) return null;
  if (!areaCode || target.areaCode === areaCode) return target;
  // Across areas: only when nothing the address names sits in the current area.
  if (blockNamed || evidence.some((ev) => ev.some((e) => e.brick.areaCode === areaCode))) return null;
  if (namesArea(fullTokens, areaCode, dist, s.truncated, gaz)) return null;
  return target;
}

export type AddressFindingKind = "longer-name" | "other-town";

export type AddressFinding = {
  brick: BrickRef;
  kind: AddressFindingKind;
  /** The importer's own matcher would make this same move at the next upload. */
  nextUploadMoves: boolean;
};

// A shop or landmark, not where the pharmacy is: "بجوار معرض الفتح للسيراميك" was a Minia row flagged
// as Assiut's الفتح when the 3 Nov 2026 hand-read of the first 50 findings caught it.
const LANDMARK_BEFORE = new Set(["بجوار", "جوار", "امام", "خلف", "معرض", "محل", "فرع"]);

const containsPhrase = (outer: string[], inner: string[]) =>
  inner.length > 0 && outer.length > inner.length && outer.some((_, i) => inner.every((t, j) => outer[i + j] === t));

function withoutPhrase(tokens: string[], phrase: string[]): string[] {
  const at = tokens.findIndex((_, i) => phrase.every((t, j) => tokens[i + j] === t));
  return at === -1 ? tokens : [...tokens.slice(0, at), ...tokens.slice(at + phrase.length)];
}

/**
 * THE WRONG-TOWN FINDER'S READING (owner, 2026-11-03: "build 1"). Which other brick does this address
 * name, for a person to rule on? It decides nothing and is never read by an import.
 *
 * `addressBrick` cannot answer this and must not be widened to: it moves rows at upload, so it stops
 * the moment the address contains the current brick's name, and it ignores every hit outside the
 * row's region. Both are why 17 Heliopolis pharmacies sat on Alexandria's النزهه, their addresses
 * reading النزهة الجديدة, until they were found by hand on 3 Nov 2026. So a name that sits only INSIDE
 * a longer brick's name does not count as naming the current brick here, and another region counts
 * when the address states that governorate. Every other guard of `addressBrick` stands: nothing in the
 * current area named, exactly one town, no namesake outside a stated governorate.
 */
export function addressBrickFinding(
  input: { addressValues: (string | null | undefined)[]; currentBrickId: string; distributorCode: string },
  maps: AddressMaps,
): AddressFinding | null {
  const dist = String(input.distributorCode ?? "").trim().toUpperCase();
  if (NO_ADDRESS_DISTRIBUTORS.has(dist)) return null;
  const address = input.addressValues.map((v) => String(v ?? "").trim()).find((v) => /[؀-ۿ]/.test(v));
  if (!address) return null;
  const current = maps.brickById.get(String(input.currentBrickId ?? "").trim().toUpperCase());
  if (!current) return null;

  const gaz = gazetteer(maps);
  const s = scan(address, dist, gaz);
  const fullTokens = toks(foldAddress(address));
  const tokensWithAl = s.folded.split(/[^\p{L}\p{N}]+/u);
  const nameTokens = toks(foldAddress(baseName(current.brickName)));
  const currentCore = ADMIN_PREFIX.has(nameTokens[0]) && nameTokens.length > 1 ? nameTokens.slice(1) : nameTokens;
  const inStatedGov = (areaCode: string) => !s.govs.size || (AREA_GOV[areaCode] ?? []).some((g) => s.govs.has(g));
  const currentGovs = AREA_GOV[current.areaCode];
  const currentOutsideGov = s.govs.size > 0 && !!currentGovs && !currentGovs.some((g) => s.govs.has(g));

  // The fixed-width sheets cut the last word, which may be what made a name longer or the current brick.
  const tail = s.truncated ? (fullTokens[fullTokens.length - 1] ?? "").replace(/^ال/, "") : "";
  const cutBeforeLonger = (h: Hit) => !!tail && fullTokens[fullTokens.length - 2] === h.tokens[h.tokens.length - 1]
    && [...REJECT_AFTER].some((w) => w.length > tail.length && w.startsWith(tail));
  const currentKey = currentCore.join(" ");

  const towns = new Map<string, BrickRef>();
  const cityAreas = new Set<string>();
  let usedTokens = fullTokens;
  let longer = false;
  for (const h of s.hits) {
    if (h.compound || NEVER_EVIDENCE.has(h.key) || UNRELIABLE.has(h.key)) continue;
    if ((h.before && LANDMARK_BEFORE.has(h.before)) || cutBeforeLonger(h)) continue;
    // "القوص" on القوصيه is the current brick misspelt, not Qena's قوص.
    if (!currentOutsideGov && h.key !== currentKey && currentKey.startsWith(h.key)) return null;
    if (NEEDS_AL.has(h.key) && !tokensWithAl.some((t) => ["ال", "بال", "وال"].some((p) => t === p + h.key))) continue;
    if (h.key === "منفلوط" && (current.areaCode === "UE3" || current.areaCode === "UE4")) continue;
    const isLonger = containsPhrase(h.tokens, currentCore);
    // Words after a street marker are a street, unless they close the segment with a longer brick's
    // whole name and are not the street's own name.
    if (h.inStreet && !(isLonger && h.endsSegment && !h.namesStreet)) continue;
    const entries = h.entries.filter((e) => !e.street && inStatedGov(e.brick.areaCode));
    if (!entries.length) continue;
    if (entries.some((e) => e.brick.areaCode === current.areaCode)) return null;
    for (const e of entries) {
      if (e.city) cityAreas.add(e.brick.areaCode);
      else towns.set(e.brick.brickId, e.brick);
    }
    usedTokens = withoutPhrase(usedTokens, h.tokens);
    if (isLonger) longer = true;
  }
  if (towns.size !== 1) return null;
  const [target] = towns.values();
  // "منشية السادات / المحلة الكبرى": the address's own city is another governorate than the town.
  const targetGovs = AREA_GOV[target.areaCode];
  if (targetGovs && [...cityAreas].some((a) => AREA_GOV[a] && !AREA_GOV[a].some((g) => targetGovs.includes(g)))) return null;

  if (!currentOutsideGov) {
    if (tail.length >= 2 && currentCore[0].startsWith(tail)) return null;
    const lastPrefix = s.truncated ? fullTokens[fullTokens.length - 1] ?? null : null;
    if (namesPlace(usedTokens, current.brickName, lastPrefix, false)) return null;
    if (current.blockName && namesPlace(usedTokens, current.blockName, lastPrefix, false)) return null;
    if (namesArea(usedTokens, current.areaCode, dist, s.truncated, gaz)) return null;
    // Glued, so no token matches: "مركز ابوالمطامير" names أبو المطامير.
    const flat = (t: string[]) => t.join("").split("ال").join("");
    if (flat(currentCore).length >= 5 && flat(usedTokens).includes(flat(currentCore))) return null;
  }
  // Egypt reuses place names: another region needs the governorate said, or a name no shorter brick owns.
  if (target.regionCode !== current.regionCode && !longer && !s.govs.size) return null;

  const upload = addressBrick(
    {
      addressValues: input.addressValues,
      baseline: { areaCode: current.areaCode, brickId: current.brickId, regionCode: current.regionCode },
      distributorCode: dist,
    },
    maps,
  );
  return { brick: target, kind: longer ? "longer-name" : "other-town", nextUploadMoves: upload?.brickId === target.brickId };
}
