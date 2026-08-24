import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;

function DialogContent({ className, children, ...props }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-slate-950/25 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out" />
      <DialogPrimitive.Content className={cn("fixed top-1/2 left-1/2 z-50 max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-white/70 bg-white p-6 shadow-2xl outline-none", className)} {...props}>
        {children}
        <DialogPrimitive.Close className="absolute top-4 right-4 grid size-8 place-items-center rounded-full bg-slate-100 text-slate-500 transition hover:bg-slate-200 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30">
          <X className="size-4" /><span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
function DialogHeader({ className, ...props }) { return <div className={cn("mb-5 flex flex-col gap-2 text-left", className)} {...props} />; }
function DialogTitle({ className, ...props }) { return <DialogPrimitive.Title className={cn("pr-10 text-xl font-semibold tracking-tight text-slate-900", className)} {...props} />; }
function DialogDescription({ className, ...props }) { return <DialogPrimitive.Description className={cn("text-sm leading-relaxed text-slate-500", className)} {...props} />; }

export { Dialog, DialogTrigger, DialogClose, DialogContent, DialogHeader, DialogTitle, DialogDescription };
