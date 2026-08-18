import Link from "next/link";
import { redirect } from "next/navigation";

import { MarketingRequestDecisionConfirmation } from "@/components/employee-portal/marketing-request-decision-confirmation";
import { writeAuditLog } from "@/lib/admin/audit";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  getMarketingRequestDecisionSummary,
  parseMarketingRequestDecision,
} from "@/lib/marketing-requests/service";

export const dynamic = "force-dynamic";

function loginRequired(access: Awaited<ReturnType<typeof resolveAccessContextFromPage>>) {
  return access.source === "guest" || (!access.loginId && !access.hrId);
}

function SafeState({
  actionHref = "/employee-portals/marketing-requests",
  actionLabel = "Open marketing requests",
  message,
  title,
}: {
  actionHref?: string;
  actionLabel?: string;
  message: string;
  title: string;
}) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-4 py-10">
      <section className="border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-600">Phoenix Workforce</p>
        <h1 className="mt-2 text-2xl font-black text-slate-950">{title}</h1>
        <p className="mt-3 text-sm font-semibold leading-6 text-slate-600">{message}</p>
        <Link className="mt-5 inline-flex border border-slate-300 px-4 py-2 text-sm font-black text-slate-700" href={actionHref}>
          {actionLabel}
        </Link>
      </section>
    </main>
  );
}

async function auditDecisionPage(input: {
  access: Awaited<ReturnType<typeof resolveAccessContextFromPage>>;
  decision: string | null;
  requestId: string;
  summary: string;
}) {
  await writeAuditLog({
    actorLoginId: input.access.loginId ?? input.access.hrId ?? "anonymous",
    entityId: input.requestId,
    entityType: "marketing_request",
    newValues: {
      decision: input.decision,
      source: "telegram_or_email_decision_link",
    },
    summary: input.summary,
  });
}

export default async function MarketingRequestDecisionPage({
  params,
  searchParams,
}: {
  params: Promise<{ requestId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { requestId } = await params;
  const query = await searchParams;
  const rawDecision = Array.isArray(query.decision) ? query.decision[0] : query.decision;
  const decision = parseMarketingRequestDecision(rawDecision);
  const access = await resolveAccessContextFromPage();

  // A link with NO `?decision=` at all is not a tampered decision — it is somebody opening the
  // request to READ it. Every "Request Preview" link the live sheet handed out before 2026-08-18
  // has this shape, and every one of them dead-ended here on "Invalid Decision Link". Send them to
  // the Case File, which is where they were trying to go. A decision that is PRESENT but not one of
  // the three real ones still gets the safe state below — that one is a tampered value.
  if (rawDecision === undefined) {
    redirect(`/marketing-requests/${encodeURIComponent(requestId)}`);
  }

  if (!decision) {
    await auditDecisionPage({
      access,
      decision: rawDecision ?? null,
      requestId,
      summary: "Marketing request decision page blocked: invalid decision.",
    });
    return (
      <SafeState
        message="This marketing request decision link is invalid. Open Phoenix to review the request."
        title="Invalid Decision Link"
      />
    );
  }

  if (loginRequired(access)) {
    await auditDecisionPage({
      access,
      decision,
      requestId,
      summary: "Marketing request decision page opened without an active Phoenix session.",
    });
    return (
      <SafeState
        actionHref="/login"
        actionLabel="Log in to Phoenix"
        message="Please log in to Phoenix first. Telegram and email cannot approve or reject a request directly."
        title="Login Required"
      />
    );
  }

  let safeState: {
    message: string;
    title: string;
  } | null = null;
  let summary: Awaited<ReturnType<typeof getMarketingRequestDecisionSummary>> | null = null;

  try {
    summary = await getMarketingRequestDecisionSummary(requestId, decision, access);
    await auditDecisionPage({
      access,
      decision,
      requestId,
      summary: "Marketing request decision confirmation page opened.",
    });
  } catch {
    await auditDecisionPage({
      access,
      decision,
      requestId,
      summary: "Marketing request decision page blocked: unauthorized or unavailable.",
    });
    safeState = {
      message: "You are not authorized to decide this marketing request, or the request is no longer pending your decision.",
      title: "Decision Not Available",
    };
  }

  if (safeState) return <SafeState message={safeState.message} title={safeState.title} />;
  return <MarketingRequestDecisionConfirmation summary={summary as Awaited<ReturnType<typeof getMarketingRequestDecisionSummary>>} />;
}
