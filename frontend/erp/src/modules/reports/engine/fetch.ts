// Coercion for the legacy list endpoints these reports read.
//
// The HR / custody / shift routes answer a BARE ARRAY on success but an
// HTTP-200 `{ success:false, error }` on failure. Handing that object to a
// table renders an empty report — a failure that looks like "nothing happened",
// which on a payroll or a cash-variance sheet is the most expensive way to be
// wrong. `asRows` turns it into a thrown Error so react-query surfaces
// <ErrorState> instead of an innocent empty table.
type Raw = Record<string, unknown>;

export function asRows(data: unknown): Raw[] {
  if (Array.isArray(data)) return data as Raw[];
  if (data && typeof data === "object") {
    const envelope = data as { success?: unknown; error?: unknown };
    if (envelope.success === false) throw new Error(String(envelope.error ?? ""));
  }
  return [];
}

export function str(value: unknown): string {
  if (value == null) return "";
  return String(value);
}

export function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
