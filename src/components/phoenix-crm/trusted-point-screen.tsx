"use client";

/**
 * Phoenix CRM — validating a customer on a TRUSTED POINT: the Super Admin's screen alone, never the rep's.
 *
 * Owner, 2026-11-10: "we will search all locations for this customer in phx crm, then we will compare with
 * the locations of checkins of this customer from the old crm until we find a trusted point or trusted
 * average location... based on this location we will extract the brick, area and all what we need." Built
 * for a doctor with no signboard, whom no rep can validate at the door.
 *
 * It shows what the server read — the point, how many readings agree of how many, on how many days, by how
 * many reps, how tightly, and the brick and area the point falls in — and one button. When the readings do
 * not agree it shows why, and no button. The server computes the point again on the save; nothing on this
 * screen is sent but the customer. The customer's page offers it only where `view.canPlaceOnTrustedPoint`,
 * this screen refuses to draw for anyone else, and the server refuses everyone but the Super Admin
 * (server/trusted-point.ts). Golden rule #1: the rep never sees any of it.
 */

import { useState } from "react";

import { crmPost, crmUrl, messageOf, useCrmGet } from "@/components/phoenix-crm/api";
import { customerMetaText } from "@/components/phoenix-crm/labels";
import { ListGone, type ListNotice, type ListScreenBase } from "@/components/phoenix-crm/list-screens";
import { CrmBackBar, CrmBlock, CrmButton, CrmFacts, CrmLoading, CrmNote, CrmPanel } from "@/components/phoenix-crm/ui";
import { formatDistance } from "@/lib/phoenix-crm/geo";
import type { TrustedPointApplied, TrustedPointPreview } from "@/lib/phoenix-crm/view-types";

const GONE_NOT_ADMIN = "Only the Super Admin validates a customer on a trusted point.";
const TITLE = "Validate on a trusted point";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function TrustedPointScreen(
  props: ListScreenBase & {
    customerId: string;
    onBack: () => void;
    onDone: (notice: ListNotice) => void;
  },
) {
  const { onBack, refreshing, view } = props;
  if (!view.canPlaceOnTrustedPoint) {
    return <ListGone backLabel="Customer" message={GONE_NOT_ADMIN} onBack={onBack} refreshing={refreshing} title={TITLE} />;
  }
  return <TrustedPointForm {...props} />;
}

function TrustedPointForm({
  customerId,
  onBack,
  onDone,
  reload,
  view,
}: ListScreenBase & {
  customerId: string;
  onBack: () => void;
  onDone: (notice: ListNotice) => void;
}) {
  const customer = view.customers.find((entry) => entry.customerId === customerId) ?? null;
  const preview = useCrmGet<TrustedPointPreview>(crmUrl("/api/phoenix-crm/list/places/trusted-point", { customerId }), "preview");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const data = preview.data;
  const result = data?.result ?? null;

  async function save() {
    if (saving || !data?.canApply) return;
    setSaving(true);
    setProblem(null);
    try {
      const applied = await crmPost<TrustedPointApplied>("/api/phoenix-crm/list/places/trusted-point", { customerId }, "applied");
      const where = [applied.preview.location?.brickName ? `Brick ${applied.preview.location.brickName}` : null, applied.preview.location?.areaName]
        .filter((part): part is string => Boolean(part))
        .join(" · ");
      onDone({
        tone: "good",
        title: `Validated on a trusted point: ${data.customerName}`,
        message: `${where ? `${where}. ` : ""}Visits to this customer are measured from this point from now on, and the decision is kept on record.`,
      });
    } catch (error) {
      setProblem(messageOf(error));
      setSaving(false);
      reload();
    }
  }

  const facts =
    data && result?.trusted
      ? [
          { label: "Point", value: `${result.lat.toFixed(6)}, ${result.lon.toFixed(6)}` },
          { label: "Readings that agree", value: `${result.readings} of ${result.of} · within ${data.rule.coreMeters} m` },
          { label: "Where they came from", value: `${plural(result.sources.phoenix, "Phoenix reading", "Phoenix readings")} · ${plural(result.sources.old_crm, "old CRM check-in", "old CRM check-ins")}` },
          { label: "Days", value: `${plural(result.days, "day", "different days")} · ${result.firstDay} to ${result.lastDay}` },
          { label: "Reps", value: plural(result.reps, "rep", "reps") },
          { label: "Spread", value: `median ${formatDistance(result.medianSpreadMeters)} · widest ${formatDistance(result.maxSpreadMeters)}` },
          { label: "Brick", value: data.location?.brickName ?? "No Phoenix brick near this point" },
          { label: "Area", value: [data.location?.areaName, data.location?.regionName].filter(Boolean).join(" · ") || "Not resolved" },
          { label: "Address", value: data.location?.address ?? "No address read" },
        ]
      : [];

  return (
    <CrmPanel>
      <CrmBackBar backLabel="Customer" onBack={onBack} title={TITLE} />
      <CrmBlock>
        <p className="break-words text-base font-black text-slate-950" dir="auto">
          {customer?.name ?? data?.customerName ?? "Customer"}
        </p>
        {customer ? <p className="mt-0.5 break-words text-xs font-semibold text-slate-500">{customerMetaText(customer)}</p> : null}
        <CrmNote className="mt-3" tone="info">
          Phoenix reads every location recorded for this customer — the reps&apos; Phoenix visits, every place ever captured for them, and the old
          CRM&apos;s check-ins — and looks for one point most of them agree on. The brick, area and region are read from that point, exactly as for a
          place validated at the door.
        </CrmNote>
      </CrmBlock>

      <CrmBlock className="border-t border-slate-100" title="What the readings say">
        {preview.error ? (
          <CrmNote tone="bad">{preview.error}</CrmNote>
        ) : !data ? (
          <CrmLoading label="Reading this customer's locations" />
        ) : result && !result.trusted ? (
          <CrmNote title="No trusted point" tone="warn">
            {result.reason}
          </CrmNote>
        ) : (
          <CrmFacts facts={facts} />
        )}
        {data ? (
          <p className="mt-3 break-words text-xs font-semibold leading-5 text-slate-500">
            Read: {plural(data.counts.phoenixVisits, "Phoenix visit", "Phoenix visits")} · {plural(data.counts.placeReadings, "place reading", "place readings")} ·{" "}
            {plural(data.counts.oldCrmCheckins, "old CRM check-in", "old CRM check-ins")}. A point is trusted when at least {data.rule.minReadings} readings
            on at least {data.rule.minDays} different days lie within {data.rule.coreMeters} m of each other.
          </p>
        ) : null}
      </CrmBlock>

      {data && result?.trusted ? (
        <CrmBlock className="border-t border-slate-100">
          {data.blockedReason ? (
            <CrmNote tone="warn">{data.blockedReason}</CrmNote>
          ) : (
            <CrmNote tone="info">
              Validating places this customer on this point with no photo. Their visits are measured from it from now on
              {data.status === "pending" ? ", and they are validated and join the KPIs" : ""}. The rep adds the clinic&apos;s days and hours as usual.
            </CrmNote>
          )}
          {problem ? (
            <CrmNote className="mt-3" tone="bad">
              {problem}
            </CrmNote>
          ) : null}
          <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
            {data.canApply ? (
              <CrmButton busy={saving} onClick={() => void save()} variant="primary">
                Validate on this point
              </CrmButton>
            ) : null}
            <CrmButton disabled={saving} onClick={onBack}>
              Cancel
            </CrmButton>
          </div>
        </CrmBlock>
      ) : null}
    </CrmPanel>
  );
}
