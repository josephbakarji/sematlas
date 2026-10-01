"""
Is Jev the right ranker, or would an ordinary LLM do better or cheaper?

Two tasks, each run on identical inputs for every system:

1. match: which Wikipedia article is this course concept? Ground truth is
   data/learn_bridge.json after human review (wiki title, or none). Every
   system sees the same candidate list per concept. A system either picks a
   candidate or abstains. Correct = picks the truth, or abstains when the
   truth is none or was not among the candidates.

2. links: rank the lead-section links of a page against a question, the
   work done at every step of /q. No ground truth exists, so a strong model
   ranks each page as the reference and systems are compared to it.

Jev answers one yes/no question per item (instructions repeated each time);
the LLMs get one prompt per concept or page and return all scores at once.
Costs are what OpenRouter reports.

    python scripts/eval_rankers.py match  [--models a,b,c]
    python scripts/eval_rankers.py links  [--models a,b,c] [--ref model]
"""

import asyncio
import json
import math
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

from backend.ask import OPENROUTER_BASE, jev_endpoint, jev_rank              # noqa: E402
from backend.explore import (LINK_CRITERIA, LINK_INSTRUCTIONS, describe,     # noqa: E402
                             is_plumbing, lead_links, search)

sys.path.insert(0, str(ROOT / "scripts"))
from build_learn_bridge import CRITERIA as MATCH_CRITERIA, INSTRUCTIONS as MATCH_INSTRUCTIONS  # noqa: E402

CACHE = Path(os.getenv("EVAL_CACHE", ROOT / "data" / "eval_cache"))
DEFAULT_MODELS = ["openai/gpt-5.4-nano", "google/gemini-3.1-flash-lite",
                  "openai/gpt-5.4-mini", "anthropic/claude-haiku-4.5"]
REFERENCE = "anthropic/claude-sonnet-5.5"
MATCH = 0.6
client = openai.AsyncOpenAI(api_key=os.getenv("OPENROUTER_API_KEY"), base_url=OPENROUTER_BASE)


def arg(name, default):
    for a in sys.argv:
        if a.startswith(f"--{name}="):
            return a.split("=", 1)[1]
    return default


async def llm_json(model, system, user, schema, sem):
    """One structured call; returns (parsed, cost, seconds)."""
    async with sem:
        t = time.time()
        extra = {"usage": {"include": True}}
        if model.startswith("openai/"):
            extra["reasoning"] = {"effort": "low"}
        for attempt in range(3):
            try:
                r = await client.chat.completions.create(
                    model=model,
                    messages=[{"role": "system", "content": system},
                              {"role": "user", "content": user}],
                    response_format={"type": "json_schema", "json_schema": {
                        "name": "out", "strict": True, "schema": schema}},
                    max_tokens=4000, extra_body=extra)
                text = r.choices[0].message.content or ""
                text = text.strip().removeprefix("```json").removesuffix("```").strip()
                cost = (getattr(r.usage, "model_extra", None) or {}).get("cost") or 0
                return json.loads(text), cost, time.time() - t
            except Exception as e:
                if attempt == 2:
                    print(f"  {model}: {type(e).__name__}: {str(e)[:120]}")
                    return None, 0, time.time() - t
                await asyncio.sleep(2)


# ---------------------------------------------------------------- task 1: match

MATCH_SYSTEM = (
    "You match concepts from a machine-learning course to Wikipedia articles. Given a "
    "concept and numbered candidate articles (title and one-line description), pick the "
    "article that IS this concept as the course means it (its own article, under its "
    "name or a standard synonym), not a broader field, a different meaning, or a merely "
    "related idea. If none is, answer null. Give your confidence from 0 to 1."
)
MATCH_SCHEMA = {"type": "object", "properties": {
    "choice": {"type": ["integer", "null"]}, "confidence": {"type": "number"}},
    "required": ["choice", "confidence"], "additionalProperties": False}


