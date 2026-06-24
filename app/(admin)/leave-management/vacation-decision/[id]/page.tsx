import { redirect } from "next/navigation";

import { isForbiddenError, resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  decideVacationRequest,
  getVacationDecisionConfirmationData,
  parseVacationDecision,
  vacationErrorMessage,
} from "@/lib/vacation/service";

export const dynamic = "force-dynamic";

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

async function recordVacationDecision(formData: FormData) {
  "use server";

  const access = await resolveAccessContextFromPage();
  const requestId = String(formData.get("requestId") ?? "");
  const decision = parseVacationDecision(formData.get("decision"));
  if (!requestId || !decision) {
    redirect(`/leave-management/vacation-report?decisionError=${encodeURIComponent("Vacation decision is invalid.")}`);
  }

  await decideVacationRequest(access, {
    decision,
    decisionComment: String(formData.get("decisionComment") ?? ""),
    requestId,
  });

  redirect(`/leave-management/vacation-report?requestId=${encodeURIComponent(requestId)}&decisionRecorded=${decision}`);
}

export default async function VacationDecisionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  const { id } = await params;
  const decision = parseVacationDecision(firstParam((await searchParams).decision)) ?? "approve";

  let data: Awaited<ReturnType<typeof getVacationDecisionConfirmationData>> | null = null;
  let error: string | null = null;
  try {
    data = await getVacationDecisionConfirmationData(access, id);
  } catch (err) {
    error = isForbiddenError(err) ? "You are not authorized to decide this vacation request." : vacationErrorMessage(err);
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-orange-600">Vacation Approval</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-950">Confirm vacation decision</h1>
      </header>

      {error || !data ? (
        <section className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800">
          {error ?? "Unable to load this vacation decision."}
        </section>
      ) : (
        <section className="rounded-md border border-slate-200 bg-white p-5 shadow-sm">
          <dl className="grid gap-3 text-sm text-slate-700 sm:grid-cols-2">
            <div>
              <dt className="font-semibold text-slate-950">Employee</dt>
              <dd>{data.request.employeeName} ({data.request.employeeHrId})</dd>
            </div>
            <div>
              <dt className="font-semibold text-slate-950">Approval step</dt>
              <dd>{data.approvalStep.replace(/_/g, " ")}</dd>
            </div>
            <div>
              <dt className="font-semibold text-slate-950">Period</dt>
              <dd>{data.request.startDate} - {data.request.endDate}</dd>
            </div>
            <div>
              <dt className="font-semibold text-slate-950">Type</dt>
              <dd>{data.request.vacationType}</dd>
            </div>
          </dl>

          <form action={recordVacationDecision} className="mt-6 flex flex-col gap-4">
            <input name="requestId" type="hidden" value={data.request.id} />
            <input name="decision" type="hidden" value={decision} />
            <label className="flex flex-col gap-2 text-sm font-medium text-slate-700">
              Decision comment
              <textarea
                className="min-h-24 rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-950 outline-none focus:border-orange-500"
                name="decisionComment"
                placeholder={decision === "reject" ? "Rejection reason is recommended." : "Optional approval note."}
              />
            </label>
            <div className="flex flex-wrap gap-3">
              <button
                className={decision === "reject"
                  ? "rounded-md bg-rose-700 px-4 py-2 text-sm font-semibold text-white"
                  : "rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white"}
                type="submit"
              >
                {decision === "reject" ? "Reject in Phoenix" : "Approve in Phoenix"}
              </button>
              <a
                className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700"
                href={`/leave-management/vacation-report?requestId=${encodeURIComponent(data.request.id)}`}
              >
                View request
              </a>
            </div>
          </form>
        </section>
      )}
    </main>
  );
}
