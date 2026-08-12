import type { ComponentType } from "react";
import {
  AlertTriangle,
  ArrowLeftRight,
  BadgeDollarSign,
  Boxes,
  CalendarClock,
  ClipboardCheck,
  Factory,
  FileCheck2,
  FileSearch,
  PackageMinus,
  ReceiptText,
  Scale,
  ScanSearch,
  ShieldCheck,
  ShoppingCart,
  Tags,
  Truck,
  UserRoundSearch,
  Warehouse,
} from "lucide-react";

export type ReportFamily =
  | "stock"
  | "valuation"
  | "movement"
  | "procurement"
  | "productionCost"
  | "reconciliation";

export type ReportMaturity = "authoritative" | "operational" | "conditional";

export type ReportBasis =
  | "currentBalance"
  | "postedMovement"
  | "postedReceipt"
  | "p2pDocument"
  | "supplierLedger"
  | "lotLayer"
  | "frozenCost";

export interface IntelligenceReportLink {
  id: string;
  labelKey: string;
  descriptionKey: string;
  to: string;
  icon: ComponentType<{ className?: string }>;
  family: ReportFamily;
  maturity: ReportMaturity;
  basis: ReportBasis;
  standard?: "ias2" | "zatca" | "internalControl";
  requiresSupplier?: boolean;
}

export interface ReportFamilyDefinition {
  id: ReportFamily;
  labelKey: string;
  descriptionKey: string;
  icon: ComponentType<{ className?: string }>;
}

export const REPORT_FAMILIES: ReportFamilyDefinition[] = [
  { id: "stock", labelKey: "warehouseIntelligence.families.stock.label", descriptionKey: "warehouseIntelligence.families.stock.description", icon: Boxes },
  { id: "valuation", labelKey: "warehouseIntelligence.families.valuation.label", descriptionKey: "warehouseIntelligence.families.valuation.description", icon: BadgeDollarSign },
  { id: "movement", labelKey: "warehouseIntelligence.families.movement.label", descriptionKey: "warehouseIntelligence.families.movement.description", icon: ArrowLeftRight },
  { id: "procurement", labelKey: "warehouseIntelligence.families.procurement.label", descriptionKey: "warehouseIntelligence.families.procurement.description", icon: ShoppingCart },
  { id: "productionCost", labelKey: "warehouseIntelligence.families.productionCost.label", descriptionKey: "warehouseIntelligence.families.productionCost.description", icon: Factory },
  { id: "reconciliation", labelKey: "warehouseIntelligence.families.reconciliation.label", descriptionKey: "warehouseIntelligence.families.reconciliation.description", icon: ShieldCheck },
];

