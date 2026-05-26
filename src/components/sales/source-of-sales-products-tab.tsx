"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Edit3,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import { AdminCallout, AdminTableShell } from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency, formatNumber } from "@/lib/sales/format";
import type {
  SourceOfSalesProduct,
  SourceOfSalesProductInput,
} from "@/lib/sales/monthly-distributor-import";

type ProductFormState = {
  active: boolean;
  factoryPrice: string;
  family: string;
  familyCode: string;
  line: string;
  productCode: string;
  productName: string;
  source: string;
  sourceFile: string;
  sourceRowNumber: string;
  sourceSheet: string;
};

type ProductResponse = {
  data?: SourceOfSalesProduct;
  error?: string;
  success: boolean;
};

type ProductListResponse = {
  data?: SourceOfSalesProduct[];
  error?: string;
  success: boolean;
};

type ProductModalState =
  | {
      mode: "create";
      productCode?: undefined;
    }
  | {
      mode: "edit";
      productCode: string;
    };

const emptyProductForm: ProductFormState = {
  active: true,
  factoryPrice: "",
  family: "",
  familyCode: "",
  line: "",
  productCode: "",
  productName: "",
  source: "",
  sourceFile: "Manual Entry",
  sourceRowNumber: "",
  sourceSheet: "Products",
};

const tableHeaderClassName = "px-4 py-3 text-xs font-black uppercase tracking-[0.14em] text-[#64748B]";
const tableCellClassName = "px-4 py-3 align-top";

function sortProducts(products: SourceOfSalesProduct[]) {
  return [...products].sort(
    (left, right) =>
      left.line.localeCompare(right.line) ||
      left.productName.localeCompare(right.productName) ||
      left.productCode.localeCompare(right.productCode),
  );
}

function productToForm(product: SourceOfSalesProduct): ProductFormState {
  return {
    active: product.active,
    factoryPrice: String(product.factoryPrice),
    family: product.family,
    familyCode: product.familyCode,
    line: product.line,
    productCode: product.productCode,
    productName: product.productName,
    source: product.source,
    sourceFile: product.sourceFile,
    sourceRowNumber: product.sourceRowNumber ? String(product.sourceRowNumber) : "",
    sourceSheet: product.sourceSheet,
  };
}

function formToProductInput(form: ProductFormState): SourceOfSalesProductInput {
  return {
    active: form.active,
    factoryPrice: form.factoryPrice,
    family: form.family,
    familyCode: form.familyCode,
    line: form.line,
    productCode: form.productCode,
    productName: form.productName,
    source: form.source,
    sourceFile: form.sourceFile,
    sourceRowNumber: form.sourceRowNumber || null,
    sourceSheet: form.sourceSheet,
  };
}

function productMatchesSearch(product: SourceOfSalesProduct, search: string) {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return [
    product.productCode,
    product.productName,
    product.family,
    product.familyCode,
    product.line,
    product.source,
  ].some((value) => value.toLowerCase().includes(needle));
}

function ProductField({
  disabled,
  label,
  onChange,
  required = false,
  type = "text",
  value,
}: {
  disabled?: boolean;
  label: string;
  onChange: (value: string) => void;
  required?: boolean;
  type?: "number" | "text";
  value: string;
}) {
  return (
    <label className="space-y-1.5">
      <span className="text-xs font-bold uppercase tracking-[0.16em] text-[#64748B]">
        {label}{required ? " *" : ""}
      </span>
      <Input
        className="h-11 rounded-2xl border-[#D8E0EA] bg-[#F8FAFC] font-semibold text-[#0F172A] focus-visible:outline-[#F97316]"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        required={required}
        type={type}
        value={value}
      />
    </label>
  );
}

