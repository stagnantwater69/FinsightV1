import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { NoBusinessProfile } from "../components/NoBusinessProfile";
import { PageHead } from "../components/ui";
import { BusinessProfileEditor } from "./EditBusinessProfile";

export function BusinessProfiles() {
  const { selected, loading } = useBusinessProfiles();

  if (loading) {
    return (
      <div className="max-w-6xl">
        <PageHead
          title="Business profile"
          subtitle="Settings apply to the selected business only."
        />
        <div className="space-y-6" aria-hidden>
          <div className="skeleton h-72 rounded-2xl" />
          <div className="skeleton h-96 rounded-2xl" />
          <div className="skeleton h-16 rounded-xl" />
          <div className="skeleton h-96 rounded-2xl" />
        </div>
        <span className="sr-only" aria-live="polite">
          Loading your business profile…
        </span>
      </div>
    );
  }

  if (!selected) {
    return (
      <NoBusinessProfile
        title="Business profile"
        subtitle="Add a business to start setting targets and tracking records."
      />
    );
  }

  return <BusinessProfileEditor key={selected.id} profile={selected} />;
}
