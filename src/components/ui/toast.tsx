import * as React from "react";
import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import { XIcon } from "lucide-react";
import { cn } from "cn";

import { Icon } from "@/components/ui/icon";

/**
 * Toast 只包外观与默认时长：堆叠、自动关闭、焦点与无障碍播报都由 Base UI 提供。
 * 页面右下角是页面内提醒的固定位置，与浏览器系统通知互补。
 */
const TOAST_TIMEOUT_MS = 10_000;

function ToastViewport() {
  const { toasts } = ToastPrimitive.useToastManager();
  return (
    <ToastPrimitive.Viewport className="fixed right-4 bottom-4 z-50 flex w-[320px] max-w-[calc(100vw-2rem)] flex-col-reverse gap-2 outline-none">
      {toasts.map((toast) => (
        <ToastPrimitive.Root
          key={toast.id}
          toast={toast}
          data-testid="chat-toast"
          className={cn(
            "pointer-events-auto relative flex flex-col gap-1 rounded-container border border-border bg-popover p-3 pr-8 text-popover-foreground shadow-lg",
            "transition-[transform,opacity] duration-150 data-starting-style:translate-y-2 data-starting-style:opacity-0 data-ending-style:translate-y-2 data-ending-style:opacity-0",
          )}
        >
          {toast.title ? (
            <ToastPrimitive.Title className="truncate text-xs font-medium">
              {toast.title}
            </ToastPrimitive.Title>
          ) : null}
          {toast.description ? (
            <ToastPrimitive.Description className="line-clamp-3 text-[11px] leading-5 text-muted-foreground">
              {toast.description}
            </ToastPrimitive.Description>
          ) : null}
          <ToastPrimitive.Close
            aria-label="关闭提醒"
            data-testid="chat-toast-close"
            className="absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-control text-muted-foreground hover:bg-hover hover:text-foreground"
          >
            <Icon as={XIcon} size={12} />
          </ToastPrimitive.Close>
        </ToastPrimitive.Root>
      ))}
    </ToastPrimitive.Viewport>
  );
}

/** 一个页面只挂一个：Provider 既提供 `useToast()` 上下文，也渲染右下角的容器。 */
export function ToastHost({ children }: { children?: React.ReactNode }) {
  return (
    <ToastPrimitive.Provider limit={4} timeout={TOAST_TIMEOUT_MS}>
      {children}
      <ToastPrimitive.Portal>
        <ToastViewport />
      </ToastPrimitive.Portal>
    </ToastPrimitive.Provider>
  );
}

/** 页面调用入口：文案与自动关闭时长收在一处，调用方不直接拿 Base UI manager。 */
export function useToast() {
  const manager = ToastPrimitive.useToastManager();
  return React.useMemo(
    () => ({
      show: ({ title, description }: { title: string; description?: string }) =>
        manager.add({ title, description, timeout: TOAST_TIMEOUT_MS }),
    }),
    [manager],
  );
}
