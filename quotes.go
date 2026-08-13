package main

import (
	"io"
	"log"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/transform"
)

const qtURL = "https://qt.gtimg.cn/q="
const qtTimeout = 8
const maxPerURL = 50

var (
	qtLineRe = regexp.MustCompile(`v_([^=]+)="([^"]*)"`)

	// 行情缓存：短期 TTL 避免自动刷新重复拉取
	quoteCache    = map[string]quoteCacheEntry{}
	quoteCacheMu  sync.Mutex
	quoteCacheTTL = 10 * time.Second
)

type quoteCacheEntry struct {
	quote     Quote
	fetchedAt time.Time
}

var quoteHTTPClient = &http.Client{Timeout: time.Duration(qtTimeout) * time.Second}

func fetchQuotes(items []struct{ Market, Code string }) map[string]Quote {
	if len(items) == 0 {
		return map[string]Quote{}
	}

	// 去重
	seen := map[string]bool{}
	var unique []struct{ Market, Code string }
	for _, it := range items {
		k := it.Market + it.Code
		if !seen[k] {
			seen[k] = true
			unique = append(unique, it)
		}
	}

	results := map[string]Quote{}

	for i := 0; i < len(unique); i += maxPerURL {
		end := i + maxPerURL
		if end > len(unique) {
			end = len(unique)
		}
		batch := unique[i:end]
		batchResults := fetchBatch(batch)
		for k, v := range batchResults {
			results[k] = v
		}
	}
	return results
}

func fetchBatch(items []struct{ Market, Code string }) map[string]Quote {
	now := time.Now()

	// 分离已缓存和需拉取的代码
	codes := make([]string, 0, len(items))
	itemByVarName := map[string]struct{ Market, Code string }{}
	results := map[string]Quote{}

	quoteCacheMu.Lock()
	for _, it := range items {
		key := it.Market + it.Code
		if cached, ok := quoteCache[key]; ok && now.Sub(cached.fetchedAt) < quoteCacheTTL {
			results[key] = cached.quote
		} else {
			codes = append(codes, key)
			itemByVarName[key] = it
			itemByVarName[strings.ToLower(key)] = it
		}
	}
	quoteCacheMu.Unlock()

	// 全部命中缓存，跳过 HTTP
	if len(codes) == 0 {
		return results
	}

	url := qtURL + strings.Join(codes, ",")

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		log.Printf("[quotes] build request error: %v", err)
		return results
	}
	req.Header.Set("User-Agent", "Mozilla/5.0")
	req.Header.Set("Referer", "https://gu.qq.com/")

	start := time.Now()
	resp, err := quoteHTTPClient.Do(req)
	if err != nil {
		log.Printf("[quotes] HTTP error (%d codes): %v", len(codes), err)
		return results
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		log.Printf("[quotes] bad status %d (%d codes)", resp.StatusCode, len(codes))
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Printf("[quotes] read body error: %v", err)
		return results
	}
	text := decodeGBK(body)

	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		m := qtLineRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		varName := strings.ToLower(m[1])
		value := m[2]

		it, ok := itemByVarName[varName]
		if !ok {
			continue
		}
		key := it.Market + it.Code
		q := parseByMarket(it.Market, it.Code, value)
		if q != nil {
			results[key] = *q
		}
	}

	parsed := 0
	for _, it := range items {
		if _, ok := results[it.Market+it.Code]; ok {
			parsed++
		}
	}
	log.Printf("[quotes] %d/%d OK (%dms)", parsed, len(items), time.Since(start).Milliseconds())

	// 写入缓存
	quoteCacheMu.Lock()
	for k, q := range results {
		quoteCache[k] = quoteCacheEntry{quote: q, fetchedAt: now}
	}
	quoteCacheMu.Unlock()

	return results
}

func decodeGBK(data []byte) string {
	reader := transform.NewReader(strings.NewReader(string(data)), simplifiedchinese.GBK.NewDecoder())
	decoded, err := io.ReadAll(reader)
	if err != nil {
		return string(data) // fallback: return raw if decode fails
	}
	return string(decoded)
}

func parseByMarket(market, code, line string) *Quote {
	parts := strings.Split(line, "~")
	if len(parts) < 33 {
		return nil
	}
	switch market {
	case "sh", "sz":
		return parseAShare(market, code, parts)
	case "us":
		return parseUS(market, code, parts)
	case "hk":
		return parseHK(market, code, parts)
	}
	return nil
}

func parseAShare(market, code string, p []string) *Quote {
	price := parseNum(p[3])
	if price == 0 {
		return nil
	}
	return &Quote{
		Code: code, Market: market, Name: p[1], Price: price,
		Change: parseNum(p[31]), ChangePct: parsePct(p[32], true),
		Currency: "CNY", TS: parseTs(p[30]),
	}
}

func parseUS(market, code string, p []string) *Quote {
	price := parseNum(p[3])
	if price == 0 {
		return nil
	}
	currency := "USD"
	if len(p) > 35 {
		cur := strings.ToUpper(p[35])
		if cur == "USD" || cur == "HKD" {
			currency = cur
		}
	}
	return &Quote{
		Code: code, Market: market, Name: p[1], Price: price,
		Change: parseNum(p[31]), ChangePct: parsePct(p[32], false),
		Currency: currency, TS: parseUSTs(p[30]),
	}
}

func parseHK(market, code string, p []string) *Quote {
	// 腾讯港股响应与 A/美股一样，p[3] 是现价；p[29] 是成交量。
	price := parseNum(p[3])
	if price == 0 {
		return nil
	}
	currency := "HKD"
	for i := 34; i <= 37 && i < len(p); i++ {
		v := strings.ToUpper(p[i])
		if v == "HKD" || v == "USD" {
			currency = v
			break
		}
	}
	return &Quote{
		Code: code, Market: market, Name: p[1], Price: price,
		Change: parseNum(p[31]), ChangePct: parsePct(p[32], false),
		Currency: currency, TS: parseMarketTs(p[30], time.FixedZone("CST", 8*3600)),
	}
}

func parseNum(s string) float64 {
	s = strings.ReplaceAll(s, "%", "")
	s = strings.TrimSpace(s)
	v, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return v
}

func parsePct(s string, normalizeInt bool) float64 {
	s = strings.ReplaceAll(s, "%", "")
	s = strings.TrimSpace(s)
	v, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	// normalizeInt: sh/sz 市场 API 返回的是百分比×100 的整数（如 "125" = 1.25%）
	// us/hk 市场返回的是实际百分比（如 "1.25" = 1.25%），无需归一化
	if normalizeInt && !strings.Contains(s, ".") {
		v /= 100
	}
	return v
}

func parseTs(s string) int64 {
	return parseMarketTs(s, time.FixedZone("CST", 8*3600))
}

func parseUSTs(s string) int64 {
	// 腾讯美股报价时间采用纽约本地时间；不能按运行机器所在时区解析，
	// 否则在中国部署时会将实时行情错误标记为过期约 8 小时。
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		loc = time.FixedZone("EST", -5*3600)
	}
	return parseMarketTs(s, loc)
}

func parseMarketTs(s string, loc *time.Location) int64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	formats := []string{"20060102150405", "2006/01/02 15:04:05", "2006-01-02 15:04:05", "2006-01-02"}
	for _, format := range formats {
		t, err := time.ParseInLocation(format, s, loc)
		if err == nil {
			return t.UnixMilli()
		}
	}
	// 未知格式不能伪装成“刚刚更新”；返回 0 会让 stale 判定生效。
	return 0
}
