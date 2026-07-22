/** English mirror of the shared zod validation messages. Keep the key set
 *  identical to ar/validation.ts (enforced by the dictionary parity test). */
export const validation = {
  defaultLabel: "This field",
  text: {
    required: "This field is required",
    requiredNamed: "{label} is required",
    minLength: "{label} must be at least {min} characters",
    maxLength: "{label} exceeds the maximum ({max} characters)",
  },
  money: {
    invalid: "Enter a valid amount",
    negative: "The amount cannot be negative",
    positive: "The amount must be greater than zero",
  },
  qty: {
    invalid: "Enter a valid quantity",
    negative: "The quantity cannot be negative",
    positive: "The quantity must be greater than zero",
  },
  rate: {
    invalid: "Enter a valid rate",
    negative: "The rate cannot be negative",
    range: "The rate must be between 0 and 1",
  },
  date: {
    required: "The date is required",
    invalid: "The date is invalid",
  },
  select: {
    required: "A selection is required",
  },
  phone: {
    invalid: "The mobile number is invalid",
  },
  email: {
    invalid: "The email address is invalid",
  },
} as const;
