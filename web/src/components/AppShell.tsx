import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useTourOptional } from "../context/TourContext";
import { usePersistentState, useDismiss, useFocusTrap, useMenuKeys } from "../lib/hooks";
import { BusinessSwitcher } from "./BusinessSwitcher";
import { GlobalSearch } from "./GlobalSearch";
import { NotificationBell } from "./NotificationBell";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { AccountMenu, initials } from "./AccountMenu";
import {
  IconBusiness,
  IconCamera,
  IconChevronDown,
  IconDashboard,
  IconExpense,
  IconInsights,
  IconPlus,
  IconProfile,
  IconRecords,
  IconSales,
  IconSearch,
  IconSidebar,
  IconUpload,
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
    items: [{ to: "/profile", label: "My profile", Icon: IconProfile }],
  },
];

// Pages reachable without being a sidebar nav destination. Notifications
// lives only behind the topbar bell now (the "one bell, not two places to
// check" decision); Categories lost its tab too but is still linked from
// GlobalSearch. Both routes are still real, so both still need a proper
// announced title below rather than falling back to the generic "FinSight".
const EXTRA_PAGE_TITLES: Record<string, string> = {
  "/notifications": "Notifications",
  "/records/categories": "Categories",
  "/business-profiles/all": "All businesses",
};

/**
 * A human name for a path, for the route announcement.
 *
 * Derived from the nav config rather than a second hand-written table, so a
 * renamed nav item cannot end up announced under its old name. Longest match
 * wins, so /records/categories resolves to Categories rather than Records.
 */
