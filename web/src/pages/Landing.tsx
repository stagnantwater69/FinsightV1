import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { PublicLayout } from "../components/PublicLayout";
import { HeroSection } from "../components/landing/HeroSection";
import { TrustMetrics } from "../components/landing/TrustMetrics";
import { ProductShowcase } from "../components/landing/ProductShowcase";
import { BentoGridFeatures } from "../components/landing/BentoGridFeatures";
import { ProcessTimeline } from "../components/landing/ProcessTimeline";
import { SafeguardsGrid } from "../components/landing/SafeguardsGrid";
import { FaqAccordion } from "../components/landing/FaqAccordion";
import { ClosingCta } from "../components/landing/ClosingCta";

// Marketing previews use illustrative figures, never customer data or usage claims.
export function Landing() {
  const { hash } = useLocation();

  // Arriving at "/#features" from another page: scroll to the section once
  // it exists. Same-page clicks are handled by the header (PublicLayout).
  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(hash.slice(1));
    if (!el) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  }, [hash]);

  return (
    <PublicLayout>
      <HeroSection />
      <TrustMetrics />
      <ProductShowcase />
      <BentoGridFeatures />
      <ProcessTimeline />
      <SafeguardsGrid />
      <FaqAccordion />
      <ClosingCta />
    </PublicLayout>
  );
}
