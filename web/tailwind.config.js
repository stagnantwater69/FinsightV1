/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // FinSight brand palette — teal-based. Use `brand-*` in UI, not
        // Tailwind's default indigo/orange.
        brand: {
          50: "#effcf9",
          100: "#c8f7ec",
          200: "#92eeda",
          300: "#5adcc4",
          400: "#2ec2ac",
          500: "#149e8d",
          600: "#0d7f72",
          700: "#0e655c",
          800: "#0f504b",
          900: "#0f423f",
          950: "#052624",
        },

        // ============================================================
        // accent — warm amber. DELIBERATELY RARE.
        // ============================================================
        // Allowed in exactly two places:
        //   1. The Recovery Meter (the product's signature component)
        //   2. Primary calls to action (landing CTAs, Save/Confirm)
        //
        // Nowhere else. Its whole job is to mean "this is the thing that
        // matters"; if it leaks into general chrome it stops meaning anything.
        // It is intentionally NOT one of the status colours — amber-as-warning
        // lives in STATUS_TEXT_COLORS and is a separate idea.
        //
        // Steps 600+ are the ink-safe ones (>= 4.5:1 on paper); 400-500 are
        // fills. See lib/chartPalette.ts for the measured contrast numbers.
        accent: {
          50: "#fff9ed",
          100: "#fdedcc",
          200: "#fbd894",
          300: "#f8bd55",
          400: "#f5a524",
          500: "#e08c0b",
          600: "#b96c06",
          700: "#94520b",
          800: "#7a4210",
          900: "#683810",
          950: "#3c1c04",
        },

        // ============================================================
        // ink / paper — the reading surface. THEME-DRIVEN.
        // ============================================================
        // These name intent ("ink-500 is secondary text", "paper is a card")
        // instead of leaving `slate-500` to mean whatever the nearest
        // component happened to assume.
        //
        // Their VALUES live in CSS custom properties (see index.css), not
        // here, because FinSight ships three themes — Classic, Light and
        // Dark. Resolving them at paint time rather than at build time is what
        // lets `bg-paper` and `text-ink-900` flip with the theme without a
        // single `dark:` variant at any call site. Swap the variables on
        // <html data-theme>, and every surface and every piece of text in the
        // app follows.
        //
        // Classic keeps the original very slightly teal-cooled neutral, so
        // the theme that existed before this system still looks identical.
        ink: {
          50: "rgb(var(--ink-50) / <alpha-value>)",
          100: "rgb(var(--ink-100) / <alpha-value>)",
          200: "rgb(var(--ink-200) / <alpha-value>)",
          300: "rgb(var(--ink-300) / <alpha-value>)",
          400: "rgb(var(--ink-400) / <alpha-value>)", // muted / placeholder
          500: "rgb(var(--ink-500) / <alpha-value>)", // secondary text
          600: "rgb(var(--ink-600) / <alpha-value>)",
          700: "rgb(var(--ink-700) / <alpha-value>)", // body text
          800: "rgb(var(--ink-800) / <alpha-value>)",
          900: "rgb(var(--ink-900) / <alpha-value>)", // headings
          950: "rgb(var(--ink-950) / <alpha-value>)",
        },
        paper: {
          DEFAULT: "rgb(var(--paper) / <alpha-value>)", // cards, panels
          50: "rgb(var(--paper-50) / <alpha-value>)", // page background
          100: "rgb(var(--paper-100) / <alpha-value>)", // subtle inset / hover
          200: "rgb(var(--paper-200) / <alpha-value>)", // borders on paper
        },

        // ============================================================
        // tint / tone / edge — themed status surfaces
        // ============================================================
        // A status chip is three colours that have to stay in step: a wash to
        // sit on, a text colour with enough contrast on that wash, and a
        // hairline. Written literally (`bg-rose-50 text-rose-800
        // ring-rose-200`) they are correct on a white page and unreadable on
        // a dark one — rose-50 becomes a glaring block, rose-800 vanishes
        // into it.
        //
        // So each triple is one themed token instead:
        //   tint-*  the wash            (background)
        //   tone-*  the text on it      (foreground, >= 4.5:1 on its tint)
        //   edge-*  the hairline        (ring / border)
        //
        // In dark themes the relationship inverts — a deep wash carrying a
        // bright tone — but the call site never changes: it still asks for
        // `bg-tint-danger text-tone-danger ring-edge-danger` and gets a
        // legible chip in every theme.
        //
        // `brand` and `accent` above stay literal on purpose: they are the
        // brand marks, and they must not drift between themes.
        tint: {
          brand: "rgb(var(--tint-brand) / <alpha-value>)",
          accent: "rgb(var(--tint-accent) / <alpha-value>)",
          danger: "rgb(var(--tint-danger) / <alpha-value>)",
          info: "rgb(var(--tint-info) / <alpha-value>)",
          neutral: "rgb(var(--tint-neutral) / <alpha-value>)",
        },
        tone: {
          brand: "rgb(var(--tone-brand) / <alpha-value>)",
          accent: "rgb(var(--tone-accent) / <alpha-value>)",
          danger: "rgb(var(--tone-danger) / <alpha-value>)",
          info: "rgb(var(--tone-info) / <alpha-value>)",
          neutral: "rgb(var(--tone-neutral) / <alpha-value>)",
        },
        edge: {
          brand: "rgb(var(--edge-brand) / <alpha-value>)",
          accent: "rgb(var(--edge-accent) / <alpha-value>)",
          danger: "rgb(var(--edge-danger) / <alpha-value>)",
          info: "rgb(var(--edge-info) / <alpha-value>)",
          neutral: "rgb(var(--edge-neutral) / <alpha-value>)",
        },

        // ============================================================
        // sidebar — the rail's own text/wash colours, themed
        // ============================================================
        // Classic and Dark keep the sidebar the fixed deep teal it always
        // was — these resolve to plain white/brand values there, identical to
        // the hardcoded `text-white` / `bg-white/10` classes they replaced.
        // Light is the one theme where the rail itself goes light, which is
        // what makes `sidebar-ink` need to flip to a dark value instead of
        // white staying illegible-on-white. `sidebar-fg` is the wash SOURCE
        // for hover/active/border states — used with Tailwind's opacity
        // suffix (`bg-sidebar-fg/10`, `border-sidebar-fg/25`, ...) exactly
        // like `bg-white/10` was, so every existing opacity step carries over
        // unchanged.
        sidebar: {
          ink: "rgb(var(--sidebar-ink) / <alpha-value>)",
          muted: "rgb(var(--sidebar-muted) / <alpha-value>)",
          accent: "rgb(var(--sidebar-accent) / <alpha-value>)",
          fg: "rgb(var(--sidebar-fg) / <alpha-value>)",
        },
      },

      fontFamily: {
        // Inter for UI text (excellent at small sizes), Sora for headings,
        // IBM Plex Mono for every currency figure. All self-hosted via
        // @fontsource, so there is no CDN request at runtime — which matters
        // for users on slow mobile connections.
        //
        // Sora is the mockup's display face and replaced IBM Plex Sans here.
        // It has noticeably more character at heading sizes and a tighter
        // default tracking, which is what makes the mockup's headings read as
        // designed rather than as default UI text. Plex Sans stays in the
        // stack as the metric-compatible fallback while Sora loads.
        sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        display: ["Sora", "IBM Plex Sans", "Inter", "system-ui", "sans-serif"],
        mono: ["IBM Plex Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },

      // ============================================================
      // Elevation — a 3-step scale, green-tinted rather than neutral black
      // ============================================================
      // Adopted from the mockup. A plain black shadow over a warm-white page
      // reads as grey haze; tinting the shadow toward the brand hue keeps
      // cards feeling like they sit ON this surface rather than floating over
      // an unrelated one.
      //
      // The tint is a variable because the trick inverts in the dark theme:
      // a green-tinted shadow on a near-black page is invisible, so dark
      // raises opacity and leans on pure black instead. Same three steps,
      // same call sites.
      boxShadow: {
        sm: "0 1px 2px rgb(var(--shadow) / var(--shadow-sm-a)), 0 1px 3px rgb(var(--shadow) / var(--shadow-sm-b))",
        md: "0 4px 16px rgb(var(--shadow) / var(--shadow-md-a))",
        lg: "0 18px 48px rgb(var(--shadow) / var(--shadow-lg-a))",
      },

      // 44px is the Fitts's-Law floor for a touch target. Named so call sites
      // read as intent rather than as a magic number.
      minWidth: { tap: "44px" },
      minHeight: { tap: "44px" },

      // ============================================================
      // The content measure
      // ============================================================
      // One number, used by the single `.shell` container that every page
      // renders into — which is what makes every page share a left and right
      // boundary.
      //
      // The value itself lives in index.css as `--content-max`, and the
      // reasoning lives with it. This entry just exposes it as a utility so
      // `max-w-content` is available; `.shell` reads the variable directly
      // rather than @apply-ing this, so the app's core layout does not depend
      // on Tailwind having reloaded its config.
      maxWidth: { content: "var(--content-max)" },

      // The two sidebar widths, named so the grid template, the transition
      // and the tooltip offsets can't drift apart.
      spacing: { sidebar: "16rem", "sidebar-collapsed": "4.5rem" },

      transitionDuration: { 250: "250ms" },

      transitionTimingFunction: {
        // The mockup's easing — a slight overshoot-free settle. Used for the
        // sidebar collapse so it decelerates into place instead of stopping.
        shell: "cubic-bezier(.4, 0, .2, 1)",
      },

      keyframes: {
        "pop-in": {
          "0%": { transform: "scale(0.85)", opacity: "0" },
          "60%": { transform: "scale(1.04)", opacity: "1" },
          "100%": { transform: "scale(1)", opacity: "1" },
        },
        "slide-up": {
          from: { transform: "translateY(8px)", opacity: "0" },
          to: { transform: "translateY(0)", opacity: "1" },
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
        // Dropdown/menu entrance — from the mockup's `pop` keyframe.
        "pop-down": {
          from: { opacity: "0", transform: "translateY(-4px)" },
          to: { opacity: "1", transform: "none" },
        },
        // Page/view transition — the mockup's `fade`.
        "fade-up": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "none" },
        },
        // Toast entrance.
        "toast-in": {
          from: { opacity: "0", transform: "translateY(10px)" },
          to: { opacity: "1", transform: "none" },
        },
        // Panels that slide in from the right edge — the notification centre
        // and the global-search results on mobile.
        "slide-in-right": {
          from: { opacity: "0", transform: "translateX(8px)" },
          to: { opacity: "1", transform: "none" },
        },
        // The unread badge on the notification bell, so a count that arrives
        // while the page is open is noticed rather than silently appearing.
        "badge-in": {
          "0%": { transform: "scale(0)", opacity: "0" },
          "70%": { transform: "scale(1.15)", opacity: "1" },
          "100%": { transform: "scale(1)", opacity: "1" },
        },
      },
      animation: {
        "pop-in": "pop-in 380ms cubic-bezier(.2,.9,.3,1) both",
        "slide-up": "slide-up 260ms ease-out both",
        shimmer: "shimmer 1.6s infinite",
        "pop-down": "pop-down 140ms ease both",
        "fade-up": "fade-up 200ms ease both",
        "toast-in": "toast-in 250ms ease both",
        "slide-in-right": "slide-in-right 180ms ease both",
        "badge-in": "badge-in 260ms cubic-bezier(.2,.9,.3,1) both",
      },
    },
  },
  plugins: [],
};
