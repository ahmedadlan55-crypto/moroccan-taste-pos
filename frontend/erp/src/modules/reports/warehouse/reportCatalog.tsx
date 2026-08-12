import type { ComponentType } from "react";
import {
  AlertTriangle,
  ArrowLeftRight,
  BadgeDollarSign,
  Boxes,
  CalendarClock,
  ClipboardCheck,
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

export interface IntelligenceReportLink {
  id: string;
  labelKey: string;
  descriptionKey: string;
  to: string;
  icon: ComponentType<{ className?: string }>;
  family: "stock" | "control" | "cost" | "purchase" | "supplier" | "compliance";
}

export const INVENTORY_INTELLIGENCE_REPORTS: IntelligenceReportLink[] = [
  { id: "stock-balance", labelKey: "warehouseIntelligence.reports.stockBalance.label", descriptionKey: "warehouseIntelligence.reports.stockBalance.description", to: "/reports/inventory/stock-balance", icon: Boxes, family: "stock" },
  { id: "valuation", labelKey: "warehouseIntelligence.reports.valuation.label", descriptionKey: "warehouseIntelligence.reports.valuation.description", to: "/reports/inventory/valuation", icon: BadgeDollarSign, family: "cost" },
  { id: "movements", labelKey: "warehouseIntelligence.reports.movements.label", descriptionKey: "warehouseIntelligence.reports.movements.description", to: "/reports/inventory/movements", icon: ArrowLeftRight, family: "control" },
  { id: "low-stock", labelKey: "warehouseIntelligence.reports.lowStock.label", descriptionKey: "warehouseIntelligence.reports.lowStock.description", to: "/reports/inventory/low-stock", icon: PackageMinus, family: "control" },
  { id: "warehouse-compare", labelKey: "warehouseIntelligence.reports.warehouseCompare.label", descriptionKey: "warehouseIntelligence.reports.warehouseCompare.description", to: "/reports/inventory/warehouse-compare", icon: Warehouse, family: "stock" },
  { id: "transfers", labelKey: "warehouseIntelligence.reports.transfers.label", descriptionKey: "warehouseIntelligence.reports.transfers.description", to: "/reports/inventory/transfers", icon: Truck, family: "control" },
  { id: "receipts-issues", labelKey: "warehouseIntelligence.reports.receiptsIssues.label", descriptionKey: "warehouseIntelligence.reports.receiptsIssues.description", to: "/reports/inventory/receipts-issues", icon: ReceiptText, family: "control" },
  { id: "adjustments", labelKey: "warehouseIntelligence.reports.adjustments.label", descriptionKey: "warehouseIntelligence.reports.adjustments.description", to: "/reports/inventory/adjustments", icon: Scale, family: "control" },
  { id: "stocktakes", labelKey: "warehouseIntelligence.reports.stocktakes.label", descriptionKey: "warehouseIntelligence.reports.stocktakes.description", to: "/reports/inventory/stocktakes", icon: ClipboardCheck, family: "control" },
  { id: "no-movement", labelKey: "warehouseIntelligence.reports.noMovement.label", descriptionKey: "warehouseIntelligence.reports.noMovement.description", to: "/reports/inventory/no-movement", icon: CalendarClock, family: "cost" },
  { id: "expiry", labelKey: "warehouseIntelligence.reports.expiry.label", descriptionKey: "warehouseIntelligence.reports.expiry.description", to: "/reports/inventory/expiry", icon: AlertTriangle, family: "control" },
  { id: "data-quality", labelKey: "warehouseIntelligence.reports.dataQuality.label", descriptionKey: "warehouseIntelligence.reports.dataQuality.description", to: "/reports/inventory/data-quality", icon: ShieldCheck, family: "compliance" },
];

export const PURCHASING_INTELLIGENCE_REPORTS: IntelligenceReportLink[] = [
  { id: "purchase-detail", labelKey: "warehouseIntelligence.reports.purchaseDetail.label", descriptionKey: "warehouseIntelligence.reports.purchaseDetail.description", to: "/reports/purchasing#purchase-ledger", icon: FileSearch, family: "purchase" },
  { id: "by-supplier", labelKey: "warehouseIntelligence.reports.bySupplier.label", descriptionKey: "warehouseIntelligence.reports.bySupplier.description", to: "/reports/purchasing#supplier-analysis", icon: UserRoundSearch, family: "supplier" },
  { id: "by-item", labelKey: "warehouseIntelligence.reports.byItem.label", descriptionKey: "warehouseIntelligence.reports.byItem.description", to: "/reports/purchasing#purchase-ledger", icon: Tags, family: "purchase" },
  { id: "open-orders", labelKey: "warehouseIntelligence.reports.openOrders.label", descriptionKey: "warehouseIntelligence.reports.openOrders.description", to: "/reports/purchasing?report=open-orders#specialized-report", icon: ShoppingCart, family: "purchase" },
  { id: "receiving-variance", labelKey: "warehouseIntelligence.reports.receivingVariance.label", descriptionKey: "warehouseIntelligence.reports.receivingVariance.description", to: "/reports/purchasing?report=receiving-variance#specialized-report", icon: Truck, family: "control" },
  { id: "three-way-match", labelKey: "warehouseIntelligence.reports.threeWayMatch.label", descriptionKey: "warehouseIntelligence.reports.threeWayMatch.description", to: "/reports/purchasing?report=three-way-match#specialized-report", icon: FileCheck2, family: "compliance" },
  { id: "price-variance", labelKey: "warehouseIntelligence.reports.priceVariance.label", descriptionKey: "warehouseIntelligence.reports.priceVariance.description", to: "/reports/purchasing?report=price-variance#specialized-report", icon: BadgeDollarSign, family: "cost" },
  { id: "purchase-analysis", labelKey: "warehouseIntelligence.reports.purchaseAnalysis.label", descriptionKey: "warehouseIntelligence.reports.purchaseAnalysis.description", to: "/reports/purchasing?report=purchase-analysis#specialized-report", icon: UserRoundSearch, family: "supplier" },
  { id: "tax", labelKey: "warehouseIntelligence.reports.inputTax.label", descriptionKey: "warehouseIntelligence.reports.inputTax.description", to: "/reports/purchasing?report=tax#specialized-report", icon: ReceiptText, family: "compliance" },
  { id: "ap-aging", labelKey: "warehouseIntelligence.reports.apAging.label", descriptionKey: "warehouseIntelligence.reports.apAging.description", to: "/reports/purchasing?report=ap-aging#specialized-report", icon: CalendarClock, family: "supplier" },
  { id: "purchase-data-quality", labelKey: "warehouseIntelligence.reports.purchaseDataQuality.label", descriptionKey: "warehouseIntelligence.reports.purchaseDataQuality.description", to: "/reports/purchasing?report=data-quality#specialized-report", icon: ScanSearch, family: "compliance" },
];
