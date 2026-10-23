import { redirect } from "next/navigation";

import { isForbiddenError, resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  decideVacationRequest,
  getVacationDecisionConfirmationData,
  parseVacationDecision,
} from "@/lib/vacation/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import {
  vacationDecisionErrorToShow,
  vacationDecisionFailureMessage,
  vacationDecisionFormProblem,
  vacationDecisionRetryPath,
} from "@/lib/vacation/decision-form";
import { phxTextareaClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

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
  const decisionComment = String(formData.get("decisionComment") ?? "");

  // 🔴 A refusal comes back to this form with its sentence — never the outage screen (audit P7-05).
  // `redirect()` works by throwing, so it is called OUTSIDE the try, never inside it.
  let failure = vacationDecisionFormProblem(decision, decisionComment);
  if (!failure) {
    try {
      await decideVacationRequest(access, { decision, decisionComment, requestId });
    } catch (error) {
      failure = vacationDecisionFailureMessage(error);
    }
  }
  if (failure) redirect(vacationDecisionRetryPath(requestId, decision, failure));

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
  const query = await searchParams;
  const decision = parseVacationDecision(firstParam(query.decision)) ?? "approve";
  // What the last submit was refused for. It arrives in the address, so it is shown only when the
  // server's own signature verifies; a crafted link gets the fixed sentence, never its own words.
  const decisionError = vacationDecisionErrorToShow(
    id,
    decision,
    firstParam(query.decisionError),
    firstParam(query.decisionErrorSig),
  );
  const reasonRequired = decision === "reject";

  let data: Awaited<ReturnType<typeof getVacationDecisionConfirmationData>> | null = null;
  let error: string | null = null;
  try {
    data = await getVacationDecisionConfirmationData(access, id);
  } catch (err) {
    error = isForbiddenError(err)
      ? "You are not authorized to decide this vacation request."
      : clientSafeErrorMessage(err, "Unable to load this vacation decision.");
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
            {decisionError ? (
              <p className="border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-800" role="alert">
                {decisionError}
              </p>
            ) : null}
            <label className="flex flex-col gap-2 text-sm font-medium text-slate-700">
              {reasonRequired ? "Rejection reason (required)" : "Decision comment"}
              {/* The service refuses a rejection with no reason, so the form says so first. */}
              <textarea
                className={cn(phxTextareaClassName, "min-h-24")}
                name="decisionComment"
                placeholder={reasonRequired ? "Why is this request rejected?" : "Optional approval note."}
                required={reasonRequired}
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
