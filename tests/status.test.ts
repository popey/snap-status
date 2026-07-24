import { describe, expect, it } from "vitest";
import { classifyStatus, compareVersions, normalizeVersion } from "../src/status";

describe("version normalization", () => {
  it("ignores a conventional leading v", () => {
    expect(normalizeVersion("v1.2.3")).toEqual(normalizeVersion("1.2.3"));
  });

  it("compares prefixed numeric releases", () => {
    expect(compareVersions("mame0288", "mame0287")).toBeGreaterThan(0);
    expect(compareVersions("20260322-193052-51e70d7", "b2-20260322-193052-51e70d7")).toBe(0);
  });

  it("treats git-describe commits as newer than their base release", () => {
    expect(compareVersions("2.4.1-161-ge9dadb4", "2.4.1")).toBeGreaterThan(0);
  });
});

describe("snap status", () => {
  it("is current when stable reaches upstream", () => {
    expect(classifyStatus({ stable: ["v1.2.0"] }, "1.2.0")).toBe("current");
  });

  it("is testing when only a pre-stable channel reaches upstream", () => {
    expect(
      classifyStatus({ stable: ["1.1.0"], candidate: [], beta: [], edge: ["1.2.0"] }, "1.2.0"),
    ).toBe("testing");
  });

  it("is outdated when no channel reaches upstream", () => {
    expect(classifyStatus({ stable: ["1.1.0"], edge: ["1.1.1"] }, "1.2.0")).toBe("outdated");
    expect(classifyStatus({ stable: ["1.1.0"], edge: ["latest"] }, "1.2.0")).toBe("outdated");
  });

  it("is unknown without upstream data", () => {
    expect(classifyStatus({ stable: ["1.1.0"] }, null)).toBe("unknown");
  });

  it("uses explicit statuses for non-automatic tracking", () => {
    expect(classifyStatus({ stable: ["1.0"] }, null, "manual")).toBe("manual");
    expect(classifyStatus({ stable: ["null"] }, null, "static")).toBe("static");
  });
});
