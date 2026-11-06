/**
 * A place, in the words a reviewer reads — never the machine prefix in front of them.
 *
 * A Phoenix-submitted trip stores the address Google returned for the captured point, which opens
 * with a plus code ("3CGJ+3G, Nasr City, Cairo Governorate 4450113, Egypt"). The code is right and
 * stays on the record; it just says nothing to the person deciding the claim, and on a narrow list
 * it was the first thing on the line (owner, 2026-11-07: the rebuilt Expense Approvals). The
 * postal code and the country at the end are dropped for the same reason: every trip is in Egypt.
 *
 * Pure. The caller keeps the full text wherever it wants it (a `title`, the record itself).
 */

// The Open Location Code alphabet, 4 to 8 characters, a plus, then 2 or 3 more.
const LEADING_PLUS_CODE = /^[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}(?:\s*[,،]\s*|\s+)/i;
const TRAILING_COUNTRY = /\s*[,،]?\s*(?:Egypt|مصر)\s*$/i;
const TRAILING_POSTAL_CODE = /\s+\d{4,7}\s*$/;

export function displayPlace(text: string | null | undefined): string {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) return "—";
  let out = raw.replace(LEADING_PLUS_CODE, "");
  out = out.replace(TRAILING_COUNTRY, "");
  out = out.replace(TRAILING_POSTAL_CODE, "");
  out = out.replace(TRAILING_COUNTRY, "");
  out = out.replace(/[\s,،]+$/, "").trim();
  // A place that was ONLY a plus code (or only "Egypt") keeps its text rather than vanishing.
  return out || raw;
}
