import random

def get_color(level: int, node_id: int) -> str:
    """
    Returns a color from a predefined palette of lighter, pastel colors
    based on the node_id.
    """
    colors = [
        "#ffb366",  # Lighter orange
        "#66b3ff",  # Lighter blue 
        "#99e699",  # Lighter green
        "#ff9999",  # Lighter red
        "#cc99ff",  # Lighter purple
        "#ff99cc",  # Lighter pink
        "#99ffff",  # Lighter cyan
        "#ffff99",  # Lighter yellow
        "#ff99ff",  # Lighter magenta
        "#99ccff"   # Lighter sky blue
    ]
    return colors[node_id % len(colors)]

def lighten_color(hex_color: str, factor=1.2) -> str:
    """
    Lighten (factor>1) or darken (factor<1) a hex color (#rrggbb).
    No randomness: same parent's color => same child color.
    """
    color = hex_color.lstrip('#')
    if len(color) != 6:
        return hex_color  # fallback if invalid

    r = int(color[0:2], 16)
    g = int(color[2:4], 16)
    b = int(color[4:6], 16)

    nr = int(min(r * factor, 255))
    ng = int(min(g * factor, 255))
    nb = int(min(b * factor, 255))

    return f"#{nr:02x}{ng:02x}{nb:02x}"
