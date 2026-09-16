"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared fixed-position popover for sidebar menus (workspace, account).
 * Backdrop click and Escape close it; focus moves in on open and returns
 * to the trigger on close.
 */
export function SidebarPopover({
  open,
  onClose,
  label,
  className,
  children,
  triggerRef
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  className?: string;
  children: React.ReactNode;
  triggerRef: React.RefObject<HTMLElement | null>;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const trigger = triggerRef.current;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      trigger?.focus?.();
    };
  }, [open, onClose, triggerRef]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50" role="presentation">
      <div className="absolute inset-0" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="false"
        aria-label={label}
        tabIndex={-1}
        className={cn(
          "absolute w-72 rounded-2xl border border-border bg-popover p-2 shadow-2xl outline-none dark:border-white/10",
          className
        )}
      >
        {children}
      </div>
    </div>
  );
}