async def match_candidates():
    """Candidate lists per concept, gathered once and cached."""
    path = CACHE / "match_candidates.json"
    if path.exists():
        return json.loads(path.read_text())
    bridge = json.loads((ROOT / "data" / "learn_bridge.json").read_text())["concepts"]
    out, sem = {}, asyncio.Semaphore(2)
    async with aiohttp.ClientSession() as session:
        async def one(key, c):
            term = key.replace("-", " ")
            async with sem:
                found = {}
                for q in (term, f"{term} {c.get('title', '')}", f"{term} machine learning"):
                    for r in await search(session, q):
                        found.setdefault(r["title"], r)
                titles = list(found)[:14]
                info = await describe(session, titles)
            out[key] = {"name": term, "slide_title": c.get("title"), "lesson": c.get("deck_title"),
                        "truth": c.get("wiki"),
                        "candidates": [{"title": t, "about": info.get(t, {}).get("about", "")}
                                       for t in titles]}
        await asyncio.gather(*(one(k, c) for k, c in bridge.items()))
    CACHE.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=1, ensure_ascii=False))
    return out


def score_match(picks, data):
    right = wrong_pick = wrong_abstain = 0
    errors = []
    for key, d in data.items():
        titles = [c["title"] for c in d["candidates"]]
        truth = d["truth"] if d["truth"] in titles else None   # unreachable truth = abstain
        pick = picks.get(key)
        if pick == truth:
            right += 1
        elif pick is None:
            wrong_abstain += 1
            errors.append((key, "abstained", truth))
        else:
            wrong_pick += 1
            errors.append((key, pick, truth))
    return right, wrong_pick, wrong_abstain, errors


async def run_match(models):
    data = await match_candidates()
    reachable = sum(1 for d in data.values() if d["truth"] in [c["title"] for c in d["candidates"]])
    print(f"{len(data)} concepts; truth among the candidates for {reachable}, "
          f"so the best possible system abstains on the other {len(data) - reachable}\n")
    results = {}

    # Jev: one yes/no per candidate
    jev, usage = jev_endpoint(), {}
    sem = asyncio.Semaphore(6)
    t = time.time()
    async with aiohttp.ClientSession() as session:
        async def jev_one(key, d):
            async with sem:
                ps = await jev_rank(session, jev, f"Which Wikipedia article is the concept '{d['name']}'?",
                                    d["candidates"], "candidates", MATCH_INSTRUCTIONS, MATCH_CRITERIA,
                                    usage, extra={"concept": {k: d[k] for k in ("name", "slide_title", "lesson")}})
            best = max(zip(ps, d["candidates"]), key=lambda x: x[0]) if ps else (0, None)
            return key, best[1]["title"] if best[1] and best[0] >= MATCH else None
        picks = dict(await asyncio.gather(*(jev_one(k, d) for k, d in data.items())))
    results["typesafe/jev-1.13"] = (picks, usage.get("cost", 0), time.time() - t)

    # LLMs: one call per concept
    for model in models:
        sem = asyncio.Semaphore(8)
        t = time.time()

        async def llm_one(key, d):
            listing = "\n".join(f"{i}. {c['title']}: {c['about']}" for i, c in enumerate(d["candidates"]))
            user = (f"Concept: {d['name']}\nSlide title: {d['slide_title']}\nLesson: {d['lesson']}\n\n"
                    f"Candidates:\n{listing}")
            out, cost, _ = await llm_json(model, MATCH_SYSTEM, user, MATCH_SCHEMA, sem)
            pick = None
            if out and isinstance(out.get("choice"), int) and 0 <= out["choice"] < len(d["candidates"]) \
                    and (out.get("confidence") or 0) >= MATCH:
                pick = d["candidates"][out["choice"]]["title"]
            return key, pick, cost

        rows = await asyncio.gather(*(llm_one(k, d) for k, d in data.items()))
        results[model] = ({k: p for k, p, _ in rows}, sum(c for _, _, c in rows), time.time() - t)

    print(f"{'system':32} {'correct':>8} {'wrong pick':>11} {'missed':>7} {'cost':>9} {'time':>6}")
    report = {}
    for name, (picks, cost, secs) in results.items():
        right, wp, wa, errors = score_match(picks, data)
        report[name] = {"correct": right, "wrong_pick": wp, "missed": wa, "cost": cost,
                        "seconds": round(secs, 1), "errors": errors}
        print(f"{name:32} {right:>4}/{len(data):<3} {wp:>11} {wa:>7} ${cost:>8.4f} {secs:>5.0f}s")
    (CACHE / "match_report.json").write_text(json.dumps(report, indent=1, ensure_ascii=False))
    print("\nwrong picks (system: concept picked -> truth):")
    for name, r in report.items():
        for key, pick, truth in r["errors"]:
            if pick != "abstained":
                print(f"  {name}: {key}: {pick} -> {truth}")


