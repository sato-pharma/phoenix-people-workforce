// Recruitment / ATS — where a CV goes in the CABINET, the owner's Google Drive tree.
//
// THE RULE, IN THE OWNER'S WORDS (2026-09-12). "You will make every folder with every channel we
// receive CVs from … any CV received on this WhatsApp, folder it in this WhatsApp folder. And don't
// follow the data in the CV … Follow what they choose in the WhatsApp: the region and the area and
// the position." And, added in the same conversation: "Anything that may disturb our work, that's a
// red flag and that's separate. For example, the auto-forward."
//
// So the cabinet is CHANNEL FIRST and ANSWER DRIVEN:
//
//     <Channel> / <Position> / <Region> / <Area>        an applicant who answered the questions
//     <Channel> / Did not answer                        an applicant who never answered
//     Red flags / <Flag>                                anything that would mislead a recruiter
//
// WHAT CHANGED FROM THE TREE THIS REPLACES. The previous cabinet (Position / Region / Area, built
// 2026-09-07) filled every gap it could from the CV itself — the current job title, the degree, the
// address, a governorate the extractor read. Measured on production 2026-09-12: of 783 CVs whose
// sender never answered, 698 sat in a position folder and 666 in a region folder that the CV had
// been GUESSED into, 53 of them under "Outside Egypt". The owner read that tree as "totally
// misleading", and it was: a folder called "Cairo" held people who never said Cairo. Nothing here
// reads the CV any more. A person who did not answer is filed as exactly that.
//
// A CHANNEL IS NOT ALWAYS AN INBOX. Most CVs arrive from outside and their channel is the line they
// landed on, read from `ats_cv_intake_events`. A CV a person attached inside Phoenix arrives on the
// path they used, and `ats_files.upload_origin` is what says so — added 2026-09-21, after all 5
// hand-uploaded CVs on production were found parked under `Red flags/Source unknown`. The interview
// calendar and a plain upload onto a candidate each open their own folder; the WhatsApp inbox does
// not yet. See `CABINET_UPLOAD_ORIGIN_FOLDERS`.
//
// THE CHANNEL IS THE LINE THE CV ARRIVED ON, NOT THE PERSON. One applicant who wrote to the chatbot
// line and also emailed careers@ has one CV in each channel folder, because that is where each one
// actually arrived. Each WhatsApp number is its own folder, named by the number, so a third line the
// company adds tomorrow opens its own folder with no code change. Email is one folder: careers@ and
// hr@ are two inboxes of one channel, and the owner asked for folders per channel.
//
// RED FLAGS WIN, AND THE ORDER BETWEEN THEM IS DELIBERATE — a CV carries at most one, the first that
// applies:
//
//   1. Not a CV          the extractor's verdict on this very file was "not a CV" (a certificate, an
//                        ID card, a job posting). Nobody should open it looking for an applicant.
//   2. Duplicate copies  a byte-identical re-send of a file this candidate already sent. The ORIGINAL
//                        keeps its real folder; the copies are parked, never deleted.
//   3. Auto-forwarded    a CV the company forwarded to itself — a bulk import, a sender on the import
//                        list, or one of the company's own WhatsApp lines as the sender. The person
//                        in the file never wrote to us, so an "answered" stamp on the record belongs
//                        to somebody else's conversation. It stays here even if they answer later.
//   4. Sent by a colleague  an email from a company address. Somebody inside passed it on.
//   5. Source unknown    nothing on the file says where it came from — no intake record and no
//                        upload origin, or a WhatsApp record that never said which line.
//
// WHAT IS NOT A FLAG, ON PURPOSE. A rejected candidate's CV stays in its normal folder — rejection is
// a recruiting decision the app already shows, and hiding the file would lose the history. And an
// applicant who forwarded THEIR OWN CV from another chat is an applicant, not an auto-forward.
//
// PURE — no database, no network. The mirror and both Drive scripts hand in rows and read the
// answer, so the running site and a one-off re-file can never disagree about where a CV belongs.

