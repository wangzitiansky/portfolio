package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var (
	baseDir string
)

func main() {
	// 确定 baseDir（assets 目录所在）
	exe, _ := os.Executable()
	baseDir = filepath.Dir(exe)
	if _, err := os.Stat(filepath.Join(baseDir, "assets")); os.IsNotExist(err) {
		baseDir, _ = os.Getwd()
	}
	os.Chdir(baseDir)

	// 日志同时输出到 stdout 和文件
	logFile, err := os.OpenFile(filepath.Join(baseDir, "server.log"),
		os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err == nil {
		log.SetOutput(io.MultiWriter(os.Stdout, logFile))
		defer logFile.Close()
	}

	if err := initDB(); err != nil {
		log.Fatalf("DB init failed: %v", err)
	}
	defer closeDB()

	mux := http.NewServeMux()

	// CORS wrapper
	handler := corsMiddleware(mux)

	// API routes
	mux.HandleFunc("/api/data", handleData)
	mux.HandleFunc("/api/nav", handleNav)
	mux.HandleFunc("/api/snapshot", handleSnapshot)
	mux.HandleFunc("/api/quote", handleQuote)

	// Static files
	mux.HandleFunc("/", handleStatic)

	addr := "127.0.0.1:8889"
	log.Printf("API listening on %s", addr)
	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}

// ── CORS ──

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

		if r.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ── JSON helpers ──

func writeJSON(w http.ResponseWriter, code int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	if err := json.NewEncoder(w).Encode(data); err != nil {
		log.Printf("[json] encode error: %v", err)
	}
}

func readJSON(r *http.Request, v interface{}) error {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return err
	}
	return json.Unmarshal(body, v)
}

// ── GET/POST /api/data ──

func handleData(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case "GET":
		holdings, err := getAllHoldings()
		if err != nil {
			writeJSON(w, 200, []Holding{})
			return
		}
		writeJSON(w, 200, holdings)

	case "POST":
		var items []Holding
		if err := readJSON(r, &items); err != nil {
			writeJSON(w, 400, map[string]interface{}{"ok": false, "error": "需要 JSON 数组"})
			return
		}
		if err := replaceAllHoldings(items); err != nil {
			writeJSON(w, 400, map[string]interface{}{"ok": false, "error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]interface{}{"ok": true})

	default:
		writeJSON(w, 405, map[string]string{"error": "method not allowed"})
	}
}

// ── GET/POST /api/nav ──

func handleNav(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case "GET":
		nav, err := getAllNav()
		if err != nil {
			writeJSON(w, 200, []NavEntry{})
			return
		}
		writeJSON(w, 200, nav)

	case "POST":
		var items []NavEntry
		if err := readJSON(r, &items); err != nil {
			writeJSON(w, 400, map[string]interface{}{"ok": false, "error": "需要 JSON 数组"})
			return
		}
		if err := replaceAllNav(items); err != nil {
			writeJSON(w, 400, map[string]interface{}{"ok": false, "error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]interface{}{"ok": true})

	default:
		writeJSON(w, 405, map[string]string{"error": "method not allowed"})
	}
}

// ── POST /api/snapshot ──

func handleSnapshot(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		writeJSON(w, 405, map[string]string{"error": "POST only"})
		return
	}

	var holdings []Holding
	if err := readJSON(r, &holdings); err != nil {
		writeJSON(w, 400, map[string]interface{}{"ok": false, "error": "需要 JSON 数组"})
		return
	}

	var errors []string
		// refresh_fx=1 时强制刷新汇率，否则使用缓存
		forceFx := r.URL.Query().Get("refresh_fx") == "1"
	start := time.Now()

	// 1. 按需并行拉取：行情 + 汇率 + 净值
	var nonManual []struct{ Market, Code string }
	var ofCodes []string
	needFx := false
	for _, h := range holdings {
		if h.Market != "manual" && h.Market != "of" {
			nonManual = append(nonManual, struct{ Market, Code string }{h.Market, h.Code})
		}
		if h.Market == "of" && h.Code != "" {
			ofCodes = append(ofCodes, h.Code)
		}
		if h.Currency == "USD" || h.Currency == "HKD" {
			needFx = true
		}
	}

	var (
		quotes  map[string]Quote
		fx      *FxResult
		navMap  map[string]*NavResult
		wg      sync.WaitGroup
		mu      sync.Mutex
	)

	if len(nonManual) > 0 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			q := fetchQuotes(nonManual)
			mu.Lock()
			quotes = q
			mu.Unlock()
		}()
	}

	if needFx {
		wg.Add(1)
		go func() {
			defer wg.Done()
			fx = getFxRates(forceFx)
		}()
	}

	if len(ofCodes) > 0 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			navMap = fetchAllNavs(ofCodes)
		}()
	}

	wg.Wait()

	if fx == nil {
		fx = &FxResult{Rates: map[string]float64{"USD": 1, "CNY": fallbackUSDCNY, "HKD": fallbackUSDHKD}, TS: 0, Source: "fallback(hardcoded)"}
	}
	if fx.Source == "fallback(hardcoded)" {
		errors = append(errors, "汇率: 双源均失败，使用硬编码汇率")
	}
	if quotes == nil {
		quotes = map[string]Quote{}
	}
	if len(nonManual) > 0 && len(quotes) == 0 {
		errors = append(errors, "行情: 全部拉取失败")
	}
	if navMap == nil {
		navMap = map[string]*NavResult{}
	}
	if len(ofCodes) > 0 && len(navMap) == 0 {
		errors = append(errors, "净值: 全部拉取失败")
	}

	// 2. Enrich
	var rows []Holding
	for _, h := range holdings {
		var nav *NavResult
		if h.Market == "of" {
			nav = navMap[h.Code]
		}
		row := enrich(h, quotes, fx, nav)
		row.Category = holdingsCategory(row)
		rows = append(rows, row)
	}

	// 3. KPIs + 图表
	kpi := calcKPIs(rows, fx)
	chartCat := aggregateByHolding(rows)
	chartIdx := aggregateByIndex(rows)

	log.Printf("[snapshot] completed in %v", time.Since(start).Round(time.Millisecond))

	writeJSON(w, 200, map[string]interface{}{
		"ts":   time.Now().UnixMilli(),
		"kpi":  kpi,
		"rows": rows,
		"charts": map[string]interface{}{
			"byCategory": chartCat,
			"byIndex":    chartIdx,
		},
		"fx":     fx,
		"errors": errors,
	})
}

