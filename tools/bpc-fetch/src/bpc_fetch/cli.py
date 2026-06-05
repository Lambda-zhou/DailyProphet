"""CLI entrypoint for bpc-fetch."""
import argparse
import asyncio
import json
import sys
from pathlib import Path

from .sites import get_sites_map, domain_from_url, SITES_JS_DEFAULT


def main():
    _configure_stdio()
    parser = argparse.ArgumentParser(prog="bpc-fetch", description="Bypass paywall: search and fetch articles")
    parser.add_argument("--compact", action="store_true", help="Minimal JSON output")
    parser.add_argument("--sites-js", type=Path, default=None, help="Path to BPC sites.js")
    sub = parser.add_subparsers(dest="command")
    # Add --compact to all subcommands for flexible positioning
    _common = argparse.ArgumentParser(add_help=False)
    _common.add_argument("--compact", action="store_true")
    _common.add_argument("--sites-js", type=Path, default=None)

    # doctor
    sub.add_parser("doctor", help="Verify setup and data files", parents=[_common])

    # sites
    p_sites = sub.add_parser("sites", help="List supported sites", parents=[_common])
    p_sites.add_argument("--filter", type=str, default="", help="Filter by domain substring")
    p_sites.add_argument("--strategy", type=str, default="", help="Filter by strategy type")
    p_sites.add_argument("--limit", type=int, default=50)

    # search
    p_search = sub.add_parser("search", help="Search or filter URLs to supported sites", parents=[_common])
    p_search.add_argument("query", nargs="*", help="Search query (Brave API) or URLs to filter")
    p_search.add_argument("--urls", nargs="*", help="URLs to filter against supported sites")
    p_search.add_argument("--site", type=str, default=None, help="Limit to specific domain")
    p_search.add_argument("--limit", type=int, default=20)

    # fetch
    p_fetch = sub.add_parser("fetch", help="Fetch article as markdown", parents=[_common])
    p_fetch.add_argument("url", help="Article URL")
    p_fetch.add_argument("--out-dir", type=Path, default=Path("."))
    p_fetch.add_argument("--no-images", action="store_true")
    p_fetch.add_argument("--incremental", action="store_true", help="Skip if already fetched")

    # batch
    p_batch = sub.add_parser("batch", help="Batch fetch multiple URLs", parents=[_common])
    p_batch.add_argument("urls", nargs="*", help="URLs to fetch")
    p_batch.add_argument("--file", type=Path, default=None, help="File with URLs (one per line)")
    p_batch.add_argument("--out-dir", type=Path, default=Path("./articles"))
    p_batch.add_argument("--no-images", action="store_true")
    p_batch.add_argument("--concurrency", type=int, default=5)
    p_batch.add_argument("--incremental", action="store_true", help="Skip already fetched URLs")

    # install-browser
    sub.add_parser("install-browser", help="Install Playwright Chromium", parents=[_common])

    # discover
    p_disc = sub.add_parser("discover", help="Discover recent articles from a site", parents=[_common])
    p_disc.add_argument("domain", help="Site domain (e.g. ft.com)")
    p_disc.add_argument("--since", type=str, default="7d", help="Time filter: today, Nd, YYYY-MM-DD")
    p_disc.add_argument("--limit", type=int, default=20)

    # crawl
    p_crawl = sub.add_parser("crawl", help="Search + time filter + batch fetch", parents=[_common])
    p_crawl.add_argument("query", nargs="+", help="Search query")
    p_crawl.add_argument("--sites", type=str, default=None, help="Comma-separated domains to crawl")
    p_crawl.add_argument("--since", type=str, default="7d", help="Time filter: today, Nd, YYYY-MM-DD")
    p_crawl.add_argument("--limit", type=int, default=20)
    p_crawl.add_argument("--out-dir", type=Path, default=Path("./articles"))
    p_crawl.add_argument("--no-images", action="store_true")
    p_crawl.add_argument("--concurrency", type=int, default=3)
    p_crawl.add_argument("--progress", action="store_true", help="Emit progress to stderr")
    p_crawl.add_argument("--incremental", action="store_true", help="Skip already fetched URLs")

    # history
    p_hist = sub.add_parser("history", help="Show fetch history", parents=[_common])
    p_hist.add_argument("--domain", type=str, default=None)
    p_hist.add_argument("--limit", type=int, default=50)

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(1)

    try:
        result = asyncio.run(_dispatch(args))
        result = _enrich_result(result, args)
        print(json.dumps(result, ensure_ascii=False, indent=None if args.compact else 2))
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as e:
        err = {"ok": False, "error": str(e), "recovery_command": "bpc-fetch doctor --compact"}
        print(json.dumps(err))
        sys.exit(1)


