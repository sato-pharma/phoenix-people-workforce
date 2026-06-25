// Demo-data gate for analytics pages. When active, pages render entirely
// in-memory fixtures (src/lib/analytics/demo-fixtures.ts) instead of calling
// Supabase — zero database I/O, satisfying the "fake/mock data only" review
// requirement without writing anything to any environment.

export function isAnalyticsDemoMode(searchParams: Record<string, string | string[] | undefined>): boolean {
  if (process.env.ANALYTICS_DEMO_MODE === "true") return true;
  const raw = searchParams.demo;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "1" || value === "true";
}