// ── GET /api/quote?market=us&code=BRK.B ──

func handleQuote(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		writeJSON(w, 405, map[string]string{"error": "GET only"})
		return
	}

	market := r.URL.Query().Get("market")
	code := r.URL.Query().Get("code")
	if market == "" || code == "" {
		writeJSON(w, 400, map[string]string{"error": "需要 market 和 code 参数"})
		return
	}

	items := []struct{ Market, Code string }{{market, code}}
	quotes := fetchQuotes(items)
	q, ok := quotes[market+code]
	if !ok {
		writeJSON(w, 200, nil)
		return
	}
	writeJSON(w, 200, q)
}

// ── Static file serving ──

func handleStatic(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/" {
		http.Redirect(w, r, "/assets/index.html", 301)
		return
	}

	// Path traversal protection
	clean := filepath.Clean(r.URL.Path)
	absPath := filepath.Join(baseDir, clean)
	if !strings.HasPrefix(absPath, baseDir) {
		w.WriteHeader(403)
		return
	}

	if info, err := os.Stat(absPath); err == nil && !info.IsDir() {
		ct := mime.TypeByExtension(filepath.Ext(absPath))
		if ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		if ct == "text/css" {
			// Ensure CSS is served with correct charset
			w.Header().Set("Content-Type", "text/css; charset=utf-8")
		}
		if strings.HasSuffix(absPath, ".js") {
			w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		}
		http.ServeFile(w, r, absPath)
		return
	}

	// Fallback: SPA routing — try index.html
	indexPath := filepath.Join(baseDir, "assets", "index.html")
	if _, err := os.Stat(indexPath); err == nil {
		http.ServeFile(w, r, indexPath)
		return
	}

	w.WriteHeader(404)
	fmt.Fprintf(w, "404 not found")
}