def _configure_stdio():
    """Force UTF-8 stdout/stderr so JSON output survives Windows codepages."""
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        if stream is None or not hasattr(stream, "reconfigure"):
            continue
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def _enrich_result(result: dict, args) -> dict:
    """Add next_command and recovery_command to all results."""
    cmd = args.command
    if not result.get("ok"):
        if "recovery_command" not in result:
            result["recovery_command"] = "bpc-fetch doctor --compact"
        return result

    if cmd == "doctor":
        result["next_command"] = "bpc-fetch sites --limit 10 --compact"
    elif cmd == "sites":
        if result.get("sites"):
            d = result["sites"][0]["domain"]
            result["next_command"] = f"bpc-fetch discover {d} --since 7d --compact"
    elif cmd == "search":
        if result.get("results"):
            urls = " ".join(f'"{r["url"]}"' for r in result["results"][:5])
            result["next_command"] = f"bpc-fetch batch {urls} --out-dir ./articles --compact"
            result["fetchable_count"] = len(result["results"])
    elif cmd == "discover":
        if result.get("articles"):
            urls = " ".join(f'"{a["url"]}"' for a in result["articles"][:10])
            result["next_command"] = f"bpc-fetch batch {urls} --out-dir ./articles --compact"
            result["fetch_command"] = f"bpc-fetch batch {urls} --out-dir ./articles --compact"
    elif cmd == "fetch":
        result["next_command"] = f"bpc-fetch discover {result.get('domain', '')} --since today --compact"
    elif cmd == "crawl":
        result["next_command"] = None
    elif cmd == "batch":
        result["next_command"] = None

    return result


async def _dispatch(args) -> dict:
    if args.command == "doctor":
        return _cmd_doctor(args)
    if args.command == "sites":
        return _cmd_sites(args)
    if args.command == "search":
        return await _cmd_search(args)
    if args.command == "fetch":
        return await _cmd_fetch(args)
    if args.command == "batch":
        return await _cmd_batch(args)
    if args.command == "install-browser":
        return _cmd_install_browser(args)
    if args.command == "discover":
        return await _cmd_discover(args)
    if args.command == "crawl":
        return await _cmd_crawl(args)
    if args.command == "history":
        return _cmd_history(args)
    return {"ok": False, "error": f"unknown command: {args.command}"}


def _cmd_doctor(args) -> dict:
    issues = []
    js_path = args.sites_js or SITES_JS_DEFAULT
    site_count = 0
    if not js_path.exists():
        issues.append(f"sites.js not found at {js_path}")
    else:
        sites = get_sites_map(js_path)
        site_count = len(sites)

    try:
        import trafilatura
        traf_ok = True
    except ImportError:
        traf_ok = False
        issues.append("trafilatura not installed")

    try:
        import httpx
        httpx_ok = True
    except ImportError:
        httpx_ok = False
        issues.append("httpx not installed")

    pw_ok = False
    pw_info = ""
    try:
        from playwright.async_api import async_playwright
        pw_ok = True
        import importlib.metadata
        pw_info = importlib.metadata.version("playwright")
    except (ImportError, Exception):
        issues.append("playwright not installed (run: pip install playwright)")

    chromium_ok = False
    if pw_ok:
        try:
            import subprocess
            r = subprocess.run(
                [sys.executable, "-m", "playwright", "install", "--dry-run", "chromium"],
                capture_output=True, text=True, timeout=10
            )
            chromium_ok = "is already installed" in r.stdout or r.returncode == 0
        except Exception:
            chromium_ok = False

    return {
        "ok": len(issues) == 0,
        "sites_js": str(js_path),
        "sites_js_exists": js_path.exists(),
        "site_count": site_count,
        "trafilatura": traf_ok,
        "httpx": httpx_ok,
        "playwright": pw_ok,
        "playwright_version": pw_info,
        "chromium_installed": chromium_ok,
        "issues": issues,
    }


