from __future__ import annotations

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import tempfile
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

RISKS = ("stable", "candidate", "beta", "edge")
USER_AGENT = "snap-status/0.1 (+https://github.com/popey/snap-status)"


def _natural_key(value: str) -> list[tuple[int, Any]]:
    tokens = re.findall(r"\d+|[a-z]+", value.lower().lstrip("v"))
    return [(1, int(token)) if token.isdigit() else (0, token) for token in tokens]


def collapse_channels(channel_map: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    grouped: dict[str, list[str]] = {risk: [] for risk in RISKS}
    for entry in channel_map:
        channel = entry.get("channel") or {}
        risk = channel.get("risk")
        track = channel.get("track") or str(channel.get("name", "")).split("/", 1)[0]
        version = entry.get("version")
        if risk in grouped and track == "latest" and version:
            grouped[risk].append(str(version))

    result: dict[str, dict[str, Any]] = {}
    for risk, values in grouped.items():
        if not values:
            result[risk] = {"version": None, "versions": []}
            continue
        counts = Counter(values)
        primary = max(counts, key=lambda value: (counts[value], _natural_key(value)))
        variants = [primary] + sorted(
            (value for value in counts if value != primary), key=_natural_key, reverse=True
        )
        result[risk] = {"version": primary, "versions": variants}
    return result


def merge_inventory(configured: list[dict[str, Any]], discovered: list[str]) -> list[dict[str, Any]]:
    by_name = {entry["name"]: dict(entry) for entry in configured}
    for name in discovered:
        by_name.setdefault(name, {"name": name})
    return [by_name[name] for name in sorted(by_name)]


def tracking_for_entry(entry: dict[str, Any]) -> dict[str, str]:
    tracking = dict(entry.get("tracking") or {"mode": "automatic"})
    for key, value in tracking.items():
        if not isinstance(key, str) or not isinstance(value, str):
            raise ValueError(f"Tracking metadata {key!r} for {entry['name']} must be a string")
    if tracking.get("mode") not in {"automatic", "manual", "static"}:
        raise ValueError(f"Unsupported tracking mode for {entry['name']}: {tracking.get('mode')}")
    return tracking


def parse_upstream_payload(provider: str, payload: dict[str, Any]) -> str:
    if provider in {"github", "codeberg"}:
        value = payload.get("tag_name") or payload.get("name")
    elif provider == "npm":
        value = payload.get("version")
    else:
        raise ValueError(f"Unsupported upstream provider: {provider}")
    if not value:
        raise ValueError(f"No version in {provider} response")
    value = str(value)
    if not re.search(r"\d", value):
        raise ValueError(f"Non-version tag in {provider} response: {value}")
    return value


def request_json(url: str, headers: dict[str, str] | None = None) -> Any:
    merged = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if headers:
        merged.update(headers)
    with urlopen(Request(url, headers=merged), timeout=30) as response:
        return json.load(response)


def discover_store_snaps(publisher: str) -> list[str]:
    payload = request_json(
        f"https://api.snapcraft.io/v2/snaps/find?publisher={quote(publisher)}",
        {"Snap-Device-Series": "16"},
    )
    return sorted(item["name"] for item in payload.get("results", []))


def fetch_store_snap(name: str) -> dict[str, Any]:
    empty = {risk: {"version": None, "versions": []} for risk in RISKS}
    try:
        payload = request_json(
            f"https://api.snapcraft.io/v2/snaps/info/{quote(name)}",
            {"Snap-Device-Series": "16"},
        )
    except HTTPError as error:
        if error.code == 404:
            return {
                "title": name,
                "storeUrl": f"https://snapcraft.io/{name}",
                "channels": empty,
                "storeError": "Not currently published",
            }
        raise
    snap = payload.get("snap") or {}
    return {
        "title": snap.get("title") or name,
        "storeUrl": snap.get("store-url") or f"https://snapcraft.io/{name}",
        "channels": collapse_channels(payload.get("channel-map") or []),
        "storeError": None,
    }


def fetch_upstream(config: dict[str, Any] | None) -> dict[str, Any]:
    if not config:
        return {"version": None, "url": None, "error": "Upstream not configured"}
    provider = config["provider"]
    token = os.environ.get("GITHUB_TOKEN")
    try:
        if provider == "github":
            repo = config["repo"]
            headers = {"Accept": "application/vnd.github+json"}
            if token:
                headers["Authorization"] = f"Bearer {token}"
            try:
                payload = request_json(f"https://api.github.com/repos/{repo}/releases/latest", headers)
            except HTTPError as error:
                if error.code != 404:
                    raise
                tags = request_json(f"https://api.github.com/repos/{repo}/tags?per_page=1", headers)
                if not tags:
                    raise ValueError("No releases or tags found")
                payload = {"tag_name": tags[0]["name"]}
            return {
                "version": parse_upstream_payload(provider, payload),
                "url": f"https://github.com/{repo}/releases",
                "error": None,
            }
        if provider == "codeberg":
            repo = config["repo"]
            payload = request_json(f"https://codeberg.org/api/v1/repos/{repo}/releases/latest")
            return {
                "version": parse_upstream_payload(provider, payload),
                "url": f"https://codeberg.org/{repo}/releases",
                "error": None,
            }
        if provider == "npm":
            package = config["package"]
            payload = request_json(f"https://registry.npmjs.org/{quote(package, safe='')}/latest")
            return {
                "version": parse_upstream_payload(provider, payload),
                "url": f"https://www.npmjs.com/package/{package}",
                "error": None,
            }
        raise ValueError(f"Unsupported provider: {provider}")
    except Exception as error:  # each snap should fail independently
        return {"version": None, "url": None, "error": str(error)}


def collect_snap(entry: dict[str, Any]) -> dict[str, Any]:
    name = entry["name"]
    store = fetch_store_snap(name)
    tracking = tracking_for_entry(entry)
    if tracking["mode"] == "automatic":
        upstream = fetch_upstream(entry.get("upstream"))
    else:
        upstream = {"version": None, "url": tracking.get("url"), "error": None}
    result = {
        "name": name,
        "title": entry.get("title") or store["title"],
        "storeUrl": store["storeUrl"],
        "channels": store["channels"],
        "storeError": store["storeError"],
        "upstream": upstream,
    }
    if tracking["mode"] != "automatic":
        result["tracking"] = tracking
    return result


def collect(config_path: Path) -> dict[str, Any]:
    config = json.loads(config_path.read_text())
    discovered = discover_store_snaps(config["publisher"])
    inventory = merge_inventory(config["snaps"], discovered)
    snaps: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = {pool.submit(collect_snap, entry): entry for entry in inventory}
        for future in as_completed(futures):
            entry = futures[future]
            name = entry["name"]
            try:
                snaps.append(future.result())
            except Exception as error:
                tracking = tracking_for_entry(entry)
                snaps.append({
                    "name": name,
                    "title": name,
                    "storeUrl": f"https://snapcraft.io/{name}",
                    "channels": {risk: {"version": None, "versions": []} for risk in RISKS},
                    "storeError": str(error),
                    "upstream": {
                        "version": None,
                        "url": tracking.get("url") if tracking["mode"] != "automatic" else None,
                        "error": "Collection failed" if tracking["mode"] == "automatic" else None,
                    },
                    "tracking": tracking,
                })
    snaps.sort(key=lambda item: item["title"].casefold())
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "publisher": config["publisher"],
        "count": len(snaps),
        "snaps": snaps,
    }


def write_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False) as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")
        temp_path = Path(handle.name)
    temp_path.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Collect Snap Store and upstream versions")
    parser.add_argument("--config", type=Path, default=Path("config/snaps.json"))
    parser.add_argument("--output", type=Path, default=Path("public/data.json"))
    args = parser.parse_args()
    payload = collect(args.config)
    write_atomic(args.output, payload)
    errors = sum(
        bool(item["storeError"] or item["upstream"]["error"])
        for item in payload["snaps"]
    )
    print(f"Collected {payload['count']} snaps ({errors} with incomplete data) -> {args.output}")


if __name__ == "__main__":
    main()
