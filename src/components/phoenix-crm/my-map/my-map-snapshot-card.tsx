/**
 * Phoenix CRM — My map's card on the overview landing pages of the rep, the district manager, the regional and
 * the national sales manager (owner, 2026-10-27: "a snapshot on the district manager, the medical rep, and the
 * national sales manager and the regional sales manager overview landing page").
 *
 * It draws a snapshot it is handed and reads nothing itself: the landing pages' loader
 * (`components/employee-portal/dashboards/my-map-snapshot-card.tsx`) reads it under each page's own
 * `<Suspense>`, because nothing under `components/phoenix-crm` may import server code
 * (`tests/phoenix-crm-boundary.test.ts`).
 *
 * 🔴 A DRAWN PICTURE, NEVER A MAP. The pins are squares in the territory's own frame (`snapshotFrame`), with the
 * busiest bricks named where their pins are. No map tiles are loaded, so a landing page is never billed for a
 * map, and the picture is the territory, not the country.
 *
 * 🔴 AM, PM AND PHARMACIES ARE THREE FIGURES, side by side and never added up (`myMapPerListText`).
 *
 * It wears the frame of the page it sits on: the managers' dark section header (`frame="manager"`, the
 * `MmSectionSkeleton` skin), or the rep's white panel (`frame="rep"`, the `RepPanel` skin). The body folds
 * by its own width (`@container`), never the window's, because the rep's column is narrower than his screen.
 */

