#!/usr/bin/env python3
"""每日净值记录脚本 — 供 hermes/cron 调度执行

用法:
  python3 record-nav.py <holdings.json> [output.json]

  - holdings.json: 持仓数据（与前端 data.json 同格式）
  - output.json: 输出文件，默认 nav-record.json
    输出格式: {"date":"2026-08-10","total":131594.59,"todayPnl":177.74,"todayPnlPct":0.13,"count":15}

依赖: 仅 Python 3 标准库，无需 pip install
"""
import json, sys, os, time, re, math
import urllib.request, concurrent.futures

# ═══════════════════════════════════════════
# 行情拉取（腾讯 API，纯 HTTP）
# ═══════════════════════════════════════════

QT_URL = 'https://qt.gtimg.cn/q='
QT_TIMEOUT = 8
MAX_PER_URL = 50

def fetch_quotes(items):
    """批量拉行情，返回 {market+code: {price,change,changePct,name,ts,currency}}"""
    if not items: return {}
    seen = set()
    unique = []
    for it in items:
        k = it['market'] + it['code']
        if k not in seen:
            seen.add(k)
            unique.append(it)

    results = {}
    for i in range(0, len(unique), MAX_PER_URL):
        batch = unique[i:i + MAX_PER_URL]
        try:
            results.update(_fetch_batch(batch))
        except Exception as e:
            print(f'[quotes] batch error: {e}', flush=True)
    return results

def _fetch_batch(items):
    codes = ','.join(it['market'] + it['code'] for it in items)
    # 预建 var_name → item 映射，避免 O(n²) 线性扫描
    by_var = {}
    for it in items:
        key = it['market'] + it['code']
        by_var[key] = it
        by_var[key.lower()] = it

    req = urllib.request.Request(f'{QT_URL}{codes}')
    req.add_header('User-Agent', 'Mozilla/5.0')
    req.add_header('Referer', 'https://gu.qq.com/')
    with urllib.request.urlopen(req, timeout=QT_TIMEOUT) as resp:
        text = resp.read().decode('gbk', errors='replace')

    results = {}
    for line in text.strip().split('\n'):
        m = re.match(r'v_([^=]+)="([^"]*)"\s*;?\s*$', line.strip())
        if not m: continue
        var_name, value = m.group(1), m.group(2)
        it = by_var.get(var_name) or by_var.get(var_name.lower())
        if not it: continue
        key = it['market'] + it['code']
        q = _parse(it['market'], it['code'], value)
        if q: results[key] = q
    return results

def _parse(market, code, line):
    p = line.split('~')
    if len(p) < 33: return None
    if market in ('sh', 'sz'): return _ashare(code, market, p)
    if market == 'us': return _ushare(code, market, p)
    if market == 'hk': return _hkshare(code, market, p)
    return None

def _ashare(code, market, p):
    price = _num(p[3])
    if not price: return None
    return {'code':code,'market':market,'name':p[1],'price':price,
            'change':_num(p[31]),'changePct':_pct(p[32], normalize=True),
            'currency':'CNY','ts':_ts14(p[30])}

def _ushare(code, market, p):
    price = _num(p[3])
    if not price: return None
    currency = 'USD'
    if len(p) > 35 and p[35]:
        cur = p[35].upper()
        if cur in ('USD','HKD'): currency = cur
    return {'code':code,'market':market,'name':p[1],'price':price,
            'change':_num(p[31]),'changePct':_pct(p[32], normalize=False),
            'currency':currency,'ts':_date_ts(p[30])}

def _hkshare(code, market, p):
    price = _num(p[29])
    if not price: return None
    currency = 'HKD'
    for i in range(34, min(38, len(p))):
        v = (p[i] or '').upper()
        if v in ('HKD','USD'): currency = v; break
    return {'code':code,'market':market,'name':p[1],'price':price,
            'change':_num(p[31]),'changePct':_pct(p[32], normalize=False),
            'currency':currency,'ts':_ts14(p[30])}

# ═══════════════════════════════════════════
# 汇率拉取（双源竞速）
# ═══════════════════════════════════════════

FX_TIMEOUT = 10
FX_FALLBACK = {'USD':1, 'CNY':7.20, 'HKD':7.82}

