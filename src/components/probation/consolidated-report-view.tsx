import type { ConsolidatedReport } from "@/lib/probation/intelligence/consolidated-report";
import { humanizeCode } from "@/lib/format/code-label";
import { ProbationSalesEvidencePanel } from "@/components/probation/probation-sales-evidence-panel";

// Presentational (server) view of the live consolidated probation report. No interactivity —
// it renders whatever the report data service composed. Human names, not codes.

const ROLE_LABEL: Record<string, string> = {
  dm: "District Manager",
  tm: "Training Manager",
  pm_gpm: "PM / GPM",
  nsm: "National Sales Manager",
  sfe: "SFE",
  hr: "HR",
};

const READINESS_LABEL: Record<string, string> = {
  not_decision_ready: "Not decision-ready",
  lean_continue: "Leaning: Continue",
  review_recommended: "Review recommended",
  lean_do_not_continue: "Leaning: Do not continue",
};

function Badge({ tone, children }: { tone: "green" | "amber" | "red" | "grey"; children: React.ReactNode }) {
  const cls = {
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    red: "bg-rose-50 text-rose-700 border-rose-200",
    grey: "bg-slate-100 text-slate-600 border-slate-200",
  }[tone];
  return <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
      {children}
    </section>
  );
}

function readinessTone(r: string): "green" | "amber" | "red" | "grey" {
  if (r === "lean_continue") return "green";
  if (r === "review_recommended") return "amber";
  if (r === "lean_do_not_continue") return "red";
  return "grey";
}

