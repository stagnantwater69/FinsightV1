import { Fragment, type ReactNode } from "react";
import { useBusinessProfiles } from "../context/BusinessProfileContext";

/** Preserves app state across routes, but remounts it when ownership changes. */
export function BusinessOwnedBoundary({ children }: { children: ReactNode }) {
  const { selected } = useBusinessProfiles();
  return <Fragment key={selected?.id ?? "no-business"}>{children}</Fragment>;
}
