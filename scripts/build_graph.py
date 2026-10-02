"""
One graph for the map and the territory: data/graph.json, served at /learn/graph.json.

It joins four sources that are each built elsewhere:

    data/course_graph.json   the course's concepts and prerequisite edges
                             (learn.sematlas.com, derived from slide tags)
    data/learn_bridge.json   which Wikipedia article each concept is, and story decks
    data/frontier.json       articles just beyond the course, and Wikipedia's links
                             between taught concepts

Node ids are typed: c:<concept key>, w:<Wikipedia title> for articles beyond
the course, d:<deck id> for story decks. Edge types:

    prereq    c:a -> c:b    a is taught before b and b uses it (from the course)
    wiki      c:a -- c:b    Wikipedia links the two in an article's lead section
    beyond    w:x -> c:k    x is a foundation of k (role basis) or where k leads (next)
    teaches   d:x -> c:k    the deck teaches k;  needs: the deck assumes k

No model is called; rebuilding is free.

    python scripts/build_graph.py
"""

import json
import os
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"


def course_of(c):
    """
    The concept's course, as the course's own config says ("intro_ml",
    "ml4science"); "other" for a deck outside both lists. Exports older than
    the field covered the intro course only.
    """
    if "course" not in c:
        return "intro_ml"
    return c["course"] or "other"


def absolute(url):
    return url if not url or url.startswith("http") else LEARN.rstrip("/") + url


def short(t):
    return t.split(" (")[0] if t else t


COURSE = os.getenv("SEMATLAS_COURSE_GRAPH",
                   "https://learn.sematlas.com/static/data/concept_graph.json")


LEARN = os.getenv("SEMATLAS_LEARN_URL", "https://learn.sematlas.com")
OUT = Path(os.getenv("SEMATLAS_GRAPH_OUT", DATA / "graph.json"))


def course_graph():
    """
    The course's published concept graph; the local snapshot until it exists.
    A fresh download also refreshes the snapshot, so a later offline build
    keeps the newest graph.
    """
    if not COURSE.startswith("http"):        # a local file, for testing an unpublished graph
        return json.loads(Path(COURSE).expanduser().read_text())
    try:
        req = urllib.request.Request(COURSE, headers={"User-Agent": "SemAtlas build_graph"})
        with urllib.request.urlopen(req, timeout=20) as r:
            g = json.loads(r.read())
        if g.get("concepts") and g.get("edges") is not None:
            g.setdefault("source", COURSE)
            (DATA / "course_graph.json").write_text(json.dumps(g, indent=1, ensure_ascii=False))
            print(f"course graph: {COURSE}")
            return g
    except Exception as e:
        print(f"course graph: {COURSE} not available ({e}); using the snapshot")
    return json.loads((DATA / "course_graph.json").read_text())


def main():
    course = course_graph()
    bridge = json.loads((DATA / "learn_bridge.json").read_text())
    frontier = json.loads((DATA / "frontier.json").read_text())
    concepts = bridge.get("concepts", {})

    nodes, edges = [], []
    for key, c in course["concepts"].items():
        b = concepts.get(key, {})
        nodes.append({
            "id": f"c:{key}", "type": "concept", "key": key,
            "name": c.get("name") or short(b.get("wiki")) or key.replace("-", " ").capitalize(),
            "definition": c.get("definition"),
            "wiki": b.get("wiki"), "wiki_closest": bool(b.get("closest")),
            "lesson": {"title": c.get("title") or c.get("name"),
                       "url": b.get("url") or absolute(c.get("url")),
                       "deck": c.get("deck"), "deck_title": b.get("deck_title")},
            "order": b.get("order"),
            "course": course_of(c),
        })
    keys = set(course["concepts"])
    # previews: a concept glimpsed before the deck that teaches it. Where the
    # glimpse is on a slide that defines another concept, it is an edge
    # (that concept -> the one previewed); otherwise the deck is recorded
    defined_on = {}
    for k, c in course["concepts"].items():
        defined_on.setdefault((c.get("deck"), c.get("slide")), []).append(k)
    titles = course.get("titles") or {}
    for n in nodes:
        pv = course["concepts"][n["key"]].get("previewed_on") or []
        n["previewed_in"] = sorted({titles.get(p["deck"], p["deck"]) for p in pv})
        for p in pv:
            for src in defined_on.get((p["deck"], p["slide"]), []):
                if src != n["key"]:
                    edges.append({"source": f"c:{src}", "target": n["id"], "type": "preview"})
    for a, b in course["edges"]:
        if a in keys and b in keys:
            edges.append({"source": f"c:{a}", "target": f"c:{b}", "type": "prereq"})
    seen = {(e["source"], e["target"]) for e in edges} | {(e["target"], e["source"]) for e in edges}
    for a, b in frontier.get("edges", []):
        if a in keys and b in keys and (f"c:{a}", f"c:{b}") not in seen:
            edges.append({"source": f"c:{a}", "target": f"c:{b}", "type": "wiki"})
    for f in frontier.get("frontier", []):
        nodes.append({"id": f"w:{f['article']}", "type": "beyond", "article": f["article"],
                      "about": f.get("about"), "role": f.get("role"), "score": f.get("score"),
                      "named_in": f.get("named_in", [])})
        for k in f.get("near", [])[:3]:
            if k in keys:
                edges.append({"source": f"w:{f['article']}", "target": f"c:{k}",
                              "type": "beyond", "role": f.get("role")})
    for did, d in (bridge.get("decks") or {}).items():
        nodes.append({"id": f"d:{did}", "type": "deck", "question": d["question"], "url": d["url"]})
        for role in ("teaches", "needs"):
            for k in d.get(role, []):
                if k in keys:
                    edges.append({"source": f"d:{did}", "target": f"c:{k}", "type": role})

    out = {
        "version": 1, "built": time.strftime("%Y-%m-%d"),
        "sources": {"course": course.get("source"), "bridge": bridge.get("source"),
                    "decks": bridge.get("decks_source"), "frontier_model": frontier.get("model")},
        "course_order": course.get("order"), "deck_titles": course.get("titles"),
        "nodes": nodes, "edges": edges,
    }
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False))
    count = lambda t: sum(1 for e in edges if e["type"] == t)
    print(f"{len(nodes)} nodes ({sum(n['type'] == 'concept' for n in nodes)} concepts, "
          f"{sum(n['type'] == 'beyond' for n in nodes)} beyond, {sum(n['type'] == 'deck' for n in nodes)} decks); "
          f"edges: {count('prereq')} prereq, {count('wiki')} wiki, {count('beyond')} beyond, "
          f"{count('preview')} preview, {count('teaches') + count('needs')} deck")


if __name__ == "__main__":
    main()