def _cmd_install_browser(args) -> dict:
    import subprocess
    r = subprocess.run([sys.executable, "-m", "playwright", "install", "chromium"], capture_output=True, text=True, timeout=300)
    if r.returncode == 0:
        return {"ok": True, "message": "Chromium installed", "output": r.stdout.strip()[-200:]}
    return {"ok": False, "error": r.stderr.strip()[-200:], "recovery_command": "pip install playwright && python -m playwright install chromium"}


async def _cmd_discover(args) -> dict:
    from .discover import discover
    result = await discover(args.domain, since=args.since, limit=args.limit)
    return result


async def _cmd_crawl(args) -> dict:
    from .crawl import crawl
    query = " ".join(args.query)
    sites_filter = args.sites.split(",") if args.sites else None
    result = await crawl(
        query=query,
        sites_filter=sites_filter,
        since=args.since,
        limit=args.limit,
        out_dir=args.out_dir,
        no_images=args.no_images,
        concurrency=args.concurrency,
        progress=args.progress,
        incremental=args.incremental,
        sites_js=args.sites_js,
    )
    return result


def _cmd_history(args) -> dict:
    from .history import get_history
    records = get_history(domain=args.domain, limit=args.limit)
    return {"ok": True, "count": len(records), "history": records}


def _cmd_sites(args) -> dict:
    js_path = args.sites_js or SITES_JS_DEFAULT
    sites = get_sites_map(js_path)

    filtered = list(sites.values())
    if args.filter:
        filtered = [s for s in filtered if args.filter.lower() in s.domain.lower() or args.filter.lower() in s.name.lower()]
    if args.strategy:
        filtered = [s for s in filtered if args.strategy.lower() in s.bypass_type().lower()]

    filtered = filtered[:args.limit]
    return {
        "ok": True,
        "total": len(sites),
        "shown": len(filtered),
        "sites": [{"domain": s.domain, "name": s.name, "bypass": s.bypass_type()} for s in filtered],
    }


async def _cmd_search(args) -> dict:
    from .search import search_sites, filter_urls

    js_path = args.sites_js or SITES_JS_DEFAULT
    sites = get_sites_map(js_path)
    supported = set(sites.keys())

    # Mode 1: Filter provided URLs
    if args.urls:
        results = filter_urls(args.urls, supported)
        return {"ok": True, "mode": "filter", "count": len(results), "results": results}

    # Mode 2: Brave Search API
    query = " ".join(args.query) if args.query else ""
    if not query:
        return {"ok": False, "error": "provide --urls to filter or a search query (requires BRAVE_API_KEY)"}

    results = search_sites(query, supported, args.limit, site_filter=args.site)
    if not results:
        return {
            "ok": True,
            "query": query,
            "count": 0,
            "results": [],
            "hint": "No results. Set BRAVE_API_KEY for search, or use --urls to filter agent-provided URLs.",
        }

    return {"ok": True, "query": query, "count": len(results), "results": results}


