import { NextResponse } from "next/server";

import { coachingMaxItemScore, coachingParameterLabels, type CoachingParameterKey } from "@/lib/coaching/constants";
import { submitCoachingReport } from "@/lib/coaching/service";
import { createSystemNotification } from "@/lib/notifications/system";
import {
  jsonError,
  readJsonObject,
  requireCoachingManagementPermission,
  submitInput,
} from "@/app/api/coaching/_lib/route-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

type CoachingScoreItemForEmail = {
  parameter_category: CoachingParameterKey | string | null;
  score: number | null;
  score_item_key: string;
  score_item_label: string;
};

function escapeEmailHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function coachingCategoryLabel(value: CoachingScoreItemForEmail["parameter_category"]) {
  if (!value) return "";
  const known = coachingParameterLabels[value as CoachingParameterKey];
  if (known) return known;
  return String(value)
    .replace(/_/g, " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function scoreToneColor(score: number | null) {
  if (score === null) return "#64748B";
  if (score >= 4) return "#166534";
  if (score >= 3) return "#92400E";
  return "#B91C1C";
}

function buildCoachingScoreEmailContext(scores: CoachingScoreItemForEmail[]) {
  const rows = scores.map((item, index) => {
    const metric = escapeEmailHtml(item.score_item_label || item.score_item_key || `Metric ${index + 1}`);
    const category = escapeEmailHtml(coachingCategoryLabel(item.parameter_category));
    const numericScore = Number(item.score);
    const score = Number.isFinite(numericScore) ? numericScore : null;
    const scoreText = score === null ? "N/A" : `${score} / ${coachingMaxItemScore}`;
    const metricHtml = category
      ? `<strong style="color:#0F172A;font-size:13px;line-height:1.45">${metric}</strong><br /><span style="color:#64748B;font-size:11px;line-height:1.4">${category}</span>`
      : `<strong style="color:#0F172A;font-size:13px;line-height:1.45">${metric}</strong>`;
    const metricText = category ? `${metric} (${category})` : metric;
    return { metricHtml, metricText, score, scoreText };
  });

  if (rows.length === 0) {
    return {
      scoreTable: '<p style="border:1px solid #E2E8F0;padding:12px;color:#64748B;font-size:13px;line-height:1.5">No coaching metric scores were provided.</p>',
      scoreTableText: "No coaching metric scores were provided.",
    };
  }

  const metricCell = "border:1px solid #E2E8F0;padding:10px 12px;font-size:13px;line-height:1.45;text-align:left;color:#0F172A";
  const scoreCell = "border:1px solid #E2E8F0;padding:10px 12px;font-size:13px;line-height:1.45;text-align:right;color:#0F172A";
  const head = "background-color:#0F172A;color:#FFFFFF;border:1px solid #0F172A;padding:10px 12px;font-size:12px;line-height:1.4;text-align:left;font-weight:700";
  return {
    scoreTable: [
      '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;border:1px solid #E2E8F0">',
      `<thead><tr><th style="${head}">Metric</th><th style="${head};text-align:right">Score</th></tr></thead>`,
      `<tbody>${rows.map((row, index) => {
        const background = index % 2 === 0 ? "#FFFFFF" : "#F8FAFC";
        const color = scoreToneColor(row.score);
        return `<tr style="background-color:${background}"><td style="${metricCell}">${row.metricHtml}</td><td style="${scoreCell}"><strong style="color:${color};font-size:13px">${row.scoreText}</strong></td></tr>`;
      }).join("")}</tbody>`,
      "</table>",
    ].join(""),
    scoreTableText: rows.map((row) => `${row.metricText}: ${row.scoreText}`).join("\n"),
  };
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const access = await requireCoachingManagementPermission(request, "update");
    const { id } = await context.params;
    const payload = await readJsonObject(request, { allowEmpty: true });
    const report = await submitCoachingReport(id, submitInput(payload), access);
    const coachName = report.summary?.coachName || report.report.coach_hr_id;
    const scoreContext = buildCoachingScoreEmailContext(report.scores);
    const notification = await createSystemNotification({
      actionUrl: `/employee-portals/coaching/${report.report.id}`,
      category: "coaching_report",
      eventType: "report_submitted",
      message: `You have received a new coaching report from ${coachName}. Please review and acknowledge it.`,
      email: {
        templateContext: scoreContext,
      },
      metadata: {
        coachHrId: report.report.coach_hr_id,
        coachName,
        idempotencyKey: `coaching_report_submitted:${report.report.id}:${report.report.medical_rep_hr_id}`,
        reportId: report.report.id,
        reportNumber: report.report.report_number,
      },
      module: "coaching",
      priority: "normal",
      recipientHrId: report.report.medical_rep_hr_id,
      title: "New Coaching Report",
    });

    return NextResponse.json({
      data: report,
      message: "Coaching report submitted.",
      notification,
      success: true,
    });
  } catch (error) {
    return jsonError(error, "Failed to submit coaching report.");
  }
}
