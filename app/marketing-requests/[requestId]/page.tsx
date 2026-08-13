import Link from "next/link";
import { redirect } from "next/navigation";

import { MarketingRequestCaseFileView } from "@/components/marketing-requests/marketing-request-case-file";
import { isForbiddenError, resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { getMarketingRequestCaseFile } from "@/lib/marketing-requests/case-file-service";
import { resolveMarketingRequestDestination } from "@/lib/marketing-requests/notification-link";
import { parseMarketingRequestDecision } from "@/lib/marketing-requests/service";

export const dynamic = "force-dynamic";

/**
 * The marketing request Case File — the one place a request can be read whole.
 *
 * ── WHAT THIS ROUTE USED TO BE ───────────────────────────────────────────────
 * A `redirect()` and nothing else. It owned no UI, so a notification — whose stored `actionUrl` is
 * `/marketing-requests/<id>` and has been for every marketing notification ever sent — landed the
 * recipient on the inbox LIST, carrying `?request=<id>` that no page has ever read. "Marketing
 * request needs your approval" meant "go and find it yourself".
 *
 * Rendering the request here fixes that for every historical link at once, with no data migration
 * and no re-send: the stored URLs were always right, there was simply nothing at the end of them.
 *
 * ── WHAT IS DELIBERATELY UNCHANGED ───────────────────────────────────────────
 * `?decision=` still redirects to the shell-correct decision page. Those are the Telegram/email
 * one-tap buttons: the button already expresses the intent, so sending the approver to a reading
 * screen first would add a step to the one flow that currently works well. Parsed with the same
 * `parseMarketingRequestDecision` the decision page itself uses, so the two cannot drift.
 */

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

export default async function MarketingRequestCaseFilePage({
  params,
  searchParams,
}: {
  params: Promise<{ requestId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ requestId }, query] = await Promise.all([params, searchParams]);
  const access = await resolveAccessContextFromPage();

  // One-tap decision links keep their existing behaviour, unchanged. Resolved BEFORE any read so
  // the redirect is never wrapped in the try/catch below (redirect() signals by throwing).
  const decision = parseMarketingRequestDecision(
    Array.isArray(query?.decision) ? query.decision[0] : query?.decision,
  );
  if (decision) {
    redirect(
      resolveMarketingRequestDestination({
        decision,
        navigationMode: resolveNavigationMode(access),
        requestId,
      }),
    );
  }

  if (access.source === "guest" || (!access.loginId && !access.hrId)) {
    return (
      <SafeState
        actionHref="/login"
        actionLabel="Log in to Phoenix"
        message="Please log in to Phoenix to open this marketing request."
        title="Login Required"
      />
    );
  }

  let caseFile: Awaited<ReturnType<typeof getMarketingRequestCaseFile>>;
  try {
    caseFile = await getMarketingRequestCaseFile(requestId, access);
  } catch (error) {
    // Deliberately one message for "not yours" and "does not exist": telling them apart would let
    // any signed-in user probe which request ids are real.
    if (isForbiddenError(error)) {
      return (
        <SafeState
          message="You do not have access to this marketing request, or it does not exist."
          title="Not Available"
        />
      );
    }
    return (
      <SafeState
        message="This marketing request could not be loaded. Please try again, and tell IT if it keeps failing."
        title="Could Not Load Request"
      />
    );
  }

  return <MarketingRequestCaseFileView caseFile={caseFile} />;
}