# ---------------------------------------------------------------- task 2: links

PAGES = [
    ("Why did the Bronze Age collapse happen?", "Late Bronze Age collapse"),
    ("Why did the Bronze Age collapse happen?", "Sea Peoples"),
    ("How do birds navigate during migration?", "Animal navigation"),
    ("How do birds navigate during migration?", "Bird migration"),
    ("How do neural networks learn?", "Backpropagation"),
    ("How do neural networks learn?", "Neural network (machine learning)"),
    ("Why is the sky blue?", "Rayleigh scattering"),
    ("Who wrote the disputed Federalist Papers?", "The Federalist Papers"),
]
LINKS_SYSTEM = (
    "A reader is exploring Wikipedia to answer a question and is on the given page. For "
    "each numbered link (title and one-line description), give the probability from 0 to "
    "1 that following it leads to an article with facts that help answer the question. "
    "Prefer specific concepts, mechanisms, people and events the answer depends on over "
    "broad fields, countries, dates and lists. Return one score per link, in order."
)
LINKS_SCHEMA = {"type": "object", "properties": {
    "scores": {"type": "array", "items": {"type": "number"}}},
    "required": ["scores"], "additionalProperties": False}


async def link_pages():
    path = CACHE / "link_pages.json"
    if path.exists():
        return json.loads(path.read_text())
    out = []
    async with aiohttp.ClientSession() as session:
        for q, page in PAGES:
            titles = await lead_links(session, page)
            info = await describe(session, titles)
            items, seen = [], set()
            for t in titles:
                c = info.get(t, {}).get("canonical", t)
                about = info.get(t, {}).get("about", "")
                if c not in seen and not is_plumbing(c, about):
                    seen.add(c)
                    items.append({"title": c, "about": about})
            out.append({"question": q, "page": page, "links": items[:120]})
    CACHE.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=1, ensure_ascii=False))
    return out


def spearman(a, b):
    def ranks(x):
        order = sorted(range(len(x)), key=lambda i: -x[i])
        r = [0] * len(x)
        for pos, i in enumerate(order):
            r[i] = pos
        return r
    ra, rb = ranks(a), ranks(b)
    n = len(a)
    if n < 3:
        return float("nan")
    return 1 - 6 * sum((x - y) ** 2 for x, y in zip(ra, rb)) / (n * (n * n - 1))


def top(xs, k):
    return set(sorted(range(len(xs)), key=lambda i: -xs[i])[:k])


PICK_SYSTEM = (
    "A reader is exploring Wikipedia to answer a question and is on the given page. From "
    "the links listed (title and one-line description), name the 10 most likely to lead "
    "to an article with facts that help answer the question, best first. Prefer specific "
    "concepts, mechanisms, people and events the answer depends on over broad fields, "
    "countries, dates and lists. Copy each title exactly."
)
PICK_SCHEMA = {"type": "object", "properties": {
    "titles": {"type": "array", "items": {"type": "string"}}},
    "required": ["titles"], "additionalProperties": False}


