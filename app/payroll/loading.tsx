import { LoadingSpinner } from "@/components/ui/loading-state";

export default function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-soft text-text">
      <div className="text-center">
        <LoadingSpinner />
        <p className="mt-4 text-sm font-medium text-text-secondary">
          Loading payroll intelligence...
        </p>
      </div>
    </div>
  );
}
