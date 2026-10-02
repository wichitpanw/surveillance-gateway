import React, { useEffect, useState } from 'react';
import { subscribeAppDialog } from '@/lib/appDialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AlertCircle, Trash2, Info, HelpCircle } from 'lucide-react';

/**
 * Host for imperative appConfirm / appPrompt (replaces browser confirm/prompt).
 */
export function AppDialogHost() {
  const [queue, setQueue] = useState([]);
  const current = queue[0] || null;
  const [promptValue, setPromptValue] = useState('');
  const [promptFor, setPromptFor] = useState(null);

  useEffect(() => {
    return subscribeAppDialog((item) => {
      setQueue((prev) => [...prev, item]);
    });
  }, []);

  // ตั้งค่าเริ่มต้นของช่อง prompt เมื่อ dialog ตัวใหม่ขึ้นมา — ทำตอน render แทน effect
  const currentId = current?.id ?? null;
  if (currentId !== promptFor) {
    setPromptFor(currentId);
    if (current?.type === 'prompt') setPromptValue(current.defaultValue || '');
  }

  const finish = (result) => {
    if (!current) return;
    current.resolve(result);
    setQueue((prev) => prev.slice(1));
  };

  if (!current) return null;

  const isDestructive = current.variant === 'destructive';
  const Icon =
    current.type === 'prompt'
      ? HelpCircle
      : isDestructive
        ? Trash2
        : current.variant === 'default'
          ? Info
          : AlertCircle;

  return (
    <AlertDialog
      open={!!current}
      onOpenChange={(open) => {
        if (!open) finish(current.type === 'prompt' ? null : false);
      }}
    >
      <AlertDialogContent className="max-w-[420px] max-h-[calc(100dvh-2rem)] border-none shadow-2xl bg-card p-0 overflow-hidden flex flex-col gap-0">
        <div className="p-6 pb-2 flex flex-col items-center text-center gap-4 shrink-0">
          <div
            className={`size-12 rounded-full flex items-center justify-center ${
              isDestructive ? 'bg-destructive/10' : 'bg-primary/10'
            }`}
          >
            <Icon className={`size-5 ${isDestructive ? 'text-destructive' : 'text-primary'}`} />
          </div>
          <AlertDialogHeader className="space-y-2">
            <AlertDialogTitle className="text-xl font-black uppercase tracking-tighter leading-none text-center">
              {current.title}
            </AlertDialogTitle>
            {current.description ? (
              <AlertDialogDescription className="text-[11px] font-semibold text-muted-foreground tracking-wide leading-relaxed whitespace-pre-line text-center normal-case">
                {current.description}
              </AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
        </div>

        {current.type === 'prompt' && (
          <div className="px-6 pb-2">
            <Input
              autoFocus
              value={promptValue}
              onChange={(e) => setPromptValue(e.target.value)}
              placeholder={current.placeholder || ''}
              className="h-11 font-mono text-sm"
              onKeyDown={(e) => {
                if (e.key === 'Enter') finish(promptValue.trim() || null);
              }}
            />
          </div>
        )}

        <AlertDialogFooter className="shrink-0 p-6 pt-4 flex-row gap-3 sm:justify-center border-t bg-muted/20 m-0">
          <AlertDialogCancel asChild>
            <Button
              variant="ghost"
              className="flex-1 h-11 font-black text-[10px] uppercase tracking-widest opacity-60 hover:opacity-100"
              onClick={() => finish(current.type === 'prompt' ? null : false)}
            >
              {current.cancelText || 'Cancel'}
            </Button>
          </AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button
              variant={isDestructive ? 'destructive' : 'default'}
              className="flex-1 h-11 font-black text-[10px] uppercase tracking-[0.2em] shadow-xl"
              onClick={() =>
                finish(current.type === 'prompt' ? (promptValue.trim() || null) : true)
              }
            >
              {current.confirmText || 'OK'}
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
