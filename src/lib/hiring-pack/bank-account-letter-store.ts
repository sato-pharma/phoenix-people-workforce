import { readFileSync } from "node:fs";
import path from "node:path";

import { ACTIVE_EMPLOYMENT_STATUSES_IN_LIST } from "@/lib/auth/session-lifecycle";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { downloadHiringDocumentFile } from "@/lib/hiring-documents/file-storage";
import { logError } from "@/lib/observability/log";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import type { BankLetterEmployee } from "./bank-account-letter.ts";
import type { BankLetterImages } from "./bank-account-letter-docx.ts";
import { sortForBankLetter } from "./bank-account-letter.ts";
import {
  pickIdSides,
  pictureSize,
  type BankLetterIdPage,
  type IdCardStatus,
  type IdPicture,
  type StoredIdFile,
} from "./bank-letter-id-pages.ts";

// The people the bank account-opening letter can list: the active staff, read from the employee
// record and the Arabic job title on the hiring profile — the same two places HR Forms prints from.

type EmployeeRow = {
  hr_id: string;
  full_name: string | null;
  nickname: string | null;
  name_ar: string | null;
  national_id: string | null;
  mobile_number: string | null;
  residence_address: string | null;
  job_title: string | null;
  base_salary: number | string | null;
  bank_name: string | null;
  hire_date: string | null;
};

type ProfileRow = { hr_id: string; job_title_ar: string | null };

const EMPLOYEE_COLUMNS =
  "hr_id,full_name,nickname,name_ar,national_id,mobile_number,residence_address,job_title,base_salary,bank_name,hire_date";

/** PostgREST puts the id list in the URL, so the profile read goes in slices. */
const PROFILE_CHUNK = 200;

