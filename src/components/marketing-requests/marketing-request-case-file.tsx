import type {
  CaseFileBlock,
  MarketingCaseFileChain,
  MarketingCaseFileCustomer,
  MarketingCaseFileDecisionAction,
  MarketingCaseFileFinanceHold,
  MarketingCaseFileHistory,
  MarketingCaseFileProducts,
  MarketingCaseFileTargetPharmacies,
  MarketingCaseFileViewerDecision,
  MarketingCaseFileWarning,
  MarketingRequestCaseFile,
} from "@/lib/marketing-requests/case-file-types";
import {
  isMarketingAdminOverrideNote,
  MARKETING_ADMIN_OVERRIDE_NOTE_CLASSES,
} from "@/lib/marketing-requests/admin-override-note";
import { humanizeCode } from "@/lib/format/code-label";
import { requestStatusLabel } from "@/lib/approvals-hub/request-status-label";
import { cairoDateTime, plainDate } from "@/lib/marketing-requests/request-report-columns";
import type { MarketingRequestStatus } from "@/lib/marketing-requests/types";
import { MarketingCaseFileGoDeeper } from "@/components/marketing-requests/marketing-case-file-go-deeper";
import { MarketingFinanceHoldControl } from "@/components/marketing-requests/marketing-finance-hold-control";
import { MarketingCancelControl } from "@/components/marketing-requests/marketing-cancel-control";
import { MarketingReopenControl } from "@/components/marketing-requests/marketing-reopen-control";
import { RecordConversationThread } from "@/components/conversations/record-conversation-thread";
import { ZoomablePhoto } from "@/components/ui/zoomable-photo";

/* ────────────────────────────────────────────────────────────────────────────
   The Case File view.

   A server component on purpose: getMarketingRequestCaseFile already runs on the server, so
   rendering here costs ZERO extra HTTP round trips and ships no JavaScript. The sibling tracking
   surface pays a second round trip to open a timeline; this one does not.

   ── THE ONE RULE THIS FILE MUST NOT BREAK ──
   Every fallible section arrives as a three-state CaseFileBlock: `ok` / `unavailable` /
   `not_applicable`. Those must render as THREE VISIBLY DIFFERENT THINGS. The module's recurring
   defect — the one the whole contract was built to end — is a read that FAILED rendering
   identically to a read that came back EMPTY. Collapsing `unavailable` into "nothing here" is
   precisely the bug, so `<Block>` below is the only way a section is unwrapped.
   ──────────────────────────────────────────────────────────────────────────── */

function egp(value: number) {
  return `EGP ${Math.round(Number.isFinite(value) ? value : 0).toLocaleString("en-US")}`;
}

function percent(ratio: number) {
  if (!Number.isFinite(ratio)) return "—";
  return `${Math.round(ratio * 100)}%`;
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

/** One labelled field. Absent renders "Not captured" — blank reads as a value of nothing. */
function DetailField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="bg-slate-50 px-3 py-2.5">
      <p className="text-phx-sm uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`text-phx-md font-medium ${value ? "text-slate-950" : "text-slate-400"}`}>
        {value || "Not captured"}
      </p>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-5 text-phx-xs font-semibold uppercase tracking-wider text-slate-400">{children}</p>
  );
}

/**
 * The three-state unwrapper. The ONLY way a CaseFileBlock is opened in this file.
 *
 * `unavailable` is deliberately loud (rose) and `not_applicable` deliberately quiet (slate): the
 * first means we tried and failed and the reader must not trust an absence, the second means there
 * is legitimately nothing to show yet.
 */
function Block<T>({
  block,
  children,
}: {
  block: CaseFileBlock<T>;
  children: (value: T) => React.ReactNode;
}) {
  if (block.state === "ok") return <>{children(block.value)}</>;
  if (block.state === "unavailable") {
    return (
      <p className="mt-2 border border-rose-200 bg-rose-50 px-3 py-2 text-phx-sm font-medium leading-5 text-rose-800">
        <span className="font-semibold">Could not be read. </span>
        {block.reason}
      </p>
    );
  }
  return (
    <p className="mt-2 border border-slate-200 bg-slate-50 px-3 py-2 text-phx-sm font-medium leading-5 text-slate-500">
      {block.reason}
    </p>
  );
}

/* ── warnings ─────────────────────────────────────────────────────────────── */

function warningClasses(warning: MarketingCaseFileWarning) {
  if (warning.state === "unavailable") return "border-slate-300 bg-slate-50 text-slate-600";
  if (warning.state === "clear") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (warning.severity === "block") return "border-rose-300 bg-rose-50 text-rose-900";
  if (warning.severity === "warn") return "border-amber-300 bg-amber-50 text-amber-900";
  return "border-slate-300 bg-white text-slate-700";
}

function warningMark(warning: MarketingCaseFileWarning) {
  if (warning.state === "clear") return "OK";
  if (warning.state === "unavailable") return "?";
  return "!";
}

