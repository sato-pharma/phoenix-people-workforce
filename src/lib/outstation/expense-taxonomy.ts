// Normalizers for outstation expense transportation + type, so the dashboard
// groups them consistently. The underlying data mixes case ("Car" vs "car",
// "Other" vs "other") and meeting expenses carry no transport mode, which split
// into duplicate / "Unspecified" buckets in the breakdowns, filters, and table.

/**
 * Canonical transportation mode. Real modes are car / train / bus / other; a meeting
 * expense has no travel, so a row with no transport mode but a meeting amount (or a
 * meeting trip type) is labelled "Meeting" — meetings are a legitimate, common expense.
 */
export function normalizeTransportation(
  transport: string | null | undefined,
  tripType: string | null | undefined,
  meetingAmount: number | null | undefined,
): string {
  const value = (transport ?? "").trim().toLowerCase();
  if (value === "car") return "Car";
  if (value === "train") return "Train";
  if (value === "bus") return "Bus";
  if (value === "other") return "Other";

  const isMeeting = (meetingAmount ?? 0) > 0 || (tripType ?? "").toLowerCase().includes("meeting");
  if (!value && isMeeting) return "Meeting";
  return "Other";
}

/** Title-case the expense type so case variants ("Other"/"other") collapse to one bucket. */
export function normalizeExpenseType(tripType: string | null | undefined): string {
  const value = (tripType ?? "").trim();
  if (!value) return "Unspecified";
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}
