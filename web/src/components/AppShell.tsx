import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { usePersistentState } from "../lib/hooks";
import { BusinessSwitcher } from "./BusinessSwitcher";
import { GlobalSearch } from "./GlobalSearch";
import { NotificationBell } from "./NotificationBell";
import { SetupPrompt } from "./SetupPrompt";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { AccountMenu } from "./AccountMenu";
import { PrefetchLink as Link } from "./PrefetchLink";
import { prefetchPrimaryRoutes } from "../lib/routeLoaders";
import {
  IconBusiness,
  IconCalendar,
  IconChevronDown,
  IconDashboard,
  IconInsights,
  IconProfile,
  IconRecords,
  IconSearch,
  IconSidebar,
} from "./icons";

/**
 * The authenticated shell.
 *
 * ---------------------------------------------------------------------
 * Layout
 * ---------------------------------------------------------------------
 *   >= 1024px  a collapsible sidebar (256px / 72px) beside a content column
 *              that fills essentially all the remaining width.
 *   <  1024px  a compact topbar plus a fixed bottom nav.
 *
 * Two layouts rather than one that shrinks. The mockup collapses its sidebar
 * into a hamburger drawer below 820px; this keeps the bottom nav instead. The
 * top-level destinations are frequently used, so a drawer adds a tap to every
 * navigation, and a top-left hamburger is the least thumb-reachable spot on a
 * tall phone.
 *
 * ---------------------------------------------------------------------
 * Where things live, and why
 * ---------------------------------------------------------------------
 * SIDEBAR — identity and place. The logo, which business you are in, and
 * where you can go. All of it is about the app.
 *
 * TOPBAR — what you are doing right now. Search, add, alerts, appearance,
 * account. All of it is about this session.
 *
 * The page header used to carry the business switcher and the account menu,
 * which meant the same chrome was rebuilt on every screen and page titles
 * competed with global controls for the same row. Splitting them this way is
 * what lets <main> start with the page's own title and nothing else.
 *
 * ---------------------------------------------------------------------
 * One measure
 * ---------------------------------------------------------------------
 * The topbar's inner row and <main> both use `.shell`. That single shared
 * class is the entire mechanism behind every page having identical left and
 * right boundaries — the search field lines up with the page title, which
 * lines up with the table beneath it, because none of them chooses its own
 * margin.
 */

type IconComponent = ComponentType<{ className?: string }>;

interface NavItem {
  to: string;
  label: string;
  Icon: IconComponent;
  /** Prefix used for the active check when it differs from `to`. */
  match?: string;
  /** Renders as a nested disclosure rather than a plain link. */
  children?: { to: string; label: string }[];
  /** `data-tour` anchor for the product tour — a stable selector, not a class. */
  tour?: string;
}

interface NavGroup {
  heading: string;
  items: NavItem[];
}

const INSIGHTS_LINKS = [
  { to: "/insights/expense-behavior", label: "Expense insight" },
  { to: "/insights/spending-impact", label: "Spending impact" },
  { to: "/insights/recovery", label: "Recovery target" },
];

/**
 * Navigation, grouped by what you came to do rather than by feature area.
 *
 * The destinations are exactly the ones that existed before — nothing was
 * added to the app to fill out a group, and nothing was dropped. What changed
 * is that eight flat links now read as four short lists, which is the
 * difference between scanning and reading (Miller's chunking, and Hick's Law
 * on the choice itself).
 */
const NAV_GROUPS: NavGroup[] = [
  {
    heading: "Overview",
    items: [
      { to: "/dashboard", label: "Dashboard", Icon: IconDashboard },
      { to: "/records", label: "Records", Icon: IconRecords, tour: "records" },
    ],
  },
  {
    heading: "Insights",
    items: [
      {
        to: "/insights/expense-behavior",
        label: "Insights",
        Icon: IconInsights,
        match: "/insights",
        children: INSIGHTS_LINKS,
        tour: "insights",
      },
    ],
  },
  {
    heading: "Management",
    items: [{ to: "/business-profiles", label: "Business profile", Icon: IconBusiness }],
  },
  {
    heading: "Account",
    items: [
      { to: "/profile", label: "My profile", Icon: IconProfile },
    ],
  },
];

