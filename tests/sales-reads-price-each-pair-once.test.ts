import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// FOURTEEN SALES AND CLOSING READS RESOLVE EACH PRODUCT'S PERIOD PRICE ONCE, NOT ONCE PER ROW.
//
// `public.phx_factory_price(code, period)` is SECURITY DEFINER and carries `SET search_path`.
// Postgres inlines a SQL function with NEITHER of those, so every mention of it in a row-level
// expression is a real call carrying two correlated subqueries of its own. Measured on production
// 2026-10-23 on `phx_closing_publication_snapshot('CNS','2026-09')`: 18,558 invocations to resolve
// 15 distinct products, 1,645 ms and 38,963 shared buffers against 177 ms without the value
// aggregate; resolving once per distinct product took it to 241 ms. Over the 21.7 hours to 12:04
// Cairo that day — a window containing the 22 Oct database stall — `phx_exec_customers`,
// `phx_exec_distributor_product` and `phx_exec_brick` alone burned 13.8 minutes of database time
// across 133 calls.
//
// 🔴 DROPPING SECURITY DEFINER IS NOT THE FIX AND MUST NOT BE TRIED. The resolver's body written
// out inline — exactly what the planner substitutes when it is allowed to inline a scalar SQL
// function — still plans `SubPlan 1` and `SubPlan 2` at one loop per row: 1,193 ms against the
// original 2,278 ms, where hoisting gave 202 ms. Inlining substitutes the correlated subqueries, it
// does not turn them into a join. The same conclusion was reached independently on 2026-09-28 and
// is recorded in tests/factory-price-resolved-once.test.ts.
//
// This pins the SHAPE of whichever migration LAST defines each function, so a later redefinition is
// held to the same rules. It is deliberately about the lookup and the things a hoist can break —
// the resolver called only over DISTINCT keys, the join kept LEFT so a priced-nothing row is 0
// rather than dropped, the direct arm still taking its stored value, the resolved column named
// `period_price`, the security settings and the grants. It is NOT a transcription of each body.
// ─────────────────────────────────────────────────────────────────────────────

const MIGRATIONS = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));

/** Functions whose price lookup is keyed on the row's own period as well as its product. */
const PAIR_KEYED = new Set([
  "phx_exec_brick",
  "phx_exec_customers",
  "phx_exec_distributor_product",
  "phx_customer_directory",
]);

/** Functions whose direct arm must keep taking the STORED direct value, never a resolved price. */
const DIRECT_ARMS: Record<string, string> = {
  phx_exec_customers: "when r.is_direct then coalesce(r.direct_value, 0)",
  phx_exec_distributor_product: "when f.is_direct then f.direct_value",
  phx_exec_sos_trend: "when g.is_direct then",
  phx_closing_corrections: "when f.is_direct then",
  f_sales_brick_detail: "when pr.is_direct then pr.direct_value",
};

const FUNCTIONS = [
  "phx_monthly_closing_matrix",
  "phx_exec_brick",
  "phx_exec_customers",
  "phx_exec_sos_trend",
  "phx_customer_sales",
  "phx_exec_distributor_product",
  "phx_customer_directory",
  "phx_territory_area_pharmacies",
  "phx_market_awareness_tracking",
  "phx_closing_corrections",
  "phx_closing_channel_breakdown",
  "phx_sales_channels_by_rep",
  "phx_refresh_sos_channel_rollup",
  // The brick drill-down behind Sales vs Target (public.phx_sales_brick_detail wraps it). Its period
  // is fixed for the whole call, so its lookup is keyed on product_code alone. Measured on
  // production 2026-10-31 for 2026-09: 5,132 ms priced per row, 499 ms hoisted, same 1,068 rows.
  "au.f_sales_brick_detail",
];

/** "au.f_x" -> ["au", "f_x"]; a bare name lives in public. */
function qualify(qualifiedName: string): [string, string] {
  const dot = qualifiedName.indexOf(".");
  return dot < 0 ? ["public", qualifiedName] : [qualifiedName.slice(0, dot), qualifiedName.slice(dot + 1)];
}

type Definition = { file: string; header: string; body: string; tail: string };

