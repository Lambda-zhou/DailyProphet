"""HTTP bypass strategy: apply correct headers per site."""
import random
import httpx
from .sites import SiteStrategy

UA_GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
UA_BINGBOT = "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)"
UA_FACEBOOKBOT = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"
UA_NORMAL = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"

REFERER_GOOGLE = "https://www.google.com/"
REFERER_FACEBOOK = "https://www.facebook.com/"
REFERER_TWITTER = "https://t.co/"

TIMEOUT = 30.0


def build_headers(strategy: SiteStrategy) -> dict[str, str]:
    """Build HTTP headers based on the site's bypass strategy."""
    headers: dict[str, str] = {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }

    if strategy.useragent_custom:
        headers["User-Agent"] = strategy.useragent_custom
    else:
        ua = strategy.useragent.lower() if strategy.useragent else ""
        if ua == "googlebot":
            headers["User-Agent"] = UA_GOOGLEBOT
        elif ua == "bingbot":
            headers["User-Agent"] = UA_BINGBOT
        elif ua in ("facebookbot", "facebook"):
            headers["User-Agent"] = UA_FACEBOOKBOT
        else:
            headers["User-Agent"] = UA_NORMAL

    ref = strategy.referer.lower() if strategy.referer else ""
    if ref == "google":
        headers["Referer"] = REFERER_GOOGLE
    elif ref == "facebook":
        headers["Referer"] = REFERER_FACEBOOK
    elif ref == "twitter":
        headers["Referer"] = REFERER_TWITTER
    elif not strategy.useragent and not strategy.useragent_custom:
        headers["Referer"] = REFERER_GOOGLE

    if strategy.random_ip:
        ip = f"{random.randint(1,223)}.{random.randint(0,255)}.{random.randint(0,255)}.{random.randint(1,254)}"
        headers["X-Forwarded-For"] = ip

    return headers


def build_fallback_headers() -> dict[str, str]:
    """Fallback: Googlebot UA + Google referer."""
    return {
        "User-Agent": UA_GOOGLEBOT,
        "Referer": REFERER_GOOGLE,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }


async def fetch_page(url: str, strategy: SiteStrategy | None = None, client: httpx.AsyncClient | None = None) -> tuple[str, int]:
    """Fetch page HTML with bypass headers. Returns (html, status_code)."""
    headers = build_headers(strategy) if strategy else build_fallback_headers()
    own_client = client is None
    if own_client:
        client = httpx.AsyncClient(follow_redirects=True, timeout=TIMEOUT)
    try:
        resp = await client.get(url, headers=headers)
        return resp.text, resp.status_code
    finally:
        if own_client:
            await client.aclose()


async def fetch_with_retries(
    url: str,
    strategy: SiteStrategy | None = None,
    client: httpx.AsyncClient | None = None,
    use_browser: bool | None = None,
) -> tuple[str, int, dict | None]:
    """Try primary strategy, fallback to googlebot, then browser, then archive.org.

    use_browser: True=force browser, False=skip browser, None=auto (block_js only).
    Returns (html, status_code, dom_result_or_None).
    """
    should_browser = use_browser if use_browser is not None else (
        strategy is not None and strategy.bypass_type() == "block_js"
    )

    own_client = client is None
    if own_client:
        client = httpx.AsyncClient(follow_redirects=True, timeout=TIMEOUT)
    try:
        html, status = await fetch_page(url, strategy, client)
        if status == 200 and _has_content(html) and not _is_paywalled(html):
            return html, status, None

        if not strategy or strategy.useragent != "googlebot":
            fallback = SiteStrategy(domain=(strategy.domain if strategy else ""), useragent="googlebot")
            html, status = await fetch_page(url, fallback, client)
            if status == 200 and _has_content(html) and not _is_paywalled(html):
                return html, status, None

        # Browser fallback — also extracts DOM directly
        browser_html = ""
        dom_result = None
        if should_browser and strategy:
            try:
                from .browser import fetch_with_browser, BrowserPool, extract_article_dom
                pool = BrowserPool(max_contexts=1)
                await pool.start()
                try:
                    async with pool.page() as page:
                        from .browser import _build_route_patterns
                        route_patterns = _build_route_patterns(strategy)
                        for pattern in route_patterns:
                            try:
                                await page.route(pattern, lambda route: route.abort())
                            except Exception:
                                pass
                        for provider in ["piano.io", "tinypass.com", "poool.fr", "zephr.com", "pelcro.com", "sophi.io"]:
                            try:
                                await page.route(f"**/*{provider}*", lambda route: route.abort())
                            except Exception:
                                pass
                        if strategy.useragent_custom:
                            await page.set_extra_http_headers({"User-Agent": strategy.useragent_custom})
                        try:
                            resp = await page.goto(url, wait_until="domcontentloaded", timeout=30000)
                            status = resp.status if resp else 0
                        except Exception:
                            status = 0
                        try:
                            await page.wait_for_selector("article, [data-article], .article-body", timeout=8000)
                        except Exception:
                            pass
                        await page.wait_for_timeout(2000)
                        await page.evaluate("""() => {
                            document.querySelectorAll('[class*="paywall"], [class*="gate"], [class*="piano"]').forEach(el => { el.style.display = 'none'; });
                            document.querySelectorAll('article, [data-article], .article-body').forEach(el => { el.style.overflow = 'visible'; el.style.maxHeight = 'none'; });
                            document.body.style.overflow = 'auto';
                        }""")
                        await page.wait_for_timeout(500)
                        dom_result = await extract_article_dom(page)
                        browser_html = await page.content()
                finally:
                    await pool.stop()
                if dom_result and dom_result.get("text") and len(dom_result["text"]) > 200:
                    return browser_html, 200, dom_result
                if browser_html and _has_content(browser_html):
                    return browser_html, 200, None
            except Exception:
                pass

        # Archive.org fallback
        try:
            archive_url = f"https://web.archive.org/web/2/{url}"
            resp = await client.get(archive_url, headers={"User-Agent": UA_NORMAL}, follow_redirects=True)
            if resp.status_code == 200 and _has_content(resp.text) and _has_full_article(resp.text):
                return resp.text, 200, None
        except Exception:
            pass

        if browser_html and _has_content(browser_html):
            return browser_html, 200, dom_result
        return html, status, None
    finally:
        if own_client:
            await client.aclose()


def _has_content(html: str) -> bool:
    """Check if HTML has meaningful content (not just a paywall/redirect)."""
    if len(html) < 500:
        return False
    lower = html.lower()
    if "<article" in lower or "articlebody" in lower or "article-body" in lower:
        return True
    if lower.count("<p") > 3:
        return True
    return len(html) > 5000


def _has_full_article(html: str) -> bool:
    """Check if HTML likely contains a full article (not just first paragraph)."""
    import re
    paragraphs = re.findall(r'<p[^>]*>(.+?)</p>', html, re.DOTALL)
    total_text = sum(len(re.sub(r'<[^>]+>', '', p)) for p in paragraphs)
    return total_text > 800 or len(paragraphs) > 5


def _is_paywalled(html: str) -> bool:
    """Detect if page shows paywall truncation markers."""
    markers = [
        "log in or create an account to continue",
        "subscribe to continue reading",
        "sign in to continue",
        "create a free account to continue",
        "this article is for subscribers",
        "to read the full story",
        "register for free to continue reading",
        "already a subscriber? sign in",
        "want to read more?",
        "unlock this article",
        "premium content",
        "members only",
    ]
    lower = html.lower()
    return any(m in lower for m in markers)
