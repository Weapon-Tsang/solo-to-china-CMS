import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

function Tabs({ className, ...props }) { return <TabsPrimitive.Root className={cn("flex flex-col", className)} {...props} />; }
function TabsList({ className, ...props }) { return <TabsPrimitive.List className={cn("inline-flex h-10 w-max items-center gap-0.5 rounded-xl border border-slate-200/80 bg-slate-100/80 p-1 shadow-xs", className)} {...props} />; }
function TabsTrigger({ className, ...props }) {
  return <TabsPrimitive.Trigger className={cn("inline-flex h-8 items-center justify-center whitespace-nowrap rounded-lg px-3 text-xs font-medium text-slate-500 transition-all hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30 data-[state=active]:bg-white data-[state=active]:text-slate-900 data-[state=active]:shadow-sm", className)} {...props} />;
}
function TabsContent({ className, ...props }) { return <TabsPrimitive.Content className={cn("mt-0 outline-none", className)} {...props} />; }

export { Tabs, TabsList, TabsTrigger, TabsContent };