function lastDefinition(qualifiedName: string): Definition {
  const [schema, functionName] = qualify(qualifiedName);
  const opener = new RegExp(`create\\s+or\\s+replace\\s+function\\s+${schema}\\.${functionName}\\(`, "i");
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .filter((name) => opener.test(readFileSync(join(MIGRATIONS, name), "utf8")));
  assert.ok(files.length > 0, `no migration defines ${schema}.${functionName}`);
  const file = files[files.length - 1];
  const sql = readFileSync(join(MIGRATIONS, file), "utf8").replace(/\r\n/g, "\n");
  const start = sql.search(opener);
  const parts = sql.slice(start).split("$function$");
  assert.ok(parts.length >= 3, `${file}: the body of ${schema}.${functionName} must sit between $function$ markers`);
  return { file, header: parts[0], body: parts[1], tail: parts.slice(2).join("$function$") };
}

function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * The text of each `period_price as ( … )` CTE, parentheses balanced, so an assertion about the
 * lookup is made against the lookup and not against whatever else the body happens to contain.
 */
function periodPriceCtes(body: string): string[] {
  const out: string[] = [];
  const opener = "period_price as (";
  let from = 0;
  for (;;) {
    const at = body.indexOf(opener, from);
    if (at < 0) return out;
    let depth = 0;
    let i = at + opener.length - 1;
    for (; i < body.length; i += 1) {
      if (body[i] === "(") depth += 1;
      else if (body[i] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(body.slice(at, i + 1));
    from = i + 1;
  }
}

/**
 * Every assertion, over one body. Exported shape so the break tests at the bottom can run it
 * against a deliberately broken body and watch the right assertion fire BY NAME.
 */
function assertHoistedShape(qualifiedName: string, definition: Definition): void {
  const [schema, name] = qualify(qualifiedName);
  const body = flat(definition.body);
  const header = flat(definition.header);
  const tail = flat(definition.tail);
  const where = `${definition.file} (${schema}.${name})`;

  // ── 1. THE LOOKUP IS A CTE, AND THE RESOLVER IS CALLED ONLY INSIDE IT, ONCE PER CTE.
  const ctes = periodPriceCtes(body);
  assert.ok(ctes.length > 0, `RED ${where} must resolve the price in a "period_price as (" CTE, not per row`);

  const calls = countOf(body, "phx_factory_price(");
  const callsInsideCtes = ctes.reduce((n, cte) => n + countOf(cte, "phx_factory_price("), 0);
  assert.equal(
    calls,
    callsInsideCtes,
    `RED ${where}: phx_factory_price is called ${calls - callsInsideCtes} time(s) OUTSIDE the period_price CTE — `
      + "that is a per-row call, which is the whole regression",
  );
  assert.equal(
    calls,
    ctes.length,
    `RED ${where} must call phx_factory_price exactly once per period_price CTE (${ctes.length} CTEs, ${calls} calls) — `
      + "a surplus call is the per-row cost coming back",
  );

  // ── 2. EVERY CALL TAKES THE DISTINCT KEY SET'S OWN ALIAS, over a "select distinct". This is what
  //      fires when someone "simplifies" the CTE away: a per-row call reads f./r./c., never d.
  const callArgs = [...definition.body.matchAll(/phx_factory_price\(\s*([A-Za-z_][\w]*)\./g)].map((m) => m[1].toLowerCase());
  assert.equal(callArgs.length, calls, `RED ${where}: every phx_factory_price call must take a qualified column`);
  for (const alias of callArgs) {
    assert.equal(
      alias,
      "d",
      `RED ${where}: phx_factory_price is called on "${alias}." — it must be called on the distinct-key subquery `
        + '(aliased "d"), never on a base-table row',
    );
  }
  for (const cte of ctes) {
    assert.ok(
      cte.includes("select distinct"),
      `RED ${where}: each period_price CTE must read a "select distinct" key set — without it the resolver runs once `
        + "per base row again",
    );
  }

  // ── 3. THE RESOLVED COLUMN IS NAMED period_price, NEVER factory_price.
  //      tests/product-period-price.test.ts rejects "* coalesce(<alias>.factory_price" outright.
  assert.ok(
    body.includes("as period_price"),
    `RED ${where}: the resolved column must be named period_price`,
  );
  assert.ok(
    !/\*\s*coalesce\([a-z_]+\.factory_price/.test(body),
    `RED ${where}: units must never be multiplied by the product master's flat factory_price`,
  );

  // ── 4. THE JOIN BACK IS LEFT, AND THE MISS IS 0 — never a dropped row.
  const leftJoins = countOf(body, "left join period_price");
  assert.ok(leftJoins > 0, `RED ${where}: the lookup must be joined back with a LEFT join`);
  assert.equal(
    countOf(body, "join period_price"),
    leftJoins,
    `RED ${where}: every period_price join must be a LEFT join — an inner join silently drops rows whose product `
      + "has no price, which changes the money",
  );
  assert.ok(
    body.includes("coalesce(pp.period_price, 0)"),
    `RED ${where}: an unmatched product must price at 0, which is what phx_factory_price itself returns`,
  );

  // ── 5. THE PAIR KEY, where the period varies row to row. The two-column join was planned as a
  //      merge on period alone (Rows Removed by Join Filter: 3,570,096, 6,531 ms); the single
  //      concatenated key runs in 3,209 ms. Production holds zero "|" in either column.
  if (PAIR_KEYED.has(name)) {
    assert.ok(
      body.includes("|| '|' ||"),
      `RED ${where}: the varying-period lookup must join on the single concatenated key `
        + "product_code || '|' || period — the two-column join is planned as a merge on period alone",
    );
    assert.ok(
      !/on pp\.product_code = [a-z_]+\.product_code and pp\.period/.test(body),
      `RED ${where}: the two-column join shape must not come back`,
    );
  }

  // ── 6. THE DIRECT ARM STILL TAKES THE STORED VALUE. A hoist must never start pricing a direct row.
  const directArm = DIRECT_ARMS[name];
  if (directArm) {
    assert.ok(body.includes(directArm), `RED ${where}: the direct arm must keep "${directArm}"`);
  }

  // ── 7. SECURITY AND GRANTS SURVIVE THE REWRITE.
  assert.ok(header.includes("security definer"), `RED ${where} must stay SECURITY DEFINER`);
  const searchPath = schema === "public" ? "set search_path to 'public'" : `set search_path to '${schema}', 'public'`;
  assert.ok(header.includes(searchPath), `RED ${where} must keep its pinned search_path`);
  assert.ok(
    new RegExp(`revoke execute on function ${schema}\\.${name}\\(`).test(tail),
    `RED ${where} must revoke execute from public, anon and authenticated`,
  );
  assert.ok(
    new RegExp(`grant execute on function ${schema}\\.${name}\\([^)]*\\) to [a-z_, ]*service_role`).test(tail),
    `RED ${where} must grant execute to service_role`,
  );
}

export function runSalesReadsPriceEachPairOnceTests() {
  for (const name of FUNCTIONS) {
    assertHoistedShape(name, lastDefinition(name));
  }

  // ───────────────────────────────────────────────────────── break tests (negative controls)
  //
  // Each one takes a real definition, breaks exactly one thing, and requires THAT assertion to fire
  // by its own words. Without these the block above could be asserting nothing at all.

  const real = lastDefinition("phx_exec_brick");
  const broke = (mutate: (d: Definition) => Definition, expect: RegExp) => {
    assert.throws(
      () => assertHoistedShape("phx_exec_brick", mutate({ ...real })),
      expect,
      `the break test for ${expect} did not fire — that assertion proves nothing`,
    );
  };

  // (a) the CTE simplified back into a per-row call — the regression this whole file exists for
  broke(
    (d) => ({ ...d, body: d.body.replace("coalesce(pp.period_price, 0)", "coalesce(public.phx_factory_price(f.product_code, f.period), 0)") }),
    /OUTSIDE the period_price CTE/,
  );

  // (b) a second resolver call inside the CTE — half the saving silently given back
  broke(
    (d) => ({
      ...d,
      body: d.body.replace(
        "public.phx_factory_price(d.product_code, d.period) as period_price",
        "coalesce(public.phx_factory_price(d.product_code, d.period), public.phx_factory_price(d.product_code, d.period)) as period_price",
      ),
    }),
    /exactly once per period_price CTE/,
  );

  // (b2) the key set no longer DISTINCT — the resolver is back to once per base row, with the CTE
  //      still in place to make it look hoisted
  broke((d) => ({ ...d, body: d.body.replace("select distinct f.product_code, f.period", "select f.product_code, f.period") }), /select distinct" key set/);

  // (b3) the resolver pointed back at a base-table row inside the CTE
  broke(
    (d) => ({ ...d, body: d.body.replace("phx_factory_price(d.product_code, d.period)", "phx_factory_price(f.product_code, f.period)") }),
    /must be called on the distinct-key subquery/,
  );

  // (c) the only LEFT join turned inner — rows whose product has no price would vanish
  broke(
    (d) => ({ ...d, body: d.body.replace("left join period_price pp", "join period_price pp") }),
    /must be joined back with a LEFT join/,
  );

  // (c2) ONE of two joins turned inner — the half-converted shape a wide edit actually produces
  assert.throws(
    () => {
      const ec = lastDefinition("phx_exec_customers");
      assertHoistedShape("phx_exec_customers", { ...ec, body: ec.body.replace("left join period_price pp", "join period_price pp") });
    },
    /must be a LEFT join/,
    "the partial inner-join break test did not fire",
  );

  // (d) the two-column join shape restored on a pair-keyed function
  assert.throws(
    () => {
      const dp = lastDefinition("phx_exec_distributor_product");
      assertHoistedShape("phx_exec_distributor_product", {
        ...dp,
        body: dp.body.replace(/on pp\.pair = f\.product_code \|\| '\|' \|\| f\.period/g, "on pp.product_code = f.product_code and pp.period = f.period"),
      });
    },
    /two-column join shape must not come back/,
    "the restored two-column join break test did not fire",
  );

  // (d2) the concatenation dropped altogether
  assert.throws(
    () => {
      const dp = lastDefinition("phx_exec_distributor_product");
      assertHoistedShape("phx_exec_distributor_product", { ...dp, body: dp.body.split("|| '|' ||").join("||") });
    },
    /single concatenated key/,
    "the lost-pair-key break test did not fire",
  );

  // (e) the resolved column renamed to factory_price
  broke((d) => ({ ...d, body: d.body.replace(/as period_price/g, "as factory_price") }), /named period_price/);

  // (f) SECURITY DEFINER dropped — the "one change fixes all 21" route, which was measured and
  //     rejected: inlining leaves the correlated subqueries where they are.
  //
  //     🔴 The mutation MUST be case-insensitive. `header` is compared lower-cased by rule 7, but the
  //     mutation runs against the RAW header, and a migration written out of `pg_get_functiondef`
  //     spells it `STABLE SECURITY DEFINER` in upper case. A plain lower-case replace is then a
  //     silent no-op and this break test stops proving anything — which is exactly what happened the
  //     moment a later migration redefined phx_exec_brick from a catalog dump.
  broke((d) => ({ ...d, header: d.header.replace(/security definer/i, "security invoker") }), /must stay SECURITY DEFINER/);

  // (g) the service_role grant lost
  broke((d) => ({ ...d, tail: d.tail.replace(/grant execute on function[^;]*;/g, "") }), /must grant execute to service_role/);

  // (h) the brick drill-down — the one au-schema read — priced per row again, exactly as it was
  //     before 2026-10-31
  const brick = lastDefinition("au.f_sales_brick_detail");
  assert.throws(
    () =>
      assertHoistedShape("au.f_sales_brick_detail", {
        ...brick,
        body: brick.body.replace(
          "coalesce(pp.period_price, 0) as factory_price",
          "coalesce(public.phx_factory_price(fa.product_code, p_period), 0) as factory_price",
        ),
      }),
    /OUTSIDE the period_price CTE/,
    "the au brick drill-down per-row break test did not fire",
  );

  // (i) its own two-schema search_path lost — the schema-aware check must not fall back to 'public'
  assert.throws(
    () =>
      assertHoistedShape("au.f_sales_brick_detail", {
        ...brick,
        header: brick.header.replace("SET search_path TO 'au', 'public'", "SET search_path TO 'public'"),
      }),
    /must keep its pinned search_path/,
    "the au brick drill-down search_path break test did not fire",
  );

  console.log(`sales reads price each pair once: ${FUNCTIONS.length} functions, 14 break tests passed`);
}
