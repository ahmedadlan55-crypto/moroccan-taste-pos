import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

// The unified router registers ONE exact route per manifest path (no `/:id`
// segments — the manifest/router are owned by SD1). To keep every O2C document
// reachable AND URL-addressable without a manifest change, the sales/customers
// modules use query params on the section route:
//   ?doc=<id>  → open that document's detail (full-page master/detail swap)
//   ?new=1     → open the create form (drawer)
//   ?customerId / ?invoiceId → presets carried into the create forms
// Back/forward + refresh all work because the state lives in the URL.
export function useDocNav() {
  const [sp, setSearchParams] = useSearchParams();
  const doc = sp.get("doc");
  const isNew = sp.get("new") === "1";

  const openDoc = useCallback(
    (id: string) =>
      setSearchParams((prev) => {
        const n = new URLSearchParams(prev);
        n.set("doc", id);
        n.delete("new");
        return n;
      }),
    [setSearchParams],
  );
  const closeDoc = useCallback(
    () =>
      setSearchParams((prev) => {
        const n = new URLSearchParams(prev);
        n.delete("doc");
        return n;
      }),
    [setSearchParams],
  );
  const openNew = useCallback(
    () =>
      setSearchParams((prev) => {
        const n = new URLSearchParams(prev);
        n.set("new", "1");
        n.delete("doc");
        return n;
      }),
    [setSearchParams],
  );
  const closeNew = useCallback(
    () =>
      setSearchParams((prev) => {
        const n = new URLSearchParams(prev);
        n.delete("new");
        return n;
      }),
    [setSearchParams],
  );

  return { sp, doc, isNew, openDoc, closeDoc, openNew, closeNew };
}
