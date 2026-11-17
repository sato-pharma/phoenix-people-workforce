// Whether a piece of text is one internet address (IPv4 or IPv6), with no Node built-in.
//
// The IP blocklist used `isIP` from "node:net", and that file is reachable from the browser bundle:
// src/lib/observability/log.ts (imported by client components) dynamic-imports the error-monitor
// service, which imports the blocklist. Turbopack cannot put a Node built-in in a browser chunk, so
// `next build` died on /admin with "does not support external modules (request: node:net)" and
// every main commit after PR 472 failed its Build step and was never deployed (17 Nov 2026).
// These are the same patterns Node's own lib/internal/net.js uses, so the answer is unchanged;
// tests/system-audit-routes-access.test.ts compares the two over a corpus.

const V4_SEG = "(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])";
const V4_STR = `(?:${V4_SEG}\\.){3}${V4_SEG}`;
const IPV4 = new RegExp(`^${V4_STR}$`);

const V6_SEG = "(?:[0-9a-fA-F]{1,4})";
const IPV6 = new RegExp(
  "^(?:" +
    `(?:${V6_SEG}:){7}(?:${V6_SEG}|:)|` +
    `(?:${V6_SEG}:){6}(?:${V4_STR}|:${V6_SEG}|:)|` +
    `(?:${V6_SEG}:){5}(?::${V4_STR}|(?::${V6_SEG}){1,2}|:)|` +
    `(?:${V6_SEG}:){4}(?:(?::${V6_SEG}){0,1}:${V4_STR}|(?::${V6_SEG}){1,3}|:)|` +
    `(?:${V6_SEG}:){3}(?:(?::${V6_SEG}){0,2}:${V4_STR}|(?::${V6_SEG}){1,4}|:)|` +
    `(?:${V6_SEG}:){2}(?:(?::${V6_SEG}){0,3}:${V4_STR}|(?::${V6_SEG}){1,5}|:)|` +
    `(?:${V6_SEG}:){1}(?:(?::${V6_SEG}){0,4}:${V4_STR}|(?::${V6_SEG}){1,6}|:)|` +
    `(?::(?:(?::${V6_SEG}){0,5}:${V4_STR}|(?::${V6_SEG}){1,7}|:))` +
    ")(?:%[0-9a-zA-Z-.:]{1,})?$",
);

/** 4 for an IPv4 address, 6 for an IPv6 address, 0 for anything else — the same answer as Node's `isIP`. */
export function ipAddressVersion(value: string): 0 | 4 | 6 {
  if (IPV4.test(value)) return 4;
  if (IPV6.test(value)) return 6;
  return 0;
}
