import { codeOrWords } from "@/lib/format/code-label";

// A request's status as a person reads it, wherever it is shown outside its own module's screen —
// the private calendar's chips, filters and agenda, and the portal's activity lists. An item's
// status arrives as its source's own code (`pending_hr`, `performed`, `holiday`) or, for
// attendance, as words already written for people ("Late", "Short day"). Codes are named here;
// anything else keeps its own wording, and a stray code is turned into words by `codeOrWords`.
//
// Moved out of src/components/employee-portal/private-calendar.tsx so a second screen never grows
// its own copy of the same map.

const REQUEST_STATUS_LABELS: Readonly<Record<string, string>> = {
  approved: "Approved",
  holiday: "Holiday",
  needs_assignment: "Awaiting assignment",
  pending: "Pending",
  pending_hr: "Waiting for HR",
  pending_manager: "Waiting for manager",
  pending_review: "Under review",
  performed: "Done",
  rejected: "Rejected",
  submitted: "Submitted",
};

export function requestStatusLabel(status: string | null | undefined): string {
  const raw = String(status ?? "").trim();
  if (!raw) return "";
  return REQUEST_STATUS_LABELS[raw.toLowerCase()] ?? codeOrWords(raw);
}
