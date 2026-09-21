#!/usr/bin/env python3
"""Fetch taste.io match scores. Requires curl_cffi (pip3 install curl_cffi).

Usage: taste.py score "Movie Title"
Reads TASTE_REFRESH_TOKEN from the environment and caches fresh JWTs in
.taste-token.json next to this script. Cloudflare blocks plain curl/fetch,
so every request impersonates a real Chrome TLS fingerprint via curl_cffi.
"""
import datetime
import fcntl
import json
import os
import sys

try:
    from curl_cffi import requests
except ImportError:
    print(json.dumps({"score": None, "error": "curl_cffi missing"}))
    sys.exit(1)

API = "https://www.taste.io"
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".taste-token.json")
IMPS = ["chrome131", "chrome136", "chrome142"]
LEEWAY = 300


def norm(s):
    return " ".join(str(s).strip().lower().split())


def env_token():
    val = os.environ.get("TASTE_REFRESH_TOKEN", "")
    if val:
        return val
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    try:
        with open(p) as f:
            for line in f:
                line = line.strip()
                if line.startswith("TASTE_REFRESH_TOKEN="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except Exception:
        pass
    return ""


def load():
    try:
        with open(CACHE) as f:
            d = json.load(f)
        exp = d.get("expires")
        if isinstance(exp, (int, float)) and exp > datetime.datetime.now().timestamp() + LEEWAY:
            return d.get("token")
    except Exception:
        pass
    return None


def save(tok, exp):
    with open(CACHE, "w") as f:
        json.dump({"token": tok, "expires": exp}, f)


def refresh():
    ref = env_token()
    if not ref:
        return None
    lock = open(CACHE + ".lock", "w")
    fcntl.flock(lock, fcntl.LOCK_EX)
    try:
        tok = load()
        if tok:
            return tok
        for imp in IMPS:
            r = requests.post(
                API + "/auth/token",
                impersonate=imp,
                headers={"Accept": "application/json"},
                json={"refreshToken": ref},
            )
            if r.status_code == 200:
                d = r.json()
                exp = d.get("expires")
                if exp:
                    ts = datetime.datetime.fromisoformat(exp.replace("Z", "+00:00")).timestamp()
                else:
                    ts = datetime.datetime.now().timestamp() + 3600
                save(d["token"], ts)
                return d["token"]
            if r.status_code == 422:
                break
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()
    return None


def fetch(path, params=None, tok=None):
    if not tok:
        return None
    for imp in IMPS:
        r = requests.get(
            API + path,
            impersonate=imp,
            params=params,
            headers={"Accept": "application/json", "Authorization": "Bearer " + tok},
        )
        if r.status_code != 403 or "Just a moment" not in r.text:
            return r
    return None


def get(path, params=None):
    tok = load() or refresh()
    if not tok:
        return None
    r = fetch(path, params, tok)
    if r is not None and r.status_code == 401:
        tok = refresh()
        if tok:
            r = fetch(path, params, tok)
    return r


def avg(slug):
    for path in ("/api/movies/" + slug, "/api/tv/" + slug):
        r = get(path)
        if r is None:
            continue
        try:
            u = r.json().get("user") or {}
        except Exception:
            continue
        a = u.get("average")
        if isinstance(a, (int, float)):
            return a
    return None


STOP = {"the", "and", "for", "with", "without", "into", "from", "that", "this",
        "of", "in", "on", "to", "at", "by", "is", "it", "vs", "a", "an"}


def tokens(s):
    import re

    return [w for w in re.split(r"[^a-z0-9]+", s) if w and (len(w) > 2 or w not in STOP)]


# Pick the best match from unified /api/search results for a title, preferring
# the item's own category (movie vs tv) so a same-named film never shadows a
# show (e.g. "Severance"). Exact name wins; otherwise fuzzy token overlap must
# reach 2 tokens (mirrors the browser snippet's confidence rules).
def pick(results, title, year, kind):
    want = "tv" if kind == "tv" else "movies"
    n = norm(title)
    exacts = [m for m in results if norm(m.get("name", "")) == n]
    if exacts:
        pool = [m for m in exacts if m.get("category") == want] or exacts
        if year:
            for m in pool:
                if str(m.get("year")) == str(year):
                    return m
        return pool[0]
    words = tokens(n)
    best = None
    bestScore = -1
    for m in results:
        cand = set(tokens(norm(m.get("name", ""))))
        hits = sum(1 for w in words if w in cand) * 2
        if m.get("category") == want:
            hits += 1
        if hits > bestScore:
            bestScore = hits
            best = m
    if best is None or bestScore < 4:
        return None
    return best


def score(title, kind=None, year=None):
    r = get("/api/search", params={"q": title})
    if r is None:
        return {"score": None, "name": None, "slug": None}
    try:
        results = r.json().get("results") or []
    except Exception:
        return {"score": None, "name": None, "slug": None}
    if not results:
        return {"score": None, "name": None, "slug": None}
    m = pick(results, title, year, kind)
    if m is None:
        return {"score": None, "name": None, "slug": None}
    a = avg(m.get("slug"))
    return {
        "score": round(a) if isinstance(a, (int, float)) else None,
        "name": m.get("name"),
        "slug": m.get("slug"),
        "category": m.get("category"),
    }


def slugscore(slug):
    a = avg(slug)
    return {
        "score": round(a) if isinstance(a, (int, float)) else None,
        "slug": slug,
    }


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "score"
    if cmd == "score":
        title = sys.argv[2] if len(sys.argv) > 2 else ""
        kind = sys.argv[3] if len(sys.argv) > 3 else None
        year = sys.argv[4] if len(sys.argv) > 4 else None
        print(json.dumps(score(title, kind, year)))
    elif cmd == "slugscore":
        slug = sys.argv[2] if len(sys.argv) > 2 else ""
        print(json.dumps(slugscore(slug)))
    elif cmd == "refresh":
        print(json.dumps({"ok": bool(refresh())}))
    else:
        print(json.dumps({"score": None, "error": "unknown cmd"}), file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
