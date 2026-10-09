import React, { useEffect, useState } from 'react';
import { subscribeToasts } from '@/lib/toast';
import { CheckCircle2, AlertCircle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Toaster — แจ้งเตือนสไตล์ของระบบ (แทน browser alert)
 */
export function Toaster() {
  const [items, setItems] = useState([]);

  useEffect(() => {
    return subscribeToasts((item) => {
      setItems((prev) => [...prev, item]);
      setTimeout(() => {
        setItems((prev) => prev.filter((t) => t.id !== item.id));
      }, 4500);
    });
  }, []);

  const dismiss = (id) => setItems((prev) => prev.filter((t) => t.id !== id));

  if (!items.length) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[200] flex flex-col gap-2 w-[min(100vw-2rem,380px)] pointer-events-none">
      {items.map((item) => {
        const isError = item.variant === 'destructive';
        return (
          <div
            key={item.id}
            className={`pointer-events-auto animate-in slide-in-from-bottom-4 fade-in duration-300 rounded-xl border shadow-2xl bg-card overflow-hidden ${
              isError ? 'border-destructive/30' : 'border-primary/20'
            }`}
          >
            <div className="flex items-start gap-3 p-4">
              <div
                className={`size-9 rounded-lg flex items-center justify-center shrink-0 ${
                  isError ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary'
                }`}
              >
                {isError ? <AlertCircle className="size-5" /> : <CheckCircle2 className="size-5" />}
              </div>
              <div className="flex-1 min-w-0 pt-0.5">
                <p className="text-sm font-bold tracking-tight text-foreground">{item.title}</p>
                {item.description && (
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{item.description}</p>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 opacity-50 hover:opacity-100 -mt-0.5 -mr-1"
                onClick={() => dismiss(item.id)}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