// Pages reachable without being a sidebar nav destination. Notifications
// lives only behind the topbar bell now (the "one bell, not two places to
// check" decision); Categories lost its tab too but is still linked from
// GlobalSearch, and Account settings now reaches people through the account
// menu, My profile and search rather than a tab of its own. The routes are all
// still real, so each still needs a proper announced title below rather than
// falling back to the generic "FinSight".
const EXTRA_PAGE_TITLES: Record<string, string> = {
  "/notifications": "Notifications",
  "/records/expenses/new": "Add expense",
  "/records/expenses": "Edit expense",
  "/records/sales/new": "Add sale",
  "/records/sales": "Edit sale",
  "/records/receipts/new": "Scan receipt",
  "/records/csv-imports/new": "Import CSV",
  "/records/flagged": "Needs review",
  "/insights/recovery/month-end-review": "Month-end review",
  "/business-profiles/new": "New business",
  "/records/categories": "Categories",
  "/business-profiles/all": "All businesses",
  "/account-settings": "Account settings",
  "/insights/expense-behavior/unusual": "Unusual expenses",
  "/insights/expense-behavior/findings": "Findings to review",
  "/insights/expense-behavior/recurring": "Recurring expenses",
  "/calendar": "Payment calendar",
};

/**
 * A human name for a path, for the route announcement.
 *
 * Derived from the nav config rather than a second hand-written table, so a
 * renamed nav item cannot end up announced under its old name. Longest match
 * wins, so /records/categories resolves to Categories rather than Records.
 */
function pageTitleFor(pathname: string): string {
  // Specific page names first: on a tie (the "Insights" group shares Expense
  // insight's URL) the stable sort below keeps the earlier entry.
  const candidates = [
    ...INSIGHTS_LINKS,
    ...Object.entries(EXTRA_PAGE_TITLES).map(([to, label]) => ({ to, label })),
    ...NAV_GROUPS.flatMap((g) => g.items.flatMap((i) => [i, ...(i.children ?? [])])),
  ];
  const match = candidates
    .filter((i) => pathname === i.to || pathname.startsWith(`${i.to}/`))
    .sort((a, b) => b.to.length - a.to.length)[0];
  return match?.label ?? "FinSight";
}

/** The four bottom-nav destinations on mobile. Mirrors the mobile app's tabs. */
const BOTTOM_NAV: NavItem[] = [
  { to: "/dashboard", label: "Dashboard", Icon: IconDashboard },
  { to: "/records", label: "Records", Icon: IconRecords, tour: "records" },
  { to: "/insights/expense-behavior", label: "Insights", Icon: IconInsights, match: "/insights", tour: "insights" },
  { to: "/business-profiles", label: "Business", Icon: IconBusiness },
];

const isBool = (v: unknown): v is boolean => typeof v === "boolean";

/**
 * The label that appears beside a collapsed sidebar icon.
 *
 * A real element rather than `title`, for two reasons: the native tooltip
 * takes about a second to appear, which is too slow to be a substitute for a
 * label you removed; and it never shows on keyboard focus, so a collapsed
 * sidebar would be entirely unlabelled for anyone tabbing through it.
 * `group-focus-visible` here is what keeps that from happening.
 */
function RailTip({ children }: { children: ReactNode }) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 scale-95 whitespace-nowrap rounded-lg bg-ink-900 px-2.5 py-1.5 text-[12px] font-medium text-paper opacity-0 shadow-md transition duration-150 group-hover:scale-100 group-hover:opacity-100 group-focus-visible:scale-100 group-focus-visible:opacity-100"
    >
      {children}
    </span>
  );
}

/**
 * A single top-level sidebar destination.
 *
 * Module-level, NOT nested inside AppShell. A component declared inside
 * another is a brand-new component type on every render, so React unmounts
 * and remounts its whole subtree each time — which drops keyboard focus. Tab
 * to a nav link, have anything in the shell re-render (opening the bell,
 * switching theme, a notification poll landing), and focus would jump back to
 * the top of the document.
 */
