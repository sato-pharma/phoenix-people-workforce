/**
 * The machines an import just put in stock, listed where the import reports them so each one can be
 * handed over on the spot.
 *
 * WHY THIS EXISTS. An Action1 pull registers a laptop with nobody signed for it — deliberately, see
 * the header of `action1.ts` — and until this the only way to hand it over was to leave the import,
 * switch the register to In stock and find the row again. The owner asked for enrolling a machine to
 * lead straight to its receipt, and chose on 2026-09-11 that the person is picked HERE, in Phoenix,
 * rather than typed into Action1.
 *
 * WHY NOT FROM ACTION1'S OWN USER FIELD. Action1 reports the Windows account that last logged in. On
 * the first machine enrolled that was `DESKTOP-TU4PJGN\satoh`, and `satoh` is also the account on the
 * owner's own laptop — a shared company login, not a person. So there is no name in it to suggest,
 * and `action1.ts` explains why a name taken from it would be wrong even on a machine where it looked
 * right.
 *
 * NOTHING HERE NAMES A HOLDER. It returns the register's own rows as they now stand. The hand-over is
 * still the existing form with the person chosen from the list, and that press is the act the custody
 * receipt records.
 *
 * WHICH ROWS. Every outcome that wrote a device WITHOUT also opening a custody record — a spreadsheet
 * row can name its holder, and those were handed over by the import itself. Matched on the id the
 * import wrote rather than on the asset tag, so the list is exactly the rows THIS import created. A
 * device handed over from the list STAYS in it with its new state, because the receipt it now needs
 * is printed from the same place.
 *
 * PURE, so which rows are offered is pinned without a database — `tests/device-action1-sync.test.ts`.
 */
import type { DeviceImportResult } from "./bulk-import";
import type { CompanyDevice } from "./types";

export type ImportedDevicesForHandover = {
  /** In the order the import reported them, which is the order of the rows it read. */
  devices: CompanyDevice[];
  /** How many of those are still in stock — the hand-overs still owed. */
  stillInStock: number;
};

export function importedDevicesForHandover(
  result: Pick<DeviceImportResult, "outcomes"> | null,
  register: readonly CompanyDevice[],
): ImportedDevicesForHandover {
  if (!result) return { devices: [], stillInStock: 0 };

  const byId = new Map(register.map((device) => [device.id, device]));
  const listed = new Map<string, CompanyDevice>();

  for (const outcome of result.outcomes) {
    if (outcome.result !== "imported" || outcome.issuedTo !== null || !outcome.deviceId) continue;
    // A row the register no longer holds is left out rather than drawn from the outcome: every button
    // in the list acts on the register, and one against a device it cannot find would be refused.
    const device = byId.get(outcome.deviceId);
    if (device && !listed.has(device.id)) listed.set(device.id, device);
  }

  const devices = [...listed.values()];
  return { devices, stillInStock: devices.filter((device) => device.status === "in_stock").length };
}
