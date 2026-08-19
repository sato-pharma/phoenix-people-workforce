"use client";

import { useEffect, useState } from "react";

import { LoadingSpinner } from "@/components/ui/loading-state";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import {
  ApprovalTracker,
  type ApprovalTrackerState,
  BlockNotice,
  CaseFileBlockView,
  Chip,
  Field,
  FieldGroup,
  FieldTable,
  HeroStat,
  LeadBanner,
  NotProvided,
  PanelSection,
  WarningRow,
} from "@/components/marketing-requests/case-file-primitives";
import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";
import type {
  CaseFileBlock,
  MarketingCaseFileAdmission,
  MarketingCaseFileChainRung,
  MarketingCaseFileProduct,
  MarketingCaseFileReferenceStatus,
  MarketingCaseFileTargetPharmacy,
  MarketingRequestCaseFile,
} from "@/lib/marketing-requests/case-file-types";
import { ROI_DATA_COVERAGE_LABEL, ROI_RESULT_STATUS_LABEL } from "@/lib/marketing-requests/roi-labels";
import type { RoiLifecycleStage } from "@/lib/marketing-requests/roi-live-stages";
import type {
  MarketingApprovalStepStatus,
  MarketingRequestStatus,
  MarketingValidationStatus,
} from "@/lib/marketing-requests/types";

/**
 * ONE marketing request, in one place.
 *
 * A marketing request is a spend commitment that climbs an approval chain and is judged months
 * later on realized sales. Until now its data was spread across ~20 routes, and three lifecycle
 * stages had NO surface at all: a REJECTED request vanishes from the requester's workspace, an
 * approver cannot reopen what they already decided, and `closed` shows nothing. All three are
 * readable here.
 *
 * ── THE RULE THAT GOVERNS EVERY PIXEL ────────────────────────────────────────
 *
 * Each fallible section arrives as a `CaseFileBlock`: `ok` | `unavailable` | `not_applicable`, and
 * each of the six checks carries `clear` | `flagged` | `unavailable`. All three render DISTINCTLY,
 * and `unavailable` never looks like `clear` or like an empty `ok`. That distinction is the whole
 * reason this screen exists — the screens it replaces render a failed check, a check that could not
 * run, and a clean pass identically, which is how a read that fell over gets acted on as a result.
 *
 * Concretely, and measured live on MKT-REQ-20260802-DCF31EC4: its ROI window is 2026-08 → 2026-12
 * while validated sales end 2026-07, so zero attributed sales is CORRECT and means "not due yet".
 * The existing screen says "No sales matched in this period range" — a reader is told the campaign
 * failed when it has not started. Here that is a `not_applicable` block carrying the service's own
 * sentence, in its own colour, under its own heading.
 *
 * Every empty state is a sentence. A missing field says "Not provided" rather than vanishing,
 * because a vanished field reads as "the screen forgot to ask".
 *
 * Reads only. `viewer.can` is an affordance hint the acting routes each re-enforce; nothing here
 * mutates anything, and no capability boolean is used as a data gate.
 */

/* ------------------------------------------------------------------------- */
/* Labels — never a raw enum on screen                                        */
/* ------------------------------------------------------------------------- */

const STATUS_LABELS: Record<MarketingRequestStatus, string> = {
  active: "Active",
  approved: "Approved",
  archived: "Archived",
  closed: "Closed",
  draft: "Draft",
  finance_hold: "Held by Finance",
  pending_approval: "Pending approval",
  pending_validation: "Pending validation",
  rejected: "Rejected",
  returned: "Returned for edits",
  roi_tracking: "ROI tracking",
};

const STEP_STATUS_LABELS: Record<MarketingApprovalStepStatus, string> = {
  approved: "Approved",
  current: "Waiting on this person",
  pending: "Not reached yet",
  rejected: "Rejected",
  returned: "Returned for edits",
  skipped: "Skipped",
};

const VALIDATION_LABELS: Record<MarketingValidationStatus, string> = {
  pending: "Never validated",
  rejected: "Validation rejected",
  sfe_validated: "Validated by SFE",
  system_validated: "Validated by the system",
};

const LIFECYCLE_LABELS: Record<RoiLifecycleStage, string> = {
  approved_unpaid: "Approved, not yet paid",
  awaiting_approval: "Awaiting a decision",
  judged: "Fully measured",
  measuring: "Being measured",
  rejected: "Refused",
};

const ADMISSION_LABELS: Record<MarketingCaseFileAdmission, string> = {
  cc_reviewer: "Advisory reviewer on the chain",
  chain_step: "Approver on the chain",
  company_oversight: "Company-wide oversight",
  hierarchy: "In the requester's management line",
  product_owner: "Owner of a promoted product",
  requester: "The requester",
  system: "System-wide access",
};

const REFERENCE_STATUS_LABELS: Record<MarketingCaseFileReferenceStatus, string> = {
  ambiguous: "More than one match",
  lookup_failed: "Could not be read",
  manual_approved: "Manually approved",
  matched: "Confirmed",
  not_found: "Not in the reference database",
  pending: "Never checked",
  rejected: "Rejected in validation",
};

const ORIGIN_LABELS: Record<string, string> = {
  phoenix: "Submitted inside Phoenix",
  xlsx_import: "Bulk-loaded from a spreadsheet — it has no live approval chain",
};

const CONFIDENCE_BAND_LABELS: Record<"high" | "medium" | "low", string> = {
  high: "High confidence",
  low: "Low confidence",
  medium: "Medium confidence",
};

