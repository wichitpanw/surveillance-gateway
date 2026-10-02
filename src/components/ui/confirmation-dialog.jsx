import React from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { AlertCircle, Trash2, LogOut, Settings2, Info } from "lucide-react";

/**
 * Reusable Confirmation Dialog for the whole system
 */
export function ConfirmationDialog({ 
  isOpen, 
  onClose, 
  onConfirm, 
  title, 
  description, 
  confirmText = "Confirm", 
  cancelText = "Cancel",
  variant = "default" 
}) {
  const getIcon = () => {
    if (variant === 'destructive') return <Trash2 className="size-5 text-destructive" />;
    if (title?.toLowerCase().includes('log out')) return <LogOut className="size-5 text-muted-foreground" />;
    if (title?.toLowerCase().includes('configure')) return <Settings2 className="size-5 text-primary" />;
    return <Info className="size-5 text-primary" />;
  };

  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => { if (!open) onClose?.(); }}>
      <AlertDialogContent className="max-w-[400px] max-h-[calc(100dvh-2rem)] border-none shadow-2xl bg-card p-0 overflow-hidden flex flex-col gap-0">
        <div className="p-6 pb-2 flex flex-col items-center text-center gap-4">
           <div className={`size-12 rounded-full flex items-center justify-center ${variant === 'destructive' ? 'bg-destructive/10' : 'bg-muted'}`}>
              {getIcon()}
           </div>
           <div className="space-y-2">
              <AlertDialogTitle className="text-xl font-black uppercase tracking-tighter leading-none">
                {title}
              </AlertDialogTitle>
              <AlertDialogDescription className="text-[11px] font-bold text-muted-foreground uppercase tracking-widest leading-relaxed">
                {description}
              </AlertDialogDescription>
           </div>
        </div>
        <AlertDialogFooter className="p-6 pt-6 flex-row gap-3 sm:justify-center border-t bg-muted/20">
          <AlertDialogCancel asChild>
            <Button variant="ghost" className="flex-1 h-11 font-black text-[10px] uppercase tracking-widest opacity-60 hover:opacity-100">
              {cancelText}
            </Button>
          </AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button 
              variant={variant === 'destructive' ? 'destructive' : 'default'}
              onClick={onConfirm}
              className="flex-1 h-11 font-black text-[10px] uppercase tracking-[0.2em] shadow-xl"
            >
              {confirmText}
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
