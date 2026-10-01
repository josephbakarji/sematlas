import asyncio
import os
import json
import logging
import uuid
import time
from collections import Counter
from datetime import datetime

from quart import Quart, request, render_template, jsonify, Response
from dotenv import load_dotenv

from backend.wikipedia.bfs import get_articles
from backend.utils.file_parser import parse_input_file
from backend.ask import ask_stream
from backend.explore import explore_stream, rewrite_stream

# Load environment variables
load_dotenv()

# Version tracking
VERSION = "1.2.1"
BUILD_TIME = datetime.utcnow().isoformat() + "Z"

# Configure logging
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# In-memory storage for active streams: { stream_id: asyncio.Event }
# We'll set the event to cancel a stream.
active_streams = {}

# Initialize Quart app
app = Quart(__name__)

# Quart configurations
app.config.update({
    'RESPONSE_TIMEOUT': 350,
    'TEMPLATES_AUTO_RELOAD': True,
    'MAX_CONTENT_LENGTH': 16 * 1024 * 1024,
    'PROVIDE_AUTOMATIC_OPTIONS': False
})

@app.after_request
def add_header(response):
    """Ensure responses are not cached."""
    # "Cache-Control" was listed twice in this dict, so the later value won and
    # the no-store line above it never took effect: responses went out as
    # publicly cacheable, which behind a CDN is the opposite of the docstring.
    response.headers.update({
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
    })
    return response

@app.route('/')
async def index():
    """Render the main index page; lab.sematlas.com opens on the lab."""
    if request.host.split(":")[0].startswith("lab."):
        return await render_template('lab.html', version=VERSION)
    return await render_template('index.html', version=VERSION)

@app.route('/version')
async def version():
    """Return version info for debugging"""
    return jsonify({
        "version": VERSION,
        "build_time": BUILD_TIME,
        "status": "running"
    })

@app.route('/simple_test')
async def simple_test():
    """Simple Wikipedia scraper test page"""
    return await render_template('simple_test.html')

@app.route('/bfs_debug')
async def bfs_debug():
    """BFS debug test page - shows exactly what BFS is doing"""
    return await render_template('bfs_debug.html')

@app.route('/simple_scrape')
async def simple_scrape():
    """
    Simple endpoint that scrapes Wikipedia and returns raw link data.
    No graph, no complexity - just shows what we actually get from Wikipedia.
    """
    import aiohttp
    from backend.wikipedia.bfs import search_wikipedia, get_page_links

    query = request.args.get('q', 'Philosophy')

    try:
        async with aiohttp.ClientSession() as session:
            # Step 1: Search for the article
            logger.info(f"🔍 Searching for: {query}")
            title, url = await search_wikipedia(session, query)
            logger.info(f"✅ Found: {title} at {url}")

            # Step 2: Get links from the page
            logger.info(f"📡 Fetching links from: {title}")
            links = await get_page_links(session, title, limit=100)
            logger.info(f"✅ Got {len(links)} links")

            # Step 3: Return simple JSON
            return jsonify({
                "success": True,
                "query": query,
                "title": title,
                "url": url,
                "links_count": len(links),
                "links": [{"title": t, "url": u} for t, u in links]
            })

    except Exception as e:
        logger.error(f"❌ Error scraping Wikipedia: {e}", exc_info=True)
        return jsonify({
            "error": str(e),
            "query": query,
            "details": f"Failed to scrape Wikipedia for '{query}'"
        }), 500

