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
import { SortableTh, useSortableTable } from "@/components/ui/sortable-table";
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

// Tighter side padding on a phone, so the four columns that survive the fold keep enough room for
// the Edit / Delete buttons without a sideways scroll.
const tableCellClassName = "break-words px-2 py-3 align-top lg:px-4";

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
      <span className="text-xs font-bold uppercase tracking-[0.16em] text-phx-ink-soft">
        {label}{required ? " *" : ""}
      </span>
      <Input
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
        className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-3xl border border-phx-line bg-white shadow-[0_28px_90px_rgba(15,23,42,0.28)]"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-phx-line px-5 py-4">
          <div>
            <p className="text-phx-sm font-black uppercase tracking-[0.18em] text-orange-600">
              Product Reference
            </p>
            <h2 className="mt-1 text-xl font-black tracking-tight text-phx-ink">{title}</h2>
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
          <label className="flex min-h-11 items-center gap-3 rounded-2xl border border-phx-line bg-phx-paper px-3.5 md:col-span-2">
            <input
              checked={form.active}
              className="h-4 w-4 accent-orange-600"
              onChange={(event) => onChange({ ...form, active: event.target.checked })}
              type="checkbox"
            />
            <span className="text-sm font-semibold text-phx-ink">Active product reference</span>
          </label>
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-phx-line px-5 py-4 sm:flex-row sm:justify-end">
          <Button disabled={saving} onClick={onClose} variant="secondary">
            Cancel
          </Button>
          <Button className="gap-2 bg-[#0B0B0B] text-white hover:bg-phx-accent" disabled={saving} onClick={onSubmit}>
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
  initialSearch,
  onProductsChange,
}: {
  initialProducts: SourceOfSalesProduct[];
  /** Pre-fill the search box — used when arriving via a "fix this in Source of Sales" deep-link. */
  initialSearch?: string;
  onProductsChange?: (count: number) => void;
}) {
  const [products, setProducts] = useState(() => sortProducts(initialProducts));
  const [search, setSearch] = useState(initialSearch ?? "");
  const [modal, setModal] = useState<ProductModalState | null>(null);
  const [form, setForm] = useState<ProductFormState>(emptyProductForm);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [deleteLoadingCode, setDeleteLoadingCode] = useState<string | null>(null);
  const [deleteConfirmCode, setDeleteConfirmCode] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; type: "error" | "success" } | null>(null);

  const filteredProducts = useMemo(
    () => products.filter((product) => productMatchesSearch(product, search)),
    [products, search],
  );
  // Sort-only: the search box above already filters, so the hook gets no searchAccessors.
  // initialSort null preserves the sortProducts() default (line -> name -> code) until a click.
  const table = useSortableTable(filteredProducts, {
    columns: [
      { key: "productCode", accessor: (row) => row.productCode, type: "string" },
      { key: "productName", accessor: (row) => row.productName, type: "string" },
      { key: "normalizedProductName", accessor: (row) => row.normalizedProductName, type: "string" },
      { key: "factoryPrice", accessor: (row) => row.factoryPrice, type: "number" },
      { key: "family", accessor: (row) => row.family, type: "string" },
      { key: "familyCode", accessor: (row) => row.familyCode, type: "string" },
      { key: "source", accessor: (row) => row.source, type: "string" },
      { key: "line", accessor: (row) => row.line, type: "string" },
      { key: "normalizedLine", accessor: (row) => row.normalizedLine, type: "string" },
      { key: "sourceFile", accessor: (row) => row.sourceFile, type: "string" },
      { key: "sourceSheet", accessor: (row) => row.sourceSheet, type: "string" },
      { key: "sourceRowNumber", accessor: (row) => row.sourceRowNumber, type: "number" },
      { key: "active", accessor: (row) => (row.active ? 1 : 0), type: "number" },
      { key: "createdAt", accessor: (row) => row.createdAt, type: "date" },
      { key: "updatedAt", accessor: (row) => row.updatedAt, type: "date" },
    ],
    initialSort: null,
  });
  const thProps = { sort: table.sort, onSort: table.toggleSort, variant: "light" as const, className: "break-words px-2 text-xs lg:px-4" };

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

  function validateProductForm(f: ProductFormState): string | null {
    if (!f.productCode.trim()) return "Product Code is required.";
    if (!f.productName.trim()) return "Product Name is required.";
    if (!f.factoryPrice.trim() || isNaN(Number(f.factoryPrice))) return "Factory Price must be a valid number.";
    if (!f.line.trim()) return "Line is required.";
    if (!f.family.trim()) return "Family is required.";
    if (!f.familyCode.trim()) return "Family Code is required.";
    if (!f.source.trim()) return "Source is required.";
    return null;
  }

  async function saveProduct() {
    if (!modal) return;
    const validationError = validateProductForm(form);
    if (validationError) {
      setMessage({ type: "error", text: validationError });
      return;
    }
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
    setDeleteConfirmCode(null);
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
            <Button className="gap-2 bg-[#0B0B0B] text-white hover:bg-phx-accent" onClick={openCreateModal}>
              <Plus className="h-4 w-4" />
              Add Product
            </Button>
          </div>
        )}
        description="Product reference rows stored in Supabase Source of Sales."
        title="Products Reference"
      >
        <div className="border-b border-phx-line p-4 md:p-5">
          <label className="relative block max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-phx-ink-soft" />
            <Input
              className="pl-10"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search products..."
              value={search}
            />
          </label>
        </div>
        <div className="p-4 md:p-5">
          <div className="overflow-hidden rounded-[16px] border border-phx-line">
            {/* Sixteen columns cannot divide a screen. Each name now carries its own code or
                normalized form beneath it, the three source columns read as one, and Created +
                Updated share a cell — nine columns, none of the data dropped. Below `lg` the six
                detail columns fold away and reappear as sub-lines under the product. */}
            <table className="w-full table-fixed text-left text-sm">
              <colgroup>
                <col className="w-[34%] lg:w-[18%]" />
                <col className="w-[16%] lg:w-[9%]" />
                <col className="hidden lg:table-column lg:w-[10%]" />
                <col className="hidden lg:table-column lg:w-[8%]" />
                <col className="hidden lg:table-column lg:w-[10%]" />
                <col className="hidden lg:table-column lg:w-[14%]" />
                <col className="w-[16%] lg:w-[8%]" />
                <col className="hidden lg:table-column lg:w-[11%]" />
                <col className="w-[34%] lg:w-[12%]" />
              </colgroup>
              <thead className="bg-phx-paper">
                <tr>
                  <SortableTh label="Product" sortKey="productName" {...thProps} />
                  <SortableTh label="Factory Price" sortKey="factoryPrice" {...thProps} />
                  <SortableTh className="hidden text-xs lg:table-cell" label="Family" sortKey="family" sort={table.sort} onSort={table.toggleSort} variant="light" />
                  <SortableTh className="hidden text-xs lg:table-cell" label="Source" sortKey="source" sort={table.sort} onSort={table.toggleSort} variant="light" />
                  <SortableTh className="hidden text-xs lg:table-cell" label="Line" sortKey="line" sort={table.sort} onSort={table.toggleSort} variant="light" />
                  <SortableTh className="hidden text-xs lg:table-cell" label="Source File" sortKey="sourceFile" sort={table.sort} onSort={table.toggleSort} variant="light" />
                  <SortableTh label="Active" sortKey="active" {...thProps} />
                  <SortableTh className="hidden text-xs lg:table-cell" label="Created · Updated" sortKey="updatedAt" sort={table.sort} onSort={table.toggleSort} variant="light" />
                  <SortableTh label="Action" {...thProps} />
                </tr>
              </thead>
              <tbody className="divide-y divide-phx-line">
                {table.rows.map((product) => {
                  const deleting = deleteLoadingCode === product.productCode;
                  return (
                    <tr className="text-phx-ink-soft" key={product.productCode}>
                      <td className={tableCellClassName}>
                        <span className="block font-semibold text-phx-ink">{product.productName}</span>
                        <span className="block font-black text-xs text-phx-ink">{product.productCode}</span>
                        <span className="block text-xs">{product.normalizedProductName}</span>
                        {/* Below `lg` the folded columns come back here, so a phone loses nothing. */}
                        <span className="mt-1 block text-xs lg:hidden">
                          {[product.family, product.familyCode].filter(Boolean).join(" · ") || "—"}
                        </span>
                        <span className="block text-xs lg:hidden">
                          {[product.source, product.line, product.normalizedLine].filter(Boolean).join(" · ") || "—"}
                        </span>
                        <span className="block text-xs lg:hidden">
                          {[product.sourceFile, product.sourceSheet, product.sourceRowNumber ? `row ${formatNumber(product.sourceRowNumber)}` : null]
                            .filter(Boolean)
                            .join(" · ") || "—"}
                        </span>
                        <span className="block text-xs lg:hidden">
                          {`Created ${product.createdAt ? new Date(product.createdAt).toLocaleString() : "—"} · Updated ${product.updatedAt ? new Date(product.updatedAt).toLocaleString() : "—"}`}
                        </span>
                      </td>
                      <td className={tableCellClassName}>{formatCurrency(product.factoryPrice)}</td>
                      <td className={`${tableCellClassName} hidden lg:table-cell`}>
                        <span className="block">{product.family}</span>
                        <span className="block text-xs text-phx-ink-faint">{product.familyCode}</span>
                      </td>
                      <td className={`${tableCellClassName} hidden lg:table-cell`}>{product.source}</td>
                      <td className={`${tableCellClassName} hidden lg:table-cell`}>
                        <span className="block">{product.line}</span>
                        <span className="block text-xs text-phx-ink-faint">{product.normalizedLine}</span>
                      </td>
                      <td className={`${tableCellClassName} hidden lg:table-cell`}>
                        <span className="block break-words">{product.sourceFile}</span>
                        <span className="block break-words text-xs text-phx-ink-faint">
                          {[product.sourceSheet, product.sourceRowNumber ? `row ${formatNumber(product.sourceRowNumber)}` : null]
                            .filter(Boolean)
                            .join(" · ") || "—"}
                        </span>
                      </td>
                      <td className={tableCellClassName}>
                        <Badge variant={product.active ? "success" : "neutral"}>
                          {product.active ? "Active" : "Inactive"}
                        </Badge>
                      </td>
                      <td className={`${tableCellClassName} hidden lg:table-cell`}>
                        <span className="block">{product.createdAt ? new Date(product.createdAt).toLocaleString() : "—"}</span>
                        <span className="block text-xs text-phx-ink-faint">
                          {product.updatedAt ? new Date(product.updatedAt).toLocaleString() : "—"}
                        </span>
                      </td>
                      <td className={tableCellClassName}>
                        {deleteConfirmCode === product.productCode ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-bold text-red-600">Delete this product?</span>
                            <Button
                              className="h-8 gap-1 px-3 text-xs"
                              disabled={deleting}
                              onClick={() => void deleteProduct(product)}
                              variant="destructive"
                            >
                              {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                              Yes, delete
                            </Button>
                            <Button
                              className="h-8 px-3 text-xs"
                              onClick={() => setDeleteConfirmCode(null)}
                              variant="secondary"
                            >
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            <Button className="h-9 gap-1 px-3" onClick={() => openEditModal(product)} variant="secondary">
                              <Edit3 className="h-3.5 w-3.5" />
                              Edit
                            </Button>
                            <Button
                              className="h-9 gap-1 px-3"
                              disabled={deleting}
                              onClick={() => setDeleteConfirmCode(product.productCode)}
                              variant="destructive"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              Delete
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {table.rows.length === 0 ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-sm font-semibold text-phx-ink-soft" colSpan={9}>
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
