import { createHmac } from "node:crypto";

import { systemAccessContext } from "@/lib/auth/permissions";
import { openAndAnnounceCrmAccountSetup } from "@/lib/crm/account-setup-notify";
import { provisionNewHireAccess } from "@/lib/employees/access-provisioning";
import {
  getEmployeeDirectoryRows,
  isActiveLifecycleStatus,
  upsertEmployee,
  type EmployeeMutationInput,
} from "@/lib/employees/employee-directory";
import { uploadEmployeePhoto } from "@/lib/employees/employee-photo";
import { generateNextHrIdForLine } from "@/lib/employees/hr-id-helper";
import { resolveGovernorate } from "@/lib/geo/egypt-locations";
import { attachHiringDocumentFiles } from "@/lib/hiring-documents/service";
import { joiningFormMailboxAddress } from "@/lib/new-hire-mailbox/address";
import { openAndAnnounceNewHireMailboxes } from "@/lib/new-hire-mailbox/notify";
import { logError, logInfo } from "@/lib/observability/log";
import { readOfferAcceptToken } from "@/lib/offers/accept-token";
import { announceJoiningFormBlocked } from "@/lib/offers/accepted-offer-alert";
import { buildOfferHireDraft } from "@/lib/offers/hire-draft";
import {
  JOINING_FORM_GOVERNORATES,
  JOINING_FORM_STATE_MESSAGE,
  joiningFormPaymentMode,
  joiningFormState,
  offerRequiresSeat,
  sameJoinerName,
  validateJoiningFacePhoto,
  validateJoiningForm,
  validateJoiningIdPhotos,
  type JoiningFormField,
  type JoiningFormPhotoField,
  type JoiningFormState,
  type JoiningFormUploadField,
} from "@/lib/offers/joining-form";
import {
  claimOfferForJoiningForm,
  getOffer,
  isOfferNotFound,
  releaseOfferJoiningClaim,
  stampOfferAcceptedByJoiningForm,
} from "@/lib/offers/service";
import type { OfferRecord, OfferVacancyOption } from "@/lib/offers/types";
import { findOpenOfferVacancy } from "@/lib/offers/vacancies";
import { resolveStandardSalaryAllowances } from "@/lib/payroll/allowance-policy";
import { deriveSalaryFromNet } from "@/lib/payroll/salary-autofill";
import { quotedOrClause } from "@/lib/supabase/search-filter";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { todayInCairo } from "@/lib/date-only";

/**
 * The joining form's I/O — the read behind the page and the write behind Submit (owner, 2026-10-08).
 * The rules themselves are pure, in ./joining-form.ts.
 *
 * ── THE HIRE GOES THROUGH THE SAME CHAIN AS HR'S ADD EMPLOYEE, in the same order ──
 * `app/api/employees/route.ts` POST: `upsertEmployee` (HR ID, seat trigger, vacancy close,
 * replacement ownership) → `provisionNewHireAccess` → `openAndAnnounceCrmAccountSetup` →
 * `openAndAnnounceNewHireMailboxes`. A joiner who filled the form is the same hire HR would have
 * typed, so he must land in exactly the same state; `tests/offer-joining-form.test.ts` pins that
 * both doors call all four. The money is the hire bridge's (`buildOfferHireDraft` hands over the
 * NET) run through `deriveSalaryFromNet`, the Employee Master's own chain — nothing here derives a
 * salary of its own, and `src/lib/payroll/policy.ts` is untouched.
 *
 * ── No login, so every input is a stranger's ──
 * The token is checked, the offer state is re-read, every answer is validated server-side whatever
 * the page did, and only the fields the candidate is allowed to set reach the record — everything
 * else comes from the offer and the seat.
 */

/** The seat-side facts the page shows and the record is written from. */
export type JoiningFormSeat = {
  areaCode: string | null;
  areaId: number | null;
  areaName: string | null;
  departmentId: number | null;
  departmentName: string | null;
  lineId: number | null;
  lineName: string | null;
  managerHrId: string | null;
  managerName: string | null;
  positionId: number | null;
  positionTitle: string | null;
  regionName: string | null;
};