function SidebarLink({
  item,
  collapsed,
  active,
}: {
  item: NavItem;
  collapsed: boolean;
  active: boolean;
}) {
  return (
    <li className="group relative">
      <Link
        to={item.to}
        data-tour={item.tour}
        aria-current={active ? "page" : undefined}
        className={`mb-0.5 flex min-h-tap items-center rounded-xl text-sm font-medium transition ${
          collapsed ? "justify-center px-0" : "gap-3 px-3"
        } ${active ? "bg-sidebar-fg/15 font-semibold text-sidebar-ink" : "text-sidebar-muted hover:bg-sidebar-fg/10 hover:text-sidebar-ink"}`}
      >
        <item.Icon className="h-[18px] w-[18px] shrink-0 opacity-90" />
        {collapsed ? <span className="sr-only">{item.label}</span> : item.label}
      </Link>
      {collapsed ? <RailTip>{item.label}</RailTip> : null}
    </li>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { selected } = useBusinessProfiles();
  const location = useLocation();

  const [collapsed, setCollapsed] = usePersistentState("finsight.sidebarCollapsed", false, isBool);
  const [insightsOpen, setInsightsOpen] = useState(location.pathname.startsWith("/insights"));
  const [mobileSearch, setMobileSearch] = useState(false);
  // The topbar floats on the canvas at rest; once content scrolls under it,
  // a blur keeps the breadcrumb legible over cards.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);


  // Once the first page has had its turn, warm the other tabs' code so
  // switching to them shows the page (or its skeleton) without a code wait.
  useEffect(() => {
    const warm = () => void prefetchPrimaryRoutes();
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(warm, { timeout: 4000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(warm, 1500);
    return () => window.clearTimeout(id);
  }, []);

  // Close transient chrome on navigation, or a menu lingers over the new page.
  useEffect(() => {
    setMobileSearch(false);
    if (location.pathname.startsWith("/insights")) setInsightsOpen(true);
  }, [location.pathname]);

  /**
   * Route changes, for people not using a mouse.
   *
   * <main> is keyed on pathname, so React tears down the old page and builds
   * the new one — but focus stays wherever it was, which after clicking a
   * sidebar link means it is still on the sidebar, and after a programmatic
   * navigation means it is on <body> and the next Tab restarts from the top of
   * the document. Moving focus to <main> puts the user at the start of the new
   * page, which is what the visual change already did for everyone else.
   *
   * The announcement is separate: focusing a container does not reliably make a
   * screen reader say where you now are, so the page name goes through a polite
   * live region. `isFirstRoute` suppresses it on initial load, where the page
   * title has just been read anyway and an announcement would be noise.
   */
  const mainRef = useRef<HTMLElement>(null);
  const [routeAnnouncement, setRouteAnnouncement] = useState("");
  const isFirstRoute = useRef(true);

  // Tabs, history and screen-reader page announcements need a name per page.
  useEffect(() => {
    const name = pageTitleFor(location.pathname);
    document.title = name === "FinSight" ? "FinSight" : `${name} · FinSight`;
  }, [location.pathname]);

  useEffect(() => {
    if (isFirstRoute.current) {
      isFirstRoute.current = false;
      return;
    }
    mainRef.current?.focus();
    setRouteAnnouncement(`${pageTitleFor(location.pathname)} page loaded`);
  }, [location.pathname]);

  // A collapsed rail has no room for the Insights disclosure, so it is forced
  // shut — otherwise its children would render as unlabelled stubs.
  const railCollapsed = collapsed;
  const showInsightsChildren = insightsOpen && !railCollapsed;

  const isActive = (to: string, match?: string) => location.pathname.startsWith(match ?? to);

  return (
    <div
      className="app-canvas min-h-dvh bg-paper-50 transition-[grid-template-columns] duration-250 ease-shell lg:grid"
      style={{
        // Inline rather than a class pair, because this is the property being
        // transitioned and Tailwind would have to emit two arbitrary values
        // that the transition then interpolates between anyway.
        gridTemplateColumns: collapsed ? "4.5rem 1fr" : "16rem 1fr",
      }}
    >
      {/*
        Skip link — the first focusable thing in the document.

        Without it a keyboard user tabs the entire sidebar on every single page:
        seven nav links, the business switcher, the collapse control and the
        insights disclosure, before reaching any page content. It is visually
        hidden until focused, which is the point — it costs sighted users
        nothing and saves everyone else ten keystrokes per navigation.
      */}
      <a
        href="#main-content"
        className="sr-only rounded-lg bg-brand-700 px-4 py-2.5 text-sm font-semibold text-white focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[300] focus:inline-flex focus:min-h-tap focus:items-center"
      >
        Skip to main content
      </a>

      {/*
        Route announcement. <main> remounts on navigation (see the key below),
        but a remount is silent: a screen-reader user got no signal that the
        page had changed. This polite live region names the new page.
      */}
      <span aria-live="polite" className="sr-only">
        {routeAnnouncement}
      </span>

      {/* ============================ SIDEBAR ============================ */}
      <aside
        // z-40: sticky makes the rail its own stacking layer, and without a
        // z-index the page's animated cards paint over the Insights flyout.
        className={`surface-sidebar sticky top-0 z-40 hidden h-screen flex-col lg:flex ${
          railCollapsed ? "px-2 py-3.5" : "p-3.5"
        }`}
      >
        {/* ---- logo + collapse ---- */}
        <div className={`mb-3 flex items-center ${railCollapsed ? "justify-center" : "gap-1"}`}>
          {railCollapsed ? (
            /*
              COLLAPSED, THE LOGO IS THE CONTROL.
              -------------------------------------------------------------
              There used to be a separate full-width "Expand sidebar" row
              sitting above the badge. At 72px that row was the widest thing
              in the rail and read as an unlabelled bar floating over the
              brand mark — two controls stacked where the owner only ever
              wanted one, and the one they instinctively clicked was the logo.

              So the badge itself expands, and the affordance is taught on
              hover: the `F` cross-fades to the sidebar glyph over 150ms with
              the same RailTip every other collapsed control uses. Two stacked
              absolutely-positioned layers rather than swapping the child, so
              the box never changes size and the rail cannot shift under the
              pointer mid-hover.

              A BUTTON, NOT A LINK. It expands a region; announcing that as
              navigation would be a lie, and /dashboard is one row down in the
              nav list anyway.

              Reduced motion is handled globally (index.css collapses
              durations to 0.01ms), so the cross-fade degrades to an instant
              swap without a second code path here.
            */
            <div className="group relative">
              <button
                type="button"
                onClick={() => setCollapsed(false)}
                aria-label="Open sidebar"
                aria-expanded={false}
                className="tap h-12 w-12 min-h-0 min-w-0 rounded-xl transition hover:bg-sidebar-fg/10"
              >
                <span aria-hidden className="relative flex h-11 w-11 items-center justify-center">
                  <span className="absolute inset-0 flex items-center justify-center rounded-xl opacity-100 transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0">
                    <img src="/newmascotlogo.png" alt="" className="h-11 w-11 rounded-xl object-contain" />
                  </span>
                  <span className="absolute inset-0 flex items-center justify-center rounded-xl bg-sidebar-fg/15 text-sidebar-muted opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                    <IconSidebar className="h-5 w-5" />
                  </span>
                </span>
              </button>
              <RailTip>Open sidebar</RailTip>
            </div>
          ) : (
            <Link
              to="/dashboard"
              className="flex min-h-tap flex-1 items-center gap-2.5 rounded-xl px-2 transition hover:bg-sidebar-fg/10"
              aria-label="FinSight home"
            >
              <img
                src="/newmascotlogo.png"
                alt=""
                aria-hidden
                className="h-11 w-11 shrink-0 rounded-xl object-contain"
              />
              <span className="font-display text-xl font-extrabold tracking-[-0.02em] text-sidebar-ink">
                Fin<span className="text-sidebar-accent">Sight</span>
              </span>
            </Link>
          )}

          {!railCollapsed ? (
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              aria-label="Collapse sidebar"
              aria-expanded
              className="tap h-11 w-11 min-h-0 min-w-0 rounded-lg text-sidebar-muted transition hover:bg-sidebar-fg/10 hover:text-sidebar-ink"
            >
              <IconSidebar className="h-[18px] w-[18px]" />
            </button>
          ) : null}
        </div>

        <BusinessSwitcher collapsed={railCollapsed} />

        {/* ---- grouped navigation ----

            Rendered whether or not a business is selected. It used to be
            hidden without one, which left an owner who chose "Skip for now" in
            a shell with no doors at all — every read-only page is open to them
            now, and a navigation they cannot see is the same dead end reached
            by a different route. Safe because every destination here only
            READS; the write paths (Add, Scan, Import) stay on their own pages. */}
        <nav
          aria-label="Main"
          // Collapsed, this must NOT be a scroll container. `overflow-y:auto`
          // computes `overflow-x` to `auto` as well, which clips the rail
          // tooltips — the only labels a collapsed sidebar has — at the 72px
          // edge. The collapsed rail is a fixed, short list (seven icons and
          // three rules, well under 400px), so there is nothing to scroll
          // anyway. Expanded, the labels are inline and scrolling is free.
          className={`min-h-0 flex-1 ${railCollapsed ? "overflow-visible" : "scroll-slim overflow-y-auto"}`}
        >
          {NAV_GROUPS.map((group, groupIndex) => (
            <div key={group.heading} className="mb-1.5">
              {/* Collapsed, the headings become a hairline: the grouping is
                  still legible as rhythm, without four words of vertical
                  space that no longer have room to be read. The first group
                  gets no rule — there is nothing above it to separate from,
                  and one there just reads as a stray line under the business
                  switcher. */}
              {railCollapsed ? (
                groupIndex > 0 ? <hr className="mx-2 my-2 border-sidebar-fg/10" aria-hidden /> : null
              ) : (
                <div className="px-3 pb-1 pt-2.5 text-xs font-bold uppercase tracking-[0.13em] text-sidebar-accent">
                  {group.heading}
                </div>
              )}

              <ul>
                {group.items.map((item) =>
                  item.children ? (
                    <li key={item.to} className="group relative">
                      {railCollapsed ? (
                        <>
                          <Link
                            to={item.to}
                            data-tour={item.tour}
                            aria-current={isActive(item.to, item.match) ? "page" : undefined}
                            className={`mb-0.5 flex min-h-tap items-center justify-center rounded-xl transition ${
                              isActive(item.to, item.match)
                                ? "bg-sidebar-fg/15 text-sidebar-ink"
                                : "text-sidebar-muted hover:bg-sidebar-fg/10 hover:text-sidebar-ink"
                            }`}
                          >
                            <item.Icon className="h-[18px] w-[18px] shrink-0 opacity-90" />
                            <span className="sr-only">{item.label}</span>
                          </Link>
                          {/* The rail has no room for the sub-pages, so they fly out
                              beside the icon on hover or keyboard focus. Padding, not
                              margin, bridges the gap so the pointer can cross to it. */}
                          <div className="invisible absolute left-full top-0 z-50 pl-2 opacity-0 transition duration-150 group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
                            <ul
                              aria-label={item.label}
                              className="min-w-44 rounded-xl border border-paper-200/70 bg-paper/80 p-1.5 text-ink-900 shadow-md backdrop-blur-md"
                            >
                              <li className="px-2.5 pb-1 pt-0.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-500" aria-hidden>
                                {item.label}
                              </li>
                              {item.children.map((child) => {
                                const active = location.pathname === child.to;
                                return (
                                  <li key={child.to}>
                                    <Link
                                      to={child.to}
                                      aria-current={active ? "page" : undefined}
                                      className={`flex min-h-tap items-center whitespace-nowrap rounded-lg px-2.5 text-[13px] transition ${
                                        active ? "bg-tint-brand font-semibold text-tone-brand" : "hover:bg-paper-100"
                                      }`}
                                    >
                                      {child.label}
                                    </Link>
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            data-tour={item.tour}
                            onClick={() => setInsightsOpen((v) => !v)}
                            aria-expanded={insightsOpen}
                            aria-controls="sidebar-insights"
                            className={`mb-0.5 flex min-h-tap w-full items-center gap-3 rounded-xl px-3 text-sm font-medium transition ${
                              isActive(item.to, item.match)
                                ? "bg-sidebar-fg/15 font-semibold text-sidebar-ink"
                                : "text-sidebar-muted hover:bg-sidebar-fg/10 hover:text-sidebar-ink"
                            }`}
                          >
                            <item.Icon className="h-[18px] w-[18px] shrink-0 opacity-90" />
                            {item.label}
                            <IconChevronDown
                              className={`ml-auto h-4 w-4 shrink-0 transition-transform duration-200 ${
                                insightsOpen ? "rotate-180" : ""
                              }`}
                            />
                          </button>
                          {showInsightsChildren ? (
                            <ul
                              id="sidebar-insights"
                              className="mb-1.5 ml-4 animate-slide-up border-l border-sidebar-fg/15 pl-3"
                            >
                              {item.children.map((child) => {
                                const active = location.pathname === child.to;
                                return (
                                  <li key={child.to}>
                                    <Link
                                      to={child.to}
                                      aria-current={active ? "page" : undefined}
                                      className={`flex min-h-tap items-center rounded-lg px-3 text-[13.5px] transition ${
                                        active
                                          ? "bg-sidebar-fg/15 font-semibold text-sidebar-ink"
                                          : "text-sidebar-muted hover:bg-sidebar-fg/10 hover:text-sidebar-ink"
                                      }`}
                                    >
                                      {child.label}
                                    </Link>
                                  </li>
                                );
                              })}
                            </ul>
                          ) : null}
                        </>
                      )}
                    </li>
                  ) : (
                    <SidebarLink
                      key={item.to}
                      item={item}
                      collapsed={railCollapsed}
                      active={isActive(item.to, item.match)}
                    />
                  ),
                )}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      {/* ============================= MAIN ============================== */}
      <div className="flex min-w-0 flex-col">
        {/* ---------------------------- TOPBAR ---------------------------- */}
        <header
          className={`sticky top-0 z-30 transition-[background-color,backdrop-filter] duration-200 short:static ${
            scrolled ? "bg-paper-50/60 backdrop-blur-md" : "bg-transparent"
          }`}
        >
          {/* Wraps rather than overflows. At a 200px CSS viewport (400px at
              200% browser zoom) the mark, search and action cluster cannot
              share one line, and a fixed height forced the page to scroll
              sideways instead. `min-h` + `py-1.5` keeps the unwrapped row at
              exactly the old 56px. */}
          <div className="shell flex min-h-[var(--topbar-h)] flex-wrap items-center gap-2 py-1.5">
            {/* Mark — the sidebar carries it from lg up, so this is mobile only. */}
            <Link
              to="/dashboard"
              className="flex min-h-tap min-w-tap shrink-0 items-center justify-center lg:hidden"
              aria-label="FinSight home"
            >
              <img src="/newmascotlogo.png" alt="" aria-hidden className="h-10 w-10 rounded-lg object-contain" />
            </Link>

            {/* ---- breadcrumb ----
                Business, then page. Takes the mark's place from lg up, where
                the sidebar carries the logo; `flex-1` makes it the spacer that
                pushes search and actions to the right edge. */}
            <nav aria-label="Breadcrumb" className="hidden min-w-0 flex-1 lg:block">
              <ol className="flex min-w-0 items-center gap-1.5 text-[13px]">
                {selected ? (
                  <>
                    <li className="min-w-0">
                      <Link
                        to="/business-profiles"
                        className="block max-w-[14rem] truncate rounded-md text-ink-500 transition hover:text-ink-900"
                      >
                        {selected.name}
                      </Link>
                    </li>
                    <li aria-hidden className="shrink-0 text-ink-400">
                      <IconChevronDown className="h-3.5 w-3.5 -rotate-90" />
                    </li>
                  </>
                ) : null}
                <li aria-current="page" className="min-w-0 truncate font-medium text-ink-900">
                  {pageTitleFor(location.pathname)}
                </li>
              </ol>
            </nav>

            {/* ---- global search ----
                The fastest route to any record in the app. Sits with the
                actions on the right at a fixed width so the breadcrumb, not
                the field, absorbs spare room on a wide monitor. */}
            {selected ? (
              <GlobalSearch className="hidden min-w-0 md:ml-auto md:block md:w-72 lg:w-80 xl:w-[22rem]" />
            ) : null}

            {/* `shrink-0` stays: the search field is the flex item that should
                give way first. `max-w-full` + `flex-wrap` only bind once the
                row itself has wrapped, so nothing moves above ~360px. */}
            <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-1.5 sm:gap-2">
              {/* Search collapses to an icon below `md`, where a full field
                  would crowd out everything else in the row. */}
              {selected ? (
                <button
                  type="button"
                  onClick={() => setMobileSearch((v) => !v)}
                  aria-expanded={mobileSearch}
                  aria-label="Search"
                  className="tap h-11 w-11 min-h-0 min-w-0 rounded-xl border border-paper-200/70 bg-paper/70 text-ink-600 shadow-sm backdrop-blur transition hover:bg-paper hover:text-ink-900 md:hidden"
                >
                  <IconSearch className="h-[18px] w-[18px]" />
                </button>
              ) : null}

              {/* Beside the bell: both answer "what needs me soon?" — the
                  bell with what already happened, the calendar with what is
                  coming. A link, not a popover: it opens a full page. */}
              {selected ? (
                <Link
                  to="/calendar"
                  aria-label="Payment calendar"
                  aria-current={location.pathname === "/calendar" ? "page" : undefined}
                  className={`tap flex h-11 w-11 items-center justify-center rounded-xl border bg-paper/70 shadow-sm backdrop-blur transition hover:bg-paper hover:text-ink-900 ${
                    location.pathname === "/calendar"
                      ? "border-edge-brand text-tone-brand"
                      : "border-paper-200/70 text-ink-600"
                  }`}
                >
                  <IconCalendar className="h-[18px] w-[18px]" />
                </Link>
              ) : null}
              {selected ? <NotificationBell /> : null}
              <ThemeSwitcher compact />
              <AccountMenu />
            </div>
          </div>

          {/* Expanded mobile search — a second row rather than a modal, so the
              page stays visible behind the results. */}
          {mobileSearch && selected ? (
            <div className="shell animate-slide-up pb-3 md:hidden">
              <GlobalSearch />
            </div>
          ) : null}
        </header>

        {/* `pb-24` keeps the bottom nav from covering the last element on
            mobile. `animate-fade-up` keyed on pathname gives each route a
            short entrance rather than a hard swap.

            `tabIndex={-1}` makes this focusable by script but not by Tab, which
            is what lets both the skip link and the route change move focus here
            without adding a stop to the tab order. */}
        <main
          key={location.pathname}
          id="main-content"
          ref={mainRef}
          tabIndex={-1}
          // Focused by script on every route change (above), never by Tab.
          // The global :focus-visible ring is a box-shadow, so outline-none
          // alone left a green frame around the page whenever the browser
          // treated that focus as keyboard focus, e.g. in a freshly opened tab.
          className="shell flex-1 animate-fade-up pb-24 pt-6 outline-none focus-visible:ring-0 focus-visible:ring-offset-0 lg:pb-12"
        >
          {/* Above the routed page on every route, not once per page — see
              SetupPrompt for why it lives in the shell. */}
          <SetupPrompt />
          {children}
        </main>
      </div>

      {/* =========================== BOTTOM NAV ===========================
          Ungated for the same reason as the sidebar: its four destinations all
          only read, and hiding them stranded an owner who skipped setup on
          whichever page they happened to land on, with no way off it. */}
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-paper-200 bg-paper/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      >
        <ul className="mx-auto flex max-w-md">
          {BOTTOM_NAV.map((item) => {
            const active = isActive(item.to, item.match);
            return (
              <li key={item.to} className="flex-1">
                <Link
                  to={item.to}
                  data-tour={item.tour}
                  aria-current={active ? "page" : undefined}
                  className={`flex min-h-tap flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] font-medium transition-colors short:flex-row short:gap-1.5 short:py-0 short:text-xs ${
                    active ? "text-brand-700" : "text-ink-500"
                  }`}
                >
                  <item.Icon className="h-[18px] w-[18px]" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

    </div>
  );
}

/**
 * Sub-navigation across the three Insights screens.
 *
 * The sidebar submenu owns this navigation on wider screens. This in-page row
 * is the equivalent path on mobile, where the bottom nav has a single Insights
 * destination. It scrolls horizontally inside its own container rather than
 * wrapping, keeping the page free of horizontal overflow at 320px.
 */
export function InsightsTabs() {
  const location = useLocation();
  return (
    <div className="scroll-slim -mx-4 mb-5 overflow-x-auto px-4 sm:-mx-6 sm:px-6 md:hidden">
      <div className="flex w-max gap-1 rounded-xl border border-paper-200 bg-paper-100 p-1">
        {INSIGHTS_LINKS.map((link) => {
          const active = location.pathname === link.to;
          return (
            <Link
              key={link.to}
              to={link.to}
              aria-current={active ? "page" : undefined}
              className={`flex min-h-tap items-center whitespace-nowrap rounded-lg px-4 text-[13.5px] font-semibold transition ${
                active ? "bg-paper text-tone-brand shadow-sm" : "text-ink-500 hover:text-tone-brand"
              }`}
            >
              {link.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
