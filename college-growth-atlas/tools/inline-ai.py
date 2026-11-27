#!/usr/bin/env python3
"""把 web/atlas-ai-consult.js 内联进资料库版 index.html。

为什么只有这一份需要内联：

- `index.html`（WorkBuddy 资料库版）是**单文件上传**：只传这一个 HTML，
  同目录的外链 JS 传不上去，线上必然 404，所以要内联。
- `web/index.html`（Qoder Sites 版）是**整个目录托管**，`atlas-ai-consult.js`
  会跟着一起部署（实测 `GET /atlas-ai-consult.js` 返回 200），所以保持外链，
  改模块时不用再跑本脚本，也不会出现「改源文件、页面里还是旧拷贝」。

改完 `web/atlas-ai-consult.js` 后跑一次本脚本即可（幂等，靠 ATLAS-AI 标记定位）。

用法:
    python tools/inline-ai.py
"""

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "web" / "atlas-ai-consult.js"
TARGETS = [ROOT / "index.html"]

START = "<!-- ATLAS-AI:INLINE-START -->"
END = "<!-- ATLAS-AI:INLINE-END -->"
EXTERNAL = '<script src="atlas-ai-consult.js"></script>'
APP_ANCHOR = "大学成长地图 — 前端应用"


def read_text(path):
    raw = path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        raw = raw[3:]
    return raw.decode("utf-8")


def write_text(path, text):
    path.write_bytes(text.encode("utf-8"))


def block_for(js, nl):
    # script 元素内部出现 `</script` 会被 HTML 解析器当成结束标签，必须转义
    js = js.replace("</script", "<\\/script").rstrip()
    head = (
        START
        + nl
        + "<!-- 内联自 web/atlas-ai-consult.js。不要直接改这一段，"
        + "改源文件后运行 python tools/inline-ai.py 重新内联。 -->"
        + nl
        + "<script>"
        + nl
    )
    return head + js + nl + "</script>" + nl + END


def refresh(text, blk):
    """已内联过：整段换掉。"""
    i = text.find(START)
    j = text.find(END, i)
    if i < 0 or j < 0:
        return None
    return text[:i] + blk + text[j + len(END):]


def inject(text, blk, nl):
    if EXTERNAL in text:
        return text.replace(EXTERNAL, blk, 1), "替换外链 script 为内联块"
    anchor = "<script>" + nl + "/* " + "=" * 60 + nl + "   " + APP_ANCHOR
    idx = text.find(anchor)
    if idx < 0:
        # 兜底：找应用脚本前的最后一个空行
        idx = text.find("<script>" + nl + "/* " + "=" * 60)
    if idx < 0:
        return None, "找不到插入位置"
    return text[:idx] + blk + nl + text[idx:], "在应用脚本前插入内联块"


def main():
    js = read_text(SRC)
    if "window.AtlasAI" not in js:
        sys.exit("源文件不像 atlas-ai-consult.js，中止")
    changed = 0
    for target in TARGETS:
        text = read_text(target)
        nl = "\r\n" if "\r\n" in text else "\n"
        blk = block_for(js, nl)
        if START in text and END in text:
            out = refresh(text, blk)
            action = "刷新已有内联块"
        else:
            out, action = inject(text, blk, nl)
        if out is None:
            print("!! %s: %s" % (target.relative_to(ROOT), action))
            continue
        if out == text:
            print("== %s: 已是最新" % target.relative_to(ROOT))
            continue
        write_text(target, out)
        changed += 1
        print("OK %s: %s（%+d 字符）" % (target.relative_to(ROOT), action, len(out) - len(text)))
    return 0 if changed or True else 1


if __name__ == "__main__":
    sys.exit(main())
