import { Modal } from "./Modal";
import { BusinessProfileForm } from "./BusinessProfileForm";
import { AvatarUpload } from "./Avatar";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import type { BusinessProfile, BusinessProfileInput } from "../lib/types";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Present when editing; absent when creating. */
  profile?: BusinessProfile;
  onSaved: (profile: BusinessProfile) => void;
}

/**
 * "Add Business Profile" and "Edit" as a popup on the All Businesses list —
 * the same BusinessProfileForm the full-page Create/EditBusinessProfile
 * routes use, just inside a Modal instead of a FormPage. Those page routes
 * stay for the entry points that aren't already looking at this list (the
 * detail page's own Edit button, empty states).
 */
export function BusinessProfileFormModal({
  open,
  onClose,
  profile,
  onSaved,
}: Props) {
  const { profiles, createProfile, updateProfile, uploadLogo } = useBusinessProfiles();
  const currentProfile = profile
    ? (profiles.find((candidate) => candidate.id === profile.id) ?? profile)
    : undefined;

  async function handleSubmit(input: BusinessProfileInput) {
    const saved = profile
      ? await updateProfile(profile.id, input)
      : await createProfile(input);
    onSaved(saved);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={profile ? `Edit ${profile.name}` : "Add Business Profile"}
      size="wide"
    >
      {currentProfile ? (
        <div className="mb-5">
          <AvatarUpload
            photoUrl={currentProfile.logoUrl}
            label={currentProfile.name}
            changeLabel="Change logo"
            successMessage="Logo updated"
            onUpload={(file) => uploadLogo(currentProfile.id, file).then(onSaved)}
          />
        </div>
      ) : null}
      <BusinessProfileForm
        compact
        submitLabel={profile ? "Save changes" : "Create business"}
        initialValues={
          profile
            ? {
                name: profile.name,
                type: profile.type,
                availableFunds: profile.availableFunds,
                expectedMonthlyExpenses: profile.expectedMonthlyExpenses,
                operatingDays: profile.operatingDays,
                largeExpenseThresholdPercent:
                  profile.largeExpenseThresholdPercent,
              }
            : undefined
        }
        onSubmit={handleSubmit}
      />
    </Modal>
  );
}
