import { PublicLayout } from "../components/PublicLayout";
import { HeroSection } from "../components/landing/HeroSection";
import { ProductShowcase } from "../components/landing/ProductShowcase";
import { BentoGridFeatures } from "../components/landing/BentoGridFeatures";
import { ProcessTimeline } from "../components/landing/ProcessTimeline";
import { SafeguardsGrid } from "../components/landing/SafeguardsGrid";
import { FaqAccordion } from "../components/landing/FaqAccordion";
import { ClosingCta } from "../components/landing/ClosingCta";

/**
 * The public landing page.
 *
 * EVERY CLAIM ON THIS PAGE HAS TO BE TRUE. That is not a style note — it is
 * the constraint the section list is built around, and it is why two sections
 * that used to sit here are gone:
 *
 *   - a statistics strip reading "500+ Local Merchants", "₱2.5M+ Expenses
 *     Tracked" and "99.4% OCR Recognition". None of those numbers came from
 *     anywhere. The OCR one was also contradicted by the project's own
 *     measurements (see tests/ocr-accuracy), which put item extraction at 87%
 *     on a corpus that is mostly synthetic.
 *   - three testimonials from named shop owners in Pasig, Quezon City and
 *     Cebu, with peso amounts they had supposedly recovered, under a heading
 *     that called them "Real stories". No such people were interviewed.
 *
 * Invented social proof is the easiest thing on a landing page to write and
 * the worst to be asked about. What replaces it is evidence that survives the
 * question "where did that come from": a hero running the REAL RecoveryMeter
 * component on figures labelled as an example, safeguards that each describe
 * something the code actually does, and an FAQ that answers "no" where the
 * answer is no.
 */
export function Landing() {
  return (
    <PublicLayout>
      {/* 1. Hero Section */}
      <HeroSection />

      {/* 3. Interactive Product & AI Showcase */}
      <ProductShowcase />

      {/* 4. Bento Grid Feature Architecture */}
      <BentoGridFeatures />

      {/* 5. 3-Step Connected Process Timeline */}
      <ProcessTimeline />

      {/* Privacy & security safeguards */}
      <SafeguardsGrid />

      {/* 8. Frequently Asked Questions Accordion */}
      <FaqAccordion />

      {/* 9. Closing Conversion Call-To-Action */}
      <ClosingCta />
    </PublicLayout>
  );
}
