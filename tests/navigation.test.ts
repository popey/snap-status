import { describe, expect, it } from "vitest";
import { statusNavigationItems } from "../src/navigation";

describe("status navigation", () => {
  it("includes every dashboard status", () => {
    expect(statusNavigationItems.map((item) => item.status)).toEqual([
      "all",
      "outdated",
      "testing",
      "unknown",
      "manual",
      "static",
    ]);
    expect(statusNavigationItems.at(-1)).toEqual({
      label: "No updates expected",
      status: "static",
    });
  });
});
