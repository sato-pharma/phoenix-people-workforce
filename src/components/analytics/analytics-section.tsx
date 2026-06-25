// Shared premium section wrapper for analytics dashboards — dark header bar +
// optional row count, matching the admin shell's locked design language
// (square corners, slate-900/black headers, orange accent). Previously
// duplicated inline per by-X drill-down page; now shared so every dashboard
// section looks identical.

export function AnalyticsSection({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-border">
      <div className="bg-[#0F172A] text-white px-4 py-2.5 flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-widest">{title}</span>
        {count != null && <span className="text-xs text-white/40">{count.toLocaleString("en-EG")} rows</span>}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}
