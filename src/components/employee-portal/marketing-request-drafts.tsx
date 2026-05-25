"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CalendarDays,
  CircleDollarSign,
  FileCheck2,
  ListChecks,
  Megaphone,
  PackagePlus,
  RefreshCcw,
  Save,
  Trash2,
  Upload,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { calculateMarketingRoiPreview } from "@/lib/marketing-requests/roi";
import type {
  MarketingApprovedRequestRow,
  MarketingCustomer,
  MarketingProduct,
  MarketingRequest,
  MarketingRequestType,
} from "@/lib/marketing-requests/types";

type DraftWorkspacePayload = {
  approvedRequests: MarketingApprovedRequestRow[];
  customers: MarketingCustomer[];
  drafts: MarketingRequest[];
  products: MarketingProduct[];
  requestTypes: MarketingRequestType[];
  requesterLineId: number | null;
  requesterLineName: string | null;
};

type ProductLine = {
  key: string;
  productId: string;
  quantity: string;
};

const todayDate = new Date().toISOString().slice(0, 10);

function egp(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

function fieldNumber(value: string) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function Field({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-2 block text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
        {label}
      </span>
      {children}
    </label>
  );
}

function SelectField({
  children,
  disabled,
  onChange,
  value,
}: {
  children: ReactNode;
  disabled?: boolean;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <select
      className="h-12 w-full rounded border border-slate-200 bg-white px-4 text-sm font-bold text-slate-800 outline-none transition focus:border-orange-300 focus:ring-4 focus:ring-orange-100 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      value={value}
    >
      {children}
    </select>
  );
}

function roiBadgeVariant(status: string): "success" | "warning" | "neutral" {
  if (status === "covers_required") return "success";
  if (status === "under_target") return "warning";
  return "neutral";
}

function emptyPayload(): DraftWorkspacePayload {
  return {
    approvedRequests: [],
    customers: [],
    drafts: [],
    products: [],
    requestTypes: [],
    requesterLineId: null,
    requesterLineName: null,
  };
}

export function MarketingRequestDraftWorkspace() {
  const [workspace, setWorkspace] = useState<DraftWorkspacePayload>(emptyPayload);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<"create" | "approved">("create");
  const [uploadingEvidenceKey, setUploadingEvidenceKey] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState("");
  const [requestTypeId, setRequestTypeId] = useState("");
  const [requestDate, setRequestDate] = useState(todayDate);
  const [payDate, setPayDate] = useState("");
  const [estimatedCost, setEstimatedCost] = useState("");
  const [roiDurationMonths, setRoiDurationMonths] = useState("3");
  const [otherRequestType, setOtherRequestType] = useState("");
  const [notes, setNotes] = useState("");
  const [productLines, setProductLines] = useState<ProductLine[]>([
    { key: "line-1", productId: "", quantity: "" },
  ]);

  async function loadWorkspace() {
    try {
      const response = await fetch("/api/marketing-requests/drafts", {
        cache: "no-store",
      });
      const payload = await response.json();
      if (!response.ok) {
        setWorkspace(emptyPayload());
        setMessage(payload.message ?? "Unable to load marketing request workspace.");
        return;
      }

      setWorkspace({
        approvedRequests: payload.approvedRequests ?? [],
        customers: payload.customers ?? [],
        drafts: payload.drafts ?? [],
        products: payload.products ?? [],
        requestTypes: payload.requestTypes ?? [],
        requesterLineId: payload.requesterLineId ?? null,
        requesterLineName: payload.requesterLineName ?? null,
      });
      setCustomerId((current) => current || payload.customers?.[0]?.id || "");
      setRequestTypeId((current) => current || String(payload.requestTypes?.[0]?.id ?? ""));
    } catch {
      setWorkspace(emptyPayload());
      setMessage("Unable to load marketing request workspace.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadWorkspace();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  const selectedRequestType = useMemo(
    () => workspace.requestTypes.find((type) => String(type.id) === requestTypeId),
    [requestTypeId, workspace.requestTypes],
  );

  const productMap = useMemo(
    () => new Map(workspace.products.map((product) => [String(product.id), product])),
    [workspace.products],
  );

  const visibleProducts = workspace.products;

  const lineScopedProductIdKey = useMemo(
    () => visibleProducts.map((product) => product.id).sort((left, right) => left - right).join("|"),
    [visibleProducts],
  );

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const productIds = new Set(lineScopedProductIdKey.split("|").filter(Boolean));
      setProductLines((current) =>
        current.map((line) =>
          line.productId && !productIds.has(line.productId)
            ? { ...line, productId: "" }
            : line,
        ),
      );
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [lineScopedProductIdKey]);

  const roiPreview = useMemo(() => {
    const products = productLines
      .map((line) => {
        const product = productMap.get(line.productId);
        if (!product) return null;
        return {
          factoryPrice: product.factoryPrice,
          productId: product.id,
          productName: product.productName,
          quantity: fieldNumber(line.quantity),
        };
      })
      .filter((line): line is NonNullable<typeof line> => Boolean(line));

    return calculateMarketingRoiPreview({
      estimatedCost: fieldNumber(estimatedCost),
      products,
    });
  }, [estimatedCost, productLines, productMap]);

  const productLineMetrics = useMemo(() => {
    return productLines
      .map((line) => {
        const product = productMap.get(line.productId);
        if (!product) return null;
        const quantity = fieldNumber(line.quantity);
        const expectedValue = quantity * product.factoryPrice;
        return {
          expectedValue,
          factoryPrice: product.factoryPrice,
          key: line.key,
          productId: product.id,
          productName: product.productName,
          quantity,
          valueShare: roiPreview.expectedRoiValue > 0 ? expectedValue / roiPreview.expectedRoiValue : 0,
        };
      })
      .filter((line): line is NonNullable<typeof line> => Boolean(line));
  }, [productLines, productMap, roiPreview.expectedRoiValue]);

  const canSave =
    !isSaving &&
    Boolean(customerId && requestTypeId && requestDate && roiDurationMonths && fieldNumber(estimatedCost) > 0) &&
    roiPreview.products.some((product) => product.quantity > 0) &&
    (!selectedRequestType?.requiresDescription || otherRequestType.trim().length > 0);

  function updateProductLine(key: string, patch: Partial<ProductLine>) {
    setProductLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  }

  function addProductLine() {
    setProductLines((current) => [
      ...current,
      {
        key: `line-${Date.now()}`,
        productId: "",
        quantity: "",
      },
    ]);
  }

  function removeProductLine(key: string) {
    setProductLines((current) =>
      current.length === 1 ? current : current.filter((line) => line.key !== key),
    );
  }

  async function submitDraft(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    if (!canSave) {
      setMessage("Complete the draft fields before saving.");
      return;
    }

    const products = productLines
      .filter((line) => line.productId && fieldNumber(line.quantity) > 0)
      .map((line) => ({
        productId: Number(line.productId),
        quantity: fieldNumber(line.quantity),
      }));

    setIsSaving(true);
    try {
      const response = await fetch("/api/marketing-requests/drafts", {
        body: JSON.stringify({
          customerId,
          estimatedCost: fieldNumber(estimatedCost),
          lineId: workspace.requesterLineId,
          notes,
          otherRequestType,
          payDate: payDate || null,
          products,
          requestDate,
          requestTypeId: Number(requestTypeId),
          roiDurationMonths: Number(roiDurationMonths),
        }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.message ?? "Unable to save draft.");
        return;
      }

      setWorkspace((current) => ({
        ...current,
        drafts: [payload.draft as MarketingRequest, ...current.drafts],
      }));
      setMessage("Draft saved.");
      setEstimatedCost("");
      setNotes("");
      setOtherRequestType("");
      setPayDate("");
      setProductLines([{ key: "line-1", productId: "", quantity: "" }]);
    } catch {
      setMessage("Unable to save draft.");
    } finally {
      setIsSaving(false);
    }
  }

  async function uploadFinanceEvidence(
    requestId: string,
    evidenceType: "money_transfer_proof" | "invoice",
    file: File | null | undefined,
  ) {
    if (!file) return;
    const uploadKey = `${requestId}:${evidenceType}`;
    setUploadingEvidenceKey(uploadKey);
    setMessage(null);

    const formData = new FormData();
    formData.append("requestId", requestId);
    formData.append("evidenceType", evidenceType);
    formData.append("file", file);

    try {
      const response = await fetch("/api/marketing-requests/finance-evidence", {
        body: formData,
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.message ?? "Unable to upload finance evidence.");
        return;
      }

      setWorkspace((current) => ({
        ...current,
        approvedRequests: current.approvedRequests.map((row) =>
          row.id === requestId ? payload.row as MarketingApprovedRequestRow : row,
        ),
      }));
      setMessage(evidenceType === "money_transfer_proof" ? "Money transfer proof uploaded." : "Invoice uploaded.");
    } catch {
      setMessage("Unable to upload finance evidence.");
    } finally {
      setUploadingEvidenceKey(null);
    }
  }

  return (
    <div className="space-y-6">
      <Card className="rounded border border-slate-200 bg-white p-4 shadow-[0_18px_44px_rgba(15,23,42,0.06)] sm:p-5">
        <div className="grid gap-3 md:grid-cols-4">
          <div className="rounded border border-orange-100 bg-orange-50 px-4 py-3">
            <p className="text-[11px] font-black uppercase tracking-[0.16em] text-orange-600">
              Drafts
            </p>
            <p className="mt-1 text-2xl font-black text-slate-950">{workspace.drafts.length}</p>
          </div>
          <div className="rounded border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
              Customers
            </p>
            <p className="mt-1 text-2xl font-black text-slate-950">{workspace.customers.length}</p>
          </div>
          <div className="rounded border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
              Products
            </p>
            <p className="mt-1 text-2xl font-black text-slate-950">{workspace.products.length}</p>
          </div>
          <button
            className="flex min-h-[78px] items-center justify-center gap-2 rounded border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-700 shadow-sm transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700"
            onClick={() => {
              setIsLoading(true);
              setMessage(null);
              void loadWorkspace();
            }}
            type="button"
          >
            {isLoading ? <LoadingSpinner /> : <RefreshCcw className="h-4 w-4" />}
            Refresh
          </button>
        </div>
      </Card>

      {message ? (
        <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900">
          {message}
        </div>
      ) : null}

      <Card className="rounded border border-slate-200 bg-white p-2 shadow-[0_16px_38px_rgba(15,23,42,0.06)]">
        <div className="grid gap-2 sm:grid-cols-2">
          <button
            className={`flex min-h-12 items-center justify-center gap-2 rounded px-4 text-sm font-black transition ${
              activeView === "create"
                ? "bg-orange-500 text-white shadow-[0_10px_24px_rgba(249,115,22,0.22)]"
                : "bg-white text-slate-600 hover:bg-slate-50"
            }`}
            onClick={() => setActiveView("create")}
            type="button"
          >
            <Megaphone className="h-4 w-4" />
            Create Request
          </button>
          <button
            className={`flex min-h-12 items-center justify-center gap-2 rounded px-4 text-sm font-black transition ${
              activeView === "approved"
                ? "bg-orange-500 text-white shadow-[0_10px_24px_rgba(249,115,22,0.22)]"
                : "bg-white text-slate-600 hover:bg-slate-50"
            }`}
            onClick={() => setActiveView("approved")}
            type="button"
          >
            <FileCheck2 className="h-4 w-4" />
            Approved Requests
          </button>
        </div>
      </Card>

      <div className={activeView === "create" ? "space-y-6" : "hidden"}>
        <Card className="overflow-hidden rounded border border-slate-200 bg-white p-0 shadow-[0_24px_60px_rgba(15,23,42,0.08)]">
          <form onSubmit={submitDraft}>
            <div className="border-b border-slate-100 bg-gradient-to-r from-white via-orange-50/60 to-white p-5 sm:p-7">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.18em] text-orange-600">
                    Create Draft
                  </p>
                  <h2 className="mt-2 text-2xl font-black tracking-tight text-slate-950 sm:text-3xl">
                    Activity request
                  </h2>
                </div>
                <Badge variant={roiBadgeVariant(roiPreview.roiStatus)}>
                  {roiPreview.roiStatus.replace(/_/g, " ")}
                </Badge>
              </div>
            </div>

            <div className="grid gap-5 p-5 sm:p-7 lg:grid-cols-6">
              <div className="lg:col-span-3">
                <Field label="Customer">
                  <SelectField disabled={isLoading || workspace.customers.length === 0} onChange={setCustomerId} value={customerId}>
                    <option value="">Select customer</option>
                    {workspace.customers.map((customer) => (
                      <option key={customer.id} value={customer.id}>
                        {customer.displayName} - {customer.customerType}
                      </option>
                    ))}
                  </SelectField>
                </Field>
              </div>

              <div className="lg:col-span-3">
                <Field label="Request Type">
                  <SelectField disabled={isLoading || workspace.requestTypes.length === 0} onChange={setRequestTypeId} value={requestTypeId}>
                    <option value="">Select type</option>
                    {workspace.requestTypes.map((type) => (
                      <option key={type.id} value={type.id}>
                        {type.name}
                      </option>
                    ))}
                  </SelectField>
                </Field>
              </div>

              {selectedRequestType?.requiresDescription ? (
                <div className="lg:col-span-6">
                  <Field label="Other Type Description">
                    <Input
                      className="h-12 rounded border-slate-200 bg-white"
                      onChange={(event) => setOtherRequestType(event.target.value)}
                      placeholder="Describe the request type"
                      value={otherRequestType}
                    />
                  </Field>
                </div>
              ) : null}

              <div className="lg:col-span-2">
                <Field label="Request Date">
                  <Input
                    className="h-12 rounded border-slate-200 bg-white"
                    onChange={(event) => setRequestDate(event.target.value)}
                    type="date"
                    value={requestDate}
                  />
                </Field>
              </div>

              <div className="lg:col-span-2">
                <Field label="Pay Date">
                  <Input
                    className="h-12 rounded border-slate-200 bg-white"
                    onChange={(event) => setPayDate(event.target.value)}
                    type="date"
                    value={payDate}
                  />
                </Field>
              </div>

              <div className="lg:col-span-2">
                <Field label="ROI Duration">
                  <Input
                    className="h-12 rounded border-slate-200 bg-white"
                    min="1"
                    onChange={(event) => setRoiDurationMonths(event.target.value)}
                    type="number"
                    value={roiDurationMonths}
                  />
                </Field>
              </div>

              <div className="lg:col-span-3">
                <Field label="Estimated Cost">
                  <Input
                    className="h-12 rounded border-slate-200 bg-white"
                    min="0"
                    onChange={(event) => setEstimatedCost(event.target.value)}
                    placeholder="EGP"
                    type="number"
                    value={estimatedCost}
                  />
                </Field>
              </div>

              <div className="lg:col-span-6">
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
                        Products
                      </p>
                      <p className="mt-1 text-xs font-bold text-slate-500">
                        {workspace.requesterLineId === null
                          ? "Showing available products."
                          : `Showing your assigned line products${workspace.requesterLineName ? `: ${workspace.requesterLineName}` : ""}.`}
                      </p>
                    </div>
                    <Button
                      className="gap-2 rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                      onClick={addProductLine}
                      type="button"
                    >
                      <PackagePlus className="h-4 w-4" />
                      Add Product
                    </Button>
                  </div>

                  {productLines.map((line) => {
                    const product = productMap.get(line.productId);
                    return (
                      <div className="rounded border border-slate-200 bg-slate-50 p-3" key={line.key}>
                        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_130px_130px_150px_90px_44px]">
                          <SelectField
                            disabled={visibleProducts.length === 0}
                            onChange={(value) => updateProductLine(line.key, { productId: value })}
                            value={line.productId}
                          >
                            <option value="">
                              {visibleProducts.length === 0 ? "No products for your assigned line" : "Select product"}
                            </option>
                            {visibleProducts.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.productName} - {egp(item.factoryPrice)}
                              </option>
                            ))}
                          </SelectField>
                          <Input
                            className="h-12 rounded border-slate-200 bg-white"
                            min="0"
                            onChange={(event) => updateProductLine(line.key, { quantity: event.target.value })}
                            placeholder="Qty"
                            type="number"
                            value={line.quantity}
                          />
                          <ReadOnlyValue label="Unit Price" value={product ? egp(product.factoryPrice) : "-"} />
                          <ReadOnlyValue label="Value" value={product ? egp(fieldNumber(line.quantity) * product.factoryPrice) : "-"} />
                          <ReadOnlyValue
                            label="Share"
                            value={product && roiPreview.expectedRoiValue > 0
                              ? `${Math.round((fieldNumber(line.quantity) * product.factoryPrice / roiPreview.expectedRoiValue) * 100)}%`
                              : "0%"}
                          />
                          <button
                            aria-label="Remove product"
                            className="flex h-12 w-full items-center justify-center rounded border border-slate-200 bg-white text-slate-500 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600"
                            onClick={() => removeProductLine(line.key)}
                            type="button"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="lg:col-span-6">
                <Field label="Note">
                  <textarea
                    className="min-h-28 w-full rounded border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-orange-300 focus:ring-4 focus:ring-orange-100"
                    onChange={(event) => setNotes(event.target.value)}
                    placeholder="Optional request note"
                    value={notes}
                  />
                </Field>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-100 bg-slate-50 px-5 py-5 sm:px-7">
              <div className="flex min-w-0 items-center gap-3 text-sm font-black text-slate-800">
                <CircleDollarSign className="h-5 w-5 shrink-0 text-orange-500" />
                <span>Required ROI: {egp(roiPreview.requiredRoiValue)}</span>
              </div>
              <Button
                className="min-h-12 min-w-[210px] gap-2 rounded bg-orange-500 px-6 text-white hover:bg-orange-600"
                disabled={!canSave}
                type="submit"
              >
                {isSaving ? <LoadingSpinner className="text-white" /> : <Save className="h-4 w-4" />}
                Save Draft
              </Button>
            </div>
          </form>
        </Card>

        <div className="space-y-6">
          <Card className="rounded border border-slate-200 bg-white p-5 shadow-[0_20px_48px_rgba(15,23,42,0.07)]">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded bg-orange-50 text-orange-600 ring-1 ring-orange-100">
                <Megaphone className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-black text-slate-950">ROI Preview</p>
                <p className="text-xs font-semibold text-slate-500">Server recalculates on save</p>
              </div>
            </div>
            <div className="mt-5 grid gap-3 md:grid-cols-4">
              <Metric label="Estimated Cost" value={egp(fieldNumber(estimatedCost))} />
              <Metric label="Required ROI" value={egp(roiPreview.requiredRoiValue)} />
              <Metric label="Expected ROI" value={egp(roiPreview.expectedRoiValue)} />
              <Metric label="Coverage" value={`${Math.round(roiPreview.roiCoverageRatio * 100)}%`} />
            </div>
            <div className="mt-5 overflow-hidden rounded border border-slate-200">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                  <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-[0.12em] text-slate-500">
                    <tr>
                      <th className="px-4 py-3">Product</th>
                      <th className="px-4 py-3 text-right">Quantity</th>
                      <th className="px-4 py-3 text-right">Unit Price</th>
                      <th className="px-4 py-3 text-right">ROI Value</th>
                      <th className="px-4 py-3 text-right">Share</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {productLineMetrics.map((product) => (
                      <tr key={product.key}>
                        <td className="px-4 py-3 font-black text-slate-950">{product.productName}</td>
                        <td className="px-4 py-3 text-right font-semibold text-slate-700">{product.quantity}</td>
                        <td className="px-4 py-3 text-right font-semibold text-slate-700">{egp(product.factoryPrice)}</td>
                        <td className="px-4 py-3 text-right font-black text-slate-950">{egp(product.expectedValue)}</td>
                        <td className="px-4 py-3 text-right font-black text-orange-700">{Math.round(product.valueShare * 100)}%</td>
                      </tr>
                    ))}
                    {productLineMetrics.length === 0 ? (
                      <tr>
                        <td className="px-4 py-8 text-center text-sm font-semibold text-slate-500" colSpan={5}>
                          Add product quantities to preview ROI by product.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>
          </Card>

          <Card className="rounded border border-slate-200 bg-white p-5 shadow-[0_20px_48px_rgba(15,23,42,0.07)]">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded bg-slate-50 text-slate-600 ring-1 ring-slate-200">
                <ListChecks className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-black text-slate-950">Draft Rows</p>
                <p className="text-xs font-semibold text-slate-500">Latest 100 visible drafts</p>
              </div>
            </div>
            <div className="mt-5 space-y-3">
              {workspace.drafts.slice(0, 6).map((draft) => (
                <div className="rounded border border-slate-100 bg-slate-50 p-3" key={draft.id}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="whitespace-nowrap font-mono text-xs font-bold text-slate-600">{draft.requestCode}</p>
                      <p className="mt-1 text-sm font-black text-slate-950">{egp(draft.estimatedCost)}</p>
                    </div>
                    <Badge variant={roiBadgeVariant(draft.roiStatus)}>
                      {draft.roiStatus.replace(/_/g, " ")}
                    </Badge>
                  </div>
                  <p className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-slate-500">
                    <CalendarDays className="h-3.5 w-3.5" />
                    {draft.requestDate}
                  </p>
                </div>
              ))}
              {!isLoading && workspace.drafts.length === 0 ? (
                <p className="rounded border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm font-semibold text-slate-500">
                  No draft rows yet.
                </p>
              ) : null}
            </div>
          </Card>
        </div>
      </div>

      <div className={activeView === "approved" ? "space-y-6" : "hidden"}>
        <Card className="overflow-hidden rounded border border-slate-200 bg-white shadow-[0_20px_48px_rgba(15,23,42,0.07)]">
          <div className="border-b border-slate-100 bg-slate-50 px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.18em] text-orange-600">
                  Employee Portal
                </p>
                <h2 className="mt-1 text-xl font-black tracking-tight text-slate-950">
                  Approved Requests
                </h2>
              </div>
              <Badge variant="neutral">{workspace.approvedRequests.length} rows</Badge>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1180px] border-collapse text-left text-sm">
              <thead className="bg-slate-100 text-[11px] font-black uppercase tracking-[0.12em] text-slate-600">
                <tr>
                  <th className="px-4 py-3">Money Transfer Date</th>
                  <th className="px-4 py-3">Line</th>
                  <th className="px-4 py-3">Contact For Money Transfer</th>
                  <th className="px-4 py-3">Customer Name</th>
                  <th className="px-4 py-3">Notes</th>
                  <th className="px-4 py-3 text-right">Sum Of Amount</th>
                  <th className="px-4 py-3">Transfer Proof</th>
                  <th className="px-4 py-3">Invoice</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {workspace.approvedRequests.map((row) => (
                  <tr key={row.id} className="align-top">
                    <td className="whitespace-nowrap px-4 py-3 font-semibold text-slate-700">
                      {row.moneyTransferDate ?? "-"}
                    </td>
                    <td className="px-4 py-3 font-semibold text-slate-700">{row.line ?? "-"}</td>
                    <td className="px-4 py-3">
                      <p className="font-black text-slate-950">{row.contactForMoneyTransfer}</p>
                      <p className="mt-1 font-mono text-[11px] font-semibold text-slate-500">{row.requesterHrId}</p>
                    </td>
                    <td className="px-4 py-3 font-black text-slate-950">{row.customerName}</td>
                    <td className="max-w-[260px] px-4 py-3 text-slate-600">
                      <p className="line-clamp-3">{row.notes || "-"}</p>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right font-black text-slate-950">
                      {egp(row.sumOfAmount)}
                    </td>
                    <td className="px-4 py-3">
                      <EvidenceUpload
                        accept="image/jpeg,image/png,image/webp"
                        fileName={row.financeProofFileName}
                        isUploading={uploadingEvidenceKey === `${row.id}:money_transfer_proof`}
                        label="Upload proof"
                        onUpload={(file) => void uploadFinanceEvidence(row.id, "money_transfer_proof", file)}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <EvidenceUpload
                        accept="image/jpeg,image/png,image/webp,application/pdf"
                        fileName={row.invoiceFileName}
                        isUploading={uploadingEvidenceKey === `${row.id}:invoice`}
                        label="Upload invoice"
                        onUpload={(file) => void uploadFinanceEvidence(row.id, "invoice", file)}
                      />
                    </td>
                  </tr>
                ))}
                {!isLoading && workspace.approvedRequests.length === 0 ? (
                  <tr>
                    <td className="px-4 py-10 text-center text-sm font-semibold text-slate-500" colSpan={8}>
                      No approved requests are available yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {workspace.customers.length === 0 || workspace.products.length === 0 ? (
        <div className="rounded border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-600">
          {workspace.customers.length === 0
            ? "No active marketing customers are available yet. Customer creation is the next UI slice."
            : "No active marketing products are available yet. Run the reference-data seed before saving real drafts."}
        </div>
      ) : null}
    </div>
  );
}

function Metric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded border border-slate-100 bg-slate-50 px-3 py-2">
      <span className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">{label}</span>
      <span className="text-sm font-black text-slate-950">{value}</span>
    </div>
  );
}

function EvidenceUpload({
  accept,
  fileName,
  isUploading,
  label,
  onUpload,
}: {
  accept: string;
  fileName: string | null;
  isUploading: boolean;
  label: string;
  onUpload: (file: File | null | undefined) => void;
}) {
  return (
    <label className="flex min-w-[150px] cursor-pointer flex-col gap-2 rounded border border-slate-200 bg-slate-50 px-3 py-2 transition hover:border-orange-200 hover:bg-orange-50">
      <span className="flex items-center gap-2 text-xs font-black text-slate-700">
        {isUploading ? <LoadingSpinner /> : <Upload className="h-3.5 w-3.5 text-orange-600" />}
        {isUploading ? "Uploading..." : label}
      </span>
      <span className="whitespace-nowrap text-[11px] font-semibold text-slate-500">
        {fileName ?? "No file yet"}
      </span>
      <input
        accept={accept}
        className="sr-only"
        disabled={isUploading}
        onChange={(event) => {
          onUpload(event.target.files?.[0]);
          event.currentTarget.value = "";
        }}
        type="file"
      />
    </label>
  );
}

function ReadOnlyValue({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex h-12 min-w-0 flex-col justify-center rounded border border-slate-200 bg-white px-3">
      <span className="whitespace-nowrap text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">{label}</span>
      <span className="whitespace-nowrap text-sm font-black text-slate-800">{value}</span>
    </div>
  );
}
