"""Stamp a content version onto the web page, and count versions.

GitHub Pages lets browsers cache files for 10 minutes, and a normal refresh can keep
using old JavaScript modules after an update. This adds ?v=<hash> to every reference in
index.html and to every relative import in js/*.js, where <hash> comes from the
contents of the web files themselves. When any of them changes, every address changes,
so browsers fetch the new files. Running it again without changes does nothing.

It also keeps a version counter in tools/version.json: when the web files' contents
differ from the last stamp, the number goes up by one. The page header shows
"version N" (and the hash on hover), so you can tell which version a browser loaded.

Run before committing changes to the web page:
    python tools/stamp_version.py
"""

import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = [ROOT / "index.html", *sorted((ROOT / "tests").glob("*.html")), *sorted((ROOT / "css").glob("*.css")),
         *sorted((ROOT / "js").glob("*.js"))]
# href="css/x.css", src="js/x.js", from "./x.js", import("./x.js"), from "../js/x.js"
REF = re.compile(r"""((?:href|src)=["']|from\s+["']|import\(\s*["'])((?:\.{1,2}/|css/|js/)[\w./-]+\.(?:js|css))(\?v=[0-9a-f]+)?(["'])""")


VERSION_FILE = ROOT / "tools" / "version.json"
LABEL = re.compile(r'<span id="version"[^>]*>[^<]*</span>')
BLANK = '<span id="version" class="version"></span>'


def strip(text):
    """The text without any stamps, so the hash only depends on real content."""
    return LABEL.sub(BLANK, REF.sub(lambda m: m.group(1) + m.group(2) + m.group(4), text))


def main():
    texts = {p: p.read_text() for p in FILES}
    digest = hashlib.sha1("".join(strip(t) for t in texts.values()).encode()).hexdigest()[:8]
    record = json.loads(VERSION_FILE.read_text()) if VERSION_FILE.exists() else {"number": 0, "hash": ""}
    if record["hash"] != digest:
        record = {"number": record["number"] + 1, "hash": digest}
        VERSION_FILE.write_text(json.dumps(record, indent=2) + "\n")
    label = f'version {record["number"]}'
    changed = []
    for p, t in texts.items():
        new = REF.sub(lambda m: f"{m.group(1)}{m.group(2)}?v={digest}{m.group(4)}", t)
        new = LABEL.sub(f'<span id="version" class="version" title="{digest}">{label}</span>', new)
        if new != t:
            p.write_text(new)
            changed.append(p.relative_to(ROOT))
    print(f"{label} ({digest}): " + (", ".join(map(str, changed)) if changed else "already stamped"))


if __name__ == "__main__":
    main()