def get_fx_rates():
    def _fetch(url):
        req = urllib.request.Request(url)
        req.add_header('User-Agent', 'Mozilla/5.0')
        with urllib.request.urlopen(req, timeout=FX_TIMEOUT) as resp:
            data = json.loads(resp.read())
            return data.get('rates', {})
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
        fs = [ex.submit(_fetch, 'https://open.er-api.com/v6/latest/USD'),
              ex.submit(_fetch_fb, 'https://api.frankfurter.dev/v1/latest?from=USD')]
        for f in concurrent.futures.as_completed(fs):
            try:
                rates = f.result()
                if rates: return rates
            except: pass
    return FX_FALLBACK

def _fetch_fb(url):
    rates = None
    req = urllib.request.Request(url)
    req.add_header('User-Agent', 'Mozilla/5.0')
    with urllib.request.urlopen(req, timeout=FX_TIMEOUT) as resp:
        data = json.loads(resp.read())
        rates = data.get('rates', {})
    if rates: rates['USD'] = 1
    return rates

# ═══════════════════════════════════════════
# 场外基金净值拉取
# ═══════════════════════════════════════════

NAV_TIMEOUT = 8

def fetch_fund_navs(codes):
    if not codes: return {}
    results = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as ex:
        fs = {ex.submit(_nav_one, c): c for c in codes}
        for f in concurrent.futures.as_completed(fs):
            try:
                nav = f.result()
                if nav: results[fs[f]] = nav
            except: pass
    return results

def _nav_one(code):
    # 只走 history API 即可获得最新净值 + 涨跌（无需 suggest）
    try:
        hurl = f'https://api.fund.eastmoney.com/f10/lsjz?fundCode={code}&pageIndex=1&pageSize=2'
        hreq = urllib.request.Request(hurl)
        hreq.add_header('User-Agent', 'Mozilla/5.0')
        hreq.add_header('Referer', 'https://fund.eastmoney.com/')
        with urllib.request.urlopen(hreq, timeout=NAV_TIMEOUT) as hresp:
            htext = hresp.read().decode('utf-8', errors='replace')
        m = re.search(r'\{.*\}', htext, re.DOTALL)
        if not m:
            return None
        hdata = json.loads(m.group())
        items = hdata.get('Data', {}).get('LSJZList', [])
        if not items:
            return None
        nav = float(items[0]['DWJZ'])
        nav_date = items[0].get('FSRQ', '')
        if nav <= 0:
            return None

        change, change_pct = 0, 0
        if len(items) >= 2:
            a, b = nav, float(items[1]['DWJZ'])
            if a > 0 and b > 0:
                change = a - b
                change_pct = (change / b) * 100
    except Exception:
        return None

    return {'nav': nav, 'navDate': nav_date, 'change': change, 'changePct': change_pct}

# ═══════════════════════════════════════════
# 核心计算（对标 compute.py/enrich + KPI）
# ═══════════════════════════════════════════

def compute(holdings, quotes, fx_rates, nav_map):
    rows = []
    for h in holdings:
        qkey = h['market'] + h['code']
        quote = quotes.get(qkey)
        nav = nav_map.get(h['code']) if h['market'] == 'of' else None
        rows.append(_enrich(h, quote, fx_rates, nav))
    kpi = _calc_kpis(rows, fx_rates)
    return rows, kpi

def _enrich(h, quote, fx, nav):
    qty = float(h.get('quantity', 0))
    cost = float(h.get('cost', 0))
    currency = h.get('currency', 'CNY')
    market = h.get('market', '')

    # price
    price = None
    if market == 'of':
        price = nav['nav'] if nav and nav.get('nav') else cost
    elif market == 'manual':
        pass
    elif quote:
        price = quote.get('price')

    use_price = price if price is not None else cost
    mv = use_price * qty
    mv_cny = _to_cny(mv, currency, fx)

    pnl = (price - cost) * qty if price is not None else 0
    pnl_pct = ((price - cost) / cost) * 100 if cost > 0 and price is not None else 0

    change = 0
    change_pct = 0
    if quote:
        change = quote.get('change', 0) or 0
        change_pct = quote.get('changePct', 0) or 0
    elif nav:
        change = nav.get('change', 0) or 0
        change_pct = nav.get('changePct', 0) or 0

    return {**h, 'marketValueCNY': mv_cny, 'pnl': pnl, 'change': change,
            'changePct': change_pct, 'quantity': qty, 'currency': currency}

