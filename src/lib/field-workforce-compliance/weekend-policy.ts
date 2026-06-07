const fridayOnlyTitlePatterns = [
  /\bmedical\s+rep(?:resentative)?\b/i,
  /\bmedical\s+representative\b/i,
  /\bdistrict\s+(?:sales\s+)?manager\b/i,
];

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function isFieldWorkforceFridayOnlyTitle(title: string | null | undefined) {
  const normalized = String(title ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return fridayOnlyTitlePatterns.some((pattern) => pattern.test(normalized));
}

export function isFieldWorkforceFriday(dateIso: string) {
  if (!isIsoDate(dateIso)) return false;
  return new Date(`${dateIso}T00:00:00Z`).getUTCDay() === 5;
}

export function isFieldWorkforceSaturday(dateIso: string) {
  if (!isIsoDate(dateIso)) return false;
  return new Date(`${dateIso}T00:00:00Z`).getUTCDay() === 6;
}

export function isFieldWorkforceWeeklyOff(input: {
  dateIso: string;
  title?: string | null;
}) {
  if (isFieldWorkforceFriday(input.dateIso)) return true;
  if (!isFieldWorkforceSaturday(input.dateIso)) return false;
  return !isFieldWorkforceFridayOnlyTitle(input.title);
}
