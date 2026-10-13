import { Fragment, type ReactNode } from "react";

export function BusinessNavigationBoundary({
  businessProfileId,
  children,
}: {
  businessProfileId: number | null;
  children: ReactNode;
}) {
  return <Fragment key={businessProfileId ?? "no-business"}>{children}</Fragment>;
}
