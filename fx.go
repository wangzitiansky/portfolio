package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"
)

const (
	fxPrimaryURL  = "https://open.er-api.com/v6/latest/USD"
	fxFallbackURL = "https://api.frankfurter.dev/v1/latest?from=USD"
	fxTimeout     = 10
)

// fallbackUSDCNY / fallbackUSDHKD — 双源均失败时的硬编码兜底汇率
const (
	fallbackUSDCNY = 7.20
	fallbackUSDHKD = 7.82
)

var (
	fxFallbackRates = map[string]float64{"USD": 1, "CNY": fallbackUSDCNY, "HKD": fallbackUSDHKD}
	fxHTTPClient    = &http.Client{Timeout: time.Duration(fxTimeout) * time.Second}
	fxCache         *FxResult
	fxCacheMu       sync.Mutex
)

// getFxRates 拉取汇率。force=true 时若缓存超过 30 分钟也刷新。
func getFxRates(force bool) *FxResult {
	fxCacheMu.Lock()
	// 非强制模式：缓存永久有效
	if !force && fxCache != nil {
		c := fxCache
		fxCacheMu.Unlock()
		return c
	}
	// 强制模式但缓存尚新鲜（30min 内）：跳过刷新
	if force && fxCache != nil && time.Since(time.UnixMilli(fxCache.TS)) < 30*time.Minute {
		c := fxCache
		fxCacheMu.Unlock()
		return c
	}
	fxCacheMu.Unlock()
	type result struct {
		rates  map[string]float64
		source string
	}

	ch := make(chan result, 2)

	go func() {
		start := time.Now()
		r, err := fetchFx(fxPrimaryURL, false)
		if err != nil {
			log.Printf("[fx] open.er-api.com failed: %v", err)
		} else {
			log.Printf("[fx] open.er-api.com OK (%dms)", time.Since(start).Milliseconds())
			ch <- result{rates: r, source: "open.er-api.com"}
		}
	}()

	go func() {
		start := time.Now()
		r, err := fetchFx(fxFallbackURL, true)
		if err != nil {
			log.Printf("[fx] frankfurter.dev failed: %v", err)
		} else {
			log.Printf("[fx] frankfurter.dev OK (%dms)", time.Since(start).Milliseconds())
			ch <- result{rates: r, source: "frankfurter.dev"}
		}
	}()

	var out *FxResult

	select {
	case res := <-ch:
		out = &FxResult{Rates: res.rates, TS: time.Now().UnixMilli(), Source: res.source}
	case <-time.After(time.Duration(fxTimeout) * time.Second):
		select {
		case res := <-ch:
			out = &FxResult{Rates: res.rates, TS: time.Now().UnixMilli(), Source: res.source}
		default:
			log.Printf("[fx] both sources timed out after %ds", fxTimeout)
		}
	}

	if out == nil {
		log.Printf("[fx] using hardcoded fallback rates (CNY=%.2f, HKD=%.2f)", fxFallbackRates["CNY"], fxFallbackRates["HKD"])
		out = &FxResult{Rates: fxFallbackRates, TS: 0, Source: "fallback(hardcoded)"}
	}
	fxCacheMu.Lock()
	fxCache = out
	fxCacheMu.Unlock()
	return out
}

// fetchFx 拉取汇率，ensureUSD 为 true 时补充 USD:1（frankfurter 以 EUR 为基准不返回 USD）
func fetchFx(url string, ensureUSD bool) (map[string]float64, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0")
	resp, err := fxHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var data struct {
		Rates map[string]float64 `json:"rates"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil, err
	}
	if data.Rates == nil {
		return nil, fmt.Errorf("empty rates in response")
	}
	if ensureUSD {
		data.Rates["USD"] = 1
	}
	return data.Rates, nil
}
