import { cardFieldsFor, type BusinessCardFields } from "@/lib/business-cards/card-content";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { hrIdsMatch, normalizeHrId } from "@/lib/auth/permissions";

/**
 * One person's signature facts, read from the register by HR id — the same row, the same formatting
 * the business card prints, so a number corrected for the card is corrected here too.
 *
 * Inactive staff are included on purpose: the picture is fetched every time a mail is opened, so a
 * leaver's old emails must keep their picture rather than turning into a broken box.
 */
export async function getSignatureCardForHrId(hrId: string | null | undefined): Promise<BusinessCardFields | null> {
  const wanted = normalizeHrId(hrId);
  if (!wanted) return null;

  const rows = await getEmployeeDirectoryRows({ includeInactive: true });
  const me = rows.find((row) => hrIdsMatch(row.hrId, wanted));
  if (!me) return null;

  return cardFieldsFor({
    areaName: me.areaName,
    displayName: me.displayName || me.fullName,
    jobTitle: me.jobTitle,
    lineName: me.lineName,
    mobileNumber: me.mobileNumber,
    workEmail: me.workEmail,
  });
}
