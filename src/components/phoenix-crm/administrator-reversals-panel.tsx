"use client";

/**
 * Phoenix CRM — the decisions the Administrator can still take back (owner, 2026-10-08).
 *
 * Only he ever gets this list (`TeamView.reversible` is null for everyone else), fourteen days back:
 * a reopened week, an approved off-plan visit, an approved list request. Each carries one button that
 * asks for a comment and then reverses it; the database refuses whatever can no longer be put back
 * (the rep changed the week, something else touched the customer) and the refusal is shown as written.
 */

import { AdministratorDecline } from "@/components/phoenix-crm/administrator-decline";
import { crmPost } from "@/components/phoenix-crm/api";
import { cairoStamp } from "@/components/phoenix-crm/format";
import { CrmCard, CrmEmpty, CrmPill } from "@/components/phoenix-crm/ui";
import {
  ADMINISTRATOR_REVERSAL_DAYS,
  ADMINISTRATOR_REVERSAL_EFFECT,
  type ReversibleItem,
} from "@/lib/phoenix-crm/administrator-reversal-rules";

export function AdministratorReversalsPanel({
  items,
  onChanged,
}: {
  items: ReadonlyArray<ReversibleItem>;
  /** A reversal saved; the Team tab reads its counts and this list again. */
  onChanged: (message: string) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="border-t border-slate-100">
        <CrmEmpty
          message={`A reopened week, an approved off-plan visit or an approved list request shows here for ${ADMINISTRATOR_REVERSAL_DAYS} days, so you can take it back with a comment.`}
          title="Nothing recent to reverse"
        />
      </div>
    );
  }
  return (
    <div className="grid gap-px border-t border-slate-100 bg-slate-100">
      {items.map((item) => (
        <CrmCard
          accent="border-l-emerald-500"
          key={`${item.kind}:${item.id}`}
          meta={[item.repName, item.territoryName, `Decided ${cairoStamp(item.decidedAt)}`].join(" · ")}
          status={<CrmPill tone="good">{item.label}</CrmPill>}
          title={item.subject}
        >
          <div className="mt-2 grid min-w-0 gap-2">
            <p className="break-words text-xs font-semibold text-slate-500">{ADMINISTRATOR_REVERSAL_EFFECT[item.kind]}</p>
            <AdministratorDecline
              hint="The rep reads it."
              onSubmit={async (comment) => {
                await crmPost(
                  "/api/phoenix-crm/administrator/reverse",
                  { kind: item.kind, id: item.id, note: comment, expectedVersion: item.version },
                  `reverse:${item.id}`,
                );
                onChanged(`Reversed by the Administrator: ${item.subject}.`);
              }}
              verb="Reverse"
            />
          </div>
        </CrmCard>
      ))}
    </div>
  );
}
