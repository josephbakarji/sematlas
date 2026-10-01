"""
SUPER SIMPLE & FAST Wikipedia graph builder
- Minimal code, maximum speed
- Concurrent fetching
- Debug-friendly
"""
import asyncio
import aiohttp
import logging
import os
from typing import Dict, List, AsyncGenerator

from backend.utils.color_utils import get_color, lighten_color

logger = logging.getLogger(__name__)

API_URL = "https://en.wikipedia.org/w/api.php"
TIMEOUT = aiohttp.ClientTimeout(total=10)

# Wikimedia asks every client to identify itself with a way to reach its
# operator: https://meta.wikimedia.org/wiki/User-Agent_policy
# Set SEMATLAS_CONTACT to your own site, issue tracker or email if you run a copy.
HEADERS = {
    "User-Agent": "SemAtlas/1.3 (https://www.sematlas.com; {}) aiohttp/3".format(
        os.getenv("SEMATLAS_CONTACT", "https://github.com/josephbakarji/sematlas/issues"))
}


async def search_wikipedia(session: aiohttp.ClientSession, query: str) -> tuple[str, str]:
    """Find Wikipedia article. Returns (title, url)"""
    params = {
        "action": "query",
        "list": "search",
        "srsearch": query,
        "format": "json",
        "srlimit": 1
    }

    async with session.get(API_URL, params=params, timeout=TIMEOUT, headers=HEADERS) as resp:
        if resp.status != 200:
            raise Exception(f"Search failed: HTTP {resp.status}")

        data = await resp.json()
        results = data.get("query", {}).get("search", [])

        if not results:
            raise Exception(f"No results for '{query}'")

        title = results[0]["title"]
        url = f"https://en.wikipedia.org/wiki/{title.replace(' ', '_')}"
        logger.info(f"Found: '{title}'")
        return title, url


async def get_page_links(session: aiohttp.ClientSession, title: str, limit: int = 15) -> List[tuple[str, str]]:
    """
    Get links from a Wikipedia page. Returns list of (title, url) tuples.
    Uses prop=links which is FAST and gets real article links.
    """
    params = {
        "action": "parse",
        "page": title,
        "prop": "links",
        "format": "json",
        "redirects": 1
    }

    try:
        async with session.get(API_URL, params=params, timeout=TIMEOUT, headers=HEADERS) as resp:
            if resp.status != 200:
                logger.warning(f"Failed to fetch '{title}': HTTP {resp.status}")
                return []

            data = await resp.json()

            if "error" in data:
                logger.warning(f"API error for '{title}': {data['error'].get('info')}")
                return []

            links = data.get("parse", {}).get("links", [])

            # Filter to main namespace (ns=0) articles only
            result = []
            for link in links:
                if link.get("ns") == 0 and link.get("exists") == "":  # exists="" means article exists
                    link_title = link.get("*", "")
                    if link_title and ":" not in link_title:  # Skip special pages
                        link_url = f"https://en.wikipedia.org/wiki/{link_title.replace(' ', '_')}"
                        result.append((link_title, link_url))

                        if len(result) >= limit:
                            break

            logger.info(f"'{title}' -> {len(result)} links")
            return result

    except asyncio.TimeoutError:
        logger.warning(f"Timeout fetching links for '{title}'")
        return []
    except Exception as e:
        logger.error(f"Error fetching links for '{title}': {e}")
        return []