function Warnings({ warnings }: { warnings: MarketingCaseFileWarning[] }) {
  if (warnings.length === 0) return null;
  // Loudest first, and "unavailable" outranks "clear" — an unrun check is never reassurance.
  const order = { flagged: 0, unavailable: 1, clear: 2 } as const;
  const sorted = [...warnings].sort((a, b) => order[a.state] - order[b.state]);
  return (
    <div className="mt-2 space-y-1.5">
      {sorted.map((warning) => (
        <div
          className={`flex items-start gap-2 border px-3 py-2 ${warningClasses(warning)}`}
          key={warning.key}
        >
          <span className="mt-px shrink-0 text-phx-sm font-black uppercase tracking-wider">
            {warningMark(warning)}
          </span>
          <p className="text-phx-sm font-medium leading-5">{warning.sentence}</p>
        </div>
      ))}
    </div>
  );
}

/* ── decision bar ─────────────────────────────────────────────────────────── */

/** Semantic colours lifted from the approval inbox so one verb never means two things. */
function decisionClasses(decision: MarketingCaseFileDecisionAction["decision"]) {
  if (decision === "approve") return "border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700";
  if (decision === "return") return "border-amber-300 bg-white text-amber-800 hover:bg-amber-50";
  return "border-rose-300 bg-white text-rose-700 hover:bg-rose-50";
}

/**
 * The finance hold, stated where the request is read.
 *
 * Everything shown here was already stored and displayed NOWHERE. The reason in particular sat in
 * `marketing_request_finance_requirements.notes`: a Super Admin froze committed money, wrote down
 * why, and the why reached no screen at all. A frozen request whose reason is invisible is one the
 * next reader can only guess at — and the next reader is usually the owner, weeks later.
 *
 * Rendered as a banner above the fold rather than a field further down, because the hold is the
 * single most important fact about a request that has one.
 */
function FinanceHoldPanel({
  canManage,
  hold,
  requestId,
}: {
  canManage: boolean;
  hold: MarketingCaseFileFinanceHold;
  requestId: string;
}) {
  return (
    <div className="border-b border-amber-300 bg-amber-50 px-6 py-4">
      <p className="text-phx-xs font-semibold uppercase tracking-[0.16em] text-amber-800">
        Frozen by finance
      </p>
      {/*
        KEEP THIS PANEL AT THE HEADING, THE REASON, AND A DATE — owner instruction 2026-08-30,
        given on seeing the first version live. Three things came out and none of them should
        return: the holder's NAME, the words "Super Admin", and a sentence restating what the
        heading and the reason already say. A requester opening their own frozen request needs to
        know it is frozen and why; who froze it makes a process decision look personal, and a role
        name tells them nothing they can act on.
      */}
      {/*
        The reason renders ONLY for someone who can act on the hold. A requester sees the heading
        and the date and nothing else — note that "No reason was recorded." is inside this branch
        too, because to a requester (whose payload never carried the reason) that sentence would be
        a lie about the state of their own request.
      */}
      {canManage
        ? hold.reason
          ? <p className="mt-1 whitespace-pre-wrap text-phx-sm leading-5 text-slate-700">{hold.reason}</p>
          : <p className="mt-1 text-phx-sm leading-5 text-slate-500">No reason was recorded.</p>
        : null}
      {hold.heldAt || (hold.invoiceStatus && hold.invoiceStatus !== "hold") ? (
        <p className="mt-2 text-phx-xs text-slate-600">
          {hold.heldAt ? cairoDateTime(hold.heldAt) : ""}
          {/* `hold` means the overdue marker is paused. Anything else means the invoice was already
              settled when the hold was placed, which is correct and worth saying rather than hiding. */}
          {hold.invoiceStatus && hold.invoiceStatus !== "hold"
            ? `${hold.heldAt ? " · " : ""}invoice ${hold.invoiceStatus}`
            : ""}
        </p>
      ) : null}
      {canManage ? <MarketingFinanceHoldControl held requestId={requestId} /> : null}
    </div>
  );
}

/**
 * The viewer's own open rung, answerable in place.
 *
 * Rendered ABOVE everything, directly under the header, and deliberately so: the reader who sees
 * this bar arrived from a notification that told them the request was theirs to answer, and making
 * them scroll a full case file to find out how is the defect this fixes, in a milder form. It says
 * which rung it is, so "approve" is never an unlabelled yes.
 *
 * `viewer.decision` is non-null ONLY for the holder of the current gating rung of a request still
 * `pending_approval` (buildCaseFileDecisionBar). Every href lands on the decision page, which
 * re-runs the whole gate before it shows a confirmation, and the API re-runs it again before it
 * writes — this is an affordance, never an authorisation. The full incident is in the header of
 * src/lib/marketing-requests/case-file-decision-bar.ts.
 */
