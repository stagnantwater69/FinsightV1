import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { ButtonLink } from "./Button";
import { Menu, X, ChevronDown, Activity } from "lucide-react";

const RESOURCES = [
  { to: "/blogs", label: "Blogs & Articles" },
  { to: "/tutorials", label: "Video Tutorials" },
  { to: "/faqs", label: "FAQ Center" },
];

/**
 * `invert` is for the landing hero, where the bar floats on deep green and
 * every ink-* token would resolve to something unreadable.
 */
type Tone = "ink" | "invert";

/**
 * One source of truth for a desktop nav item's look, because the same three
 * states (default, hover, current page) now have to be expressed twice — once
 * in ink on paper, once in white on green — and there are five call sites
 * between the links and the Resources trigger.
 *
 * `active` is new: the inverted bar renders the current page as a filled white
 * pill, which needs the router to say which page that is. On the ink tone it
 * is a quiet tint, so the six pages that already used this header do not
 * suddenly grow a loud selected state.
 */
function navLinkClasses(tone: Tone, active = false) {
  const shape = "rounded-full px-[15px] py-2 text-[13.5px]";
  if (tone === "invert") {
    return active
      ? `${shape} bg-white/[0.92] font-semibold text-[#06231c]`
      : `${shape} font-medium text-white/[0.72] hover:bg-white/10 hover:text-white`;
  }
  return active
    ? `${shape} bg-paper-100 font-semibold text-ink-900`
    : `${shape} font-medium text-ink-600 hover:bg-paper-100 hover:text-ink-900`;
}

function Brand({ size = "md", tone = "ink" }: { size?: "sm" | "md"; tone?: Tone }) {
  const box = size === "sm" ? "h-7 w-7" : "h-9 w-9";
  const text = size === "sm" ? "text-base" : "text-lg";
  return (
    <span className="flex items-center gap-2.5">
      {/*
        The owl, replacing a rounded square with an "F" in it. The artwork was
        already sitting in public/ unused; the wordmark beside it carries the
        name, so the image is decorative and takes an empty alt rather than
        making a screen reader announce "FinSight FinSight".

        Width and height are set so the row reserves its space before the
        image decodes — without them the wordmark jumps left on first paint.
      */}
      <img
        src="/finsight-owl.webp"
        alt=""
        aria-hidden
        width={36}
        height={36}
        className={`${box} shrink-0 object-contain`}
      />
      <span
        className={`font-display font-bold tracking-tight ${text} ${tone === "invert" ? "text-white" : "text-ink-900"}`}
      >
        FinSight
      </span>
    </span>
  );
}

