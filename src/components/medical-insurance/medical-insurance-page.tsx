"use client";

import { AlertTriangle, HeartPulse, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import { AdminCallout, AdminPageHero } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { formatLeftDay } from "@/lib/employees/left-flag";
import { egpWords, monthWords, type MedicalInsuranceMoneyView, type MedicalInsuranceView } from "@/lib/medical-insurance/view";
import { cn } from "@/lib/utils";

import { MedicalInsuranceActionsTab } from "./medical-insurance-actions";
import { MedicalInsuranceCostTab } from "./medical-insurance-cost";
import { MedicalInsuranceDocumentsTab } from "./medical-insurance-documents";
import { MedicalInsuranceMembersTab } from "./medical-insurance-members";

type TabId = "actions" | "cost" | "documents" | "members" | "overview";

type Props = {
  canCreate: boolean;
  canEdit: boolean;
  canExport: boolean;
  error: string | null;
  money: MedicalInsuranceMoneyView | null;
  view: MedicalInsuranceView | null;
};

/**
 * THE GROUP MEDICAL POLICY, END TO END (owner, 2026-11-04). Who should be in, who should be out, what it
 * should cost, what the insurer billed against that, and the papers and emails behind it. It sends nothing
 * and pays nothing: the form goes to the insurer by a person's hand, and a difference is a person's to act on.
 */
export function MedicalInsurancePage({ canCreate, canEdit, canExport, error, money, view }: Props) {
  const router = useRouter();
  const [tab, setTab] = React.useState<TabId>("overview");

  const toAct = view ? view.counts.addNow + view.counts.removeNow + view.counts.review : 0;
  const tabs: Array<{ id: TabId; label: string; note: string }> = view
    ? [
        { id: "overview", label: "Overview", note: `${view.counts.covered} people covered` },
        { id: "actions", label: "Add or remove", note: toAct === 1 ? "1 to act on now" : `${toAct} to act on now` },
        { id: "members", label: "Members", note: `${view.members.length} on the register` },
        ...(money ? [{ id: "cost" as const, label: "Cost and invoices", note: egpWords(money.plan.statement.total) }] : []),
        { id: "documents", label: "Documents", note: `${view.documents.length + (money?.documents.length ?? 0)} on file` },
      ]
    : [];

  return (
    <div className="space-y-5">
      <AdminPageHero
        actions={
          <Button className="h-10 gap-2" onClick={() => router.refresh()} variant="secondary">
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        }
        description={
          view
            ? `${view.policy.insurer} policy ${view.policy.policyNumber}, ${formatLeftDay(view.policy.startsOn)} to ${formatLeftDay(view.policy.endsOn)}.`
            : "Who should be on the group medical policy, and who should not."
        }
        eyebrow="People Operations"
        icon={<HeartPulse className="h-3.5 w-3.5" />}
        title="Medical Insurance"
      />

      {error ? (
        <AdminCallout tone="danger">
          <AlertTriangle className="mt-0.5 h-5 w-5 text-[#B91C1C]" />
          <div>
            <h2 className="text-sm font-bold text-[#B91C1C]">Medical insurance could not be read</h2>
            <p className="mt-1 text-sm text-[#991B1B]">{error}</p>
          </div>
        </AdminCallout>
      ) : null}

      {!view && !error ? (
        <AdminCallout>
          <p className="text-sm font-semibold">No medical insurance policy has been set up yet.</p>
        </AdminCallout>
      ) : null}

      {view ? (
        <>
          <div className={cn("grid grid-cols-2 gap-px border border-phx-line bg-phx-line", money ? "lg:grid-cols-5" : "lg:grid-cols-4")} role="tablist">
            {tabs.map(({ id, label, note }) => (
              <button
                aria-selected={tab === id}
                className={cn("border-b-2 border-transparent bg-white px-4 py-3 text-left hover:bg-phx-accent-soft", tab === id && "border-phx-accent bg-phx-accent-soft")}
                key={id}
                onClick={() => setTab(id)}
                role="tab"
                type="button"
              >
                <span className="block break-words text-phx-2xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">{label}</span>
                <span className="mt-1 block break-words text-phx-xs font-semibold text-phx-ink-soft">{note}</span>
              </button>
            ))}
          </div>

          {tab === "overview" ? <Overview money={money} onOpenActions={() => setTab("actions")} view={view} /> : null}
          {tab === "actions" ? <MedicalInsuranceActionsTab canCreate={canCreate} canEdit={canEdit} canExport={canExport} view={view} /> : null}
          {tab === "members" ? <MedicalInsuranceMembersTab canCreate={canCreate} canEdit={canEdit} canExport={canExport} view={view} /> : null}
          {tab === "cost" && money ? <MedicalInsuranceCostTab money={money} /> : null}
          {tab === "documents" ? <MedicalInsuranceDocumentsTab canEdit={canEdit} money={money} view={view} /> : null}
        </>
      ) : null}
    </div>
  );
}

function Figure({ label, note, value }: { label: string; note: string; value: string }) {
  return (
    <div className="bg-white px-4 py-3">
      <span className="block break-words text-phx-2xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">{label}</span>
      <span className="mt-1 block break-words text-2xl font-black tabular-nums text-phx-ink">{value}</span>
      <span className="mt-0.5 block break-words text-phx-xs font-semibold text-phx-ink-soft">{note}</span>
    </div>
  );
}

function Overview({ money, onOpenActions, view }: { money: MedicalInsuranceMoneyView | null; onOpenActions: () => void; view: MedicalInsuranceView }) {
  const { counts, policy } = view;
  const latest = money?.invoices[0] ?? null;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-px border border-phx-line bg-phx-line lg:grid-cols-5">
        <Figure label="Covered" note={`${counts.coveredEmployees} employees, ${counts.coveredFamily} family`} value={String(counts.covered)} />
        <Figure label="To add" note={counts.addSoon ? `${counts.addSoon} more in the next 30 days` : "Should be on, and are not"} value={String(counts.addNow)} />
        <Figure label="To remove" note={counts.removeSoon ? `${counts.removeSoon} more in the next 30 days` : "Should be off, and are not"} value={String(counts.removeNow)} />
        <Figure label="To check" note="No Phoenix employee record" value={String(counts.review)} />
        <Figure label="Exceptions" note="Kept on or off by decision" value={String(counts.exceptions)} />
      </div>

      {counts.addNow + counts.removeNow + counts.review > 0 ? (
        <AdminCallout tone="warning">
          <div>
            <p className="text-sm font-bold">The register and the rule disagree on {counts.addNow + counts.removeNow + counts.review} people today.</p>
            <Button className="mt-3 h-9" onClick={onOpenActions} variant="secondary">See who</Button>
          </div>
        </AdminCallout>
      ) : null}

      {money ? (
        <div className="grid grid-cols-1 gap-px border border-phx-line bg-phx-line md:grid-cols-3">
          <Figure label="Should cost this period" note={`${formatLeftDay(money.period.start)} to ${formatLeftDay(money.period.end)}`} value={egpWords(money.plan.statement.total)} />
          <Figure label="Should cost this year" note="Every period, as the people stand today" value={egpWords(money.yearEstimate)} />
          {latest ? (
            <Figure
              label="Latest invoice against plan"
              note={`Bill ${latest.billNumber}, ${egpWords(latest.totalDue)}`}
              value={`${latest.comparison.difference > 0 ? "+" : ""}${egpWords(latest.comparison.difference)}`}
            />
          ) : (
            <Figure label="Latest invoice against plan" note="Upload it under Cost and invoices" value="None yet" />
          )}
        </div>
      ) : null}

      <div className="border border-phx-line bg-white p-4">
        <h2 className="text-sm font-black text-phx-ink">Who came on and went off</h2>
        {view.movements.length === 0 ? (
          <p className="mt-2 text-sm font-semibold text-phx-ink-soft">Nobody has joined or left the register since {formatLeftDay(policy.startsOn)}.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {view.movements.map((movement) => (
              <li className="border-t border-phx-line pt-3" key={movement.month}>
                <p className="text-sm font-black text-phx-ink">{monthWords(movement.month)}</p>
                {movement.joined.length > 0 ? (
                  <p className="mt-1 break-words text-phx-xs font-semibold text-phx-ink-soft" dir="auto">
                    On: {movement.joined.map((row) => `${row.name} (${formatLeftDay(row.day)})`).join(", ")}
                  </p>
                ) : null}
                {movement.left.length > 0 ? (
                  <p className="mt-1 break-words text-phx-xs font-semibold text-phx-ink-soft" dir="auto">
                    Off: {movement.left.map((row) => `${row.name} (${formatLeftDay(row.day)})`).join(", ")}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
