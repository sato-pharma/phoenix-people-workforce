export function toNumber(value: unknown) {
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "EGP",
    maximumFractionDigits: 0,
  }).format(value || 0);
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value || 0);
}

export function formatUnits(value: number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value || 0);
}

export function formatPercent(value: number, options: { input?: "ratio" | "percent"; digits?: number } = {}) {
  const input = options.input ?? "ratio";
  const digits = options.digits ?? 1;
  const normalized = input === "ratio" ? value * 100 : value;
  return `${(Number.isFinite(normalized) ? normalized : 0).toFixed(digits)}%`;
}

export function periodLabel(year: number, month: number) {
  return `${year}-${String(month).padStart(2, "0")}`;
}