export function ConsolidatedReportView({ report }: { report: ConsolidatedReport }) {
  const c = report.case;
  const score = report.score;

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">{c.employeeName ?? c.employeeHrId}</h1>
            <p className="text-sm text-slate-500">
              {c.jobTitle ?? "—"} · {c.lineName ?? "—"} · {c.areaName ?? "—"}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Hired {c.hireDate ?? "—"} · Probation ends {c.probationEndDate ?? "—"} · Day{" "}
              {c.currentProbationDay != null ? Math.min(c.currentProbationDay, 90) : "—"} of 90
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <Badge tone={readinessTone(report.provisionalReadiness)}>{READINESS_LABEL[report.provisionalReadiness]}</Badge>
            <span className="text-xs text-slate-500">
              {score.decisionReady ? "Final score" : "Provisional score"}:{" "}
              <strong className="text-slate-800">{score.finalScore ?? score.provisionalScore ?? "—"}</strong> / 10
            </span>
          </div>
        </div>
        {report.dataFreshness.stale && (
          <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-700">
            ⚠ Data may be stale — last CRM sync {report.dataFreshness.lastCrmSyncAt ?? "never"}.
          </p>
        )}
      </div>

      {/* Milestones */}
      <Section title="Milestones">
        <div className="flex flex-wrap gap-3">
          {report.milestones.map((m) => (
            <div key={m.day} className="flex items-center gap-2 rounded border border-slate-200 px-3 py-2">
              <Badge tone={m.reached ? "green" : "grey"}>{m.reached ? "Reached" : "Upcoming"}</Badge>
              <span className="text-sm text-slate-700">{m.label}</span>
              <span className="text-xs text-slate-400">{m.date ?? ""}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* DV-Day progress */}
      <Section title={`Double-Visit progress — ${report.dvProgress.totalFeedbackCompleted}/${report.dvProgress.totalRequired} feedback complete`}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {Object.values(report.dvProgress.byRole).map((rp) => (
            <div key={rp.role} className="rounded border border-slate-200 p-2">
              <div className="text-xs font-medium text-slate-500">{ROLE_LABEL[rp.role]}</div>
              <div className="text-sm text-slate-800">
                {rp.feedbackCompleted}/{rp.required}{" "}
                <Badge tone={rp.complete ? "green" : rp.validated > 0 ? "amber" : "grey"}>
                  {rp.complete ? "Complete" : rp.validated > 0 ? "In progress" : "Pending"}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* Score breakdown */}
      <Section title="Weighted score breakdown">
        <div>
          <table className="w-full table-fixed text-sm">
            <colgroup>
              <col className="w-[24%]" />
              <col className="w-[16%]" />
              <col className="w-[16%]" />
              <col className="w-[24%]" />
              <col className="w-[20%]" />
            </colgroup>
            <thead>
              <tr className="text-left text-xs uppercase text-slate-400">
                <th className="py-1 pr-3">Component</th>
                <th className="py-1 pr-3">Score</th>
                <th className="py-1 pr-3">Weight</th>
                <th className="py-1 pr-3">Contribution</th>
                <th className="py-1">Status</th>
              </tr>
            </thead>
            <tbody>
              {Object.values(score.components).map((comp) => (
                <tr key={comp.key} className="border-t border-slate-100">
                  <td className="py-1 pr-3 text-slate-700">{ROLE_LABEL[comp.key]}</td>
                  <td className="py-1 pr-3 text-slate-800">{comp.score ?? "—"}</td>
                  <td className="py-1 pr-3 text-slate-500">{comp.weight}</td>
                  <td className="py-1 pr-3 text-slate-800">{comp.weightedContribution ?? "—"}</td>
                  <td className="py-1">
                    <Badge tone={comp.complete ? "green" : comp.present ? "amber" : "grey"}>
                      {comp.complete ? "Complete" : comp.present ? "Partial" : "Missing"}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {score.completeness.missingComponents.length > 0 && (
          <p className="mt-2 text-xs text-slate-500">
            Missing before decision-ready: {score.completeness.missingComponents.map((k) => ROLE_LABEL[k]).join(", ")}.
          </p>
        )}
      </Section>

      {/* Contradictions */}
      {report.contradictions.length > 0 && (
        <Section title="⚠ Conflicting evaluations detected">
          <ul className="flex flex-col gap-2">
            {report.contradictions.map((ct, i) => (
              <li key={i} className="rounded border border-slate-200 p-2">
                <div className="flex items-center gap-2">
                  <Badge tone={ct.severity === "high" ? "red" : ct.severity === "warning" ? "amber" : "grey"}>{ct.severity}</Badge>
                  <span className="text-sm font-medium text-slate-800">{ct.title}</span>
                </div>
                <p className="mt-1 text-xs text-slate-600">{ct.detail}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* SLA breaches */}
      {report.slaBreaches.length > 0 && (
        <Section title="Feedback SLA breaches">
          <ul className="flex flex-col gap-1 text-sm">
            {report.slaBreaches.map((b) => (
              <li key={b.dvDayId} className="flex items-center gap-2">
                <Badge tone={b.state === "overdue" ? "red" : "amber"}>{humanizeCode(b.state)}</Badge>
                <span className="text-slate-700">DV day {b.dvDate}</span>
                {b.hoursOverdue > 0 && <span className="text-xs text-slate-400">{b.hoursOverdue}h overdue</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* DV-Day history */}
      <Section title="Double-Visit history">
        <div className="flex flex-col gap-2">
          {report.dvDays.length === 0 && <p className="text-sm text-slate-500">No double-visit days captured yet.</p>}
          {report.dvDays.map((d) => (
            <div key={d.id} className="rounded border border-slate-200 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm text-slate-800">
                  <strong>{d.dvDate}</strong> · {d.evaluatorRole ? ROLE_LABEL[d.evaluatorRole] : "—"} ·{" "}
                  {d.evaluatorName ?? "—"} · {d.visitCount} visit{d.visitCount === 1 ? "" : "s"}
                </div>
                <div className="flex items-center gap-2">
                  {d.feedback ? (
                    <Badge tone="green">Feedback {d.feedback.score ?? "—"}/10 · {d.feedback.recommendation ?? "—"} (v{d.feedback.version})</Badge>
                  ) : d.sla ? (
                    <Badge tone={d.sla.state === "overdue" ? "red" : d.sla.state === "pending" ? "grey" : "amber"}>Feedback {humanizeCode(d.sla.state).toLowerCase()}</Badge>
                  ) : (
                    <Badge tone="grey">{humanizeCode(d.dvStatus)}</Badge>
                  )}
                </div>
              </div>
              {d.visits.length > 0 && (
                <ul className="mt-2 flex flex-col gap-0.5 text-xs text-slate-500">
                  {d.visits.slice(0, 12).map((v, i) => (
                    <li key={i}>· {v.contactName ?? "—"} {v.ampm ? `(${v.ampm})` : ""}{v.comment ? ` — ${v.comment}` : ""}</li>
                  ))}
                  {d.visits.length > 12 && <li>· … {d.visits.length - 12} more</li>}
                </ul>
              )}
            </div>
          ))}
        </div>
      </Section>

      {report.salesEvidence ? <ProbationSalesEvidencePanel evidence={report.salesEvidence} /> : null}

      {/* Assessments */}
      <Section title="SFE & HR assessments">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded border border-slate-200 p-3">
            <div className="mb-1 text-xs font-medium uppercase text-slate-500">SFE (data-driven)</div>
            {report.sfeEvidence ? (
              <ul className="flex flex-col gap-0.5 text-xs text-slate-600">
                {report.sfeEvidence.metrics.filter((m) => m.available).map((m) => (
                  <li key={m.key}>{m.label}: <strong>{m.value}</strong> {m.unit}</li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-slate-400">No SFE evidence.</p>
            )}
            <div className="mt-2 text-sm">Score: <strong>{report.assessments.sfe?.score ?? "—"}</strong> / 10</div>
          </div>
          <div className="rounded border border-slate-200 p-3">
            <div className="mb-1 text-xs font-medium uppercase text-slate-500">HR</div>
            {"status" in (report.assessments.hr ?? {}) && report.assessments.hr && !("score" in report.assessments.hr) ? (
              <Badge tone="grey">{(report.assessments.hr as { status: string }).status}</Badge>
            ) : (
              <div className="text-sm">Score: <strong>{(report.assessments.hr as { score?: number | null })?.score ?? "—"}</strong> / 10</div>
            )}
          </div>
        </div>
      </Section>

      {/* Development actions */}
      {report.developmentActions.length > 0 && (
        <Section title="Development actions">
          <ul className="flex flex-col gap-2">
            {report.developmentActions.map((a) => (
              <li key={a.id} className="rounded border border-slate-200 p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-slate-800">{a.title}</span>
                  <Badge tone={a.status === "done" ? "green" : a.status === "cancelled" ? "grey" : a.status === "in_progress" ? "amber" : "grey"}>
                    {humanizeCode(a.status)}
                  </Badge>
                </div>
                {a.description && <p className="mt-0.5 text-xs text-slate-600">{a.description}</p>}
                <p className="mt-1 text-phx-xs text-slate-400">
                  {a.scoreCategory ? `${a.scoreCategory} · ` : ""}{a.ownerHrId ? `owner ${a.ownerName ?? a.ownerHrId} · ` : ""}{a.dueDate ? `due ${a.dueDate}` : "no due date"}
                  {a.followUpOutcome ? ` · outcome: ${a.followUpOutcome}` : ""}
                </p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Timeline */}
      <Section title="Audit timeline">
        <ol className="flex flex-col gap-1 text-xs text-slate-600">
          {report.auditTimeline.map((e, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-slate-400">{e.at.slice(0, 16).replace("T", " ")}</span>
              <span className="text-slate-700">{e.detail}</span>
              {e.actor && <span className="text-slate-400">· {e.actor}</span>}
            </li>
          ))}
        </ol>
        <p className="mt-2 text-phx-xs text-slate-400">
          Generated {report.generatedAt.slice(0, 16).replace("T", " ")} · Last CRM sync {report.dataFreshness.lastCrmSyncAt?.slice(0, 16).replace("T", " ") ?? "never"}
        </p>
      </Section>
    </div>
  );
}