async def _cmd_fetch(args) -> dict:
    from .extract import extract_article, article_to_markdown, download_images
    from .strategy import fetch_with_retries
    from .history import get_fetched, mark_fetched

    js_path = args.sites_js or SITES_JS_DEFAULT
    sites = get_sites_map(js_path)
    domain = domain_from_url(args.url)
    strategy = sites.get(domain)

    if getattr(args, 'incremental', False):
        record = get_fetched(args.url)
        if record and record.get("path") and Path(record["path"]).exists():
            return {
                "ok": True,
                "skipped": True,
                "reason": "already_fetched",
                "url": args.url,
                "domain": domain,
                "title": record.get("title", ""),
                "path": record["path"],
            }

    html, status, dom_result = await fetch_with_retries(args.url, strategy)
    if status != 200:
        return {"ok": False, "error": f"HTTP {status}", "url": args.url, "domain": domain}

    article = extract_article(html, args.url, dom_result=dom_result)
    if not article["text"]:
        return {"ok": False, "error": "extraction_failed", "url": args.url, "domain": domain}

    out_dir = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    slug = _slugify(article["title"] or domain)
    images_dir = out_dir / slug / "images"

    saved_images: list[Path] = []
    if not args.no_images and article["images"]:
        saved_images = await download_images(article["images"], images_dir)

    md = article_to_markdown(article, images_dir="images")
    md_path = out_dir / slug / f"{slug}.md"
    md_path.parent.mkdir(parents=True, exist_ok=True)
    md_path.write_text(md, encoding="utf-8")

    mark_fetched(args.url, domain, article["title"], str(md_path))

    return {
        "ok": True,
        "url": args.url,
        "domain": domain,
        "strategy": strategy.bypass_type() if strategy else "fallback",
        "title": article["title"],
        "path": str(md_path),
        "images": len(saved_images),
        "text_length": len(article["text"]),
    }


async def _cmd_batch(args) -> dict:
    import asyncio as aio
    from .extract import extract_article, article_to_markdown, download_images
    from .strategy import fetch_with_retries
    from .history import get_fetched, mark_fetched
    import httpx

    urls = list(args.urls)
    if args.file and args.file.exists():
        urls.extend(line.strip() for line in args.file.read_text().splitlines() if line.strip() and not line.startswith("#"))

    if not urls:
        return {"ok": False, "error": "no URLs provided"}

    js_path = args.sites_js or SITES_JS_DEFAULT
    sites = get_sites_map(js_path)
    out_dir = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    sem = aio.Semaphore(args.concurrency)
    results = []

    async with httpx.AsyncClient(follow_redirects=True, timeout=30.0) as client:
        async def _fetch_one(url: str) -> dict:
            async with sem:
                domain = domain_from_url(url)
                strategy = sites.get(domain)
                if getattr(args, 'incremental', False):
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
                try:
                    html, status, dom_result = await fetch_with_retries(url, strategy, client)
                    if status != 200:
                        return {"ok": False, "url": url, "error": f"HTTP {status}"}
                    article = extract_article(html, url, dom_result=dom_result)
                    if not article["text"]:
                        return {"ok": False, "url": url, "error": "extraction_failed"}
                    slug = _slugify(article["title"] or domain)
                    images_dir = out_dir / slug / "images"
                    if not args.no_images and article["images"]:
                        await download_images(article["images"], images_dir, client=client)
                    md = article_to_markdown(article, images_dir="images")
                    md_path = out_dir / slug / f"{slug}.md"
                    md_path.parent.mkdir(parents=True, exist_ok=True)
                    md_path.write_text(md, encoding="utf-8")
                    mark_fetched(url, domain, article["title"], str(md_path))
                    return {"ok": True, "url": url, "title": article["title"], "path": str(md_path)}
                except Exception as e:
                    return {"ok": False, "url": url, "error": str(e)}

        tasks = [_fetch_one(u) for u in urls]
        results = await aio.gather(*tasks)

    success = sum(1 for r in results if r.get("ok"))
    return {
        "ok": True,
        "total": len(urls),
        "success": success,
        "failed": len(urls) - success,
        "results": list(results),
    }


def _slugify(text: str) -> str:
    import re
    text = re.sub(r'[^\w\s-]', '', text.lower())
    text = re.sub(r'[\s_]+', '-', text)
    return text[:80].strip('-') or "article"
