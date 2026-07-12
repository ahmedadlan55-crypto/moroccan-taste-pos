// Shared form helpers on react-hook-form + zod.
export * from "./Field";
export * from "./FieldError";
export * from "./FormActions";
export * from "./useUnsavedGuard";
export * from "./ConfirmSubmit";

// Convenience re-export so screens can `import { zodResolver } from "@/shared/forms"`.
export { zodResolver } from "@hookform/resolvers/zod";
