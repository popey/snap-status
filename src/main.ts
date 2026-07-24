import "./vanilla.scss";
import { statusNavigationItems } from "./navigation";
import {
  classifyStatus,
  compareVersions,
  type ChannelRisk,
  type SnapStatus,
  type TrackingMode,
} from "./status";

type ChannelInfo = { version: string | null; versions: string[] };
type SnapRecord = {
  name: string;
  title: string;
  storeUrl: string;
  channels: Record<ChannelRisk, ChannelInfo>;
  storeError: string | null;
  upstream: { version: string | null; url: string | null; error: string | null };
  tracking?: { mode: TrackingMode; url?: string; note?: string };
};
type DashboardData = {
  generatedAt: string;
  publisher: string;
  count: number;
  snaps: SnapRecord[];
};
type EnrichedSnap = SnapRecord & { status: SnapStatus };
type SortKey = "title" | "status" | ChannelRisk | "upstream";

const risks: ChannelRisk[] = ["stable", "candidate", "beta", "edge"];
const statusOrder: Record<SnapStatus, number> = {
  outdated: 0,
  testing: 1,
  unknown: 2,
  manual: 3,
  static: 4,
  current: 5,
};
const statusLabels: Record<SnapStatus, string> = {
  current: "Current",
  testing: "In testing",
  outdated: "Update needed",
  unknown: "Needs mapping",
  manual: "Manual review",
  static: "No updates expected",
};
const chipClasses: Record<SnapStatus, string> = {
  current: "p-chip--positive",
  testing: "p-chip--caution",
  outdated: "p-chip--negative",
  unknown: "p-chip--information",
  manual: "p-chip--information",
  static: "p-chip--positive",
};

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"]/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!,
  );

const safeUrl = (value: string | null): string => {
  if (!value) return "#";
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? escapeHtml(url.href) : "#";
  } catch {
    return "#";
  }
};

const relativeTime = (iso: string): string => {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (Math.abs(seconds) < 90) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 90) return formatter.format(minutes, "minute");
  return formatter.format(Math.round(minutes / 60), "hour");
};

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing #app");

async function load(): Promise<void> {
  const response = await fetch(`/data.json?ts=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Data request failed (${response.status})`);
  const data = (await response.json()) as DashboardData;
  const snaps: EnrichedSnap[] = data.snaps.map((snap) => ({
    ...snap,
    status: classifyStatus(
      Object.fromEntries(risks.map((risk) => [risk, snap.channels[risk]?.versions ?? []])),
      snap.upstream.version,
      snap.tracking?.mode ?? "automatic",
    ),
  }));
  render(data, snaps);
}

