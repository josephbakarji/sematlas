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
    python scripts/build_learn_bridge.py --fresh    # re-match every concept

A rebuild keeps every match already in data/learn_bridge.json and only asks
Jev about concepts it has not seen, so adding a deck costs about a cent per
new concept and matches do not drift between runs.
"""

import asyncio
import json
import os
import sys
import time
from pathlib import Path

import aiohttp
import openai
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env")

from backend.ask import jev_endpoint, jev_rank          # noqa: E402
from backend.explore import describe, search             # noqa: E402

LEARN = os.getenv("SEMATLAS_LEARN_URL", "https://learn.sematlas.com")
# Story decks (sematlas-learn): each answers one question and lists the concepts
# it teaches and needs. A URL, or a local path while the index is unpublished.
DECKS = os.getenv("SEMATLAS_DECKS", "https://josephbakarji.github.io/sematlas-learn/decks.json")
OUT = Path(os.getenv("SEMATLAS_BRIDGE_OUT", ROOT / "data" / "learn_bridge.json"))
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
            extra={"concept": {"name": c.get("name") or term, "definition": c.get("definition"),
                               "slide_title": c.get("title"), "lesson": c.get("lecture")}})
    ranked = sorted(zip(ps, items), key=lambda x: -x[0])
    top = [{"title": it["title"], "about": it["about"], "p": round(p, 3)} for p, it in ranked[:3]]
    best = top[0] if top and top[0]["p"] >= MATCH else None
    return key, best, top


async def load_decks(session):
    """The story-deck index, or None when it is not published yet."""
    try:
        if DECKS.startswith("http"):
            async with session.get(DECKS) as r:
                if r.status != 200:
                    print(f"decks: {DECKS} returned HTTP {r.status}; building without decks")
                    return None
                return await r.json(content_type=None)
        return json.loads(Path(DECKS).expanduser().read_text())
    except Exception as e:
        print(f"decks: could not read {DECKS} ({e}); building without decks")
        return None


REVIEW_MODEL = os.getenv("SEMATLAS_REVIEW_MODEL", "anthropic/claude-sonnet-5.5")
REVIEW_SYSTEM = (
    "You match a concept from a university course to its Wikipedia article. Given the "
    "concept (name, one-line definition, lesson) and numbered candidate articles (title and "
    "one-line description), choose: 'exact' if one article is about this concept itself, "
    "under its name or a standard synonym; otherwise 'closest' if one article covers the "
    "concept as a clearly identifiable part of a broader topic (for example 'DeepONet' "
    "within 'Neural operators'); otherwise 'none'. Never choose a different meaning of the "
    "same word, a person, a product or a company. Give the candidate's number, or null."
)
REVIEW_SCHEMA = {"type": "object", "properties": {
    "kind": {"type": "string", "enum": ["exact", "closest", "none"]},
    "choice": {"type": ["integer", "null"]}},
    "required": ["kind", "choice"], "additionalProperties": False}


async def review(session, client, key, c, sem, cost):
    """
    A second look, by a stronger model, at a concept Jev would not match.
    Returns (title or None, "review" | "review-closest" | "review-none").
    """
    term = (c.get("name") or key.replace("-", " "))
    async with sem:
        found = {}
        for q in (term, f"{term} {c.get('title') or ''}", f"{term} {c.get('lecture') or ''}"):
            for r in await search(session, q.strip()):
                found.setdefault(r["title"], r)
        cands = list(found.values())[:16]
        info = await describe(session, [r["title"] for r in cands])
        items = [{"title": r["title"], "about": info.get(r["title"], {}).get("about", "")} for r in cands]
        if not items:
            return None, "review-none"
        listing = "\n".join(f"{i}. {it['title']}: {it['about']}" for i, it in enumerate(items))
        user = (f"Concept: {term}\nDefinition: {c.get('definition') or '(none given)'}\n"
                f"Lesson: {c.get('lecture') or c.get('title') or ''}\n\nCandidates:\n{listing}")
        for attempt in range(3):
            try:
                r = await client.chat.completions.create(
                    model=REVIEW_MODEL, max_tokens=300,
                    messages=[{"role": "system", "content": REVIEW_SYSTEM},
                              {"role": "user", "content": user}],
                    response_format={"type": "json_schema", "json_schema": {
                        "name": "match", "strict": True, "schema": REVIEW_SCHEMA}},
                    extra_body={"usage": {"include": True}})
                cost[0] += (getattr(r.usage, "model_extra", None) or {}).get("cost") or 0
                text = (r.choices[0].message.content or "").strip().removeprefix("```json").removesuffix("```").strip()
                out = json.loads(text)
                break
            except Exception as e:
                if attempt == 2:
                    print(f"  review failed for {key}: {str(e)[:80]}")
                    return None, None          # ask again next build
                await asyncio.sleep(2)
    i = out.get("choice")
    if out.get("kind") in ("exact", "closest") and isinstance(i, int) and 0 <= i < len(items):
        return items[i]["title"], "review" if out["kind"] == "exact" else "review-closest"
    return None, "review-none"


async def main():
    jev = jev_endpoint()
    if not jev:
        sys.exit("Set OPENROUTER_API_KEY (or TYPESAFE_API_KEY) in .env")
    overrides = json.loads(OVERRIDES.read_text()) if OVERRIDES.exists() else {}
    async with aiohttp.ClientSession() as session:
        async with session.get(f"{LEARN}/static/data/concepts.json") as r:
            course = await r.json(content_type=None)
        concepts = dict(course["concepts"])
        # the published concept graph carries a name and one-line definition per
        # concept, which make Jev's matching sharper; use them when they exist
        try:
            async with session.get(f"{LEARN}/static/data/concept_graph.json") as r:
                if r.status == 200:
                    graph = await r.json(content_type=None)
                    for k, g in (graph.get("concepts") or {}).items():
                        concepts[k] = {**g, **concepts.get(k, {}),
                                       "name": g.get("name"), "definition": g.get("definition")}
        except Exception as e:
            print(f"concept_graph.json not available ({e}); matching without definitions")
        index = await load_decks(session)
        decks = (index or {}).get("decks", [])
        moves = (index or {}).get("moves", {})
        # a key only a deck uses still gets matched to Wikipedia
        for d in decks:
            for key in d.get("teaches", []) + d.get("needs", []):
                key = moves.get(key, key)
                if key not in concepts:
                    concepts[key] = {"deck": d["id"], "slide": "", "title": key.replace("-", " "),
                                     "lecture": d["question"], "external": d["url"]}
        usage, sem = {}, asyncio.Semaphore(CONCURRENCY)
        t = time.time()
        known = {}
        if "--fresh" not in sys.argv and OUT.exists():
            known = json.loads(OUT.read_text()).get("concepts", {})

        async def one(k, c):
            if k in overrides:                 # a person decided; nothing to ask
                return k, None, (known.get(k) or {}).get("candidates", [])
            if k in known and known[k].get("match") == "jev":
                prev = known[k]
                return k, {"title": prev["wiki"], "p": prev["p"]}, prev.get("candidates", [])
            if k in known and (known[k].get("match") or "").startswith("review"):
                prev = known[k]
                return k, ({"title": prev["wiki"], "p": None, "how": prev["match"]} if prev["wiki"]
                           else {"title": None, "p": None, "how": prev["match"]}), prev.get("candidates", [])
            if k in known and known[k].get("match") is None and known[k].get("candidates") \
                    and "--review" not in sys.argv:
                return k, None, known[k]["candidates"]
            return await match(session, jev, sem, k, c, usage)

        results = await asyncio.gather(*(one(k, c) for k, c in concepts.items()))

        # what Jev would not match, a stronger model looks at again
        review_cost = [0.0]
        if "--review" in sys.argv:
            client = openai.AsyncOpenAI(api_key=os.getenv("OPENROUTER_API_KEY"),
                                        base_url="https://openrouter.ai/api/v1")
            todo = [i for i, (k, best, top) in enumerate(results)
                    if best is None and k not in overrides]
            rsem = asyncio.Semaphore(6)
            got = await asyncio.gather(*(review(session, client, results[i][0],
                                                concepts[results[i][0]], rsem, review_cost)
                                         for i in todo))
            for i, (title, how) in zip(todo, got):
                k, _, top = results[i]
                if how:
                    results[i] = (k, {"title": title, "p": None, "how": how}, top)
            print(f"reviewed {len(todo)} by {REVIEW_MODEL}: "
                  f"{sum(1 for t, h in got if h == 'review')} exact, "
                  f"{sum(1 for t, h in got if h == 'review-closest')} closest, "
                  f"{sum(1 for t, h in got if h == 'review-none')} none; ${review_cost[0]:.4f}")
    deck_order = {d: i for i, d in enumerate(course.get("order", []))}
    out, by_wiki, unmatched = {}, {}, []
    for pos, (key, best, top) in enumerate(results):
        c = concepts[key]
        wiki = overrides[key] if key in overrides else (best["title"] if best else None)
        how = "override" if key in overrides else ((best.get("how") or "jev") if best else None)
        out[key] = {
            "title": c.get("title"), "deck": c["deck"], "slide": c["slide"],
            "deck_title": course.get("titles", {}).get(c["deck"], c.get("lecture")),
            "url": c.get("external") or f"{LEARN}/slides/{c['deck']}#/{c['slide']}",
            "order": [deck_order.get(c["deck"], 999), pos],
            "wiki": wiki, "match": how, "p": best["p"] if best else None,
            "closest": how == "review-closest",
            "candidates": top,
        }
        if wiki:
            by_wiki.setdefault(wiki, []).append(key)
        else:
            unmatched.append(key)
    OUT.parent.mkdir(exist_ok=True)
    deck_out, by_concept = {}, {}
    for d in decks:
        teaches = [moves.get(k, k) for k in d.get("teaches", [])]
        needs = [moves.get(k, k) for k in d.get("needs", [])]
        deck_out[d["id"]] = {"question": d["question"], "answer": d.get("answer"),
                             "url": d["url"], "teaches": teaches, "needs": needs,
                             "spine": d.get("spine", [])}
        for role, keys in (("teaches", teaches), ("needs", needs)):
            for k in keys:
                by_concept.setdefault(k, {"teaches": [], "needs": []})[role].append(d["id"])
    OUT.write_text(json.dumps({
        "source": f"{LEARN}/static/data/concepts.json",
        "decks_source": DECKS if index else None,
        "built": time.strftime("%Y-%m-%d"),
        "concepts": out, "by_wiki": by_wiki,
        "decks": deck_out, "decks_by_concept": by_concept, "moves": moves,
    }, indent=1, ensure_ascii=False))
    print(f"decks: {len(deck_out)} from {DECKS if index else 'nowhere'}")
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
