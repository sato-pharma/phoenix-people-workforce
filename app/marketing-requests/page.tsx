import Link from "next/link";

import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { cairoDateTime } from "@/lib/marketing-requests/request-report-columns";
import {
  getApproverPendingRequests,
  type MarketingApproverInboxRow,
  type MarketingApproverUpcomingRow,
} from "@/lib/marketing-requests/service";

export const dynamic = "force-dynamic";

/**
 * The marketing work queue — what YOU have to do, at the canonical route.
 *
 * ── WHY THIS ROUTE EXISTS ────────────────────────────────────────────────────
 * `/marketing-requests` had no page at all. Only `/marketing-requests/[requestId]` existed, so the
 * parent of every notification deep link, every "Open the full record" link and every hand-typed
 * URL resolved to nothing. Work lived on the approver inbox inside one shell, which a viewer had to
 * already know to look for.
 *
 * ── WHAT MAKES IT ROLE-AWARE ─────────────────────────────────────────────────
 * Nothing here filters by role, and that is deliberate. `getApproverPendingRequests` is scoped to
 * the ACTOR: it returns the rungs assigned to them, the CC rungs they may comment on, and the
 * requests heading toward them. A Medical Rep and a Finance Manager get different queues from the
 * same code because the data is theirs, not because a component decided what they may see. Adding a
 * role switch here would be a second, weaker gate that could drift from the real one.
 *
 * ── THE ONE RULE ─────────────────────────────────────────────────────────────
 * A failed read must NEVER render as an empty queue. "You have nothing to do" and "we could not
 * find out what you have to do" are opposite answers, and showing the first when the second is true
 * is how somebody misses an approval. Same contract the Case File is built on.
 */

function egp(value: number) {
  return `EGP ${Math.round(Number.isFinite(value) ? value : 0).toLocaleString("en-US")}`;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      <div className="border border-slate-200 bg-white">
        <div className="bg-slate-950 px-6 py-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-orange-400">
            Marketing requests
          </p>
          <h1 className="mt-1 text-xl font-semibold text-white">Your work queue</h1>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </main>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-5 text-[11px] font-semibold uppercase tracking-wider text-slate-400 first:mt-0">
      {children}
    </p>
  );
}

/**
 * One request, as a card at every width.
 *
 * Cards rather than a table on purpose: the owner's rule is that mobile never gets a table, and a
 * queue is read on a phone more often than anywhere else. Nothing is truncated and nothing is
 * abbreviated with an ellipsis — a request code the reader cannot finish reading is not a link they
 * can trust.
 */
