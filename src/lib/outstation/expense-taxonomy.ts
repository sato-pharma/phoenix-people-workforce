// Normalizers for outstation expense transportation + type, so the dashboard
// groups them consistently. The underlying data mixes case ("Car" vs "car",
// "Other" vs "other") and meeting expenses carry no transport mode, which split
// into duplicate / "Unspecified" buckets in the breakdowns, filters, and table.

/**
 * Canonical transportation mode — car / train / bus / other only. Meeting expenses
 * have no travel mode; they return "" so they are excluded from the transportation
 * breakdown and appear only in the "Spend by type" chart via their tripType.
 */
export function normalizeTransportation(
  transport: string | null | undefined,
  _tripType: string | null | undefined,
  _meetingAmount: number | null | undefined,
): string {
  const value = (transport ?? "").trim().toLowerCase();
  if (value === "car") return "Car";
  if (value === "train") return "Train";
  if (value === "bus") return "Bus";
  if (value === "other") return "Other";
  if (value === "no_ticket") return "No ticket";
  return "";
}

/** Title-case the expense type so case variants ("Other"/"other") collapse to one bucket. */
export function normalizeExpenseType(tripType: string | null | undefined): string {
  const value = (tripType ?? "").trim();
  if (!value) return "Unspecified";
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}
