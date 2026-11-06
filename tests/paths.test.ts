import { describe, expect, it } from "vitest";
import { isSubscriptionsPath } from "../src/shared/paths";

describe("isSubscriptionsPath", () => {
  it.each([
    ["/feed/subscriptions", true],
    ["/feed/subscriptions/", true],
    ["/", false],
    ["/feed", false],
    ["/feed/history", false],
    ["/feed/subscription", false],
    ["/feed/subscriptions/x", false],
    ["/watch", false],
    ["/results", false],
    ["/@channel/videos", false],
    ["", false],
  ])("%s → %s", (p, want) => expect(isSubscriptionsPath(p)).toBe(want));

  it("нестроки → false", () => {
    for (const v of [undefined, null, 5, {}, ["/feed/subscriptions"]]) expect(isSubscriptionsPath(v as never)).toBe(false);
  });
});