function ResourcesMenu({ tone = "ink" }: { tone?: Tone }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { pathname } = useLocation();
  const active = RESOURCES.some((r) => r.to === pathname);

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
   * THE BUG THIS FIXES: moving the pointer from the button down into the
   * panel used to cross empty space with nothing rendered in it — the panel
   * was offset from the button by `mt-2` (8px), and that gap belonged to
   * neither element. The browser's mouseleave firing is based on what is
   * actually under the pointer, not on the wrapper's logical shape, so
   * crossing that dead pixel strip fired mouseleave on the wrapper and
   * unmounted the panel WHILE the cursor was still travelling toward a link —
   * before the click could ever land. That is the exact bug reported: hover
   * shows the menu, but trying to move down and select an item makes it
   * disappear first.
   *
   * Removing the gap (see the padded spacer below) fixes the root cause. This
   * delay is the second layer: real mouse movement is rarely instant even
   * with no gap at all, and 150ms is comfortably past any real transit time
   * while still reading as instant to a user moving the pointer away on
   * purpose. onMouseEnter on the panel or the button cancels it before it
   * fires.
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
      hover available at all. onFocus/onBlur is not used instead of hover
      because the panel needs to survive the pointer travelling from the
      button down into it, and these handlers sit on the WRAPPER, which
      encloses both, so that traversal is inside the element being tracked.
    */
    <div ref={ref} className="relative" onMouseEnter={openNow} onMouseLeave={closeSoon}>
      <button
        type="button"
        onClick={openNow}
        aria-expanded={open}
        aria-haspopup="menu"
        className={`tap flex items-center gap-1.5 transition-colors ${navLinkClasses(tone, active)}`}
      >
        <span>Resources</span>
        <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        /*
          The GAP FIX: `pt-2` is the visual spacing that `mt-2` used to be,
          moved from margin (outside this element's box, hoverable by nothing)
          to padding (inside this element's box, hoverable as part of it). The
          bordered, shadowed panel a visitor actually sees is the nested div
          below — this outer one is invisible and exists only so the full
          vertical span from the button to the panel is continuously part of
          the wrapper's hover footprint, with no dead strip in between.
        */
        <div className="absolute right-0 top-full z-30 pt-2">
          <div
            role="menu"
            className="w-48 overflow-hidden rounded-2xl border border-paper-200 bg-paper py-1.5 shadow-xl ring-1 ring-black/5"
          >
            {RESOURCES.map((r) => (
              <Link
                key={r.to}
                to={r.to}
                role="menuitem"
                className="block px-4 py-2.5 text-sm font-medium text-ink-700 hover:bg-paper-100 hover:text-ink-900 transition-colors"
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

export function PublicLayout({
  children,
  overlay = false,
}: {
  children: ReactNode;
  /**
   * Float the header ON the page's first section instead of sitting above it
   * on paper. Opt-in, and currently only the landing page opts in: its hero
   * paints a deep-green wash that runs up behind the bar, and the six other
   * public pages start on a light surface where white nav text would vanish.
   */
  overlay?: boolean;
}) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  /**
   * The overlay bar is transparent over the hero and opaque past it.
   *
   * Without this it stays transparent all the way down, so white nav text
   * ends up floating over the white feature sections — unreadable, and the
   * header is sticky, so it is on screen for the entire page.
   *
   * 24px rather than the hero's full height: the switch wants to happen as
   * soon as the bar is no longer over the very top of the wash, and measuring
   * the hero would couple this component to the landing page's markup.
   * `passive` because the handler never calls preventDefault, which lets the
   * browser keep scrolling without waiting on it.
   */
  useEffect(() => {
    if (!overlay) return;
    function onScroll() {
      setScrolled(window.scrollY > 24);
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [overlay]);

  // Inverted for the whole scroll, not just over the hero: once past it the
  // bar goes opaque dark green rather than turning into a paper bar, so the
  // nav never has to change colour underneath the pointer.
  const tone: Tone = overlay ? "invert" : "ink";

  /**
   * THE BUG: clicking "Home" while already on "/" did nothing.
   *
   * `<Link to="/">` is a no-op when the destination equals the current path —
   * react-router sees nothing to navigate to, so it does not touch the URL,
   * the scroll position, or anything else. That is invisible on most nav
   * links, because you are usually clicking them FROM a different page. Home
   * is the one link a visitor clicks while already there — typically after
   * scrolling down via the Features link — expecting it to act like a
   * "back to top", and Link has no such behaviour to fall back to.
   *
   * So Home gets its own handler: when already on "/", scroll to the top by
   * hand and skip the no-op navigation. From anywhere else, do nothing extra
   * and let Link navigate normally — that case already worked.
   */
  function handleHomeClick(e: React.MouseEvent<HTMLAnchorElement>) {
    if (pathname !== "/") return;
    e.preventDefault();
    setMobileMenuOpen(false);
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  }

  return (
    <div data-theme="classic" className="flex min-h-screen flex-col bg-paper-50 font-sans antialiased text-ink-900">
      {/*
        Sticky header. The frosted-glass effect is DESKTOP ONLY, deliberately.

        `backdrop-blur` forces the browser to re-sample and re-blur everything
        behind the header, and on a sticky element that happens on every frame
        of every scroll. It is the single most reliable way to make a page
        stutter on a budget Android phone — precisely the device most of these
        shop owners are using.

        Below `md` the bar is near-opaque instead, which costs nothing to
        composite and looks almost identical at 95% (the blur was only ever
        showing through 15% of a solid colour). Above `md`, where there is a
        real GPU, the glass comes back.

        The overlay variant follows the same rule for the same reason — it
        just resolves to green instead of paper, and to nothing at all while
        it is still sitting on the hero.
      */}
      <header
        className={
          overlay
            ? `sticky top-0 z-50 border-b transition-colors duration-300 ${scrolled
              ? "border-white/10 bg-[#04231a]/95 md:bg-[#04231a]/85 md:backdrop-blur-md"
              : "border-transparent bg-transparent"
            }`
            : "sticky top-0 z-50 border-b border-paper-200/80 bg-paper/95 transition md:bg-paper/85 md:backdrop-blur-md"
        }
      >
        <div
          className={`mx-auto flex items-center justify-between px-4 py-3.5 lg:px-6 ${overlay ? "max-w-[1440px] lg:px-14" : "max-w-6xl"
            }`}
        >
          {/* Same fix as the Home link below — the logo is also a link to
              "/" and had the identical no-op-while-already-home bug. */}
          <Link to="/" onClick={handleHomeClick} className="tap rounded-xl">
            <Brand tone={tone} />
          </Link>

          {/*
            Desktop Navigation Links. In overlay mode they sit inside a glass
            capsule, which is what gives the current-page pill something to be
            a pill *within*; on paper they stay as loose items, unchanged.
          */}
          <nav
            className={`hidden items-center md:flex ${overlay
                ? "gap-0.5 rounded-full border border-white/[0.09] bg-white/5 px-[7px] py-[5px] backdrop-blur-[14px]"
                : "gap-1"
              }`}
          >
            <Link
              to="/"
              onClick={handleHomeClick}
              className={`tap transition-colors ${navLinkClasses(tone, pathname === "/")}`}
            >
              Home
            </Link>
            <a href="/#features" className={`tap transition-colors ${navLinkClasses(tone)}`}>
              Features
            </a>
            <ResourcesMenu tone={tone} />
            <Link to="/contact" className={`tap transition-colors ${navLinkClasses(tone, pathname === "/contact")}`}>
              Contact
            </Link>
          </nav>

          {/* Desktop Right Action Buttons */}
          <div className={`hidden items-center md:flex ${overlay ? "gap-[18px]" : "gap-2"}`}>
            <Link
              to="/login"
              className={`tap rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${overlay ? "text-white/85 hover:text-white" : "text-ink-700 hover:bg-paper-100 hover:text-ink-900"
                }`}
            >
              Log in
            </Link>
            {/* Mint on the dark bar, amber on paper — see the accent-rule note
                in landing/HeroSection.tsx. The two CTAs on the landing page
                have to be the same colour as each other, and the hero's is
                the one the mockup pins down. */}
            <ButtonLink
              to="/register"
              variant="primary"
              size="sm"
              /* The glow is overlay-only. On the six paper-header pages this
                 button is amber on near-white, where a halo has nothing dark
                 to read against and just muddies the edge. */
              className={
                overlay
                  ? "glow-cta rounded-full px-5 py-2.5 text-[13.5px] font-bold transition hover:brightness-95"
                  : "bg-accent-400 text-ink-950 hover:bg-accent-300 font-bold shadow-xs px-4 py-2 rounded-xl transition"
              }
              style={
                overlay ? ({ backgroundColor: "#9be8a0", color: "#06231c", "--glow-color": "#9be8a0" } as CSSProperties) : undefined
              }
            >
              Get started free
            </ButtonLink>
          </div>

          {/* Mobile Menu Toggle Button */}
          <button
            type="button"
            onClick={() => setMobileMenuOpen((v) => !v)}
            className={`flex h-10 w-10 items-center justify-center rounded-xl border md:hidden ${overlay
                ? "border-white/15 bg-white/10 text-white hover:bg-white/20"
                : "border-paper-200 bg-paper text-ink-700 hover:bg-paper-100"
              }`}
            aria-label="Toggle Navigation Menu"
          >
            {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>

        {/*
          Mobile Dropdown Menu. Stays on paper even in overlay mode — it is an
          opaque sheet covering the top of the page rather than something
          floating on the hero, and inverting it would mean a second full set
          of colours for no gain.
        */}
        {mobileMenuOpen && (
          <div className="border-b border-paper-200 bg-paper p-4 md:hidden space-y-2 shadow-lg">
            <Link
              to="/"
              onClick={handleHomeClick}
              className="block rounded-xl px-4 py-2.5 text-sm font-semibold text-ink-700 hover:bg-paper-100"
            >
              Home
            </Link>
            <a
              href="/#features"
              className="block rounded-xl px-4 py-2.5 text-sm font-semibold text-ink-700 hover:bg-paper-100"
            >
              Features
            </a>
            <Link
              to="/blogs"
              className="block rounded-xl px-4 py-2.5 text-sm font-semibold text-ink-700 hover:bg-paper-100"
            >
              Blogs
            </Link>
            <Link
              to="/tutorials"
              className="block rounded-xl px-4 py-2.5 text-sm font-semibold text-ink-700 hover:bg-paper-100"
            >
              Tutorials
            </Link>
            <Link
              to="/contact"
              className="block rounded-xl px-4 py-2.5 text-sm font-semibold text-ink-700 hover:bg-paper-100"
            >
              Contact
            </Link>
            <div className="pt-2 flex flex-col gap-2 border-t border-paper-200">
              <Link
                to="/login"
                className="w-full text-center rounded-xl py-2.5 text-sm font-semibold text-ink-800 bg-paper-100"
              >
                Log in
              </Link>
              <ButtonLink
                to="/register"
                variant="primary"
                size="md"
                className="w-full text-center bg-accent-400 text-ink-950 font-bold py-2.5 rounded-xl"
              >
                Get started free
              </ButtonLink>
            </div>
          </div>
        )}
      </header>

      {/* Main Content Body */}
      <main className="flex-1">{children}</main>

      {/* Modern Multi-Column Footer */}
      <footer className="border-t border-paper-200/80 bg-paper py-12 lg:py-16">
        <div className="mx-auto max-w-6xl px-4 lg:px-6">
          <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
            <div className="lg:col-span-2">
              <Brand size="md" />
              <p className="mt-4 max-w-sm text-sm leading-relaxed text-ink-500">
                FinSight is a financial monitoring and decision-support application built for small businesses in the Philippines. Turn daily sales and supplier receipts into actionable profit clarity.
              </p>

              <div className="mt-6 flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50/80 px-3.5 py-1 text-xs font-semibold text-emerald-800 w-fit">
                <Activity className="h-3.5 w-3.5 text-emerald-600 animate-pulse" />
                <span>All Systems Operational</span>
              </div>
            </div>

            <div>
              <h3 className="font-display text-sm font-bold uppercase tracking-wider text-ink-900">
                Product & Help
              </h3>
              <ul className="mt-4 space-y-2.5 text-sm font-medium">
                <li>
                  <a href="/#features" className="text-ink-600 hover:text-brand-700 transition-colors">
                    Features
                  </a>
                </li>
                <li>
                  <Link to="/blogs" className="text-ink-600 hover:text-brand-700 transition-colors">
                    Blogs & Articles
                  </Link>
                </li>
                <li>
                  <Link to="/tutorials" className="text-ink-600 hover:text-brand-700 transition-colors">
                    Video Tutorials
                  </Link>
                </li>
                <li>
                  <Link to="/faqs" className="text-ink-600 hover:text-brand-700 transition-colors">
                    FAQ Center
                  </Link>
                </li>
              </ul>
            </div>

            <div>
              <h3 className="font-display text-sm font-bold uppercase tracking-wider text-ink-900">
                Company & Legal
              </h3>
              <ul className="mt-4 space-y-2.5 text-sm font-medium">
                <li>
                  <Link to="/contact" className="text-ink-600 hover:text-brand-700 transition-colors">
                    Contact Us
                  </Link>
                </li>
                <li>
                  <Link to="/privacy" className="text-ink-600 hover:text-brand-700 transition-colors">
                    Privacy Policy
                  </Link>
                </li>
                <li>
                  <Link to="/terms" className="text-ink-600 hover:text-brand-700 transition-colors">
                    Terms of Service
                  </Link>
                </li>
              </ul>
            </div>
          </div>

          <div className="mt-12 border-t border-paper-200 pt-6 text-center sm:flex sm:items-center sm:justify-between">
            <p className="text-xs text-ink-400">
              © {new Date().getFullYear()} FinSight Inc. A decision support tool — not a substitute for certified accounting advice.
            </p>
            <div className="mt-4 sm:mt-0 text-xs text-ink-400">
              Crafted for Philippine Small Merchants 🇵🇭
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

export function PublicPageHead({ eyebrow, title, lede }: { eyebrow: string; title: string; lede?: string }) {
  return (
    <section className="border-b border-paper-200 bg-paper py-12 text-center lg:py-16">
      <div className="mx-auto max-w-4xl px-4 lg:px-6">
        <p className="text-xs font-bold uppercase tracking-wider text-brand-700">{eyebrow}</p>
        <h1 className="mt-3 font-display text-3xl font-bold text-ink-900 sm:text-4xl">{title}</h1>
        {lede ? <p className="mx-auto mt-4 max-w-2xl text-base text-ink-600">{lede}</p> : null}
      </div>
    </section>
  );
}
