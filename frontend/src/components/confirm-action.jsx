import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function ConfirmAction({
  open,
  onOpenChange,
  title,
  description,
  detail,
  confirmLabel = "确认继续",
  cancelLabel = "返回",
  destructive = false,
  busy = false,
  onConfirm,
}) {
  return <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
    <DialogContent className="max-w-md p-5 sm:p-6">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      {detail && <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs leading-relaxed text-slate-700">{detail}</div>}
      <div className="mt-5 grid gap-2 sm:flex sm:flex-row-reverse">
        <Button className="min-h-11 w-full sm:w-auto" variant={destructive ? "destructive" : "default"} disabled={busy} onClick={onConfirm}>{confirmLabel}</Button>
        <Button className="min-h-11 w-full sm:w-auto" variant="secondary" disabled={busy} onClick={() => onOpenChange(false)}>{cancelLabel}</Button>
      </div>
    </DialogContent>
  </Dialog>;
}
