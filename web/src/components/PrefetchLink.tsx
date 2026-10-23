import type { FocusEvent, PointerEvent } from "react";
import { Link, type LinkProps } from "react-router-dom";
import { prefetchRoute } from "../lib/routeLoaders";
import { useRouteDataPrefetch } from "../lib/routeDataPrefetch";

function destinationPath(to: LinkProps["to"]): string {
  return typeof to === "string" ? to : to.pathname ?? "";
}

/** Warms only the route signaled by keyboard, mouse, pen, or touch intent: its code, and its main read. */
export function PrefetchLink({
  to,
  onFocus,
  onPointerEnter,
  onPointerDown,
  ...props
}: LinkProps) {
  const warmData = useRouteDataPrefetch();
  const warm = () => {
    const pathname = destinationPath(to);
    if (!pathname) return;
    void prefetchRoute(pathname);
    warmData?.(pathname);
  };

  return (
    <Link
      {...props}
      to={to}
      onFocus={(event: FocusEvent<HTMLAnchorElement>) => {
        onFocus?.(event);
        if (!event.defaultPrevented) warm();
      }}
      onPointerEnter={(event: PointerEvent<HTMLAnchorElement>) => {
        onPointerEnter?.(event);
        if (!event.defaultPrevented) warm();
      }}
      onPointerDown={(event: PointerEvent<HTMLAnchorElement>) => {
        onPointerDown?.(event);
        if (!event.defaultPrevented) warm();
      }}
    />
  );
}
