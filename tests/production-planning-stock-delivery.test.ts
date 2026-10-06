import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isStockMovement,
  isStockSource,
  STOCK_MOVEMENT_SOURCE,
  STOCK_SOURCES,
  storedStockQty,
} from "@/lib/production-planning/stock.ts";

/**
 * A DELIVERY adds; every other stock source is a balance stored as typed.
 *
 * The owner's own case, 2026-10-06: EGPI had reported 43 kg of ivy extract, he supplied 100 kg
 * more and recorded it as a Delivery of 100 — and the planner then read 100 kg, not 143. Nothing
 * had been lost (reports are appended and the newest IS the current figure) but the one source
 * whose plain meaning is "how much I sent" was being stored as "what the balance is now". Asked
 * which way it should read, he chose: a delivery adds.
 *
 * What would otherwise go wrong quietly: this is a SILENT wrong number. A balance that reads 100
 * instead of 143 looks perfectly ordinary, the reorder alarm divides it by the per-run requirement
 * and reports a cover that is too low, and the only way anybody notices is somebody remembering
 * what they sent. Hence the arithmetic sits in one tested place rather than in the writer.
 */
export function runProductionPlanningStockDeliveryTests() {
  // --- The owner's own case, in the base units the engine counts in -------------------
  const held43kg = BigInt(43_000); // grams, as `prodplan_stock_entries.qty` stores it
  const sent100kg = BigInt(100_000);

  assert.equal(
    storedStockQty({ previousQty: held43kg, source: "delivery", typedQty: sent100kg }),
    BigInt(143_000),
    "43 kg held plus a 100 kg delivery must store 143 kg — this is the defect the owner hit",
  );

  // --- The other three replace, which is what they have always meant -----------------
  for (const source of ["factory_report", "own_count", "adjustment"] as const) {
    assert.equal(
      storedStockQty({ previousQty: held43kg, source, typedQty: sent100kg }),
      sent100kg,
      `${source} is a balance somebody counted, so it must store exactly what was typed`,
    );
    assert.equal(isStockMovement(source), false, `${source} must not be treated as a movement`);
  }

  assert.equal(isStockMovement(STOCK_MOVEMENT_SOURCE), true, "delivery IS the movement source");
  assert.equal(STOCK_MOVEMENT_SOURCE, "delivery", "the movement source is the one the form calls Delivery");

  // --- Nothing held yet: a delivery stores what arrived, not zero --------------------
  assert.equal(
    storedStockQty({ previousQty: BigInt(0), source: "delivery", typedQty: sent100kg }),
    sent100kg,
    "a delivery into a location with no history must store the delivered amount",
  );

  // --- A zero delivery changes nothing, rather than wiping the balance ---------------
  assert.equal(
    storedStockQty({ previousQty: held43kg, source: "delivery", typedQty: BigInt(0) }),
    held43kg,
    "a delivery of nothing must leave the balance where it was",
  );

  // --- The union matches the table's own CHECK ---------------------------------------
  const migration = readFileSync("supabase/migrations/20261005214007_production_planning.sql", "utf8");
  for (const source of STOCK_SOURCES) {
    assert.ok(
      migration.includes(`'${source}'`),
      `${source} must be a value the prodplan_stock_entries source CHECK allows`,
    );
  }
  assert.equal(isStockSource("movement"), false, "a source outside the union must be refused");
  assert.equal(isStockSource(null), false, "a missing source must be refused rather than coerced");

  // --- The writer must go through the rule, not insert the typed figure --------------
  // Read as source because `service.ts` pulls in the Supabase admin client, the same reason
  // tests/production-planning-silent-until-armed.test.ts reads its subjects as text.
  const service = readFileSync("src/lib/production-planning/service.ts", "utf8");
  const writerStart = service.indexOf("export async function addStockEntry");
  assert.notEqual(writerStart, -1, "addStockEntry has moved or been renamed");
  const writer = service.slice(writerStart, service.indexOf("\n}\n", writerStart));

  assert.match(
    writer,
    /const storedQty = storedStockQty\(\{ previousQty, source, typedQty: qty \}\)/,
    "addStockEntry must resolve what to store through storedStockQty, never inline",
  );
  assert.match(
    writer,
    /qty: formatQty\(storedQty\)/,
    "the inserted qty must be the RESOLVED balance, not the figure typed on the form",
  );
  assert.doesNotMatch(
    writer,
    /qty: formatQty\(qty\)/,
    "inserting the typed qty directly is exactly the defect: a delivery would replace the balance",
  );
  assert.match(
    writer,
    /deliveryBehindANewerReport/,
    "a delivery dated behind a newer report must refuse rather than invent a balance under it",
  );
  assert.match(
    writer,
    /unknownStockSource/,
    "an unknown source must be refused with a sentence, not left to the table's CHECK",
  );

  // --- The form must ask for the delivered amount, not a balance ---------------------
  const workspace = readFileSync(
    "src/components/production-planning/production-planning-workspace.tsx",
    "utf8",
  );
  assert.match(
    workspace,
    /label=\{isDelivery \? t\.stockDeliveredQty : t\.stockQty\}/,
    "the quantity field must change its label when the source is a delivery",
  );
  assert.match(
    workspace,
    /t\.stockDeliveryAdds/,
    "the form must say the delivered amount is added to the current balance",
  );
  assert.doesNotMatch(
    workspace,
    /Number\(standingHere|parseFloat\(standingHere/,
    "the screen must not re-compute the new balance in floats — the service owns that arithmetic",
  );
}
