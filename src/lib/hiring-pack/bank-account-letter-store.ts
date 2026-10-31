import { readFileSync } from "node:fs";
import path from "node:path";

import { ACTIVE_EMPLOYMENT_STATUSES_IN_LIST } from "@/lib/auth/session-lifecycle";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import type { BankLetterEmployee } from "./bank-account-letter.ts";
import type { BankLetterImages } from "./bank-account-letter-docx.ts";
import { sortForBankLetter } from "./bank-account-letter.ts";

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
  const { data, error } = await supabase
    .from("employees")
    .select(EMPLOYEE_COLUMNS)
    .or(`employment_status.is.null,employment_status.in.${ACTIVE_EMPLOYMENT_STATUSES_IN_LIST}`)
    .limit(2000)
    .returns<EmployeeRow[]>();
  if (error) throw new Error(error.message);
  const rows: EmployeeRow[] = data ?? [];

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

  return sortForBankLetter(
    rows.map((row) => ({
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