export type JoiningFormView =
  | { kind: "invalid" }
  | { body: string; kind: "closed"; state: Exclude<JoiningFormState, "open">; title: string }
  | {
      kind: "open";
      offer: {
        candidateEmail: string;
        candidateName: string;
        reference: string;
        salutationName: string;
      };
      job: {
        contractType: string;
        departmentName: string | null;
        hireDate: string;
        hrIdPreview: string | null;
        jobTitle: string;
        lineName: string | null;
        areaName: string | null;
        regionName: string | null;
        managerHrId: string | null;
        managerName: string | null;
        satoEmail: string | null;
        satoEmailReason: string | null;
      };
      pay: {
        baseSalary: number;
        basicSalary: number;
        extraCostOfLiving: number;
        fuelAllowance: number;
        grossSalary: number;
        netSalary: number;
      } | null;
      residence: {
        areaOptions: string[];
        defaultCity: string | null;
        /** Per area option, the governorate it pre-selects (Arabic value) when one is recognised. */
        cityByArea: Record<string, string>;
      };
    };

/** Full time unless the offer says otherwise — the only contract type the master holds today. */
const DEFAULT_CONTRACT_TYPE = "full time";

function contractTypeLabel(value: string): string {
  return value.replace(/\b\w/g, (c) => c.toUpperCase());
}

function governorateValue(english: string | null): string | null {
  if (!english) return null;
  const match = JOINING_FORM_GOVERNORATES.find((g) => g.label.startsWith(`${english} ·`));
  return match?.value ?? null;
}

