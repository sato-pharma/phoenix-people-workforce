"use client";

import { useEffect, useState } from "react";

import type { ClaimKind } from "@/lib/outstation/approvals/types";

const ROUTE = "/api/admin/outstation/approvals/history";

/**
 * How many DECIDED claims the desk's filters match — History's own count, asked for alone (no rows).
 *
 * Owner, 23 Nov 2026, October picked: "I can see nothing. The tab are empty. No meetings … Of course,
 * there's something wrong." Every claim with an October trip date had been decided, so both waiting
 * lanes were rightly empty — and nothing on the page said the 116 were in History. With this figure
 * the History tab carries its count and an empty lane says where the claims went.
 *
 * Read only while a filter History also reads is set (kind, trip dates, search); null while it is read,
 * when it could not be, or when nothing is filtered. The search is read a moment after the typing
 * stops, as History reads it. `version` goes up when a press is answered, so the count follows it.
 */
export function useDecidedCount({
  enabled,
  from,
  kind,
  search,
  to,
  version,
}: {
  enabled: boolean;
  from: string | null;
  kind: ClaimKind | null;
  search: string;
  to: string | null;
  version: number;
}): number | null {
  const [term, setTerm] = useState(search.trim());
  useEffect(() => {
    const timer = window.setTimeout(() => setTerm(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const params = new URLSearchParams({ count: "1", filter: "all" });
  if (kind) params.set("kind", kind);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (term) params.set("search", term);
  const url = `${ROUTE}?${params.toString()}`;
  const key = enabled ? `${url}|${version}` : null;

  const [read, setRead] = useState<{ key: string; total: number | null } | null>(null);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    fetch(url, { cache: "no-store", headers: { accept: "application/json" } })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as { total?: unknown } | null;
        const total = response.ok && typeof payload?.total === "number" ? payload.total : null;
        if (!cancelled) setRead({ key, total });
      })
      .catch(() => {
        // Unread is said as unread: the lane keeps its plain "Nothing matches", never a made-up zero.
        if (!cancelled) setRead({ key, total: null });
      });
    return () => {
      cancelled = true;
    };
  }, [key, url]);

  return key && read?.key === key ? read.total : null;
}
