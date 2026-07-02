import type { ReactNode } from "react";
import { Construction } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";

// Phase 1 ships the foundation + the read-only command center. Every other
// route exists and is navigable, rendering a structured placeholder that names
// the phase in which it gets built. This keeps the IA, routing, deep-links and
// the shell fully exercisable now, with zero dead links.

function FeaturePlaceholder({
  eyebrow,
  title,
  subtitle,
  phase,
  children,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  phase: string;
  children?: ReactNode;
}) {
  return (
    <>
      <PageHeader eyebrow={eyebrow} title={title} subtitle={subtitle} />
      <div className="surface grid place-items-center gap-3 p-12 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-teal-50 text-teal-700">
          <Construction className="h-6 w-6" />
        </div>
        <div className="text-base font-extrabold text-slate-800">هذه الشاشة قيد الإنشاء</div>
        <p className="max-w-md text-sm font-medium text-slate-500">
          الأساس والتنقل والصلاحيات جاهزة. تُبنى هذه الشاشة بالكامل في <span className="font-extrabold text-teal-700">{phase}</span>.
        </p>
        {children}
      </div>
    </>
  );
}

// NOTE: Warehouses + Inventory are now REAL pages (features/warehouses,
// features/inventory). The remaining routes below stay as placeholders.
export const ReceiptsPage = () => (
  <FeaturePlaceholder eyebrow="العمليات" title="مركز الاستلام" subtitle="استلام المشتريات والتحويلات مع المطابقة وتسجيل الفروقات." phase="المرحلة 3 (Receipts)" />
);
export const TransfersPage = () => (
  <FeaturePlaceholder eyebrow="العمليات" title="التحويلات وإذونات الصرف" subtitle="دورة واضحة من الطلب إلى الاعتماد ثم الشحن والاستلام التراكمي." phase="المرحلة 3 (Transfers)" />
);
export const StocktakesPage = () => (
  <FeaturePlaceholder eyebrow="الرقابة" title="الجرد والتسويات" subtitle="عدّ محكوم، فروقات مفسّرة، واعتماد يفصل بين العادّ والمراجع — عبر stocktake-pro." phase="المرحلة 3 (Stocktake Pro)" />
);
export const AdjustmentsPage = () => (
  <FeaturePlaceholder eyebrow="الرقابة" title="التعديلات والهدر" subtitle="كل تخفيض أو تسوية بمبرر وأثر مالي ومسار اعتماد." phase="المرحلة 3 (Adjustments/Waste)" />
);
export const ProductionPage = () => (
  <FeaturePlaceholder eyebrow="الإنتاج" title="أوامر الإنتاج" subtitle="توافر المواد، التشغيل، الناتج، الهدر، والتكلفة في مسار واحد." phase="المرحلة 3 (Production)" />
);
export const AnalyticsPage = () => (
  <FeaturePlaceholder eyebrow="ذكاء المخزون" title="التحليلات والتنبيهات" subtitle="التغطية، ABC، الركود، الصلاحية، وإعادة الطلب في لوحة قرار." phase="المرحلة 2 (Analytics)" />
);
export const ReportsPage = () => (
  <FeaturePlaceholder eyebrow="المعلومات" title="مركز التقارير" subtitle="تقارير قابلة للحفظ والمشاركة مع مرشحات موحّدة ومصدر بيانات واضح." phase="المرحلة 2 (Reports)" />
);
export const SystemMapPage = () => (
  <FeaturePlaceholder eyebrow="التصميم التشغيلي" title="خريطة النظام وحركة النوافذ" subtitle="كيف تتحرك البيانات والمستخدم بين الاستلام والمخزون والرقابة والتقارير." phase="المرحلة 4 (Cutover)" />
);
