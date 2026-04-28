const EMPTY_VALUES = new Set(["", "-", "n/a", "na", "null", "undefined"]);

export function normalizeHeaderName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function normalizeTextValue(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim().replace(/\s+/g, " ");

  if (EMPTY_VALUES.has(normalized.toLowerCase())) {
    return null;
  }

  return normalized;
}

export function normalizeEmail(value: unknown) {
  const text = normalizeTextValue(value);
  return text ? text.toLowerCase() : null;
}

export function normalizeHrId(value: unknown) {
  return normalizeTextValue(value)?.toUpperCase() ?? null;
}

export function normalizeDateValue(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  const text = normalizeTextValue(value);

  if (!text) {
    return null;
  }

  const parsed = new Date(text);

  if (Number.isNaN(parsed.getTime())) {
    return text;
  }

  return parsed.toISOString().slice(0, 10);
}

export function createCode(value: string | null) {
  if (!value) {
    return null;
  }

  return value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

export function createScopedCode(...parts: Array<string | null>) {
  return createCode(parts.filter(Boolean).join("_"));
}