import { candidateFolderKindLabels } from "@/lib/recruitment/candidate-folder";
import { candidateRegionLabels, type CandidateRegionCode } from "@/lib/recruitment/candidate-region";
import { candidateRoleFamilyLabels, type CandidateRoleFamily } from "@/lib/recruitment/candidate-role-family";
import { shouldMirrorCopy, type DedupableCvRow } from "@/lib/recruitment/cv-duplicate-copies";
import { regionFolderForArea, sanitizeDriveSegment, type AreaRegionMap } from "@/lib/recruitment/drive-cv-folders";
import { isEmailImportSender, parseEmailImportSenders } from "@/lib/recruitment/inbound/email-message-parser";
import { isWhatsAppImportSender, parseWhatsAppImportSenders } from "@/lib/recruitment/inbound/whatsapp-payload-parser";

/**
 * The cabinet's root folder name.
 *
 * Deliberately NOT "Phoenix CVs". The old tree keeps that name and keeps its files; a session that
 * confuses the two would write into a cabinet the owner asked to be left alone.
 */
export const CABINET_ROOT_NAME = "Phoenix CV Cabinet";

/** careers@ and hr@ together — two inboxes of one channel. */
export const EMAIL_CHANNEL_FOLDER = "Email";

/**
 * The channel folder for a CV attached inside Phoenix while booking an interview.
 *
 * A CHANNEL, not a red flag. The cabinet files by the line a CV arrived on, and this one arrived on
 * the interview calendar — a person in Phoenix attached it, and `ats_files.upload_origin` records
 * which path did. Before that column existed the file had no intake record and nothing else said
 * where it came from, so `cabinetRedFlagFor` could only call it "Source unknown": measured on
 * production 2026-09-21, 4 CVs the owner attached himself sat under `Red flags/Source unknown`,
 * reading as suspect when their provenance was the most certain of any CV in the cabinet.
 */
export const INTERVIEW_CALENDAR_CHANNEL_FOLDER = "Interview calendar";

/**
 * The channel folder for a CV dropped straight onto a candidate's record inside Phoenix.
 *
 * Also a CHANNEL, not a red flag, and for the same reason: somebody in Phoenix put the file there
 * deliberately. The owner's decision, 2026-09-21, on being shown that the one CV of this kind on
 * production — attached by him on 2026-08-18 — was sitting under `Red flags/Source unknown` reading
 * as suspect. "Source unknown" is now reserved for a CV nothing in the system can place at all.
 */
export const ATS_UPLOAD_CHANNEL_FOLDER = "Uploaded in Phoenix";

/**
 * The upload origins `ats_files.upload_origin` can hold, and the channel folder each opens.
 *
 * `whatsapp_inbox` is the one origin still without a folder. An attachment lifted out of the inbox
 * onto a candidate genuinely arrived on a WhatsApp line, so the open question is WHICH line's folder
 * it belongs in — not whether it deserves one — and that is the owner's to answer. Until he does it
 * keeps today's behaviour and reads as "Source unknown". Giving it a folder is one line here.
 */
export const CABINET_UPLOAD_ORIGIN_FOLDERS: Readonly<Record<string, string>> = {
  ats_upload: ATS_UPLOAD_CHANNEL_FOLDER,
  interview_calendar: INTERVIEW_CALENDAR_CHANNEL_FOLDER,
};

/** Under a channel, for a sender who never answered the questions. Nothing is guessed for them. */
export const DID_NOT_ANSWER_FOLDER = "Did not answer";

/** An applicant who answered but left the role question empty. */
export const POSITION_NOT_STATED = "Position not stated";

/** A role typed under "Other", or the bare "Other" choice. The shelf name the app already uses. */
export const OTHER_POSITIONS_FOLDER = candidateFolderKindLabels.other;

/**
 * An area the applicant TYPED that is not one of the company's areas. One folder per region rather
 * than one per spelling: "Qena north" must never sit beside the real "Qena 1" wearing an
 * official-looking name for a territory nobody owns.
 */