async def llm_links(model, page, sem):
    listing = "\n".join(f"{i}. {l['title']}: {l['about']}" for i, l in enumerate(page["links"]))
    user = f"Question: {page['question']}\nPage: {page['page']}\n\nLinks:\n{listing}"
    if arg("style", "scores") == "pick":
        # name the best ten; avoids long position-aligned arrays, which LLMs misalign
        listing = "\n".join(f"- {l['title']}: {l['about']}" for l in page["links"])
        user = f"Question: {page['question']}\nPage: {page['page']}\n\nLinks:\n{listing}"
        out, cost, secs = await llm_json(model, PICK_SYSTEM, user, PICK_SCHEMA, sem)
        names = [t.strip() for t in (out or {}).get("titles", [])]
        idx = {l["title"]: i for i, l in enumerate(page["links"])}
        s = [0.0] * len(page["links"])
        for r, t in enumerate(names[:10]):
            if t in idx:
                s[idx[t]] = 1.0 - r / 20
        return s, cost, secs
    out, cost, secs = await llm_json(model, LINKS_SYSTEM, user, LINKS_SCHEMA, sem)
    s = (out or {}).get("scores") or []
    s = [float(x) if isinstance(x, (int, float)) else 0.0 for x in s][:len(page["links"])]
    s += [0.0] * (len(page["links"]) - len(s))
    return s, cost, secs


async def run_links(models, ref):
    pages = await link_pages()
    print(f"{len(pages)} pages, {sum(len(p['links']) for p in pages)} links; reference: {ref}\n")
    sem = asyncio.Semaphore(8)
    refs = await asyncio.gather(*(llm_links(ref, p, sem) for p in pages))
    ref_scores = [r[0] for r in refs]
    print(f"reference cost ${sum(r[1] for r in refs):.4f}")

    systems = {}
    jev, usage = jev_endpoint(), {}
    async with aiohttp.ClientSession() as session:
        t = time.time()
        jev_scores = await asyncio.gather(*(jev_rank(
            session, jev, p["question"], p["links"], "links", LINK_INSTRUCTIONS, LINK_CRITERIA,
            usage, extra={"page": p["page"]}) for p in pages))
        systems["typesafe/jev-1.13"] = (jev_scores, usage.get("cost", 0), time.time() - t)
    for model in models:
        t = time.time()
        rows = await asyncio.gather(*(llm_links(model, p, sem) for p in pages))
        systems[model] = ([r[0] for r in rows], sum(r[1] for r in rows), time.time() - t)

    print(f"\n(style: {arg('style', 'scores')}; rank corr is only meaningful for the scores style)")
    print(f"\n{'system':32} {'top-4 agree':>11} {'top-8 agree':>11} {'rank corr':>10} {'cost':>9} {'time':>6}")
    report = {}
    for name, (scores, cost, secs) in systems.items():
        t4 = sum(len(top(s, 4) & top(r, 4)) for s, r in zip(scores, ref_scores)) / (4 * len(pages))
        t8 = sum(len(top(s, 8) & top(r, 8)) for s, r in zip(scores, ref_scores)) / (8 * len(pages))
        rho = [spearman(s, r) for s, r in zip(scores, ref_scores)]
        rho = sum(x for x in rho if not math.isnan(x)) / max(1, sum(not math.isnan(x) for x in rho))
        report[name] = {"top4": t4, "top8": t8, "spearman": rho, "cost": cost, "seconds": secs}
        print(f"{name:32} {t4:>10.0%} {t8:>11.0%} {rho:>10.2f} ${cost:>8.4f} {secs:>5.0f}s")
    # what each system would follow, side by side, for a feel of the difference
    print("\nfirst page, top 4:")
    p = pages[0]
    for name, scores in [("reference", ref_scores[0])] + [(n, s[0][0]) for n, s in systems.items()]:
        best = [p["links"][i]["title"] for i in sorted(range(len(scores)), key=lambda i: -scores[i])[:4]]
        print(f"  {name:30} {best}")
    (CACHE / "links_report.json").write_text(json.dumps(report, indent=1))


if __name__ == "__main__":
    models = arg("models", ",".join(DEFAULT_MODELS)).split(",")
    if "match" in sys.argv:
        asyncio.run(run_match(models))
    elif "links" in sys.argv:
        asyncio.run(run_links(models, arg("ref", REFERENCE)))
    else:
        print(__doc__)
