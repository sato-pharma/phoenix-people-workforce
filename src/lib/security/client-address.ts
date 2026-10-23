/**
 * THE CALLER'S ADDRESS, AS RAILWAY'S EDGE SAW IT (technical audit, 2026-10-23, S-AUTH-05).
 *
 * Every rate limit, audit row and log line used the LEFTMOST `X-Forwarded-For` entry. That entry is
 * whatever the caller sent: a proxy appends the address it saw to the RIGHT of any header already
 * there, so a client can put anything it likes on the left — a fresh address per request, and a
 * per-address rate limit never fills. The production site is served by Railway's edge directly
 * (`Server: railway-hikari`, read 2026-10-23; no CDN in front), so the address that edge saw is the
 * rightmost entry that is not one of the platform's own internal hops.
 *
 * Read from the right, skip private, loopback, link-local and carrier-grade addresses (an internal
 * proxy hop), and take the first public one. Nothing the caller writes can sit to the right of what
 * the edge appends, so it cannot choose this value. With no public entry (a local run) the rightmost
 * entry, then `X-Real-IP`, stands in.
 *
 * Deliberately dependency-free, so the unit tests import it directly.
 */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Whether an address belongs to a private network rather than to a caller on the internet. */
export function isInternalAddress(value: string): boolean {
  const address = value.trim().toLowerCase().replace(/^::ffff:/, "");
  const v4 = IPV4.exec(address);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (address === "::1" || address === "::") return true;
  // fc00::/7 (unique local) and fe80::/10 (link-local).
  return /^f[cd][0-9a-f]{0,2}:/.test(address) || /^fe[89ab][0-9a-f]?:/.test(address);
}

/** The caller's address, or null when the request carries none at all. */
export function clientAddress(request: { headers: Pick<Headers, "get"> }): string | null {
  const chain = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    if (!isInternalAddress(chain[index])) return chain[index];
  }
  return chain[chain.length - 1] || request.headers.get("x-real-ip")?.trim() || null;
}
