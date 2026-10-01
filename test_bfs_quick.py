"""Quick test to verify BFS works without crashing"""
import asyncio
import sys

# Add parent dir to path
sys.path.insert(0, '/home/user/sematlas')

from backend.wikipedia.bfs import get_articles


async def test_bfs():
    """Test that BFS runs without errors"""
    print("🧪 Testing Wikipedia BFS...")

    try:
        updates = 0
        async for data in get_articles("Philosophy", depth=1):
            updates += 1
            print(f"\n📦 Update {updates}:")
            print(f"  Nodes: {len(data.get('nodes', []))}")
            print(f"  Links: {len(data.get('links', []))}")

            if data.get('_debug'):
                debug = data['_debug']
                print(f"  Debug: [{debug['step']}] {debug['message']}")

            # Show first node if available
            if data.get('nodes') and len(data['nodes']) > 0:
                node = data['nodes'][0]
                print(f"  Sample node: {node.get('name')} (index={node.get('index')})")

            # Stop after a couple updates to save time
            if updates >= 2:
                print("\n✅ BFS working! Stopping early...")
                break

        print(f"\n✅ Test passed! Got {updates} updates without errors.")
        return True

    except Exception as e:
        print(f"\n❌ Test failed with error: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    result = asyncio.run(test_bfs())
    sys.exit(0 if result else 1)
