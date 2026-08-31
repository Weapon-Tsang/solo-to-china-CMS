import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

function Tabs({ className, ...props }) { return <TabsPrimitive.Root className={cn("flex flex-col", className)} {...props} />; }
function TabsList({ className, ...props }) { return <TabsPrimitive.List className={cn("inline-flex h-11 w-max items-center gap-1 rounded-2xl border border-slate-200/80 bg-white/80 p-1.5 shadow-sm backdrop-blur", className)} {...props} />; }
function TabsTrigger({ className, ...props }) {
  return <TabsPrimitive.Trigger className={cn("inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-2.5 text-[11px] font-medium text-slate-500 transition-all hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30 data-[state=active]:bg-slate-900 data-[state=active]:text-white data-[state=active]:shadow-sm", className)} {...props} />;
}
function TabsContent({ className, ...props }) { return <TabsPrimitive.Content className={cn("mt-0 outline-none", className)} {...props} />; }

export { Tabs, TabsList, TabsTrigger, TabsContent };
