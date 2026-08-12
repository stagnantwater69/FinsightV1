import { useNavigate } from "react-router-dom";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { BusinessProfileForm } from "../components/BusinessProfileForm";
import { getErrorMessage } from "../lib/errors";
import type { BusinessProfileInput } from "../lib/types";
import { FormPage } from "../components/ui";

export function CreateBusinessProfile() {
  const { createProfile } = useBusinessProfiles();
  const navigate = useNavigate();

  async function handleSubmit(input: BusinessProfileInput) {
    try {
      await createProfile(input);
      navigate("/business-profiles");
    } catch (err) {
      throw new Error(getErrorMessage(err));
    }
  }

  return (
    <FormPage eyebrow="Management" title="Create a business profile" wide>
      <BusinessProfileForm submitLabel="Create business" onSubmit={handleSubmit} />
    </FormPage>
  );
}
