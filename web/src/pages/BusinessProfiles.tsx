import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { NoBusinessProfile } from "../components/NoBusinessProfile";
import { PageHead } from "../components/ui";
import { BusinessProfileEditor } from "./EditBusinessProfile";

export function BusinessProfiles() {
  const { selected, loading } = useBusinessProfiles();

  if (loading) {
    return (
      <div>
        <PageHead
          title="Business profile"
          subtitle="Settings apply to the selected business only."
        />
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(20rem,0.85fr)]">
          <div className="space-y-5">
            <div className="skeleton h-72 rounded-2xl" aria-hidden />
            <div className="skeleton h-96 rounded-2xl" aria-hidden />
          </div>
          <div className="space-y-5">
            <div className="skeleton h-64 rounded-2xl" aria-hidden />
            <div className="skeleton h-72 rounded-2xl" aria-hidden />
          </div>
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