function render(data: DashboardData, snaps: EnrichedSnap[]): void {
  let activeStatus: SnapStatus | "all" = "all";
  let search = "";
  let sortKey: SortKey = "status";
  let sortDirection: 1 | -1 = 1;

  const counts = Object.fromEntries(
    (["current", "testing", "outdated", "unknown", "manual", "static"] as SnapStatus[]).map((status) => [
      status,
      snaps.filter((snap) => snap.status === status).length,
    ]),
  ) as Record<SnapStatus, number>;

  app!.innerHTML = `
    <header id="navigation" class="p-navigation is-dark">
      <div class="p-navigation__row--25-75">
        <div class="p-navigation__banner">
          <div class="p-navigation__tagged-logo">
            <a class="p-navigation__link" href="/">
              <span class="p-navigation__logo-title">Snap Status</span>
            </a>
          </div>
          <ul class="p-navigation__items">
            <li class="p-navigation__item">
              <button class="p-navigation__toggle--open js-menu-button">Menu</button>
              <button class="p-navigation__toggle--close js-menu-button">Close</button>
            </li>
          </ul>
        </div>
        <nav class="p-navigation__nav" aria-label="Status filters">
          <ul class="p-navigation__items">
            ${statusNavigationItems.map(({ label, status }, index) => navItem(label, status, index === 0)).join("")}
          </ul>
          <ul class="p-navigation__items">
            <li class="p-navigation__item"><a class="p-navigation__link" href="https://github.com/popey/snap-status" target="_blank" rel="noreferrer">GitHub ↗</a></li>
          </ul>
        </nav>
      </div>
    </header>

    <section class="p-strip--light is-shallow status-strip" aria-label="Status summary">
      <div class="u-fixed-width status-strip__items">
        <span><strong>${data.count}</strong> snaps tracked</span>
        <button data-status="current"><strong class="status-count--current">${counts.current}</strong> current</button>
        <button data-status="outdated"><strong class="status-count--outdated">${counts.outdated}</strong> need updates</button>
        <button data-status="testing"><strong class="status-count--testing">${counts.testing}</strong> in testing</button>
        <button data-status="unknown"><strong>${counts.unknown}</strong> need mapping</button>
        <button data-status="manual"><strong>${counts.manual}</strong> manual review</button>
        <button data-status="static"><strong>${counts.static}</strong> no updates expected</button>
        <span>Synced <strong>${escapeHtml(relativeTime(data.generatedAt))}</strong></span>
      </div>
    </section>

    <main>
      <section class="p-strip is-shallow intro-strip">
        <div class="row">
          <div class="col-8">
            <p class="p-heading--5 section-kicker">MAINTAINED BY ${escapeHtml(data.publisher.toUpperCase())}</p>
            <h1>Snap maintenance dashboard</h1>
            <p class="p-heading--4">Compare every release channel with the latest upstream version.</p>
          </div>
          <div class="col-4 intro-note">
            <p>Live data from the Snap Store, GitHub, Codeberg and npm. Refreshes hourly.</p>
          </div>
        </div>
      </section>

      <section id="snap-table" class="p-strip is-shallow table-strip">
        <div class="row table-heading">
          <div class="col-6"><h2 class="p-heading--4">Maintained snaps</h2></div>
          <div class="col-6">
            <form class="p-search-box" id="search-form" role="search">
              <label class="u-off-screen" for="search">Filter snaps</label>
              <input type="search" id="search" class="p-search-box__input" placeholder="Filter by app or snap name…" autocomplete="off" />
              <button type="reset" class="p-search-box__reset"><i class="p-icon--close">Clear</i></button>
              <button type="submit" class="p-search-box__button"><i class="p-icon--search">Search</i></button>
            </form>
          </div>
        </div>

        <div class="row">
          <div class="col-12">
            <div class="filter-bar" aria-label="Filter by status">
              ${filterButton("All", "all", data.count, true)}
              ${filterButton("Current", "current", counts.current)}
              ${filterButton("Update needed", "outdated", counts.outdated)}
              ${filterButton("In testing", "testing", counts.testing)}
              ${filterButton("Needs mapping", "unknown", counts.unknown)}
              ${filterButton("Manual review", "manual", counts.manual)}
              ${filterButton("No updates expected", "static", counts.static)}
            </div>
            <div class="table-scroll">
              <table class="p-table--mobile-card" role="grid">
                <thead><tr>
                  ${heading("Application", "title")}
                  ${heading("Stable", "stable")}
                  ${heading("Candidate", "candidate")}
                  ${heading("Beta", "beta")}
                  ${heading("Edge", "edge")}
                  ${heading("Upstream", "upstream")}
                  ${heading("Status", "status")}
                </tr></thead>
                <tbody id="rows"></tbody>
              </table>
            </div>
            <div class="table-footer">
              <span id="result-count"></span>
              <span>Generated <time datetime="${escapeHtml(data.generatedAt)}">${escapeHtml(new Date(data.generatedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London" }))}</time></span>
            </div>
          </div>
        </div>
      </section>
    </main>

    <footer class="p-strip is-shallow page-footer">
      <div class="row"><div class="col-12"><p>Personal maintenance dashboard. Not affiliated with Canonical or Snapcraft.io. Data sourced from public APIs.</p></div></div>
    </footer>
  `;

  const rows = document.querySelector<HTMLTableSectionElement>("#rows")!;
  const resultCount = document.querySelector<HTMLSpanElement>("#result-count")!;
  const searchInput = document.querySelector<HTMLInputElement>("#search")!;

  const drawRows = (): void => {
    const filtered = snaps
      .filter((snap) => activeStatus === "all" || snap.status === activeStatus)
      .filter((snap) => `${snap.title} ${snap.name}`.toLowerCase().includes(search))
      .sort((a, b) => sortSnaps(a, b, sortKey) * sortDirection);

    rows.innerHTML = filtered.length
      ? filtered.map(rowHtml).join("")
      : '<tr><td class="no-results" colspan="7">No snaps match this view.</td></tr>';
    resultCount.textContent = `Showing ${filtered.length} of ${snaps.length} snaps`;

    document.querySelectorAll<HTMLButtonElement>("[data-sort]").forEach((button) => {
      const active = button.dataset.sort === sortKey;
      button.classList.toggle("is-sorted", active);
      button.closest("th")?.setAttribute(
        "aria-sort",
        active ? (sortDirection === 1 ? "ascending" : "descending") : "none",
      );
      button.querySelector(".sort-arrow")!.textContent = active ? (sortDirection === 1 ? "▲" : "▼") : "";
    });
  };

  const setStatus = (status: SnapStatus | "all"): void => {
    activeStatus = status;
    document.querySelectorAll("[data-filter-status]").forEach((item) => {
      item.classList.toggle("is-selected", (item as HTMLElement).dataset.filterStatus === status);
    });
    document.querySelectorAll("[data-nav-status]").forEach((item) => {
      item.parentElement?.classList.toggle("is-selected", (item as HTMLElement).dataset.navStatus === status);
    });
    drawRows();
  };

  document.querySelector<HTMLFormElement>("#search-form")!.addEventListener("submit", (event) => {
    event.preventDefault();
    search = searchInput.value.trim().toLowerCase();
    drawRows();
  });
  searchInput.addEventListener("input", () => {
    search = searchInput.value.trim().toLowerCase();
    drawRows();
  });
  document.querySelector<HTMLFormElement>("#search-form")!.addEventListener("reset", () => {
    window.setTimeout(() => {
      search = "";
      drawRows();
    });
  });

  document.querySelectorAll<HTMLElement>("[data-status]").forEach((button) => {
    button.addEventListener("click", () => {
      setStatus(button.dataset.status as SnapStatus | "all");
      document.querySelector("#snap-table")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-filter-status]").forEach((button) => {
    button.addEventListener("click", () => setStatus(button.dataset.filterStatus as SnapStatus | "all"));
  });
  document.querySelectorAll<HTMLAnchorElement>("[data-nav-status]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      setStatus(link.dataset.navStatus as SnapStatus | "all");
      document.querySelector("#snap-table")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-sort]").forEach((button) => {
    button.addEventListener("click", () => {
      const next = button.dataset.sort as SortKey;
      if (sortKey === next) sortDirection = sortDirection === 1 ? -1 : 1;
      else {
        sortKey = next;
        sortDirection = 1;
      }
      drawRows();
    });
  });
  document.querySelectorAll<HTMLButtonElement>(".js-menu-button").forEach((button) => {
    button.addEventListener("click", () => document.querySelector("#navigation")?.classList.toggle("has-menu-open"));
  });

  drawRows();
  document.querySelector("main")?.setAttribute("aria-busy", "false");
}

