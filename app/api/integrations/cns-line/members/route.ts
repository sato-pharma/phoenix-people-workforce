import { handleCnsLineMembersRequest } from "@/lib/employees/cns-line-members";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The CNS Line detailing app's server asks here whether an email belongs to somebody it admits: the
// CNS line, the managers up its reporting chain, and Head Office. It gets HMAC-SHA256 hashes (key CNS_LINE_MEMBERS_HASH_KEY) of the active members'
// work and personal addresses and nothing else — never an address, a name or an HR id. On its OWN
// token, CNS_LINE_MEMBERS_TOKEN, with no development bypass: either value unset answers 503, a missing
// or wrong bearer 401. The rule and its reasons
// live in src/lib/employees/cns-line-members.ts. GET only; it changes nothing in Phoenix.
export async function GET(request: Request) {
  return handleCnsLineMembersRequest(request, {
    token: process.env.CNS_LINE_MEMBERS_TOKEN,
    hashKey: process.env.CNS_LINE_MEMBERS_HASH_KEY,
  });
}
