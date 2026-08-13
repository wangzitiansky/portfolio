package main

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// QuoteDetail is intentionally an API-only view. It does not change Holding or
// the SQLite schema; the frontend may discard it whenever the popup closes.
type QuoteDetail struct {
	Code       string       `json:"code"`
	Market     string       `json:"market"`
	Name       string       `json:"name"`
	Price      float64      `json:"price"`
	Change     float64      `json:"change"`
	ChangePct  float64      `json:"changePct"`
	Currency   string       `json:"currency"`
	Exchange   string       `json:"exchange"`
	TS         int64        `json:"ts"`
	Open       *float64     `json:"open"`
	High       *float64     `json:"high"`
	Low        *float64     `json:"low"`
	Volume     *float64     `json:"volume"`
	PE         *float64     `json:"pe"`
	MarketCap  *float64     `json:"marketCap"`
	Week52High *float64     `json:"week52High"`
	Week52Low  *float64     `json:"week52Low"`
	Points     []QuotePoint `json:"points"`
	Range      string       `json:"range"`
	Stale      bool         `json:"stale"`
}

type QuotePoint struct {
	Time  int64   `json:"time"`
	Value float64 `json:"value"`
}

func handleQuoteDetail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "GET only"})
		return
	}
	market, code := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("market"))), strings.TrimSpace(r.URL.Query().Get("code"))
	if !validQuoteMarketCode(market, code) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "不支持的 market/code"})
		return
	}
	rng := r.URL.Query().Get("range")
	if !validQuoteRange(rng) {
		rng = "1D"
	}
	detail := buildQuoteDetail(market, code, rng)
	writeJSON(w, http.StatusOK, detail)
}

func validQuoteRange(v string) bool {
	switch v {
	case "1D", "1M", "3M", "1Y", "5Y", "10Y", "YTD":
		return true
	}
	return false
}

func validQuoteMarketCode(market, code string) bool {
	return ((market == "sh" || market == "sz") && aShareCodeRe.MatchString(code)) ||
		(market == "hk" && hkCodeRe.MatchString(code)) || (market == "us" && usCodeRe.MatchString(code))
}

func buildQuoteDetail(market, code, rng string) QuoteDetail {
	d := QuoteDetail{Code: code, Market: market, Currency: map[string]string{"us": "USD", "hk": "HKD"}[market], Exchange: map[string]string{"sh": "SSE", "sz": "SZSE", "hk": "HKEX", "us": "NYSE/NASDAQ"}[market], Range: rng}
	if d.Currency == "" {
		d.Currency = "CNY"
	}
	if market != "us" {
		if q, ok := fetchQuotes([]struct{ Market, Code string }{{market, code}})[market+code]; ok {
			d.Name, d.Price, d.Change, d.ChangePct, d.TS = q.Name, q.Price, q.Change, q.ChangePct, q.TS
			if q.Currency != "" {
				d.Currency = q.Currency
			}
		}
	} else if q, ok := fetchEastmoneyQuote(code); ok {
		d.Name, d.Price, d.Change, d.ChangePct, d.TS = q.Name, q.Price, q.Change, q.ChangePct, q.TS
		d.Currency, d.Exchange = "USD", q.Exchange
		d.Open, d.High, d.Low, d.Volume = q.Open, q.High, q.Low, q.Volume
	}
	d.Stale = d.TS == 0 || nowMs()-d.TS > 120000
	points, latest := fetchQuoteSeries(market, code, rng)
	d.Points = points
	if latest.Open != nil {
		d.Open = latest.Open
	}
	if latest.High != nil {
		d.High = latest.High
	}
	if latest.Low != nil {
		d.Low = latest.Low
	}
	if latest.Volume != nil {
		d.Volume = latest.Volume
	}
	if len(points) > 0 && d.TS == 0 {
		d.TS = points[len(points)-1].Time
	}
	applyQuoteMetrics(&d, market, code)
	return d
}

type parsedPoint struct {
	QuotePoint
	Open, High, Low, Volume *float64
}