def _calc_kpis(rows, fx):
    total = sum(r.get('marketValueCNY', 0) or 0 for r in rows)
    rates = fx or FX_FALLBACK
    usd_rate = rates.get('CNY', 6.5)
    hkd_rate = usd_rate / rates.get('HKD', 7.8) if rates.get('HKD') else 0.85

    today_pnl = 0
    total_pnl = 0
    for r in rows:
        cur = r.get('currency', 'CNY')
        chg = r.get('change', 0) or 0
        if chg:
            rate = usd_rate if cur == 'USD' else hkd_rate if cur == 'HKD' else 1
            today_pnl += chg * r.get('quantity', 0) * rate
        p = r.get('pnl', 0) or 0
        if p:
            rate = usd_rate if cur == 'USD' else hkd_rate if cur == 'HKD' else 1
            total_pnl += p * rate

    return {'total': total, 'todayPnl': today_pnl, 'totalPnl': total_pnl, 'count': len(rows)}

def _to_cny(amount, currency, fx):
    if currency == 'CNY': return amount
    if not fx: return 0
    rates = fx
    if currency == 'USD': return amount * rates.get('CNY', 6.5)
    if currency == 'HKD':
        hkd = rates.get('HKD', 7.8)
        return amount * rates.get('CNY', 6.5) / hkd if hkd else amount * 0.85
    return amount

def _num(s):
    try:
        v = float(str(s or '').replace('%','').strip())
        if math.isnan(v) or math.isinf(v):
            return 0
        return v
    except: return 0

def _pct(s, normalize=False):
    v = _num(s)
    # normalize: A 股市场 API 返回的是百分比×100 的整数（如 "125" = 1.25%），需归一化
    # 美股/港股返回的是实际百分比（如 "1.25" = 1.25%），无需归一化
    if normalize and '.' not in str(s or ''):
        v /= 100
    return v

def _ts14(s):
    if not s: return int(time.time() * 1000)
    try: return int(time.mktime(time.strptime(s, '%Y%m%d%H%M%S')) * 1000)
    except: return int(time.time() * 1000)

def _date_ts(s):
    if not s: return int(time.time() * 1000)
    try: return int(time.mktime(time.strptime(s, '%Y-%m-%d')) * 1000)
    except: return int(time.time() * 1000)

# ═══════════════════════════════════════════
# Main
# ═══════════════════════════════════════════

def main():
    if len(sys.argv) < 2:
        print(f'用法: {sys.argv[0]} <holdings.json> [output.json]', file=sys.stderr)
        print(f'示例: {sys.argv[0]} data.json nav-record.json', file=sys.stderr)
        sys.exit(1)

    holdings_file = sys.argv[1]
    output_file = sys.argv[2] if len(sys.argv) > 2 else 'nav-record.json'

    with open(holdings_file, 'r') as f:
        holdings = json.load(f)

    if not holdings:
        print('持仓为空，跳过', file=sys.stderr)
        return

    # 筛选需要拉取的数据
    non_manual = [h for h in holdings if h['market'] not in ('manual', 'of')]
    of_codes = [h['code'] for h in holdings if h['market'] == 'of']
    need_fx = any(h.get('currency') in ('USD', 'HKD') for h in holdings)

    print(f'持仓 {len(holdings)} 条, 行情 {len(non_manual)} 个, 场外 {len(of_codes)} 个', file=sys.stderr)

    # 并行拉取
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
        f_quotes = ex.submit(fetch_quotes, non_manual) if non_manual else None
        f_fx = ex.submit(get_fx_rates) if need_fx else None
        f_navs = ex.submit(fetch_fund_navs, of_codes) if of_codes else None

        quotes = f_quotes.result(timeout=15) if f_quotes else {}
        fx = f_fx.result(timeout=15) if f_fx else FX_FALLBACK
        navs = f_navs.result(timeout=15) if f_navs else {}

    # 计算
    _, kpi = compute(holdings, quotes, fx, navs)

    # 生成记录
    today = time.strftime('%Y-%m-%d')
    total = kpi['total']
    today_pnl = kpi['todayPnl']
    total_pnl = kpi['totalPnl']
    pnl_pct = (total_pnl / (total - total_pnl)) * 100 if total > 0 and total != total_pnl else 0

    record = {
        'date': today,
        'total': round(total, 2),
        'todayPnl': round(today_pnl, 2),
        'todayPnlPct': round(pnl_pct, 4),
        'count': kpi['count'],
    }

    with open(output_file, 'w') as f:
        json.dump(record, f, ensure_ascii=False, indent=2)

    print(f'✓ {today} 总资产 ¥{total:,.0f}  今日盈亏 {today_pnl:+,.0f} ({pnl_pct:+.2f}%)', file=sys.stderr)
    print(json.dumps(record, ensure_ascii=False))

if __name__ == '__main__':
    main()
