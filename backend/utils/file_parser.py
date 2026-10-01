def parse_input_file(text_content: str):
    """
    parser for a textual input file.
    """
    lines = text_content.strip().split('\n')
    return {
        "lines": lines,
        "count": len(lines)
    }
 