function ProductModal({
  form,
  modal,
  onChange,
  onClose,
  onSubmit,
  saving,
}: {
  form: ProductFormState;
  modal: ProductModalState;
  onChange: (next: ProductFormState) => void;
  onClose: () => void;
  onSubmit: () => void;
  saving: boolean;
}) {
  const title = modal.mode === "create" ? "Add Product" : "Edit Product";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4">
      <div
        aria-modal="true"
        className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-3xl border border-[#D8E0EA] bg-white shadow-[0_28px_90px_rgba(15,23,42,0.28)]"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-[#E2E8F0] px-5 py-4">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-orange-600">
              Product Reference
            </p>
            <h2 className="mt-1 text-xl font-black tracking-tight text-[#0F172A]">{title}</h2>
          </div>
          <Button className="h-9 w-9 rounded-xl p-0" disabled={saving} onClick={onClose} variant="secondary">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="grid gap-4 p-5 md:grid-cols-2">
          <ProductField
            label="Product Code"
            onChange={(value) => onChange({ ...form, productCode: value })}
            required
            value={form.productCode}
          />
          <ProductField
            label="Product Name"
            onChange={(value) => onChange({ ...form, productName: value })}
            required
            value={form.productName}
          />
          <ProductField
            label="Factory Price"
            onChange={(value) => onChange({ ...form, factoryPrice: value })}
            required
            type="number"
            value={form.factoryPrice}
          />
          <ProductField
            label="Line"
            onChange={(value) => onChange({ ...form, line: value })}
            required
            value={form.line}
          />
          <ProductField
            label="Family"
            onChange={(value) => onChange({ ...form, family: value })}
            required
            value={form.family}
          />
          <ProductField
            label="Family Code"
            onChange={(value) => onChange({ ...form, familyCode: value })}
            required
            value={form.familyCode}
          />
          <ProductField
            label="Source"
            onChange={(value) => onChange({ ...form, source: value })}
            required
            value={form.source}
          />
          <ProductField
            label="Source Row Number"
            onChange={(value) => onChange({ ...form, sourceRowNumber: value })}
            type="number"
            value={form.sourceRowNumber}
          />
          <ProductField
            label="Source File"
            onChange={(value) => onChange({ ...form, sourceFile: value })}
            value={form.sourceFile}
          />
          <ProductField
            label="Source Sheet"
            onChange={(value) => onChange({ ...form, sourceSheet: value })}
            value={form.sourceSheet}
          />
          <label className="flex min-h-11 items-center gap-3 rounded-2xl border border-[#D8E0EA] bg-[#F8FAFC] px-3.5 md:col-span-2">
            <input
              checked={form.active}
              className="h-4 w-4 accent-orange-600"
              onChange={(event) => onChange({ ...form, active: event.target.checked })}
              type="checkbox"
            />
            <span className="text-sm font-semibold text-[#0F172A]">Active product reference</span>
          </label>
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-[#E2E8F0] px-5 py-4 sm:flex-row sm:justify-end">
          <Button disabled={saving} onClick={onClose} variant="secondary">
            Cancel
          </Button>
          <Button className="gap-2 bg-[#0B0B0B] text-white hover:bg-[#F97316]" disabled={saving} onClick={onSubmit}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Save Product
          </Button>
        </div>
      </div>
    </div>
  );
}

async function readJsonResponse<T extends ProductListResponse | ProductResponse>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) return { success: response.ok, error: response.ok ? undefined : response.statusText } as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return { success: false, error: text } as T;
  }
}

