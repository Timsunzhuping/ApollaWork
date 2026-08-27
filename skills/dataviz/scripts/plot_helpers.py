# -*- coding: utf-8 -*-
"""dataviz 技能助手函数。

统一风格的 matplotlib 图表：中文字体自动探测（避免方块）、和谐配色、去边框、
高 dpi 导出 PNG。所有函数返回保存路径。

用法::

    import sys
    sys.path.insert(0, "<技能目录>/scripts")
    from plot_helpers import (setup_cjk_font, bar_chart, line_chart, pie_chart,
                              scatter_chart, PALETTE)

    setup_cjk_font()  # 也可不显式调用，各绘图函数会自动调用
    bar_chart(["华东", "华北", "华南"], [1200, 900, 1500], "bar.png",
              title="各区域销售额", ylabel="万元")
    line_chart(["Q1", "Q2", "Q3", "Q4"],
               {"2024": [10, 12, 11, 15], "2025": [12, 14, 16, 20]},
               "trend.png", title="季度营收趋势")
    pie_chart(["直销", "分销", "线上"], [45, 30, 25], "pie.png", title="渠道占比", donut=True)
"""
import matplotlib

matplotlib.use("Agg")  # 无显示环境（沙箱）必须
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib import font_manager  # noqa: E402

# 和谐配色（近似 seaborn deep），可直接按索引取用
PALETTE = ["#4C72B0", "#DD8452", "#55A868", "#C44E52", "#8172B3",
           "#937860", "#DA8BC3", "#8C8C8C", "#CCB974", "#64B5CD"]
GRID_COLOR = "#DDDDDD"
TEXT_COLOR = "#333333"

# 中文字体候选（覆盖 macOS / Linux 常见 CJK 字体；沙箱镜像预装 Noto CJK）
_CJK_CANDIDATES = ["PingFang SC", "Noto Sans CJK SC", "Noto Sans CJK JP",
                   "Source Han Sans SC", "Microsoft YaHei", "Heiti SC",
                   "WenQuanYi Zen Hei", "Arial Unicode MS", "SimHei", "STHeiti"]


def setup_cjk_font(preferred=None):
    """探测并设置可用中文字体，返回选中的字体名（找不到返回 None）。"""
    candidates = list(preferred or []) + _CJK_CANDIDATES
    available = {f.name for f in font_manager.fontManager.ttflist}
    chosen = [c for c in candidates if c in available]
    if chosen:
        existing = [f for f in plt.rcParams.get("font.sans-serif", []) if f not in chosen]
        plt.rcParams["font.sans-serif"] = chosen + existing
    plt.rcParams["font.family"] = "sans-serif"
    plt.rcParams["axes.unicode_minus"] = False  # 负号正常显示
    return chosen[0] if chosen else None


def _fmt(value):
    try:
        if abs(value) >= 1000:
            return format(value, ",.0f")
        if float(value).is_integer():
            return str(int(value))
        return format(value, ".2f")
    except Exception:
        return str(value)


def _as_series(values):
    """把 [v...] 归一化为 [(None, [v...])]；dict 归一化为 [(name, [v...])]。"""
    if isinstance(values, dict):
        return list(values.items())
    return [(None, list(values))]


def _apply_style(ax, title="", xlabel="", ylabel=""):
    ax.set_facecolor("white")
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)
    for spine in ("left", "bottom"):
        ax.spines[spine].set_color("#BBBBBB")
    ax.tick_params(colors=TEXT_COLOR, labelsize=10)
    if title:
        ax.set_title(title, fontsize=14, color=TEXT_COLOR, pad=12, fontweight="bold")
    if xlabel:
        ax.set_xlabel(xlabel, fontsize=11, color=TEXT_COLOR)
    if ylabel:
        ax.set_ylabel(ylabel, fontsize=11, color=TEXT_COLOR)


