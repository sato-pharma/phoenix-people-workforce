// Employee 360 — lightweight inline-SVG charts (server-rendered, no client JS,
// no chart library). Robust even when the client shell is slow. Colours are
// passed explicitly; text uses currentColor so it adapts to light/dark.

export type ChartSeries = { name: string; color: string; points: (number | null)[]; area?: boolean };

const W = 640;
const PAD = { top: 12, right: 10, bottom: 24, left: 10 };

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
  height?: number;
  yMax?: number;
  yFormat?: (n: number) => string;
  className?: string;
}) {
  const n = labels.length;
  const allVals = series.flatMap((s) => s.points.filter((v): v is number => v != null));
  const dataMax = allVals.length ? Math.max(...allVals) : 1;
  const top = yMax ?? niceMax(dataMax);
  const innerW = W - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => PAD.top + (1 - Math.min(v, top) / top) * innerH;

  const gridY = [0, 0.25, 0.5, 0.75, 1].map((f) => PAD.top + f * innerH);

  function segments(points: (number | null)[]): string[] {
    const paths: string[] = [];
    let cur: string[] = [];
    points.forEach((v, i) => {
      if (v == null) {
        if (cur.length > 1) paths.push(cur.join(" "));
        cur = [];
      } else {
        cur.push(`${cur.length === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`);
      }
    });
    if (cur.length > 1) paths.push(cur.join(" "));
    return paths;
  }

  return (
    <div className={className}>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${height}`} width="100%" preserveAspectRatio="xMidYMid meet" role="img" style={{ maxWidth: "100%" }}>
          {/* gridlines */}
          {gridY.map((gy, i) => (
            <line key={i} x1={PAD.left} y1={gy} x2={W - PAD.right} y2={gy} stroke="currentColor" strokeOpacity={0.1} strokeWidth={1} />
          ))}
          {/* y labels (max / mid) */}
          <text x={PAD.left} y={PAD.top - 2} fontSize={11} fill="currentColor" fillOpacity={0.5}>{yFormat(top)}</text>
          {/* area + lines */}
          {series.map((s) => {
            const paths = segments(s.points);
            const firstIdx = s.points.findIndex((v) => v != null);
            const lastIdx = s.points.length - 1 - [...s.points].reverse().findIndex((v) => v != null);
            const areaPath =
              s.area && paths.length && firstIdx >= 0
                ? `${paths[0]} L ${x(lastIdx).toFixed(1)} ${(PAD.top + innerH).toFixed(1)} L ${x(firstIdx).toFixed(1)} ${(PAD.top + innerH).toFixed(1)} Z`
                : null;
            return (
              <g key={s.name}>
                {areaPath ? <path d={areaPath} fill={s.color} fillOpacity={0.12} /> : null}
                {paths.map((d, i) => (
                  <path key={i} d={d} fill="none" stroke={s.color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
                ))}
                {s.points.map((v, i) =>
                  v == null ? null : (
                    <circle key={i} cx={x(i)} cy={y(v)} r={2.6} fill={s.color}>
                      <title>{`${labels[i]}: ${yFormat(v)}`}</title>
                    </circle>
                  ),
                )}
              </g>
            );
          })}
          {/* x labels (thinned to ~8) */}
          {labels.map((lbl, i) => {
            const stride = Math.ceil(n / 8);
            if (n > 8 && i % stride !== 0 && i !== n - 1) return null;
            return (
              <text key={i} x={x(i)} y={height - 6} fontSize={11} fill="currentColor" fillOpacity={0.5} textAnchor="middle">
                {lbl}
              </text>
            );
          })}
        </svg>
      </div>
      {series.length > 1 ? (
        <div className="mt-1 flex flex-wrap gap-4 text-xs text-muted-foreground">
          {series.map((s) => (
            <span key={s.name} className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: s.color }} /> {s.name}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
