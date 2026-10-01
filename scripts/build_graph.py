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
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"


def short(t):
    return t.split(" (")[0] if t else t


def main():
    course = json.loads((DATA / "course_graph.json").read_text())
    bridge = json.loads((DATA / "learn_bridge.json").read_text())
    frontier = json.loads((DATA / "frontier.json").read_text())
    concepts = bridge.get("concepts", {})

    nodes, edges = [], []
    for key, c in course["concepts"].items():
        b = concepts.get(key, {})
        nodes.append({
            "id": f"c:{key}", "type": "concept", "key": key,
            "name": short(b.get("wiki")) or key.replace("-", " ").capitalize(),
            "wiki": b.get("wiki"),
            "lesson": {"title": c.get("title"), "url": b.get("url") or c.get("url"),
                       "deck": c.get("deck"), "deck_title": b.get("deck_title")},
            "order": b.get("order"),
        })
    keys = set(course["concepts"])
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
    (DATA / "graph.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))
    count = lambda t: sum(1 for e in edges if e["type"] == t)
    print(f"{len(nodes)} nodes ({sum(n['type'] == 'concept' for n in nodes)} concepts, "
          f"{sum(n['type'] == 'beyond' for n in nodes)} beyond, {sum(n['type'] == 'deck' for n in nodes)} decks); "
          f"edges: {count('prereq')} prereq, {count('wiki')} wiki, {count('beyond')} beyond, "
          f"{count('teaches') + count('needs')} deck")


if __name__ == "__main__":
    main()
