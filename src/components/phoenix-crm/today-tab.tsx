"use client";

import { brickTintMap } from "@/components/phoenix-crm/brick-tints";
import { crmUrl, useCrmGet } from "@/components/phoenix-crm/api";
import { dayLabelLong } from "@/components/phoenix-crm/format";
import {
  CrmBlock,
  CrmButton,
  CrmCardsOnPhone,
  CrmEmpty,
  CrmLoadError,
  CrmLoading,
  CrmPanel,
  CrmPill,
  CrmStat,
  CrmStatGrid,
  CrmTable,
  crmTdClassName,
  crmThClassName,
} from "@/components/phoenix-crm/ui";
import { NO_BRICK_KEY } from "@/lib/phoenix-crm/brick-groups";
import { todayByBrick } from "@/lib/phoenix-crm/today-rules";

import type { TodayView } from "@/lib/phoenix-crm/view-types";

/**
 * Phoenix CRM — Today: the screen a rep lands on.
 *
 * GOLDEN RULE #1, the EASY half (owner, 2026-09-26): "very easy very simple". He opens the app a
 * dozen times a day and used to land on a tab bar. Now he lands on his day — the stops in the order
 * he will drive them, grouped by brick, each one either done with the time on it or one tap from
 * being entered.
 *
 * Everything here is HIS OWN WORK, which is what the rule keeps visible: his plan, his day, his two
 * targets. There is no distance on this screen, no accuracy, no spread, and no count of any of them.
 *
 * AM and PM are two figures, never summed and never averaged — the call-rate golden rule.
 */

function stopKey(customerId: string): string {
  return `today-${customerId}`;
}

export function TodayTab({
  onAddVisit,
  seatId,
  test,
}: {
  /** Opens Add Visit with this customer already chosen — the module's existing hand-off, one tap earlier. */
  onAddVisit: (customerId: string, customerName: string) => void;
  seatId: string;
  test: boolean;
}) {
  const resource = useCrmGet<{ today: TodayView }>(crmUrl("/api/phoenix-crm/today", { seatId, test }), "today");
  const view = resource.data?.today ?? null;

  if (!view) {
    return resource.error ? <CrmLoadError message={resource.error} onRetry={resource.reload} /> : <CrmLoading label="Opening your day" />;
  }

  const groups = todayByBrick(view.stops);
  const tints = brickTintMap(groups.filter((group) => group.key !== NO_BRICK_KEY).map((group) => group.key));
  const left = view.stops.filter((stop) => !stop.done).length;

  return (
    <CrmPanel description={`${view.territory.name} · ${dayLabelLong(view.date)}`} title="Today">
      {resource.error ? <CrmLoadError message={resource.error} onRetry={resource.reload} /> : null}

      <CrmBlock>
        {/* AM first, as every sentence in the module says it. Two figures, apart — never a total. */}
        <CrmStatGrid>
          <CrmStat label="AM done" note={`Target ${view.target.am}`} value={`${view.counts.doneAm}`} />
          <CrmStat label="PM done" note={`Target ${view.target.pm}`} value={`${view.counts.donePm}`} />
          <CrmStat label="Planned today" note={`${view.counts.plannedAm} AM · ${view.counts.plannedPm} PM`} value={`${view.stops.length}`} />
          <CrmStat label="Left to do" note={left === 0 ? "Every planned visit is entered" : "Still on today's plan"} value={`${left}`} />
        </CrmStatGrid>
      </CrmBlock>

      {view.stops.length === 0 ? (
        <CrmEmpty message={view.emptyReason ?? undefined} title="Nothing planned for today" />
      ) : (
        groups.map((group) => {
          const tint = tints.get(group.key);
          return (
            <CrmBlock
              className="border-t border-slate-100"
              key={group.key}
              title={groups.length > 1 ? group.label : "Your day"}
            >
              <CrmCardsOnPhone>
                {group.rows.map((stop) => (
                  <div className="flex min-w-0 flex-col gap-1 py-3" key={`${stopKey(stop.customerId)}-card`}>
                    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                      <p className="min-w-0 break-words font-black text-slate-950">{stop.name}</p>
                      {stop.done ? <CrmPill tone="good">Done {stop.doneAt}</CrmPill> : <CrmPill tone="neutral">{stop.listType}</CrmPill>}
                    </div>
                    <p className="break-words text-xs font-semibold text-slate-500">
                      {stop.placeLabel ?? "No place saved yet"} · {stop.todayWindows}
                    </p>
                    {stop.done || !view.canAdd ? null : (
                      <div className="pt-1">
                        <CrmButton onClick={() => onAddVisit(stop.customerId, stop.name)} size="sm" variant="primary">
                          Add visit
                        </CrmButton>
                      </div>
                    )}
                  </div>
                ))}
              </CrmCardsOnPhone>

              <CrmTable columns={["34%", "10%", "24%", "16%", "16%"]}>
                <thead>
                  <tr>
                    <th className={crmThClassName}>Customer</th>
                    <th className={crmThClassName}>List</th>
                    <th className={crmThClassName}>Where and when</th>
                    <th className={crmThClassName}>Standing</th>
                    <th className={crmThClassName}>&nbsp;</th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((stop) => (
                    <tr className={tint?.fill} key={stopKey(stop.customerId)}>
                      <td className={crmTdClassName}>
                        <p className="font-black text-slate-950">{stop.name}</p>
                        {stop.speciality ? <p className="mt-0.5 text-xs text-slate-500">{stop.speciality}</p> : null}
                      </td>
                      <td className={crmTdClassName}>{stop.listType}</td>
                      <td className={crmTdClassName}>
                        <p>{stop.placeLabel ?? "No place saved yet"}</p>
                        <p className="mt-0.5 text-xs text-slate-500">{stop.todayWindows}</p>
                      </td>
                      <td className={crmTdClassName}>
                        {stop.done ? <CrmPill tone="good">Done {stop.doneAt}</CrmPill> : <CrmPill tone="neutral">Not yet</CrmPill>}
                      </td>
                      <td className={crmTdClassName}>
                        {stop.done || !view.canAdd ? null : (
                          <CrmButton onClick={() => onAddVisit(stop.customerId, stop.name)} size="sm" variant="primary">
                            Add visit
                          </CrmButton>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </CrmTable>
            </CrmBlock>
          );
        })
      )}

      {view.alsoVisited.length > 0 ? (
        // Beside the day, never inside it. Real work he did, and dropping it into the middle of his
        // route would make the list he is reading change shape as he works down it.
        <CrmBlock className="border-t border-slate-100" title="Also visited today">
          <div className="divide-y divide-slate-100 border-t border-slate-100">
            {view.alsoVisited.map((extra) => (
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-2.5" key={extra.customerId}>
                <p className="min-w-0 break-words font-black text-slate-950">{extra.name}</p>
                <p className="text-xs font-semibold text-slate-500">
                  {extra.listType} · {extra.doneAt}
                </p>
              </div>
            ))}
          </div>
        </CrmBlock>
      ) : null}
    </CrmPanel>
  );
}
