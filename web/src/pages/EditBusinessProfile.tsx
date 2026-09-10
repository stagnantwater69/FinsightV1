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
      aside={
        <div className="space-y-4">
          <Card className="overflow-hidden">
            <div className="bg-brand-900 p-5 text-white">
              <p className="font-display text-base font-semibold">
                Business tools
              </p>
              <p className="mt-1 text-sm leading-relaxed text-brand-100">
                Fine-tune how FinSight calculates targets and sends reminders
                for this business.
              </p>
            </div>
            <div className="divide-y divide-paper-200 px-5">
              <ManagementLink
                title="Operating schedule"
                description="Set regular opening days, holidays, and special openings used by Recovery Target."
                to={`/business-profiles/${profile.id}/operating-schedule`}
                action="Manage schedule"
              />
              <ManagementLink
                title="Recovery Target notifications"
                description="Choose alerts, quiet hours, and how frequently this business can notify you."
                to={`/business-profiles/${profile.id}/recovery-notifications`}
                action="Manage notifications"
              />
            </div>
          </Card>

          <Card className="bg-paper-100 p-5">
            <p className="text-sm font-semibold text-ink-900">
              What these figures affect
            </p>
            <p className="mt-2 text-sm leading-relaxed text-ink-600">
              Funds, expenses, operating days, and the large-expense threshold
              shape this business's Dashboard, insights, recovery calculations,
              and review flags.
            </p>
          </Card>
        </div>
      }
    >
      <BusinessProfileForm
        submitLabel="Save changes"
        onCancel={() => navigate("/business-profiles")}
        logo={
          <AvatarUpload
            photoUrl={profile.logoUrl}
            label={profile.name}
            changeLabel="Change logo"
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
      />
    </FormPage>
  );
}

function ManagementLink({
  title,
  description,
  to,
  action,
}: {
  title: string;
  description: string;
  to: string;
  action: string;
}) {
  return (
    <div className="py-5">
      <p className="text-sm font-semibold text-ink-900">{title}</p>
      <p className="mt-1 text-sm leading-relaxed text-ink-500">{description}</p>
      <Link
        to={to}
        className="tap mt-3 inline-flex rounded-lg px-2 text-sm font-semibold text-brand-700 transition hover:bg-tint-brand hover:text-tone-brand"
      >
        {action} →
      </Link>
    </div>
  );
}
