#!/usr/bin/env python3
"""检查页面内联 <script> 块与外链 AI 模块的 JS 语法。

JS 语法错误在浏览器里表现为整页白屏。这里用纯 Python 的 esprima 做语法校验。

用法:
    python tools/check-js.py            # 检查 index.html 内联块 + atlas-ai-consult.js
    python tools/check-js.py index.html
"""

from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent.parent
MODULE = ROOT / "atlas-ai-consult.js"
SCRIPT_RE = re.compile(r"<script>(.*?)</script>", re.S)


def check_source(label, body, failed):
    body = body.replace("<\\/script", "</script")
    try:
        import esprima
        esprima.parseScript(body)
        print("  [%s] OK (%d 字符)" % (label, len(body)))
    except Exception as exc:
        failed[0] += 1
        print("  [%s] 语法错误: %s" % (label, exc))


def main(argv):
    files = [Path(a) for a in argv[1:]] or [ROOT / "index.html"]
    try:
        import esprima  # noqa: F401
    except ImportError:
        sys.exit("缺少依赖：python -m pip install esprima")

    failed = [0]
    for path in files:
        text = path.read_bytes().decode("utf-8")
        if path.suffix == ".js":
            print("%s: 外链模块" % path.relative_to(ROOT))
            check_source("module", text, failed)
            continue
        blocks = SCRIPT_RE.findall(text)
        print("%s: %d 个内联 script 块" % (path.relative_to(ROOT), len(blocks)))
        for i, body in enumerate(blocks, 1):
            check_source(str(i), body, failed)
        if not blocks:
            failed[0] += 1
            print("  !! 一个 script 块都没找到，文件名或标记有问题")
    if not argv[1:]:
        print("%s: 外链模块" % MODULE.relative_to(ROOT))
        check_source("module", MODULE.read_bytes().decode("utf-8"), failed)
    return 1 if failed[0] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))