@app.route('/get_abstract')
async def get_abstract():
    """
    Fetch Wikipedia article abstract for the info panel.
    """
    import aiohttp
    from backend.wikipedia.bfs import HEADERS, TIMEOUT

    title = request.args.get('title', '')

    if not title:
        return jsonify({"error": "No title provided"}), 400

    API_URL = "https://en.wikipedia.org/w/api.php"
    params = {
        "action": "query",
        "titles": title,
        "prop": "extracts",
        "exintro": "1",
        "explaintext": "1",
        "format": "json"
    }

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(API_URL, params=params, timeout=TIMEOUT, headers=HEADERS) as resp:
                if resp.status != 200:
                    return jsonify({"error": f"Wikipedia API error: {resp.status}"}), 500

                data = await resp.json()
                pages = data.get("query", {}).get("pages", {})

                for page_id, page_data in pages.items():
                    if page_id != "-1":
                        abstract = page_data.get("extract", "")
                        # Limit abstract length
                        if len(abstract) > 1500:
                            abstract = abstract[:1500] + "..."
                        return jsonify({
                            "title": title,
                            "abstract": abstract
                        })

                return jsonify({"title": title, "abstract": None})

    except Exception as e:
        logger.error(f"Error fetching abstract for {title}: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/expand_node')
async def expand_node():
    """
    Expand a single node by fetching its children.
    Returns new nodes and links to be merged into the existing graph.
    """
    import aiohttp
    from backend.wikipedia.bfs import get_page_links, HEADERS, TIMEOUT
    from backend.utils.color_utils import get_color, lighten_color

    title = request.args.get('title', '')

    if not title:
        return jsonify({"error": "No title provided"}), 400

    try:
        async with aiohttp.ClientSession() as session:
            # Fetch children of this node
            links = await get_page_links(session, title, limit=15)

            if not links:
                return jsonify({
                    "success": False,
                    "message": "No children found",
                    "new_nodes": [],
                    "new_links": []
                })

            # Build new nodes and links
            new_nodes = []
            new_links = []

            for i, (child_title, child_url) in enumerate(links):
                # Create node with proper structure
                new_node = {
                    "name": child_title,
                    "url": child_url,
                    "level": 99,  # Mark as dynamically added
                    "group": 99,
                    "color": get_color(3, i),  # Use level 3 colors
                    "index": 1000 + i  # High index to avoid conflicts
                }
                new_nodes.append(new_node)

                # Create link from parent to child (by name, will be resolved in frontend)
                new_link = {
                    "source": title,
                    "target": child_title
                }
                new_links.append(new_link)

            logger.info(f"Expanded {title}: found {len(new_nodes)} children")

            return jsonify({
                "success": True,
                "parent": title,
                "new_nodes": new_nodes,
                "new_links": new_links
            })

    except Exception as e:
        logger.error(f"Error expanding node {title}: {e}")
        return jsonify({"error": str(e), "success": False}), 500

@app.route('/visualize', methods=['POST'])
async def visualize():
    """
    Visualize data for a given article.
    Returns a text/event-stream response. The first chunk of data
    includes a JSON object with {"stream_id": <uuid>} that can be
    used to stop this stream via the /stop/<uuid> endpoint.
    """
    form_data = await request.form
    article_name = form_data.get('article_name')
    search_source = form_data.get('search_source', 'wikipedia')
    depth = form_data.get('depth', type=int, default=1)

    logger.info(f"Visualization requested for article: {article_name} using {search_source}")

    if not article_name:
        logger.warning("Empty article name provided")
        return jsonify({"error": "Please Enter an Article Name"}), 400

    # Generate a unique UUID that is not already in use
    stream_id = str(uuid.uuid4())
    while stream_id in active_streams:
        stream_id = str(uuid.uuid4())

    # Create an Event to signal stopping this stream
    stop_event = asyncio.Event()
    # Store the stop event in the dictionary
    active_streams[stream_id] = {
        "event": stop_event,
        "nodes": []
    }

    # Depending on search_source, pick the correct BFS function
    # Note: For Wikipedia, depth=0 means root only, depth=1 means root+children
    # The UI shows depth as 1-based (1, 2, 3), so we subtract 1
    # to get the actual BFS depth (0, 1, 2)
    bfs_depth = depth - 1

    data_generator = get_articles(article_name, depth=bfs_depth, include_minimum=10)

    async def stream():
        # First yield: let the client know the stream_id
        yield json.dumps({"stream_id": stream_id}) + '\n\n'

        data_count = 0

        async for data_chunk in data_generator:
            # If stop_event is set, break out of the loop
            if active_streams[stream_id]["event"].is_set():
                break

            data_count += 1
            # Store the latest nodes
            active_streams[stream_id]["nodes"] = data_chunk.get("nodes", [])

            await asyncio.sleep(0.04)

            yield json.dumps(data_chunk) + '\n\n'

        logger.info(f"Completed streaming {data_count} data chunks for stream {stream_id}")
        
        # Remove the stream_id from active_streams upon completion
        active_streams.pop(stream_id, None)

    return Response(stream(), content_type='text/event-stream')

@app.route('/stop/<string:stream_id>', methods=['POST'])
async def stop_stream(stream_id):
    """
    Stop the ongoing stream with the given UUID.
    Signals the stop event, which will cause the
    streaming generator to break out.
    """
    if stream_id not in active_streams:
        logger.warning(f"Stop request for invalid stream ID: {stream_id}")
        return jsonify({"error": "Invalid or inactive stream ID"}), 400

    # Signal the stream to stop
    active_streams[stream_id]["event"].set()
    logger.info(f"Stop signal set for stream {stream_id}")

    return jsonify({"message": f"Stream {stream_id} is stopping"}), 200

@app.route('/test')
async def test_logs():
    """Live testing page with real-time logs"""
    return await render_template('test_logs.html', version=VERSION)

@app.route('/dsc')
async def dsc():
    """Render DSC graph page with parsed data."""
    try:
        with open('static/dsc_graph.txt', 'r', encoding='utf-8') as file:
            content = file.read()
        data = parse_input_file(content)
        return await render_template('dsc.html', initial_data=data)
    except Exception as e:
        logger.error(f"Error rendering DSC graph: {e}")
        return await render_template('dsc.html', error=str(e))

@app.route('/debug/test_wikipedia', methods=['GET'])
async def debug_test_wikipedia():
    """
    Debug endpoint to test Wikipedia search directly.
    Usage: /debug/test_wikipedia?q=Philosophy&depth=1
    """
    query = request.args.get('q', 'Philosophy')
    depth = request.args.get('depth', type=int, default=1)

    try:
        from backend.wikipedia.bfs import get_articles

        results = []
        async for data in get_articles(query, depth=depth):
            results.append({
                "nodes_count": len(data.get("nodes", [])),
                "links_count": len(data.get("links", [])),
                "sample_nodes": data.get("nodes", [])[:3]  # First 3 nodes
            })

        final_data = results[-1] if results else {}

        return jsonify({
            "success": True,
            "query": query,
            "depth": depth,
            "total_updates": len(results),
            "final_graph": final_data,
            "message": f"Successfully generated graph with {final_data.get('nodes_count', 0)} nodes"
        }), 200

    except Exception as e:
        logger.error(f"Debug test failed: {e}", exc_info=True)
        return jsonify({
            "success": False,
            "error": str(e),
            "type": type(e).__name__
        }), 500


@app.route('/q')
async def question_page():
    """Question-first explorer: ask, watch the graph grow, read the article."""
    return await render_template('q.html', version=VERSION,
                                 repo_url=os.getenv("SEMATLAS_REPO_URL",
                                                    "https://github.com/josephbakarji/sematlas"))


# ---------------------------------------------------------------- who pays
#
# Every question spends real money on the model APIs (about 1.5 cents for a
# /q search). Visitors either bring their own OpenRouter key, sent per request
# in the X-OpenRouter-Key header and never logged or stored, or use the free
# tier the site pays for: a few questions per visitor per day, inside a daily
# dollar budget counted from the costs the providers actually report.
# In memory, so a restart resets the counts; enough for one process.

FREE_PER_DAY = int(os.getenv("SEMATLAS_FREE_PER_DAY", "5"))
FREE_BUDGET_USD = float(os.getenv("SEMATLAS_FREE_BUDGET_USD", "2"))
OWN_KEY_PER_HOUR = int(os.getenv("SEMATLAS_OWN_KEY_PER_HOUR", "120"))
ASK_COST_ESTIMATE = 0.006    # /ask reports no cost; count it at a typical value

_free = {"day": None, "spent": 0.0, "by_ip": Counter()}
_hourly = {}                  # ip -> [timestamps], for visitors with their own key


def _ip():
    return (request.headers.get("X-Forwarded-For") or request.remote_addr or "?").split(",")[0].strip()


def _user_key():
    k = (request.headers.get("X-OpenRouter-Key") or "").strip()
    return k if k.startswith("sk-or-") and len(k) < 200 else None


def _roll_day():
    day = int(time.time() // 86400)
    if _free["day"] != day:
        _free.update(day=day, spent=0.0, by_ip=Counter())


def _quota():
    _roll_day()
    return {
        "free_left": max(0, FREE_PER_DAY - _free["by_ip"][_ip()]),
        "free_per_day": FREE_PER_DAY,
        "budget_left": FREE_BUDGET_USD > _free["spent"],
    }


def _admit(user_key):
    """None if the request may go ahead, else (message, status)."""
    if user_key:
        now = time.time()
        recent = [t for t in _hourly.get(_ip(), []) if now - t < 3600]
        if len(recent) >= OWN_KEY_PER_HOUR:
            return "That's a lot of questions for one hour. Give it a little while.", 429
        _hourly[_ip()] = recent + [now]
        return None
    q = _quota()
    if not q["budget_left"]:
        return ("Today's free questions are used up for everyone. Connect your own "
                "OpenRouter account to keep going; each question costs about 1.5 cents.", 402)
    if q["free_left"] <= 0:
        n = f"{FREE_PER_DAY} free question" + ("s" if FREE_PER_DAY != 1 else "")
        return (f"You've used today's {n}. Connect your own "
                "OpenRouter account to keep going; each question costs about 1.5 cents.", 402)
    _free["by_ip"][_ip()] += 1
    return None


async def _metered(gen, free):
    """Pass the stream through, adding free-tier costs to today's budget."""
    async for chunk in gen:
        if free and chunk.startswith(b'{"type": "cost"'):
            try:
                _free["spent"] += json.loads(chunk).get("total") or 0
            except ValueError:
                pass
        yield chunk


def _refused(msg, status):
    return jsonify({"error": msg, "need_key": status == 402, **_quota()}), status


def _followup_context(data):
    """The earlier questions and answers, and the graph on the page, trimmed."""
    prior = [{"question": str(p.get("question", ""))[:500], "answer": str(p.get("answer", ""))[:4000]}
             for p in (data or {}).get("prior", [])[-5:] if isinstance(p, dict) and p.get("question")]
    graph = (data or {}).get("graph") or {}
    known = {"nodes": [n for n in graph.get("nodes", []) if isinstance(n, dict)][:500],
             "links": [l for l in graph.get("links", []) if isinstance(l, dict)][:2000]}
    return prior or None, known


@app.route('/lab')
async def lab_page():
    """The course on the map: what learn.sematlas.com teaches and what lies beyond it."""
    return await render_template('lab.html', version=VERSION)


@app.route('/learn/frontier.json')
async def learn_frontier():
    """
    What lies just beyond the course, ranked, plus the links between taught
    concepts. Built by scripts/build_frontier.py from the bridge.
    """
    from pathlib import Path
    p = Path(__file__).parent / "data" / "frontier.json"
    if not p.exists():
        return jsonify({"frontier": [], "edges": []})
    resp = Response(p.read_text(), content_type="application/json")
    resp.headers["Access-Control-Allow-Origin"] = "*"
    return resp


@app.route('/learn/bridge.json')
async def learn_bridge():
    """
    Which Wikipedia articles are concepts taught on learn.sematlas.com, and
    where. Built by scripts/build_learn_bridge.py from the course's public
    concept list; data/learn_bridge_overrides.json holds human corrections.
    """
    from pathlib import Path
    p = Path(os.getenv("SEMATLAS_BRIDGE", Path(__file__).parent / "data" / "learn_bridge.json"))
    if not p.exists():
        return jsonify({"concepts": {}, "by_wiki": {}})
    resp = Response(p.read_text(), content_type="application/json")
    resp.headers["Access-Control-Allow-Origin"] = "*"   # the course site may read it
    return resp


@app.route('/q/quota')
async def quota():
    return jsonify(_quota())


@app.route('/explore', methods=['POST'])
async def explore():
    """Body: {"question": str}. Streams NDJSON events; see backend/explore.py."""
    data = await request.get_json()
    question = (data or {}).get("question", "").strip()
    if not question or len(question) > 500:
        return jsonify({"error": "Ask a question of up to 500 characters"}), 400
    prior, known = _followup_context(data)
    seeds = [t.strip() for t in (data or {}).get("seeds", [])
             if isinstance(t, str) and 0 < len(t.strip()) < 200][:3] or None
    key = _user_key()
    if (refusal := _admit(key)):
        return _refused(*refusal)
    _count("concept" if seeds else "followup" if prior else "question", key)
    logger.info(f"Explore: {question!r}" + (f" (follow-up, {len(known['nodes'])} nodes)" if prior else ""))
    return Response(_metered(explore_stream(question, prior, known, key, seeds), not key),
                    content_type='application/x-ndjson')


@app.route('/explore/rewrite', methods=['POST'])
async def explore_rewrite():
    """Body: {"question": str, "titles": [str]}. Rewrites from the reader's chosen articles."""
    data = await request.get_json() or {}
    question = data.get("question", "").strip()
    titles = [t for t in data.get("titles", []) if isinstance(t, str) and t.strip()][:12]
    if not question or len(question) > 500 or not titles:
        return jsonify({"error": "A question and at least one article are required"}), 400
    key = _user_key()
    if (refusal := _admit(key)):
        return _refused(*refusal)
    _count("rewrite", key)
    prior, _ = _followup_context(data)
    logger.info(f"Rewrite: {question!r} from {len(titles)} articles")
    return Response(_metered(rewrite_stream(question, titles, prior, key), not key),
                    content_type='application/x-ndjson')


@app.route('/ask', methods=['POST'])
async def ask():
    """
    Answer a question from the articles in the current graph.
    Body: {"question": str, "nodes": [{"name": str, "title": str}]}
    Streams newline-delimited JSON events; see backend/ask.py.
    """
    data = await request.get_json()
    question = (data or {}).get("question", "").strip()
    nodes = [n for n in (data or {}).get("nodes", [])
             if isinstance(n, dict) and n.get("name") and n.get("title")]
    if not question or not nodes:
        return jsonify({"error": "A question and the graph's nodes are required"}), 400
    if len(question) > 500:
        return jsonify({"error": "Keep the question under 500 characters"}), 400
    key = _user_key()
    if (refusal := _admit(key)):
        return _refused(*refusal)
    if not key:
        _free["spent"] += ASK_COST_ESTIMATE
    _count("graph_question", key)
    logger.info(f"Ask: {question!r} over {len(nodes)} nodes")
    return Response(ask_stream(question, nodes, key), content_type='application/x-ndjson')


# ---------------------------------------------------------------- usage counts
#
# Anonymous counts of what people do on /q, so we can tell whether the graph
# is used at all: no question text, no identifiers, just event names.

EVENTS = {"node_add", "node_remove", "open_wikipedia", "cite_click", "fullview", "open_lesson",
          "zoom", "hide_graph", "connect_start", "connected", "paste_key", "disconnect"}
_counts = Counter()


def _count(name, key=None):
    _counts[name] += 1
    _counts[name + (":own_key" if key else ":free")] += 1
    logger.info(f"event {name}")


@app.route('/q/event', methods=['POST'])
async def q_event():
    data = await request.get_json(silent=True) or {}
    name = data.get("name")
    if name in EVENTS:
        _count(name)
    return ("", 204)


@app.route('/q/stats')
async def q_stats():
    _roll_day()
    return jsonify({"since_restart": dict(sorted(_counts.items())),
                    "free_spent_today_usd": round(_free["spent"], 4),
                    "free_budget_usd": FREE_BUDGET_USD})


if __name__ == '__main__':
    app.run(debug=True)