export const TYPED_AREA_FOLDER = "Typed area (not a company area)";

/** The top-level folder every red-flagged CV sits under, apart from the channel folders. */
export const RED_FLAGS_FOLDER = "Red flags";

export const cabinetRedFlags = ["not_a_cv", "duplicate_copy", "auto_forward", "colleague", "source_unknown"] as const;
export type CabinetRedFlag = (typeof cabinetRedFlags)[number];

export const cabinetRedFlagLabels: Record<CabinetRedFlag, string> = {
  auto_forward: "Auto-forwarded",
  colleague: "Sent by a colleague",
  duplicate_copy: "Duplicate copies",
  not_a_cv: "Not a CV",
  source_unknown: "Source unknown",
};

/** An email from this domain was passed on by somebody inside the company. */
export const COMPANY_EMAIL_DOMAIN = "satopharma.com";

/**
 * The company's own WhatsApp lines. A CV whose SENDER is one of these was forwarded by us — measured
 * 2026-09-12, 109 CVs reached the chatbot line from the advertised handset. Checked on top of the
 * import-sender list because a missing environment variable must not quietly turn our own forwards
 * into applicants.
 */
export const COMPANY_WHATSAPP_LINES: readonly string[] = ["201159888247", "201098500699"];

/** Everything this module needs about the candidate. Nothing the CV extractor wrote is on it. */
export type CabinetCandidateRow = {
  applied_for_job_title: string | null;
  preferences_declared_at: string | null;
  preferred_area_name: string | null;
  preferred_region_code: string | null;
};

/** The intake record of the CV — `ats_cv_intake_events`, joined by `file_id`. */
export type CabinetIntakeEvent = {
  channel: string | null;
  created_at?: string | null;
  mailbox_label?: string | null;
  raw_metadata: Record<string, unknown> | null;
  sender_identifier: string | null;
};

export type CabinetImportSenders = {
  email: readonly string[];
  whatsapp: readonly string[];
};

/** One CV file and everything that decides its folder. */
export type CabinetFileInput = {
  candidate: CabinetCandidateRow;
  fileId: string;
  importSenders?: CabinetImportSenders | null;
  intake: CabinetIntakeEvent | null;
  /** The latest extraction's verdict for THIS file. `null` means never judged, never "not a CV". */
  isCv: boolean | null;
  /** Every CV row the candidate has, this one included — the duplicate rule needs all of them. */
  siblings: readonly DedupableCvRow[];
  /**
   * `ats_files.upload_origin` — which in-app path uploaded this file, or null when it arrived through
   * inbound intake (where `intake` carries the channel instead). Old rows are all null, which is why
   * leaving it out reads exactly as the cabinet read before the column existed.
   */
  uploadOrigin?: string | null;
};

function clean(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text || null;
}

function isTrue(value: unknown): boolean {
  return value === true || String(value ?? "").trim().toLowerCase() === "true";
}

