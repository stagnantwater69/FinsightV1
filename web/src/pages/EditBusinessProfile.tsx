import { useState, type ComponentType, type SVGProps } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Bell,
  BookOpen,
  CalendarDays,
  ChevronRight,
  LayoutDashboard,
  ReceiptText,
  Settings,
  Target,
  Upload,
} from "lucide-react";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { BusinessProfileForm } from "../components/BusinessProfileForm";
import { AvatarUpload } from "../components/Avatar";
import { ButtonLink } from "../components/Button";
import { useToast } from "../components/Toast";
import { Card, PageHead } from "../components/ui";
import { getErrorMessage } from "../lib/errors";
import { useUnsavedChangesWarning } from "../lib/navigationGuards";
import type { BusinessProfile, BusinessProfileInput } from "../lib/types";

type LucideIcon = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

export function BusinessProfileEditor({
  profile,
  returnToSelectedProfile = false,
}: {
  profile: BusinessProfile;
  returnToSelectedProfile?: boolean;
}) {
  const { updateProfile, uploadLogo } = useBusinessProfiles();
  const navigate = useNavigate();
  const toast = useToast();
  const [dirty, setDirty] = useState(false);
  const allowNavigation = useUnsavedChangesWarning(
    dirty,
    "Leave this business profile? Your unsaved changes will be lost.",
  );

  async function handleSubmit(input: BusinessProfileInput) {
    try {
      await updateProfile(profile.id, input);
      toast("Business profile updated");
      if (returnToSelectedProfile) {
        allowNavigation();
        navigate("/business-profiles", { replace: true });
      }
    } catch (err) {
      throw new Error(getErrorMessage(err));
    }
  }

  function handleCancel() {
    if (!returnToSelectedProfile) return;
    allowNavigation();
    navigate("/business-profiles", { replace: true });
  }

  return (
    <div className="w-full">
      <PageHead
        title="Business profile"
        subtitle={
          <>
            Settings for <span className="font-medium text-ink-700">{profile.name}</span>. Changes apply to this business only.
          </>
        }
        actions={
          <ButtonLink to="/business-profiles/all" variant="secondary" size="sm">
            View all businesses
          </ButtonLink>
        }
      />

      <BusinessProfileForm
        key={profile.id}
        submitLabel="Save changes"
        onCancel={handleCancel}
        onDirtyChange={setDirty}
        logo={
          <AvatarUpload
            photoUrl={profile.logoUrl}
            label={profile.name}
            changeLabel="Change logo"
            successMessage="Logo updated"
            size="xl"
            buttonIcon={<Upload size={16} aria-hidden />}
            helpText="JPEG, PNG, or WebP up to 5 MB. Logo changes save immediately."
            onUpload={(file) =>
              uploadLogo(profile.id, file).then(() => undefined)
            }
          />
        }
        initialValues={{
          name: profile.name,
          type: profile.type,
          availableFunds: profile.availableFunds,
          expectedMonthlyExpenses: profile.expectedMonthlyExpenses,
          operatingDays: profile.operatingDays,
          largeExpenseThresholdPercent: profile.largeExpenseThresholdPercent,
        }}
        onSubmit={handleSubmit}
        settingsAside={
          <>
            <Card className="p-5 sm:p-6">
              <SettingsHeading
                icon={Settings}
                title="Business tools"
                description="Fine-tune how FinSight calculates targets and sends reminders."
              />
              <div className="mt-5 divide-y divide-paper-200">
                <ManagementLink
                  Icon={CalendarDays}
                  title="Operating schedule"
                  description="Set regular opening days, holidays, and special openings used by Recovery Target."
                  to={`/business-profiles/${profile.id}/operating-schedule`}
                  action="Manage schedule"
                />
                <ManagementLink
                  Icon={Bell}
                  title="Recovery Target notifications"
                  description="Choose alerts, quiet hours, and how frequently this business can notify you."
                  to={`/business-profiles/${profile.id}/recovery-notifications`}
                  action="Manage notifications"
                />
              </div>
            </Card>

            <Card className="p-5 sm:p-6">
              <SettingsHeading
                icon={BookOpen}
                title="Where these settings are used"
                description="These details power key parts of FinSight."
              />
              <dl className="mt-5 divide-y divide-paper-200">
                <UsageRow
                  Icon={LayoutDashboard}
                  title="Dashboard"
                  description="Planning figures shape targets, progress, and key insights."
                />
                <UsageRow
                  Icon={Target}
                  title="Recovery target"
                  description="Monthly expenses and operating days set the daily sales target."
                />
                <UsageRow
                  Icon={ReceiptText}
                  title="Expense flags"
                  description="The threshold identifies unusually large expenses for review."
                />
              </dl>
            </Card>
          </>
        }
      />
    </div>
  );
}

export function EditBusinessProfile() {
  const { id } = useParams<{ id: string }>();
  const { profiles } = useBusinessProfiles();
  const profile = profiles.find((candidate) => candidate.id === Number(id));

  if (!profile) {
    return <p className="text-sm text-ink-500">Business profile not found.</p>;
  }

  return (
    <BusinessProfileEditor
      key={profile.id}
      profile={profile}
      returnToSelectedProfile
    />
  );
}

function SettingsHeading({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-tint-brand text-tone-brand ring-1 ring-edge-brand">
        <Icon size={21} aria-hidden />
      </span>
      <div className="min-w-0 pt-0.5">
        <h2 className="font-display text-base font-semibold text-ink-900 sm:text-lg">
          {title}
        </h2>
        <p className="mt-0.5 text-sm leading-relaxed text-ink-500">
          {description}
        </p>
      </div>
    </div>
  );
}

function ManagementLink({
  Icon,
  title,
  description,
  to,
  action,
}: {
  Icon: LucideIcon;
  title: string;
  description: string;
  to: string;
  action: string;
}) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 py-5 first:pt-0 last:pb-0 2xl:grid-cols-[auto_minmax(0,1fr)_auto] 2xl:items-center">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-tint-brand text-tone-brand">
        <Icon size={20} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink-900">{title}</p>
        <p className="mt-1 max-w-[52ch] text-sm leading-relaxed text-ink-500">
          {description}
        </p>
      </div>
      <Link
        to={to}
        className="tap col-span-2 inline-flex w-full shrink-0 items-center justify-center gap-2 rounded-lg border border-ink-200 bg-paper px-3 text-sm font-medium text-ink-700 transition-colors hover:bg-paper-100 2xl:col-span-1 2xl:w-auto"
      >
        {action}
        <ChevronRight size={16} aria-hidden />
      </Link>
    </div>
  );
}

function UsageRow({
  Icon,
  title,
  description,
}: {
  Icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-3 py-4 first:pt-0 last:pb-0">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-paper-100 text-tone-brand">
        <Icon size={19} aria-hidden />
      </span>
      <div className="min-w-0">
        <dt className="text-sm font-semibold text-ink-900">{title}</dt>
        <dd className="mt-1 max-w-[58ch] text-sm leading-relaxed text-ink-500">
          {description}
        </dd>
      </div>
    </div>
  );
}
