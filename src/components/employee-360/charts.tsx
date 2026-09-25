// Employee 360 — lightweight inline-SVG charts (server-rendered, no client JS,
// no chart library). Robust even when the client shell is slow. Colours are
// passed explicitly; text uses currentColor so it adapts to light/dark.
//
// FITS THE SCREEN (AGENTS.md §4). This used to draw a 640-unit-wide SVG and let the browser
// scale the WHOLE picture down to the card, text included: on a 375px phone the card holds
// ~277px, so the axis text rendered ~4.8px tall and the chart ~73px tall, inside an
// `overflow-x-auto` wrapper that was never needed. Now only the MARKS live in the SVG, drawn in a
// 0–100 box stretched to a fixed-height plot (`preserveAspectRatio="none"`, strokes kept at their
// pixel width by `vector-effect`), while every piece of text and every data point is HTML placed
// by percentage — so labels stay at the house type scale at any width and a point never turns
// into an ellipse.

export type ChartSeries = { name: string; color: string; points: (number | null)[]; area?: boolean };

/** At most this many x-axis labels: the rest stay on the points' own tooltips. */
const MAX_X_LABELS = 6;

function niceMax(max: number): number {
  if (max <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(max)));
  const norm = max / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

export function LineChart({
  labels,
  series,
  height = 180,
  yMax,
  yFormat = (n) => String(Math.round(n)),
  className,
}: {
  labels: string[];
  series: ChartSeries[];
  /** Height of the plot area in px (the axis labels sit outside it). */
  height?: number;
  yMax?: number;
  yFormat?: (n: number) => string;
  className?: string;
}) {
  const n = labels.length;
  const allVals = series.flatMap((s) => s.points.filter((v): v is number => v != null));
  const dataMax = allVals.length ? Math.max(...allVals) : 1;
  const top = yMax ?? niceMax(dataMax);
  // Percent coordinates in a 0–100 box, shared by the SVG marks and the HTML overlays.
  const x = (i: number) => (n <= 1 ? 50 : (i / (n - 1)) * 100);
  const y = (v: number) => (1 - Math.min(v, top) / top) * 100;

  const gridY = [0, 25, 50, 75, 100];

  // Thin the x labels by counting back from the LAST point, so the latest month is always named
  // and the spacing between shown labels stays even (a forced last label used to crowd its
  // neighbour).
  const stride = Math.max(1, Math.ceil(n / MAX_X_LABELS));
  const xLabelIndexes = labels.map((_, i) => i).filter((i) => (n - 1 - i) % stride === 0);

  function segments(points: (number | null)[]): string[] {
    const paths: string[] = [];
    let cur: string[] = [];
    points.forEach((v, i) => {
      if (v == null) {
        if (cur.length > 1) paths.push(cur.join(" "));
        cur = [];
      } else {
        cur.push(`${cur.length === 0 ? "M" : "L"} ${x(i).toFixed(2)} ${y(v).toFixed(2)}`);
      }
    });
    if (cur.length > 1) paths.push(cur.join(" "));
    return paths;
  }

  return (
    <div className={className}>
      <div className="mb-1 text-phx-2xs font-semibold tabular-nums text-slate-400">{yFormat(top)}</div>
      <div className="px-1.5">
        <div className="relative w-full" style={{ height }}>
          <svg
            aria-label={`${series.map((s) => s.name).join(" and ")} chart`}
            className="absolute inset-0 h-full w-full overflow-visible"
            preserveAspectRatio="none"
            role="img"
            viewBox="0 0 100 100"
          >
            {/* gridlines */}
            {gridY.map((gy) => (
              <line key={gy} x1={0} y1={gy} x2={100} y2={gy} stroke="currentColor" strokeOpacity={0.1} strokeWidth={1} vectorEffect="non-scaling-stroke" />
            ))}
            {/* area + lines */}
            {series.map((s) => {
              const paths = segments(s.points);
              const firstIdx = s.points.findIndex((v) => v != null);
              const lastIdx = s.points.length - 1 - [...s.points].reverse().findIndex((v) => v != null);
              const areaPath =
                s.area && paths.length && firstIdx >= 0
                  ? `${paths[0]} L ${x(lastIdx).toFixed(2)} 100 L ${x(firstIdx).toFixed(2)} 100 Z`
                  : null;
              return (
                <g key={s.name}>
                  {areaPath ? <path d={areaPath} fill={s.color} fillOpacity={0.12} /> : null}
                  {paths.map((d, i) => (
                    <path key={i} d={d} fill="none" stroke={s.color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
                  ))}
                </g>
              );
            })}
          </svg>
          {/* Data points as HTML squares, so the stretched plot never distorts them. */}
          {series.map((s) =>
            s.points.map((v, i) =>
              v == null ? null : (
                <span
                  aria-hidden
                  className="absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2"
                  key={`${s.name}-${i}`}
                  style={{ backgroundColor: s.color, left: `${x(i)}%`, top: `${y(v)}%` }}
                  title={`${s.name} · ${labels[i]}: ${yFormat(v)}`}
                />
              ),
            ),
          )}
        </div>
        {/* x labels, each centred under its own point; the two ends are pinned inside the plot. */}
        <div aria-hidden className="relative mt-1 h-4 text-phx-2xs font-semibold text-slate-400">
          {xLabelIndexes.map((i) => {
            const pos = x(i);
            const edge = n > 1 && i === 0 ? "translate-x-0" : n > 1 && i === n - 1 ? "-translate-x-full" : "-translate-x-1/2";
            return (
              <span className={`absolute top-0 whitespace-nowrap ${edge}`} key={i} style={{ left: `${pos}%` }}>
                {labels[i]}
              </span>
            );
          })}
        </div>
      </div>
      {series.length > 1 ? (
        <div className="mt-1 flex flex-wrap gap-4 text-xs text-muted-foreground">
          {series.map((s) => (
            <span key={s.name} className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5" style={{ backgroundColor: s.color }} /> {s.name}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