function toNumber(value: number | string | null): number | null {
  if (value === null || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

export async function listBankLetterEmployees(): Promise<BankLetterEmployee[]> {
  const supabase = getSupabaseAdmin();
  // Every active person, paged (hr_id is the tiebreak). A fixed row count here would leave the
  // overflow off the bank's account-opening letter without a word.
  let rows: EmployeeRow[];
  try {
    rows = await fetchAllRows<EmployeeRow>(
      () =>
        supabase
          .from("employees")
          .select(EMPLOYEE_COLUMNS)
          .or(`employment_status.is.null,employment_status.in.${ACTIVE_EMPLOYMENT_STATUSES_IN_LIST}`),
      "hr_id",
    );
  } catch (error) {
    throw new Error((error as { message?: string } | null)?.message ?? String(error));
  }

  const titles = new Map<string, string | null>();
  const hrIds = rows.map((row) => row.hr_id);
  for (let start = 0; start < hrIds.length; start += PROFILE_CHUNK) {
    const { data: profiles, error: profileError } = await supabase
      .from("employee_hiring_profile")
      .select("hr_id,job_title_ar")
      .in("hr_id", hrIds.slice(start, start + PROFILE_CHUNK))
      .returns<ProfileRow[]>();
    if (profileError) throw new Error(profileError.message);
    for (const profile of profiles ?? []) titles.set(profile.hr_id, profile.job_title_ar);
  }

  const idCards = await loadIdCardStatuses();

  return sortForBankLetter(
    rows.map((row) => ({
      idCard: idCards ? (idCards.get(row.hr_id.toLowerCase()) ?? "missing") : null,
      address: row.residence_address,
      bankName: row.bank_name,
      baseSalary: toNumber(row.base_salary),
      displayName: resolveEmployeeDisplayName(row.full_name ?? row.hr_id, row.nickname, row.hr_id),
      hireDate: row.hire_date,
      hrId: row.hr_id,
      jobTitleAr: titles.get(row.hr_id) ?? null,
      jobTitleEn: row.job_title,
      mobile: row.mobile_number,
      nameAr: row.name_ar,
      nationalId: row.national_id,
    })),
  );
}

/** The two house pictures the letterhead carries, read from the app's own `public/brand`. */
export function loadBankLetterImages(): BankLetterImages {
  const brand = path.join(process.cwd(), "public", "brand");
  return {
    bandPng: readFileSync(path.join(brand, "sato-house-band.png")),
    logoPng: readFileSync(path.join(brand, "sato-pharma-logo-on-light.png")),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE NATIONAL ID PAGES (owner, 2026-11-27: one A4 page per chosen person, the card's front on top
// and its back below — `bank-letter-id-pages.ts`). The pictures are the ones filed on Hiring
// Documents in the slot `joining_form_upload = 'national_id'` marks, found by that flag and never by
// its admin-editable name, the way the joining form files them.
// ─────────────────────────────────────────────────────────────────────────────────────────────

type IdFileRow = {
  employee_hr_id: string;
  storage_path: string;
  file_name: string;
  content_type: string;
  uploaded_at: string;
};

type IdFile = StoredIdFile & { storagePath: string };

const ID_FILE_COLUMNS = "employee_hr_id,storage_path,file_name,content_type,uploaded_at";

/** The id of the "National ID copy" slot, or null when no active slot carries the flag. */
async function nationalIdSlotId(): Promise<string | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("hiring_document_definitions")
    .select("id")
    .eq("joining_form_upload", "national_id")
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const id = String((data as { id?: string } | null)?.id ?? "").trim();
  return id || null;
}

function groupIdFiles(rows: readonly IdFileRow[]): Map<string, IdFile[]> {
  const byPerson = new Map<string, IdFile[]>();
  for (const row of rows) {
    // HR ids are mixed case on some tables; the key is the lowercase form on both sides.
    const key = row.employee_hr_id.toLowerCase();
    const file: IdFile = {
      contentType: row.content_type,
      fileName: row.file_name,
      storagePath: row.storage_path,
      uploadedAt: row.uploaded_at,
    };
    byPerson.set(key, [...(byPerson.get(key) ?? []), file]);
  }
  return byPerson;
}

/** Every slot file, read once — the slot holds a few files per person, never a company's worth of pages. */
async function loadAllIdFiles(): Promise<Map<string, IdFile[]>> {
  const slotId = await nationalIdSlotId();
  if (!slotId) return new Map();
  const rows = await fetchAllRows<IdFileRow>(
    () => getSupabaseAdmin().from("hiring_document_files").select(ID_FILE_COLUMNS).eq("document_id", slotId),
    "storage_path",
  );
  return groupIdFiles(rows);
}

/**
 * Each person's ID status, keyed by lowercase HR id; a person with no row is `missing`. Null when the
 * files cannot be read — the screen then shows nothing rather than calling everyone "missing".
 */
async function loadIdCardStatuses(): Promise<Map<string, IdCardStatus> | null> {
  try {
    const files = await loadAllIdFiles();
    return new Map([...files].map(([hrId, list]) => [hrId, pickIdSides(list).status]));
  } catch (error) {
    logError("The bank account letter could not read the national ID files", {
      error: error instanceof Error ? error : new Error(String(error)),
      labels: { event: "bank_letter_id_status_failed" },
    });
    return null;
  }
}

type SharpFactory = typeof import("sharp").default;
let cachedSharp: SharpFactory | null = null;

/** sharp loads on demand, never at module load — the reason is written on `document-scan.ts`. */
async function loadSharp(): Promise<SharpFactory> {
  if (!cachedSharp) cachedSharp = (await import("sharp")).default;
  return cachedSharp;
}

/** The long edge a side is printed from: ~240 dpi across the 170 mm box, a few hundred KB a side. */
const ID_PICTURE_MAX_EDGE_PX = 1600;

/**
 * One stored picture, made ready for the page: turned upright (phones record the turn in EXIF rather
 * than in the pixels), capped at 1,600 px and written as JPEG. If the image library cannot load, a
 * JPEG or PNG goes in as it is, at its own proportion; anything else is left out.
 */
async function preparePicture(bytes: Buffer): Promise<IdPicture | null> {
  try {
    const sharp = await loadSharp();
    const { data, info } = await sharp(bytes)
      .rotate()
      .resize({ fit: "inside", height: ID_PICTURE_MAX_EDGE_PX, width: ID_PICTURE_MAX_EDGE_PX, withoutEnlargement: true })
      .jpeg({ mozjpeg: true, quality: 85 })
      .toBuffer({ resolveWithObject: true });
    return { bytes: new Uint8Array(data), contentType: "image/jpeg", heightPx: info.height, widthPx: info.width };
  } catch {
    const size = pictureSize(bytes);
    return size ? { bytes: new Uint8Array(bytes), ...size } : null;
  }
}

async function loadSide(file: IdFile | null): Promise<IdPicture | null> {
  if (!file) return null;
  try {
    return await preparePicture(await downloadHiringDocumentFile(file.storagePath));
  } catch (error) {
    logError("A national ID picture for the bank account letter could not be read", {
      context: { storagePath: file.storagePath },
      error: error instanceof Error ? error : new Error(String(error)),
      labels: { event: "bank_letter_id_picture_failed" },
    });
    return null;
  }
}

/** How many people's pictures are fetched at once. */
const ID_DOWNLOAD_CONCURRENCY = 4;

/**
 * One ID page per chosen person, in the letter's order. A side that is not on file, or cannot be
 * read, is null — the page prints an empty box for it, never skips the person.
 */
export async function loadBankLetterIdPages(chosen: readonly BankLetterEmployee[]): Promise<BankLetterIdPage[]> {
  const files = await loadAllIdFiles();
  const pages: BankLetterIdPage[] = new Array(chosen.length);
  let next = 0;
  async function worker() {
    while (next < chosen.length) {
      const index = next++;
      const employee = chosen[index];
      const sides = pickIdSides(files.get(employee.hrId.toLowerCase()) ?? []);
      const [front, back] = await Promise.all([loadSide(sides.front), loadSide(sides.back)]);
      pages[index] = {
        back,
        front,
        name: (employee.nameAr ?? "").trim() || employee.displayName,
        nationalId: employee.nationalId,
        status: sides.status,
      };
    }
  }
  await Promise.all(Array.from({ length: Math.min(ID_DOWNLOAD_CONCURRENCY, chosen.length) }, worker));
  return pages;
}
