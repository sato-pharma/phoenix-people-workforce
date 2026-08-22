/**
 * Browser-side fetch for the organogram's mobile numbers, used ONLY when someone presses
 * Export.
 *
 * The numbers deliberately do not ride on `OrganogramReportRow`. The chart is a client
 * component that holds every row it draws, so a `mobileNumber` field there would put ~50
 * colleagues' personal numbers into the page payload of everyone who opens a chart, all
 * day, whether or not they ever export. Fetching here instead keeps them in a browser for
 * the few seconds an export takes, only for the person who asked, and the route writes an
 * `audit_logs` row for the pull before it answers.
 *
 * The server decides who is in the answer — see
 * `app/api/reports/organogram/contact-numbers/route.ts`. This module only reshapes it.
 */

import { canonicalHrIdKey } from "@/lib/hr-id";

const CONTACT_NUMBERS_ENDPOINT = "/api/reports/organogram/contact-numbers";

type ContactNumbersPayload = {
  contacts?: Array<{ hrId?: string | null; mobile?: string | null }>;
};

/**
 * HR ID (canonical key) to the mobile number to print.
 *
 * Throws on a failed request rather than resolving empty. An empty map would produce a
 * sheet with a blank Mobile column, which reads as "nobody has a number on file" — a
 * silent, confident lie. The caller surfaces the failure and the user retries.
 */
export async function fetchOrganogramMobileNumbers(): Promise<Map<string, string>> {
  const response = await fetch(CONTACT_NUMBERS_ENDPOINT, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Organogram contact numbers request failed (${response.status}).`);
  }

  const payload = (await response.json()) as ContactNumbersPayload;
  const byHrId = new Map<string, string>();

  for (const contact of payload.contacts ?? []) {
    const key = canonicalHrIdKey(contact?.hrId);
    const mobile = (contact?.mobile ?? "").trim();
    if (!key || !mobile) continue;
    byHrId.set(key, mobile);
  }

  return byHrId;
}
