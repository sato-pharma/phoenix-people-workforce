// Shared formatters for the Sales Intelligence executive surface. Charts and tiles use compact
// EGP (4.2M / 540K); tables use full currency from src/lib/sales/format.ts.

export function compactEGP(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  const abs = Math.abs(safe);
  if (abs >= 1_000_000) return `${(safe / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(safe / 1_000).toFixed(0)}K`;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(safe);
}

export function compactNumber(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  const abs = Math.abs(safe);
  if (abs >= 1_000_000) return `${(safe / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(safe / 1_000).toFixed(1)}K`;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(safe);
}

export function shareText(share: number, digits = 1): string {
  return `${((Number.isFinite(share) ? share : 0) * 100).toFixed(digits)}%`;
}
