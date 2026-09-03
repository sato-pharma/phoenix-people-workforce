import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// `direct_order_pharmacies.distributor_code` and `.distributor_customer_code` are dead columns:
// empty on every production row, and read by nothing — not `mapPharmacyRow()`, not any view, not
// `phx_search_direct_order_customers`, `phx_create_direct_order_pharmacy` or
// `phx_resolve_directory_pharmacy`. The live distributor link is the child table
// `direct_order_pharmacy_distributor_codes (distributor_code, customer_code)`.
//
// The failure this pins is silent in both directions. Linking a direct-order pharmacy to a Source
// of Sales customer through the PARENT column returns zero rows and raises no error, which reads
// as "direct orders are not linked to sales" when most of them are, through the child. And writing
// the pair onto the parent asserts a link that both registration paths deliberately REFUSE to
// record in the child when the pair is absent from the master customer map.

const sourceRoots = ["src", "app"].map((directory) => path.join(process.cwd(), directory));

function walkSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkSourceFiles(fullPath);
    return /\.tsx?$/.test(entry.name) ? [fullPath] : [];
  });
}

// The pin is about CODE, not prose — the source comment that explains why these columns are dead
// has to name them. Strip comments first so documenting the trap can never fail the sweep. The
// `[^:]` guard keeps a `https://` URL from being read as the start of a line comment.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/gm, "$1");
}

// `.from("direct_order_pharmacies") … .insert({ … })` — the object literal only, stopping at its
// own closing brace, non-greedy so two inserts in one file stay separate.
const parentInsert = /\.from\("direct_order_pharmacies"\)\s*\.insert\(\{([\s\S]*?)\n\s*\}\)/g;

export function runDirectOrderPharmacyDeadDistributorColumnsTests() {
  const files = sourceRoots.flatMap(walkSourceFiles);
  assert.ok(files.length > 0, "walking src/ and app/ must find sources, or every sweep below passes vacuously");

  const stripped = files.map((file) => ({
    relativePath: path.relative(process.cwd(), file),
    source: stripComments(readFileSync(file, "utf8")),
  }));

  for (const { relativePath, source } of stripped) {
    assert.ok(
      !source.includes("distributor_customer_code"),
      `${relativePath} names direct_order_pharmacies.distributor_customer_code, which is empty on every row — the customer code lives in direct_order_pharmacy_distributor_codes.customer_code`,
    );
  }

  const insertBodies = stripped.flatMap(({ relativePath, source }) =>
    [...source.matchAll(parentInsert)].map((match) => ({ relativePath, body: match[1] })),
  );
  assert.ok(
    insertBodies.length >= 2,
    "both direct_order_pharmacies inserts (manual registration and marketing transfer) must be found, or this sweep pins nothing",
  );
  for (const { relativePath, body } of insertBodies) {
    assert.ok(
      !/\bdistributor_code\s*:/.test(body),
      `${relativePath} writes direct_order_pharmacies.distributor_code, a column nothing reads — the link belongs in direct_order_pharmacy_distributor_codes`,
    );
  }

  const transfer = readFileSync(
    path.join(process.cwd(), "src", "lib", "marketing-requests", "validated-customer-transfer.ts"),
    "utf8",
  );
  assert.match(
    transfer,
    /\.from\("direct_order_pharmacy_distributor_codes"\)\s*\.insert\(/,
    "a transferred customer must still be linked through the child table, or the venue is invisible to every distributor-scoped search",
  );
}
