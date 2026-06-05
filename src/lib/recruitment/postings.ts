// Recruitment / ATS — Phase 4 public job postings + application intake.
//
// HR creates a posting for a requisition (a public token + /apply/<token> link).
// Candidates apply with no login; submitPublicApplication runs under a SYSTEM
// context, dedupes the candidate, creates the application, and IP-rate-limits.
// Only non-sensitive info is exposed publicly (job title) — never the org chart
// or other candidates.

import crypto from "node:crypto";

import { systemAccessContext, type AccessContext } from "@/lib/auth/permissions";
import { createApplication } from "@/lib/recruitment/applications";
import { numberOrNull, recruitmentDb, textOrNull } from "@/lib/recruitment/db";
import { getRequisition } from "@/lib/recruitment/requisitions";
import type { CreateCandidateInput } from "@/lib/recruitment/types";

const openRequisitionStatuses = ["req_open", "req_published"];
const rateLimitWindowMs = 10 * 60 * 1000;
const rateLimitMax = 5;

export type JobPostingLink = { token: string; path: string };

export async function createJobPosting(access: AccessContext, requisitionId: string): Promise<JobPostingLink> {
  const requisition = await getRequisition(access, requisitionId); // scope + existence
  if (!requisition) throw new Error("Requisition not found.");

  const supabase = recruitmentDb();
  const { data: existing, error: existingError } = await supabase
    .from("recruitment_job_postings")
    .select("public_token")
    .eq("requisition_id", requisitionId)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing?.public_token) {
    return { token: String(existing.public_token), path: `/apply/${existing.public_token}` };
  }

  const token = crypto.randomBytes(18).toString("base64url");
  const { data, error } = await supabase
    .from("recruitment_job_postings")
    .insert({
      requisition_id: requisitionId,
      public_token: token,
      title: requisition.jobTitle,
      status: "open",
      created_by: access.hrId ?? access.loginId ?? null,
    })
    .select("public_token")
    .single();

  if (error) {
    if ((error as { code?: string }).code === "23505") {
      const { data: row } = await supabase
        .from("recruitment_job_postings")
        .select("public_token")
        .eq("requisition_id", requisitionId)
        .maybeSingle();
      if (row?.public_token) return { token: String(row.public_token), path: `/apply/${row.public_token}` };
    }
    throw error;
  }

  return { token: String(data.public_token), path: `/apply/${data.public_token}` };
}

export type PublicPosting = { token: string; title: string };

// Public, non-sensitive view. Null unless the posting AND requisition are open.
export async function getPublicPosting(token: string): Promise<PublicPosting | null> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("recruitment_job_postings")
    .select("public_token,status,requisition_id,title")
    .eq("public_token", token)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.status !== "open") return null;

  const requisition = await getRequisition(systemAccessContext, String(data.requisition_id));
  if (!requisition || !openRequisitionStatuses.includes(requisition.status)) return null;

  return { token: String(data.public_token), title: requisition.jobTitle || String(data.title ?? "Open role") };
}

export type PublicApplicationInput = {
  fullName: string;
  email?: unknown;
  phone?: unknown;
  governorate?: unknown;
  currentEmployer?: unknown;
  yearsExperience?: unknown;
  expectedSalary?: unknown;
  noticePeriod?: unknown;
  cvExternalUrl?: unknown;
  source?: unknown;
};

export async function submitPublicApplication(
  token: string,
  input: PublicApplicationInput,
  ipHash: string | null,
): Promise<{ ok: true }> {
  const supabase = recruitmentDb();
  const { data: posting, error } = await supabase
    .from("recruitment_job_postings")
    .select("requisition_id,status")
    .eq("public_token", token)
    .maybeSingle();
  if (error) throw error;
  if (!posting || posting.status !== "open") {
    throw new Error("This job posting is no longer accepting applications.");
  }

  const requisitionId = String(posting.requisition_id);
  const requisition = await getRequisition(systemAccessContext, requisitionId);
  if (!requisition || !openRequisitionStatuses.includes(requisition.status)) {
    throw new Error("This job posting is no longer accepting applications.");
  }

  if (!String(input.fullName ?? "").trim()) throw new Error("Full name is required.");
  if (!textOrNull(input.email) && !textOrNull(input.phone)) {
    throw new Error("An email or mobile number is required.");
  }

  if (ipHash) {
    const since = new Date(Date.now() - rateLimitWindowMs).toISOString();
    const { count, error: countError } = await supabase
      .from("recruitment_applications")
      .select("id", { count: "exact", head: true })
      .eq("submitted_ip_hash", ipHash)
      .gte("created_at", since);
    if (countError) throw countError;
    if ((count ?? 0) >= rateLimitMax) {
      throw new Error("Too many applications submitted recently. Please try again later.");
    }
  }

  const source = textOrNull(input.source) ?? "public";
  const candidate: CreateCandidateInput = {
    fullName: String(input.fullName).trim(),
    email: textOrNull(input.email),
    phone: textOrNull(input.phone),
    governorate: textOrNull(input.governorate),
    currentEmployer: textOrNull(input.currentEmployer),
    yearsExperience: numberOrNull(input.yearsExperience),
    expectedSalary: numberOrNull(input.expectedSalary),
    noticePeriod: textOrNull(input.noticePeriod),
    cvExternalUrl: textOrNull(input.cvExternalUrl),
    source,
  };

  const application = await createApplication({ requisitionId, candidate, source }, systemAccessContext);

  if (ipHash) {
    await supabase
      .from("recruitment_applications")
      .update({ submitted_ip_hash: ipHash })
      .eq("id", application.id);
  }

  return { ok: true };
}