import { Map as MapIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { countText, plural } from "@/components/phoenix-crm/format";
import { snapshotFrame } from "@/lib/phoenix-crm/my-map-geometry";
import { MY_MAP_LAYER_COLOUR, MY_MAP_LAYERS, myMapPerListText, type MyMapSnapshot } from "@/lib/phoenix-crm/my-map-rules";

const WIDTH = 320;
const HEIGHT = 200;

export type MyMapCardFrame = "manager" | "rep";

function Shell({ children, frame }: { children: ReactNode; frame: MyMapCardFrame }) {
  if (frame === "rep") {
    return (
      <section className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
        <header className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
          <MapIcon aria-hidden className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-phx-xs font-bold uppercase tracking-[0.09em] text-slate-600">My map</h2>
        </header>
        {children}
      </section>
    );
  }
  return (
    <div className="overflow-hidden border border-slate-200">
      <div className="flex items-center justify-between bg-slate-900 px-5 py-3">
        <h2 className="flex items-center gap-2 text-phx-2xs font-bold uppercase tracking-widest text-slate-300">
          <MapIcon className="h-3.5 w-3.5 text-orange-400" />
          My map
        </h2>
        <div className="h-1.5 w-12 bg-orange-500" />
      </div>
      {children}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 bg-white px-4 py-3">
      <p className="break-words text-phx-xs font-medium uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-1 break-words text-xl font-bold text-slate-900">{value}</p>
      {sub ? <p className="mt-0.5 break-words text-phx-xs font-medium text-slate-500">{sub}</p> : null}
    </div>
  );
}

function OpenLink() {
  return (
    <Link
      className="inline-flex items-center gap-1.5 rounded-none bg-slate-900 px-3 py-2 text-xs font-bold uppercase tracking-wider text-white transition hover:bg-slate-800"
      href="/employee-portals/my-map"
      prefetch={false}
    >
      <MapIcon aria-hidden className="h-3.5 w-3.5 text-orange-400" />
      Open My map
    </Link>
  );
}

/** PM first, so the fewer AM and pharmacy pins are drawn on top of it and never buried. */
const DRAW_ORDER: Record<MyMapSnapshot["points"][number]["layer"], number> = { PM: 0, AM: 1, Pharmacy: 2 };
/** About how wide one letter of a 9px bold label is, and how tall the label is, to keep two from overlapping. */
const LABEL_CHAR_WIDTH = 5.4;
const LABEL_HEIGHT = 11;

type Box = { left: number; right: number; top: number; bottom: number };

/**
 * The bricks to name, busiest first: a label that would sit on one already placed is left out, and every label is
 * kept inside the picture rather than cut at its edge.
 */
function placeLabels(bricks: MyMapSnapshot["bricks"], place: (point: { lat: number; lon: number }) => { x: number; y: number }) {
  const placed: Array<{ name: string; x: number; y: number }> = [];
  const boxes: Box[] = [];
  for (const brick of bricks) {
    const spot = place(brick);
    const half = Math.min((brick.name.length * LABEL_CHAR_WIDTH) / 2, WIDTH / 2 - 2);
    const x = Math.min(Math.max(spot.x, half + 2), WIDTH - half - 2);
    const y = Math.min(Math.max(spot.y - 6, LABEL_HEIGHT), HEIGHT - 3);
    const box = { left: x - half, right: x + half, top: y - LABEL_HEIGHT + 2, bottom: y + 2 };
    if (boxes.some((other) => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)) continue;
    boxes.push(box);
    placed.push({ name: brick.name, x, y });
  }
  return placed;
}

function Picture({ snapshot }: { snapshot: MyMapSnapshot }) {
  const place = snapshotFrame(snapshot.points, WIDTH, HEIGHT, 14);
  const points = [...snapshot.points].sort((left, right) => DRAW_ORDER[left.layer] - DRAW_ORDER[right.layer]);
  return (
    <svg aria-label="Where the validated customers are" className="block h-auto w-full border border-slate-200" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
      <rect fill="#f8fafc" height={HEIGHT} width={WIDTH} x={0} y={0} />
      {points.map((point, index) => {
        const spot = place(point);
        return <rect fill={MY_MAP_LAYER_COLOUR[point.layer]} height={5} key={index} stroke="#ffffff" strokeWidth={0.75} width={5} x={spot.x - 2.5} y={spot.y - 2.5} />;
      })}
      {placeLabels(snapshot.bricks, place).map((label) => (
        // The pale halo keeps a name readable where it crosses the pins under it.
        <text
          fill="#475569"
          fontSize={9}
          fontWeight={700}
          key={label.name}
          paintOrder="stroke"
          stroke="#f8fafc"
          strokeWidth={3}
          textAnchor="middle"
          x={label.x}
          y={label.y}
        >
          {label.name}
        </text>
      ))}
    </svg>
  );
}

export function MyMapSnapshotView({ frame = "manager", snapshot }: { frame?: MyMapCardFrame; snapshot: MyMapSnapshot }) {
  if (snapshot.unavailable) {
    return (
      <Shell frame={frame}>
        <p className="bg-amber-50 px-5 py-5 text-sm font-semibold text-amber-900">The map could not be read just now. Refresh to try again.</p>
      </Shell>
    );
  }

  const counts = snapshot.counts;
  // 🔴 "No validated customer" only when there is none: validated customers whose places have no point are named.
  const someWithoutPin = MY_MAP_LAYERS.some((layer) => snapshot.withoutPin[layer] > 0);
  if (snapshot.points.length === 0) {
    return (
      <Shell frame={frame}>
        <div className="flex flex-col gap-3 bg-white px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-slate-500">
            {someWithoutPin
              ? `No pin yet: ${myMapPerListText(snapshot.withoutPin)} validated, and none of their places has a point.`
              : snapshot.unplaced > 0
                ? `No pin yet: ${plural(snapshot.unplaced, "validated place has", "validated places have")} no point.`
                : "No validated customer on your territories yet. Each one is drawn here as soon as they are validated."}
          </p>
          <OpenLink />
        </div>
      </Shell>
    );
  }

  return (
    <Shell frame={frame}>
      <div className="@container">
        <div className="grid min-w-0 gap-px bg-slate-200 @xl:grid-cols-2">
          <div className="min-w-0 bg-white p-3">
            <Picture snapshot={snapshot} />
            <ul aria-label="What the colours mean" className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
              {(["AM", "PM", "Pharmacy"] as const).map((layer) => (
                <li className="flex items-center gap-1.5 text-phx-xs font-semibold text-slate-600" key={layer}>
                  <span aria-hidden className="inline-block h-2.5 w-2.5" style={{ backgroundColor: MY_MAP_LAYER_COLOUR[layer] }} />
                  {layer === "Pharmacy" ? "Pharmacies" : layer}
                </li>
              ))}
            </ul>
          </div>
          <div className="grid min-w-0 content-start gap-px bg-slate-200">
            <div className="grid grid-cols-3 gap-px bg-slate-200">
              <Stat label="AM" sub={plural(counts.places.AM, "pin", "pins")} value={countText(counts.customers.AM)} />
              <Stat label="PM" sub={plural(counts.places.PM, "pin", "pins")} value={countText(counts.customers.PM)} />
              <Stat label="Pharmacies" sub={plural(counts.places.Pharmacy, "pin", "pins")} value={countText(counts.customers.Pharmacy)} />
            </div>
            <Stat label="New this week" sub="Validated in the last 7 days" value={myMapPerListText(counts.newThisWeek)} />
            <Stat label="Not visited this month" value={myMapPerListText(counts.notVisited)} />
            {snapshot.planRead ? <Stat label="In today's plan" value={myMapPerListText(counts.plannedToday)} /> : null}
            <div className="flex flex-wrap items-center justify-between gap-2 bg-white px-4 py-3">
              <p className="min-w-0 break-words text-phx-xs font-medium text-slate-500">
                {someWithoutPin
                  ? `${myMapPerListText(snapshot.withoutPin)} validated with no pin yet`
                  : snapshot.unplaced > 0
                    ? `${plural(snapshot.unplaced, "place", "places")} without a point yet`
                    : "Open My map for directions to any pin"}
              </p>
              <OpenLink />
            </div>
          </div>
        </div>
      </div>
    </Shell>
  );
}
