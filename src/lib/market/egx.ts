/**
 * Live EGX 30 (Egyptian Exchange main index) quote for the CEO hero.
 *
 * Reads the public Yahoo Finance chart endpoint for `^CASE30`. Cached for 5 minutes
 * via the Next data cache and bounded by a short timeout, so a slow or failed market
 * source degrades to `null` (the hero simply hides the market pill) rather than ever
 * blocking the page or showing a stale/misleading number.
 */

export type EgxQuote = {
  price: number;
  changeAbs: number;
  changePct: number;
  asOfIso: string;
};

const EGX_URL =
  "https://query1.finance.yahoo.com/v8/finance/chart/%5ECASE30?interval=1d&range=1d";

export async function getEgxQuote(): Promise<EgxQuote | null> {
  try {
    const res = await fetch(EGX_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; PhoenixWorkforce/1.0)" },
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      chart?: { result?: Array<{ meta?: Record<string, unknown> }> };
    };
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const price = Number(meta.regularMarketPrice);
    const prev = Number(meta.chartPreviousClose ?? meta.previousClose);
    if (!Number.isFinite(price) || !Number.isFinite(prev) || prev === 0) return null;
    const changeAbs = price - prev;
    const changePct = (changeAbs / prev) * 100;
    const epoch = Number(meta.regularMarketTime);
    const asOfIso = Number.isFinite(epoch)
      ? new Date(epoch * 1000).toISOString()
      : new Date().toISOString();
    return { price, changeAbs, changePct, asOfIso };
  } catch {
    return null;
  }
}
