import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { Menu, Moon, Sun, X, ChevronDown } from "lucide-react";

const LANDING_THEME_KEY = "finsight.landingTheme";

/**
 * The landing page's own light/dark toggle — independent of the
 * authenticated app's account theme (ThemeContext), since a visitor here has
 * no account yet. See index.html's landing-theme boot script for how the
 * choice avoids a flash on first paint, and index.css's
 * `[data-landing-theme]` block for where the actual colours live.
 */
function useLandingTheme() {
  const [dark, setDark] = useState(() => document.documentElement.dataset.landingTheme === "dark");

  function toggle() {
    setDark((prev) => {
      const next = !prev;
      document.documentElement.dataset.landingTheme = next ? "dark" : "light";
      try {
        localStorage.setItem(LANDING_THEME_KEY, next ? "dark" : "light");
      } catch {
        // Private browsing / storage disabled — the toggle still works for
        // this visit, it just won't be remembered for the next one.
      }
      return next;
    });
  }

  return { dark, toggle };
}

const RESOURCES = [
  { to: "/blogs", label: "Blogs & Articles" },
  { to: "/tutorials", label: "Video Tutorials" },
  { to: "/faqs", label: "FAQ Center" },
];

function Brand({ size = "md" }: { size?: "sm" | "md" }) {
  const box = size === "sm" ? "h-9 w-9" : "h-11 w-11";
  const text = size === "sm" ? "text-base" : "text-lg";
  return (
    <span className="flex items-center gap-2.5">
      <img src="/finsight-logo.png" alt="" aria-hidden className={`rounded-xl object-contain shadow-sm ${box}`} />
      <span className={`font-landing-display font-bold tracking-tight text-landing-charcoal ${text}`}>FinSight</span>
    </span>
  );
}

// Fully pill-shaped, sitting inside the white nav pill — 2026 redesign.
const NAV_LINK =
  "tap rounded-full px-4 py-2 font-landing-sans text-sm font-medium text-landing-muted transition-colors hover:bg-landing-mint-pale hover:text-landing-charcoal";
const NAV_LINK_ACTIVE =
  "tap rounded-full px-4 py-2 font-landing-sans text-sm font-semibold text-landing-surface bg-landing-charcoal";
const NAV_LINK_ACTIVE_QUIET =
  "tap rounded-full bg-landing-surface/40 px-4 py-2 font-landing-sans text-sm font-semibold text-landing-charcoal";

function ResourcesMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { pathname } = useLocation();

  useEffect(() => setOpen(false), [pathname]);

  function cancelScheduledClose() {
    if (closeTimer.current !== undefined) {
      clearTimeout(closeTimer.current);
      closeTimer.current = undefined;
    }
  }

  /**
   * Opens immediately and cancels any close still pending from a moment ago.
   *
   * Used by BOTH hover and click, and click no longer toggles — it just
   * guarantees open. Toggling used to fight the hover state: a touch tap
   * synthesizes a mouseenter immediately followed by a click, so mouseenter
   * opened it and the very next click toggled it straight back closed, all
   * within one tap. Idempotent open fixes that for free, and a mouse user who
   * is already hovering (so already open) gets no surprise close from
   * clicking the button either.
   */
  function openNow() {
    cancelScheduledClose();
    setOpen(true);
  }

  /**
   * Closes on a short delay rather than instantly.
   *
   * The panel used to be offset from the button by a margin, and crossing
   * that dead strip fired mouseleave and unmounted the panel while the cursor
   * was still travelling toward a link. The padded spacer below removes the
   * gap; this 150ms delay is the second layer, comfortably past any real
   * transit time while still reading as instant when leaving on purpose.
   */
  function closeSoon() {
    cancelScheduledClose();
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  }

  // Pending timer must not fire setState after this component is gone.
  useEffect(() => cancelScheduledClose, []);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    /*
      Opens on hover AND on click, deliberately both — hover for a pointer
      user, click so a keyboard user (Tab, then Enter) can reach it with no
      hover available at all. The handlers sit on the WRAPPER, which encloses
      both the button and the panel, so travelling between them stays inside
      the element being tracked.
    */
    <div ref={ref} className="relative" onMouseEnter={openNow} onMouseLeave={closeSoon}>
      <button
        type="button"
        onClick={openNow}
        aria-expanded={open}
        aria-haspopup="menu"
        className={`${NAV_LINK} flex items-center gap-1.5`}
      >
        <span>Resources</span>
        <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        /* pt-2 (padding, not margin) keeps the hover footprint continuous
           between the button and the panel — see closeSoon above. */
        <div className="absolute right-0 top-full z-30 pt-2">
          <div
            role="menu"
            className="w-48 overflow-hidden rounded-2xl border border-landing-mint-light bg-landing-surface py-1.5 shadow-lg animate-fade-up"
          >
            {RESOURCES.map((r) => (
              <Link
                key={r.to}
                to={r.to}
                role="menuitem"
                className="block px-4 py-2.5 font-landing-sans text-sm font-medium text-landing-charcoal transition-colors hover:bg-landing-mint-pale hover:text-landing-green"
              >
                {r.label}
              </Link>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** True once the page has scrolled past the hero's first pixels. */
function useScrolled(threshold = 8) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    function onScroll() {
      setScrolled(window.scrollY > threshold);
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [threshold]);
  return scrolled;
}

/**
 * Which landing section is currently in view, for the header highlight.
 * Only observes on "/" — other public pages have no landing sections.
 */
function useActiveSection(pathname: string) {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (pathname !== "/" || typeof IntersectionObserver === "undefined") {
      setActive(null);
      return;
    }
    const sections = ["features"]
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (!sections.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.id;
          if (entry.isIntersecting) setActive(id);
          else setActive((prev) => (prev === id ? null : prev));
        }
      },
      { rootMargin: "-20% 0px -60% 0px" },
    );
    sections.forEach((s) => observer.observe(s));
    return () => observer.disconnect();
  }, [pathname]);
  return active;
}

