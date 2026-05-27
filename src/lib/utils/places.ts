/**
 * Place / city alias resolution utilities.
 *
 * Used by expense reports, organogram, and any other view that needs
 * to normalize free-text city / governorate names (English and Arabic)
 * to a canonical label.
 *
 * Extracted from personal-expense-workload-dashboard.tsx so the alias
 * table can be shared and the dashboard's client bundle stays light.
 */

export const placeAliases: ReadonlyArray<{ aliases: string[]; label: string }> = [
  { label: "Alexandria", aliases: ["alexandria", "alex", "الإسكندرية", "اسكندرية"] },
  { label: "Manoufia", aliases: ["manoufia", "menoufia", "monufia", "menofia", "المنوفية", "منوفية"] },
  { label: "Kafr El Sheikh", aliases: ["kafr el sheikh", "kafr el sheykh", "kafr elsheikh", "كفر الشيخ"] },
  { label: "Port Said", aliases: ["port said", "بورسعيد"] },
  { label: "Beni Suef", aliases: ["beni suef", "bani suef", "بني سويف"] },
  { label: "Red Sea", aliases: ["red sea", "البحر الأحمر", "البحر الاحمر"] },
  { label: "North Sinai", aliases: ["north sinai", "شمال سيناء"] },
  { label: "South Sinai", aliases: ["south sinai", "جنوب سيناء"] },
  { label: "6th Of October", aliases: ["6th of october", "6 october", "sixth of october", "أكتوبر", "اكتوبر"] },
  { label: "New Cairo", aliases: ["new cairo", "tagamoa", "tagamo3", "التجمع"] },
  { label: "Cairo", aliases: ["cairo", "القاهرة", "sheraton", "heliopolis", "el nozha", "nozha", "matar", "airport"] },
  { label: "Giza", aliases: ["giza", "gizah", "الجيزة", "sheikh zayed", "zayed", "الشيخ زايد"] },
  { label: "Qalyubia", aliases: ["qalyubia", "qaliubiya", "القليوبية"] },
  { label: "Sharqia", aliases: ["sharqia", "sharkia", "الشرقية"] },
  { label: "Dakahlia", aliases: ["dakahlia", "dakahliya", "الدقهلية"] },
  { label: "Gharbia", aliases: ["gharbia", "الغربية"] },
  { label: "Beheira", aliases: ["beheira", "البحيرة"] },
  { label: "Damietta", aliases: ["damietta", "دمياط"] },
  { label: "Ismailia", aliases: ["ismailia", "الإسماعيلية", "الاسماعيلية"] },
  { label: "Suez", aliases: ["suez", "السويس"] },
  { label: "Fayoum", aliases: ["fayoum", "faiyum", "الفيوم"] },
  { label: "Minya", aliases: ["minya", "المنيا"] },
  { label: "Assiut", aliases: ["assiut", "asyut", "أسيوط", "اسيوط"] },
  { label: "Sohag", aliases: ["sohag", "سوهاج"] },
  { label: "Qena", aliases: ["qena", "قنا"] },
  { label: "Luxor", aliases: ["luxor", "الأقصر", "الاقصر"] },
  { label: "Aswan", aliases: ["aswan", "أسوان", "اسوان"] },
  { label: "Matrouh", aliases: ["matrouh", "matruh", "مطروح"] },
];

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function containsArabic(value: string) {
  return /[؀-ۿ]/.test(value);
}

function aliasMatches(value: string, alias: string) {
  if (containsArabic(alias)) return value.includes(alias);
  return new RegExp(
    `(^|[^a-z0-9])${escapeRegExp(alias.toLowerCase())}([^a-z0-9]|$)`,
  ).test(value);
}

/**
 * Map a free-text place string to a known canonical label, or empty
 * string if no alias matches.
 */
export function extractKnownPlace(value: string): string {
  const normalized = value.toLowerCase().replace(/\s+/g, " ");
  for (const place of placeAliases) {
    if (place.aliases.some((alias) => aliasMatches(normalized, alias))) {
      return place.label;
    }
  }
  return "";
}
