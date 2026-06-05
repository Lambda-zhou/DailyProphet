"""Filter URLs to supported sites + optional Brave Search API."""
import os
from urllib.parse import urlparse

import httpx

from .sites import domain_from_url


def filter_urls(urls: list[str], supported_domains: set[str]) -> list[dict]:
    """Filter a list of URLs to only those on supported paywall sites."""
    results = []
    seen = set()
    for url in urls:
        if url in seen:
            continue
        domain = domain_from_url(url)
        if domain in supported_domains:
            seen.add(url)
            results.append({"url": url, "domain": domain, "supported": True})
    return results


def search_brave(
    query: str,
    supported_domains: set[str],
    limit: int = 20,
    site_filter: str | None = None,
) -> list[dict]:
    """Search via Brave Search API. Requires BRAVE_API_KEY env var."""
    api_key = os.environ.get("BRAVE_API_KEY", "")
    if not api_key:
        return []
    search_query = f"site:{site_filter} {query}" if site_filter else query
    results: list[dict] = []
    try:
        resp = httpx.get(
            "https://api.search.brave.com/res/v1/web/search",
            params={"q": search_query, "count": min(limit * 2, 20)},
            headers={"X-Subscription-Token": api_key, "Accept": "application/json"},
            timeout=15.0,
        )
        if resp.status_code == 200:
            data = resp.json()
            for item in data.get("web", {}).get("results", []):
                url = item.get("url", "")
                domain = domain_from_url(url)
                if site_filter:
                    if domain == site_filter or domain.endswith(f".{site_filter}"):
                        results.append(_format(item, domain))
                elif domain in supported_domains:
                    results.append(_format(item, domain))
                if len(results) >= limit:
                    break
    except Exception:
        pass
    return results[:limit]


def search_sites(
    query: str,
    supported_domains: set[str],
    limit: int = 20,
    site_filter: str | None = None,
) -> list[dict]:
    """Search supported sites. Uses Brave API if available, otherwise returns empty."""
    return search_brave(query, supported_domains, limit, site_filter)


def _format(item: dict, domain: str) -> dict:
    return {
        "title": item.get("title", ""),
        "url": item.get("url", ""),
        "domain": domain,
        "snippet": item.get("description", ""),
    }
