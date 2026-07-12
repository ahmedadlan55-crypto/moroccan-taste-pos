import { useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Visible, focusable descendants of `container`, in DOM order. */
export function getFocusable(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

export interface FocusTrapOptions {
  /** Whether the overlay is open (the trap is only active while true). */
  active: boolean;
  /** Called on Escape (unless `escClosable` is false). */
  onClose: () => void;
  escClosable?: boolean;
  /** Lock body scroll while open (default true). */
  lockScroll?: boolean;
}

/**
 * Accessible modal behavior for overlays: on open it moves focus inside, traps
 * Tab within the container, closes on Escape, locks body scroll, and restores
 * focus to the previously-focused element on close. Returns a ref to attach to
 * the overlay panel.
 */
export function useFocusTrap<T extends HTMLElement>({
  active,
  onClose,
  escClosable = true,
  lockScroll = true,
}: FocusTrapOptions) {
  const ref = useRef<T>(null);
  // Keep the latest onClose without re-running the effect on every render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    const panel = ref.current;
    const restore = document.activeElement as HTMLElement | null;

    if (lockScroll) document.body.style.overflow = "hidden";

    // Move focus into the panel (first focusable, else the panel itself).
    const first = getFocusable(panel)[0];
    const timer = window.setTimeout(() => (first ?? panel)?.focus(), 20);

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (escClosable) {
          e.preventDefault();
          onCloseRef.current();
        }
        return;
      }
      if (e.key === "Tab") {
        const els = getFocusable(panel);
        if (els.length === 0) {
          e.preventDefault();
          panel?.focus();
          return;
        }
        const firstEl = els[0];
        const lastEl = els[els.length - 1];
        const activeEl = document.activeElement;
        if (e.shiftKey && (activeEl === firstEl || activeEl === panel)) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && activeEl === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onKeyDown);
      if (lockScroll) document.body.style.overflow = "";
      restore?.focus?.();
    };
  }, [active, escClosable, lockScroll]);

  return ref;
}
