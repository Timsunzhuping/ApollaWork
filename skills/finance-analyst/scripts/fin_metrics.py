#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""finance-analyst 技能：财务指标计算（纯 stdlib，无需第三方库）。

输入为“科目字典”（键见下方 ACCOUNT_KEYS），输出常用指标与杜邦分解。
所有除法都做零/缺失保护，缺失项返回 None，绝不抛异常打断分析。

用法::

    from fin_metrics import compute_ratios, yoy_table, growth, fmt_pct

    cur = {"revenue": 1200, "cost_of_sales": 800, "net_profit": 150,
           "net_profit_attributable": 140, "total_assets": 2000,
           "total_liabilities": 1200, "equity_attributable": 800,
           "current_assets": 900, "current_liabilities": 500, "inventory": 200}
    ratios = compute_ratios(cur)
    print(fmt_pct(ratios["gross_margin"]), fmt_pct(ratios["roe"]))

科目单位需一致（例如都用“万元”）；比率均为小数，用 fmt_pct 转百分数展示。
"""

# 约定的科目键（取数阶段尽量按此命名，缺失的留空即可）
ACCOUNT_KEYS = [
    "revenue",                    # 营业收入
    "cost_of_sales",              # 营业成本
    "gross_profit",              # 毛利（缺失则用 revenue - cost_of_sales）
    "operating_profit",          # 营业利润
    "ebit",                      # 息税前利润
    "ebt",                       # 利润总额（税前利润）
    "tax",                       # 所得税费用
    "net_profit",                # 净利润
    "net_profit_attributable",   # 归母净利润
    "interest_expense",          # 利息费用
    "total_assets",              # 资产总计
    "total_liabilities",         # 负债总计
    "total_equity",              # 所有者权益合计（缺失则用 assets - liabilities）
    "equity_attributable",       # 归母所有者权益
    "current_assets",            # 流动资产
    "current_liabilities",       # 流动负债
    "inventory",                 # 存货
    "accounts_receivable",       # 应收账款
    "operating_cash_flow",       # 经营活动现金流净额
]


def _safe_div(numerator, denominator):
    """安全除法：分母为 0 / None，或分子为 None 时返回 None。"""
    try:
        if numerator is None or denominator in (None, 0):
            return None
        return numerator / denominator
    except (TypeError, ZeroDivisionError):
        return None


def _sub(a, b):
    if a is None or b is None:
        return None
    return a - b


def growth(current, base):
    """增长率（同比/环比通用）= (current - base) / |base|，小数。base 为 0/None 返回 None。"""
    if current is None or base in (None, 0):
        return None
    return (current - base) / abs(base)


def cagr(begin, end, periods):
    """复合年均增长率。begin<=0 或 periods<=0 返回 None。"""
    try:
        if begin is None or end is None or begin <= 0 or periods <= 0:
            return None
        return (end / begin) ** (1.0 / periods) - 1.0
    except (TypeError, ZeroDivisionError, ValueError):
        return None


def compute_ratios(f):
    """由单期科目字典计算指标，返回 {指标名: 小数值或 None}。"""
    get = f.get
    revenue = get("revenue")
    cogs = get("cost_of_sales")
    gross = get("gross_profit")
    if gross is None:
        gross = _sub(revenue, cogs)
    net_profit = get("net_profit")
    net_attr = get("net_profit_attributable", net_profit)
    total_assets = get("total_assets")
    total_liab = get("total_liabilities")
    total_equity = get("total_equity")
    if total_equity is None:
        total_equity = _sub(total_assets, total_liab)
    equity_attr = get("equity_attributable", total_equity)
    current_assets = get("current_assets")
    current_liab = get("current_liabilities")
    inventory = get("inventory")

    r = {}
    # 盈利能力
    r["gross_margin"] = _safe_div(gross, revenue)
    r["operating_margin"] = _safe_div(get("operating_profit"), revenue)
    r["net_margin"] = _safe_div(net_profit, revenue)
    r["roe"] = _safe_div(net_attr, equity_attr)            # 归母口径 ROE
    r["roa"] = _safe_div(net_profit, total_assets)
    # 偿债能力
    r["debt_to_asset"] = _safe_div(total_liab, total_assets)
    r["current_ratio"] = _safe_div(current_assets, current_liab)
    r["quick_ratio"] = _safe_div(_sub(current_assets, inventory), current_liab)
    r["equity_multiplier"] = _safe_div(total_assets, equity_attr)
    r["interest_coverage"] = _safe_div(get("ebit"), get("interest_expense"))
    # 运营效率
    r["asset_turnover"] = _safe_div(revenue, total_assets)
    r["ar_turnover"] = _safe_div(revenue, get("accounts_receivable"))
    r["inventory_turnover"] = _safe_div(cogs, inventory)
    r["effective_tax_rate"] = _safe_div(get("tax"), get("ebt"))
    # 现金含量
    r["ocf_to_net_profit"] = _safe_div(get("operating_cash_flow"), net_profit)

    # 杜邦分解：ROE ≈ 净利率 × 总资产周转率 × 权益乘数
    dupont_nm = _safe_div(net_profit, revenue)
    r["dupont_net_margin"] = dupont_nm
    r["dupont_asset_turnover"] = r["asset_turnover"]
    r["dupont_equity_multiplier"] = r["equity_multiplier"]
    if None not in (dupont_nm, r["asset_turnover"], r["equity_multiplier"]):
        r["dupont_roe"] = dupont_nm * r["asset_turnover"] * r["equity_multiplier"]
    else:
        r["dupont_roe"] = None
    return r


def yoy_table(current, previous):
    """两期科目字典对比，返回 {科目: {current, previous, delta, growth}}。"""
    out = {}
    for key in current:
        if key in previous:
            out[key] = {
                "current": current[key],
                "previous": previous[key],
                "delta": _sub(current[key], previous[key]),
                "growth": growth(current[key], previous[key]),
            }
    return out


def fmt_pct(value, digits=1):
    """小数转百分数字符串；None -> 'N/A'。"""
    if value is None:
        return "N/A"
    return format(value * 100, "." + str(digits) + "f") + "%"


def fmt_num(value, digits=2):
    """数值格式化（千分位）；None -> 'N/A'。"""
    if value is None:
        return "N/A"
    return format(value, ",." + str(digits) + "f")


if __name__ == "__main__":
    cur = {
        "revenue": 1200, "cost_of_sales": 800, "operating_profit": 200,
        "ebit": 210, "ebt": 190, "tax": 40, "net_profit": 150,
        "net_profit_attributable": 140, "interest_expense": 20,
        "total_assets": 2000, "total_liabilities": 1200,
        "equity_attributable": 800, "current_assets": 900,
        "current_liabilities": 500, "inventory": 200,
        "accounts_receivable": 300, "operating_cash_flow": 170,
    }
    prev = {"revenue": 1000, "net_profit": 120, "total_assets": 1800}
    ratios = compute_ratios(cur)
    print("毛利率 =", fmt_pct(ratios["gross_margin"]))
    print("净利率 =", fmt_pct(ratios["net_margin"]))
    print("ROE   =", fmt_pct(ratios["roe"]))
    print("资产负债率 =", fmt_pct(ratios["debt_to_asset"]))
    print("杜邦 ROE =", fmt_pct(ratios["dupont_roe"]),
          "= 净利率", fmt_pct(ratios["dupont_net_margin"]),
          "× 周转", fmt_num(ratios["dupont_asset_turnover"]),
          "× 乘数", fmt_num(ratios["dupont_equity_multiplier"]))
    print("营收同比 =", fmt_pct(growth(cur["revenue"], prev["revenue"])))
