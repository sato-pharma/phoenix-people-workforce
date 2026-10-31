/**
 * THE CALLER'S ADDRESS, AS RAILWAY'S EDGE SAW IT (technical audit 2026-10-23, S-AUTH-05; corrected 2026-10-31).
 *
 * Rate limits, the IP blocklist, sign-in attempts and log lines all key on this address, so a caller must
 * not be able to choose it. What Railway's edge forwards was CAPTURED on 2026-10-31 (an echo service behind
 * the same edge, edge `cdg1`, forged headers sent alongside):
 *
 *   X-Forwarded-For: <the address the edge saw>, 79.127.178.81   <- REWRITTEN; a caller's own value is dropped
 *   X-Real-IP:       <the address the edge saw>                  <- REWRITTEN; a caller's own value is dropped
 *   CF-Connecting-IP, X-Envoy-External-Address                   <- passed through exactly as the caller sent them
 *
 * The rightmost X-Forwarded-For entry is the edge point of presence's OWN address (Datacamp/CDN77 ranges:
 * 79.127.178.81/.82 Paris, 212.102.36.x Zurich, 152.233.x Amsterdam...). From 23 to 31 Oct this file took
 * the rightmost public entry, so 70-80% of all sign-ins were recorded as one of two Paris addresses, every
 * employee shared one sign-in throttle and one API rate limit, and a blocklist entry could not name a visitor.
 * So the address the edge saw is `X-Real-IP`, which the edge always overwrites.
 *
 * BEHIND CLOUDFLARE (2026-10-26). The production domain is proxied through Cloudflare, so the address the
 * edge saw may be a Cloudflare server. When — and only when — it is inside Cloudflare's published ranges,
 * the visitor is Cloudflare's own `CF-Connecting-IP`. A caller that reaches Railway directly cannot use that
 * header: the edge saw the caller's own address, which is not Cloudflare's. The ranges are
 * https://www.cloudflare.com/ips-v4 and /ips-v6, read 2026-10-26.
 *
 * With no `X-Real-IP` (a local run, nothing in front of it) the rightmost public X-Forwarded-For entry, then
 * the rightmost entry, stands in.
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

function wellFormed(value: string | null | undefined): string | null {
  const address = value?.trim().toLowerCase() ?? "";
  if (v4Number(address.replace(/^::ffff:/, "")) !== null || v6Number(address) !== null) return address;
  return null;
}

/** The address Railway's edge saw: its own X-Real-IP, else (no edge in front) the rightmost public hop. */
function edgeSawAddress(headers: Pick<Headers, "get">): string | null {
  const realIp = wellFormed(headers.get("x-real-ip"));
  if (realIp) return realIp;
  const chain = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    if (!isInternalAddress(chain[index])) return chain[index];
  }
  return chain[chain.length - 1] || null;
}

/** The caller's address, or null when the request carries none at all. */
export function clientAddress(request: { headers: Pick<Headers, "get"> }): string | null {
  const edgeSaw = edgeSawAddress(request.headers);
  if (edgeSaw && isCloudflareAddress(edgeSaw)) {
    const visitor = wellFormed(request.headers.get("cf-connecting-ip"));
    if (visitor) return visitor;
  }
  return edgeSaw;
}
