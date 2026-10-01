# SemAtlas

**Ask a question and watch Wikipedia answer it.**
Live at [sematlas.com/q](https://www.sematlas.com/q).

SemAtlas searches Wikipedia, follows the links most likely to lead to an
answer, and writes a short Wikipedia-style article from what it found, citing
every article it used. The search happens in the open: you watch the graph of
articles grow, see why each one was followed, and decide for yourself which
articles the answer should be built from.

Most AI answer engines hand you a conclusion and a list of links. SemAtlas is
built around the opposite idea: the path to an answer is worth seeing, and the
reader, not the machine, should get the last word on what counts as evidence.

## What you can do

- **Ask a question.** The graph grows as articles are chosen. A node's colour
  says which starting article it grew from; its brightness says how strongly
  it answers the question. Dashed boxes are links that were ranked but not
  followed.
- **Choose the evidence.** Click any article, followed or not, to add it to the
  answer's sources or take it out, then rewrite the answer.
- **Ask follow-ups.** The same graph keeps growing, and each answer builds on
  the last.
- **Check everything.** Every claim cites its source, every ranking decision is
  listed with its score, and the exact models and the cost of each answer are
  shown.
- **Explore topics without a question** on the original page at `/`, which
  draws the link graph around any Wikipedia article.

## How it works

```
question
  → Wikipedia search (20 results)
  → Jev picks the starting articles
  → best-first growth, a few rounds: the most promising article's lead links,
    with their one-line descriptions, are ranked against the question; the
    best are followed, the next few stay in the graph as candidates
  → every article's intro is scored as evidence; the most promising are read
    in full and every paragraph is scored
  → a chat model writes the answer from the strongest intros and paragraphs,
    citing them as numbered references
```

Ranking is done by [Jev](https://openrouter.ai/typesafe/jev-1.13), a
"decision model" that returns calibrated probabilities instead of text: it is
fast (well under a second for a hundred judgements) and costs $0.042 per
million input tokens. Writing is done by a general chat model,
`openai/gpt-5.4-mini` by default. A question costs about 1.5 cents and takes
about 12 seconds. The code is in `backend/explore.py` (the exploration),
`backend/ask.py` (scoring and writing) and `static/js/q.js` (the page).

## Run it yourself

Python 3.11 or newer.

```bash
git clone https://github.com/josephbakarji/sematlas
cd sematlas
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # add an OpenRouter key: https://openrouter.ai/keys
hypercorn main:app --bind 127.0.0.1:5000
```

Then open http://127.0.0.1:5000/q.

One OpenRouter key covers both models. You can instead point the writer at
OpenAI, Anthropic, or a local OpenAI-compatible server such as Ollama (set
`SEMATLAS_LLM=openai` and `OPENAI_BASE_URL`); see `.env.example`. Without Jev,
relevance is scored by the writing model instead, which works but is slower,
and the graph does not grow past its starting articles.

### Running a public copy

Every question costs money, so a public deployment needs to decide who pays.
SemAtlas gives each visitor a few free questions a day, paid by the operator's
key inside a daily dollar budget (`SEMATLAS_FREE_PER_DAY`,
`SEMATLAS_FREE_BUDGET_USD`). Beyond that, visitors connect their own
OpenRouter account with one click (OAuth with PKCE) or paste a key. Their key
stays in their browser, is sent only with their own requests, and is never
stored or logged by the server.

Please set `SEMATLAS_CONTACT` to a way to reach you: Wikimedia asks every API
client to identify its operator.

The repository deploys as is to Render or any host that runs a `Procfile` or
the included `Dockerfile`.

## Privacy

The server logs question text, for debugging. It keeps anonymous counts of
what people do on the page (event names such as "added a source" or "opened
full view", with no identifiers) at `/q/stats`. Keys supplied by visitors are
never logged or stored.

## Licence

Code: MIT, see `LICENSE`. Wikipedia text is by Wikipedia contributors under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), and answers
written from it are shared under the same licence.
