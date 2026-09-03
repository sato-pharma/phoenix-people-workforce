// Canonical Egypt geography module — the single source of truth for turning
// free-text / Arabic / English place strings into one governorate, and for
// mapping a region to a centroid. Consolidates three previously-separate files:
//   - src/lib/utils/places.ts            (governorate aliases + extractKnownPlace)
//   - src/lib/employee-360/egypt-locations.ts (Arabic-orthography + town-level)
//   - src/lib/outstation/region-centroids.ts  (region → lat/lng centroid)
// Those paths now re-export from here.
//
// Place strings arrive in ~5 shapes: English governorate/city names (spelling
// drift "Kafr El-Shaikh" vs "Kafr El-Sheikh"), Arabic governorate names, and full
// Arabic street addresses where the governorate is the last comma-segment. They
// all describe the same ~27 governorates. canonicalizeLocation NEVER returns
// "Unknown"; resolveGovernorate returns null when nothing is confidently matched.

// ── Arabic / general normalisation ───────────────────────────────────────────
/** Fold the Arabic orthography variants that carry no meaning for a place name: diacritics, tatweel,
 *  bidi marks, the four alef forms, alef maqsura, ta marbuta and the hamza carriers. Exported because
 *  `arabic-name-key.ts` builds on exactly this normalisation — one spelling policy, not two. */
export function normalizeArabic(s: string): string {
  return s
    .replace(/[ً-ٰٟ]/g, "") // harakat/diacritics
    .replace(/ـ/g, "") // tatweel
    .replace(/[‎‏‪-‮]/g, "") // bidi marks
    .replace(/[أإآٱ]/g, "ا") // alef variants → ا
    .replace(/ى/g, "ي") // alef maqsura → ya
    .replace(/ة/g, "ه") // ta marbuta → ha
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي");
}

function normalize(s: string): string {
  return normalizeArabic(String(s ?? "").toLowerCase())
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // latin diacritics
    .replace(/[^a-z0-9؀-ۿ]+/g, " ") // keep latin + arabic, punctuation → space
    .replace(/\s+/g, " ")
    .trim();
}

