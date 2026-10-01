"""
The frontier of the course: what lies just beyond what learn.sematlas.com teaches.

For every taught concept (data/learn_bridge.json) this reads its Wikipedia
article's lead-section links, the ideas the article itself leans on, and asks
a small model to name the ones most worth learning for a student who has just
learned the concept: what it rests on, or where it leads. Links that are
themselves taught become edges between concepts (the course seen through
Wikipedia); the rest are candidates beyond the syllabus. An article ranks high
when many taught concepts point to it.

The ranker is an ordinary LLM naming its picks, not Jev: on the link-ranking
benchmark (scripts/eval_rankers.py links --style=pick) Gemini 3.1 Flash-Lite
agreed with a strong reference on 81% of top-4 picks at the same cost as Jev,
which agreed on 50%.

    python scripts/build_frontier.py        # writes data/frontier.json
"""

import asyncio
import json
import os
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

import aiohttp
import openai
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env")

from backend.ask import OPENROUTER_BASE                       # noqa: E402
from backend.explore import describe, is_plumbing, lead_links  # noqa: E402

MODEL = os.getenv("SEMATLAS_FRONTIER_MODEL", "google/gemini-3.1-flash-lite")
OUT = ROOT / "data" / "frontier.json"
PICKS = 6

SYSTEM = (
    "You help design a machine-learning course. A student has just learned the given "
    "concept. From the links in its Wikipedia article (title and one-line description), "
    "name up to 6 that are most worth learning next for this student: ideas the concept "
    "rests on that a student might lack, or ideas it leads to. Prefer concepts, methods "
    "and phenomena; avoid people, places, dates, publications, software products and "
    "broad fields. Copy each title exactly, best first, and say for each whether it is "
    "'basis' (the concept rests on it) or 'next' (the concept leads to it)."
)
SCHEMA = {"type": "object", "properties": {"picks": {"type": "array", "items": {
    "type": "object", "properties": {
        "title": {"type": "string"}, "role": {"type": "string", "enum": ["basis", "next"]}},
    "required": ["title", "role"], "additionalProperties": False}}},
    "required": ["picks"], "additionalProperties": False}


async def pick(client, sem, concept, article, links):
    listing = "\n".join(f"- {l['title']}: {l['about']}" for l in links)
    user = (f"Concept: {concept['name']} (taught in the lesson '{concept['title']}', "
            f"{concept['deck_title']})\nIts Wikipedia article: {article}\n\nLinks:\n{listing}")
    async with sem:
        for attempt in range(3):
            try:
                r = await client.chat.completions.create(
                    model=MODEL,
                    messages=[{"role": "system", "content": SYSTEM},
                              {"role": "user", "content": user}],
                    response_format={"type": "json_schema", "json_schema": {
                        "name": "out", "strict": True, "schema": SCHEMA}},
                    max_tokens=1500, extra_body={"usage": {"include": True}})
                cost = (getattr(r.usage, "model_extra", None) or {}).get("cost") or 0
                text = (r.choices[0].message.content or "").strip()
                text = text.removeprefix("```json").removesuffix("```").strip()
                return json.loads(text).get("picks", []), cost
            except Exception as e:
                if attempt == 2:
                    print(f"  {article}: {type(e).__name__}: {str(e)[:100]}")
                    return [], 0
                await asyncio.sleep(2)


async def main():
    bridge = json.loads((ROOT / "data" / "learn_bridge.json").read_text())
    concepts, by_wiki = bridge["concepts"], bridge["by_wiki"]
    client = openai.AsyncOpenAI(api_key=os.getenv("OPENROUTER_API_KEY"), base_url=OPENROUTER_BASE)
    t = time.time()

    # 1. lead links of every taught article (Wikipedia, polite)
    articles = {}
    for key, c in concepts.items():
        if c.get("wiki"):
            articles.setdefault(c["wiki"], []).append(key)
    wsem = asyncio.Semaphore(2)
    links = {}
    async with aiohttp.ClientSession() as session:
        async def fetch(article):
            async with wsem:
                titles = await lead_links(session, article)
                info = await describe(session, titles)
            seen, items = set(), []
            for tt in titles:
                c = info.get(tt, {}).get("canonical", tt)
                about = info.get(tt, {}).get("about", "")
                if c not in seen and c != article and not is_plumbing(c, about):
                    seen.add(c)
                    items.append({"title": c, "about": about})
            links[article] = items
        await asyncio.gather(*(fetch(a) for a in articles))
    print(f"read {len(links)} articles in {time.time() - t:.0f}s")

    # 2. taught-to-taught edges: the course as Wikipedia links it
    edges = set()
    for article, items in links.items():
        for it in items:
            if it["title"] in by_wiki:
                for a in articles[article]:
                    for b in by_wiki[it["title"]]:
                        if a != b:
                            edges.add(tuple(sorted((a, b))))

    # 3. what lies beyond: the model's picks among untaught links
    lsem = asyncio.Semaphore(8)
    total = 0.0
    beyond = defaultdict(lambda: {"score": 0.0, "near": {}, "roles": defaultdict(int), "about": ""})

    async def one(article):
        nonlocal total
        keys = articles[article]
        c = concepts[keys[0]]
        concept = {"name": article, "title": c.get("title"), "deck_title": c.get("deck_title")}
        untaught = [l for l in links[article] if l["title"] not in by_wiki][:150]
        if not untaught:
            return
        picks, cost = await pick(client, lsem, concept, article, untaught)
        total += cost
        about = {l["title"]: l["about"] for l in untaught}
        for rank, p in enumerate(picks[:PICKS]):
            title = p.get("title", "").strip()
            if title not in about:          # the model invented or misspelled a title
                continue
            b = beyond[title]
            weight = 1.0 - rank / (2 * PICKS)
            b["score"] += weight
            b["about"] = about[title]
            b["roles"][p.get("role", "next")] += 1
            for k in keys:
                b["near"][k] = max(b["near"].get(k, 0), round(weight, 2))

    await asyncio.gather(*(one(a) for a in articles))

    # an article named in a lesson or deck title may be taught but untagged
    lesson_titles = {(c.get("title") or "") for c in concepts.values()} | \
                    {(c.get("deck_title") or "") for c in concepts.values()}

    def named_in(title):
        word = re.escape(title.split(" (")[0].lower())
        return sorted(t for t in lesson_titles if t and re.search(rf"\b{word}\b", t.lower()))

    frontier = sorted(({
        "article": title, "about": b["about"], "score": round(b["score"], 2),
        "near": sorted(b["near"], key=lambda k: -b["near"][k]),
        "role": "basis" if b["roles"]["basis"] > b["roles"]["next"] else "next",
        "named_in": named_in(title),
        "questions": [],          # filled once real question traffic is kept somewhere durable
    } for title, b in beyond.items()), key=lambda x: (-x["score"], x["article"]))

    OUT.write_text(json.dumps({
        "built": time.strftime("%Y-%m-%d"), "model": MODEL,
        "method": "lead-section links of each taught concept's article; the model names "
                  f"up to {PICKS} worth learning next; score = sum of rank weights across concepts",
        "cost_usd": round(total, 4),
        "frontier": frontier,
        "edges": [list(e) for e in sorted(edges)],
    }, indent=1, ensure_ascii=False))
    print(f"{len(frontier)} articles beyond the course, {len(edges)} edges between taught "
          f"concepts; model cost ${total:.4f}; {time.time() - t:.0f}s")
    for f in frontier[:25]:
        print(f"  {f['score']:5.2f}  {f['role']:5}  {f['article']:42} near {', '.join(f['near'][:4])}")


if __name__ == "__main__":
    asyncio.run(main())