function pageTitleFor(pathname: string): string {
  const candidates = [
    ...NAV_GROUPS.flatMap((g) => g.items.flatMap((i) => [i, ...(i.children ?? [])])),
    ...INSIGHTS_LINKS,
    ...Object.entries(EXTRA_PAGE_TITLES).map(([to, label]) => ({ to, label })),
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

const QUICK_ADD: { to: string; Icon: IconComponent; tone: string; title: string; sub: string; tour?: string }[] = [
  { to: "/records/expenses/new", Icon: IconExpense, tone: "bg-tint-accent text-tone-accent", title: "Add expense", sub: "Money spent by the business" },
  { to: "/records/sales/new", Icon: IconSales, tone: "bg-tint-brand text-tone-brand", title: "Add sales reference", sub: "A recorded sales amount" },
  { to: "/records/receipts/new", Icon: IconCamera, tone: "bg-tint-info text-tone-info", title: "Scan receipt", sub: "Extract details from a photo", tour: "scan-receipt" },
  { to: "/records/csv-imports/new", Icon: IconUpload, tone: "bg-tint-brand text-tone-brand", title: "Import CSV", sub: "Upload existing records", tour: "import-csv" },
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
  const { profile: user } = useAuth();
  const { selected } = useBusinessProfiles();
  const location = useLocation();

  const [collapsed, setCollapsed] = usePersistentState("finsight.sidebarCollapsed", false, isBool);
  const [insightsOpen, setInsightsOpen] = useState(location.pathname.startsWith("/insights"));
  const [addOpen, setAddOpen] = useState(false);
  const [mobileSearch, setMobileSearch] = useState(false);

  /*
   * The product tour's two Quick-add steps highlight items INSIDE this menu,
   * so while one of them is active the menu is held open by the tour rather
   * than by the user. Held open this way it must not behave like a menu the
   * user opened: useDismiss would close it the moment they click the tour's
   * own Next button (an "outside" click), and useFocusTrap would fight the
   * tour tooltip's trap for focus — so both stay wired to `addOpen` only.
   * When the step moves on, `tourHoldsAddMenu` goes false and the menu
   * disappears again, restoring exactly the state the user had.
   */
  const tour = useTourOptional();
  const tourHoldsAddMenu =
    tour?.activeStepId === "receipt-scanner" || tour?.activeStepId === "csv-import";
  const addMenuVisible = addOpen || tourHoldsAddMenu;

  const { ref: addRef, triggerRef: addTriggerRef } = useDismiss(addOpen, () => setAddOpen(false));
  const onMenuKeys = useMenuKeys();
  const addTrapRef = useFocusTrap<HTMLDivElement>(addOpen && !tourHoldsAddMenu);

  // Close transient chrome on navigation, or a menu lingers over the new page.
  useEffect(() => {
    setAddOpen(false);
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
      className="min-h-screen bg-paper-50 transition-[grid-template-columns] duration-250 ease-shell lg:grid"
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
        className={`surface-sidebar sticky top-0 hidden h-screen flex-col lg:flex ${
          railCollapsed ? "px-2 py-3.5" : "p-3.5"
        }`}
      >
        {/* Collapsed, the expand control gets its own full-width row above the
            logo — sharing one with the logo at 72px would make both too
            small to hit, and it reads as "the rail's own control", not
            something attached underneath the brand mark. */}
        {railCollapsed ? (
          <div className="group relative mb-3">
            <button
              type="button"
              onClick={() => setCollapsed(false)}
              aria-label="Expand sidebar"
              aria-expanded={false}
              className="tap h-10 w-full min-h-0 min-w-0 rounded-xl text-sidebar-muted transition hover:bg-sidebar-fg/10 hover:text-sidebar-ink"
            >
              <IconSidebar className="h-[18px] w-[18px]" />
            </button>
            <RailTip>Expand sidebar</RailTip>
          </div>
        ) : null}

        {/* ---- logo + collapse ---- */}
        <div className={`mb-3 flex items-center ${railCollapsed ? "justify-center" : "gap-1"}`}>
          <Link
            to="/dashboard"
            className={`flex min-h-tap items-center rounded-xl transition hover:bg-sidebar-fg/10 ${
              railCollapsed ? "justify-center px-1.5" : "flex-1 gap-2.5 px-2"
            }`}
            aria-label="FinSight home"
          >
            {/* MASCOT SEAM — the owl badge mark replaces this monogram, 36px. */}
            <span
              aria-hidden
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-sidebar-fg/15 font-display text-base font-extrabold text-sidebar-ink"
            >
              F
            </span>
            {!railCollapsed ? (
              <span className="font-display text-xl font-extrabold tracking-[-0.02em] text-sidebar-ink">
                Fin<span className="text-sidebar-accent">Sight</span>
              </span>
            ) : null}
          </Link>

          {!railCollapsed ? (
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              aria-label="Collapse sidebar"
              aria-expanded
              className="tap h-9 w-9 min-h-0 min-w-0 rounded-lg text-sidebar-muted transition hover:bg-sidebar-fg/10 hover:text-sidebar-ink"
            >
              <IconSidebar className="h-[18px] w-[18px]" />
            </button>
          ) : null}
        </div>

        <BusinessSwitcher collapsed={railCollapsed} />

        {/* ---- grouped navigation ---- */}
        {selected ? (
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
                  <div className="px-3 pb-1 pt-2.5 text-[10.5px] font-bold uppercase tracking-[0.13em] text-sidebar-accent">
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
                            <RailTip>{item.label}</RailTip>
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
        ) : (
          <div className="flex-1" />
        )}

        {/* ---- account footer ---- */}
        <div className="mt-auto border-t border-sidebar-fg/10 pt-3">
          {railCollapsed ? (
            <div className="group relative">
              <Link
                to="/profile"
                className="tap h-10 w-full min-h-0 min-w-0 rounded-xl transition hover:bg-sidebar-fg/10"
                aria-label="My profile"
              >
                <span
                  aria-hidden
                  className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-[12px] font-bold text-white"
                >
                  {initials(user?.firstName, user?.lastName)}
                </span>
              </Link>
              <RailTip>
                {[user?.firstName, user?.lastName].filter(Boolean).join(" ") || "My profile"}
              </RailTip>
            </div>
          ) : (
            <Link
              to="/profile"
              className="flex min-h-tap items-center gap-2.5 rounded-xl px-2.5 transition hover:bg-sidebar-fg/10"
            >
              <span
                aria-hidden
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-600 text-sm font-bold text-white"
              >
                {initials(user?.firstName, user?.lastName)}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold text-sidebar-ink">
                  {[user?.firstName, user?.lastName].filter(Boolean).join(" ") || "Account"}
                </span>
                <span className="block truncate text-[11.5px] text-sidebar-accent">{user?.email}</span>
              </span>
            </Link>
          )}
        </div>
      </aside>

      {/* ============================= MAIN ============================== */}
      <div className="flex min-w-0 flex-col">
        {/* ---------------------------- TOPBAR ---------------------------- */}
        <header className="sticky top-0 z-30 border-b border-paper-200 bg-paper/85 backdrop-blur">
          <div className="shell flex h-[var(--topbar-h)] items-center gap-2">
            {/* Mark — the sidebar carries it from lg up, so this is mobile only. */}
            <Link
              to="/dashboard"
              className="flex shrink-0 items-center lg:hidden"
              aria-label="FinSight home"
            >
              <span
                aria-hidden
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-700 font-display text-sm font-bold text-white"
              >
                F
              </span>
            </Link>

            {/* ---- global search ----
                Given the room it deserves: it is the fastest route to any
                record in the app, and a search field that looks like an
                afterthought gets used like one. Capped so it doesn't stretch
                to absurd widths on a large monitor. */}
            {selected ? (
              <GlobalSearch className="hidden min-w-0 flex-1 md:block md:max-w-lg lg:max-w-xl" />
            ) : null}

            <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1">
              {/* Search collapses to an icon below `md`, where a full field
                  would crowd out everything else in the row. */}
              {selected ? (
                <button
                  type="button"
                  onClick={() => setMobileSearch((v) => !v)}
                  aria-expanded={mobileSearch}
                  aria-label="Search"
                  className="tap h-10 w-10 min-h-0 min-w-0 rounded-xl text-ink-600 transition hover:bg-paper-100 hover:text-ink-900 md:hidden"
                >
                  <IconSearch className="h-[18px] w-[18px]" />
                </button>
              ) : null}

              {/* ---- quick add ---- */}
              {selected ? (
                <div ref={addRef} className="relative">
                  <button
                    ref={addTriggerRef}
                    type="button"
                    data-tour="quick-add"
                    onClick={() => setAddOpen((v) => !v)}
                    aria-expanded={addMenuVisible}
                    aria-haspopup="menu"
                    className="tap gap-1.5 rounded-xl bg-brand-700 px-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-800 sm:px-3"
                  >
                    <IconPlus className="h-4 w-4 shrink-0" />
                    <span className="hidden sm:inline">Quick add</span>
                    <span className="sr-only sm:hidden">Quick add</span>
                  </button>
                  {addMenuVisible ? (
                    // useDismiss closes this on Escape and outside click, and
                    // useMenuKeys drives the arrow keys — but neither stopped
                    // Tab from leaving the menu while it stayed open over the
                    // page. useFocusTrap also puts focus on the first item when
                    // it opens, which is what a menu is expected to do.
                    <div
                      ref={addTrapRef}
                      role="menu"
                      aria-label="Add a record"
                      onKeyDown={onMenuKeys}
                      className="absolute right-0 top-full z-50 mt-2 w-[17rem] max-w-[calc(100vw-1.5rem)] animate-pop-down rounded-2xl border border-paper-200 bg-paper p-2 shadow-lg"
                    >
                      <div className="px-2.5 pb-1.5 pt-2 text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink-400">
                        Add a record
                      </div>
                      {QUICK_ADD.map((entry) => (
                        <Link
                          key={entry.to}
                          to={entry.to}
                          data-tour={entry.tour}
                          role="menuitem"
                          className="flex min-h-tap items-center gap-2.5 rounded-xl px-2.5 transition hover:bg-paper-100"
                        >
                          <span
                            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${entry.tone}`}
                          >
                            <entry.Icon className="h-4 w-4" />
                          </span>
                          <span className="min-w-0">
                            <span className="block text-[13.5px] font-semibold text-ink-900">
                              {entry.title}
                            </span>
                            <span className="block truncate text-[11.5px] text-ink-500">{entry.sub}</span>
                          </span>
                        </Link>
                      ))}
                    </div>
                  ) : null}
                </div>
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
          className="shell flex-1 animate-fade-up pb-24 pt-6 outline-none lg:pb-12"
        >
          {children}
        </main>
      </div>

      {/* =========================== BOTTOM NAV =========================== */}
      {selected ? (
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
                    className={`flex min-h-tap flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] font-medium transition-colors ${
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
      ) : null}
    </div>
  );
}

/**
 * Sub-navigation across the three Insights screens.
 *
 * Redundant with the sidebar submenu on desktop, deliberately — the mockup
 * shows both, and the in-page row is the only path on mobile, where the
 * bottom nav has a single Insights destination. It scrolls horizontally
 * inside its own container rather than wrapping, keeping the page free of
 * horizontal overflow at 320px.
 */
export function InsightsTabs() {
  const location = useLocation();
  return (
    <div className="scroll-slim -mx-4 mb-5 overflow-x-auto px-4 sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0">
      <div className="flex w-max gap-1 rounded-xl border border-paper-200 bg-paper-100 p-1">
        {INSIGHTS_LINKS.map((link) => {
          const active = location.pathname === link.to;
          return (
            <Link
              key={link.to}
              to={link.to}
              aria-current={active ? "page" : undefined}
              className={`flex min-h-tap items-center whitespace-nowrap rounded-lg px-4 text-[13.5px] font-semibold transition ${
                active ? "bg-paper text-brand-800 shadow-sm" : "text-ink-500 hover:text-brand-800"
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