function DecisionBar({ decision }: { decision: MarketingCaseFileViewerDecision }) {
  return (
    <div className="border-b border-orange-200 bg-orange-50 px-6 py-4">
      <p className="text-phx-xs font-semibold uppercase tracking-[0.16em] text-orange-700">
        Waiting for you
      </p>
      <p className="mt-1 text-phx-md font-medium leading-5 text-slate-800">
        This request is on your rung — {decision.stepName}. It does not move until you answer it.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {decision.actions.map((action) => (
          // min-h-11 is a thumb, not a cursor: the CEO reads these on a phone, from a push alert.
          <a
            className={`inline-flex min-h-11 items-center whitespace-nowrap border px-5 text-phx-md font-semibold ${decisionClasses(action.decision)}`}
            href={action.href}
            key={action.decision}
          >
            {action.label}
          </a>
        ))}
      </div>
    </div>
  );
}

/* ── approval chain ───────────────────────────────────────────────────────── */

function rungClasses(rung: MarketingCaseFileChain["rungs"][number]) {
  if (rung.isCurrent) return "bg-orange-500 text-white";
  if (rung.status === "approved") return "bg-slate-900 text-white";
  if (rung.status === "rejected" || rung.status === "returned") return "bg-rose-100 text-rose-700";
  if (rung.status === "skipped") return "bg-slate-100 text-slate-400";
  return "bg-slate-100 text-slate-500";
}