async function loadSeat(vacancy: OfferVacancyOption | null): Promise<JoiningFormSeat | null> {
  if (!vacancy) return null;
  const db = getSupabaseAdmin();
  const [area, department] = await Promise.all([
    vacancy.areaId
      ? db.from("areas").select("code,name").eq("id", vacancy.areaId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    vacancy.departmentId
      ? db.from("departments").select("name").eq("id", vacancy.departmentId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  const areaRow = (area.data ?? null) as { code?: string | null; name?: string | null } | null;
  const departmentRow = (department.data ?? null) as { name?: string | null } | null;
  return {
    areaCode: areaRow?.code ?? null,
    areaId: vacancy.areaId,
    areaName: vacancy.areaName ?? areaRow?.name ?? null,
    departmentId: vacancy.departmentId,
    departmentName: departmentRow?.name ?? null,
    lineId: vacancy.lineId,
    lineName: vacancy.lineName,
    managerHrId: vacancy.managerHrId,
    managerName: vacancy.managerName,
    positionId: vacancy.positionId,
    positionTitle: vacancy.positionTitle,
    regionName: vacancy.regionName,
  };
}

/**
 * The neighbourhoods (sales bricks) of the seat's own area — "make it cascading based on the area
 * the job offer is sent to him". A district manager's seat sits on a district code that carries no
 * bricks, and a non-sales seat has no area at all; both get an empty list, and the page then asks
 * him to type the area instead.
 */
async function residenceAreaOptions(areaCode: string | null): Promise<string[]> {
  if (!areaCode) return [];
  const { data, error } = await getSupabaseAdmin()
    .from("source_of_sales_bricks")
    .select("brick_name")
    .eq("area_code", areaCode)
    .eq("active", true)
    .limit(500);
  if (error) return [];
  const names = new Set<string>();
  for (const row of (data ?? []) as Array<{ brick_name: string | null }>) {
    const name = String(row.brick_name ?? "").replace(/\s+/g, " ").trim();
    if (name) names.add(name);
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b, "ar"));
}

/** Every company address in use or already queued — a generated address must not be one of them. */
async function takenCompanyAddresses(): Promise<Set<string>> {
  const taken = new Set<string>();
  const rows = await getEmployeeDirectoryRows({ includeInactive: true });
  for (const row of rows) {
    const address = String(row.workEmail ?? "").trim().toLowerCase();
    if (address) taken.add(address);
  }
  const { data } = await getSupabaseAdmin()
    .from("new_hire_mailbox_tasks")
    .select("email_address,status")
    .not("email_address", "is", null)
    .limit(2000);
  for (const task of (data ?? []) as Array<{ email_address: string | null; status: string | null }>) {
    if (task.status !== "not_needed" && task.email_address) taken.add(task.email_address.trim().toLowerCase());
  }
  return taken;
}

type Loaded = {
  offer: OfferRecord;
  requiresSeat: boolean;
  seat: JoiningFormSeat | null;
  state: JoiningFormState;
  vacancy: OfferVacancyOption | null;
};

async function loadOffer(token: string): Promise<Loaded | null> {
  const offerId = readOfferAcceptToken(token);
  if (!offerId) return null;
  let offer: OfferRecord;
  try {
    offer = await getOffer(offerId);
  } catch (error) {
    if (isOfferNotFound(error)) return null;
    throw error;
  }
  const requiresSeat = offerRequiresSeat(offer.title);
  const vacancy = offer.employeeHrId ? null : await findOpenOfferVacancy(offer.vacancyId);
  const state = joiningFormState({
    employeeHrId: offer.employeeHrId ?? null,
    requiresSeat,
    seatOpen: Boolean(vacancy),
    status: offer.status,
  });
  const seat = state === "open" ? await loadSeat(vacancy) : null;
  return { offer, requiresSeat, seat, state, vacancy };
}

/**
 * The record's salary lines, from the offer's NET.
 *
 * 🔴 THE ALLOWANCES ARE PAYROLL'S OWN, NOT THE TITLE TABLE'S. Payroll pays the stored base plus the
 * cost of living and fuel IT resolves for the record's title, position, department and line
 * (`resolveStandardSalaryAllowances`, read by automated payroll). The Employee Master's title table
 * matches titles exactly and falls back to 1,500, so for a "District Manager", a "Product Manager -
 * CNS" or a "Training Specialist" it subtracted 1,500 too little and payroll would have paid up to
 * 1,500 EGP a month over the agreed net, with nobody looking (risk review, 2026-10-08). Handing
 * payroll's figures to `deriveSalaryFromNet` as the allowances makes base + payroll's allowances =
 * the offer's net exactly. Base and basic still come from policy.ts through that chain.
 */
function payFor(offer: OfferRecord, jobTitle: string, seat: JoiningFormSeat | null, hireDate: string) {
  const when = /^\d{4}-\d{2}-\d{2}$/.test(hireDate) ? hireDate : todayInCairo();
  const payroll = resolveStandardSalaryAllowances({
    departmentName: seat?.departmentName ?? null,
    jobTitle,
    lineName: seat?.lineName ?? null,
    month: Number(when.slice(5, 7)),
    positionTitle: seat?.positionTitle ?? null,
    year: Number(when.slice(0, 4)),
  });
  const derived = deriveSalaryFromNet({
    extraCostOfLiving: payroll.extraCostOfLiving,
    fuelAllowance: payroll.fuelAllowance,
    jobTitle,
    netSalary: offer.totalMonthly,
  });
  if (!derived) return null;
  return {
    baseSalary: derived.baseSalary,
    basicSalary: derived.basicSalary,
    extraCostOfLiving: derived.extraCostOfLiving,
    fuelAllowance: derived.fuelAllowance,
    grossSalary: derived.grossSalary,
    insuranceWage: derived.insuranceWage,
    netSalary: derived.netSalary,
    socialInsurance: derived.socialInsurance,
    taxes: derived.taxes,
  };
}

/** What the page renders for a token. Never throws for a bad link — that is the "invalid" view. */
export async function loadJoiningForm(token: string): Promise<JoiningFormView> {
  const loaded = await loadOffer(token);
  if (!loaded) return { kind: "invalid" };
  const { offer, seat, state, vacancy } = loaded;
  if (state !== "open") return { ...JOINING_FORM_STATE_MESSAGE[state], kind: "closed", state };

  const draft = buildOfferHireDraft({ offer, vacancy });
  // No readable start date → no record: an active hire with a blank hire date is paid a full,
  // unprorated month. HR confirms the date first (the submit alerts them).
  if (!draft.hireDate) return { ...JOINING_FORM_STATE_MESSAGE.start_date_pending, kind: "closed", state: "start_date_pending" };
  const pay = payFor(offer, draft.jobTitle, seat, draft.hireDate);

  let hrIdPreview: string | null = null;
  try {
    hrIdPreview = await generateNextHrIdForLine(seat?.lineId ?? null);
  } catch {
    hrIdPreview = null;
  }

  let satoEmail: string | null = null;
  let satoEmailReason: string | null = null;
  try {
    const proposal = joiningFormMailboxAddress(offer.candidateName, await takenCompanyAddresses());
    satoEmail = proposal.address;
    satoEmailReason = proposal.reason;
  } catch {
    // The page then reads plainly "HR will send it to you" — no reason worth showing him.
    satoEmailReason = null;
  }

  const areaOptions = await residenceAreaOptions(seat?.areaCode ?? null);
  const defaultCity = governorateValue(resolveGovernorate(seat?.areaName ?? null) ?? resolveGovernorate(offer.territory));
  const cityByArea: Record<string, string> = {};
  for (const name of areaOptions) {
    const value = governorateValue(resolveGovernorate(name));
    if (value) cityByArea[name] = value;
  }

  return {
    job: {
      areaName: seat?.areaName ?? null,
      contractType: contractTypeLabel(DEFAULT_CONTRACT_TYPE),
      departmentName: seat?.departmentName ?? null,
      hireDate: draft.hireDate,
      hrIdPreview,
      jobTitle: draft.jobTitle,
      lineName: seat?.lineName ?? null,
      managerHrId: seat?.managerHrId ?? null,
      managerName: seat?.managerName ?? null,
      regionName: seat?.regionName ?? null,
      satoEmail,
      satoEmailReason,
    },
    kind: "open",
    offer: {
      candidateEmail: offer.candidateEmail,
      candidateName: offer.candidateName,
      reference: offer.reference,
      salutationName: offer.salutationName || offer.candidateName,
    },
    pay: pay
      ? {
          baseSalary: pay.baseSalary,
          basicSalary: pay.basicSalary,
          extraCostOfLiving: pay.extraCostOfLiving,
          fuelAllowance: pay.fuelAllowance,
          grossSalary: pay.grossSalary,
          netSalary: pay.netSalary,
        }
      : null,
    residence: { areaOptions, cityByArea, defaultCity },
  };
}

export type JoiningFormSubmitResult =
  | { ok: true; hrId: string; offerId: string; satoEmail: string | null; satoEmailReason: string | null }
  | { errors: Partial<Record<JoiningFormField | JoiningFormUploadField, string>>; ok: false; status: 400 }
  | { message: string; ok: false; status: 404 | 409 | 500 };

/** Keyed, so the stored value cannot be reversed by hashing every IPv4 address. */
function ipHash(ip: string | null): string | null {
  const value = String(ip ?? "").trim();
  const secret = process.env.PHOENIX_AUTH_SECRET?.trim();
  if (!value || !secret) return null;
  return createHmac("sha256", secret).update(`offer-joining-form.ip.v1\n${value}`).digest("hex");
}

const HR_WILL_CONTACT = "Our HR team has been told and will contact you shortly. You can also reply to the offer email.";

type ExistingHire = { kind: "none" } | { kind: "found"; reason: string } | { kind: "unknown" };

/**
 * Is this person already on the Employee Master? (risk review, 2026-10-08)
 *
 * The same email tells him to press Accept while HR may already have hired him through Add
 * Employee from this offer — a door that never sets `offers.employee_hr_id` and does not require a
 * national ID. So the match is wider than the ID: the national ID or the mobile on a CURRENT record,
 * or a record made SINCE THE OFFER WENT OUT whose name is his. A read that fails is "unknown" and
 * blocks the submit — a duplicate employee is paid, a delayed one is not.
 *
 * A record whose employment has ended does not count (owner, 2026-11-01): someone who resigned and
 * returns on a new offer is a NEW employee with a new record, and the old one stays as it is.
 * employees has no unique index on either column, so one person can hold several records, which is
 * why the read below takes no limit: with limit(1) a leaver's row could hide a current employee's.
 */
export async function findExistingHire(
  offer: Pick<OfferRecord, "candidateName" | "sentAt">,
  answers: { fullName: string; mobileNumber: string; nationalId: string },
  db: ReturnType<typeof getSupabaseAdmin> = getSupabaseAdmin(),
): Promise<ExistingHire> {
  const identity = await db
    .from("employees")
    .select("hr_id,employment_status")
    // Both values are typed by the CANDIDATE into the joining form, so they are the widest untrusted
    // input any `.or(...)` in this repo receives: a comma or a parenthesis in either one used to end
    // its arm early, and the duplicate-hire check then asked PostgREST a question nobody wrote —
    // which, because a failed read is "unknown" and a false negative is "no duplicate", is the
    // direction that pays a man twice. Quoted, both match literally (AGENTS.md MR-B04).
    .or(
      [
        quotedOrClause("national_id", "eq", answers.nationalId),
        quotedOrClause("mobile_number", "eq", answers.mobileNumber),
      ].join(","),
    );
  if (identity.error) return { kind: "unknown" };
  const holders = (identity.data ?? []) as Array<{ employment_status: string | null }>;
  if (holders.some((row) => isActiveLifecycleStatus(row.employment_status))) {
    return { kind: "found", reason: "the national ID or mobile typed is on a current Employee Master record." };
  }
  const since = offer.sentAt ?? new Date(Date.now() - 120 * 86_400_000).toISOString();
  const recent = await db.from("employees").select("hr_id,full_name").gte("created_at", since).limit(500);
  if (recent.error) return { kind: "unknown" };
  for (const row of (recent.data ?? []) as Array<{ full_name: string | null }>) {
    if (sameJoinerName(row.full_name, offer.candidateName) || sameJoinerName(row.full_name, answers.fullName)) {
      return { kind: "found", reason: "a record with this candidate's name was created after the offer was sent." };
    }
  }
  return { kind: "none" };
}

/**
 * The record this submit's own write left behind, when a later step of that write threw. Asked by the
 * HR ID minted for it, never by the national ID alone: a returning leaver's old record holds the same
 * ID, and the offer would be stamped with it. The national ID stays in the filter so that an HR ID
 * taken by somebody else in the same moment is not mistaken for his.
 */
export async function findRecordJustWritten(
  hrId: string,
  nationalId: string,
  db: ReturnType<typeof getSupabaseAdmin> = getSupabaseAdmin(),
): Promise<string> {
  const written = await db.from("employees").select("hr_id").eq("hr_id", hrId).eq("national_id", nationalId).limit(1);
  return String((written.data?.[0] as { hr_id?: string } | undefined)?.hr_id ?? "").trim();
}

/** One uploaded national ID photo, as the route read it off the request. */
export type JoiningFormPhoto = { bytes: Buffer; contentType: string };

/**
 * File the two national ID photos into the new record's "National ID copy" slot on Hiring Documents
 * (owner, 2026-10-08), through the store's own attach — the same rows, bucket, size and type checks
 * and checklist tick as HR's own upload, with the joiner named as the uploader.
 *
 * The slot is the one `hiring_document_definitions.joining_form_upload = 'national_id'` marks — never
 * matched on its admin-editable name. Runs AFTER the record exists, so it never throws: a refusal is
 * reported to HR in the acceptance alert, and the acceptance stands.
 */
async function fileJoiningIdPhotos(hrId: string, photos: Record<JoiningFormPhotoField, JoiningFormPhoto>): Promise<boolean> {
  try {
    const slot = await getSupabaseAdmin()
      .from("hiring_document_definitions")
      .select("id")
      .eq("joining_form_upload", "national_id")
      .eq("is_active", true)
      .maybeSingle();
    if (slot.error) throw new Error(slot.error.message);
    const documentId = String((slot.data as { id?: string } | null)?.id ?? "").trim();
    if (!documentId) throw new Error("No active Hiring Documents slot is marked for the joining form's national ID photos.");
    const extension = (contentType: string) => (contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg");
    await attachHiringDocumentFiles(
      { ...systemAccessContext, loginId: "joining-form" },
      {
        documentId,
        employeeHrId: hrId,
        mode: "upload",
        pages: [
          { bytes: photos.idFront.bytes, contentType: photos.idFront.contentType, fileName: `national-id-front.${extension(photos.idFront.contentType)}` },
          { bytes: photos.idBack.bytes, contentType: photos.idBack.contentType, fileName: `national-id-back.${extension(photos.idBack.contentType)}` },
        ],
        uploadedByHrId: hrId,
      },
    );
    return true;
  } catch (error) {
    logError("The joining form created the record but could not file the national ID photos", {
      context: { hrId },
      error: error instanceof Error ? error : new Error(String(error)),
      labels: { event: "offer_joining_form_id_photos_failed" },
    });
    return false;
  }
}

/**
 * The optional photo (owner, 2026-10-08): it becomes the new record's Phoenix profile photo, AND is
 * filed on Hiring Documents into the slot `joining_form_upload = 'photo'` marks ("(6) personal
 * photos") WITHOUT ticking it — that slot is six prints for the paper file, and HR still collects
 * them (his ruling). The two halves are independent: either can land without the other. Runs AFTER
 * the record exists and never throws — a photo that does not land costs the acceptance nothing.
 */
async function fileJoiningFacePhoto(hrId: string, photo: JoiningFormPhoto): Promise<{ filed: boolean; profile: boolean }> {
  const outcome = { filed: false, profile: false };
  try {
    await uploadEmployeePhoto(hrId, photo.bytes, photo.contentType);
    outcome.profile = true;
  } catch (error) {
    logError("The joining form created the record but could not set the profile photo", {
      context: { hrId },
      error: error instanceof Error ? error : new Error(String(error)),
      labels: { event: "offer_joining_form_profile_photo_failed" },
    });
  }
  try {
    const slot = await getSupabaseAdmin()
      .from("hiring_document_definitions")
      .select("id")
      .eq("joining_form_upload", "photo")
      .eq("is_active", true)
      .maybeSingle();
    if (slot.error) throw new Error(slot.error.message);
    const documentId = String((slot.data as { id?: string } | null)?.id ?? "").trim();
    if (!documentId) throw new Error("No active Hiring Documents slot is marked for the joining form's photo.");
    const extension = photo.contentType === "image/png" ? "png" : photo.contentType === "image/webp" ? "webp" : "jpg";
    await attachHiringDocumentFiles(
      { ...systemAccessContext, loginId: "joining-form" },
      {
        documentId,
        employeeHrId: hrId,
        markSubmitted: false,
        mode: "upload",
        pages: [{ bytes: photo.bytes, contentType: photo.contentType, fileName: `photo.${extension}` }],
        uploadedByHrId: hrId,
      },
    );
    outcome.filed = true;
  } catch (error) {
    logError("The joining form created the record but could not file the photo on Hiring Documents", {
      context: { hrId },
      error: error instanceof Error ? error : new Error(String(error)),
      labels: { event: "offer_joining_form_photo_filing_failed" },
    });
  }
  return outcome;
}

/**
 * Submit — the acceptance. In order: the link, the offer's state, every answer, the seat still open,
 * the ID not already on file, the claim on the offer row, the record through HR's own chain, then the
 * offer stamped accepted and the audit row. Any failure before the record exists gives the claim
 * back, so he can simply try again.
 */
export async function submitJoiningForm(
  token: string,
  answers: Partial<Record<JoiningFormField, unknown>>,
  photos: Partial<Record<JoiningFormUploadField, JoiningFormPhoto | null>>,
  meta: { ip: string | null; userAgent: string | null },
): Promise<JoiningFormSubmitResult> {
  const loaded = await loadOffer(token);
  if (!loaded) return { message: "This link is not valid any more. Please reply to the offer email.", ok: false, status: 404 };
  const { offer, seat, state, vacancy } = loaded;
  if (state !== "open") {
    if (state === "seat_unavailable") {
      await announceJoiningFormBlocked(offer, "the seat on the offer is no longer open in the organogram.");
    }
    return { message: JOINING_FORM_STATE_MESSAGE[state].body, ok: false, status: 409 };
  }

  // The answers and the ID photos are judged together, so he sees every problem at once — and both
  // BEFORE the claim, so a missing photo never costs him a record.
  const areaOptions = await residenceAreaOptions(seat?.areaCode ?? null);
  const { errors, value } = validateJoiningForm(answers, { residenceAreaOptions: areaOptions, todayIso: todayInCairo() });
  const photoErrors: Partial<Record<JoiningFormUploadField, string>> = validateJoiningIdPhotos({
    idBack: photos.idBack ? { contentType: photos.idBack.contentType, size: photos.idBack.bytes.length } : null,
    idFront: photos.idFront ? { contentType: photos.idFront.contentType, size: photos.idFront.bytes.length } : null,
  });
  const facePhotoError = validateJoiningFacePhoto(
    photos.photo ? { contentType: photos.photo.contentType, size: photos.photo.bytes.length } : null,
  );
  if (facePhotoError) photoErrors.photo = facePhotoError;
  if (!value || Object.keys(photoErrors).length > 0) return { errors: { ...errors, ...photoErrors }, ok: false, status: 400 };
  const idPhotos = { idBack: photos.idBack as JoiningFormPhoto, idFront: photos.idFront as JoiningFormPhoto };
  const facePhoto = photos.photo && photos.photo.bytes.length > 0 ? photos.photo : null;

  const db = getSupabaseAdmin();
  const draft = buildOfferHireDraft({ offer, vacancy });
  if (!draft.hireDate) {
    await announceJoiningFormBlocked(offer, "the offer has no readable start date, so no record was made.");
    return { message: JOINING_FORM_STATE_MESSAGE.start_date_pending.body, ok: false, status: 409 };
  }

  const existing = await findExistingHire(offer, value);
  if (existing.kind === "unknown") {
    return { message: "We could not complete your joining form right now. Please try again in a few minutes.", ok: false, status: 500 };
  }
  if (existing.kind === "found") {
    await announceJoiningFormBlocked(offer, existing.reason);
    return { message: `You are already registered with us. ${HR_WILL_CONTACT}`, ok: false, status: 409 };
  }

  if (!(await claimOfferForJoiningForm(offer.id))) {
    return {
      message: "This form is already being submitted, or was submitted a moment ago. Please refresh the page.",
      ok: false,
      status: 409,
    };
  }

  const pay = payFor(offer, draft.jobTitle, seat, draft.hireDate);

  let satoEmail: string | null = null;
  let satoEmailReason: string | null = null;
  try {
    // His name as he typed it on the form — the legal spelling — not the letter's salutation.
    const proposal = joiningFormMailboxAddress(value.fullName, await takenCompanyAddresses());
    satoEmail = proposal.address;
    satoEmailReason = proposal.reason;
  } catch {
    satoEmailReason = null;
  }

  const employee: EmployeeMutationInput = {
    areaId: seat?.areaId ?? null,
    birthDate: value.birthDate,
    contractType: DEFAULT_CONTRACT_TYPE,
    departmentId: seat?.departmentId ?? null,
    education: value.education,
    fullName: value.fullName,
    gender: value.gender,
    hireDate: draft.hireDate,
    jobTitle: draft.jobTitle,
    lineId: seat?.lineId ?? null,
    managerHrId: seat?.managerHrId ?? null,
    mobileNumber: value.mobileNumber,
    nationalId: value.nationalId,
    personalEmail: value.personalEmail,
    positionId: seat?.positionId ?? null,
    regionName: seat?.regionName ?? null,
    residenceAddress: value.residenceAddress,
    residenceArea: value.residenceArea,
    residenceCity: value.residenceCity,
    salaryPaymentMode: joiningFormPaymentMode(draft.jobTitle),
    workEmail: satoEmail,
    ...(pay
      ? {
          baseSalary: pay.baseSalary,
          basicSalary: pay.basicSalary,
          extraCostOfLiving: pay.extraCostOfLiving,
          fuelAllowance: pay.fuelAllowance,
          grossSalary: pay.grossSalary,
          netSalary: pay.netSalary,
          socialInsurance: pay.socialInsurance,
          socialInsuranceWage: pay.insuranceWage,
          taxes: pay.taxes,
        }
      : {}),
  };

  let hrId = "";
  let mintedHrId = "";
  let hireError: Error | null = null;
  try {
    mintedHrId = await generateNextHrIdForLine(seat?.lineId ?? null);
    // "joining-form" as the login, so the salary audit trail names the door instead of reading
    // "unattributed" (an out-of-band write in that log's own vocabulary).
    const rows = await upsertEmployee({ ...employee, hrId: mintedHrId }, { actorHrId: null, actorLoginId: "joining-form" });
    hrId = String(rows[0]?.hr_id ?? "").trim();
    if (!hrId) throw new Error("The employee record was written but returned no HR ID.");
  } catch (error) {
    hireError = error instanceof Error ? error : new Error(String(error));
    // upsertEmployee writes the row FIRST, then the residence, the vacancy and ownership. A throw in
    // those later steps leaves a real record — carry on with it rather than tell HR it does not exist.
    const found = mintedHrId ? await findRecordJustWritten(mintedHrId, value.nationalId, db) : "";
    if (found) {
      hrId = found;
      logError("The joining form's record was written but a later step failed — continuing with it", {
        context: { hrId },
        error: hireError,
        labels: { event: "offer_joining_form_hire_partial" },
      });
    }
  }
  if (!hrId) {
    const error = hireError ?? new Error("The employee record could not be created.");
    await releaseOfferJoiningClaim(offer.id);
    logError("The joining form could not create the employee record", {
      error,
      labels: { event: "offer_joining_form_hire_failed" },
    });
    await announceJoiningFormBlocked(offer, `the employee record could not be created (${error.message}).`.slice(0, 300));
    return { message: `We could not complete your joining form right now. ${HR_WILL_CONTACT}`, ok: false, status: 500 };
  }

  // From here the record EXISTS. Nothing below may give the claim back or report a failure to him:
  // file the ID photos (so the acceptance alert can say whether they landed), stamp the offer, so a
  // refresh shows "already completed", then the follow-ups — each swallows its own failures exactly
  // as it does on HR's own Add Employee. Until the stamp, the claim turns a second Submit away.
  const idPhotosFiled = await fileJoiningIdPhotos(hrId, idPhotos);
  const facePhotoOutcome = facePhoto ? await fileJoiningFacePhoto(hrId, facePhoto) : null;
  try {
    await stampOfferAcceptedByJoiningForm(offer.id, {
      hrId,
      idPhotosFiled,
      seated: Boolean(seat?.lineId || seat?.departmentId),
      workEmail: satoEmail,
    });
  } catch (error) {
    logError("The joining form created an employee but could not stamp the offer", {
      error: error instanceof Error ? error : new Error(String(error)),
      labels: { event: "offer_joining_form_stamp_failed" },
    });
  }

  try {
    await db.from("offer_acceptances").insert({
      employee_hr_id: hrId,
      ip_hash: ipHash(meta.ip),
      offer_id: offer.id,
      payload: {
        ...value,
        idPhotosFiled,
        photo: facePhotoOutcome,
        satoEmail,
        satoEmailReason,
        userAgent: String(meta.userAgent ?? "").slice(0, 300),
      },
    });
  } catch (error) {
    logError("The joining form could not write its audit row", {
      error: error instanceof Error ? error : new Error(String(error)),
      labels: { event: "offer_joining_form_audit_failed" },
    });
  }

  // HR's Add Employee chain, after the record — same order as app/api/employees/route.ts. The
  // portal login goes through the create-only, rank-bounded HR Operations door: it can only ever
  // create a NEW default-rank login for the hr id just written, never change an existing account.
  try {
    await provisionNewHireAccess({
      actor: { loginId: "joining-form", role: "HR Operations" },
      hrIds: [hrId],
      source: "offer joining form",
    });
  } catch (error) {
    logError("The joining form could not provision the new hire's login", {
      error: error instanceof Error ? error : new Error(String(error)),
      labels: { event: "offer_joining_form_access_failed" },
    });
  }
  await openAndAnnounceCrmAccountSetup({ actorId: "joining-form", hrIds: [hrId], source: "manual_add" });
  await openAndAnnounceNewHireMailboxes({ actorId: "joining-form", hrIds: [hrId], source: "manual_add" });

  logInfo("Offer accepted through the joining form", {
    context: { hrId, offerId: offer.id },
    labels: { event: "offer_joining_form_submitted" },
  });

  return { hrId, offerId: offer.id, ok: true, satoEmail, satoEmailReason: satoEmail ? null : satoEmailReason };
}
