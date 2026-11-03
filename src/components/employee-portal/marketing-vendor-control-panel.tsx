"use client";

import { useEffect, useState } from "react";

import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
  PortalSection,
} from "@/components/employee-portal/portal-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-kit";
import { LoadingSpinner } from "@/components/ui/loading-state";
import type { MarketingVendorControlRow } from "@/lib/marketing-requests/vendor-control";

/**
 * Allow or hide a marketing vendor (owner, 2026-11-03). The counts sit in the row and in the confirmation,
 * because hiding a vendor with live customers and allowing one with thousands of waiting codes are both
 * decisions that want the number in front of the person pressing.
 */

function confirmationFor(vendor: MarketingVendorControlRow, active: boolean): string {
  if (active) {
    return (
      `Allow ${vendor.name}?\n\nIt appears in the Vendor picker straight away. `
      + `${vendor.codesWaiting.toLocaleString("en-US")} waiting code(s) load at the next nightly sync, 02:47 Cairo.`
    );
  }
  return (
    `Hide ${vendor.name}?\n\nIt leaves the Vendor picker. Its ${vendor.codesLoaded.toLocaleString("en-US")} code(s) are kept.`
  );
}

function VendorState({ vendor }: { vendor: MarketingVendorControlRow }) {
  if (vendor.mergedIntoName) return <Badge variant="neutral">{`Merged into ${vendor.mergedIntoName}`}</Badge>;
  return <Badge variant={vendor.active ? "success" : "neutral"}>{vendor.active ? "Shown" : "Hidden"}</Badge>;
}

export function MarketingVendorControlPanel() {
  const [vendors, setVendors] = useState<MarketingVendorControlRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/marketing-requests/vendors", { cache: "no-store" });
        const payload = await response.json();
        if (cancelled) return;
        if (!response.ok) {
          setError(payload.message ?? "Could not read the vendors.");
          return;
        }
        setVendors(payload.vendors ?? []);
      } catch {
        if (!cancelled) setError("Could not read the vendors.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function setActive(vendor: MarketingVendorControlRow, active: boolean) {
    if (!window.confirm(confirmationFor(vendor, active))) return;
    setBusyId(vendor.id);
    setError(null);
    try {
      const response = await fetch("/api/marketing-requests/vendors", {
        body: JSON.stringify({ active, vendorId: vendor.id }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.message ?? "Could not change the vendor.");
        return;
      }
      setVendors(payload.vendors ?? []);
    } catch {
      setError("Could not change the vendor.");
    } finally {
      setBusyId(null);
    }
  }

  function action(vendor: MarketingVendorControlRow) {
    if (vendor.mergedIntoName) return <span className="text-xs font-semibold text-slate-500">Stays hidden</span>;
    if (vendor.active && vendor.customersLinked > 0) return <span className="text-xs font-semibold text-slate-500">Customers linked</span>;
    return (
      <Button disabled={busyId !== null} onClick={() => void setActive(vendor, !vendor.active)} size="sm" type="button" variant="outline">
        {busyId === vendor.id ? <LoadingSpinner /> : vendor.active ? "Hide" : "Allow"}
      </Button>
    );
  }

  return (
    <PortalSection
      actions={vendors ? <Badge variant="neutral">{`${vendors.filter((row) => row.active).length} shown of ${vendors.length}`}</Badge> : null}
      description="A new vendor from the Sales map starts hidden until you allow it. Allowing puts it in the Vendor picker; its waiting codes load at the next nightly sync. Hiding deletes nothing."
      eyebrow="Marketing Control"
      title="Vendors"
    >
      <div className="grid gap-3 p-4 sm:p-5">
        <FormError>{error}</FormError>
        {vendors === null && !error ? (
          <span className="inline-flex items-center gap-2 text-xs font-bold text-slate-500">
            <LoadingSpinner /> Loading vendors...
          </span>
        ) : null}
        {vendors ? (
          <PortalResponsiveDataList
            empty={<PortalEmptyState message="The vendor table holds no rows." title="No vendors" />}
            getKey={(vendor) => String(vendor.id)}
            items={vendors}
            renderCard={(vendor) => (
              <PortalRecordCard actions={action(vendor)} status={<VendorState vendor={vendor} />} title={vendor.name}>
                <PortalRecordFields
                  fields={[
                    { label: "Codes loaded", value: vendor.codesLoaded.toLocaleString("en-US") },
                    { label: "Codes waiting", value: vendor.codesWaiting.toLocaleString("en-US") },
                    { label: "Customers", value: vendor.customersLinked.toLocaleString("en-US") },
                  ]}
                />
              </PortalRecordCard>
            )}
            renderTable={() => (
              <PortalDesktopTable
                cols={
                  <colgroup>
                    <col className="w-[24%]" />
                    <col className="w-[20%]" />
                    <col className="w-[14%]" />
                    <col className="w-[14%]" />
                    <col className="w-[14%]" />
                    <col className="w-[14%]" />
                  </colgroup>
                }
              >
                <thead className="bg-slate-50 text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500">
                  <tr>
                    <th className="px-3 py-3">Vendor</th>
                    <th className="px-3 py-3">State</th>
                    <th className="break-words px-3 py-3 text-right">Codes loaded</th>
                    <th className="break-words px-3 py-3 text-right">Codes waiting</th>
                    <th className="break-words px-3 py-3 text-right">Customers</th>
                    <th className="px-3 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {vendors.map((vendor) => (
                    <tr className="align-top" key={vendor.id}>
                      <td className="break-words px-3 py-2 font-semibold text-slate-950">{vendor.name}</td>
                      <td className="px-3 py-2"><VendorState vendor={vendor} /></td>
                      <td className="px-3 py-2 text-right tabular-nums">{vendor.codesLoaded.toLocaleString("en-US")}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{vendor.codesWaiting.toLocaleString("en-US")}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{vendor.customersLinked.toLocaleString("en-US")}</td>
                      <td className="px-3 py-2 text-right">{action(vendor)}</td>
                    </tr>
                  ))}
                </tbody>
              </PortalDesktopTable>
            )}
          />
        ) : null}
      </div>
    </PortalSection>
  );
}