function navItem(label: string, status: SnapStatus | "all", selected = false): string {
  return `<li class="p-navigation__item${selected ? " is-selected" : ""}"><a class="p-navigation__link" href="#snap-table" data-nav-status="${status}">${escapeHtml(label)}</a></li>`;
}

function filterButton(label: string, status: SnapStatus | "all", count: number, selected = false): string {
  return `<button type="button" class="p-button is-small${selected ? " is-selected" : ""}" data-filter-status="${status}">${escapeHtml(label)} <span class="filter-count">${count}</span></button>`;
}

function heading(label: string, key: SortKey): string {
  return `<th scope="col" aria-sort="none"><button class="sort-button" data-sort="${key}">${escapeHtml(label)} <span class="sort-arrow" aria-hidden="true"></span></button></th>`;
}

function channelCell(channel: ChannelInfo, headingLabel: string): string {
  if (!channel.version) return `<td data-heading="${headingLabel}"><span class="u-text--muted">—</span></td>`;
  const variants = channel.versions.length - 1;
  const title = variants > 0 ? ` title="Also: ${escapeHtml(channel.versions.slice(1).join(", "))}"` : "";
  return `<td data-heading="${headingLabel}"><code>${escapeHtml(channel.version)}</code>${
    variants > 0 ? `<span class="version-variant"${title}>+${variants}</span>` : ""
  }</td>`;
}

