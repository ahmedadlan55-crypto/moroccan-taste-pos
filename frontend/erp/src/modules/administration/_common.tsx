// Shared helpers for the Administration module pages. Kept tiny + dependency-free
// so each page can import the normalizers and the mutation-result guard without
// pulling in a page.

/** Backend list endpoints return a bare array (and fall back to [] on error),
 *  but some wrap in { data } / { items } / { rows }. Normalize to a real array. */
export function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    for (const k of ["data", "items", "rows", "results"]) {
      if (Array.isArray(o[k])) return o[k] as T[];
    }
  }
  return [];
}

/** Legacy write endpoints answer 200 with { success:false, error } instead of a
 *  non-2xx status. Turn a falsey `success` into a thrown Error so react-query's
 *  onError path (and the toast) fire consistently. */
export interface MutationAck {
  success?: boolean;
  error?: string;
  id?: string | number;
}
export function ensureAck(res: MutationAck | undefined | null): MutationAck {
  if (res && res.success === false) {
    throw new Error(res.error || "تعذّر حفظ التغييرات");
  }
  return res ?? {};
}
