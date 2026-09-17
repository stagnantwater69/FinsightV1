import {
  GraduationCap,
  Info,
  Palette,
  Sparkles,
  UserRound,
} from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useTourOptional, type TourContextValue } from "../context/TourContext";
import { getErrorMessage } from "../lib/errors";
import { Card, PageHead } from "../components/ui";
import { Button, ButtonLink } from "../components/Button";
import { SettingSwitch } from "../components/Switch";
import { ThemeSwitcher } from "../components/ThemeSwitcher";
import { useToast } from "../components/Toast";

/** Every preference saves immediately; a page-level Save button would only
 * leave someone unsure whether a visible switch had taken effect. */
export function AccountSettings() {
  return (
    <div className="w-full">
      <PageHead
        title="Account Settings"
        subtitle="Personalize how FinSight guides you and how your workspace looks."
      />

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.75fr)] xl:gap-8">
        {/* Both columns are grid items, which default to min-width:auto and
            so hold the page wider than a 200px viewport (400px at 200% zoom). */}
        <GuidancePanel />
        <div className="min-w-0 space-y-6">
          <AppearancePanel />
          <PreferenceDetailsPanel />
        </div>
      </div>
    </div>
  );
}

function GuidancePanel() {
  return (
    <Card className="min-w-0 overflow-hidden">
      {/* Wraps so Fin drops below the copy instead of holding the panel wider
          than a 200px viewport (400px at 200% zoom). */}
      <div className="flex flex-wrap items-start justify-between gap-5 bg-brand-900 px-5 py-5 sm:px-6 sm:py-6">
        <div className="min-w-0">
          <span className="mb-4 flex size-10 items-center justify-center rounded-xl bg-white/10 text-brand-100">
            <Sparkles size={19} aria-hidden />
          </span>
          <h2 className="font-display text-lg font-semibold text-white">
            Guidance and learning
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-brand-100">
            Decide when Fin appears and whether the product walkthrough should
            return when you sign in.
          </p>
        </div>
        <img
          src="/mascot/01-onboarding/tutorial.webp"
          alt=""
          aria-hidden
          width={72}
          height={72}
          draggable={false}
          className="size-[72px] shrink-0 select-none object-contain"
        />
      </div>

      <div className="divide-y divide-paper-200 px-5 sm:px-6">
        <MascotMessageSetting />
        <GuidedTourSetting />
      </div>
    </Card>
  );
}

function MascotMessageSetting() {
  const { preferences, updatePreferences } = useAuth();
  const toast = useToast();

  async function toggle(next: boolean) {
    try {
      await updatePreferences({ showDashboardMascotMessage: next });
    } catch (err) {
      toast(getErrorMessage(err));
    }
  }

  return (
    <section className="py-6" aria-labelledby="daily-message-heading">
      <SettingHeading
        id="daily-message-heading"
        icon={<Sparkles size={18} aria-hidden />}
        title="Daily Mascot Message"
        description="Control the personalized greeting Fin shows at the top of your Dashboard."
      />
      <SettingSwitch
        label="Show the daily message on my Dashboard"
        description="Turning this off only hides the Dashboard greeting. Fin remains available in the tour, empty states, and Ask FinSight."
        checked={preferences.showDashboardMascotMessage}
        onChange={(next) => void toggle(next)}
      />
    </section>
  );
}

function GuidedTourSetting() {
  const tour = useTourOptional();
  return tour ? <GuidedTourSettingContent tour={tour} /> : null;
}

function GuidedTourSettingContent({ tour }: { tour: TourContextValue }) {
  const toast = useToast();
  const navigate = useNavigate();

  async function toggleAlwaysShow(next: boolean) {
    try {
      await tour.setAlwaysShow(next);
    } catch (err) {
      toast(getErrorMessage(err));
    }
  }

  return (
    <section className="py-6" aria-labelledby="guided-tour-heading">
      <SettingHeading
        id="guided-tour-heading"
        tone="info"
        icon={<GraduationCap size={19} aria-hidden />}
        title="Guided Tour"
        description="Revisit the walkthrough or make it appear automatically whenever you sign in."
      />
      <SettingSwitch
        label="Always show the tour when I sign in"
        description="When off, the walkthrough appears only the first time. Turn it on for demonstrations or guided setup."
        checked={tour.alwaysShow}
        onChange={(next) => void toggleAlwaysShow(next)}
      />
      <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
        {tour.available ? null : (
          <p className="mr-auto text-sm text-ink-500">
            Add a business first—the tour uses your Dashboard.
          </p>
        )}
        <Button
          type="button"
          variant="secondary"
          disabled={!tour.available}
          onClick={() => {
            tour.restart();
            navigate("/dashboard");
          }}
        >
          Start Guided Tour
        </Button>
      </div>
    </section>
  );
}

function SettingHeading({
  id,
  icon,
  title,
  description,
  tone = "brand",
}: {
  id: string;
  icon: ReactNode;
  title: string;
  description: string;
  tone?: "brand" | "info";
}) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <span
        className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${tone === "info" ? "bg-tint-info text-tone-info" : "bg-tint-brand text-tone-brand"}`}
      >
        {icon}
      </span>
      <div>
        <h2 id={id} className="text-base font-semibold text-ink-900">
          {title}
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-ink-500">
          {description}
        </p>
      </div>
    </div>
  );
}

function AppearancePanel() {
  return (
    <Card className="p-5 sm:p-6">
      <div className="mb-5 flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-tint-brand text-tone-brand">
          <Palette size={19} aria-hidden />
        </span>
        <div>
          <h2 className="text-base font-semibold text-ink-900">Appearance</h2>
          <p className="mt-1 text-sm leading-relaxed text-ink-500">
            Choose the theme that is most comfortable for this screen.
          </p>
        </div>
      </div>
      <div className="flex min-h-tap items-center justify-between gap-4 rounded-xl bg-paper-100 p-4 ring-1 ring-paper-200">
        <span className="min-w-0">
          <span className="block text-sm font-medium text-ink-900">Theme</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-ink-600">
            Classic, Light, or Dark
          </span>
        </span>
        <ThemeSwitcher />
      </div>
    </Card>
  );
}

function PreferenceDetailsPanel() {
  return (
    <Card className="p-5 sm:p-6">
      <div className="mb-5 flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-tint-neutral text-tone-neutral">
          <Info size={19} aria-hidden />
        </span>
        <div>
          <h2 className="text-base font-semibold text-ink-900">
            Where settings are saved
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-ink-500">
            Not every preference follows you in the same way.
          </p>
        </div>
      </div>
      <dl className="divide-y divide-paper-200 border-y border-paper-200">
        <PreferenceDetail
          label="Daily message"
          value="Saved to your FinSight account"
        />
        <PreferenceDetail
          label="Guided tour"
          value="Remembered for this account in this browser"
        />
        <PreferenceDetail label="Theme" value="Saved only on this device" />
      </dl>
      <ButtonLink
        to="/profile"
        variant="secondary"
        fullWidth
        className="mt-5 justify-start"
      >
        <UserRound size={16} aria-hidden />
        Profile and security
      </ButtonLink>
    </Card>
  );
}

function PreferenceDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="py-3.5">
      <dt className="text-xs font-semibold text-ink-500">{label}</dt>
      <dd className="mt-1 text-sm font-medium leading-relaxed text-ink-800">
        {value}
      </dd>
    </div>
  );
}