export function PublicLayout({ children }: { children: ReactNode }) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { pathname } = useLocation();
  const scrolled = useScrolled();
  const activeSection = useActiveSection(pathname);
  const { dark, toggle: toggleLandingTheme } = useLandingTheme();

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  // No background scrolling while the mobile navigation is open, and Escape
  // closes it — the panel behaves like the small dialog it visually is.
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMobileMenuOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [mobileMenuOpen]);

  /**
   * `<Link to="/">` is a no-op when already on "/" — react-router sees
   * nothing to navigate to. Home is the one link a visitor clicks while
   * already there, expecting "back to top", so it gets that by hand.
   */
  function handleHomeClick(e: React.MouseEvent<HTMLAnchorElement>) {
    if (pathname !== "/") return;
    e.preventDefault();
    setMobileMenuOpen(false);
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  }

  /**
   * Smooth-scrolls to an in-page landing section when already on "/", and
   * falls back to normal anchor navigation from any other page (the landing
   * page scrolls to the hash on mount — see Landing.tsx).
   */
  function handleSectionClick(id: string) {
    return (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (pathname !== "/") return;
      const el = document.getElementById(id);
      if (!el) return;
      e.preventDefault();
      setMobileMenuOpen(false);
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    };
  }

  const atLandingTop = pathname === "/" && !scrolled;
  const activeNavLink = atLandingTop ? NAV_LINK_ACTIVE_QUIET : NAV_LINK_ACTIVE;

  return (
    <div
      data-theme="classic"
      className="landing-page-surface flex min-h-screen flex-col bg-landing-cream font-landing-sans text-landing-charcoal antialiased"
    >
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-landing-emerald focus:px-4 focus:py-2.5 focus:text-sm focus:font-semibold focus:text-white"
      >
        Skip to content
      </a>

      {/*
        Sticky header. At the top of the landing page it borrows the hero's
        ambient color and drops its dividing line, so it does not read as a
        separate banner. Once the page scrolls it firms up just enough to keep
        controls readable over changing content. The frosted
        blur stays DESKTOP ONLY: backdrop-blur on a sticky element re-blurs on
        every scrolled frame, which is the single most reliable way to make a
        budget Android phone stutter — precisely the device most of these shop
        owners are using. Below md the bar is near-opaque instead.
      */}
      <header
        className={`sticky top-0 z-50 border-b transition-colors duration-200 md:backdrop-blur-md ${
          atLandingTop
            ? "landing-header-at-hero border-transparent shadow-none"
            : scrolled
              ? "border-landing-mint-light/50 bg-landing-surface/90 shadow-sm md:bg-landing-surface/78"
              : "border-transparent bg-landing-cream/90 md:bg-landing-cream/78"
        }`}
      >
        <div className="mx-auto flex max-w-[1240px] items-center justify-between gap-4 px-4 py-3 lg:px-6">
          {/* The logo is also a link to "/" — same back-to-top fix as Home. */}
          <Link to="/" onClick={handleHomeClick} className="tap shrink-0 rounded-xl">
            <Brand />
          </Link>

          {/* The pill recedes into the hero at the top, then gains a clearer
              surface once content can scroll beneath it. */}
          <nav
            aria-label="Main"
            className={`hidden items-center gap-1 rounded-full border p-1.5 md:flex ${
              atLandingTop
                ? "border-transparent bg-transparent shadow-none"
                : "border-landing-mint-light/70 bg-landing-surface/90 shadow-sm"
            }`}
          >
            <Link
              to="/"
              onClick={handleHomeClick}
              aria-current={pathname === "/" && !activeSection ? "page" : undefined}
              className={pathname === "/" && !activeSection ? activeNavLink : NAV_LINK}
            >
              Home
            </Link>
            <a
              href="/#features"
              onClick={handleSectionClick("features")}
              aria-current={activeSection === "features" ? "true" : undefined}
              className={activeSection === "features" ? activeNavLink : NAV_LINK}
            >
              Features
            </a>
            <ResourcesMenu />
            <Link to="/contact" className={NAV_LINK}>
              Contact
            </Link>
          </nav>

          <div className="hidden items-center gap-2 md:flex">
            <Link
              to="/login"
              className="tap rounded-full px-4 py-2 font-landing-sans text-sm font-semibold text-landing-charcoal transition-colors hover:bg-landing-surface"
            >
              Log in
            </Link>
            <button
              type="button"
              onClick={toggleLandingTheme}
              aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
              aria-pressed={dark}
              className={`tap flex h-11 w-11 shrink-0 items-center justify-center rounded-full border text-landing-charcoal transition-colors hover:bg-landing-mint-pale ${
                atLandingTop
                  ? "border-landing-charcoal/10 bg-transparent"
                  : "border-landing-mint-light bg-landing-surface"
              }`}
            >
              {dark ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
            </button>
          </div>

          <button
            type="button"
            onClick={() => setMobileMenuOpen((v) => !v)}
            aria-expanded={mobileMenuOpen}
            aria-label="Toggle navigation menu"
            className={`flex h-11 w-11 items-center justify-center rounded-xl border text-landing-charcoal transition-colors hover:bg-landing-mint-pale md:hidden ${
              atLandingTop
                ? "border-landing-charcoal/10 bg-transparent"
                : "border-landing-mint-light bg-landing-surface"
            }`}
          >
            {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>

        {mobileMenuOpen && (
          <nav
            aria-label="Mobile"
            className="max-h-[calc(100vh-4rem)] space-y-1 overflow-y-auto border-b border-landing-mint-light bg-landing-cream p-4 shadow-lg md:hidden"
          >
            <Link
              to="/"
              onClick={handleHomeClick}
              className="block rounded-xl px-4 py-3 text-sm font-semibold text-landing-charcoal hover:bg-landing-mint-pale"
            >
              Home
            </Link>
            <a
              href="/#features"
              onClick={handleSectionClick("features")}
              className="block rounded-xl px-4 py-3 text-sm font-semibold text-landing-charcoal hover:bg-landing-mint-pale"
            >
              Features
            </a>
            {RESOURCES.map((r) => (
              <Link
                key={r.to}
                to={r.to}
                className="block rounded-xl px-4 py-3 text-sm font-semibold text-landing-charcoal hover:bg-landing-mint-pale"
              >
                {r.label}
              </Link>
            ))}
            <Link
              to="/contact"
              className="block rounded-xl px-4 py-3 text-sm font-semibold text-landing-charcoal hover:bg-landing-mint-pale"
            >
              Contact
            </Link>
            <div className="flex flex-col gap-2 border-t border-landing-mint-light pt-3">
              <Link
                to="/login"
                className="w-full rounded-xl bg-landing-mint-pale py-3 text-center text-sm font-semibold text-landing-charcoal"
              >
                Log in
              </Link>
              <button
                type="button"
                onClick={toggleLandingTheme}
                aria-pressed={dark}
                className="tap flex w-full items-center justify-center gap-2 rounded-xl border border-landing-mint-light bg-landing-surface py-3 font-landing-sans text-sm font-semibold text-landing-charcoal"
              >
                {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                {dark ? "Switch to light mode" : "Switch to dark mode"}
              </button>
            </div>
          </nav>
        )}
      </header>

      <main id="main-content" className="flex-1">
        {children}
      </main>

      <footer className="landing-section-gradient-raised border-t border-landing-mint-light/70 bg-landing-surface py-12 lg:py-16">
        <div className="mx-auto max-w-[1240px] px-4 lg:px-6">
          <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
            <div className="lg:col-span-2">
              <Brand size="md" />
              <p className="mt-4 max-w-sm text-sm leading-relaxed text-landing-muted">
                FinSight is a financial monitoring and decision-support platform built for small business owners.
                Turn daily sales and supplier receipts into real-time profit clarity.
              </p>
            </div>

            <div>
              <h3 className="font-landing-display text-sm font-bold uppercase tracking-wider text-landing-charcoal">
                Product & Help
              </h3>
              <ul className="mt-4 space-y-2.5 text-sm font-medium">
                <li>
                  <a
                    href="/#features"
                    onClick={handleSectionClick("features")}
                    className="rounded text-landing-muted transition-colors hover:text-landing-green"
                  >
                    Features
                  </a>
                </li>
                <li>
                  <Link to="/blogs" className="rounded text-landing-muted transition-colors hover:text-landing-green">
                    Blogs & Articles
                  </Link>
                </li>
                <li>
                  <Link to="/tutorials" className="rounded text-landing-muted transition-colors hover:text-landing-green">
                    Video Tutorials
                  </Link>
                </li>
                <li>
                  <Link to="/faqs" className="rounded text-landing-muted transition-colors hover:text-landing-green">
                    FAQ Center
                  </Link>
                </li>
              </ul>
            </div>

            <div>
              <h3 className="font-landing-display text-sm font-bold uppercase tracking-wider text-landing-charcoal">
                Company & Legal
              </h3>
              <ul className="mt-4 space-y-2.5 text-sm font-medium">
                <li>
                  <Link to="/contact" className="rounded text-landing-muted transition-colors hover:text-landing-green">
                    Contact Us
                  </Link>
                </li>
                <li>
                  <Link to="/privacy" className="rounded text-landing-muted transition-colors hover:text-landing-green">
                    Privacy Policy
                  </Link>
                </li>
                <li>
                  <Link to="/terms" className="rounded text-landing-muted transition-colors hover:text-landing-green">
                    Terms of Service
                  </Link>
                </li>
              </ul>
            </div>
          </div>

          <div className="mt-12 border-t border-landing-mint-light/70 pt-6 text-center sm:flex sm:items-center sm:justify-between sm:text-left">
            <p className="text-xs text-landing-muted">
              © {new Date().getFullYear()} FinSight. A decision support tool — not a substitute for certified
              accounting advice.
            </p>
            <p className="mt-4 text-xs text-landing-muted sm:mt-0">Proudly built in the Philippines 🇵🇭</p>
          </div>
        </div>
      </footer>
    </div>
  );
}

export function PublicPageHead({ eyebrow, title, lede }: { eyebrow: string; title: string; lede?: string }) {
  return (
    <section className="border-b border-landing-mint-light/70 bg-landing-surface py-12 text-center lg:py-16">
      <div className="mx-auto max-w-4xl px-4 lg:px-6">
        <p className="text-xs font-bold uppercase tracking-wider text-landing-green">{eyebrow}</p>
        <h1 className="mt-3 font-landing-display text-3xl font-bold text-landing-charcoal sm:text-4xl">{title}</h1>
        {lede ? <p className="mx-auto mt-4 max-w-2xl text-base text-landing-muted">{lede}</p> : null}
      </div>
    </section>
  );
}
