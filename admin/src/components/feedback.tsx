import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

type ToastKind = 'success' | 'error' | 'info';

interface ToastOptions {
  undo?: () => void;
}

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  undo?: () => void;
}

interface ConfirmOptions {
  title: string;
  body: string;
  confirmLabel?: string;
  danger?: boolean;
}

interface FeedbackApi {
  toast: (kind: ToastKind, message: string, options?: ToastOptions) => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /** Remove the row now. Commit after 6 seconds unless Undo is pressed. */
  undoable: (message: string, commit: () => Promise<void>, restore: () => void) => void;
}

const FeedbackContext = createContext<FeedbackApi | null>(null);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [pending, setPending] = useState<(ConfirmOptions & { id: number }) | null>(null);
  const resolvers = useRef(new Map<number, (value: boolean) => void>());
  const nextId = useRef(1);

  const toast = useCallback((kind: ToastKind, message: string, options?: ToastOptions) => {
    const id = nextId.current++;
    setToasts((current) => [...current, { id, kind, message, undo: options?.undo }]);
  }, []);

  const undoable = useCallback(
    (message: string, commit: () => Promise<void>, restore: () => void) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        void commit().catch((err: unknown) => {
          restore();
          toast('error', err instanceof Error ? err.message : 'Could not finish that change');
        });
      }, 6000);
      toast('info', message, {
        undo: () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          restore();
        },
      });
    },
    [toast],
  );

  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((item) =>
      window.setTimeout(() => {
        setToasts((current) => current.filter((toastItem) => toastItem.id !== item.id));
      }, item.undo ? 6000 : 4200),
    );
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [toasts]);

  const confirm = useCallback((options: ConfirmOptions) => {
    const id = nextId.current++;
    setPending({ ...options, id });
    return new Promise<boolean>((resolve) => {
      resolvers.current.set(id, resolve);
    });
  }, []);

  const settle = (id: number, value: boolean) => {
    resolvers.current.get(id)?.(value);
    resolvers.current.delete(id);
    setPending((current) => (current?.id === id ? null : current));
  };

  const api = useMemo(() => ({ toast, confirm, undoable }), [toast, confirm, undoable]);

  return (
    <FeedbackContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((item) => (
          <div
            key={item.id}
            role="status"
            className={`pointer-events-auto flex items-center justify-between gap-3 rounded-xl border px-3 py-2 text-sm shadow-none ${
              item.kind === 'error'
                ? 'border-red-500/30 bg-surface-raised text-red-200'
                : item.kind === 'success'
                  ? 'border-emerald-500/30 bg-surface-raised text-emerald-200'
                  : 'border-line bg-surface-raised text-ink'
            }`}
          >
            <span>{item.message}</span>
            {item.undo && (
              <button
                type="button"
                className="ml-3 font-medium text-ink underline"
                onClick={item.undo}
              >
                Undo
              </button>
            )}
          </div>
        ))}
      </div>
      {pending && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            className="w-full max-w-md rounded-2xl border border-line bg-surface-raised p-5 shadow-none"
          >
            <h2 id="confirm-title" className="text-base font-medium text-ink">
              {pending.title}
            </h2>
            <p className="mt-2 text-sm text-ink-muted">{pending.body}</p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={() => settle(pending.id, false)}>
                Cancel
              </button>
              <button
                type="button"
                className={pending.danger ? 'btn-danger' : 'btn-primary'}
                onClick={() => settle(pending.id, true)}
              >
                {pending.confirmLabel || 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </FeedbackContext.Provider>
  );
}

export function useFeedback(): FeedbackApi {
  const ctx = useContext(FeedbackContext);
  if (!ctx) throw new Error('useFeedback must be used within FeedbackProvider');
  return ctx;
}
