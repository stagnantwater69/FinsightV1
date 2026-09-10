import { Link } from "react-router-dom";
import { PublicLayout, PublicPageHead } from "../components/PublicLayout";
import { BookOpen, GraduationCap } from "lucide-react";

/**
 * Blogs — routed and reachable, with nothing published yet.
 *
 * An empty state rather than invented articles. The nav promises this page
 * exists, so it has to resolve to something honest; filling it with
 * plausible-looking posts nobody wrote would be worse than saying there are
 * none. When posts exist they replace this block.
 */
export function Blogs() {
  return (
    <PublicLayout>
      <PublicPageHead
        eyebrow="Help Center"
        title="Blogs"
        lede="Notes on running the money side of a small shop — what the numbers tend to show, and what to do about it."
      />

      <div className="mx-auto max-w-[1240px] px-4 py-14 lg:px-6 lg:py-20">
        <div className="mx-auto max-w-3xl border-y border-landing-mint-light py-12 text-center sm:py-16">
          <span
            aria-hidden
            className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-landing-mint-pale text-landing-green"
          >
            <BookOpen className="h-6 w-6" />
          </span>
          <h2 className="mt-5 font-landing-display text-xl font-bold text-landing-charcoal">Nothing published yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-landing-muted">
            The first posts are being written. In the meantime, the FAQs cover most of what people ask,
            and the tutorials walk through each feature.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link
              to="/faqs"
              className="tap gap-2 rounded-full border border-landing-mint-light bg-landing-surface px-5 text-sm font-semibold text-landing-charcoal hover:bg-landing-mint-pale"
            >
              <BookOpen className="h-4 w-4" />
              Read the FAQs
            </Link>
            <Link
              to="/tutorials"
              className="tap gap-2 rounded-full border border-landing-mint-light bg-landing-surface px-5 text-sm font-semibold text-landing-charcoal hover:bg-landing-mint-pale"
            >
              <GraduationCap className="h-4 w-4" />
              See the tutorials
            </Link>
          </div>
        </div>
      </div>
    </PublicLayout>
  );
}
