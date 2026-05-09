import { LoadingSpinner } from "@/components/ui/loading-state";

export default function EmployeePortalLoading() {
  return (
    <div className="flex min-h-[400px] flex-col items-center justify-center rounded-2xl border border-slate-200 bg-white p-8 text-center backdrop-blur-sm shadow-sm">
      <LoadingSpinner className="h-8 w-8 text-orange-500" />
      <p className="mt-4 text-sm font-medium text-slate-500">Updating your portal...</p>
    </div>
  );
}
