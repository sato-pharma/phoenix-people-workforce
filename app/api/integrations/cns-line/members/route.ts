import { handleCnsLineMembersRequest } from "@/lib/employees/cns-line-members";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The CNS Line detailing app's server asks here whether an email belongs to somebody working on the
// CNS line today. It gets SHA-256 hashes of the active members' work and personal addresses and
// nothing else — never an address, a name or an HR id. On its OWN token, CNS_LINE_MEMBERS_TOKEN, with
// no development bypass: unset answers 503, a missing or wrong bearer 401. The rule and its reasons
// live in src/lib/employees/cns-line-members.ts. GET only; it changes nothing in Phoenix.
export async function GET(request: Request) {
  return handleCnsLineMembersRequest(request, { token: process.env.CNS_LINE_MEMBERS_TOKEN });
}
