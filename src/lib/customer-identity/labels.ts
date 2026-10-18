import type { IdentitySource } from "@/lib/customer-identity/types";

/**
 * What each source is CALLED on a screen — in one place, because three screens now say it.
 *
 * 🔴 ONE MAP, NEVER A COPY PER SCREEN. The workspace, the master's own profile and the Customer
 * 360 note all name the same five systems, and a fourth screen naming `direct_order` "Direct
 * order desk" while the other three say "Direct orders" is how the same link reads as two
 * different things depending on where the owner opened it. A label drifting is not a crash, which
 * is exactly why it goes unnoticed.
 *
 * 🔴 AN UNKNOWN SOURCE FALLS BACK TO ITS OWN KEY RATHER THAN TO "Unknown". A source added to the
 * union and forgotten here then reads as `visit_feedback` on the screen — ugly, obvious, and
 * fixed in a minute — where "Unknown" would read as a deliberate statement about the data and
 * could sit there for months.
 */
const SOURCE_LABEL: Record<IdentitySource, string> = {
  direct_order: "Direct orders",
  ireports360: "iReports360",
  marketing: "Marketing register",
  marketing_customer: "Marketing customers",
  phoenix_crm: "Phoenix CRM",
  // Named for what it IS, so nobody reads it as a register that could be opened: it is a name a
  // rep wrote on a visit, and there is no row behind it to look up.
  visit_feedback: "Typed on a visit",
};

export function identitySourceLabel(source: IdentitySource | string): string {
  return SOURCE_LABEL[source as IdentitySource] ?? String(source);
}
