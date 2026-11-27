#!/usr/bin/env python3
"""检查单文件页面里内联 <script> 块的 JS 语法。

页面是「一个 HTML 打天下」的形态，JS 语法错误在浏览器里表现为整页白屏，
而本机没有 Node 可用来 `node --check`。这里用纯 Python 的 esprima 做语法校验。

用法:
    python tools/check-js.py            # 检查两份页面
    python tools/check-js.py web/index.html
"""

from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent.parent
DEFAULT = [ROOT / "index.html", ROOT / "web" / "index.html"]
SCRIPT_RE = re.compile(r"<script>(.*?)</script>", re.S)


def main(argv):
    files = [Path(a) for a in argv[1:]] or DEFAULT
    try:
        import esprima
    except ImportError:
        sys.exit("缺少依赖：python -m pip install esprima")

    failed = 0
    for path in files:
        text = path.read_bytes().decode("utf-8")
        blocks = SCRIPT_RE.findall(text)
        print("%s: %d 个内联 script 块" % (path.relative_to(ROOT), len(blocks)))
        for i, body in enumerate(blocks, 1):
            body = body.replace("<\\/script", "</script")
            try:
                esprima.parseScript(body)
                print("  [%d] OK (%d 字符)" % (i, len(body)))
            except Exception as exc:
                failed += 1
                print("  [%d] 语法错误: %s" % (i, exc))
        if not blocks:
            failed += 1
            print("  !! 一个 script 块都没找到，文件名或标记有问题")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
