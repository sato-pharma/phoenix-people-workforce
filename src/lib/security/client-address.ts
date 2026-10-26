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
 * BEHIND CLOUDFLARE (2026-10-26). Railway's edge address 69.46.46.36 dropped about one connection in
 * six from Egyptian networks while staging's edge dropped none, so the production domain is proxied
 * through Cloudflare. Then the address Railway's edge sees is a Cloudflare server, and every member of
 * staff on one network would share one rate limit. So when — and only when — that edge-seen address is
 * inside Cloudflare's published ranges, the visitor is Cloudflare's own `CF-Connecting-IP`. A caller
 * that reaches Railway directly cannot use that header: its edge-seen address is not Cloudflare's.
 * The ranges are https://www.cloudflare.com/ips-v4 and /ips-v6, read 2026-10-26.
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

const CLOUDFLARE_V4 = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18",
  "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17",
  "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
];
const CLOUDFLARE_V6 = [
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32",
  "2a06:98c0::/29", "2c0f:f248::/32",
];

function v4Number(address: string): number | null {
  const parts = IPV4.exec(address);
  if (!parts) return null;
  const octets = parts.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  return octets.reduce((total, octet) => total * 256 + octet, 0);
}

function v6Number(address: string): bigint | null {
  if (!/^[0-9a-f:]+$/.test(address) || address.split("::").length > 2) return null;
  const [head, tail = ""] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (missing > 0 && !address.includes("::"))) return null;
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((total, group) => (total << BigInt(16)) + BigInt(parseInt(group, 16)), BigInt(0));
}

/** Whether an address is one of Cloudflare's own servers. */
export function isCloudflareAddress(value: string): boolean {
  const address = value.trim().toLowerCase().replace(/^::ffff:/, "");
  const v4 = v4Number(address);
  if (v4 !== null) {
    return CLOUDFLARE_V4.some((range) => {
      const [base, bits] = range.split("/");
      const size = 2 ** (32 - Number(bits));
      return Math.floor(v4 / size) === Math.floor((v4Number(base) as number) / size);
    });
  }
  const v6 = v6Number(address);
  if (v6 === null) return false;
  return CLOUDFLARE_V6.some((range) => {
    const [base, bits] = range.split("/");
    const shift = BigInt(128 - Number(bits));
    return v6 >> shift === (v6Number(base) as bigint) >> shift;
  });
}

/** The caller's address, or null when the request carries none at all. */
export function clientAddress(request: { headers: Pick<Headers, "get"> }): string | null {
  const chain = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  let edgeSaw: string | null = null;
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    if (!isInternalAddress(chain[index])) {
      edgeSaw = chain[index];
      break;
    }
  }
  if (edgeSaw && isCloudflareAddress(edgeSaw)) {
    const visitor = request.headers.get("cf-connecting-ip")?.trim().toLowerCase() ?? "";
    if (v4Number(visitor.replace(/^::ffff:/, "")) !== null || v6Number(visitor) !== null) return visitor;
  }
  if (edgeSaw) return edgeSaw;
  return chain[chain.length - 1] || request.headers.get("x-real-ip")?.trim() || null;
}
