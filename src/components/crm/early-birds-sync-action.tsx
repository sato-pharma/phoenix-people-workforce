import { EarlyBirdsSyncButton } from "@/components/crm/early-birds-sync-button";
import { resolveVendorSyncStandDown } from "@/lib/crm/cutover";

// The "Sync now" island, decided on the SERVER. Every board that shows CRM first-visit data mounts
// this rather than the button itself.
//
// Once the CRM cutover retires iReports360 the sync route answers 409 to every press, so a button
// that can only fail is worse than no button. The server asks the cutover setting and renders
// nothing. `resolveVendorSyncStandDown` fails OPEN, so an unreadable setting keeps the button, as
// before the cutover existed.
export async function EarlyBirdsSyncAction() {
  if (await resolveVendorSyncStandDown()) return null;
  return <EarlyBirdsSyncButton />;
}