export const INVENTORY_INTELLIGENCE_REPORTS: IntelligenceReportLink[] = [
  { id: "stock-balance", labelKey: "warehouseIntelligence.reports.stockBalance.label", descriptionKey: "warehouseIntelligence.reports.stockBalance.description", to: "/reports/inventory/stock-balance", icon: Boxes, family: "stock", maturity: "authoritative", basis: "currentBalance" },
  { id: "warehouse-compare", labelKey: "warehouseIntelligence.reports.warehouseCompare.label", descriptionKey: "warehouseIntelligence.reports.warehouseCompare.description", to: "/reports/inventory/warehouse-compare", icon: Warehouse, family: "stock", maturity: "authoritative", basis: "currentBalance" },
  { id: "low-stock", labelKey: "warehouseIntelligence.reports.lowStock.label", descriptionKey: "warehouseIntelligence.reports.lowStock.description", to: "/reports/inventory/low-stock", icon: PackageMinus, family: "stock", maturity: "operational", basis: "currentBalance" },
  { id: "valuation", labelKey: "warehouseIntelligence.reports.valuation.label", descriptionKey: "warehouseIntelligence.reports.valuation.description", to: "/reports/inventory/valuation", icon: BadgeDollarSign, family: "valuation", maturity: "conditional", basis: "currentBalance", standard: "ias2" },
  { id: "no-movement", labelKey: "warehouseIntelligence.reports.noMovement.label", descriptionKey: "warehouseIntelligence.reports.noMovement.description", to: "/reports/inventory/no-movement", icon: CalendarClock, family: "valuation", maturity: "conditional", basis: "postedMovement", standard: "ias2" },
  { id: "sales-cost-profitability", labelKey: "warehouseIntelligence.reports.salesCostProfitability.label", descriptionKey: "warehouseIntelligence.reports.salesCostProfitability.description", to: "/reports/sales/items?view=profitability", icon: BadgeDollarSign, family: "productionCost", maturity: "conditional", basis: "frozenCost", standard: "ias2" },
  { id: "movements", labelKey: "warehouseIntelligence.reports.movements.label", descriptionKey: "warehouseIntelligence.reports.movements.description", to: "/reports/inventory/movements", icon: ArrowLeftRight, family: "movement", maturity: "operational", basis: "postedMovement" },
  { id: "transfers", labelKey: "warehouseIntelligence.reports.transfers.label", descriptionKey: "warehouseIntelligence.reports.transfers.description", to: "/reports/inventory/transfers", icon: Truck, family: "movement", maturity: "operational", basis: "postedMovement", standard: "internalControl" },
  { id: "receipts-issues", labelKey: "warehouseIntelligence.reports.receiptsIssues.label", descriptionKey: "warehouseIntelligence.reports.receiptsIssues.description", to: "/reports/inventory/receipts-issues", icon: ReceiptText, family: "movement", maturity: "operational", basis: "postedMovement" },
  { id: "adjustments", labelKey: "warehouseIntelligence.reports.adjustments.label", descriptionKey: "warehouseIntelligence.reports.adjustments.description", to: "/reports/inventory/adjustments", icon: Scale, family: "reconciliation", maturity: "operational", basis: "postedMovement", standard: "internalControl" },
  { id: "stocktakes", labelKey: "warehouseIntelligence.reports.stocktakes.label", descriptionKey: "warehouseIntelligence.reports.stocktakes.description", to: "/reports/inventory/stocktakes", icon: ClipboardCheck, family: "reconciliation", maturity: "operational", basis: "postedMovement", standard: "internalControl" },
  { id: "expiry", labelKey: "warehouseIntelligence.reports.expiry.label", descriptionKey: "warehouseIntelligence.reports.expiry.description", to: "/reports/inventory/expiry", icon: AlertTriangle, family: "reconciliation", maturity: "conditional", basis: "lotLayer", standard: "ias2" },
  { id: "data-quality", labelKey: "warehouseIntelligence.reports.dataQuality.label", descriptionKey: "warehouseIntelligence.reports.dataQuality.description", to: "/reports/inventory/data-quality", icon: ShieldCheck, family: "reconciliation", maturity: "operational", basis: "currentBalance", standard: "internalControl" },
];

