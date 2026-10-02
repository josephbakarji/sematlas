"""
Compute /lab's three layouts once, offline, and save them (data/lab_layout.json).

The page then draws stored positions and never runs a simulation, however
large the graph (the approach of sematlas-learn's lab/concept-graph/bake.py).
Rerun after scripts/build_graph.py. Needs the app running locally and
Playwright:

    hypercorn main:app --bind 127.0.0.1:5057 &
    python scripts/bake_lab_layout.py [http://127.0.0.1:5057]
"""
import asyncio
import json
import sys
import time
from pathlib import Path

from playwright.async_api import async_playwright

OUT = Path(__file__).resolve().parent.parent / "data" / "lab_layout.json"
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5057"


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={"width": 1440, "height": 900})
        t = time.time()
        await pg.goto(f"{BASE}/lab?bake=1")
        await pg.wait_for_function("window.__layout", timeout=600000)
        layout = await pg.evaluate("window.__layout")
        OUT.write_text(json.dumps(layout))
        print(f"{OUT.name}: {len(layout['web'])} positions per layout, baked in {time.time() - t:.1f} s")
        await b.close()


asyncio.run(main())
