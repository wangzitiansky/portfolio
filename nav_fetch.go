package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	navHistoryURL = "https://api.fund.eastmoney.com/f10/lsjz"
	navTrendURL   = "https://fund.eastmoney.com/pingzhongdata/"
	navTimeout    = 8
	navMaxBody    = 8 << 20
)

var (
	navHTTPClient = &http.Client{Timeout: time.Duration(navTimeout) * time.Second}
	navTrendRe    = regexp.MustCompile(`(?s)\bData_netWorthTrend\s*=\s*(\[.*?\])\s*;`)
	navCodeRe     = regexp.MustCompile(`\bfS_code\s*=\s*["'](\d{6})["']`)
)

func fetchNav(code string) *NavResult {
	return fetchNavContext(context.Background(), code)
}

func fetchNavContext(parent context.Context, code string) *NavResult {
	start := time.Now()
	if !fundCodeRe.MatchString(code) {
		log.Printf("[nav] invalid fund code %q", code)
		return nil
	}
	ctx, cancel := context.WithTimeout(parent, time.Duration(navTimeout)*time.Second)
	defer cancel()

	var entries []navEntry
	var failures []string
	source := "history"
	for attempt := 1; attempt <= 2; attempt++ {
		attemptCtx, cancelAttempt := context.WithTimeout(ctx, 3*time.Second)
		var err error
		entries, err = fetchNavHistoryContext(attemptCtx, code, 2)
		cancelAttempt()
		if err == nil {
			break
		}
		failures = append(failures, fmt.Sprintf("history attempt %d: %v", attempt, err))
		if ctx.Err() != nil {
			break
		}
	}
	if len(entries) == 0 && ctx.Err() == nil {
		source = "published-trend"
		body, err := requestNavData(ctx, navTrendURL+code+".js")
		if err == nil {
			entries, err = parseNavTrend(body, code)
		}
		if err != nil {
			failures = append(failures, fmt.Sprintf("published-trend: %v", err))
		}
	}
	if len(entries) == 0 {
		log.Printf("[nav] %s failed: %s", code, strings.Join(failures, "; "))
		return nil
	}
	if len(failures) > 0 {
		log.Printf("[nav] %s recovered source=%s after %s", code, source, strings.Join(failures, "; "))
	}

	change, changePct := 0.0, 0.0
	if len(entries) >= 2 {
		latest := entries[0].Value
		prev := entries[1].Value
		if latest > 0 && prev > 0 {
			change = latest - prev
			changePct = (change / prev) * 100
		}
	}

	log.Printf("[nav] %s OK source=%s nav=%s %.4f chg=%+.2f%% (%dms)",
		code, source, entries[0].Date, entries[0].Value, changePct, time.Since(start).Milliseconds())

	return &NavResult{
		Nav:       entries[0].Date,
		NavPrice:  entries[0].Value,
		Change:    change,
		ChangePct: changePct,
	}
}

func fetchAllNavs(codes []string) map[string]*NavResult {
	return fetchAllNavsContext(context.Background(), codes)
}

func fetchAllNavsContext(ctx context.Context, codes []string) map[string]*NavResult {
	return fetchAllNavsWithContext(ctx, codes, fetchNavContext)
}

func fetchAllNavsWith(codes []string, fetch func(string) *NavResult) map[string]*NavResult {
	return fetchAllNavsWithContext(context.Background(), codes, func(_ context.Context, code string) *NavResult {
		return fetch(code)
	})
}

func fetchAllNavsWithContext(ctx context.Context, codes []string, fetch func(context.Context, string) *NavResult) map[string]*NavResult {
	if len(codes) == 0 {
		return map[string]*NavResult{}
	}
	seen := make(map[string]bool, len(codes))
	unique := make([]string, 0, len(codes))
	for _, code := range codes {
		if !seen[code] {
			seen[code] = true
			unique = append(unique, code)
		}
	}

	type pair struct {
		code string
		nav  *NavResult
	}
	jobs := make(chan string)
	ch := make(chan pair, len(unique))
	workerCount := 8
	if len(unique) < workerCount {
		workerCount = len(unique)
	}
	var wg sync.WaitGroup
	for i := 0; i < workerCount; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for code := range jobs {
				if ctx.Err() != nil {
					return
				}
				ch <- pair{code, fetch(ctx, code)}
			}
		}()
	}
	go func() {
	produce:
		for _, code := range unique {
			select {
			case jobs <- code:
			case <-ctx.Done():
				break produce
			}
		}
		close(jobs)
		wg.Wait()
		close(ch)
	}()

	results := map[string]*NavResult{}
	// 每只基金的抓取已受 navTimeout 限制；等待所有批次完成，避免排队的基金
	// 被整批固定超时丢弃，并确保返回后没有遗留净值抓取协程。
	for p := range ch {
		if p.nav != nil {
			results[p.code] = p.nav
		}
	}
	if ctx.Err() != nil {
		log.Printf("[nav] batch canceled completed=%d/%d: %v", len(results), len(unique), ctx.Err())
	}
	return results
}