export const PURCHASING_INTELLIGENCE_REPORTS: IntelligenceReportLink[] = [
  { id: "purchase-detail", labelKey: "warehouseIntelligence.reports.purchaseDetail.label", descriptionKey: "warehouseIntelligence.reports.purchaseDetail.description", to: "/reports/purchasing#purchase-ledger", icon: FileSearch, family: "procurement", maturity: "authoritative", basis: "postedReceipt" },
  { id: "by-supplier", labelKey: "warehouseIntelligence.reports.bySupplier.label", descriptionKey: "warehouseIntelligence.reports.bySupplier.description", to: "/reports/purchasing#supplier-analysis", icon: UserRoundSearch, family: "procurement", maturity: "authoritative", basis: "postedReceipt" },
  { id: "by-item", labelKey: "warehouseIntelligence.reports.byItem.label", descriptionKey: "warehouseIntelligence.reports.byItem.description", to: "/reports/purchasing#purchase-ledger", icon: Tags, family: "procurement", maturity: "authoritative", basis: "postedReceipt" },
  { id: "open-orders", labelKey: "warehouseIntelligence.reports.openOrders.label", descriptionKey: "warehouseIntelligence.reports.openOrders.description", to: "/reports/purchasing?report=open-orders#specialized-report", icon: ShoppingCart, family: "procurement", maturity: "authoritative", basis: "p2pDocument" },
  { id: "purchase-analysis", labelKey: "warehouseIntelligence.reports.purchaseAnalysis.label", descriptionKey: "warehouseIntelligence.reports.purchaseAnalysis.description", to: "/reports/purchasing?report=purchase-analysis#specialized-report", icon: UserRoundSearch, family: "procurement", maturity: "conditional", basis: "supplierLedger" },
  { id: "receiving-variance", labelKey: "warehouseIntelligence.reports.receivingVariance.label", descriptionKey: "warehouseIntelligence.reports.receivingVariance.description", to: "/reports/purchasing?report=receiving-variance#specialized-report", icon: Truck, family: "reconciliation", maturity: "conditional", basis: "p2pDocument", standard: "internalControl" },
  { id: "three-way-match", labelKey: "warehouseIntelligence.reports.threeWayMatch.label", descriptionKey: "warehouseIntelligence.reports.threeWayMatch.description", to: "/reports/purchasing?report=three-way-match#specialized-report", icon: FileCheck2, family: "reconciliation", maturity: "conditional", basis: "p2pDocument", standard: "internalControl" },
  { id: "price-variance", labelKey: "warehouseIntelligence.reports.priceVariance.label", descriptionKey: "warehouseIntelligence.reports.priceVariance.description", to: "/reports/purchasing?report=price-variance#specialized-report", icon: BadgeDollarSign, family: "productionCost", maturity: "conditional", basis: "p2pDocument" },
  { id: "tax", labelKey: "warehouseIntelligence.reports.inputTax.label", descriptionKey: "warehouseIntelligence.reports.inputTax.description", to: "/reports/purchasing?report=tax#specialized-report", icon: ReceiptText, family: "reconciliation", maturity: "conditional", basis: "supplierLedger", standard: "zatca" },
  { id: "ap-aging", labelKey: "warehouseIntelligence.reports.apAging.label", descriptionKey: "warehouseIntelligence.reports.apAging.description", to: "/reports/purchasing?report=ap-aging#specialized-report", icon: CalendarClock, family: "procurement", maturity: "conditional", basis: "supplierLedger" },
  { id: "supplier-statement", labelKey: "warehouseIntelligence.reports.supplierStatement.label", descriptionKey: "warehouseIntelligence.reports.supplierStatement.description", to: "/reports/purchasing?report=supplier-statement#specialized-report", icon: FileSearch, family: "procurement", maturity: "conditional", basis: "supplierLedger", requiresSupplier: true },
  { id: "purchase-data-quality", labelKey: "warehouseIntelligence.reports.purchaseDataQuality.label", descriptionKey: "warehouseIntelligence.reports.purchaseDataQuality.description", to: "/reports/purchasing?report=data-quality#specialized-report", icon: ScanSearch, family: "reconciliation", maturity: "operational", basis: "p2pDocument", standard: "internalControl" },
];

export interface ReadinessRequirement {
  id:
    | "ias2Classification" | "nrvWriteDown" | "writeDownReversal" | "pledgedInventory"
    | "valuedStockCard" | "asOfValuation" | "inventoryRollForward" | "inventoryAging"
    | "abcXyzTurnoverDoh" | "replenishmentServiceLevel" | "landedCost" | "supplierPerformance"
    | "inputVatGl" | "productionWipYield" | "recipeStandardActual";
  family: ReportFamily;
  modes: Array<"inventory" | "purchasing">;
}

export const REPORT_READINESS_REQUIREMENTS: ReadinessRequirement[] = [
  { id: "ias2Classification", family: "valuation", modes: ["inventory"] },
  { id: "nrvWriteDown", family: "valuation", modes: ["inventory"] },
  { id: "writeDownReversal", family: "valuation", modes: ["inventory"] },
  { id: "pledgedInventory", family: "valuation", modes: ["inventory"] },
  { id: "valuedStockCard", family: "movement", modes: ["inventory"] },
  { id: "asOfValuation", family: "valuation", modes: ["inventory"] },
  { id: "inventoryRollForward", family: "reconciliation", modes: ["inventory", "purchasing"] },
  { id: "inventoryAging", family: "valuation", modes: ["inventory"] },
  { id: "abcXyzTurnoverDoh", family: "productionCost", modes: ["inventory"] },
  { id: "replenishmentServiceLevel", family: "stock", modes: ["inventory"] },
  { id: "landedCost", family: "productionCost", modes: ["purchasing"] },
  { id: "supplierPerformance", family: "procurement", modes: ["purchasing"] },
  { id: "inputVatGl", family: "reconciliation", modes: ["purchasing"] },
  { id: "productionWipYield", family: "productionCost", modes: ["inventory", "purchasing"] },
  { id: "recipeStandardActual", family: "productionCost", modes: ["inventory", "purchasing"] },
];
