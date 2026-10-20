import "./mobile-dashboard-preview.css";

interface MobileDashboardPreviewProps {
  compact?: boolean;
  className?: string;
}

export function MobileDashboardPreview({ compact = false, className = "" }: MobileDashboardPreviewProps) {
  return (
    <div
      className={`landing-mobile-dashboard-preview${compact ? " landing-mobile-dashboard-preview--compact" : ""} ${className}`}
      role="img"
      aria-label="FinSight mobile Home dashboard with illustrative October records: money in PHP 84,500, money out PHP 56,200, net PHP 28,300, and available funds PHP 78,300."
    >
      <div className="landing-mobile-dashboard-preview__screen">
        <img
          src="/landing/dashboard-mobile.webp"
          alt=""
          width={780}
          height={1688}
          loading={compact ? "lazy" : "eager"}
          decoding="async"
          draggable={false}
        />
      </div>
    </div>
  );
}