function Chain({
  chain,
  requestCode,
  status,
}: {
  chain: MarketingCaseFileChain;
  /** Only read to spot the one out-of-band SFE Validation note — see `admin-override-note.ts`. */
  requestCode?: string | null;
  status: MarketingRequestStatus;
}) {
  // Nobody is holding a request that has already ended. `chain.currentStepName` is derived from the
  // step rows, so it named a rung on a refused request for as long as those rows stayed `pending`,
  // and rendering "now with Finance Execution" on a request Finance never saw is exactly the kind
  // of confident wrong answer this page exists to stop. Caught in the browser against the live
  // rejected request. The guard stays even though the rows are now closed out at the source: the
  // sentence is only ever true of a request still in flight, whatever the chain happens to say.
  const isInFlight = status === "pending_approval";

  // A rung below the refusal was never reached and never will be.
  //
  // The decision RPC now closes these out as `skipped` in the same transaction as the reject, and
  // the migration backfilled the rows that were already stranded — so this normally reads real data
  // rather than compensating for it.
  //
  // `skipped` alone is NOT enough to say "not reached", because three different things write it: a
  // CC row (informational, skipped from birth), a rung the requester was assigned to (skipped with
  // a decision note explaining why), and a rung the refusal closed out. Only the third was never
  // reached, and it is the only one with no note and no CC tag. `pending` stays as a fallback for
  // rows written before the migration — "pending" on a dead request is the outcome worth defending
  // against, because it reads as work somebody still owes.
  const neverReached = (rung: MarketingCaseFileChain["rungs"][number]) =>
    status === "rejected" &&
    !rung.isCc &&
    (rung.status === "pending" || (rung.status === "skipped" && !rung.decisionNote));

  return (
    <>
      <p className="mt-2 text-phx-sm font-medium text-slate-600">
        {chain.approvedGatingCount} of {chain.totalGatingSteps} approvals
        {isInFlight && chain.currentStepName ? ` · now with ${chain.currentStepName}` : ""}
      </p>
      {chain.returnReason ? (
        <p className="mt-2 border border-amber-200 bg-amber-50 px-3 py-2 text-phx-sm font-medium leading-5 text-amber-900">
          <span className="font-semibold">Returned: </span>
          {chain.returnReason}
        </p>
      ) : null}
      <ol className="mt-2 space-y-1.5">
        {chain.rungs.map((rung) => (
          <li
            className={`border px-3 py-2.5 ${
              rung.isMine ? "border-orange-300 bg-orange-50/40" : "border-slate-200 bg-white"
            }`}
            key={`${rung.sequence}-${rung.stepName}-${rung.isCc ? "cc" : "gate"}`}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-phx-md font-medium text-slate-950">
                  {rung.stepName}
                  {/* CC rows are KEPT and tagged. "The PM was asked and said nothing" is a fact
                      about the decision; dropping the row deletes it. */}
                  {rung.isCc ? (
                    <span className="ml-1.5 bg-slate-200/70 px-1 py-0.5 text-phx-xs font-black uppercase tracking-[0.08em] text-slate-500">
                      CC
                    </span>
                  ) : null}
                  {rung.isMine ? (
                    <span className="ml-1.5 bg-orange-200/70 px-1 py-0.5 text-phx-xs font-black uppercase tracking-[0.08em] text-orange-800">
                      You
                    </span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-phx-xs text-slate-500">
                  {rung.assignedRole}
                  {rung.assignedName ? ` · ${rung.assignedName}` : ""}
                </p>
              </div>
              <span
                className={`shrink-0 px-2 py-0.5 text-phx-sm font-semibold uppercase tracking-[0.06em] ${
                  neverReached(rung) ? "bg-slate-100 text-slate-400" : rungClasses(rung)
                }`}
              >
                {neverReached(rung) ? "not reached" : requestStatusLabel(rung.status)}
              </span>
            </div>
            {rung.decisionAt || rung.decisionNote ? (
              <div className="mt-1.5 border-t border-slate-100 pt-1.5">
                <p className="text-phx-xs text-slate-500">
                  {rung.approverName || rung.assignedName}
                  {rung.decisionAt ? ` · ${cairoDateTime(rung.decisionAt) ?? ""}` : ""}
                </p>
                {rung.decisionNote ? (
                  <p
                    className={`mt-1 break-words text-phx-sm font-medium leading-5 ${
                      isMarketingAdminOverrideNote({ requestCode, stepName: rung.stepName })
                        ? MARKETING_ADMIN_OVERRIDE_NOTE_CLASSES
                        : "text-slate-700"
                    }`}
                  >
                    {rung.decisionNote}
                  </p>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </>
  );
}

/* ── history ──────────────────────────────────────────────────────────────── */

function History({ history }: { history: MarketingCaseFileHistory }) {
  return (
    <>
      <p className="mt-2 text-phx-sm font-medium text-slate-600">
        {history.commentCount > 0
          ? `${history.commentCount} comment${history.commentCount === 1 ? "" : "s"} · ${history.entries.length} event${history.entries.length === 1 ? "" : "s"}`
          : `${history.entries.length} event${history.entries.length === 1 ? "" : "s"}`}
      </p>
      <ol className="mt-2 space-y-1.5">
        {history.entries.map((entry) => (
          <li
            className={`border px-3 py-2.5 ${
              // A comment is the reason this section exists — the step row can only ever hold the
              // latest one, so an earlier comment appears HERE or nowhere.
              entry.kind === "step_commented"
                ? "border-orange-200 bg-orange-50/40"
                : "border-slate-200 bg-white"
            }`}
            key={`${entry.occurredAt}-${entry.kind}-${entry.stepName ?? ""}`}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="min-w-0 text-phx-md font-medium text-slate-950">{entry.headline}</p>
              <span className="shrink-0 text-phx-xs text-slate-500">{entry.atLabel}</span>
            </div>
            {entry.note ? (
              <p className="mt-1 break-words text-phx-sm font-medium leading-5 text-slate-700">
                {entry.note}
              </p>
            ) : null}
            {/* A reconstruction is labelled as one. A row derived from the request's own columns
                during the backfill did not witness the event, and must not pass as if it had. */}
            {entry.isBackfilled ? (
              <p className="mt-1 text-phx-sm uppercase tracking-[0.06em] text-slate-400">
                Reconstructed from the request&apos;s own rows
              </p>
            ) : null}
          </li>
        ))}
      </ol>
      <p className="mt-2 text-phx-xs leading-5 text-slate-400">{history.coverageSentence}</p>
    </>
  );
}

/* ── products ─────────────────────────────────────────────────────────────── */

function Products({ products }: { products: MarketingCaseFileProducts }) {
  return (
    <>
      {/* Mobile: cards. Desktop: table. Owner rule — admin/desktop shows tables, mobile never does. */}
      <div className="mt-2 space-y-2 md:hidden">
        {products.rows.map((row) => (
          <div className="border border-slate-200 bg-white px-3 py-2.5" key={row.productId}>
            <p className="text-phx-md font-medium text-slate-950">{row.name}</p>
            <div className="mt-1.5 flex items-center justify-between text-xs">
              <span className="text-slate-500">
                Qty <span className="font-semibold text-slate-800">{row.forecastQuantity}</span>
              </span>
              <span className="font-medium text-slate-950">{egp(row.expectedValue)}</span>
            </div>
          </div>
        ))}
      </div>
      <table className="mt-2 hidden w-full table-fixed border-collapse text-sm md:table">
        <colgroup>
          <col className="w-[40%]" />
          <col className="w-[20%]" />
          <col className="w-[18%]" />
          <col className="w-[22%]" />
        </colgroup>
        <thead>
          <tr className="bg-slate-950 text-white">
            <th className="px-3 py-2 text-left font-medium">Product</th>
            <th className="px-3 py-2 text-left font-medium">Line</th>
            <th className="px-3 py-2 text-right font-medium">Forecast qty</th>
            <th className="px-3 py-2 text-right font-medium">Expected value</th>
          </tr>
        </thead>
        <tbody>
          {products.rows.map((row) => (
            <tr className="border-b border-orange-100" key={row.productId}>
              <td className="break-words px-3 py-2 text-slate-950">{row.name}</td>
              <td className="break-words px-3 py-2 text-slate-600">{row.line ?? "—"}</td>
              <td className="px-3 py-2 text-right text-slate-600">{row.forecastQuantity}</td>
              <td className="px-3 py-2 text-right text-slate-950">{egp(row.expectedValue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-phx-sm font-medium text-slate-600">
        {products.totalForecastUnits} units · {egp(products.totalExpectedValue)} expected
      </p>
      {/* Announced, never a silently short list. */}
      {products.confidentialWithheldCount > 0 ? (
        <p className="mt-2 border border-slate-300 bg-slate-50 px-3 py-2 text-phx-sm font-medium text-slate-600">
          {products.confidentialWithheldCount} confidential product
          {products.confidentialWithheldCount === 1 ? " is" : "s are"} on this request but hidden
          from your role.
        </p>
      ) : null}
    </>
  );
}

/* ── target pharmacies ────────────────────────────────────────────────────── */

function TargetPharmacies({ targets }: { targets: MarketingCaseFileTargetPharmacies }) {
  if (targets.rows.length === 0) {
    return (
      <p className="mt-2 border border-rose-200 bg-rose-50 px-3 py-2 text-phx-sm font-medium text-rose-800">
        No target pharmacies. A request with no targets can never attribute a sale, so its ROI stays
        zero however well the campaign performs.
      </p>
    );
  }
  return (
    <>
      <div className="mt-2 space-y-2">
        {targets.rows.map((row) => (
          <div
            className={`border px-3 py-2.5 ${
              row.suspect ? "border-amber-300 bg-amber-50/50" : "border-slate-200 bg-white"
            }`}
            key={`${row.pharmacyCode}-${row.distributorPharmacyCode}`}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-phx-md font-medium text-slate-950">{row.pharmacyName}</p>
                <p className="mt-0.5 text-phx-xs text-slate-500">
                  {row.distributorName} · {row.distributorPharmacyCode}
                </p>
              </div>
            </div>
            {/* Prose, never the raw status word — a "pending" chip here was always a failed lookup
                wearing a benign label. */}
            <p className="mt-1.5 text-phx-xs font-medium text-slate-600">{row.referenceStatusSentence}</p>
          </div>
        ))}
      </div>
      {/* Only the counts that are actually non-zero. "0 codes cannot be relied on" is noise that
          reads, at a glance, like a warning. */}
      {targets.suspectCount > 0 || targets.unvalidatedCount > 0 ? (
        <p className="mt-2 text-phx-sm font-medium text-amber-800">
          {[
            targets.suspectCount > 0
              ? `${targets.suspectCount} code${targets.suspectCount === 1 ? "" : "s"} cannot be relied on for attribution`
              : null,
            targets.unvalidatedCount > 0
              ? `${targets.unvalidatedCount} pharmac${targets.unvalidatedCount === 1 ? "y is" : "ies are"} unvalidated`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}
    </>
  );
}

/* ── customer ─────────────────────────────────────────────────────────────── */

function Customer({ customer, canSeePii }: { customer: MarketingCaseFileCustomer; canSeePii: boolean }) {
  return (
    <>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <DetailField label="Customer code" value={customer.code} />
        <DetailField label="Customer name" value={customer.name} />
        <DetailField label="Type" value={customer.type} />
        <DetailField label="Type detail" value={customer.speciality} />
        <DetailField label="Area" value={customer.location.extractedAreaName} />
        <DetailField label="Governorate" value={customer.location.extractedGovernorateName} />
      </div>

      {/* Never surfaced anywhere before this page, though the overwhelming majority of customers
          sit at `pending`. "Nobody has ever validated this customer" must be visible, not silent. */}
      <p
        className={`mt-2 border px-3 py-2 text-phx-sm font-medium leading-5 ${
          customer.validation.status === "pending"
            ? "border-amber-300 bg-amber-50 text-amber-900"
            : "border-slate-200 bg-slate-50 text-slate-600"
        }`}
      >
        {customer.validation.sentence}
      </p>

      {canSeePii ? (
        <>
          <Block block={customer.contact}>
            {(contact) =>
              contact.name || contact.mobile ? (
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <DetailField label="Contact" value={contact.name} />
                  <DetailField label="Contact mobile" value={contact.mobile} />
                </div>
              ) : (
                <p className="mt-2 text-phx-sm font-medium text-slate-400">No contact captured.</p>
              )
            }
          </Block>
          <Block block={customer.location.capturedAddress}>
            {(address) =>
              address ? (
                <p className="mt-2 border border-slate-200 bg-white px-3 py-2 text-phx-sm font-medium leading-5 text-slate-600">
                  {address}
                </p>
              ) : (
                <p className="mt-2 text-phx-sm font-medium text-slate-400">No address captured.</p>
              )
            }
          </Block>
          <Block block={customer.evidencePhoto}>
            {(photo) =>
              photo.url ? (
                <figure className="mt-2 border border-emerald-200 bg-white">
                  <ZoomablePhoto
                    alt={`Live capture of ${customer.name ?? "the customer"} premises`}
                    caption={`Live capture · ${customer.name ?? "the customer"}`}
                    className="h-64 w-full bg-slate-50 object-contain"
                    src={photo.url}
                  />
                  <figcaption className="border-t border-emerald-200 px-3 py-1.5 text-phx-xs font-semibold text-emerald-700">
                    Live capture on file
                    {photo.capturedAt ? ` · ${cairoDateTime(photo.capturedAt) ?? ""}` : ""}
                  </figcaption>
                </figure>
              ) : (
                // A filename is NOT proof: for customers created before the retention fix only the
                // string was kept and the bytes were discarded in the browser.
                <p className="mt-2 border border-slate-300 bg-slate-50 px-3 py-2 text-phx-sm font-medium text-slate-600">
                  {photo.fileName
                    ? `A capture was named (${photo.fileName}) but no image was retained — this is not proof.`
                    : "No live capture photo on file."}
                </p>
              )
            }
          </Block>
        </>
      ) : (
        <p className="mt-2 border border-slate-200 bg-slate-50 px-3 py-2 text-phx-sm font-medium text-slate-500">
          Contact details, captured address and evidence photographs are withheld from your role.
        </p>
      )}
    </>
  );
}

/* ── the page view ────────────────────────────────────────────────────────── */

export function MarketingRequestCaseFileView({ caseFile }: { caseFile: MarketingRequestCaseFile }) {
  const {
    chain,
    customer,
    financeHold,
    header,
    history,
    lazySections,
    money,
    outcome,
    products,
    targetPharmacies,
    viewer,
    warnings,
  } = caseFile;

  // The PLACE half. Without it the Case File could only ever RELEASE a hold someone else had
  // placed from outside the product, which is how this feature spent its whole life so far.
  //
  // Decided on the server (`buildViewer`), never here: which statuses may be frozen is a domain
  // rule, and a component re-listing it would be a second copy of that rule. This module has
  // already paid for a second copy of a rule once — two definitions of "overdue" on the same
  // money path — which is precisely what the shared obligation module was created to end.
  const canPlaceHold = viewer.can.placeFinanceHold;

  /**
   * The rung that ended the chain, and therefore the one a reopen puts back.
   *
   * Highest sequence first, mirroring `phx_reopen_rejected_marketing_request`'s own
   * `order by sequence desc limit 1`: a request refused, reopened and refused again further up
   * must name the LATEST refusal, never the first. CC rows are excluded — they are never gates.
   */
  //
  // `chain` is a CaseFileBlock, so it may be withheld ("unavailable") for this viewer. That is not
  // a reason to hide the control: the RPC finds the refused rung itself, so a reopen still works
  // with no chain to read. Only the panel's naming of WHO refused it degrades, which the copy below
  // already handles.
  const refusedRung =
    viewer.can.reopen && chain.state === "ok"
      ? [...chain.value.rungs]
          .filter((rung) => !rung.isCc && rung.status === "rejected")
          .sort((left, right) => right.sequence - left.sequence)[0] ?? null
      : null;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      <div className="border border-slate-200 bg-white">
        <div className="bg-slate-950 px-6 py-5">
          <p className="text-phx-xs font-semibold uppercase tracking-[0.18em] text-orange-400">
            Marketing request
            {header.origin === "xlsx_import" ? " · imported" : ""}
          </p>
          <h1 className="mt-1 font-mono text-xl font-semibold text-white">{header.requestCode}</h1>
          {/* One sentence: where it is and what happens next. Never a bare status code. */}
          <p className="mt-1.5 text-phx-md leading-5 text-slate-300">{header.lifecycleSentence}</p>
        </div>

        {financeHold ? (
          <FinanceHoldPanel
            canManage={viewer.can.manageFinanceHold}
            hold={financeHold}
            requestId={header.requestId}
          />
        ) : null}

        {canPlaceHold ? (
          <div className="border-b border-slate-200 bg-slate-50 px-6 py-4">
            <p className="text-phx-xs font-semibold uppercase tracking-[0.16em] text-slate-600">
              Finance hold
            </p>
            <p className="mt-1 text-phx-md leading-5 text-slate-700">
              Freeze this request if the invoice has not arrived. It stops the overdue marker and
              records why, but pays nobody and reverses nothing.
            </p>
            <MarketingFinanceHoldControl held={false} requestId={header.requestId} />
          </div>
        ) : null}

        {viewer.can.reopen ? (
          <div className="border-b border-slate-200 bg-slate-50 px-6 py-4">
            <p className="text-phx-xs font-semibold uppercase tracking-[0.16em] text-slate-600">
              Reopen
            </p>
            <p className="mt-1 text-phx-md leading-5 text-slate-700">
              This request was refused
              {refusedRung ? ` by ${refusedRung.approverName} at ${refusedRung.stepName}` : ""}.
              Reopening puts it back on that same rung and tells them again — the approvals already
              given below it are not asked for a second time.
            </p>
            {refusedRung?.decisionNote ? (
              <p className="mt-2 border-l-2 border-rose-300 pl-3 text-phx-sm leading-5 text-slate-600">
                Reason given: {refusedRung.decisionNote}
              </p>
            ) : null}
            <MarketingReopenControl requestId={header.requestId} stepName={refusedRung?.stepName ?? null} />
          </div>
        ) : null}

        {viewer.can.cancel ? (
          <div className="border-b border-slate-200 bg-slate-50 px-6 py-4">
            <p className="text-phx-xs font-semibold uppercase tracking-[0.16em] text-slate-600">
              Cancel
            </p>
            <p className="mt-1 text-phx-md leading-5 text-slate-700">
              Call this request off if it will not go ahead. It becomes terminal and stops counting
              towards committed spend, but pays nobody and reverses nothing — any money already moved
              is reversed on the finance screen.
            </p>
            <MarketingCancelControl requestId={header.requestId} />
          </div>
        ) : null}

        {viewer.decision ? <DecisionBar decision={viewer.decision} /> : null}

        <div className="px-6 py-5">
          <div className="flex items-center gap-3 border-b border-slate-200 pb-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center bg-orange-50 text-sm font-semibold text-orange-700">
              {initials(header.requester.name)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-phx-lg font-medium text-slate-950">{header.requester.name}</p>
              {header.requester.role ? <p className="text-xs text-slate-500">{header.requester.role}</p> : null}
            </div>
            <div className="shrink-0 text-right">
              <span className="inline-block bg-slate-100 px-2.5 py-1 text-phx-xs font-medium uppercase tracking-wide text-slate-700">
                {/* Not the raw status: a request on Finance Execution still stores
                    `pending_approval` though every approver has signed. See request-status-label.ts. */}
                {header.statusLabel}
              </span>
            </div>
          </div>

          {/* The requester's OWN org context, in its own group and labelled as such. On the approval
              screen these values sit under a "Customer" heading while carrying the requester's
              values, so an approver reading "Area: Giza" believes it describes the customer. */}
          <SectionLabel>Raised by</SectionLabel>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <DetailField label="Requester line" value={header.requester.lineName} />
            <DetailField label="Requester area" value={header.requester.areaName} />
            <DetailField label="Requester region" value={header.requester.regionName} />
          </div>

          <SectionLabel>Checks</SectionLabel>
          <Warnings warnings={warnings} />

          <SectionLabel>The ask</SectionLabel>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <div className="bg-slate-50 px-3 py-2.5">
              <p className="text-phx-sm uppercase tracking-wide text-slate-400">Estimated cost</p>
              <p className="text-base font-medium text-slate-950">{egp(money.estimatedCost)}</p>
            </div>
            <div className="bg-orange-50 px-3 py-2.5">
              <p className="text-phx-sm uppercase tracking-wide text-orange-700">
                Required ROI{money.roiDurationMonths ? ` · ${money.roiDurationMonths} mo` : ""}
              </p>
              <p className="text-base font-medium text-orange-800">{egp(money.requiredRoiValue)}</p>
            </div>
            <div className="bg-slate-50 px-3 py-2.5">
              <p className="text-phx-sm uppercase tracking-wide text-slate-400">Expected ROI</p>
              <p className="text-phx-md font-medium text-slate-950">{egp(money.expectedRoiValue)}</p>
            </div>
            <div className="bg-slate-50 px-3 py-2.5">
              <p className="text-phx-sm uppercase tracking-wide text-slate-400">
                Forecast coverage
              </p>
              <p className="text-phx-md font-medium text-slate-950">
                {percent(money.forecastCoverageRatio)}
              </p>
            </div>
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <DetailField label="Request type" value={header.requestType} />
            <DetailField label="Request date" value={plainDate(header.requestDate)} />
            <DetailField label="Pay date" value={plainDate(header.payDate)} />
          </div>

          <SectionLabel>Spent on this customer before</SectionLabel>
          <Block block={money.spentBefore}>
            {(spent) =>
              spent.isFirstRequest ? (
                <p className="mt-2 text-phx-sm font-medium text-slate-600">
                  First request for this customer — nothing has been committed here before.
                </p>
              ) : (
                <>
                  <p className="mt-2 text-phx-sm font-medium text-slate-700">
                    {egp(spent.total)} committed across {spent.requests.length} earlier request
                    {spent.requests.length === 1 ? "" : "s"} (drafts and refused requests excluded)
                    {" · "}
                    {/* null, never 0 — "never measured" is not "measured at zero". */}
                    {spent.priorRealisedSales === null
                      ? "no earlier return has been measured"
                      : `${egp(spent.priorRealisedSales)} realised`}
                  </p>
                  <ul className="mt-2 space-y-1">
                    {spent.requests.map((prior) => (
                      <li
                        className="flex flex-wrap items-center justify-between gap-2 border border-slate-200 bg-white px-3 py-2 text-phx-sm"
                        key={prior.requestCode}
                      >
                        <span className="font-mono text-slate-700">{prior.requestCode}</span>
                        <span className="text-slate-500">
                          {requestStatusLabel(prior.status)}
                          {prior.payDate ? ` · ${plainDate(prior.payDate) ?? ""}` : ""}
                        </span>
                        <span className="font-medium text-slate-950">{egp(prior.estimatedCost)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )
            }
          </Block>

          <SectionLabel>Approval chain</SectionLabel>
          <Block block={chain}>
            {(value) => <Chain chain={value} requestCode={header.requestCode} status={header.status} />}
          </Block>

          {/* Directly under the chain: the chain says WHERE the request is, this says how it got
              there — and holds the comments the step rows overwrote. */}
          <SectionLabel>History and comments</SectionLabel>
          <Block block={history}>{(value) => <History history={value} />}</Block>

          <SectionLabel>Customer</SectionLabel>
          <Block block={customer}>
            {(value) => <Customer canSeePii={viewer.canSeeCustomerPii} customer={value} />}
          </Block>

          <SectionLabel>Products</SectionLabel>
          <Block block={products}>{(value) => <Products products={value} />}</Block>

          <SectionLabel>Target pharmacies</SectionLabel>
          <Block block={targetPharmacies}>{(value) => <TargetPharmacies targets={value} />}</Block>

          <SectionLabel>Outcome</SectionLabel>
          <Block block={outcome}>
            {(value) => (
              <>
                {/* Prose verdict. Never renders zero attributed sales as a failure when the
                    measurement window has not opened yet. */}
                <p className="mt-2 text-phx-sm font-medium leading-5 text-slate-700">
                  {value.resultSentence}
                </p>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <div className="bg-slate-50 px-3 py-2.5">
                    <p className="text-phx-sm uppercase tracking-wide text-slate-400">Realised sales</p>
                    <p className="text-phx-md font-medium text-slate-950">{egp(value.actualSalesValue)}</p>
                  </div>
                  <div className="bg-slate-50 px-3 py-2.5">
                    <p className="text-phx-sm uppercase tracking-wide text-slate-400">Coverage of required</p>
                    <p className="text-phx-md font-medium text-slate-950">
                      {percent(value.actualCoverageRatio)}
                    </p>
                  </div>
                </div>
                {value.attributionGapReason ? (
                  <p className="mt-2 border border-amber-200 bg-amber-50 px-3 py-2 text-phx-sm font-medium leading-5 text-amber-900">
                    {value.attributionGapReason}
                  </p>
                ) : null}
                <SectionLabel>Confidence in the figure</SectionLabel>
                <Block block={value.confidence}>
                  {(confidence) => (
                    <p className="mt-2 text-phx-sm font-medium text-slate-600">
                      {confidence.score}/100 ({confidence.band})
                      {confidence.weakest ? ` · ${confidence.weakest.detail}` : ""}
                    </p>
                  )}
                </Block>
              </>
            )}
          </Block>

          {lazySections.length > 0 ? (
            <>
              <SectionLabel>Go deeper</SectionLabel>
              {/* Press-to-expand IN PLACE. These four were once plain links straight at raw JSON API
                  routes, so pressing one navigated the reader off the Case File and dumped the
                  route's JSON into the window. Each panel already self-fetches by request id, so the
                  reader now opens it below the button and never leaves the page. */}
              <MarketingCaseFileGoDeeper
                requestId={header.requestId}
                sections={lazySections}
                viewSalesBasePath={viewer.viewSalesBasePath}
              />
            </>
          ) : null}

          <div className="mt-6 border-t border-slate-200 pt-3">
            <p className="text-phx-xs leading-5 text-slate-400">
              {/* Announced, never silent: a reader seeing a redacted file must be able to tell why. */}
              You can see this request as: {viewer.admittedAs.map((a) => humanizeCode(a)).join(", ")}
              {" · "}
              Generated {cairoDateTime(caseFile.generatedAt) ?? ""} (Africa/Cairo)
            </p>
          </div>
        </div>
      </div>

      {/* The conversation — open at ANY status, even after this request is rejected / cancelled
          (owner rule, 2026-09-22). This case-file page is the shared "open the request" destination
          for the requester and every approver, so mounting the thread here reaches them all. Every
          message emails the requester, cc's everyone on the request, and pings them in-app / Telegram.
          A viewer admitted ONLY as a product's owner reads this file with the customer's details held
          back, and the conversation can carry them, so its route refuses them: asking anyway only
          raised a false block on their screen (2 Nov 2026). The route's gate stays as it is. */}
      {viewer.admittedAs.some((arm) => arm !== "product_owner") ? (
        <div className="mt-6">
          <RecordConversationThread base={`/api/marketing-requests/${header.requestId}/conversation`} />
        </div>
      ) : null}
    </main>
  );
}
