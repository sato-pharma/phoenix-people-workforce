/**
 * Phoenix CRM — Place checks: the titled card every panel of the board sets its lists in.
 *
 * It is the admin shell's own titled card, under the board's name for it, so the board keeps the look of
 * its sibling pages (Same place, Same customer, Camera reviews).
 *
 * 🔴 A PANEL DRAWS NO TABLE. Each list a panel holds owns its table AND its phone cards (`CrmCardsOnPhone`):
 * the waiting queue, the buildings, the places in use, the sent-back customers, the scorecard. The
 * fits-the-screen rule is therefore proven where the table is, not where its title is:
 * `tests/phoenix-crm-place-check-lanes.test.ts` reads every list a panel draws for its phone cards, and
 * `tests/table-structure-ratchet.test.ts` reads each of those list files as the table file it is.
 */

export { AdminTableShell as PlaceCheckSection } from "@/components/admin/admin-design-system";