def _save(fig, path, dpi=200):
    fig.savefig(path, dpi=dpi, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return path


def bar_chart(categories, values, path, title="", xlabel="", ylabel="",
              colors=None, figsize=(9, 5), value_labels=True, horizontal=False):
    """柱状图。values 为 [v...]（单系列）或 {系列名: [v...]}（多系列分组）。"""
    setup_cjk_font()
    fig, ax = plt.subplots(figsize=figsize)
    series = _as_series(values)
    colors = colors or PALETTE
    n = len(series)
    idx = np.arange(len(categories))
    total_width = 0.8
    bar_w = total_width / max(n, 1)
    for i, (name, vals) in enumerate(series):
        offset = (i - (n - 1) / 2.0) * bar_w
        color = colors[i % len(colors)]
        if horizontal:
            bars = ax.barh(idx + offset, vals, height=bar_w, label=name, color=color, zorder=3)
        else:
            bars = ax.bar(idx + offset, vals, width=bar_w, label=name, color=color, zorder=3)
        if value_labels and n <= 3:
            ax.bar_label(bars, labels=[_fmt(v) for v in vals], padding=2,
                         fontsize=8, color=TEXT_COLOR)
    if horizontal:
        ax.set_yticks(idx)
        ax.set_yticklabels(categories)
        ax.grid(axis="x", color=GRID_COLOR, linewidth=0.8, zorder=0)
    else:
        ax.set_xticks(idx)
        ax.set_xticklabels(categories)
        ax.grid(axis="y", color=GRID_COLOR, linewidth=0.8, zorder=0)
    _apply_style(ax, title, xlabel, ylabel)
    if n > 1:
        ax.legend(frameon=False, fontsize=9)
    return _save(fig, path)


def line_chart(categories, values, path, title="", xlabel="", ylabel="",
               colors=None, figsize=(9, 5), markers=True):
    """折线图。values 同 bar_chart（单/多系列）。"""
    setup_cjk_font()
    fig, ax = plt.subplots(figsize=figsize)
    series = _as_series(values)
    colors = colors or PALETTE
    for i, (name, vals) in enumerate(series):
        ax.plot(categories, vals, marker="o" if markers else None,
                color=colors[i % len(colors)], linewidth=2.2, markersize=5,
                label=name, zorder=3)
    ax.grid(axis="y", color=GRID_COLOR, linewidth=0.8, zorder=0)
    _apply_style(ax, title, xlabel, ylabel)
    if len(series) > 1 or series[0][0] is not None:
        ax.legend(frameon=False, fontsize=9)
    return _save(fig, path)


def pie_chart(labels, values, path, title="", colors=None, figsize=(7, 7),
              donut=False, show_percent=True):
    """饼图 / 环形图（donut=True）。"""
    setup_cjk_font()
    fig, ax = plt.subplots(figsize=figsize)
    colors = (colors or PALETTE)[:len(values)]
    autopct = "%1.1f%%" if show_percent else None
    wedge_props = {"width": 0.42, "edgecolor": "white"} if donut else {"edgecolor": "white"}
    result = ax.pie(values, labels=labels, colors=colors, autopct=autopct,
                    startangle=90, counterclock=False, wedgeprops=wedge_props,
                    pctdistance=0.8 if donut else 0.6,
                    textprops={"fontsize": 11, "color": TEXT_COLOR})
    autotexts = result[2] if len(result) == 3 else []
    for text in autotexts:
        text.set_color("white")
        text.set_fontsize(10)
    ax.axis("equal")
    if title:
        ax.set_title(title, fontsize=14, color=TEXT_COLOR, pad=12, fontweight="bold")
    return _save(fig, path)


def scatter_chart(x, y, path, title="", xlabel="", ylabel="", color=None,
                  figsize=(8, 6), labels=None):
    """散点图，可选逐点标注。"""
    setup_cjk_font()
    fig, ax = plt.subplots(figsize=figsize)
    ax.scatter(x, y, c=color or PALETTE[0], s=45, alpha=0.75,
               edgecolors="white", linewidths=0.6, zorder=3)
    if labels:
        for xi, yi, li in zip(x, y, labels):
            ax.annotate(str(li), (xi, yi), fontsize=8, color=TEXT_COLOR,
                        xytext=(4, 4), textcoords="offset points")
    ax.grid(True, color=GRID_COLOR, linewidth=0.8, zorder=0)
    _apply_style(ax, title, xlabel, ylabel)
    return _save(fig, path)


if __name__ == "__main__":
    # 自测（需已安装 matplotlib）
    setup_cjk_font()
    bar_chart(["华东", "华北", "华南"], {"2024": [10, 9, 15], "2025": [12, 11, 18]},
              "/tmp/_plot_bar.png", title="各区域销售额", ylabel="万元")
    line_chart(["Q1", "Q2", "Q3", "Q4"], [10, 12, 11, 16], "/tmp/_plot_line.png",
               title="季度趋势")
    pie_chart(["直销", "分销", "线上"], [45, 30, 25], "/tmp/_plot_pie.png",
              title="渠道占比", donut=True)
    print("saved /tmp/_plot_bar.png /tmp/_plot_line.png /tmp/_plot_pie.png")
