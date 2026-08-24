import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-lg text-sm font-medium transition-all outline-none select-none focus-visible:ring-2 focus-visible:ring-slate-400/30 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4",
  {
    variants: {
      variant: {
        default: "bg-slate-900 text-white shadow-sm hover:bg-slate-800 active:scale-[.98]",
        secondary: "border border-slate-200/80 bg-white text-slate-700 shadow-sm hover:bg-slate-50 active:scale-[.98]",
        ghost: "text-slate-500 hover:bg-slate-100 hover:text-slate-900",
        outline: "border border-slate-200 bg-transparent text-slate-700 hover:bg-slate-50",
        destructive: "bg-red-600 text-white shadow-sm hover:bg-red-500",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 px-5",
        icon: "size-9 rounded-lg",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

function Button({ className, variant, size, asChild = false, ...props }) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { Button, buttonVariants };
