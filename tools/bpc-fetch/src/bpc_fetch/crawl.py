"""Cross-site crawl: search + time filter + batch fetch."""
import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import httpx

from .discover import discover, parse_since
from .extract import extract_article, article_to_markdown, download_images
from .history import get_fetched, mark_fetched
from .search import search_sites
from .sites import get_sites_map, domain_from_url, SITES_JS_DEFAULT
from .strategy import fetch_with_retries


async def crawl(
    query: str,
    sites_filter: list[str] | None = None,
    since: str = "7d",
    limit: int = 20,
    out_dir: Path = Path("./articles"),
    no_images: bool = False,
    concurrency: int = 3,
    progress: bool = False,
    incremental: bool = False,
    sites_js: Path | None = None,
) -> dict:
    """Search + discover + time filter + batch fetch.

    1. If sites_filter given: discover from those sites, filter by since
    2. Else: search query across all supported sites
    3. Fetch all found articles
    4. Save as markdown
    """
    sites_map = get_sites_map(sites_js or SITES_JS_DEFAULT)
    supported = set(sites_map.keys())
    since_dt = parse_since(since)
    urls_to_fetch: list[dict] = []

    # Phase 1: Discover/Search
    if sites_filter:
        for domain in sites_filter:
            result = await discover(domain, since=since, limit=limit)
            if result.get("ok"):
                urls_to_fetch.extend(result.get("articles", []))
    else:
        results = search_sites(query, supported, limit=limit * 2)
        urls_to_fetch = results

    # Deduplicate
    seen = set()
    unique: list[dict] = []
    for item in urls_to_fetch:
        url = item.get("url", "")
        if url and url not in seen:
            seen.add(url)
            unique.append(item)
    urls_to_fetch = unique[:limit]

    if not urls_to_fetch:
        return {"ok": True, "query": query, "total": 0, "success": 0, "failed": 0, "results": []}

    # Phase 2: Batch fetch
    out_dir.mkdir(parents=True, exist_ok=True)
    sem = asyncio.Semaphore(concurrency)
    results = []
    total = len(urls_to_fetch)

    async with httpx.AsyncClient(follow_redirects=True, timeout=30.0) as client:
        async def _fetch_one(item: dict, idx: int) -> dict:
            async with sem:
                url = item.get("url", "")
                domain = domain_from_url(url)
                strategy = sites_map.get(domain)

                if incremental:
                    record = get_fetched(url)
                    if record and record.get("path") and Path(record["path"]).exists():
                        return {
                            "ok": True,
                            "skipped": True,
                            "reason": "already_fetched",
                            "url": url,
                            "title": record.get("title", ""),
                            "path": record["path"],
                        }

                if progress:
                    _emit_progress(idx + 1, total, url)

                try:
                    html, status, dom_result = await fetch_with_retries(url, strategy, client)
                    if status != 200:
                        return {"ok": False, "url": url, "error": f"HTTP {status}"}
                    article = extract_article(html, url, dom_result=dom_result)
                    if not article["text"]:
                        return {"ok": False, "url": url, "error": "extraction_failed"}
                    slug = _slugify(article["title"] or domain)
                    article_dir = out_dir / slug
                    if not no_images and article["images"]:
                        await download_images(article["images"], article_dir / "images", client=client)
                    md = article_to_markdown(article, images_dir="images")
                    md_path = article_dir / f"{slug}.md"
                    md_path.parent.mkdir(parents=True, exist_ok=True)
                    md_path.write_text(md, encoding="utf-8")
                    mark_fetched(url, domain, article["title"], str(md_path))
                    return {"ok": True, "url": url, "title": article["title"], "path": str(md_path)}
                except Exception as e:
                    return {"ok": False, "url": url, "error": str(e)}

        tasks = [_fetch_one(item, i) for i, item in enumerate(urls_to_fetch)]
        results = await asyncio.gather(*tasks)

    # Phase 3: Manifest
    results = list(results)
    success = sum(1 for r in results if r.get("ok"))
    manifest = {
        "query": query,
        "since": since,
        "total": total,
        "success": success,
        "failed": total - success,
        "articles": [r for r in results if r.get("ok")],
    }
    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    return {
        "ok": True,
        "query": query,
        "total": total,
        "success": success,
        "failed": total - success,
        "manifest_path": str(manifest_path),
        "results": results,
    }


def _emit_progress(current: int, total: int, url: str):
    msg = json.dumps({"progress": current, "total": total, "current": url}, ensure_ascii=False)
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


def _slugify(text: str) -> str:
    import re
    text = re.sub(r'[^\w\s-]', '', text.lower())
    text = re.sub(r'[\s_]+', '-', text)
    return text[:80].strip('-') or "article"
