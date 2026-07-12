import { useCallback, useMemo, useState } from "react";

export interface Disclosure {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  setOpen: (value: boolean) => void;
}

/** Boolean open/close state for dialogs, drawers, menus, popovers. */
export function useDisclosure(initial = false): Disclosure {
  const [isOpen, setOpen] = useState(initial);
  const open = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  return useMemo(() => ({ isOpen, open, close, toggle, setOpen }), [isOpen, open, close, toggle]);
}
