import { Link, useNavigate, useParams } from "react-router-dom";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { BusinessProfileForm } from "../components/BusinessProfileForm";
import { AvatarUpload } from "../components/Avatar";
import { getErrorMessage } from "../lib/errors";
import type { BusinessProfileInput } from "../lib/types";
import { Card, FormPage } from "../components/ui";

export function EditBusinessProfile() {
  const { id } = useParams<{ id: string }>();
  const { profiles, updateProfile, uploadLogo } = useBusinessProfiles();
  const navigate = useNavigate();

  const profile = profiles.find((p) => p.id === Number(id));

  if (!profile) {
    return <p className="text-sm text-ink-500">Business profile not found.</p>;
  }

  async function handleSubmit(input: BusinessProfileInput) {
    try {
      await updateProfile(profile!.id, input);
      navigate("/business-profiles");
    } catch (err) {
      throw new Error(getErrorMessage(err));
    }
  }

  return (
    <FormPage
      eyebrow="Management"
      title={`Edit ${profile.name}`}
      subtitle="Changes apply to this business only. Your records aren't affected."
      wide
    >
      <BusinessProfileForm
        submitLabel="Save changes"
        onCancel={() => navigate("/business-profiles")}
        logo={
          <AvatarUpload
            photoUrl={profile.logoUrl}
            label={profile.name}
            changeLabel="Change logo"
            onUpload={(file) => uploadLogo(profile.id, file).then(() => undefined)}
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
      />

      <Card className="mt-6 flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink-900">Operating schedule</p>
          <p className="mt-0.5 text-xs text-ink-500">
            Set which days of the week this business is normally open, plus any holidays or special
            openings — used to calculate exact operating days on your Recovery Target.
          </p>
        </div>
        <Link
          to={`/business-profiles/${profile.id}/operating-schedule`}
          className="tap-inline shrink-0 rounded-lg px-3 py-2 text-sm font-semibold text-brand-700 underline-offset-2 hover:underline"
        >
          Manage schedule →
        </Link>
      </Card>

      <Card className="mt-4 flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink-900">Recovery Target notifications</p>
          <p className="mt-0.5 text-xs text-ink-500">
            Choose which Recovery Target alerts this business can send you, plus quiet hours and how often.
          </p>
        </div>
        <Link
          to={`/business-profiles/${profile.id}/recovery-notifications`}
          className="tap-inline shrink-0 rounded-lg px-3 py-2 text-sm font-semibold text-brand-700 underline-offset-2 hover:underline"
        >
          Manage notifications →
        </Link>
      </Card>
    </FormPage>
  );
}
