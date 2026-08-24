import { cn } from "@/lib/utils";

function Alert({ className, ...props }) {
  return <div role="alert" className={cn("relative flex gap-3 rounded-xl border border-amber-200 bg-amber-50/80 p-4 text-amber-950 shadow-sm", className)} {...props} />;
}
function AlertTitle({ className, ...props }) {
  return <h5 className={cn("text-sm font-medium", className)} {...props} />;
}
function AlertDescription({ className, ...props }) {
  return <div className={cn("text-xs leading-relaxed text-amber-800", className)} {...props} />;
}

export { Alert, AlertTitle, AlertDescription };
