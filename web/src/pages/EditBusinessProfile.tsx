import { useState, type ComponentType, type SVGProps } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Bell, CalendarDays, ChevronRight, Upload } from "lucide-react";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { BusinessProfileForm } from "../components/BusinessProfileForm";
import { FinancialPositionPanel } from "../components/FinancialPositionPanel";
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
    <div className="w-full max-w-6xl">
      <PageHead
        title="Business profile"
        subtitle="Settings apply to this business only."
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
            <FinancialPositionPanel profile={profile} />

            <Card className="p-5 shadow-none sm:p-7">
              <h2 className="font-display text-lg font-semibold text-ink-900">
                Business tools
              </h2>
              <div className="mt-2 divide-y divide-paper-200 lg:grid lg:grid-cols-2 lg:divide-x lg:divide-y-0">
                <ManagementLink
                  Icon={CalendarDays}
                  title="Operating schedule"
                  description="Opening days, holidays, and special openings used by Recovery Target."
                  to={`/business-profiles/${profile.id}/operating-schedule`}
                  action="Manage schedule"
                />
                <ManagementLink
                  Icon={Bell}
                  title="Recovery Target notifications"
                  description="Alerts, quiet hours, and how often this business can notify you."
                  to={`/business-profiles/${profile.id}/recovery-notifications`}
                  action="Manage notifications"
                />
              </div>
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
    <Link
      to={to}
      className="group flex min-w-0 items-start gap-3 rounded-lg py-5 transition-colors hover:bg-paper-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 lg:pr-6 lg:last:pl-6 lg:last:pr-0"
    >
      <Icon size={20} className="mt-0.5 shrink-0 text-tone-brand" aria-hidden />
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-ink-900">{title}</h3>
        <p className="mt-1 max-w-[52ch] text-sm leading-relaxed text-ink-500">
          {description}
        </p>
        <span className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-tone-brand group-hover:underline">
          {action}
          <ChevronRight size={16} aria-hidden />
        </span>
      </div>
    </Link>
  );
}
