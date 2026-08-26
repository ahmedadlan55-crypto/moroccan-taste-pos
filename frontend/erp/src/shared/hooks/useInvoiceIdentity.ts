// The company identity a printed document is issued BY.
//
// WHY THIS EXISTS
//   Every accounting statement the system printed came off the printer with a
//   report title and no issuer: a trial balance that does not say whose trial
//   balance it is. PrintDocument calls this once, so every report in the system
//   gains the letterhead together.
//
// WHY IT READS THE NARROW PUBLIC BRANDING ENDPOINT
//   The richer endpoint resolves branch → brand → company → settings, and it is
//   gated `admin|manager`. An ACCOUNTANT — the role that actually prints
//   statements — would have 403'd, and every trial balance, ledger and ageing
//   sheet would print with no letterhead.
//
//   The first attempt at this widened that endpoint's guard. That was the wrong
//   trade: it is an access-control change to a live route, made in service of a
//   reports feature, and nobody asked for it. Reverted.
//
//   `/settings/public-branding` returns only CompanyName, TaxNumber, CrNumber
//   and NationalAddress. It must never inherit arbitrary settings rows: that
//   table also stores security policies and user metadata.
//
//   WHAT THIS COSTS, STATED PLAINLY: this is the COMPANY identity, not the
//   branch-resolved one. For a financial statement that is the correct issuer
//   anyway — a trial balance is issued by the legal entity, not by a branch —
//   so the loss is theoretical here. A document that genuinely needs the
//   branch-scoped seller block (a tax invoice) already uses the scoped endpoint
//   through its own path and is unaffected.
//
// CACHE
//   Its own key. It deliberately does NOT reuse the InvoiceSettings editor's
//   `["erp","invoice-identity",…]` key: that key means the scoped endpoint's
//   envelope, and pointing a different request at it would make one key stand
//   for two different bodies.
//
// DEGRADATION
//   A report must print. If identity cannot be read — offline, a backend without
//   the route, or simply no QueryClient in the tree — this returns
//   `identity: null` and the masthead prints without a letterhead rather than
//   blocking, erroring, or inventing a seller name.
import { useContext, useMemo } from "react";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";

/** The letterhead block. Narrower than the scoped seller block, by design. */
export interface InvoiceIdentity {
  /** Legal entity name — what the statement is issued by. */
  legalName: string;
  /** VAT registration number. */
  taxNumber: string;
  /** Commercial registration number. */
  crNumber: string;
  /** National address, when recorded. */
  nationalAddress: string;
}

/** The public branding endpoint returns a four-key flat map. */
export type SettingsMap = Record<string, string | null | undefined>;

export interface UseInvoiceIdentityOptions {
  /** Opt out entirely (e.g. a preview that must not hit the network). */
  enabled?: boolean;
}

export interface UseInvoiceIdentityResult {
  /** null whenever identity could not be read — never a fabricated seller. */
  identity: InvoiceIdentity | null;
  /** The entity name to print, "" when unknown. */
  entityName: string;
  /** VAT registration number, "" when unknown. */
  taxNumber: string;
  isLoading: boolean;
  /** TRUE when the read failed. The caller prints without a letterhead. */
  isUnavailable: boolean;
}

/** Shared cache key for the public settings map. */
export function companyIdentityQueryKey() {
  return ["erp", "company-identity"] as const;
}

/**
 * A QueryClient used only when the component tree has no QueryClientProvider.
 *
 * PrintDocument sits at the top of ~20 screens, and a screen's unit test renders
 * it without a provider. `useQueryClient()` THROWS in that case, which would
 * turn "the letterhead could not be read" into "the whole report crashed" — the
 * opposite of degrading honestly. Reading the context directly never throws, and
 * this inert client keeps useQuery's hook order stable while `enabled:false`
 * guarantees it never issues a request.
 */
let _detachedClient: QueryClient | null = null;
function detachedClient(): QueryClient {
  if (!_detachedClient) {
    _detachedClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  }
  return _detachedClient;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function useInvoiceIdentity(options: UseInvoiceIdentityOptions = {}): UseInvoiceIdentityResult {
  const { enabled = true } = options;
  // NOT useQueryClient(): that throws when no provider is mounted. See above.
  const ambient = useContext(QueryClientContext);

  const query = useQuery<SettingsMap>(
    {
      queryKey: companyIdentityQueryKey(),
      queryFn: ({ signal }) => apiClient.get<SettingsMap>("/settings/public-branding", { signal }),
      enabled: enabled && !!ambient,
      // Identity changes when the owner edits it, which is rare.
      // An hour of staleness beats a request behind every printed page.
      staleTime: 60 * 60 * 1000,
      // One failed read must not retry behind every printed page.
      retry: false,
    },
    ambient ?? detachedClient(),
  );

  return useMemo(() => {
    const s = query.data;
    const legalName = str(s?.CompanyName);
    const taxNumber = str(s?.TaxNumber);
    // An identity with no name is not an identity — printing a bare VAT number
    // under a report title reads as a stray figure, so it degrades to null.
    const identity: InvoiceIdentity | null = legalName
      ? {
          legalName,
          taxNumber,
          crNumber: str(s?.CrNumber),
          nationalAddress: str(s?.NationalAddress),
        }
      : null;
    return {
      identity,
      entityName: identity?.legalName ?? "",
      taxNumber: identity?.taxNumber ?? "",
      isLoading: query.isLoading && !!ambient && enabled,
      isUnavailable: !identity && !query.isLoading,
    };
  }, [query.data, query.isLoading, ambient, enabled]);
}
