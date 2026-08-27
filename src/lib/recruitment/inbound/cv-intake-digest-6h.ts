// Recruitment / ATS — 6-hourly email digest of CVs received by each hiring manager.
//
// Every 6 hours, each manager who had candidates pushed to them gets an email listing how many
// CVs they received and from whom. Silent when nobody received anything (no "0 CVs" noise).
// The owner's CC rule:
//
//   • District Manager recipients → CC their manager
//   • Regional Manager recipients → CC their manager
//   • National Sales Manager recipients → do NOT CC their manager
//   • In ALL cases → CC omar.anwar@satopharma.com
//
// "Received a CV" means the candidate was pushed to that manager via pushCandidateToManager —
// stamped on ats_candidates.manager_notified_hr_id / manager_notified_at. The sender grouping
// comes from the intake event that created the candidate (ats_cv_intake_events.candidate_id).
//
// The pure half (buildCvDigestForManager, cvDigestEmailBody) takes rows and returns text, so the
// wording and the counting are unit-testable without a database or a clock.

import type { PhoenixRole } from "@/lib/auth/permissions";
import { recruitmentDb } from "@/lib/recruitment/db";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  renderGeneralNotificationEmailHtml,
  renderGeneralNotificationEmailText,
} from "@/emails/general-notification";
import { sendPhoenixEmail } from "@/lib/email/send-phoenix-email";
import { logError, logInfo } from "@/lib/observability/log";

const LOOKBACK_HOURS = 6;
const ALWAYS_CC = "omar.anwar@satopharma.com";
const CANDIDATES_PATH = "/employee-portals/recruitment-candidates";

