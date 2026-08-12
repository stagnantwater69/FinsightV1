import { Link } from "react-router-dom";
import { PublicLayout, PublicPageHead } from "../components/PublicLayout";

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

      <div className="mx-auto max-w-3xl px-4 py-16 lg:px-6">
        <div className="rounded-2xl border border-paper-200 bg-paper p-10 text-center">
          <span
            aria-hidden
            className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-tint-brand text-2xl text-tone-brand"
          >
            ✎
          </span>
          <h2 className="mt-4 font-display text-lg font-bold text-ink-900">Nothing published yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-600">
            The first posts are being written. In the meantime, the FAQs cover most of what people ask,
            and the tutorials walk through each feature.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link
              to="/faqs"
              className="tap rounded-lg border border-paper-200 px-4 text-sm font-medium text-ink-700 hover:bg-paper-100"
            >
              Read the FAQs
            </Link>
            <Link
              to="/tutorials"
              className="tap rounded-lg border border-paper-200 px-4 text-sm font-medium text-ink-700 hover:bg-paper-100"
            >
              See the tutorials
            </Link>
          </div>
        </div>
      </div>
    </PublicLayout>
  );
}
