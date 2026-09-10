import { describe, expect, it } from "vitest";
import { landingRouteTarget } from "./landingRoute";

describe("landingRouteTarget", () => {
  it("sends a signed-in owner from a bare / to their dashboard", () => {
    expect(landingRouteTarget({ hash: "", signedIn: true })).toBe("dashboard");
  });

  it("serves the landing page to a visitor", () => {
    expect(landingRouteTarget({ hash: "", signedIn: false })).toBe("landing");
  });

  /*
   * QA register FUN-014: the public header's "Features" link is `/#features`,
   * and it took a signed-in visitor to the dashboard instead of the features
   * section.
   */
  it("serves the landing page when the URL names a section, even when signed in", () => {
    expect(landingRouteTarget({ hash: "#features", signedIn: true })).toBe("landing");
    expect(landingRouteTarget({ hash: "#faq", signedIn: true })).toBe("landing");
    expect(landingRouteTarget({ hash: "#how-it-works", signedIn: true })).toBe("landing");
  });

  it("treats an empty hash as no hash", () => {
    expect(landingRouteTarget({ hash: "#", signedIn: true })).toBe("dashboard");
  });
});
