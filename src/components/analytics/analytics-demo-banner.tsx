// Server-renderable banner shown when an analytics page is in demo mode
// (see src/lib/analytics/demo-mode.ts). No client JS needed.

export function AnalyticsDemoBanner() {
  return (
    <div className="border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
      DEMO DATA — not connected to real sales records. Remove <code>?demo=1</code> to see live data.
    </div>
  );
}
