# CLAUDE.md: working on SemAtlas

SemAtlas has two pages. `/q` takes a question, grows a graph of Wikipedia
articles toward an answer with Jev ranking each step, and writes a cited
Wikipedia-style article. `/` draws the link graph around a topic, with an
"ask the graph" panel. See README.md for what the product is for.

## Run

```bash
pip install -r requirements.txt        # Python 3.11+
cp .env.example .env                   # OPENROUTER_API_KEY is enough
hypercorn main:app --bind 127.0.0.1:5000
```

The deployed site is www.sematlas.com (Render, auto-deploys from `main`).

## Layout

```
main.py                    routes; free tier, visitor keys, usage counts
backend/explore.py         /q: search, Jev seeds, best-first growth, passages, follow-ups, rewrite
backend/ask.py             shared: Jev calls (jev_rank), providers, scoring, answer streaming
backend/wikipedia/bfs.py   topic graph BFS for /, Wikipedia HEADERS (User-Agent)
static/js/q.js, static/css/q.css, templates/q.html   the /q page
static/js/graph.js, script.js, ask.js, templates/index.html   the / page
```

Every model-backed endpoint streams newline-delimited JSON events
(`status`, `graph`, `turn`, `scores`, `sources`, `text`, `cite`, `models`,
`cost`, `done`, `error`).

## Things that are easy to get wrong

- **Money.** Every question costs about 1.5 cents. Requests without a
  visitor key go through `_admit` in main.py (free tier, dollar budget); keep
  any new model-backed route behind it, and meter it with `_metered`.
- **Visitor keys** arrive in the `X-OpenRouter-Key` header. Never log them,
  never store them, never echo them in an error.
- **Jev on OpenRouter** is `typesafe/jev-1.13` at `/api/alpha/decisions`;
  `jev-latest` does not exist there. A hung Jev call is cut at 8 s and retried.
- **Wikipedia links**: rank lead-section links (full-page links include
  navboxes), resolve redirects before adding nodes, and filter citation
  plumbing (ISBN, DOI…) and disambiguation pages.
- **Theme**: the / page recolours nodes with `rethemeGraph()`; anything that
  marks nodes must use classes, not fill/stroke attributes, or it is wiped.
- **Licence**: Wikipedia text is CC BY-SA 4.0; keep the attribution on any
  page that shows or writes from it.
