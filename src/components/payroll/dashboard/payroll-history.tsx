import { Download, FileCheck2, Loader2, Trash2, Upload } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatDateTimeValue } from "@/lib/i18n/format";
import type { SalaryBatch } from "@/lib/payroll/types";
import { cn } from "@/lib/utils";

import {
  isBatchReplaceable,
  panelClassName,
  payrollPeriodIndex,
  payrollPeriodLabel,
  publishedPayslipStatuses,
  statusBadge,
} from "./shared";
import { TableHeaderMenu } from "./table-header-menu";

export function PayrollHistory({
  activeBatchId,
  batches,
  deletingBatchId,
  onDelete,
  onReplace,
  replacingBatchId,
}: {
  activeBatchId?: string;
  batches: SalaryBatch[];
  deletingBatchId: string | null;
  onDelete: (batchId: string) => void;
  onReplace: (batch: SalaryBatch) => void;
  replacingBatchId: string | null;
}) {
  const [fileSearch, setFileSearch] = useState("");
  const [fileColumnFilters, setFileColumnFilters] = useState<Record<string, string>>({});
  const [fileSort, setFileSort] = useState("period-desc");
  const fileColumns = useMemo(
    () => [
      { asc: "period-asc", desc: "period-desc", key: "period", label: "Period" },
      { asc: "file", desc: "file-desc", key: "fileName", label: "File" },
      { asc: "status", desc: "status-desc", key: "status", label: "Status" },
      { asc: "uploaded-asc", desc: "uploaded-desc", key: "createdAt", label: "Uploaded" },
    ],
    [],
  );
  const fileColumnValue = (batch: SalaryBatch, key: string) => {
    if (key === "period") return payrollPeriodLabel(batch.month, batch.year);
    if (key === "fileName") return batch.fileName;
    if (key === "status") return batch.status.replace(/_/g, " ");
    if (key === "createdAt") return formatDateTimeValue(batch.createdAt);
    return "";
  };
  const visibleBatches = useMemo(() => {
    const query = fileSearch.trim().toLowerCase();
    const searched = batches.filter((batch) => {
      const haystack = [
        payrollPeriodLabel(batch.month, batch.year),
        batch.fileName,
        batch.status,
        batch.uploadedBy ?? "",
      ]
        .join(" ")
        .toLowerCase();

      const matchesGlobal = !query || haystack.includes(query);
      const matchesColumns = fileColumns.every((column) => {
        const filter = fileColumnFilters[column.key]?.trim().toLowerCase();
        return !filter || fileColumnValue(batch, column.key).toLowerCase().includes(filter);
      });

      return matchesGlobal && matchesColumns;
    });

    return searched.slice().sort((left, right) => {
      if (fileSort === "period-asc") {
        return payrollPeriodIndex(left.month, left.year) - payrollPeriodIndex(right.month, right.year);
      }
      if (fileSort === "uploaded-desc") {
        return right.createdAt.localeCompare(left.createdAt);
      }
      if (fileSort === "uploaded-asc") {
        return left.createdAt.localeCompare(right.createdAt);
      }
      if (fileSort === "status") {
        return left.status.localeCompare(right.status);
      }
      if (fileSort === "status-desc") {
        return right.status.localeCompare(left.status);
      }
      if (fileSort === "file") {
        return left.fileName.localeCompare(right.fileName);
      }
      if (fileSort === "file-desc") {
        return right.fileName.localeCompare(left.fileName);
      }

      return payrollPeriodIndex(right.month, right.year) - payrollPeriodIndex(left.month, left.year);
    });
  }, [batches, fileColumnFilters, fileColumns, fileSearch, fileSort]);

  if (batches.length === 0) return null;

  return (
    <Card className={`${panelClassName} p-5`}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-[#0F172A]">
            Uploaded Files History
          </h2>
          <p className="mt-1 text-sm text-[#64748B]">
            Review uploaded payroll sheets, download stored data, replace incorrect files, or delete batches.
          </p>
        </div>
        <Badge variant="neutral">{batches.length} files</Badge>
      </div>
      <div className="mb-4 grid gap-3 rounded-[24px] border border-[#E2E8F0] bg-[#FCFDFE] p-3 md:grid-cols-[1fr_220px]">
        <Input
          onChange={(event) => setFileSearch(event.target.value)}
          placeholder="Filter uploaded files by period, file, status..."
          value={fileSearch}
        />
        <select
          className="h-10 rounded-2xl border border-[#D7E0EA] bg-white px-3 text-sm text-[#0F172A] focus:outline-none"
          onChange={(event) => setFileSort(event.target.value)}
          value={fileSort}
        >
          <option value="period-desc">Period newest</option>
          <option value="period-asc">Period oldest</option>
          <option value="uploaded-desc">Uploaded newest</option>
          <option value="uploaded-asc">Uploaded oldest</option>
          <option value="status">Status A-Z</option>
          <option value="file">File A-Z</option>
        </select>
      </div>
      <div className="overflow-hidden rounded-[24px] border border-[#E2E8F0]">
        <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead>
            <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
              {[...fileColumns, { key: "actions", label: "Actions" }].map((column) => (
                <th className="px-3 py-3 font-medium text-[#64748B]" key={column.key}>
                  {column.key === "actions" ? (
                    column.label
                  ) : (
                    <TableHeaderMenu
                      filterValue={fileColumnFilters[column.key] ?? ""}
                      label={column.label}
                      onFilterChange={(value) =>
                        setFileColumnFilters((filters) => ({
                          ...filters,
                          [column.key]: value,
                        }))
                      }
                      onSortAsc={() => setFileSort("asc" in column ? column.asc : "period-asc")}
                      onSortDesc={() => setFileSort("desc" in column ? column.desc : "period-desc")}
                    />
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visibleBatches.length === 0 ? (
              <tr>
                <td className="px-3 py-8 text-center text-sm text-[#64748B]" colSpan={5}>
                  No uploaded files match the current filter.
                </td>
              </tr>
            ) : visibleBatches.map((batch) => (
              <tr
                className={cn(
                  "transition-colors hover:bg-bg-muted",
                  activeBatchId === batch.id && "bg-orange-50/70 dark:bg-orange-950/10",
                )}
                key={batch.id}
              >
                <td className="py-3 pr-4 font-medium text-text">
                  <a href={`/payroll?batchId=${batch.id}`}>
                    {payrollPeriodLabel(batch.month, batch.year)}
                  </a>
                </td>
                <td className="max-w-[260px] truncate py-3 pr-4 text-text-secondary">
                  {batch.fileName}
                </td>
                <td className="py-3 pr-4">{statusBadge(batch.status)}</td>
                <td className="py-3 pr-4 text-text-secondary">
                  {formatDateTimeValue(batch.createdAt)}
                </td>
                <td className="py-3 pr-4">
                  <div className="flex flex-wrap gap-2">
                    <Link href={`/api/payroll/${batch.id}/download`}>
                      <Button className="px-3 py-1.5 text-xs" variant="secondary">
                        <Download className="mr-2 h-3.5 w-3.5" />
                        Download
                      </Button>
                    </Link>
                    {publishedPayslipStatuses.has(batch.status) ? (
                      <Link href={`/api/payroll/${batch.id}/payslips?returnTo=${encodeURIComponent(`/payroll?batchId=${batch.id}`)}`} target="_blank">
                        <Button className="px-3 py-1.5 text-xs" variant="secondary">
                          <FileCheck2 className="mr-2 h-3.5 w-3.5" />
                          Payslips
                        </Button>
                      </Link>
                    ) : (
                      <Button className="px-3 py-1.5 text-xs" disabled variant="secondary">
                        <FileCheck2 className="mr-2 h-3.5 w-3.5" />
                        Payslips
                      </Button>
                    )}
                    <Button
                      className="px-3 py-1.5 text-xs"
                      disabled={!isBatchReplaceable(batch) || replacingBatchId === batch.id}
                      onClick={() => onReplace(batch)}
                      variant="secondary"
                    >
                      {replacingBatchId === batch.id ? (
                        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Upload className="mr-2 h-3.5 w-3.5" />
                      )}
                      Replace
                    </Button>
                    <Button
                      className="px-3 py-1.5 text-xs"
                      disabled={deletingBatchId === batch.id}
                      onClick={() => onDelete(batch.id)}
                      variant="secondary"
                    >
                      {deletingBatchId === batch.id ? (
                        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="mr-2 h-3.5 w-3.5" />
                      )}
                      Delete
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </Card>
  );
}
