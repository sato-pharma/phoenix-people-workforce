function cleanCodePart(value: string | number | null | undefined, maxLength = 6) {
  const text = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "");

  return text ? text.slice(0, maxLength) : "";
}

function stableHash(value: string) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash.toString(36).toUpperCase().slice(-3).padStart(3, "0");
}

export function generateShortVacancyCode(input: {
  parts?: Array<string | number | null | undefined>;
  prefix?: string;
  primary?: string | number | null;
}) {
  const prefix = cleanCodePart(input.prefix ?? "VAC", 5) || "VAC";
  const seedParts = [input.primary, ...(input.parts ?? [])].filter(
    (part) => String(part ?? "").trim().length > 0,
  );
  const seed = seedParts.map((part) => String(part).trim()).join("|") || "vacancy";
  const readable = cleanCodePart(input.primary, 6) || cleanCodePart(seedParts[0], 6) || "AUTO";

  return `${prefix}-${readable}-${stableHash(seed)}`;
}