func fetchQuoteSeries(market, code, rng string) ([]QuotePoint, parsedPoint) {
	if market == "us" {
		if points, ok := fetchEastmoneySeries(code, rng); ok {
			return points, parsedPoint{}
		}
		return nil, parsedPoint{}
	}
	if rng == "1D" {
		if points, ok := fetchRealtimeMinuteSeries(market, code); ok {
			return points, parsedPoint{}
		}
	}
	period, limit := "day", 370
	if rng == "1D" {
		period = "min"
	} else if rng == "1M" {
		limit = 35
	} else if rng == "3M" {
		limit = 100
	} else if rng == "1Y" {
		limit = 370
	} else if rng == "5Y" {
		limit = 2000
	} else if rng == "10Y" {
		limit = 4000
	}
	param := url.QueryEscape(fmt.Sprintf("%s%s,%s,,,%d", market, code, period, limit))
	req, err := http.NewRequest(http.MethodGet, "https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param="+param, nil)
	if err != nil {
		return nil, parsedPoint{}
	}
	req.Header.Set("User-Agent", "Mozilla/5.0")
	resp, err := quoteHTTPClient.Do(req)
	if err != nil {
		return nil, parsedPoint{}
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, parsedPoint{}
	}
	var envelope struct {
		Data map[string]map[string]json.RawMessage `json:"data"`
	}
	if json.Unmarshal(body, &envelope) != nil {
		return nil, parsedPoint{}
	}
	var rows [][]any
	if item := envelope.Data[market+code][period]; len(item) > 0 {
		_ = json.Unmarshal(item, &rows)
	}
	if len(rows) > limit && limit > 0 {
		rows = rows[len(rows)-limit:]
	}
	out := make([]QuotePoint, 0, len(rows))
	var latest parsedPoint
	for _, row := range rows {
		p, ok := parseQuoteRow(row)
		if !ok {
			continue
		}
		out = append(out, p.QuotePoint)
		latest = p
	}
	// 行情源偶尔只给出一条远古复权基准和当日数据。它不是连续走势图，
	// 不能绘制成看似真实的 1W/1M 等历史曲线。
	if len(out) >= 2 && out[len(out)-1].Time-out[0].Time > int64(370*24*time.Hour/time.Millisecond) && len(out) <= 2 {
		out = nil
	}
	return out, latest
}

func eastmoneySymbol(code string) string {
	return strings.ReplaceAll(strings.ToUpper(strings.TrimSpace(code)), ".", "_")
}

type eastmoneyQuote struct {
	Name, Exchange           string
	Price, Change, ChangePct float64
	TS                       int64
	Open, High, Low, Volume  *float64
}

func fetchEastmoneyQuote(code string) (eastmoneyQuote, bool) {
	for _, prefix := range []string{"106.", "105."} {
		for _, host := range []string{"push2.eastmoney.com", "push2delay.eastmoney.com", "push2his.eastmoney.com"} {
			ep := fmt.Sprintf("https://%s/api/qt/stock/get?secid=%s%s&fields=f43,f57,f58,f46,f44,f45,f47,f48,f49,f116,f169,f170", host, prefix, url.QueryEscape(eastmoneySymbol(code)))
			resp, err := quoteHTTPClient.Get(ep)
			if err != nil {
				continue
			}
			var root struct {
				Data map[string]any `json:"data"`
			}
			ok := resp.StatusCode == http.StatusOK && json.NewDecoder(resp.Body).Decode(&root) == nil
			resp.Body.Close()
			if !ok || root.Data == nil {
				continue
			}
			num := func(k string) float64 { v, _ := root.Data[k].(float64); return v }
			price := num("f43") / 1000
			if price <= 0 {
				continue
			}
			change := num("f169") / 1000
			pct := num("f170") / 100
			ptr := func(k string, scale float64) *float64 {
				v := num(k) / scale
				if v <= 0 {
					return nil
				}
				return &v
			}
			return eastmoneyQuote{Name: fmt.Sprint(root.Data["f58"]), Exchange: map[string]string{"106.": "NYSE", "105.": "NASDAQ"}[prefix], Price: price, Change: change, ChangePct: pct, TS: time.Now().UnixMilli(), Open: ptr("f46", 1000), High: ptr("f44", 1000), Low: ptr("f45", 1000), Volume: ptr("f47", 1)}, true
		}
	}
	return eastmoneyQuote{}, false
}

// fetchEastmoneySeries supports current-day intraday trends and daily history.
// US exchange prefixes are 106 (NYSE) and 105 (NASDAQ); trying both keeps the
// endpoint useful for symbols whose exchange is not known by the holding.
func fetchEastmoneySeries(code, rng string) ([]QuotePoint, bool) {
	symbol := eastmoneySymbol(code)
	if rng == "1D" {
		for _, host := range []string{"push2.eastmoney.com", "push2delay.eastmoney.com", "push2his.eastmoney.com"} {
			ep := "https://" + host + "/api/qt/stock/trends2/get?secid=106." + url.QueryEscape(symbol) + "&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=1"
			if points, ok := parseEastmoneyTrends(ep); ok {
				return points, true
			}
			ep = strings.Replace(ep, "106.", "105.", 1)
			if points, ok := parseEastmoneyTrends(ep); ok {
				return points, true
			}
		}
		return nil, false
	}
	limit := 4000
	switch rng {
	case "1M":
		limit = 35
	case "3M":
		limit = 100
	case "1Y":
		limit = 370
	case "5Y":
		limit = 2000
	case "10Y":
		limit = 4000
	case "YTD":
		limit = 4000
	}
	for _, prefix := range []string{"106.", "105."} {
		for _, host := range []string{"push2.eastmoney.com", "push2delay.eastmoney.com", "push2his.eastmoney.com"} {
			ep := fmt.Sprintf("https://%s/api/qt/stock/kline/get?secid=%s%s&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58&klt=101&fqt=1&end=20500101&lmt=%d", host, prefix, url.QueryEscape(symbol), limit)
			if points, ok := parseEastmoneyKlines(ep); ok {
				return points, true
			}
		}
	}
	return nil, false
}