type navEntry struct {
	Date  string
	Value float64
}

func fetchNavHistory(code string, pageSize int) ([]navEntry, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(navTimeout)*time.Second)
	defer cancel()
	return fetchNavHistoryContext(ctx, code, pageSize)
}

func fetchNavHistoryContext(ctx context.Context, code string, pageSize int) ([]navEntry, error) {
	params := url.Values{}
	params.Set("fundCode", code)
	params.Set("pageIndex", "1")
	params.Set("pageSize", strconv.Itoa(pageSize))
	requestURL := fmt.Sprintf("%s?%s", navHistoryURL, params.Encode())
	body, err := requestNavData(ctx, requestURL)
	if err != nil {
		return nil, err
	}
	return parseNavHistory(body)
}

func requestNavData(ctx context.Context, requestURL string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0")
	req.Header.Set("Referer", "https://fund.eastmoney.com/")
	resp, err := navHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("bad status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, navMaxBody+1))
	if err != nil {
		return nil, err
	}
	if len(body) > navMaxBody {
		return nil, fmt.Errorf("response exceeds %d bytes", navMaxBody)
	}
	return body, nil
}

func parseNavHistory(body []byte) ([]navEntry, error) {
	text := string(body)
	start, end := strings.IndexByte(text, '{'), strings.LastIndexByte(text, '}')
	if start < 0 || end < start {
		return nil, fmt.Errorf("no json in response")
	}

	var data struct {
		Data struct {
			LSJZList []struct {
				DWJZ json.RawMessage `json:"DWJZ"`
				FSRQ string          `json:"FSRQ"`
			} `json:"LSJZList"`
		} `json:"Data"`
		ErrCode int    `json:"ErrCode"`
		ErrMsg  string `json:"ErrMsg"`
	}
	if err := json.Unmarshal(body[start:end+1], &data); err != nil {
		return nil, fmt.Errorf("invalid history JSON: %w", err)
	}
	if data.ErrCode != 0 {
		return nil, fmt.Errorf("history error %d: %s", data.ErrCode, data.ErrMsg)
	}

	var entries []navEntry
	for _, item := range data.Data.LSJZList {
		value := strings.TrimSpace(string(item.DWJZ))
		if strings.HasPrefix(value, `"`) {
			if err := json.Unmarshal(item.DWJZ, &value); err != nil {
				continue
			}
		}
		v, err := strconv.ParseFloat(value, 64)
		if err == nil && finitePositive(v) && validNavDate(item.FSRQ) {
			entries = append(entries, navEntry{Date: item.FSRQ, Value: v})
		}
	}
	return normalizeNavEntries(entries)
}

// 备用源是基金网站发布的单位净值走势，不能使用估算净值或累计净值。
// 只解析数据数组，不执行第三方 JavaScript。
func parseNavTrend(body []byte, code string) ([]navEntry, error) {
	identity := navCodeRe.FindSubmatch(body)
	if len(identity) != 2 || string(identity[1]) != code {
		return nil, fmt.Errorf("published-trend fund code mismatch")
	}
	match := navTrendRe.FindSubmatch(body)
	if len(match) != 2 {
		return nil, fmt.Errorf("no published unit NAV trend in response")
	}
	var points []struct {
		Time  int64   `json:"x"`
		Value float64 `json:"y"`
	}
	if err := json.Unmarshal(match[1], &points); err != nil {
		return nil, fmt.Errorf("invalid published-trend JSON: %w", err)
	}
	location := time.FixedZone("CST", 8*3600)
	var entries []navEntry
	for _, point := range points {
		if point.Time <= 0 || !finitePositive(point.Value) {
			continue
		}
		date := time.UnixMilli(point.Time).In(location).Format("2006-01-02")
		if validNavDate(date) {
			entries = append(entries, navEntry{Date: date, Value: point.Value})
		}
	}
	entries, err := normalizeNavEntries(entries)
	if len(entries) > 2 {
		entries = entries[:2]
	}
	return entries, err
}

func validNavDate(date string) bool {
	_, err := time.Parse("2006-01-02", date)
	return err == nil
}

func normalizeNavEntries(entries []navEntry) ([]navEntry, error) {
	if len(entries) == 0 {
		return nil, fmt.Errorf("no valid published unit NAV entries")
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].Date > entries[j].Date })
	unique := entries[:0]
	for _, entry := range entries {
		if len(unique) == 0 || unique[len(unique)-1].Date != entry.Date {
			unique = append(unique, entry)
		}
	}
	return unique, nil
}
