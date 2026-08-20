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

/**
 * The public landing page — the approved emerald/mint/cream card design.
 *
 * EVERY CLAIM ON THIS PAGE HAS TO BE TRUE. That is not a style note — it is
 * the constraint the section list is built around. Two things have already
 * been deleted from earlier versions of this page for violating it:
 *
 *   - a statistics strip with invented usage numbers ("500+ Local Merchants",
 *     "99.4% OCR Recognition" — contradicted by the project's own tests)
 *   - testimonials from shop owners who were never interviewed
 *
 * The redesign's reference mockup showed "20,000+ small businesses" and
 * "5M+ receipts processed"; those numbers do not exist, so TrustMetrics
 * carries truthful statements in the same layout instead (see the comment
 * there). Product mockups on this page are labelled as example figures, and
 * the privacy section's claims each describe something the code enforces.
 */
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
      {/* Hero: pitch + layered dashboard preview */}
      <HeroSection />

      {/* Trust strip — truthful statements, no invented counts */}
      <TrustMetrics />

      {/* Receipt workflow: snap → extract → recorded */}
      <ProductShowcase />

      {/* Bento feature grid */}
      <BentoGridFeatures />

      {/* Three-step how-it-works with the Financial Trail */}
      <ProcessTimeline />

      {/* Privacy & security safeguards — deep emerald */}
      <SafeguardsGrid />

      {/* FAQ accordion */}
      <FaqAccordion />

      {/* Closing conversion banner */}
      <ClosingCta />
    </PublicLayout>
  );
}