function RequestCard({
  emphasis,
  row,
  trailer,
}: {
  emphasis: boolean;
  row: MarketingApproverInboxRow;
  trailer?: React.ReactNode;
}) {
  return (
    <li
      className={`border px-3 py-2.5 ${
        emphasis ? "border-orange-300 bg-orange-50/40" : "border-slate-200 bg-white"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Link
            className="font-mono text-[13px] font-semibold text-slate-950 underline underline-offset-2 hover:text-orange-700"
            href={`/marketing-requests/${row.id}`}
          >
            {row.requestCode}
          </Link>
          <p className="mt-0.5 text-[11px] text-slate-500">
            {row.customerName} · raised by {row.requesterName}
          </p>
        </div>
        <span className="shrink-0 text-[13px] font-medium text-slate-950">{egp(row.estimatedCost)}</span>
      </div>
      <p className="mt-1.5 text-[11px] font-medium text-slate-600">
        {row.requestType} · {row.currentStepName}
        {/* Cairo, never raw UTC — the owner's standing rule. */}
        {row.submittedAt ? ` · submitted ${cairoDateTime(row.submittedAt) ?? ""}` : ""}
      </p>
      {trailer}
    </li>
  );
}

/** Nothing waiting — stated positively, and never used to describe a read that failed. */
function NothingHere({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-[12px] font-medium text-slate-400">{children}</p>;
}

function Upcoming({ row }: { row: MarketingApproverUpcomingRow }) {
  return (
    <RequestCard
      emphasis={false}
      row={row}
      trailer={
        <p className="mt-1 text-[11px] leading-5 text-slate-500">
          Yours is step {row.myStepSequence} of {row.totalGatingSteps}. Currently with{" "}
          {row.awaitingStepName ?? "no open step"}
          {row.awaitingApproverName ? ` — ${row.awaitingApproverName}` : ""} ·{" "}
          {/* The number that makes a stall visible. */}
          {row.ageDays} day{row.ageDays === 1 ? "" : "s"} since it was submitted
        </p>
      }
    />
  );
}

export default async function MarketingRequestsWorkQueuePage() {
  const access = await resolveAccessContextFromPage();

  if (access.source === "guest" || (!access.loginId && !access.hrId)) {
    return (
      <Shell>
        <p className="text-[13px] font-medium text-slate-600">
          Please log in to Phoenix to see your marketing work queue.
        </p>
        <Link
          className="mt-4 inline-flex border border-slate-300 px-4 py-2 text-[13px] font-semibold text-slate-700"
          href="/login"
        >
          Log in to Phoenix
        </Link>
      </Shell>
    );
  }

  let workspace: Awaited<ReturnType<typeof getApproverPendingRequests>>;
  try {
    workspace = await getApproverPendingRequests(access);
  } catch {
    // The whole point of the contract: this is NOT an empty queue.
    return (
      <Shell>
        <p className="border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-medium leading-5 text-rose-800">
          <span className="font-semibold">Your queue could not be read. </span>
          This is not the same as having nothing to do — do not treat it as an empty list. Please try
          again, and tell IT if it keeps failing.
        </p>
      </Shell>
    );
  }

  const { advisoryRows, rows, upcomingRows } = workspace;
  const nothingAtAll =
    rows.length === 0 && advisoryRows.length === 0 && upcomingRows.length === 0;

  return (
    <Shell>
      <p className="text-[12px] font-medium text-slate-600">
        {rows.length > 0
          ? `${rows.length} request${rows.length === 1 ? "" : "s"} need${rows.length === 1 ? "s" : ""} your decision`
          : "Nothing is waiting on your decision"}
      </p>

      <SectionLabel>Needs my action</SectionLabel>
      {rows.length === 0 ? (
        <NothingHere>No request is waiting on a decision from you.</NothingHere>
      ) : (
        <ol className="mt-2 space-y-1.5">
          {rows.map((row) => (
            <RequestCard emphasis key={row.id} row={row} />
          ))}
        </ol>
      )}

      <SectionLabel>Waiting for my comment</SectionLabel>
      {advisoryRows.length === 0 ? (
        <NothingHere>No request is open for your comment.</NothingHere>
      ) : (
        <ol className="mt-2 space-y-1.5">
          {advisoryRows.map((row) => (
            <RequestCard emphasis={false} key={row.id} row={row} />
          ))}
        </ol>
      )}

      {/* Owner instruction, 2026-08-04: an approver must see what is COMING, not only what has
          already reached them. The CEO sits at the last rung — without this they are on the hook
          for a request stalled three steps upstream that their inbox never mentions. */}
      <SectionLabel>Coming to you</SectionLabel>
      {upcomingRows.length === 0 ? (
        <NothingHere>Nothing is on its way to you.</NothingHere>
      ) : (
        <ol className="mt-2 space-y-1.5">
          {upcomingRows.map((row) => (
            <Upcoming key={row.id} row={row} />
          ))}
        </ol>
      )}

      {nothingAtAll ? (
        <p className="mt-5 border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] font-medium leading-5 text-slate-600">
          Your queue is empty. This is a read that succeeded and found nothing — if a request should
          be here, it is assigned to somebody else rather than missing.
        </p>
      ) : null}
    </Shell>
  );
}