function sortSnaps(a: EnrichedSnap, b: EnrichedSnap, key: SortKey): number {
  if (key === "title") return a.title.localeCompare(b.title);
  if (key === "status") return statusOrder[a.status] - statusOrder[b.status] || a.title.localeCompare(b.title);
  if (key === "upstream") {
    const left = a.upstream.version;
    const right = b.upstream.version;
    if (!left || !right) return left ? -1 : right ? 1 : a.title.localeCompare(b.title);
    return compareVersions(left, right);
  }
  const left = a.channels[key]?.version;
  const right = b.channels[key]?.version;
  if (!left || !right) return left ? -1 : right ? 1 : a.title.localeCompare(b.title);
  return compareVersions(left, right);
}

function rowHtml(snap: EnrichedSnap): string {
  const upstream = snap.upstream.version
    ? snap.upstream.url
      ? `<a href="${safeUrl(snap.upstream.url)}" target="_blank" rel="noreferrer"><code>${escapeHtml(snap.upstream.version)}</code></a>`
      : `<code>${escapeHtml(snap.upstream.version)}</code>`
    : snap.tracking?.url
      ? `<a href="${safeUrl(snap.tracking.url)}" target="_blank" rel="noreferrer" title="${escapeHtml(snap.tracking.note ?? "Source details")}">${snap.tracking.mode === "static" ? "Story" : "Source"} ↗</a>`
      : `<span class="u-text--muted" title="${escapeHtml(snap.upstream.error ?? "No upstream version")}">—</span>`;
  const statusTitle = snap.tracking?.note ? ` title="${escapeHtml(snap.tracking.note)}"` : "";
  return `<tr>
    <th scope="row" data-heading="Application" class="app-cell"><a href="${safeUrl(snap.storeUrl)}" target="_blank" rel="noreferrer">${escapeHtml(snap.title)}</a><small>${escapeHtml(snap.name)}</small></th>
    ${channelCell(snap.channels.stable, "Stable")}
    ${channelCell(snap.channels.candidate, "Candidate")}
    ${channelCell(snap.channels.beta, "Beta")}
    ${channelCell(snap.channels.edge, "Edge")}
    <td data-heading="Upstream">${upstream}</td>
    <td data-heading="Status"><span class="${chipClasses[snap.status]}"${statusTitle}>${statusLabels[snap.status]}</span></td>
  </tr>`;
}

load().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  app!.innerHTML = `<main class="p-strip"><div class="u-fixed-width"><div class="p-notification--negative"><div class="p-notification__content"><h1 class="p-notification__title">Could not load snap status</h1><p class="p-notification__message">${escapeHtml(message)}</p></div></div><p><a class="p-button" href="/">Try again</a></p></div></main>`;
});
