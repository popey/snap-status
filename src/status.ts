export type ChannelRisk = "stable" | "candidate" | "beta" | "edge";
export type TrackingMode = "automatic" | "manual" | "static";
export type SnapStatus = "current" | "testing" | "outdated" | "unknown" | "manual" | "static";
export type VersionToken = number | string;

const PRE_RELEASE = new Set(["alpha", "beta", "pre", "preview", "rc"]);

export function normalizeVersion(value: string): VersionToken[] {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^v(?=\d)/, "")
    .replace(/^[a-z][a-z0-9]*-(?=\d{4,})/, "");
  const tokens = (normalized.match(/\d+|[a-z]+/g) ?? []).map((token) =>
    /^\d+$/.test(token) ? Number.parseInt(token, 10) : token,
  );
  while (typeof tokens[0] === "string") tokens.shift();
  return tokens;
}

export function compareVersions(left: string, right: string): number {
  const a = normalizeVersion(left);
  const b = normalizeVersion(right);
  const shared = Math.min(a.length, b.length);

  for (let index = 0; index < shared; index += 1) {
    const x = a[index];
    const y = b[index];
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x).localeCompare(String(y), undefined, { numeric: true });
  }

  if (a.length === b.length) return 0;
  const remainder = (a.length > b.length ? a : b).slice(shared);
  const direction = a.length > b.length ? 1 : -1;
  if (remainder.some((token) => typeof token === "string" && PRE_RELEASE.has(token))) {
    return -direction;
  }
  return direction;
}

export function classifyStatus(
  channels: Partial<Record<ChannelRisk, string[]>>,
  upstream: string | null,
  tracking: TrackingMode = "automatic",
): SnapStatus {
  if (tracking === "manual") return "manual";
  if (tracking === "static") return "static";
  if (!upstream) return "unknown";
  if ((channels.stable ?? []).some((version) => compareVersions(version, upstream) >= 0)) {
    return "current";
  }
  const testingVersions = [
    ...(channels.candidate ?? []),
    ...(channels.beta ?? []),
    ...(channels.edge ?? []),
  ];
  return testingVersions.some((version) => compareVersions(version, upstream) >= 0)
    ? "testing"
    : "outdated";
}