export function containsArabic(value: string): boolean {
  return /[؀-ۿ]/.test(value);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const NOISE = /^(محافظه|مركز|مدينه|قسم|حي|شارع|ش|طريق|governorate|markaz|city|district|el|al)$/;

function titleCase(s: string): string {
  return s
    .split(" ")
    .filter((w) => w && !NOISE.test(normalizeArabic(w.toLowerCase())))
    .map((w) => (/[a-z]/i.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ")
    .trim();
}

// ── Governorate resolution ───────────────────────────────────────────────────
// canonical English governorate → recognisable name fragments (Arabic + English,
// including town names that resolve to that governorate). Order = priority.
const GOVERNORATE_KEYS: [string, string[]][] = [
  ["Kafr El-Sheikh", ["كفر الشيخ", "kafr el shaikh", "kafr el sheikh", "kafr elshaikh", "kafr elsheikh", "دسوق", "desouk", "disuq", "بلطيم", "baltim", "بيلا", "biyala", "الحامول", "el hamool", "hamul", "فوه", "fuwwah", "سيدي سالم", "قلين", "دمرو", "damru", "مطوبس", "riyadh"]],
  ["Dakahlia", ["الدقهليه", "dakahlia", "daqahliyah", "المنصوره", "mansoura", "دكرنس", "dikirnis", "اجا", " aga", "ميت غمر", "mit ghamr", "بلقاس", "belqas", "شربين", "sherbin", "منيه النصر", "طلخا", "talkha", "ميت الحلوج", "mit al halluj", "شيوه"]],
  ["Sharqia", ["الشرقيه", "sharqia", "sharkia", "الزقازيق", "zagazig", "بلبيس", "belbeis", "ابو حماد", "abu hammad", "منيا القمح", "فاقوس", "faqous", "ههيا", "ديرب نجم", "كفر صقر", "أبو كبير", "العاشر من رمضان", "10th of ramadan"]],
  ["Gharbia", ["الغربيه", "gharbia", "gharbiyah", "طنطا", "tanta", "المحله", "mahalla", "mahalla el kubra", "كفر الزيات", "kafr el zayat", "السنطه", "santa", "زفتى", "zifta", "سمنود", "samannoud", "بسيون", "basyoun", "قطور"]],
  ["Menoufia", ["المنوفيه", "menoufia", "menofia", "منوفيه", "شبين الكوم", "shibin el kom", "shibin", "اشمون", "ashmoun", "تلا", " tala", "بركه السبع", "birket el sabaa", "berket", "السادات", "sadat city", "منوف", "منف", "قويسنا", "quesna", "الباجور", "بركة السبع"]],
  ["Qalyubia", ["القليوبيه", "qalyubia", "qalyubiyah", "qalubeya", "بنها", "benha", "banha", "شبرا الخيمه", "shubra el kheima", "قليوب", "qalyub", "القناطر", "qanater", "الخانكه", "khanka", "طوخ", "toukh", "كفر شكر", "العبور", "obour"]],
  ["Beheira", ["البحيره", "beheira", "behira", "buhayrah", "دمنهور", "damanhour", "كفر الدوار", "kafr el dawwar", "رشيد", "rashid", "rosetta", "ايتاي البارود", "itay el baroud", "ابو حمص", "كوم حماده", "kom hamada", "الدلنجات", "حوش عيسى", "ابو المطامير", "بدر", "wadi el natrun", "وادي النطرون"]],
  ["Alexandria", ["الاسكندريه", "الإسكندرية", "alexandria", "alexandrie", "iskandariyah", "alex", "المنتزه", "montaza", "سيدي بشر", "sidi bishr", "العجمي", "agami", "برج العرب", "borg el arab", "المعموره", "سموحه", "smouha", "ميامي", "miami", "العصافره"]],
  ["Cairo", ["القاهره", "cairo", "kairo", "مصر الجديده", "heliopolis", "مدينه نصر", "nasr city", "المعادي", "maadi", "الزمالك", "zamalek", "حلوان", "helwan", "المطريه", "matariya", "el matariya", "عين شمس", "ain shams", "المعصره", "التجمع", "new cairo", "القاهره الجديده", "المرج", "el marg", "الساحل", "الوايلي", "شبرا مصر", "وسط البلد", "downtown", "الرحاب", "مدينتي", "madinaty", "بدر", "الشروق", "shorouk", "15 مايو"]],
  ["Giza", ["الجيزه", "giza", "gizah", "الهرم", "haram", "pyramids", "حدائق الاهرام", "hadayek el ahram", "faisal", "فيصل", "6 اكتوبر", "6th of october", "october", "الشيخ زايد", "sheikh zayed", "العياط", "al ayyat", "el ayyat", "ayatt", "البدرشين", "badrashin", "اوسيم", "oseem", "كرداسه", "kerdasa", "ابو النمرس", "الصف", "el saff", "منشأه القناطر", "امبابه", "imbaba", "بولاق الدكرور", "الدقي", "dokki", "المهندسين", "mohandessin", "العجوزه"]],
  ["Ismailia", ["الاسماعيليه", "ismailia", "ismailiyah", "فايد", "fayed", "القنطره", "qantara", "التل الكبير"]],
  ["Port Said", ["بورسعيد", "بور سعيد", "port said", "port fouad", "بور فؤاد"]],
  ["Damietta", ["دمياط", "damietta", "new damietta", "domiat", "dumyat", "kafr al battikh", "كفر البطيخ", "kafr saad", "كفر سعد", "faraskur", "فارسكور", "زرقا", "ras el bar"]],
  ["Suez", ["السويس", "suez", "عتاقه", "الجناين"]],
  ["North Sinai", ["شمال سيناء", "north sinai", "العريش", "arish", "الشيخ زويد", "رفح", "بئر العبد", "الحسنه"]],
  ["South Sinai", ["جنوب سيناء", "south sinai", "شرم الشيخ", "sharm", "دهب", "dahab", "نويبع", "nuweiba", "طور سيناء", "el tor", "سانت كاترين", "catherine", "رأس سدر"]],
  ["Beni Suef", ["بني سويف", "beni suef", "bani sweif", "banisuef", "الواسطى", "wasta", "ناصر", "ببا", "beba", "الفشن", "fashn", "سمسطا", "اهناسيا"]],
  ["Fayoum", ["الفيوم", "faiyum", "fayoum", "fayyum", "طاميه", "tamiya", "سنورس", "sinnuris", "ابشواي", "ibsheway", "اطسا", "itsa", "يوسف الصديق"]],
  ["Minya", ["المنيا", "minya", "minia", "ملوي", "mallawi", "بني مزار", "beni mazar", "مطاي", "matai", "ابو قرقاص", "abu qurqas", "سمالوط", "samalut", "مغاغه", "maghagha", "ديرمواس", "deir mawas", "العدوه", "adwa"]],
  ["Assiut", ["اسيوط", "assiut", "asyut", "asuit", "asiut", "assuit", "assiout", "assout", "القوصيه", "qusiya", "ديروط", "dairut", "ابنوب", "abnub", "منفلوط", "manfalut", "ابوتيج", "abutig", "الغنايم", "ساحل سليم", "البداري", "badari", "صدفا", "الفتح", "الستامونى", "satamuni", "as satamuni"]],
  ["Sohag", ["سوهاج", "sohag", "suhaj", "نجع حمادي", "nag hammadi", "naga hammadi", "اخميم", "akhmim", "طهطا", "tahta", "جرجا", "girga", "طما", "tima", "المراغه", "maragha", "البلينا", "balyana", "دار السلام", "ساقلته", "جهينه", "المنشاه"]],
  ["Qena", ["قنا", "qena", "qina", "نقاده", "naqada", "دشنا", "dishna", "قوص", "qus", "نجع حمادي", "ابو تشت", "abu tesht", "فرشوط", "farshut", "قفط", "qift", "الوقف"]],
  ["Luxor", ["الاقصر", "luxor", "uxor", "الاقصر", "اسنا", "esna", "الطود", "armant", "ارمنت", "البياضيه", "القرنه"]],
  ["Aswan", ["اسوان", "aswan", "assuan", "كوم امبو", "kom ombo", "ادفو", "edfu", "درو", "daraw", "نصر النوبه", "كلابشه", "ابو سمبل", "abu simbel"]],
  ["Red Sea", ["البحر الاحمر", "red sea", "الغردقه", "hurghada", "ghardaqa", "سفاجا", "safaga", "القصير", "quseir", "مرسى علم", "marsa alam", "رأس غارب", "ras gharib", "الشلاتين"]],
  ["New Valley", ["الوادي الجديد", "new valley", "الخارجه", "kharga", "الداخله", "dakhla", "الفرافره", "farafra", "باريس", "balat"]],
  ["Matrouh", ["مطروح", "matrouh", "matruh", "مرسى مطروح", "marsa matruh", "العلمين", "alamein", "الضبعه", "dabaa", "سيوه", "siwa", "سيدي براني", "الحمام", "hammam", "النجيله"]],
];

const NORMALIZED_GOVERNORATES: [string, string[]][] = GOVERNORATE_KEYS.map(([canonical, keys]) => [
  canonical,
  keys.map((k) => normalize(k)).filter(Boolean),
]);

/** Resolve a string to a canonical Egyptian governorate ONLY when a name is
 *  confidently recognised; returns null otherwise. Safe on free text like an
 *  expense description ("Interviews Asiut 2 territory" → "Assiut", but "By HR" → null). */
export function resolveGovernorate(raw: string | null | undefined): string | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const segments = text
    .split(/[,،]/)
    .map((s) => normalize(s))
    .filter(Boolean)
    .reverse();
  const candidates = [...segments, normalize(text)];
  for (const candidate of candidates) {
    for (const [canonical, keys] of NORMALIZED_GOVERNORATES) {
      for (const key of keys) {
        if (candidate === key || candidate.includes(` ${key} `) || candidate.includes(key)) {
          return canonical;
        }
      }
    }
  }
  return null;
}

/** Map an Egyptian LOCATION field to a canonical governorate. Falls back to the
 *  string's own cleaned primary place — never "Unknown". */
export function canonicalizeLocation(raw: string | null | undefined): string {
  const text = String(raw ?? "").trim();
  if (!text) return "Local area";
  const gov = resolveGovernorate(text);
  if (gov) return gov;
  const originalSegs = text.split(/[,،]/).map((s) => s.trim()).filter(Boolean);
  const primary = titleCase(originalSegs[originalSegs.length - 1] ?? text);
  return primary || "Local area";
}

/** Backward-compatible free-text place resolver (was src/lib/utils/places.ts).
 *  Returns the canonical governorate label, or "" if nothing is recognised. */
export function extractKnownPlace(value: string): string {
  return resolveGovernorate(value) ?? "";
}

/** Legacy governorate alias table, retained for backward compatibility. Prefer
 *  resolveGovernorate / canonicalizeLocation which cover far more spellings/towns. */
export const placeAliases: ReadonlyArray<{ aliases: string[]; label: string }> = GOVERNORATE_KEYS.map(([label, keys]) => ({
  label,
  aliases: keys,
}));

// ── Transport ────────────────────────────────────────────────────────────────
const TRANSPORT_KEYS: [string, string[]][] = [
  ["Car", ["car", "سياره", "عربيه", "private", "خاص", "own car", "auto"]],
  ["Bus", ["bus", "باص", "اتوبيس", "coach"]],
  ["Microbus", ["microbus", "micro", "ميكروباص", "ميكروباس"]],
  ["Train", ["train", "قطار", "railway", "سكه حديد"]],
  ["Taxi", ["taxi", "تاكسي", "uber", "اوبر", "cab"]],
  ["Plane", ["plane", "flight", "طياره", "طيران", "air"]],
];
const NORMALIZED_TRANSPORT = TRANSPORT_KEYS.map(([c, ks]) => [c, ks.map((k) => normalize(k))] as [string, string[]]);

/** Canonicalise a transport type; returns null for empty so callers can omit it. */
export function canonicalizeTransport(raw: string | null | undefined): string | null {
  const norm = normalize(String(raw ?? ""));
  if (!norm) return null;
  for (const [canonical, keys] of NORMALIZED_TRANSPORT) {
    if (keys.some((k) => norm === k || norm.includes(k))) return canonical;
  }
  return titleCase(String(raw)) || null;
}

// ── Region → map centroid (was src/lib/outstation/region-centroids.ts) ────────
export type RegionCentroid = { lat: number; lng: number };

function normalizeRegionKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const CENTROIDS: Record<string, RegionCentroid> = {
  // Org region groupings (brick master)
  "upper egypt": { lat: 27.1809, lng: 31.1837 },
  "delta 1": { lat: 30.7865, lng: 31.0004 },
  "delta 2": { lat: 31.0409, lng: 31.3785 },
  "delta 3": { lat: 30.5877, lng: 31.502 },
  "alex bhr": { lat: 31.2001, lng: 29.9187 },
  "alex behiera": { lat: 31.0418, lng: 30.4736 },
  "head office": { lat: 30.0444, lng: 31.2357 },
  egypt: { lat: 30.0444, lng: 31.2357 },

  // Governorates
  cairo: { lat: 30.0444, lng: 31.2357 },
  giza: { lat: 30.0131, lng: 31.2089 },
  alexandria: { lat: 31.2001, lng: 29.9187 },
  alex: { lat: 31.2001, lng: 29.9187 },
  beheira: { lat: 30.9876, lng: 30.4682 },
  behira: { lat: 30.9876, lng: 30.4682 },
  behiera: { lat: 30.9876, lng: 30.4682 },
  gharbia: { lat: 30.8754, lng: 31.0335 },
  dakahlia: { lat: 31.0409, lng: 31.3785 },
  sharqia: { lat: 30.7327, lng: 31.7195 },
  sharkia: { lat: 30.7327, lng: 31.7195 },
  manoufia: { lat: 30.5587, lng: 31.0094 },
  menoufia: { lat: 30.5587, lng: 31.0094 },
  menofia: { lat: 30.5587, lng: 31.0094 },
  monufia: { lat: 30.5587, lng: 31.0094 },
  qalyubia: { lat: 30.4078, lng: 31.2189 },
  qaliubiya: { lat: 30.4078, lng: 31.2189 },
  fayoum: { lat: 29.3084, lng: 30.8428 },
  faiyum: { lat: 29.3084, lng: 30.8428 },
  "beni suef": { lat: 29.0661, lng: 31.0994 },
  "bani suef": { lat: 29.0661, lng: 31.0994 },
  minya: { lat: 28.1099, lng: 30.7503 },
  minia: { lat: 28.1099, lng: 30.7503 },
  assiut: { lat: 27.1809, lng: 31.1837 },
  asyut: { lat: 27.1809, lng: 31.1837 },
  sohag: { lat: 26.5571, lng: 31.6996 },
  qena: { lat: 26.1551, lng: 32.716 },
  luxor: { lat: 25.6872, lng: 32.6396 },
  aswan: { lat: 24.0889, lng: 32.8998 },
  "port said": { lat: 31.2653, lng: 32.3019 },
  ismailia: { lat: 30.5965, lng: 32.2715 },
  suez: { lat: 29.9668, lng: 32.5498 },
  damietta: { lat: 31.4165, lng: 31.8133 },
  "kafr el sheikh": { lat: 31.1117, lng: 30.9396 },
  matrouh: { lat: 31.3543, lng: 27.2373 },
  matruh: { lat: 31.3543, lng: 27.2373 },
  "red sea": { lat: 27.2579, lng: 33.8116 },
  "north sinai": { lat: 31.1324, lng: 33.7995 },
  "south sinai": { lat: 27.9158, lng: 34.3299 },
  "new valley": { lat: 25.4914, lng: 30.5589 }, // Kharga — New Valley capital

  // Greater Cairo satellites and districts
  "new cairo": { lat: 30.0307, lng: 31.4695 },
  "5th settlement": { lat: 30.0307, lng: 31.4695 },
  "fifth settlement": { lat: 30.0307, lng: 31.4695 },
  tagamoa: { lat: 30.0307, lng: 31.4695 },
  "6th of october": { lat: 29.9318, lng: 30.9264 },
  "6 october": { lat: 29.9318, lng: 30.9264 },
  "sixth of october": { lat: 29.9318, lng: 30.9264 },
  helwan: { lat: 29.8455, lng: 31.3342 },
  "nasr city": { lat: 30.0544, lng: 31.3656 },
  maadi: { lat: 29.9591, lng: 31.2574 },
  obour: { lat: 30.2045, lng: 31.4736 },
  "el obour": { lat: 30.2045, lng: 31.4736 },
  shoubra: { lat: 30.0919, lng: 31.2494 },
  shubra: { lat: 30.0919, lng: 31.2494 },

  // Governorate capital cities (for raw city-name destinations)
  mansoura: { lat: 31.0409, lng: 31.3785 },
  tanta: { lat: 30.7865, lng: 31.0004 },
  zagazig: { lat: 30.5877, lng: 31.502 },
  damanhour: { lat: 31.0418, lng: 30.4736 },
  damanhur: { lat: 31.0418, lng: 30.4736 },
  banha: { lat: 30.4669, lng: 31.1828 },
  benha: { lat: 30.4669, lng: 31.1828 },
  "shibin el kom": { lat: 30.5587, lng: 31.0094 },
  shibin: { lat: 30.5587, lng: 31.0094 },
  hurghada: { lat: 27.2579, lng: 33.8116 },
  "sharm el sheikh": { lat: 27.9158, lng: 34.3299 },
  sharm: { lat: 27.9158, lng: 34.3299 },
  arish: { lat: 31.1324, lng: 33.7995 },
  "el arish": { lat: 31.1324, lng: 33.7995 },
  "el mahalla": { lat: 30.9726, lng: 31.1672 },
  mahalla: { lat: 30.9726, lng: 31.1672 },
  "10th of ramadan": { lat: 30.2937, lng: 31.7416 },
  "kafr el dawar": { lat: 31.1339, lng: 30.1288 },
};

/** Resolve a brick-master region name (or a governorate label) to a map centroid.
 *  Exact normalised match → progressively shorter prefixes → first token. */
export function resolveRegionCentroid(region: string | null | undefined): RegionCentroid | null {
  if (!region) return null;
  const key = normalizeRegionKey(region);
  if (!key) return null;
  if (CENTROIDS[key]) return CENTROIDS[key];
  const tokens = key.split(" ").filter(Boolean);
  for (let take = tokens.length - 1; take >= 1; take -= 1) {
    const prefix = tokens.slice(0, take).join(" ");
    if (CENTROIDS[prefix]) return CENTROIDS[prefix];
  }
  return tokens[0] && CENTROIDS[tokens[0]] ? CENTROIDS[tokens[0]] : null;
}