async def get_articles(article_name: str, depth: int = 1, include_minimum: int = 10) -> AsyncGenerator[Dict, None]:
    """
    Fast Wikipedia graph generator.

    Args:
        article_name: Starting article
        depth: How many levels deep (0=root only, 1=root+children, 2=root+children+grandchildren)
        include_minimum: Min links per page (for backward compat - using 15 for speed)

    Yields:
        {"nodes": [...], "links": [...]} in D3 format with debug logs
    """
    logger.info(f"🔍 Starting graph for '{article_name}' depth={depth}")

    # Limit links per page for speed
    LINKS_PER_PAGE = 15

    # Graph storage
    nodes = {}  # title -> node_id
    node_data = {}  # node_id -> {title, url, level}
    edges = set()  # (source_id, target_id)

    # BFS queue: (title, url, level)
    queue = []
    visited = set()

    async with aiohttp.ClientSession() as session:
        # 1. Find root article
        try:
            root_title, root_url = await search_wikipedia(session, article_name)
        except Exception as e:
            logger.error(f"Failed to find article: {e}")
            raise

        # Add root node
        root_id = 0
        nodes[root_title] = root_id
        node_data[root_id] = {"title": root_title, "url": root_url, "level": 0}
        visited.add(root_title)

        # Yield root with debug info
        graph_data = build_d3_graph(nodes, node_data, edges)
        graph_data["_debug"] = {
            "step": "root",
            "message": f"Found root article: {root_title}",
            "depth": depth
        }
        logger.info(f"✅ Root node added: {root_title}")
        yield graph_data

        # Add root to queue for expansion
        queue.append((root_title, root_url, 0))

        # 2. BFS expansion
        expansion_count = 0
        while queue:
            current_title, current_url, current_level = queue.pop(0)

            # Stop if we've reached max depth
            if current_level >= depth:
                logger.info(f"⏭️  Skipping {current_title} (level {current_level} >= depth {depth})")
                continue

            expansion_count += 1
            # Fetch links from this page
            logger.info(f"📡 [{expansion_count}] Fetching links for: {current_title} (level {current_level})")
            links = await get_page_links(session, current_title, LINKS_PER_PAGE)

            if not links:
                logger.warning(f"⚠️  No links found for: {current_title}")
                continue

            logger.info(f"✅ Got {len(links)} links from: {current_title}")

            # Process each link
            nodes_before = len(nodes)
            queued_count = 0
            for link_title, link_url in links:
                link_level = current_level + 1

                # Add node if new
                if link_title not in nodes:
                    node_id = len(nodes)
                    nodes[link_title] = node_id
                    node_data[node_id] = {"title": link_title, "url": link_url, "level": link_level}

                    # Queue for expansion if within depth
                    if link_title not in visited and link_level < depth:
                        queue.append((link_title, link_url, link_level))
                        visited.add(link_title)
                        queued_count += 1

                # Add edge
                source_id = nodes[current_title]
                target_id = nodes[link_title]
                edges.add((source_id, target_id))

            # Yield update after each page with debug info
            new_nodes_added = len(nodes) - nodes_before
            graph_data = build_d3_graph(nodes, node_data, edges)
            graph_data["_debug"] = {
                "step": "expand",
                "message": f"Expanded {current_title} (L{current_level}): +{new_nodes_added} nodes, queued {queued_count} for expansion",
                "current_level": current_level,
                "queue_size": len(queue),
                "total_nodes": len(nodes),
                "expansion_number": expansion_count
            }
            logger.info(f"📊 Progress: {len(nodes)} nodes, {len(edges)} edges, queue: {len(queue)}, expansion #{expansion_count}")
            yield graph_data

            # Small delay to be nice to Wikipedia
            await asyncio.sleep(0.02)

        # Final yield
        logger.info(f"✅ Complete: {len(nodes)} nodes, {len(edges)} edges")
        graph_data = build_d3_graph(nodes, node_data, edges)
        graph_data["_debug"] = {
            "step": "complete",
            "message": f"Graph complete!",
            "total_nodes": len(nodes),
            "total_edges": len(edges)
        }
        yield graph_data


def build_d3_graph(nodes: Dict[str, int], node_data: Dict[int, Dict], edges: set) -> Dict:
    """Convert to D3 format with colors"""

    # Build nodes array
    nodes_list = []
    for node_id, data in node_data.items():
        title = data["title"]
        url = data["url"]
        level = data["level"]

        # Color based on level
        if level == 0:
            color = "#000000"
            group = 0
        elif level == 1:
            color = get_color(1, node_id)
            group = 1
        elif level == 2:
            # Find parent to lighten color
            parent_color = "#666666"
            for source_id, target_id in edges:
                if target_id == node_id:
                    parent_node = node_data.get(source_id, {})
                    parent_level = parent_node.get("level", 0)
                    if parent_level == 1:
                        parent_color = get_color(1, source_id)
                    break
            color = lighten_color(parent_color, 1.2)
            group = 2
        else:
            color = get_color(level, node_id)
            group = level

        nodes_list.append({
            "name": title,
            "url": url,
            "level": level,
            "group": group,
            "color": color,
            "index": node_id  # D3 needs this
        })

    # Build links array - use node names for D3 resolution
    # This allows consistent link handling for both initial load and dynamic expansion
    links_list = []
    for src_id, tgt_id in edges:
        src_name = node_data[src_id]["title"]
        tgt_name = node_data[tgt_id]["title"]
        links_list.append({"source": src_name, "target": tgt_name})

    return {"nodes": nodes_list, "links": links_list}
