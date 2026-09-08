// The values Phoenix fills in when the person being messaged is an EMPLOYEE rather than a candidate.
//
// WHY THIS EXISTS AT ALL. Measured on production 2026-09-08: 30 people were inside their 90-day
// probation window and exactly ONE of them had a candidate record carrying a phone number. Nothing
// links an employee back to the CV they arrived as, so a probation message driven off `ats_candidates`
// would have been unusable for 29 of the 30 people it is for — the recruiter typing the name, the
// number and the date by hand every time, which is the opposite of the one click every other
// template in this feature gives.
//
// ONE VOCABULARY, DELIBERATELY. The auto keys stay the candidate-flavoured ones — `candidate_name`,
// `candidate_first_name`, `job_title`. They read a little oddly against an employee, and the
// alternative is worse: a second set of keys means every template that should work for both has to
// be written twice, and the day they drift is the day one of them is missing a fix the other got.
// The key names describe the SLOT, not the person's employment status.

import { systemLegalEntity } from "@/config/system-settings";
import { candidateSuppliedDocumentList } from "@/lib/hiring-documents/candidate-supplied";
import { formatPhoenixLongDate } from "@/lib/i18n/format";
// 🔴 THE OWNER-LOCKED PROBATION RULE. `src/lib/probation/date.ts` is the single source of truth:
// probation ends at hire + 90 DAYS, not "+3 calendar months". Never re-derive it here.
import { probationEndDate } from "@/lib/probation/date";
import { firstNameOf } from "@/lib/recruitment/whatsapp-templates/candidate-context";
import { recruitmentDb, textOrNull } from "@/lib/recruitment/db";
import { toWhatsAppDialNumber } from "@/lib/recruitment/whatsapp-templates/send-link";
import type { AutoVariableKey } from "@/lib/recruitment/whatsapp-templates/variables";

export type EmployeeSendContext = {
  employeeHrId: string;
  fullName: string;
  jobTitle: string;
  /** Digits-only dialable number, or null when nothing on file can be read with confidence. */
  dialNumber: string | null;
  /** Which stored column the number came from — shown on screen so the sender can sanity-check it. */
  numberSource: "mobile" | null;
  autoValues: Record<AutoVariableKey, string>;
};

/**
 * Load one employee and work out everything that can be answered without asking.
 *
 * THE NUMBER NEEDS THE EGYPTIAN REPAIR, and this is not a nicety here. 126 of the 159 employees
 * carrying a mobile number have lost the leading zero to a spreadsheet import — stored as
 * `1XXXXXXXXX` rather than `01XXXXXXXXX` (production, 2026-09-08). Without `toWhatsAppDialNumber`
 * four employees in five would be undialable, which reads as "no number on file" rather than as a
 * storage defect.
 *
 * 🔴 THE PROBATION END DATE IS DERIVED, NEVER READ FROM `employees.probation_end_date`. That column
 * is NULL for all 186 employees and has never been written by anything — so a reader that trusted it
 * would report "no date" for every person alive, silently, and look like missing data rather than
 * like the wrong source. `probationEndDate(hire_date)` is the owner-locked rule and the only answer.
 */
export async function loadEmployeeSendContext(
  employeeHrId: string,
  senderName: string | null,
): Promise<EmployeeSendContext | null> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("employees")
    .select("hr_id,full_name,nickname,job_title,hire_date,mobile_number")
    .eq("hr_id", employeeHrId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;

  const row = data as Record<string, unknown>;
  const fullName = String(row.full_name ?? "").trim();
  const jobTitle = textOrNull(row.job_title) ?? "";

  const mobile = toWhatsAppDialNumber(textOrNull(row.mobile_number));

  // The end of the 90-day window, as a date a person can read. An unknown hire date leaves this
  // EMPTY — never "—" — so `renderTemplate` reports it MISSING and the send is refused until a human
  // types the real day. A dash rendered into a message is a hole that looks like text.
  const documentList = await candidateSuppliedDocumentList();

  const endDateOnly = probationEndDate(textOrNull(row.hire_date));
  const probationEnd = endDateOnly ? formatPhoenixLongDate(endDateOnly) : "";

  return {
    autoValues: {
      candidate_first_name: firstNameOf(fullName),
      candidate_name: fullName,
      company_name: systemLegalEntity.legalNameEn,
      // An employee's REAL job title, not what they once applied for. This is the one place the
      // employee path deliberately answers a shared key from a different column than the candidate
      // path does — a confirmed employee is addressed as what they now are.
      job_title: jobTitle,
      probation_end_date: probationEnd,
      sender_name: senderName ?? "",
      // Left to the candidate path. An employee's first working day is their hire date, but this key
      // means "the start date on the offer letter" and quietly redefining it per target is how two
      // templates come to mean different things by the same word.
      start_date: "",
      // The joining-document list is NOT person-derived — it is the same for everybody — so the
      // employee path fills it exactly as the candidate path does. Leaving it blank here would make
      // the same template behave differently depending on who it was aimed at.
      document_list: documentList,
    },
    dialNumber: mobile,
    employeeHrId: String(row.hr_id),
    fullName,
    jobTitle,
    numberSource: mobile ? "mobile" : null,
  };
}