// Same env-var convention src/lib/notifications/email.ts and closing-publish-notification.ts use —
// an email CTA must be an absolute URL, so a bare path is only a last-resort fallback.
function appUrl(path: string): string {
  const base = (process.env.NOTIFICATION_DASHBOARD_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/+$/, "");
  if (!base) return path;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

const ROLES_THAT_CC_MANAGER: readonly PhoenixRole[] = [
  "District Manager",
  "Regional Manager",
];

export type CvDigestCandidateRow = {
  candidateId: string;
  candidateName: string;
  senderDisplayName: string | null;
  senderIdentifier: string | null;
  sourceChannelCode: string | null;
  channel: string | null;
};

export type CvDigestGroup = { count: number; label: string };

export type CvDigestForManager = {
  bySender: CvDigestGroup[];
  total: number;
  windowLabel: string;
};

function senderLabel(row: CvDigestCandidateRow): string {
  const display = String(row.senderDisplayName ?? "").trim();
  if (display) return display;
  const identifier = String(row.senderIdentifier ?? "").trim();
  if (identifier) return identifier;
  const code = String(row.sourceChannelCode ?? "").trim();
  if (code) return code;
  return "Unknown sender";
}

function groupByLabel(values: string[], fallback: string): CvDigestGroup[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    const label = value.trim() || fallback;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Array.from(counts, ([label, count]) => ({ count, label })).sort(
    (left, right) => right.count - left.count || left.label.localeCompare(right.label),
  );
}

export function buildCvDigestForManager(rows: readonly CvDigestCandidateRow[]): CvDigestForManager {
  return {
    bySender: groupByLabel(
      rows.map((row) => senderLabel(row)),
      "Unknown sender",
    ),
    total: rows.length,
    windowLabel: "6 hours",
  };
}

export function cvDigestTitle(digest: CvDigestForManager): string {
  return digest.total === 1
    ? "You received 1 CV in the past 6 hours"
    : `You received ${digest.total} CVs in the past 6 hours`;
}

export function cvDigestEmailBody(digest: CvDigestForManager): string {
  if (digest.total === 0) return "";

  const lines: string[] = [];
  lines.push(`During the past ${digest.windowLabel}, you received ${digest.total === 1 ? "1 CV" : `${digest.total} CVs`}.`);

  lines.push("");
  lines.push("From:");
  for (const group of digest.bySender) lines.push(`  • ${group.label} — ${group.count}`);

  return lines.join("\n");
}

type CandidatePushedDbRow = {
  id?: string | null;
  full_name?: string | null;
  manager_notified_hr_id?: string | null;
  source?: string | null;
};

type IntakeEventForCandidate = {
  candidate_id?: string | null;
  channel?: string | null;
  sender_display_name?: string | null;
  sender_identifier?: string | null;
  source_channel_code?: string | null;
};

type ManagerCvBatch = {
  managerHrId: string;
  candidates: CvDigestCandidateRow[];
};

export async function loadRecentPushedCandidates(now: Date = new Date()): Promise<ManagerCvBatch[]> {
  const since = new Date(now.getTime() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
  const supabase = recruitmentDb();

  const { data: candidates, error: candError } = await supabase
    .from("ats_candidates")
    .select("id,full_name,manager_notified_hr_id,source")
    .gte("manager_notified_at", since)
    .not("manager_notified_hr_id", "is", null);
  if (candError) throw candError;

  const rows = (candidates ?? []) as CandidatePushedDbRow[];
  if (rows.length === 0) return [];

  const candidateIds = rows.map((r) => String(r.id)).filter(Boolean);

  const intakeByCandidate = new Map<string, IntakeEventForCandidate>();
  if (candidateIds.length > 0) {
    const chunks: string[][] = [];
    for (let i = 0; i < candidateIds.length; i += 50) {
      chunks.push(candidateIds.slice(i, i + 50));
    }
    for (const chunk of chunks) {
      const { data: events } = await supabase
        .from("ats_cv_intake_events")
        .select("candidate_id,channel,sender_display_name,sender_identifier,source_channel_code")
        .in("candidate_id", chunk);
      for (const ev of ((events ?? []) as IntakeEventForCandidate[])) {
        if (ev.candidate_id) intakeByCandidate.set(String(ev.candidate_id), ev);
      }
    }
  }

  const byManager = new Map<string, CvDigestCandidateRow[]>();
  for (const row of rows) {
    const managerId = String(row.manager_notified_hr_id ?? "").trim().toUpperCase();
    if (!managerId) continue;

    const intake = intakeByCandidate.get(String(row.id));
    const candidate: CvDigestCandidateRow = {
      candidateId: String(row.id),
      candidateName: String(row.full_name ?? "").trim() || "Unnamed candidate",
      channel: intake?.channel ?? row.source ?? null,
      senderDisplayName: intake?.sender_display_name ?? null,
      senderIdentifier: intake?.sender_identifier ?? null,
      sourceChannelCode: intake?.source_channel_code ?? null,
    };

    const list = byManager.get(managerId);
    if (list) list.push(candidate);
    else byManager.set(managerId, [candidate]);
  }

  return Array.from(byManager, ([managerHrId, cands]) => ({
    managerHrId,
    candidates: cands,
  }));
}

type ManagerProfile = {
  email: string;
  hrId: string;
  name: string;
  role: PhoenixRole;
  managerHrId: string | null;
};

async function resolveManagerProfile(hrId: string): Promise<ManagerProfile | null> {
  const supabase = getSupabaseAdmin();

  const { data: emp } = await supabase
    .from("employees")
    .select("hr_id,full_name,work_email,manager_hr_id")
    .eq("hr_id", hrId)
    .maybeSingle();
  if (!emp) return null;

  const empRow = emp as { hr_id?: string; full_name?: string; work_email?: string; manager_hr_id?: string | null };
  const email = String(empRow.work_email ?? "").trim().toLowerCase();
  if (!email) return null;

  const { data: auth } = await supabase
    .from("app_auth_users")
    .select("role")
    .eq("hr_id", hrId)
    .maybeSingle();
  const role = (auth as { role?: string } | null)?.role as PhoenixRole | undefined;

  return {
    email,
    hrId: String(empRow.hr_id),
    name: String(empRow.full_name ?? "").trim() || hrId,
    managerHrId: empRow.manager_hr_id ? String(empRow.manager_hr_id).trim().toUpperCase() : null,
    role: role ?? "District Manager",
  };
}

async function resolveManagerEmail(managerHrId: string): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employees")
    .select("work_email")
    .eq("hr_id", managerHrId)
    .maybeSingle();
  if (error || !data) return null;
  const email = String((data as { work_email: unknown }).work_email ?? "").trim().toLowerCase();
  return email || null;
}

function shouldCcManager(role: PhoenixRole): boolean {
  return (ROLES_THAT_CC_MANAGER as readonly string[]).includes(role);
}

export function buildCcList(
  recipientRole: PhoenixRole,
  managerEmail: string | null,
): string[] {
  const cc: string[] = [ALWAYS_CC];
  if (shouldCcManager(recipientRole) && managerEmail) {
    cc.push(managerEmail);
  }
  return Array.from(new Set(cc));
}

export async function sendCvIntakeDigest6h(now: Date = new Date()): Promise<{
  total: number;
  recipientCount: number;
}> {
  const batches = await loadRecentPushedCandidates(now);
  if (batches.length === 0) return { total: 0, recipientCount: 0 };

  const totalCvs = batches.reduce((sum, b) => sum + b.candidates.length, 0);
  const windowKey = `${Math.floor(now.getTime() / (LOOKBACK_HOURS * 3600 * 1000))}`;
  let sent = 0;

  for (const batch of batches) {
    try {
      const profile = await resolveManagerProfile(batch.managerHrId);
      if (!profile) continue;

      const digest = buildCvDigestForManager(batch.candidates);
      const title = cvDigestTitle(digest);
      const body = cvDigestEmailBody(digest);

      let managerEmail: string | null = null;
      if (shouldCcManager(profile.role) && profile.managerHrId) {
        managerEmail = await resolveManagerEmail(profile.managerHrId);
      }
      const cc = buildCcList(profile.role, managerEmail);

      const html = renderGeneralNotificationEmailHtml({
        subject: title,
        title,
        summary: body,
        bodyText: body,
        greeting: `Hi ${profile.name},`,
        action: { label: "Review Candidates", href: appUrl(CANDIDATES_PATH) },
      });
      const text = renderGeneralNotificationEmailText({
        subject: title,
        title,
        summary: body,
        bodyText: body,
        greeting: `Hi ${profile.name},`,
        action: { label: "Review Candidates", href: appUrl(CANDIDATES_PATH) },
      });

      const idempotencyKey = `cv-intake-digest-6h:${profile.hrId}:${windowKey}`;

      await sendPhoenixEmail({
        cc,
        externalRecipients: cc.filter((addr) => addr !== profile.email),
        html,
        idempotencyKey,
        origin: {
          eventType: "recruitment_cv_intake_digest_6h",
          module: "recruitment",
          recipientHrId: profile.hrId,
        },
        subject: title,
        text,
        to: [profile.email],
      });
      sent++;
    } catch (error) {
      logError("CV intake 6h digest: failed to send to manager", {
        error,
        labels: {
          event: "cv_intake_digest_6h_send_failed",
          managerHrId: batch.managerHrId,
        },
      });
    }
  }

  logInfo("CV intake 6h digest sent", {
    labels: {
      event: "cv_intake_digest_6h_sent",
      recipientCount: sent,
      total: totalCvs,
    },
  });

  return { total: totalCvs, recipientCount: sent };
}