func parseEastmoneyTrends(endpoint string) ([]QuotePoint, bool) {
	resp, err := quoteHTTPClient.Get(endpoint)
	if err != nil {
		return nil, false
	}
	defer resp.Body.Close()
	var root struct {
		Data struct {
			Trends []string `json:"trends"`
		} `json:"data"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&root) != nil {
		return nil, false
	}
	out := make([]QuotePoint, 0, len(root.Data.Trends))
	for _, row := range root.Data.Trends {
		f := strings.Split(row, ",")
		if len(f) < 2 {
			continue
		}
		ts := parseEastmoneyTime(f[0])
		v, e := strconv.ParseFloat(f[1], 64)
		if ts > 0 && e == nil && v > 0 {
			out = append(out, QuotePoint{Time: ts, Value: v})
		}
	}
	return out, len(out) > 0
}

func parseEastmoneyTime(v string) int64 {
	if ny, err := time.LoadLocation("America/New_York"); err == nil {
		for _, layout := range []string{"2006-01-02 15:04", "2006-01-02 15:04:05"} {
			if t, e := time.ParseInLocation(layout, v, ny); e == nil {
				return t.UnixMilli()
			}
		}
	}
	return parseSeriesTime(v)
}

func parseEastmoneyKlines(endpoint string) ([]QuotePoint, bool) {
	resp, err := quoteHTTPClient.Get(endpoint)
	if err != nil {
		return nil, false
	}
	defer resp.Body.Close()
	var root struct {
		Data struct {
			Klines []string `json:"klines"`
		} `json:"data"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&root) != nil {
		return nil, false
	}
	out := make([]QuotePoint, 0, len(root.Data.Klines))
	for _, row := range root.Data.Klines {
		f := strings.Split(row, ",")
		if len(f) < 3 {
			continue
		}
		ts := parseSeriesTime(f[0])
		v, e := strconv.ParseFloat(f[2], 64) // close
		if ts > 0 && e == nil && v > 0 {
			out = append(out, QuotePoint{Time: ts, Value: v})
		}
	}
	return out, len(out) > 0
}

// fetchRealtimeMinuteSeries returns only today's intraday points. The source
// covers full A-share/ETF sessions and falls back to the latest point for
// markets where it does not publish a complete intraday tape.
func fetchRealtimeMinuteSeries(market, code string) ([]QuotePoint, bool) {
	req, err := http.NewRequest(http.MethodGet, "https://web.ifzq.gtimg.cn/appstock/app/minute/query?code="+url.QueryEscape(market+code), nil)
	if err != nil {
		return nil, false
	}
	req.Header.Set("User-Agent", "Mozilla/5.0")
	resp, err := quoteHTTPClient.Do(req)
	if err != nil {
		return nil, false
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, false
	}
	var envelope struct {
		Data map[string]json.RawMessage `json:"data"`
	}
	if json.Unmarshal(body, &envelope) != nil {
		return nil, false
	}
	var payload struct {
		Data struct {
			Data []string `json:"data"`
			Date string   `json:"date"`
		} `json:"data"`
		QT map[string][]any `json:"qt"`
	}
	if json.Unmarshal(envelope.Data[market+code], &payload) != nil {
		return nil, false
	}
	date := payload.Data.Date
	if len(date) == 8 {
		date = date[:4] + "-" + date[4:6] + "-" + date[6:8]
	}
	if date == "" && len(payload.QT[market+code]) > 30 {
		date = strings.TrimSpace(fmt.Sprint(payload.QT[market+code][30]))
		if len(date) == 8 {
			date = date[:4] + "-" + date[4:6] + "-" + date[6:8]
		}
		if len(date) >= 10 {
			date = date[:10]
		}
	}
	loc := time.FixedZone("CST", 8*3600)
	if market == "us" {
		if ny, e := time.LoadLocation("America/New_York"); e == nil {
			loc = ny
		}
	}
	points := make([]QuotePoint, 0, len(payload.Data.Data))
	for _, row := range payload.Data.Data {
		fields := strings.Fields(row)
		if len(fields) < 2 || len(date) != 10 || len(fields[0]) != 4 {
			continue
		}
		value, e := strconv.ParseFloat(fields[1], 64)
		if e != nil || value <= 0 {
			continue
		}
		t, e := time.ParseInLocation("2006-01-02 1504", date+" "+fields[0], loc)
		if e == nil {
			points = append(points, QuotePoint{Time: t.UnixMilli(), Value: value})
		}
	}
	return points, true
}

