"use client";

import { Building2, Check, Globe2, Layers, MapPin, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { groupSatoEmailLists, type SatoListGroupItem } from "@/lib/sato-email/list-groups";

/**
 * The distribution-list half of "Who it reaches", laid out in groups instead of one long column.
 *
 * Owner 2026-09-13: "make the dls appears horizontly grouped and tidy and user friendly and premium
 * polish". Company-wide and team lists sit side by side as tiles; the ~60 line lists collapse into
 * one tab per line, each a Region × (District Managers | Medical Reps) grid, so any single list is
 * two clicks away and the whole of a line is readable at a glance.
 *
 * A list already reached by a WIDER pick says so ("Included") and names the list that carries it.
 * That hint comes from the server's rule comparison (./list-groups `coveredBy`), never from the
 * label, and it never changes what is sent — the preview still resolves and dedupes the audience.
 *
 * Fits the screen at 375 px and on desktop without a horizontal scroll: tiles wrap by grid, and the
 * region grid is a fixed-layout table whose columns merge their header words rather than widen.
 */

type Props = {
  lists: SatoListGroupItem[];
  onChange: (next: string[]) => void;
  selected: string[];
};

type TileState = { coveredByLabel: string | null; picked: boolean };

export function SatoEmailListPicker({ lists, onChange, selected }: Props) {
  const groups = useMemo(() => groupSatoEmailLists(lists), [lists]);
  const byKey = useMemo(() => new Map(lists.map((list) => [list.listKey, list])), [lists]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const [activeLine, setActiveLine] = useState<string>(() => {
    const withPick = groups.lines.find((group) => lineKeys(group).some((key) => selected.includes(key)));
    return (withPick ?? groups.lines[0])?.line ?? "";
  });

  const stateOf = (item: SatoListGroupItem): TileState => {
    const picked = selectedSet.has(item.listKey);
    const carrier = picked ? undefined : item.coveredBy.find((key) => selectedSet.has(key));
    return { coveredByLabel: carrier ? (byKey.get(carrier)?.label ?? null) : null, picked };
  };

  const toggle = (listKey: string) => {
    onChange(selectedSet.has(listKey) ? selected.filter((key) => key !== listKey) : [...selected, listKey]);
  };

  if (lists.length === 0) {
    return (
      <p className="border border-dashed border-phx-line bg-phx-paper p-4 text-sm text-phx-ink-soft">
        No distribution list is switched on yet. Turn one on under Distribution Lists, or name people below.
      </p>
    );
  }

  const current = groups.lines.find((group) => group.line === activeLine) ?? groups.lines[0] ?? null;
  const picked = selected.map((key) => byKey.get(key)).filter((item): item is SatoListGroupItem => Boolean(item));

  return (
    <div className="space-y-5">
      {groups.companyWide.length > 0 ? (
        <Group icon={<Globe2 className="h-3.5 w-3.5" />} title="Company-wide">
          <TileGrid>
            {groups.companyWide.map((item) => (
              <ListTile item={item} key={item.listKey} onToggle={toggle} state={stateOf(item)} title={item.label} />
            ))}
          </TileGrid>
        </Group>
      ) : null}

      {groups.teams.length > 0 ? (
        <Group icon={<Building2 className="h-3.5 w-3.5" />} title="Teams">
          <TileGrid>
            {groups.teams.map((item) => (
              <ListTile item={item} key={item.listKey} onToggle={toggle} state={stateOf(item)} title={item.label} />
            ))}
          </TileGrid>
        </Group>
      ) : null}

      {current ? (
        <Group icon={<Layers className="h-3.5 w-3.5" />} title="By line">
          <div
            aria-label="Sales line"
            className="grid border border-phx-line bg-phx-paper p-1"
            role="tablist"
            // One row for up to three lines — the company has three, and a wrapped tab strip reads as
            // two separate controls. A fourth line wraps rather than squeezing the names.
            style={{ gridTemplateColumns: `repeat(${Math.min(groups.lines.length, 3)}, minmax(0, 1fr))` }}
          >
            {groups.lines.map((group) => {
              const active = group.line === current.line;
              const count = lineKeys(group).filter((key) => selectedSet.has(key)).length;
              return (
                <button
                  aria-selected={active}
                  className={`relative flex min-h-[44px] flex-col items-center justify-center gap-0.5 px-2 py-1.5 text-center transition ${
                    active
                      ? "bg-[#0B0B0B] text-white shadow-[0_6px_16px_rgba(15,23,42,0.18)]"
                      : "text-phx-ink-2 hover:bg-white"
                  }`}
                  key={group.line}
                  onClick={() => setActiveLine(group.line)}
                  role="tab"
                  type="button"
                >
                  <span className="text-phx-xs font-black leading-tight">{group.line}</span>
                  <span
                    className={`text-phx-sm font-bold uppercase tracking-wide ${
                      count > 0 ? (active ? "text-phx-accent" : "text-orange-700") : active ? "text-white/60" : "text-phx-ink-faint"
                    }`}
                  >
                    {count > 0 ? `${count} picked` : "None picked"}
                  </span>
                  {active ? <span className="absolute inset-x-0 bottom-0 h-0.5 bg-phx-accent" /> : null}
                </button>
              );
            })}
          </div>

          <div className="mt-3 border border-phx-line bg-white" role="tabpanel">
            {current.everyone || current.districtManagers || current.medicalReps ? (
              <div className="border-b border-phx-line bg-phx-paper p-3">
                <p className="mb-2 text-phx-sm font-black uppercase tracking-wide text-phx-ink-faint">
                  Whole {current.line} line, every region
                </p>
                <TileGrid>
                  {current.everyone ? (
                    <ListTile item={current.everyone} onToggle={toggle} state={stateOf(current.everyone)} title="Everyone" />
                  ) : null}
                  {current.districtManagers ? (
                    <ListTile
                      item={current.districtManagers}
                      onToggle={toggle}
                      state={stateOf(current.districtManagers)}
                      title="District Managers"
                    />
                  ) : null}
                  {current.medicalReps ? (
                    <ListTile
                      item={current.medicalReps}
                      onToggle={toggle}
                      state={stateOf(current.medicalReps)}
                      title="Medical Reps"
                    />
                  ) : null}
                </TileGrid>
              </div>
            ) : null}

            {current.regions.length > 0 ? (
              <table className="w-full table-fixed border-collapse text-left">
                <colgroup>
                  <col className="w-[36%]" />
                  <col className="w-[32%]" />
                  <col className="w-[32%]" />
                </colgroup>
                <thead>
                  <tr className="border-b border-phx-line">
                    <th className="px-3 py-2 text-phx-sm font-black uppercase tracking-wide text-phx-ink-faint" scope="col">
                      Region
                    </th>
                    <th className="px-2 py-2 text-center text-phx-sm font-black uppercase tracking-wide text-phx-ink-faint" scope="col">
                      District Managers
                    </th>
                    <th className="px-2 py-2 text-center text-phx-sm font-black uppercase tracking-wide text-phx-ink-faint" scope="col">
                      Medical Reps
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {current.regions.map((row) => (
                    <tr className="border-b border-phx-line last:border-b-0 even:bg-phx-paper/60" key={row.region}>
                      <th className="px-2 py-2 align-middle sm:px-3" scope="row">
                        <span className="flex items-center gap-1.5 text-sm font-black text-phx-ink">
                          <MapPin className="h-3.5 w-3.5 shrink-0 text-phx-accent" />
                          <span className="break-words">{row.region}</span>
                        </span>
                      </th>
                      <td className="px-1.5 py-1.5 align-middle">
                        <RegionCell
                          item={row.districtManagers}
                          name={`${current.line}, ${row.region}, District Managers`}
                          onToggle={toggle}
                          state={row.districtManagers ? stateOf(row.districtManagers) : null}
                        />
                      </td>
                      <td className="px-1.5 py-1.5 align-middle">
                        <RegionCell
                          item={row.medicalReps}
                          name={`${current.line}, ${row.region}, Medical Reps`}
                          onToggle={toggle}
                          state={row.medicalReps ? stateOf(row.medicalReps) : null}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
        </Group>
      ) : null}

      {groups.other.length > 0 ? (
        <Group icon={<Layers className="h-3.5 w-3.5" />} title="Other lists">
          <TileGrid>
            {groups.other.map((item) => (
              <ListTile item={item} key={item.listKey} onToggle={toggle} state={stateOf(item)} title={item.label} />
            ))}
          </TileGrid>
        </Group>
      ) : null}

      {/* -------------------------------------------------------------- what is picked, in full */}
      <div className="border border-phx-line bg-phx-paper">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-phx-line px-3 py-2">
          <span className="text-phx-xs font-black uppercase tracking-wide text-phx-ink-2">
            {picked.length === 0 ? "No list picked" : `${picked.length} list${picked.length === 1 ? "" : "s"} picked`}
          </span>
          {picked.length > 0 ? (
            <button
              className="text-phx-xs font-black text-phx-ink-soft underline-offset-2 transition hover:text-phx-ink hover:underline"
              onClick={() => onChange([])}
              type="button"
            >
              Clear all
            </button>
          ) : null}
        </div>
        {picked.length === 0 ? (
          <p className="px-3 py-3 text-xs font-semibold text-phx-ink-faint">
            Pick a tile or a region above. Each list you pick is listed here with exactly who it is meant to reach.
          </p>
        ) : (
          <ul className="divide-y divide-phx-line">
            {picked.map((item) => {
              const carrier = item.coveredBy.find((key) => selectedSet.has(key));
              return (
                <li className="flex items-start gap-3 px-3 py-2.5" key={item.listKey}>
                  <span className="mt-1 h-2 w-2 shrink-0 bg-phx-accent" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-black text-phx-ink">{item.label}</span>
                    <span className="block text-xs font-semibold text-phx-ink-faint">{item.description}</span>
                    {carrier ? (
                      <span className="mt-0.5 block text-xs font-bold text-orange-700">
                        Already reached through {byKey.get(carrier)?.label ?? "a wider list"} — nobody gets it twice.
                      </span>
                    ) : null}
                  </span>
                  <button
                    aria-label={`Remove ${item.label}`}
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center border border-phx-line bg-white text-phx-ink-soft transition hover:border-phx-ink hover:text-phx-ink"
                    onClick={() => toggle(item.listKey)}
                    type="button"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function lineKeys(group: ReturnType<typeof groupSatoEmailLists>["lines"][number]): string[] {
  const keys: string[] = [];
  for (const item of [group.everyone, group.districtManagers, group.medicalReps]) if (item) keys.push(item.listKey);
  for (const row of group.regions) {
    if (row.districtManagers) keys.push(row.districtManagers.listKey);
    if (row.medicalReps) keys.push(row.medicalReps.listKey);
  }
  return keys;
}

function Group({ children, icon, title }: { children: ReactNode; icon: ReactNode; title: string }) {
  return (
    <div>
      <p className="mb-2 flex items-center gap-1.5 text-phx-xs font-black uppercase tracking-wide text-phx-ink-2">
        <span className="text-phx-accent">{icon}</span>
        {title}
      </p>
      {children}
    </div>
  );
}

function TileGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{children}</div>;
}

function Tick({ state }: { state: TileState }) {
  if (state.picked) {
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center bg-phx-accent text-white">
        <Check className="h-3 w-3" strokeWidth={3.5} />
      </span>
    );
  }
  if (state.coveredByLabel) {
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center border border-phx-accent-line bg-white text-phx-accent">
        <Check className="h-3 w-3" strokeWidth={3} />
      </span>
    );
  }
  return <span className="block h-4 w-4 shrink-0 border border-phx-line-strong bg-white" />;
}

function ListTile({
  item,
  onToggle,
  state,
  title,
}: {
  item: SatoListGroupItem;
  onToggle: (listKey: string) => void;
  state: TileState;
  title: string;
}) {
  const tone = state.picked
    ? "border-[#0B0B0B] bg-[#0B0B0B] text-white shadow-[0_8px_20px_rgba(15,23,42,0.18)]"
    : state.coveredByLabel
      ? "border-phx-accent-line bg-phx-accent-soft text-phx-ink"
      : "border-phx-line bg-white text-phx-ink hover:-translate-y-px hover:border-phx-ink-faint hover:shadow-[0_6px_16px_rgba(15,23,42,0.08)]";

  return (
    <button
      aria-pressed={state.picked}
      className={`flex min-h-[52px] w-full items-start gap-2.5 border px-3 py-2.5 text-left transition ${tone}`}
      onClick={() => onToggle(item.listKey)}
      title={item.description}
      type="button"
    >
      <span className="mt-0.5 flex shrink-0">
        <Tick state={state} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-black leading-snug break-words">{title}</span>
        {state.coveredByLabel ? (
          <span className="mt-0.5 block text-[11px] font-bold leading-snug text-orange-700">
            Included in {state.coveredByLabel}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function RegionCell({
  item,
  name,
  onToggle,
  state,
}: {
  item: SatoListGroupItem | null;
  name: string;
  onToggle: (listKey: string) => void;
  state: TileState | null;
}) {
  if (!item || !state) {
    return <span className="block py-2 text-center text-xs font-semibold text-phx-ink-faint">No list</span>;
  }

  const tone = state.picked
    ? "border-[#0B0B0B] bg-[#0B0B0B] text-white"
    : state.coveredByLabel
      ? "border-phx-accent-line bg-phx-accent-soft text-orange-700"
      : "border-phx-line bg-white text-phx-ink-soft hover:border-phx-ink-faint hover:text-phx-ink";

  return (
    <button
      aria-label={name}
      aria-pressed={state.picked}
      className={`flex min-h-[38px] w-full items-center justify-center gap-1.5 border px-1.5 text-phx-xs font-black transition ${tone}`}
      onClick={() => onToggle(item.listKey)}
      title={state.coveredByLabel ? `Included in ${state.coveredByLabel}` : item.description}
      type="button"
    >
      <Tick state={state} />
      <span>{state.picked ? "Picked" : state.coveredByLabel ? "Included" : "Pick"}</span>
    </button>
  );
}
