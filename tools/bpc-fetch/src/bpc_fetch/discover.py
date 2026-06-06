"""Discover recent articles from a supported site via RSS, sitemap, or homepage."""
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import urljoin, urlparse
from xml.etree import ElementTree as ET

import httpx

from .strategy import UA_GOOGLEBOT, UA_NORMAL, TIMEOUT

RSS_PATHS = ["/feed", "/rss", "/rss.xml", "/atom.xml", "/feeds/all", "/feed/rss",
             "/index.xml", "/rss/news", "/feed.xml"]

SITEMAP_PATHS = ["/sitemap.xml", "/sitemap-index.xml", "/sitemap_index.xml",
                 "/news-sitemap.xml", "/sitemap-news.xml"]


def parse_since(since: str) -> datetime:
    """Parse --since value: 'today', 'Nd', or 'YYYY-MM-DD'."""
    now = datetime.now(timezone.utc)
    if since == "today":
        return now.replace(hour=0, minute=0, second=0, microsecond=0)
    if re.match(r"^\d+d$", since):
        days = int(since[:-1])
        return now - timedelta(days=days)
    try:
        return datetime.strptime(since, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        return now - timedelta(days=7)


async def discover(domain: str, since: str = "7d", limit: int = 20) -> dict:
    """Discover recent articles from domain. Returns {ok, domain, count, articles}."""
    since_dt = parse_since(since)
    articles: list[dict] = []
    source = ""

    async with httpx.AsyncClient(follow_redirects=True, timeout=TIMEOUT) as client:
        rss_articles = await _try_rss(client, domain, since_dt)
        if rss_articles:
            articles = rss_articles
            source = "rss"
        else:
            sitemap_articles = await _try_sitemap(client, domain, since_dt)
            if sitemap_articles:
                articles = sitemap_articles
                source = "sitemap"
            else:
                homepage_articles = await _try_homepage(client, domain, since_dt)
                if homepage_articles:
                    articles = homepage_articles
                    source = "homepage"

    # Browser fallback: if HTTP methods all failed, use Playwright
    if not articles:
        browser_articles = await _try_browser_homepage(domain, since_dt)
        if browser_articles:
            articles = browser_articles
            source = "browser"

    articles = _filter_and_dedupe_articles(articles)
    articles = articles[:limit]
    return {
        "ok": True,
        "domain": domain,
        "source": source or "none",
        "count": len(articles),
        "articles": articles,
    }


async def _try_rss(client: httpx.AsyncClient, domain: str, since: datetime) -> list[dict]:
    """Try common RSS feed paths."""
    base = f"https://www.{domain}"
    for path in RSS_PATHS:
        try:
            resp = await client.get(base + path, headers={"User-Agent": UA_NORMAL}, timeout=10)
            if resp.status_code == 200 and ("<rss" in resp.text[:500] or "<feed" in resp.text[:500] or "<atom" in resp.text[:500]):
                return _parse_rss(resp.text, since, domain)
        except Exception:
            continue
    return []


def _parse_rss(xml_text: str, since: datetime, domain: str) -> list[dict]:
    """Parse RSS/Atom XML into article list."""
    articles = []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []

    ns = {"atom": "http://www.w3.org/2005/Atom", "dc": "http://purl.org/dc/elements/1.1/"}

    # RSS 2.0
    for item in root.iter("item"):
        title = _text(item, "title")
        link = _text(item, "link")
        excerpt = _text(item, "description") or _text(item, "summary") or _text(item, "content:encoded", ns)
        pub_date = _text(item, "pubDate") or _text(item, "dc:date", ns)
        date = _parse_date(pub_date)
        if date and date < since:
            continue
        if link and title and _is_article_url(link):
            articles.append({
                "title": title,
                "url": link,
                "date": str(date.date()) if date else "",
                "domain": domain,
                "excerpt": _clean_excerpt(excerpt),
            })

    # Atom
    for entry in root.iter("{http://www.w3.org/2005/Atom}entry"):
        title = _text(entry, "{http://www.w3.org/2005/Atom}title")
        link_el = entry.find("{http://www.w3.org/2005/Atom}link")
        link = link_el.get("href", "") if link_el is not None else ""
        excerpt = (
            _text(entry, "{http://www.w3.org/2005/Atom}summary") or
            _text(entry, "{http://www.w3.org/2005/Atom}content")
        )
        updated = _text(entry, "{http://www.w3.org/2005/Atom}updated") or _text(entry, "{http://www.w3.org/2005/Atom}published")
        date = _parse_date(updated)
        if date and date < since:
            continue
        if link and title and _is_article_url(link):
            articles.append({
                "title": title,
                "url": link,
                "date": str(date.date()) if date else "",
                "domain": domain,
                "excerpt": _clean_excerpt(excerpt),
            })

    return articles


async def _try_sitemap(client: httpx.AsyncClient, domain: str, since: datetime) -> list[dict]:
    """Try sitemap.xml for recent URLs."""
    base = f"https://www.{domain}"
    for path in SITEMAP_PATHS:
        try:
            resp = await client.get(base + path, headers={"User-Agent": UA_GOOGLEBOT}, timeout=10)
            if resp.status_code == 200 and "<urlset" in resp.text[:500]:
                return _parse_sitemap(resp.text, since, domain)
            if resp.status_code == 200 and "<sitemapindex" in resp.text[:500]:
                return await _parse_sitemap_index(client, resp.text, since, domain)
        except Exception:
            continue
    return []


def _parse_sitemap(xml_text: str, since: datetime, domain: str) -> list[dict]:
    """Parse sitemap XML."""
    articles = []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []
    ns = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    for url_el in root.findall(".//sm:url", ns):
        loc = _text(url_el, "sm:loc", ns)
        lastmod = _text(url_el, "sm:lastmod", ns)
        date = _parse_date(lastmod)
        if date and date < since:
            continue
        if loc and _is_article_url(loc):
            articles.append({"title": "", "url": loc, "date": str(date.date()) if date else "", "domain": domain})
    return articles


async def _parse_sitemap_index(client: httpx.AsyncClient, xml_text: str, since: datetime, domain: str) -> list[dict]:
    """Parse sitemap index, fetch most recent sub-sitemap."""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []
    ns = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    sitemaps = root.findall(".//sm:sitemap", ns)
    if not sitemaps:
        return []
    last_sm = sitemaps[-1]
    loc = _text(last_sm, "sm:loc", ns)
    if not loc:
        return []
    try:
        resp = await client.get(loc, headers={"User-Agent": UA_GOOGLEBOT}, timeout=10)
        if resp.status_code == 200:
            return _parse_sitemap(resp.text, since, domain)
    except Exception:
        pass
    return []


async def _try_homepage(client: httpx.AsyncClient, domain: str, since: datetime) -> list[dict]:
    """Extract article links from homepage."""
    base = f"https://www.{domain}"
    try:
        resp = await client.get(base, headers={"User-Agent": UA_NORMAL}, timeout=15)
        if resp.status_code != 200:
            return []
    except Exception:
        return []

    articles = []
    seen = set()
    for m in re.finditer(r'<a[^>]+href=["\']([^"\']+)["\'][^>]*>([^<]{5,120})</a>', resp.text):
        href = m.group(1)
        title = m.group(2).strip()
        url = urljoin(base, href)
        if url in seen:
            continue
        parsed = urlparse(url)
        if parsed.hostname and domain in parsed.hostname and _is_article_url(url):
            seen.add(url)
            articles.append({"title": title, "url": url, "date": "", "domain": domain})
    return articles


def _filter_and_dedupe_articles(articles: list[dict]) -> list[dict]:
    """Apply final URL screening + de-duplication across all discovery modes."""
    out: list[dict] = []
    seen: set[str] = set()
    for article in articles:
        url = str(article.get("url", "")).strip()
        if not url or not _is_article_url(url):
            continue
        if url in seen:
            continue
        seen.add(url)
        out.append(article)
    return out


def _is_article_url(url: str) -> bool:
    """Heuristic: URL looks like an article (has date pattern or article path)."""
    parsed = urlparse(url)
    host = parsed.hostname or ""
    path = parsed.path

    # FT's homepage exposes many section/navigation URLs such as
    # /technology-sector, /business-education, /world/us/politics.  The
    # generic heuristic below used to treat those as articles, which polluted
    # GitHub Actions reports when RSS discovery was unavailable and we fell
    # back to homepage scraping.  Real Financial Times article pages use the
    # stable /content/<uuid> shape, so keep FT strict.
    if host == "ft.com" or host.endswith(".ft.com"):
        return bool(re.fullmatch(r"/content/[0-9a-fA-F-]{36}/?", path))

    if re.search(r"/\d{4}/\d{2}/", path):
        return True
    if any(seg in path for seg in ["/article", "/story", "/news/", "/opinion/", "/world/", "/politics/", "/tech"]):
        return True
    if path.count("/") >= 3 and len(path) > 20:
        return True
    return False


def _text(el, tag: str, ns: dict | None = None) -> str:
    child = el.find(tag, ns) if ns else el.find(tag)
    return child.text.strip() if child is not None and child.text else ""


def _parse_date(date_str: str | None) -> datetime | None:
    if not date_str:
        return None
    for fmt in ["%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d",
                "%a, %d %b %Y %H:%M:%S %z", "%a, %d %b %Y %H:%M:%S %Z"]:
        try:
            dt = datetime.strptime(date_str.strip(), fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except ValueError:
            continue
    return None


def _clean_excerpt(text: str | None) -> str:
    if not text:
        return ""
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:500]


async def _try_browser_homepage(domain: str, since: datetime) -> list[dict]:
    """Use Playwright to load homepage and extract article links (Cloudflare bypass)."""
    try:
        from .browser import BrowserPool
    except ImportError:
        return []

    articles = []
    try:
        pool = BrowserPool(max_contexts=1)
        await pool.start()
        async with pool.page() as page:
            await page.goto(f"https://www.{domain}/", wait_until="domcontentloaded", timeout=20000)
            await page.wait_for_timeout(3000)

            links = await page.evaluate("""(domain) => {
                const articles = [];
                const seen = new Set();
                document.querySelectorAll('a[href]').forEach(a => {
                    const href = a.href;
                    if (!href || seen.has(href)) return;
                    const path = new URL(href).pathname;
                    const isArticle = path.match(/\\/\\d{4}\\/\\d{2}\\//) ||
                        ['/article', '/story', '/news/', '/opinion/', '/world/', '/politics/', '/tech', '/science', '/business', '/finance'].some(s => path.includes(s));
                    if (isArticle && href.includes(domain)) {
                        const title = a.textContent.trim().substring(0, 200);
                        if (title.length > 10) {
                            seen.add(href);
                            articles.push({url: href, title: title});
                        }
                    }
                });
                return articles;
            }""", domain)

            for item in links:
                url = item.get("url", "")
                title = item.get("title", "")
                if not _is_article_url(url):
                    continue
                date_match = re.search(r"/(\d{4})/(\d{2})/(\d{2})/", url)
                date_str = ""
                if date_match:
                    try:
                        dt = datetime(int(date_match.group(1)), int(date_match.group(2)), int(date_match.group(3)), tzinfo=timezone.utc)
                        if dt < since:
                            continue
                        date_str = str(dt.date())
                    except ValueError:
                        pass
                articles.append({"title": title, "url": url, "date": date_str, "domain": domain})

        await pool.stop()
    except Exception:
        pass
    return articles
