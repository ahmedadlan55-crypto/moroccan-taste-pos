// Shared zod primitives (money, qty, dateISO, arabicText, …) that domain modules
// extend. `z` is re-exported for convenience so schemas import from one place.
export { z } from "zod";
export * from "./primitives";
