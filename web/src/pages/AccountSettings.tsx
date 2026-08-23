import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useTourOptional, type TourContextValue } from "../context/TourContext";
import { getErrorMessage } from "../lib/errors";
import { Card, PageHead } from "../components/ui";
import { Button } from "../components/Button";
import { SettingSwitch } from "../components/Switch";
import { ThemeSwitcher } from "../components/ThemeSwitcher";
import { useToast } from "../components/Toast";

/**
 * The preferences screen — how FinSight guides you, and how it looks.
 *
 * SEPARATE FROM /profile ON PURPOSE. Profile is identity and security: your
 * name, your password, your devices, and the one irreversible button in the
 * app. Nothing there should sit next to a switch someone flicks to see what it
 * does. The guided-tour panel used to, and moved here whole.
 *
 * NOTHING HERE HAS A SAVE BUTTON. Every control is a single preference with an
 * immediately visible effect, so it writes on change and reports failure by
 * putting itself back — a Save button would only add a step where the owner
 * can walk away believing a switch they can see is on.
 */
export function AccountSettings() {
  return (
    <div>
      <PageHead
        eyebrow="Account"
        title="Account Settings"
        subtitle="Choose how FinSight guides you day to day, and how it looks."
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <GuidedTourPanel />
          <AppearancePanel />
        </div>
        <div className="space-y-6">
          <MascotMessagePanel />
        </div>
      </div>
    </div>
  );
}

/**
 * Fin, illustrating the setting a card is about.
 *
 * Poses come from the existing library only (web/public/mascot/, mapped in
 * docs/mascot-scenario-library.md and components/tour/steps.tsx) — no new art.
 * Decorative: the heading and description carry every word of the meaning, so
 * it is `alt=""` and hidden from assistive tech.
 */
function CardMascot({ pose }: { pose: string }) {
  return (
    <img
      src={pose}
      alt=""
      aria-hidden
      width={56}
      height={56}
      draggable={false}
      className="h-14 w-14 shrink-0 select-none object-contain"
    />
  );
}

/**
 * The guided tour's own settings.
 *
 * WHY THIS EXISTS AT ALL. The tour is deliberately once-per-account: it starts
 * itself for a new owner and never interrupts again. That is right for a real
 * owner and impossible for everyone else — showing the tour to someone, or
 * re-checking a change to it, meant registering a fresh account or clearing
 * browser storage by hand. The toggle is the supported way to keep it on.
 *
 * It keeps the one-shot "Start" next to the standing "Always show" so the two
 * are read together rather than hunted for in different places.
 *
 * Renders nothing when the tour provider is absent (the public pages, tests
 * that mount this page alone), so it can never be the reason a page fails.
 */
function GuidedTourPanel() {
  const tour = useTourOptional();
  // Split in two rather than guarding inside one component: the panel's own
  // handlers run long after render, and TypeScript will not carry a
  // `if (!tour) return null` narrowing into a callback that outlives the
  // render that made it. Passing the resolved value down makes the
  // non-nullness structural instead of asserted.
  return tour ? <GuidedTourCard tour={tour} /> : null;
}

function GuidedTourCard({ tour }: { tour: TourContextValue }) {
  const toast = useToast();
  const navigate = useNavigate();

  const toggleAlwaysShow = async (next: boolean) => {
    try {
      await tour.setAlwaysShow(next);
    } catch (err) {
      toast(getErrorMessage(err));
    }
  };

  return (
    <Card className="p-6 sm:p-7">
      <div className="mb-5 flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="mb-1 text-base font-semibold text-ink-900">Guided Tour</h2>
          <p className="text-xs text-ink-500">
            Revisit the FinSight walkthrough and learn how to use the main features.
          </p>
        </div>
        <CardMascot pose="/mascot/01-onboarding/tutorial.webp" />
      </div>

      <SettingSwitch
        label="Always show the tour when I sign in"
        description="Replays the walkthrough on every sign-in instead of only the first. Useful for demonstrating FinSight or setting it up for someone else — turn it off and the tour goes back to appearing once."
        checked={tour.alwaysShow}
        onChange={(next) => void toggleAlwaysShow(next)}
      />

      <div className="mt-4 flex justify-end">
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            // Rewind first, then land on the dashboard — the tour's targets
            // are that page and its chrome, so it opens once the data is in.
            tour.restart();
            navigate("/dashboard");
          }}
        >
          Start Guided Tour
        </Button>
      </div>
    </Card>
  );
}

/**
 * Fin's daily line on the dashboard, on or off.
 *
 * The message is composed from the owner's own figures (lib/homeInsight.ts),
 * not written by a model — so this is a "do I want to be greeted" preference,
 * not an AI opt-out, and it is worded as one. It hides ONLY that panel: Fin
 * still guides the tour, still fronts Ask FinSight, and still appears in empty
 * states, because those are answers to something the owner just did rather
 * than an unprompted daily message.
 */
function MascotMessagePanel() {
  const { preferences, updatePreferences } = useAuth();
  const toast = useToast();

  async function toggle(next: boolean) {
    try {
      // Optimistic inside updatePreferences: the switch moves now and puts
      // itself back if the account refuses the change.
      await updatePreferences({ showDashboardMascotMessage: next });
    } catch (err) {
      toast(getErrorMessage(err));
    }
  }

  return (
    <Card className="p-6 sm:p-7">
      <div className="mb-5 flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="mb-1 text-base font-semibold text-ink-900">Daily Mascot Message</h2>
          <p className="text-xs text-ink-500">
            Show helpful daily tips, reminders, or financial messages from the FinSight mascot on your Dashboard.
          </p>
        </div>
        <CardMascot pose="/mascot/greeting.webp" />
      </div>

      <SettingSwitch
        label="Show the daily message on my Dashboard"
        description="Turning this off hides the greeting panel at the top of the Dashboard. Fin still helps everywhere else."
        checked={preferences.showDashboardMascotMessage}
        onChange={(next) => void toggle(next)}
      />
    </Card>
  );
}

/**
 * Theme, in the place someone actually looks for it.
 *
 * The same ThemeSwitcher the topbar uses, not a second copy of the choice —
 * three themes, one control. It stays in the topbar too: changing a theme is a
 * thing people do while looking at the screen they want to change.
 *
 * PER DEVICE, DELIBERATELY, and the card says so. Theme is the one preference
 * on this page that is not on the account: a phone in dark mode at night
 * should not drag the shop's desktop with it.
 */
function AppearancePanel() {
  return (
    <Card className="p-6 sm:p-7">
      <h2 className="mb-1 text-base font-semibold text-ink-900">Appearance</h2>
      <p className="mb-5 text-xs text-ink-500">
        Pick the look that's easiest on your eyes. This one is saved on this device rather than your account.
      </p>

      <div className="flex min-h-tap items-center justify-between gap-4 rounded-xl border border-paper-200 p-3.5">
        <span className="min-w-0">
          <span className="block text-sm font-medium text-ink-900">Theme</span>
          <span className="mt-0.5 block text-xs text-ink-500">Classic, Light or Dark.</span>
        </span>
        <ThemeSwitcher />
      </div>
    </Card>
  );
}
