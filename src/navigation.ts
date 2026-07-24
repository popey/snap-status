import type { SnapStatus } from "./status";

export type StatusNavigationItem = {
  label: string;
  status: SnapStatus | "all";
};

export const statusNavigationItems: readonly StatusNavigationItem[] = [
  { label: "All snaps", status: "all" },
  { label: "Update needed", status: "outdated" },
  { label: "In testing", status: "testing" },
  { label: "Needs mapping", status: "unknown" },
  { label: "Manual review", status: "manual" },
  { label: "No updates expected", status: "static" },
];