func parseQuoteRow(row []any) (parsedPoint, bool) {
	if len(row) < 2 {
		return parsedPoint{}, false
	}
	ts := parseSeriesTime(fmt.Sprint(row[0]))
	if ts == 0 {
		return parsedPoint{}, false
	}
	vals := make([]float64, len(row)-1)
	for i := 1; i < len(row); i++ {
		vals[i-1], _ = strconv.ParseFloat(strings.TrimSpace(fmt.Sprint(row[i])), 64)
	}
	closeVal := vals[0]
	p := parsedPoint{QuotePoint: QuotePoint{Time: ts, Value: closeVal}}
	if len(vals) >= 5 {
		p.Open = floatPtr(vals[0])
		p.QuotePoint.Value = vals[1]
		p.High = floatPtr(vals[2])
		p.Low = floatPtr(vals[3])
		p.Volume = floatPtr(vals[4])
	}
	return p, math.IsNaN(p.Value) == false && math.IsInf(p.Value, 0) == false
}
func floatPtr(v float64) *float64 { return &v }
func parseSeriesTime(v string) int64 {
	for _, f := range []string{"2006-01-02 15:04", "2006-01-02 15:04:05", "2006-01-02", "20060102150405"} {
		if t, e := time.ParseInLocation(f, v, time.Local); e == nil {
			return t.UnixMilli()
		}
	}
	return 0
}

// 腾讯行情详情的 qt 数组包含估值和 52 周区间；这些字段不在基础 Quote 中。
// 只映射已核对过的下标，其他不确定字段保持 null，避免展示误导性数据。
func applyQuoteMetrics(d *QuoteDetail, market, code string) {
	if market == "us" {
		return
	}
	url := "https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=" + url.QueryEscape(fmt.Sprintf("%s%s,day,,,1", market, code))
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return
	}
	req.Header.Set("User-Agent", "Mozilla/5.0")
	resp, err := quoteHTTPClient.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return
	}
	var envelope struct {
		Data map[string]json.RawMessage `json:"data"`
	}
	if json.Unmarshal(body, &envelope) != nil {
		return
	}
	var payload struct {
		QT map[string][]any `json:"qt"`
	}
	if json.Unmarshal(envelope.Data[market+code], &payload) != nil {
		return
	}
	qt := payload.QT[market+code]
	if len(qt) == 0 {
		return
	}
	value := func(i int) *float64 {
		if i >= len(qt) {
			return nil
		}
		v, err := strconv.ParseFloat(strings.TrimSpace(fmt.Sprint(qt[i])), 64)
		if err != nil || v <= 0 || math.IsNaN(v) || math.IsInf(v, 0) {
			return nil
		}
		return &v
	}
	if d.Open == nil {
		d.Open = value(5)
	}
	if d.High == nil {
		d.High = value(33)
	}
	if d.Low == nil {
		d.Low = value(34)
	}
	if d.Volume == nil {
		d.Volume = value(36)
	}
	d.PE = value(39)
	d.Week52High = value(48)
	d.Week52Low = value(49)
	if cap := value(45); cap != nil {
		scaled := *cap * 100000000
		d.MarketCap = &scaled
	}
}

func isTradeableHolding(market, typ string) bool {
	if typ == "stock" {
		return market == "sh" || market == "sz" || market == "hk" || market == "us"
	}
	return (market == "sh" || market == "sz") && (typ == "etf" || typ == "fund" || typ == "money")
}

func isMarketOpenAt(market string, now time.Time) bool {
	var loc *time.Location
	switch market {
	case "sh", "sz":
		loc = time.FixedZone("CST", 8*3600)
	case "hk":
		loc = time.FixedZone("HKT", 8*3600)
	case "us":
		loc, _ = time.LoadLocation("America/New_York")
	default:
		return false
	}
	t := now.In(loc)
	if t.Weekday() == time.Saturday || t.Weekday() == time.Sunday {
		return false
	}
	mins := t.Hour()*60 + t.Minute()
	switch market {
	case "sh", "sz":
		return (mins >= 570 && mins < 690) || (mins >= 780 && mins < 900)
	case "hk":
		return (mins >= 570 && mins < 720) || (mins >= 780 && mins < 960)
	case "us":
		return mins >= 570 && mins < 960
	}
	return false
}