function lower(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

/** The two import-sender lists, read from the same variables the intake reads them from. */
export function cabinetImportSendersFromEnv(env: Record<string, string | undefined>): CabinetImportSenders {
  return {
    email: parseEmailImportSenders(env.RECRUITMENT_EMAIL_IMPORT_SENDERS),
    whatsapp: parseWhatsAppImportSenders(env.RECRUITMENT_WHATSAPP_IMPORT_SENDERS),
  };
}

/**
 * The folder for one WhatsApp line, named by its local number: `201098500699` → `WhatsApp 01098500699`.
 *
 * Named by the NUMBER rather than by a nickname, because the number is what the owner advertises and
 * what an applicant typed — and because a new line then files itself with nothing to configure.
 * A foreign number keeps its international form rather than being forced into Egypt's.
 */
export function whatsappLineFolderName(displayNumber: unknown): string | null {
  const digits = String(displayNumber ?? "").replace(/\D/g, "");
  if (digits.length < 8) return null;
  const local = digits.startsWith("20") && digits.length === 12 ? `0${digits.slice(2)}` : `+${digits}`;
  return `WhatsApp ${local}`;
}

/**
 * The channel folder a CV arrived through, or null when nothing on it said.
 *
 * The INTAKE RECORD is asked first and the upload origin second, because an intake record is where
 * the CV actually landed from outside the company, while an origin only ever says which screen inside
 * Phoenix wrote the row. A file cannot honestly carry both; if one ever did, the outside arrival is
 * the channel the owner asked us to file by.
 */
export function cabinetChannelFolder(
  intake: CabinetIntakeEvent | null,
  uploadOrigin?: string | null,
): string | null {
  const channel = lower(intake?.channel);
  if (intake) {
    if (channel === "email") return EMAIL_CHANNEL_FOLDER;
    if (channel === "whatsapp") return whatsappLineFolderName(intake.raw_metadata?.deliveredToDisplayNumber);
  }
  return CABINET_UPLOAD_ORIGIN_FOLDERS[lower(uploadOrigin)] ?? null;
}

/** Whether the company forwarded this CV to itself. See the header for why it outranks an answer. */
export function isAutoForwardedCv(intake: CabinetIntakeEvent | null, importSenders?: CabinetImportSenders | null): boolean {
  if (!intake) return false;
  const meta = intake.raw_metadata ?? {};
  if (isTrue(meta.bulkImport)) return true;
  const channel = lower(intake.channel);
  if (channel === "whatsapp") {
    const sender = clean(intake.sender_identifier) ?? clean(meta.wa_id);
    if (!sender) return false;
    return (
      isWhatsAppImportSender(sender, importSenders?.whatsapp ?? []) ||
      isWhatsAppImportSender(sender, COMPANY_WHATSAPP_LINES)
    );
  }
  if (channel === "email") {
    return isEmailImportSender(clean(intake.sender_identifier), importSenders?.email ?? []);
  }
  return false;
}

/** Whether an email came from a company address. */
export function isColleagueEmail(intake: CabinetIntakeEvent | null): boolean {
  if (!intake || lower(intake.channel) !== "email") return false;
  const sender = lower(intake.sender_identifier);
  const at = sender.lastIndexOf("@");
  if (at <= 0) return false;
  const domain = sender.slice(at + 1);
  return domain === COMPANY_EMAIL_DOMAIN || domain.endsWith(`.${COMPANY_EMAIL_DOMAIN}`);
}

/** The one red flag a CV carries, strongest first, or null for a clean CV. */
export function cabinetRedFlagFor(input: CabinetFileInput): CabinetRedFlag | null {
  if (input.isCv === false) return "not_a_cv";
  // Only a sibling list that actually CONTAINS this file can call it a copy. An empty or partial list
  // would make `shouldMirrorCopy` answer "not kept" for a file it never saw, and park an original.
  if (input.siblings.some((row) => row.id === input.fileId) && !shouldMirrorCopy(input.fileId, input.siblings)) {
    return "duplicate_copy";
  }
  if (isAutoForwardedCv(input.intake, input.importSenders)) return "auto_forward";
  if (isColleagueEmail(input.intake)) return "colleague";
  if (!cabinetChannelFolder(input.intake, input.uploadOrigin)) return "source_unknown";
  return null;
}

const MENU_LABEL_BY_KEY = new Map<string, string>(
  (Object.entries(candidateRoleFamilyLabels) as Array<[CandidateRoleFamily, string]>)
    .filter(([family]) => family !== "other")
    .map(([, label]) => [label.toLowerCase(), label]),
);

/**
 * The position folder for an applicant who answered: the role they TAPPED, verbatim.
 *
 * NOT classified. The previous cabinet ran every title through the job-title classifier, which is
 * right for a CV's free text and wrong here: a tapped menu row is already the company's own label,
 * and a typed "Other" answer is the applicant's own words, which the owner asked us to follow rather
 * than reinterpret. So a label matches case-insensitively (one live record says "Office coordinator")
 * and anything else is "Other positions".
 */
export function cabinetPositionFolder(candidate: CabinetCandidateRow): string {
  const title = clean(candidate.applied_for_job_title);
  if (!title) return POSITION_NOT_STATED;
  return MENU_LABEL_BY_KEY.get(title.toLowerCase()) ?? OTHER_POSITIONS_FOLDER;
}

function companyAreaName(typed: string, areaRegions: AreaRegionMap): string | null {
  if (areaRegions[typed]) return typed;
  const wanted = typed.toLowerCase();
  return Object.keys(areaRegions).find((area) => area.toLowerCase() === wanted) ?? null;
}

/**
 * The region and area folders for an applicant who answered.
 *
 * The REGION is the one they chose. Only when they chose none and named a company area is the region
 * taken from that area — through `regionFolderForArea`, which applies the recruitment Delta (3)
 * override rather than the raw sales region. With no region at all the path stops at the position:
 * a region folder they never chose is exactly the guess this tree exists to stop making.
 */
export function cabinetPlaceFolders(
  candidate: CabinetCandidateRow,
  areaRegions: AreaRegionMap,
): { area: string | null; region: string | null } {
  const typedArea = clean(candidate.preferred_area_name);
  const area = typedArea ? companyAreaName(typedArea, areaRegions) : null;
  const code = clean(candidate.preferred_region_code)?.toUpperCase() ?? null;
  const region = code
    ? candidateRegionLabels[code as CandidateRegionCode] ?? code
    : area
      ? regionFolderForArea(area, areaRegions)
      : null;
  if (!region) return { area: null, region: null };
  if (!typedArea) return { area: null, region };
  return { area: area ?? TYPED_AREA_FOLDER, region };
}

/**
 * The full cabinet path for one CV, UNROOTED — `ensureFolderPath` roots it at the cabinet.
 *
 * Sanitized here as well as at the Drive layer: a typed value carrying a "/" would otherwise read as
 * two folders in any path-shaped view of the tree.
 */
export function cabinetPathFor(input: CabinetFileInput, areaRegions: AreaRegionMap): string[] {
  const flag = cabinetRedFlagFor(input);
  let segments: string[];
  if (flag) {
    segments = [RED_FLAGS_FOLDER, cabinetRedFlagLabels[flag]];
  } else {
    // Not null: a CV with no channel is flagged "Source unknown" above.
    const channel = cabinetChannelFolder(input.intake, input.uploadOrigin) as string;
    if (!clean(input.candidate.preferences_declared_at)) {
      segments = [channel, DID_NOT_ANSWER_FOLDER];
    } else {
      const { area, region } = cabinetPlaceFolders(input.candidate, areaRegions);
      segments = [channel, cabinetPositionFolder(input.candidate), ...(region ? [region] : []), ...(area ? [area] : [])];
    }
  }
  return segments.map(sanitizeDriveSegment).filter(Boolean);
}

/** The FIRST intake record of a file — where it actually arrived. */
export function earliestIntakeEvent<T extends CabinetIntakeEvent>(events: readonly T[]): T | null {
  let first: T | null = null;
  for (const event of events) {
    if (!first || String(event.created_at ?? "") < String(first.created_at ?? "")) first = event;
  }
  return first;
}

/**
 * The LATEST extraction's verdict on a file. Only an explicit `false` is "not a CV" — a null is an
 * extraction that never judged, and treating it as a verdict would park real CVs.
 */
export function latestCvVerdict(rows: ReadonlyArray<{ created_at?: string | null; is_cv?: boolean | null }>): boolean | null {
  let latest: { created_at?: string | null; is_cv?: boolean | null } | null = null;
  for (const row of rows) {
    if (!latest || String(row.created_at ?? "") > String(latest.created_at ?? "")) latest = row;
  }
  if (!latest) return null;
  return latest.is_cv === false ? false : latest.is_cv === true ? true : null;
}
