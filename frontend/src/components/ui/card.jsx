import { cn } from "@/lib/utils";

function Card({ className, ...props }) {
  return <div className={cn("rounded-xl border border-slate-200/80 bg-white shadow-sm", className)} {...props} />;
}
function CardHeader({ className, ...props }) {
  return <div className={cn("flex flex-col gap-1.5 p-5", className)} {...props} />;
}
function CardTitle({ className, ...props }) {
  return <h3 className={cn("font-semibold tracking-tight text-slate-900", className)} {...props} />;
}
function CardDescription({ className, ...props }) {
  return <p className={cn("text-sm leading-relaxed text-slate-500", className)} {...props} />;
}
function CardContent({ className, ...props }) {
  return <div className={cn("p-5 pt-0", className)} {...props} />;
}
function CardFooter({ className, ...props }) {
  return <div className={cn("flex items-center p-5 pt-0", className)} {...props} />;
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
