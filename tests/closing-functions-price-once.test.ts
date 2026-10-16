import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// THE TWO CLOSING READS PRICE EACH PRODUCT ONCE, AND NOTHING ELSE ABOUT THEM MOVED (2026-10-16).
//
// `phx_closing_brick` and `phx_closing_distributor_product` called `phx_factory_price` (SECURITY
// DEFINER, never inlined) on every rollup row: CNS September was 18,558 calls and 1,760 ms of a read
// whose scans take about 110 ms. Both now resolve each DISTINCT product code once. Proven identical on
// production the same day: 20,703 distributor-product rows (94,313,644.99034 EGP) and 13,633 + 9,619
// brick rows (46,145,066.770775 and 48,168,578.219565 EGP), before and after.
//
// This pins the shape of whichever migration LAST defines each function, so a later redefinition is
// held to the same rules: the old FROM, JOINs and WHERE kept whole (the product-master left join can
// change row multiplicity), the confidential exclusion on the brick read, the period passed straight
// to the one dated-price resolver, one resolver call over distinct codes, the security settings and
// the grants. The body carries no comment, because a comment inside it changes `pg_proc.prosrc` and
// breaks the digest that proves the live body is the file's.
// ─────────────────────────────────────────────────────────────────────────────

const MIGRATIONS = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));

type Definition = { file: string; header: string; body: string; tail: string };

function lastDefinition(functionName: string): Definition {
  const opener = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${functionName}\\(`, "i");
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .filter((name) => opener.test(readFileSync(join(MIGRATIONS, name), "utf8")));
  assert.ok(files.length > 0, `no migration defines public.${functionName}`);
  const file = files[files.length - 1];
  const sql = readFileSync(join(MIGRATIONS, file), "utf8").replace(/\r\n/g, "\n");
  const start = sql.search(opener);
  const parts = sql.slice(start).split("$function$");
  assert.ok(parts.length >= 3, `${file}: the body of public.${functionName} must sit between $function$ markers`);
  return { file, header: parts[0], body: parts[1], tail: parts.slice(2).join("$function$") };
}

function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function assertCommonShape(name: string, definition: Definition) {
  const header = flat(definition.header);
  const body = flat(definition.body);
  const tail = flat(definition.tail);
  const where = `${definition.file} (public.${name})`;

  for (const setting of ["stable parallel safe security definer", "set search_path to 'public'", "set statement_timeout to '45s'"]) {
    assert.ok(header.includes(setting), `RED ${where} must keep "${setting}"`);
  }
  assert.ok(!definition.body.includes("--"), `RED ${where}: no comment inside the body — it changes pg_proc.prosrc and breaks the digest proof`);

  assert.ok(
    body.includes("period_price as ( select d.product_code, public.phx_factory_price(d.product_code, p_period) as price from (select distinct base.product_code from base) d )"),
    `RED ${where} must resolve the period price once per DISTINCT product code, with p_period, through phx_factory_price`,
  );
  assert.equal(countOf(body, "phx_factory_price("), 1, `RED ${where} must call the price resolver exactly once — a second call is the per-row cost coming back`);
  assert.ok(
    body.includes("left join period_price on period_price.product_code = b.product_code"),
    `RED ${where} must keep every base row when a product has no price (LEFT join, NULL -> 0)`,
  );

  assert.ok(
    tail.includes(`revoke execute on function public.${name}(text, text) from public, anon, authenticated;`),
    `RED ${where} must revoke execute from public, anon and authenticated`,
  );
  assert.ok(tail.includes(`grant execute on function public.${name}(text, text) to service_role;`), `RED ${where} must grant execute to service_role`);
}

export function runClosingFunctionsPriceOnceTests() {
  // ── (1) The brick read ─────────────────────────────────────────────────────
  {
    const definition = lastDefinition("phx_closing_brick");
    assertCommonShape("phx_closing_brick", definition);
    const body = flat(definition.body);
    for (const clause of [
      "from public.source_of_sales_fact_rollup f",
      "join public.source_of_sales_import_batches b on b.id = f.batch_id and b.status = 'validated'",
      "left join public.source_of_sales_products p on upper(btrim(p.product_code)) = upper(btrim(f.product_code))",
      "where f.period = p_period",
      "and lower(btrim(f.official_line)) = lower(btrim(p_line))",
      "and not f.is_direct",
      "and upper(btrim(coalesce(f.product_code, ''))) not in ('la003', 'la004', 'ss001')",
      "sum(b.total_qty) as units",
      "sum(b.effective_units * coalesce(period_price.price, 0)) as value",
      "group by b.distributor_code, b.region_code, b.area_code, b.brick_id",
    ]) {
      assert.ok(body.includes(clause), `RED ${definition.file}: the brick read must keep "${clause}"`);
    }
  }

  // ── (2) The distributor-product read ───────────────────────────────────────
  {
    const definition = lastDefinition("phx_closing_distributor_product");
    assertCommonShape("phx_closing_distributor_product", definition);
    const body = flat(definition.body);
    for (const clause of [
      "from public.source_of_sales_distributor_product_rollup r",
      "left join public.source_of_sales_products p on upper(btrim(p.product_code)) = upper(btrim(r.product_code))",
      "where r.period = p_period and r.line_key = lower(btrim(p_line))",
      "max(b.product_name) as product_name",
      "sum(b.units_qty) as units",
      "sum(b.eff_units * coalesce(period_price.price, 0)) as value",
      "group by b.distributor_code, b.region_code, b.area_code, b.product_code",
    ]) {
      assert.ok(body.includes(clause), `RED ${definition.file}: the distributor-product read must keep "${clause}"`);
    }
  }

  console.log("closing functions price once: 2 blocks passed");
}