export function SourceOfSalesProductsTab({
  initialProducts,
  onProductsChange,
}: {
  initialProducts: SourceOfSalesProduct[];
  onProductsChange?: (count: number) => void;
}) {
  const [products, setProducts] = useState(() => sortProducts(initialProducts));
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState<ProductModalState | null>(null);
  const [form, setForm] = useState<ProductFormState>(emptyProductForm);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [deleteLoadingCode, setDeleteLoadingCode] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; type: "error" | "success" } | null>(null);

  const filteredProducts = useMemo(
    () => products.filter((product) => productMatchesSearch(product, search)),
    [products, search],
  );

  async function reloadProducts() {
    setRefreshing(true);
    try {
      const response = await fetch("/api/sales/source-of-sales/products", { cache: "no-store" });
      const payload = await readJsonResponse<ProductListResponse>(response);
      if (payload.success) {
        const nextProducts = sortProducts(payload.data ?? []);
        setProducts(nextProducts);
        onProductsChange?.(nextProducts.length);
      } else {
        setMessage({ type: "error", text: payload.error ?? "Failed to refresh products." });
      }
    } catch (caught) {
      setMessage({ type: "error", text: caught instanceof Error ? caught.message : "Failed to refresh products." });
    } finally {
      setRefreshing(false);
    }
  }

  function openCreateModal() {
    setForm(emptyProductForm);
    setModal({ mode: "create" });
    setMessage(null);
  }

  function openEditModal(product: SourceOfSalesProduct) {
    setForm(productToForm(product));
    setModal({ mode: "edit", productCode: product.productCode });
    setMessage(null);
  }

  async function saveProduct() {
    if (!modal) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(
        modal.mode === "create"
          ? "/api/sales/source-of-sales/products"
          : `/api/sales/source-of-sales/products/${encodeURIComponent(modal.productCode)}`,
        {
          body: JSON.stringify(formToProductInput(form)),
          headers: { "Content-Type": "application/json" },
          method: modal.mode === "create" ? "POST" : "PATCH",
        },
      );
      const payload = await readJsonResponse<ProductResponse>(response);
      if (!payload.success || !payload.data) {
        setMessage({ type: "error", text: payload.error ?? "Product save failed." });
        return;
      }

      setProducts((current) => {
        const withoutPrevious = current.filter((product) =>
          product.productCode !== (modal.mode === "edit" ? modal.productCode : payload.data?.productCode),
        );
        const nextProducts = sortProducts([...withoutPrevious, payload.data as SourceOfSalesProduct]);
        onProductsChange?.(nextProducts.length);
        return nextProducts;
      });
      setMessage({
        type: "success",
        text: modal.mode === "create" ? "Product added." : "Product updated.",
      });
      setModal(null);
    } catch (caught) {
      setMessage({ type: "error", text: caught instanceof Error ? caught.message : "Product save failed." });
    } finally {
      setSaving(false);
    }
  }

  async function deleteProduct(product: SourceOfSalesProduct) {
    if (!window.confirm(`Delete product "${product.productName}" (${product.productCode})?`)) return;

    setDeleteLoadingCode(product.productCode);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/sales/source-of-sales/products/${encodeURIComponent(product.productCode)}`,
        { method: "DELETE" },
      );
      const payload = await readJsonResponse<ProductResponse>(response);
      if (payload.success) {
        setProducts((current) => {
          const nextProducts = current.filter((row) => row.productCode !== product.productCode);
          onProductsChange?.(nextProducts.length);
          return nextProducts;
        });
        setMessage({ type: "success", text: "Product deleted." });
      } else {
        setMessage({ type: "error", text: payload.error ?? "Product delete failed." });
      }
    } catch (caught) {
      setMessage({ type: "error", text: caught instanceof Error ? caught.message : "Product delete failed." });
    } finally {
      setDeleteLoadingCode(null);
    }
  }

  return (
    <div className="space-y-5">
      {message ? (
        <AdminCallout tone={message.type === "success" ? "success" : "danger"}>
          {message.type === "success" ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4" />
          )}
          <p>{message.text}</p>
        </AdminCallout>
      ) : null}

      <AdminTableShell
        action={(
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button className="gap-2" disabled={refreshing} onClick={() => void reloadProducts()} variant="secondary">
              {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </Button>
            <Button className="gap-2 bg-[#0B0B0B] text-white hover:bg-[#F97316]" onClick={openCreateModal}>
              <Plus className="h-4 w-4" />
              Add Product
            </Button>
          </div>
        )}
        description="Product reference rows stored in Supabase Source of Sales."
        title="Products Reference"
      >
        <div className="border-b border-[#E2E8F0] p-4 md:p-5">
          <label className="relative block max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#64748B]" />
            <Input
              className="h-11 rounded-2xl border-[#D8E0EA] bg-[#F8FAFC] pl-10 font-semibold text-[#0F172A]"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search products..."
              value={search}
            />
          </label>
        </div>
        <div className="overflow-x-auto p-4 md:p-5">
          <div className="overflow-hidden rounded-[16px] border border-[#E2E8F0]">
            <table className="w-full min-w-[1680px] text-left text-sm">
              <thead className="bg-[#F8FAFC]">
                <tr>
                  <th className={tableHeaderClassName}>Product Code</th>
                  <th className={tableHeaderClassName}>Product Name</th>
                  <th className={tableHeaderClassName}>Normalized Product Name</th>
                  <th className={tableHeaderClassName}>Factory Price</th>
                  <th className={tableHeaderClassName}>Family</th>
                  <th className={tableHeaderClassName}>Family Code</th>
                  <th className={tableHeaderClassName}>Source</th>
                  <th className={tableHeaderClassName}>Line</th>
                  <th className={tableHeaderClassName}>Normalized Line</th>
                  <th className={tableHeaderClassName}>Source File</th>
                  <th className={tableHeaderClassName}>Source Sheet</th>
                  <th className={tableHeaderClassName}>Source Row</th>
                  <th className={tableHeaderClassName}>Active</th>
                  <th className={tableHeaderClassName}>Created</th>
                  <th className={tableHeaderClassName}>Updated</th>
                  <th className={tableHeaderClassName}>Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E2E8F0]">
                {filteredProducts.map((product) => {
                  const deleting = deleteLoadingCode === product.productCode;
                  return (
                    <tr className="text-[#64748B]" key={product.productCode}>
                      <td className={`${tableCellClassName} font-black text-[#0F172A]`}>{product.productCode}</td>
                      <td className={`${tableCellClassName} font-semibold text-[#0F172A]`}>{product.productName}</td>
                      <td className={tableCellClassName}>{product.normalizedProductName}</td>
                      <td className={tableCellClassName}>{formatCurrency(product.factoryPrice)}</td>
                      <td className={tableCellClassName}>{product.family}</td>
                      <td className={tableCellClassName}>{product.familyCode}</td>
                      <td className={tableCellClassName}>{product.source}</td>
                      <td className={tableCellClassName}>{product.line}</td>
                      <td className={tableCellClassName}>{product.normalizedLine}</td>
                      <td className={tableCellClassName}>{product.sourceFile}</td>
                      <td className={tableCellClassName}>{product.sourceSheet}</td>
                      <td className={tableCellClassName}>
                        {product.sourceRowNumber ? formatNumber(product.sourceRowNumber) : "-"}
                      </td>
                      <td className={tableCellClassName}>
                        <Badge variant={product.active ? "success" : "neutral"}>
                          {product.active ? "Active" : "Inactive"}
                        </Badge>
                      </td>
                      <td className={tableCellClassName}>
                        {product.createdAt ? new Date(product.createdAt).toLocaleString() : "-"}
                      </td>
                      <td className={tableCellClassName}>
                        {product.updatedAt ? new Date(product.updatedAt).toLocaleString() : "-"}
                      </td>
                      <td className={tableCellClassName}>
                        <div className="flex gap-2">
                          <Button className="h-9 gap-1 px-3" onClick={() => openEditModal(product)} variant="secondary">
                            <Edit3 className="h-3.5 w-3.5" />
                            Edit
                          </Button>
                          <Button
                            className="h-9 gap-1 px-3"
                            disabled={deleting}
                            onClick={() => void deleteProduct(product)}
                            variant="destructive"
                          >
                            {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                            Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {filteredProducts.length === 0 ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-sm font-semibold text-[#64748B]" colSpan={16}>
                      No products found.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </AdminTableShell>

      {modal ? (
        <ProductModal
          form={form}
          modal={modal}
          onChange={setForm}
          onClose={() => setModal(null)}
          onSubmit={() => void saveProduct()}
          saving={saving}
        />
      ) : null}
    </div>
  );
}
