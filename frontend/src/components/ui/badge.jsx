import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", {
  variants: {
    variant: {
      default: "bg-slate-100 text-slate-600 ring-slate-200/70",
      success: "bg-emerald-50 text-emerald-700 ring-emerald-200/70",
      warning: "bg-amber-50 text-amber-700 ring-amber-200/70",
      destructive: "bg-red-50 text-red-700 ring-red-200/70",
      info: "bg-blue-50 text-blue-700 ring-blue-200/70",
    },
  },
  defaultVariants: { variant: "default" },
});

function Badge({ className, variant, ...props }) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
