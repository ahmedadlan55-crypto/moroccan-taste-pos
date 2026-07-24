export const customerAddDialog = {
  title: "Add new customer",
  fields: {
    nameLabel: "Name *",
    namePlaceholder: "John Smith",
    phoneLabel: "Phone *",
    phonePlaceholder: "05xxxxxxxx",
    vatLabel: "VAT number (optional)",
    typeLabel: "Customer type",
    typeB2C: "Individuals · B2C",
    typeB2B: "Companies · B2B",
    typeB2G: "Government · B2G",
  },
  actions: {
    cancel: "Cancel",
    saveLink: "Save & link",
    recallExisting: "Recall existing customer",
  },
  validation: {
    nameRequired: "Customer name is required",
    phoneRequired: "Phone number is required",
    phoneTooShort: "Phone number is too short (at least 5 digits)",
  },
  errors: {
    saveFailed: "Failed to save customer",
  },
} as const;