/* ------------------------------------------------------------------------- */
/* Formatters — Africa/Cairo, human-readable, never truncated                 */
/* ------------------------------------------------------------------------- */

const numberFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function money(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Not provided";
  return `${numberFormatter.format(Math.round(value))} EGP`;
}

function units(value: number): string {
  return numberFormatter.format(Number.isFinite(value) ? value : 0);
}

function percent(ratio: number): string {
  return `${Math.round((Number.isFinite(ratio) ? ratio : 0) * 100)}%`;
}

/** A calendar day in Africa/Cairo. Handles both `YYYY-MM-DD` and a full ISO stamp. */
function cairoDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: PHOENIX_BUSINESS_TIME_ZONE,
    year: "numeric",
  });
}

/** A moment in Africa/Cairo, named as such so nobody reads it as UTC. */
function cairoDateTime(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${parsed.toLocaleString("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: PHOENIX_BUSINESS_TIME_ZONE,
    year: "numeric",
  })} Cairo`;
}

/** A date, or the sentence saying there is not one. Never a bare dash. */
function dateOr(value: string | null, absence: string) {
  const formatted = cairoDate(value);
  return formatted ?? <NotProvided what={absence} />;
}

function textOr(value: string | null | undefined, absence = "Not provided") {
  const clean = typeof value === "string" ? value.trim() : "";
  return clean ? clean : <NotProvided what={absence} />;
}

/** The short, honest phrase a hero tile shows when its number could not be produced. */
function blockShorthand(block: CaseFileBlock<unknown>): string {
  return block.state === "unavailable" ? "Could not be read" : "Not measurable yet";
}

function blockTone(block: CaseFileBlock<unknown>): "amber" | "sky" {
  return block.state === "unavailable" ? "amber" : "sky";
}

function trackerState(rung: MarketingCaseFileChainRung): ApprovalTrackerState {
  switch (rung.status) {
    case "approved":
      return "done";
    case "current":
      return "current";
    case "rejected":
      return "rejected";
    case "returned":
      return "returned";
    case "skipped":
      return "skipped";
    default:
      return "waiting";
  }
}

/* ------------------------------------------------------------------------- */
/* Sections                                                                   */
/* ------------------------------------------------------------------------- */

/** 1. Header — the code, the status, the lifecycle sentence, the decisive numbers, the chain bar. */
function HeaderSection({ caseFile }: { caseFile: MarketingRequestCaseFile }) {
  const { header, money: forecast, outcome } = caseFile;
  const customerName = caseFile.customer.state === "ok" ? caseFile.customer.value.name : null;

  const chainSteps =
    caseFile.chain.state === "ok"
      ? caseFile.chain.value.rungs
        .filter((rung) => !rung.isCc)
        .map((rung) => ({ label: rung.stepName, order: rung.sequence, state: trackerState(rung) }))
      : [];

  // A SENTENCE, never a blank bar. Zero steps is legitimate for a draft, and an empty tracker reads
  // as broken rather than as "this has never been submitted".
  const trackerEmptyNote =
    caseFile.chain.state === "ok"
      ? chainSteps.length === 0
        ? "This request carries no gating approval steps — nobody is being asked to approve it."
        : null
      : caseFile.chain.reason;

  return (
    <section className="border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-4 sm:px-5">
        <p className="overflow-x-auto whitespace-nowrap text-[10px] font-black uppercase tracking-[0.18em] text-orange-600">
          Marketing Case File · {header.requestCode}
        </p>
        <h2 className="mt-1 overflow-x-auto whitespace-nowrap text-lg font-black tracking-tight text-slate-950">
          {customerName ?? "Customer not readable on this request"}
        </h2>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Chip label={STATUS_LABELS[header.status] ?? header.status} tone="dark" />
          <Chip
            label={LIFECYCLE_LABELS[header.lifecycleStage]}
            tone={
              header.lifecycleStage === "rejected"
                ? "rose"
                : header.lifecycleStage === "judged"
                  ? "emerald"
                  : header.lifecycleStage === "measuring"
                    ? "sky"
                    : "amber"
            }
          />
          {header.requestType ? <Chip label={header.requestType} /> : null}
        </div>
        <p className="mt-2.5 text-[13px] font-semibold leading-6 text-slate-700">{header.lifecycleSentence}</p>
      </div>

      <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-3 lg:grid-cols-5">
        <HeroStat label="Estimated cost" note="What this campaign commits" tone="orange" value={money(forecast.estimatedCost)} />
        <HeroStat
          label="Required return"
          note="What it must sell back"
          value={money(forecast.requiredRoiValue)}
        />
        <HeroStat
          label="Forecast coverage"
          note="Promised at submission, not a result"
          tone="slate"
          value={percent(forecast.forecastCoverageRatio)}
        />
        {outcome.state === "ok" ? (
          <>
            <HeroStat
              label="Attributed so far"
              note={`${units(outcome.value.actualSalesUnits)} units`}
              tone={outcome.value.resultStatus === "on_track" ? "emerald" : "slate"}
              value={money(outcome.value.actualSalesValue)}
            />
            <HeroStat
              label="Actual coverage"
              note={ROI_RESULT_STATUS_LABEL[outcome.value.resultStatus]}
              tone={outcome.value.resultStatus === "on_track" ? "emerald" : "rose"}
              value={percent(outcome.value.actualCoverageRatio)}
            />
          </>
        ) : (
          <>
            <HeroStat
              label="Attributed so far"
              note="Explained under What came back"
              tone={blockTone(outcome)}
              value={blockShorthand(outcome)}
            />
            <HeroStat
              label="Actual coverage"
              note="Explained under What came back"
              tone={blockTone(outcome)}
              value={blockShorthand(outcome)}
            />
          </>
        )}
      </div>

      <div className="border-t border-slate-200 px-4 py-3.5">
        <p className="mb-2 text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">Approval chain</p>
        <ApprovalTracker emptyNote={trackerEmptyNote} steps={chainSteps} />
      </div>
    </section>
  );
}

/**
 * The banner a `rejected` / `returned` / `draft` request leads with.
 *
 * The surface that does not exist today: a rejected request drops out of the requester's workspace
 * entirely, so who refused it, when, and why has never been readable anywhere in the product.
 */
function LeadSection({ caseFile }: { caseFile: MarketingRequestCaseFile }) {
  const { chain, header } = caseFile;

  if (header.status === "rejected" || header.lifecycleStage === "rejected") {
    const rung = chain.state === "ok" ? chain.value.rungs.find((row) => row.status === "rejected") ?? null : null;
    return (
      <LeadBanner headline="This request was refused" tone="rose">
        <p className="overflow-x-auto whitespace-nowrap text-[14px] font-black text-rose-950">
          {rung ? `Refused by ${rung.approverName || rung.assignedName}` : "Refused — the deciding approver could not be read"}
          {rung?.stepName ? ` at ${rung.stepName}` : ""}
        </p>
        <p className="text-[12px] font-bold text-rose-800">
          {cairoDateTime(rung?.decisionAt ?? header.decidedAt) ?? "No decision timestamp was recorded."}
        </p>
        <p className="text-[13px] font-semibold leading-6 text-rose-900">
          {rung?.decisionNote
            ? `Reason given: ${rung.decisionNote}`
            : chain.state === "ok"
              ? "No reason was written when this request was refused, so the record does not say why."
              : `The approval chain could not be read, so the reason cannot be shown. ${chain.reason}`}
        </p>
      </LeadBanner>
    );
  }

  if (header.status === "returned" || header.status === "draft") {
    const returnReason = chain.state === "ok" ? chain.value.returnReason : null;
    return (
      <LeadBanner
        headline={header.status === "draft" ? "This request is still a draft" : "This request was sent back"}
        tone="orange"
      >
        <p className="text-[13px] font-semibold leading-6 text-orange-900">
          {returnReason
            ? `Reason given: ${returnReason}`
            : header.status === "draft"
              ? "It has not been submitted, so no approver has seen it and no reason exists yet."
              : chain.state === "ok"
                ? "No reason was written when this request was returned, so the record does not say what to change."
                : `The approval chain could not be read, so the return reason cannot be shown. ${chain.reason}`}
        </p>
      </LeadBanner>
    );
  }

  return null;
}

/** 2. The ask, and whether it is worth it — products, forecast, and the six checks. */
function AskSection({ caseFile }: { caseFile: MarketingRequestCaseFile }) {
  const { money: forecast, products, warnings } = caseFile;

  return (
    <PanelSection subtitle="What is being asked for" title="The ask, and whether it is worth it">
      <FieldGroup title="Forecast made at submission">
        <Field label="Estimated cost" value={money(forecast.estimatedCost)} />
        <Field label="Expected return (forecast)" value={money(forecast.expectedRoiValue)} />
        <Field label="Required return" value={money(forecast.requiredRoiValue)} />
        <Field label="Forecast coverage" value={percent(forecast.forecastCoverageRatio)} />
        <Field label="ROI window" value={textOr(forecast.roiWindow, "No window yet — no pay date is set")} />
        <Field label="Measured over" value={`${forecast.roiDurationMonths} month${forecast.roiDurationMonths === 1 ? "" : "s"}`} />
      </FieldGroup>

      <div>
        <p className="mb-2 border-b border-slate-100 pb-1.5 text-[10px] font-black uppercase tracking-[0.16em] text-orange-600">
          Promoted products
        </p>
        <CaseFileBlockView block={products}>
          {(value) => (
            <div className="space-y-3">
              {value.confidentialWithheldCount > 0 ? (
                <p className="border border-sky-200 bg-sky-50 px-3 py-2 text-[12px] font-semibold leading-6 text-sky-900">
                  {value.confidentialWithheldCount} promoted product
                  {value.confidentialWithheldCount === 1 ? " is" : "s are"} confidential and withheld from you, so the
                  totals below cover only the products you may see.
                </p>
              ) : null}
              <div className="border border-slate-200">
                <PortalResponsiveDataList<MarketingCaseFileProduct>
                  empty={
                    <PortalEmptyState
                      message="No promoted product is recorded on this request, so there is nothing for its sales to be attributed to."
                      title="No products on this request"
                    />
                  }
                  getKey={(row) => String(row.productId)}
                  items={value.rows}
                  renderCard={(row) => (
                    <PortalRecordCard
                      accent="orange"
                      meta={row.line ?? "No line recorded"}
                      status={
                        <span className="whitespace-nowrap text-sm font-black text-slate-950">
                          {money(row.expectedValue)}
                        </span>
                      }
                      title={row.name}
                    >
                      <PortalRecordFields
                        fields={[
                          { label: "Forecast units", value: units(row.forecastQuantity) },
                          { label: "Factory price", value: money(row.factoryPrice) },
                          { label: "Share of value", value: percent(row.valueShare) },
                        ]}
                      />
                    </PortalRecordCard>
                  )}
                  renderTable={() => (
                    <PortalDesktopTable className="text-[13px]" minWidth="760px">
                      <thead className="bg-slate-900 text-[10px] font-black uppercase tracking-[0.12em] text-white">
                        <tr>
                          <th className="px-3 py-2.5">Product</th>
                          <th className="px-3 py-2.5">Line</th>
                          <th className="px-3 py-2.5 text-right">Forecast units</th>
                          <th className="px-3 py-2.5 text-right">Factory price</th>
                          <th className="px-3 py-2.5 text-right">Expected value</th>
                          <th className="px-3 py-2.5 text-right">Share of value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {value.rows.map((row) => (
                          <tr className="border-b border-slate-100 last:border-b-0" key={row.productId}>
                            <td className="max-w-[260px] px-3 py-2 font-bold text-slate-900">
                              <span className="block overflow-x-auto whitespace-nowrap">{row.name}</span>
                            </td>
                            <td className="px-3 py-2 font-semibold text-slate-600">
                              <span className="block overflow-x-auto whitespace-nowrap">
                                {row.line ?? <NotProvided what="No line recorded" />}
                              </span>
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 text-right font-semibold text-slate-900">{units(row.forecastQuantity)}</td>
                            <td className="whitespace-nowrap px-3 py-2 text-right font-semibold text-slate-900">{money(row.factoryPrice)}</td>
                            <td className="whitespace-nowrap px-3 py-2 text-right font-black text-slate-950">{money(row.expectedValue)}</td>
                            <td className="whitespace-nowrap px-3 py-2 text-right font-semibold text-slate-600">{percent(row.valueShare)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="border-t-2 border-slate-900 bg-slate-50 text-[12px] font-black text-slate-950">
                        <tr>
                          <td className="px-3 py-2" colSpan={2}>Total</td>
                          <td className="whitespace-nowrap px-3 py-2 text-right">{units(value.totalForecastUnits)}</td>
                          <td className="px-3 py-2" />
                          <td className="whitespace-nowrap px-3 py-2 text-right">{money(value.totalExpectedValue)}</td>
                          <td className="px-3 py-2" />
                        </tr>
                      </tfoot>
                    </PortalDesktopTable>
                  )}
                />
              </div>
            </div>
          )}
        </CaseFileBlockView>
      </div>

      <div>
        <p className="mb-2 border-b border-slate-100 pb-1.5 text-[10px] font-black uppercase tracking-[0.16em] text-orange-600">
          Checks · a check that could not run is never reported as clear
        </p>
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          {warnings.map((warning) => (
            <WarningRow key={warning.key} warning={warning} />
          ))}
        </div>
      </div>
    </PanelSection>
  );
}

/** 3. Who decided and what they said — every rung, every note, every timestamp. */
function ChainSection({ caseFile }: { caseFile: MarketingRequestCaseFile }) {
  return (
    <PanelSection subtitle="Who decided, and what they said" title="The approval chain">
      <CaseFileBlockView block={caseFile.chain}>
        {(chain) => (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <Chip label={`${chain.approvedGatingCount} of ${chain.totalGatingSteps} approvals given`} tone="dark" />
              {chain.currentStepName ? <Chip label={`Now at ${chain.currentStepName}`} tone="amber" /> : null}
              <Chip
                label={`${chain.rungs.filter((rung) => rung.isCc).length} advisory (CC) reviewer${
                  chain.rungs.filter((rung) => rung.isCc).length === 1 ? "" : "s"
                }`}
                tone="sky"
              />
            </div>
            <div className="border border-slate-200">
              <PortalResponsiveDataList<MarketingCaseFileChainRung>
                empty={
                  <PortalEmptyState
                    message="This request has no approval steps recorded, so nobody has been asked to decide it."
                    title="Nobody has been asked yet"
                  />
                }
                getKey={(rung, index) => `${rung.sequence}-${rung.isCc ? "cc" : "gate"}-${index}`}
                items={chain.rungs}
                renderCard={(rung) => (
                  <PortalRecordCard
                    accent={rung.isCc ? "sky" : rung.status === "rejected" ? "rose" : rung.isCurrent ? "amber" : "slate"}
                    meta={rung.assignedRole}
                    status={<Chip label={STEP_STATUS_LABELS[rung.status]} tone={rung.status === "approved" ? "emerald" : rung.status === "rejected" ? "rose" : rung.isCurrent ? "amber" : "slate"} />}
                    title={`${rung.isCc ? "CC · " : ""}${rung.stepName}`}
                  >
                    <PortalRecordFields
                      fields={[
                        { label: "Assigned to", value: textOr(rung.assignedName, "Nobody is assigned") },
                        { label: "Decided by", value: textOr(rung.approverName, "Not decided yet") },
                        { label: "Decided at", value: cairoDateTime(rung.decisionAt) ?? "Not decided yet" },
                        { label: "Note", value: rung.decisionNote ?? "No note was written." },
                      ]}
                    />
                  </PortalRecordCard>
                )}
                renderTable={() => (
                  <PortalDesktopTable className="text-[13px]" minWidth="900px">
                    <thead className="bg-slate-900 text-[10px] font-black uppercase tracking-[0.12em] text-white">
                      <tr>
                        <th className="px-3 py-2.5">Step</th>
                        <th className="px-3 py-2.5">Assigned to</th>
                        <th className="px-3 py-2.5">Role</th>
                        <th className="px-3 py-2.5">Outcome</th>
                        <th className="px-3 py-2.5">Decided by</th>
                        <th className="px-3 py-2.5">Decided at (Cairo)</th>
                        <th className="px-3 py-2.5">Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {chain.rungs.map((rung, index) => (
                        <tr
                          className={`border-b border-slate-100 last:border-b-0 ${
                            rung.isCc
                              ? "border-l-4 border-l-sky-400 bg-sky-50/50"
                              : rung.isCurrent
                                ? "border-l-4 border-l-amber-400 bg-amber-50/40"
                                : "border-l-4 border-l-transparent"
                          }`}
                          key={`${rung.sequence}-${rung.isCc ? "cc" : "gate"}-${index}`}
                        >
                          <td className="px-3 py-2 font-bold text-slate-900">
                            <span className="flex items-center gap-1.5 overflow-x-auto whitespace-nowrap">
                              {rung.isCc ? <Chip label="CC · advisory" tone="sky" /> : null}
                              {rung.stepName}
                              {rung.isMine ? <Chip label="This one is yours" tone="orange" /> : null}
                            </span>
                          </td>
                          <td className="px-3 py-2 font-semibold text-slate-800">
                            <span className="block overflow-x-auto whitespace-nowrap">
                              {textOr(rung.assignedName, "Nobody is assigned")}
                            </span>
                          </td>
                          <td className="px-3 py-2 font-semibold text-slate-600">
                            <span className="block overflow-x-auto whitespace-nowrap">{textOr(rung.assignedRole)}</span>
                          </td>
                          <td className="whitespace-nowrap px-3 py-2">
                            <Chip
                              label={STEP_STATUS_LABELS[rung.status]}
                              tone={
                                rung.status === "approved"
                                  ? "emerald"
                                  : rung.status === "rejected"
                                    ? "rose"
                                    : rung.status === "returned"
                                      ? "orange"
                                      : rung.isCurrent
                                        ? "amber"
                                        : "slate"
                              }
                            />
                          </td>
                          <td className="px-3 py-2 font-semibold text-slate-800">
                            <span className="block overflow-x-auto whitespace-nowrap">
                              {textOr(rung.approverName, "Not decided yet")}
                            </span>
                          </td>
                          <td className="px-3 py-2 font-semibold text-slate-600">
                            <span className="block overflow-x-auto whitespace-nowrap">
                              {cairoDateTime(rung.decisionAt) ?? <NotProvided what="Not decided yet" />}
                            </span>
                          </td>
                          <td className="max-w-[320px] px-3 py-2 font-medium text-slate-700">
                            <span className="block overflow-x-auto whitespace-nowrap">
                              {rung.decisionNote ?? <NotProvided what="No note was written" />}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </PortalDesktopTable>
                )}
              />
            </div>
            <p className="text-[11px] font-semibold leading-5 text-slate-500">
              Advisory (CC) rows are kept and marked. An advisory comment is not an approval and never counts as one
              more yes — but &ldquo;the Product Manager was asked and said nothing&rdquo; is a fact about this decision,
              and dropping the row would delete it.
            </p>
          </div>
        )}
      </CaseFileBlockView>
    </PanelSection>
  );
}

/** 4. Where the money is pointed — the requester, the customer, and the target pharmacies. */
function PointedAtSection({ caseFile }: { caseFile: MarketingRequestCaseFile }) {
  const { header, targetPharmacies } = caseFile;
  const requester = header.requester;

  return (
    <PanelSection subtitle="Where the money is pointed" title="Requester, customer, and targets">
      {/*
        The requester's own org context, in the REQUESTER's own group. On the approval screen "Area"
        and "Line" sit under the Customer heading while carrying the requester's values, so an
        approver reading "Area: Giza" believes it describes the customer. It never did.
      */}
      <FieldTable
        rows={[
          { label: "Name", value: textOr(requester.name) },
          { label: "HR ID", value: textOr(requester.hrId) },
          { label: "Role", value: textOr(requester.role, "No role on file") },
          { label: "Their line", value: textOr(requester.lineName, "No line on file") },
          { label: "Their area", value: textOr(requester.areaName, "No area on file") },
          { label: "Their region", value: textOr(requester.regionName, "No region on file") },
        ]}
        title="The requester — this is the requester's own geography, not the customer's"
      />

      <CaseFileBlockView block={caseFile.customer}>
        {(customer) => (
          <div className="space-y-3">
            <FieldTable
              rows={[
                { label: "Customer name", value: textOr(customer.name, "No customer name on file") },
                { label: "Customer code", value: textOr(customer.code, "No code on file") },
                { label: "Customer type", value: textOr(customer.type, "No type on file") },
                { label: "Speciality", value: textOr(customer.speciality, "No speciality on file") },
                {
                  label: "Validation",
                  value: (
                    <span className="flex items-center gap-2">
                      <Chip
                        label={VALIDATION_LABELS[customer.validation.status] ?? customer.validation.status}
                        tone={
                          customer.validation.status === "sfe_validated" || customer.validation.status === "system_validated"
                            ? "emerald"
                            : customer.validation.status === "rejected"
                              ? "rose"
                              : "amber"
                        }
                      />
                      <span className="font-semibold text-slate-700">{customer.validation.sentence}</span>
                    </span>
                  ),
                },
                {
                  label: "Validated by",
                  value: customer.validation.validatedByName
                    ? `${customer.validation.validatedByName}${
                      cairoDate(customer.validation.validatedAt) ? ` on ${cairoDate(customer.validation.validatedAt)}` : ""
                    }`
                    : <NotProvided what="Nobody has validated this customer" />,
                },
                { label: "Area on the customer record", value: textOr(customer.location.extractedAreaName, "No area was extracted from the captured address") },
                { label: "Governorate on the customer record", value: textOr(customer.location.extractedGovernorateName, "No governorate was extracted from the captured address") },
              ]}
              title="The customer this campaign is aimed at"
            />

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
              <div>
                <p className="mb-1.5 text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">Captured address</p>
                <CaseFileBlockView block={customer.location.capturedAddress}>
                  {(address) => (
                    <p className="overflow-x-auto whitespace-nowrap border border-slate-200 bg-slate-50 px-3 py-2 text-[13px] font-semibold text-slate-800">
                      {address ?? <NotProvided what="No address was captured on the doorstep" />}
                    </p>
                  )}
                </CaseFileBlockView>
              </div>
              <div>
                <p className="mb-1.5 text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">Contact</p>
                <CaseFileBlockView block={customer.contact}>
                  {(contact) => (
                    <p className="overflow-x-auto whitespace-nowrap border border-slate-200 bg-slate-50 px-3 py-2 text-[13px] font-semibold text-slate-800">
                      {contact.name || contact.mobile
                        ? `${contact.name ?? "Name not recorded"} · ${contact.mobile ?? "No mobile recorded"}`
                        : <NotProvided what="No contact person was recorded" />}
                    </p>
                  )}
                </CaseFileBlockView>
              </div>
              <div>
                <p className="mb-1.5 text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">Evidence photo</p>
                <CaseFileBlockView block={customer.evidencePhoto}>
                  {(photo) => (
                    <p className="border border-slate-200 bg-slate-50 px-3 py-2 text-[13px] font-semibold leading-6 text-slate-800">
                      {photo.url ? (
                        <a className="font-black text-orange-700 underline" href={photo.url} rel="noreferrer" target="_blank">
                          Open the captured frame
                          {cairoDate(photo.capturedAt) ? ` (captured ${cairoDate(photo.capturedAt)})` : ""}
                        </a>
                      ) : photo.fileName ? (
                        // A filename on its own is NOT proof: for every customer created before
                        // 2026-08-04 the bytes were discarded in the browser and only the string kept.
                        <span className="text-amber-800">
                          A filename was recorded ({photo.fileName}) but the image itself was never stored, so there is
                          no photograph to inspect.
                        </span>
                      ) : (
                        <NotProvided what="No evidence photo was captured" />
                      )}
                    </p>
                  )}
                </CaseFileBlockView>
              </div>
            </div>
          </div>
        )}
      </CaseFileBlockView>

      <div>
        <p className="mb-2 border-b border-slate-100 pb-1.5 text-[10px] font-black uppercase tracking-[0.16em] text-orange-600">
          Target pharmacies — where sales are looked for
        </p>
        <CaseFileBlockView block={targetPharmacies}>
          {(targets) => (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip label={`${targets.rows.length} target pharmac${targets.rows.length === 1 ? "y" : "ies"}`} tone="dark" />
                <Chip
                  label={`${targets.suspectCount} code${targets.suspectCount === 1 ? "" : "s"} not confirmed`}
                  tone={targets.suspectCount > 0 ? "orange" : "emerald"}
                />
                <Chip
                  label={`${targets.unvalidatedCount} never validated`}
                  tone={targets.unvalidatedCount > 0 ? "amber" : "emerald"}
                />
              </div>
              <div className="border border-slate-200">
                <PortalResponsiveDataList<MarketingCaseFileTargetPharmacy>
                  empty={
                    <PortalEmptyState
                      message="This request has no target pharmacies at all. Nothing can ever be attributed to it, so its measured ROI is permanently zero however the campaign actually performs."
                      title="No target pharmacies"
                    />
                  }
                  getKey={(row, index) => `${row.pharmacyCode}-${row.distributorPharmacyCode}-${index}`}
                  items={targets.rows}
                  renderCard={(row) => (
                    <PortalRecordCard
                      accent={row.suspect ? "amber" : "emerald"}
                      meta={row.distributorName}
                      status={
                        <Chip
                          label={REFERENCE_STATUS_LABELS[row.referenceStatus]}
                          tone={row.suspect ? "amber" : "emerald"}
                        />
                      }
                      title={row.pharmacyName}
                    >
                      <PortalRecordFields
                        fields={[
                          { label: "Distributor code", value: textOr(row.distributorPharmacyCode, "No code on file") },
                          {
                            label: "Pharmacy validation",
                            value: row.validationStatus ? VALIDATION_LABELS[row.validationStatus] : "Never validated",
                          },
                          { label: "What that means", value: row.referenceStatusSentence },
                          { label: "Notes", value: row.notes ?? "No note was written." },
                        ]}
                      />
                    </PortalRecordCard>
                  )}
                  renderTable={() => (
                    <PortalDesktopTable className="text-[13px]" minWidth="980px">
                      <thead className="bg-slate-900 text-[10px] font-black uppercase tracking-[0.12em] text-white">
                        <tr>
                          <th className="px-3 py-2.5">Pharmacy</th>
                          <th className="px-3 py-2.5">Distributor</th>
                          <th className="px-3 py-2.5">Distributor code</th>
                          <th className="px-3 py-2.5">Code status</th>
                          <th className="px-3 py-2.5">What that means</th>
                          <th className="px-3 py-2.5">Pharmacy validation</th>
                        </tr>
                      </thead>
                      <tbody>
                        {targets.rows.map((row, index) => (
                          <tr
                            className={`border-b border-slate-100 last:border-b-0 ${
                              row.suspect ? "border-l-4 border-l-amber-400 bg-amber-50/40" : "border-l-4 border-l-transparent"
                            }`}
                            key={`${row.pharmacyCode}-${row.distributorPharmacyCode}-${index}`}
                          >
                            <td className="max-w-[240px] px-3 py-2 font-bold text-slate-900">
                              <span className="block overflow-x-auto whitespace-nowrap">{textOr(row.pharmacyName, "No pharmacy name on file")}</span>
                            </td>
                            <td className="px-3 py-2 font-semibold text-slate-700">
                              <span className="block overflow-x-auto whitespace-nowrap">{textOr(row.distributorName, "No distributor on file")}</span>
                            </td>
                            <td className="px-3 py-2 font-semibold text-slate-700">
                              <span className="block overflow-x-auto whitespace-nowrap">{textOr(row.distributorPharmacyCode, "No code on file")}</span>
                            </td>
                            <td className="whitespace-nowrap px-3 py-2">
                              <Chip
                                label={REFERENCE_STATUS_LABELS[row.referenceStatus]}
                                tone={row.suspect ? "amber" : "emerald"}
                              />
                            </td>
                            <td className="max-w-[320px] px-3 py-2 font-medium text-slate-700">
                              <span className="block overflow-x-auto whitespace-nowrap">{row.referenceStatusSentence}</span>
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 font-semibold text-slate-700">
                              {row.validationStatus ? (
                                VALIDATION_LABELS[row.validationStatus]
                              ) : (
                                <NotProvided what="Never validated" />
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </PortalDesktopTable>
                  )}
                />
              </div>
            </div>
          )}
        </CaseFileBlockView>
      </div>

      <div>
        <p className="mb-2 border-b border-slate-100 pb-1.5 text-[10px] font-black uppercase tracking-[0.16em] text-orange-600">
          Spend at this customer before this request
        </p>
        <CaseFileBlockView block={caseFile.money.spentBefore}>
          {(spent) => (
            <div className="space-y-2">
              <p className="text-[13px] font-semibold leading-6 text-slate-700">
                {spent.isFirstRequest
                  ? "This is the first committed request ever raised for this customer — nothing has been spent here before."
                  : `${money(spent.total)} has been committed at this customer across ${spent.requests.length} earlier request${
                    spent.requests.length === 1 ? "" : "s"
                  }. Drafts and refused requests are excluded, because neither is money that left the company.`}
              </p>
              <p className="text-[12px] font-semibold text-slate-500">
                {spent.priorRealisedSales === null
                  ? "None of those earlier requests has a calculated return yet, so there is no realized figure to compare against."
                  : `${money(spent.priorRealisedSales)} has been realized against them so far.`}
              </p>
            </div>
          )}
        </CaseFileBlockView>
      </div>
    </PanelSection>
  );
}

/** 5. What came back — the realized outcome and how far the data actually reaches. */
function OutcomeSection({ caseFile }: { caseFile: MarketingRequestCaseFile }) {
  return (
    <PanelSection subtitle="What came back" title="Realized return">
      <CaseFileBlockView block={caseFile.outcome}>
        {(outcome) => (
          <div className="space-y-3">
            <p className="text-[13.5px] font-bold leading-6 text-slate-900">{outcome.resultSentence}</p>
            <FieldGroup title="The measured figures">
              <Field label="Verdict" value={ROI_RESULT_STATUS_LABEL[outcome.resultStatus]} />
              <Field label="Attributed value" value={money(outcome.actualSalesValue)} />
              <Field label="Attributed units" value={units(outcome.actualSalesUnits)} />
              <Field label="Required return" value={money(outcome.requiredRoiValue)} />
              <Field label="Actual coverage" value={percent(outcome.actualCoverageRatio)} />
              <Field label="ROI window" value={textOr(outcome.roiWindow, "No window recorded")} />
            </FieldGroup>
            <FieldTable
              rows={[
                { label: "Data coverage", value: ROI_DATA_COVERAGE_LABEL[outcome.dataCoverage] },
                {
                  label: "Validated sales reach",
                  value: textOr(outcome.salesDataAsOf, "No validated Source-of-Sales month is loaded"),
                },
                { label: "Window opens", value: textOr(outcome.windowStart, "No window — no pay date is set") },
                { label: "Window closes", value: textOr(outcome.windowEnd, "No window — no pay date is set") },
                {
                  label: "Why nothing attributed",
                  value: outcome.attributionGapReason ?? <NotProvided what="Sales did attribute — there is no gap to explain" />,
                },
              ]}
              title="How far the data actually reaches"
            />
            <div>
              <p className="mb-1.5 text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
                How much the FIGURE can be trusted — not how the campaign performed
              </p>
              <CaseFileBlockView block={outcome.confidence}>
                {(confidence) => (
                  <div className="space-y-2 border border-slate-200 bg-slate-50 px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Chip
                        label={CONFIDENCE_BAND_LABELS[confidence.band]}
                        tone={confidence.band === "high" ? "emerald" : confidence.band === "medium" ? "amber" : "rose"}
                      />
                      <Chip label={`${Math.round(confidence.score)} out of 100`} tone="dark" />
                    </div>
                    <p className="text-[12.5px] font-semibold leading-6 text-slate-700">
                      {confidence.weakest
                        ? `Weakest factor — ${confidence.weakest.label}: ${confidence.weakest.detail}`
                        : "Nothing is holding this score back."}
                    </p>
                  </div>
                )}
              </CaseFileBlockView>
            </div>
          </div>
        )}
      </CaseFileBlockView>
    </PanelSection>
  );
}

/** 6. Raw record — last, deliberately. Decision-critical facts come first. */
function RawRecordSection({ caseFile }: { caseFile: MarketingRequestCaseFile }) {
  const { header, lazySections, viewer } = caseFile;

  return (
    <PanelSection subtitle="Timestamps, identifiers, and what you are admitted as" title="The raw record">
      <FieldTable
        rows={[
          { label: "Request code", value: header.requestCode },
          { label: "Request type", value: textOr(header.requestType, "No request type on file") },
          { label: "Origin", value: ORIGIN_LABELS[header.origin] ?? header.origin },
          { label: "Status", value: STATUS_LABELS[header.status] ?? header.status },
          { label: "Raised on", value: dateOr(header.requestDate, "No request date on file") },
          { label: "Submitted", value: cairoDateTime(header.submittedAt) ?? <NotProvided what="Never submitted" /> },
          { label: "Decided", value: cairoDateTime(header.decidedAt) ?? <NotProvided what="No decision has been recorded" /> },
          { label: "Pay date", value: dateOr(header.payDate, "No pay date is set, so the ROI window has never opened") },
          { label: "Closed", value: cairoDateTime(header.closedAt) ?? <NotProvided what="Not closed" /> },
          { label: "Read at", value: cairoDateTime(caseFile.generatedAt) ?? "Unknown" },
          { label: "Internal request id", value: header.requestId },
        ]}
        title="Identifiers and timestamps"
      />

      <FieldTable
        rows={[
          { label: "You are reading this as", value: viewer.admittedAs.map((arm) => ADMISSION_LABELS[arm] ?? arm).join(" · ") },
          {
            label: "Customer personal data",
            value: viewer.canSeeCustomerPii
              ? "Shown to you — you have a stake in this request."
              : "Withheld from you: your claim is on the promoted products, not on the customer's doorstep.",
          },
          {
            label: "Confidential products",
            value: viewer.canSeeConfidentialProducts
              ? "Shown to you."
              : "Any confidential promoted product is withheld from you and announced above rather than silently dropped.",
          },
        ]}
        title="Why you can see this"
      />

      <div>
        <p className="mb-2 border-b border-slate-100 pb-1.5 text-[10px] font-black uppercase tracking-[0.16em] text-orange-600">
          Deliberately not loaded here
        </p>
        <div className="space-y-1.5">
          {lazySections.map((section) => (
            <p className="text-[12px] font-semibold leading-6 text-slate-600" key={section.key}>
              <span className="font-black text-slate-900">{section.label}</span>
              {" — "}
              {section.reason}
              {section.available ? "" : " You are not admitted to this one."}
            </p>
          ))}
        </div>
      </div>
    </PanelSection>
  );
}

/* ------------------------------------------------------------------------- */
/* The screen                                                                 */
/* ------------------------------------------------------------------------- */

export function MarketingRequestCaseFile({ requestId }: { requestId: string }) {
  const [caseFile, setCaseFile] = useState<MarketingRequestCaseFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Same shape as the sibling per-request fetchers (marketing-request-approver-detail): an inline
  // async IIFE guarded by `cancelled`, never a useCallback the effect then invokes — the latter
  // trips react-hooks/set-state-in-effect, because the rule sees setState reachable directly from
  // the effect body.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/marketing-requests/${encodeURIComponent(requestId)}/case-file`, {
          cache: "no-store",
        });
        const payload = await response.json();
        if (cancelled) return;
        if (!response.ok || !payload?.caseFile) {
          setError(
            typeof payload?.message === "string"
              ? payload.message
              : "This request's case file could not be loaded, so nothing about it is being shown rather than a partial picture.",
          );
        } else {
          setCaseFile(payload.caseFile as MarketingRequestCaseFile);
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setError("This request's case file could not be loaded — the request to the server did not complete.");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requestId]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 border border-slate-200 bg-white px-4 py-8 text-[13px] font-semibold text-slate-600">
        <LoadingSpinner /> Loading this request&rsquo;s case file&hellip;
      </div>
    );
  }

  if (error || !caseFile) {
    // Itself a three-state rule: a screen that could not read its own subject says so in a sentence
    // rather than rendering an empty, healthy-looking page.
    return <BlockNotice reason={error ?? "No case file was returned for this request."} state="unavailable" />;
  }

  const stage = caseFile.header.lifecycleStage;

  // The order varies by lifecycle stage, because what a reader needs first varies. A rejected
  // request leads with the refusal; a request being measured leads with what has come back.
  const sections =
    stage === "rejected"
      ? (["chain", "ask", "pointed", "outcome"] as const)
      : stage === "measuring" || stage === "judged"
        ? (["outcome", "ask", "chain", "pointed"] as const)
        : (["ask", "chain", "pointed", "outcome"] as const);

  const render = {
    ask: <AskSection caseFile={caseFile} key="ask" />,
    chain: <ChainSection caseFile={caseFile} key="chain" />,
    outcome: <OutcomeSection caseFile={caseFile} key="outcome" />,
    pointed: <PointedAtSection caseFile={caseFile} key="pointed" />,
  };

  return (
    <WorkspaceErrorBoundary fallbackTitle="Marketing case file error">
      <div className="space-y-4" dir="auto">
        <HeaderSection caseFile={caseFile} />
        <LeadSection caseFile={caseFile} />
        {sections.map((key) => render[key])}
        <RawRecordSection caseFile={caseFile} />
      </div>
    </WorkspaceErrorBoundary>
  );
}
