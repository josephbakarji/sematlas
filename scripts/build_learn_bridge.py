"""
Build the bridge between learn.sematlas.com (the course) and sematlas.com (the map).

The course publishes its concepts at /static/data/concepts.json: a key, the
deck and slide that teach it, and a title. This script finds the Wikipedia
article each concept corresponds to, so the map can mark the articles a
learner can go and practise, and a concept can open its place on the map.

For every concept it searches Wikipedia under the concept's name and its
slide title, then asks Jev, per candidate, whether that article *is* the
concept as a machine-learning course means it. The best candidate is kept
when Jev is confident (>= MATCH); otherwise the concept stays unmatched and
is listed for a person to decide. Write overrides in data/learn_bridge_overrides.json:
{"concept-key": "Wikipedia title"} to fix a match, or {"concept-key": null}
to say there is no good article.

    python scripts/build_learn_bridge.py            # writes data/learn_bridge.json
"""

import asyncio
import json
import os
import sys
import time
from pathlib import Path

import aiohttp
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env")

from backend.ask import jev_endpoint, jev_rank          # noqa: E402
from backend.explore import describe, search             # noqa: E402

LEARN = os.getenv("SEMATLAS_LEARN_URL", "https://learn.sematlas.com")
OUT = ROOT / "data" / "learn_bridge.json"
OVERRIDES = ROOT / "data" / "learn_bridge_overrides.json"
MATCH = 0.6
CONCURRENCY = 2      # Wikipedia rate-limits bursts

INSTRUCTIONS = (
    "Is `candidates[{i}]` the Wikipedia article about the concept described in "
    "`concept`, in the sense a machine-learning course means it? Judge from the "
    "article's title and one-line description (`about`). The article must be "
    "about this concept itself (or its standard name), not a broader field, a "
    "different meaning of the same word, or a merely related idea."
)
CRITERIA = {
    "true": "This article is about the concept itself, under its name or a standard synonym.",
    "false": "A broader topic, a different meaning, a person or place, or only related.",
}


async def match(session, jev, sem, key, c, usage):
    term = key.replace("-", " ")
    async with sem:
        found = {}
        for q in (term, f"{term} {c.get('title', '')}", f"{term} machine learning"):
            for r in await search(session, q):
                found.setdefault(r["title"], r)
        cands = list(found.values())[:14]
        info = await describe(session, [r["title"] for r in cands])
        items = [{"title": r["title"], "about": info.get(r["title"], {}).get("about", "")}
                 for r in cands]
        if not items:
            return key, None, []
        ps = await jev_rank(
            session, jev, f"Which Wikipedia article is the concept '{term}'?",
            items, "candidates", INSTRUCTIONS, CRITERIA, usage,
            extra={"concept": {"name": term, "slide_title": c.get("title"),
                               "lesson": c.get("lecture")}})
    ranked = sorted(zip(ps, items), key=lambda x: -x[0])
    top = [{"title": it["title"], "about": it["about"], "p": round(p, 3)} for p, it in ranked[:3]]
    best = top[0] if top and top[0]["p"] >= MATCH else None
    return key, best, top


async def main():
    jev = jev_endpoint()
    if not jev:
        sys.exit("Set OPENROUTER_API_KEY (or TYPESAFE_API_KEY) in .env")
    overrides = json.loads(OVERRIDES.read_text()) if OVERRIDES.exists() else {}
    async with aiohttp.ClientSession() as session:
        async with session.get(f"{LEARN}/static/data/concepts.json") as r:
            course = await r.json(content_type=None)
        concepts = course["concepts"]
        usage, sem = {}, asyncio.Semaphore(CONCURRENCY)
        t = time.time()
        results = await asyncio.gather(*(match(session, jev, sem, k, c, usage)
                                         for k, c in concepts.items()))
    deck_order = {d: i for i, d in enumerate(course.get("order", []))}
    out, by_wiki, unmatched = {}, {}, []
    for pos, (key, best, top) in enumerate(results):
        c = concepts[key]
        wiki = overrides[key] if key in overrides else (best["title"] if best else None)
        how = "override" if key in overrides else ("jev" if best else None)
        out[key] = {
            "title": c.get("title"), "deck": c["deck"], "slide": c["slide"],
            "deck_title": course.get("titles", {}).get(c["deck"], c.get("lecture")),
            "url": f"{LEARN}/slides/{c['deck']}#/{c['slide']}",
            "order": [deck_order.get(c["deck"], 999), pos],
            "wiki": wiki, "match": how, "p": best["p"] if best else None,
            "candidates": top,
        }
        if wiki:
            by_wiki.setdefault(wiki, []).append(key)
        else:
            unmatched.append(key)
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({
        "source": f"{LEARN}/static/data/concepts.json",
        "built": time.strftime("%Y-%m-%d"),
        "concepts": out, "by_wiki": by_wiki,
    }, indent=1, ensure_ascii=False))
    print(f"{len(out)} concepts, {len(out) - len(unmatched)} matched, "
          f"{len(unmatched)} unmatched, {time.time() - t:.0f}s, "
          f"Jev {usage.get('calls')} calls ${usage.get('cost', 0):.4f}")
    if unmatched:
        print("unmatched (review, or add to data/learn_bridge_overrides.json):")
        for k in unmatched:
            top = out[k]["candidates"][:2]
            print(f"  {k:24} best: " + "; ".join(f"{x['title']} {x['p']}" for x in top))


if __name__ == "__main__":
    asyncio.run(main())
