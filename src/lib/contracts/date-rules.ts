function parseDateOnly(value: string | null | undefined) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.slice(0, 10));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
  return date;
}

function toDateOnlyString(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function anniversaryForYear(start: Date, year: number) {
  const month = start.getMonth();
  const day = start.getDate();
  const anniversary = new Date(year, month, day);

  if (anniversary.getMonth() !== month) {
    return new Date(year, month + 1, 0);
  }

  return anniversary;
}

export function nextContractAnniversary(
  startDate: string | null | undefined,
  today: Date = new Date(),
) {
  const start = parseDateOnly(startDate);
  if (!start) return null;

  const normalizedToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let year = Math.max(normalizedToday.getFullYear(), start.getFullYear() + 1);
  let candidate = anniversaryForYear(start, year);

  while (candidate.getTime() < normalizedToday.getTime()) {
    year += 1;
    candidate = anniversaryForYear(start, year);
  }

  return toDateOnlyString(candidate);
}

export function isDateOnlyBefore(left: string | null | undefined, right: string | null | undefined) {
  const leftDate = parseDateOnly(left);
  const rightDate = parseDateOnly(right);
  if (!leftDate || !rightDate) return false;
  return leftDate.getTime() < rightDate.getTime();
}
