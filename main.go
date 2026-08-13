package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"mime"
	"net/http"
	"os"
	"os/signal"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

var (
	baseDir string
)

const (
	maxJSONBody = 2 << 20 // 2 MiB
	maxHoldings = 200
	maxNavRows  = 5000
)

var (
	aShareCodeRe = regexp.MustCompile(`^\d{6}$`)
	hkCodeRe     = regexp.MustCompile(`^\d{1,5}$`)
	usCodeRe     = regexp.MustCompile(`^[A-Za-z0-9.]{1,16}$`)
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
	workerStop := make(chan struct{})
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		startNavWorker(workerStop)
	}()

	mux := http.NewServeMux()

	// 仅接受本机 Host，避免 DNS rebinding；前端与 API 同源，不开放 CORS。
	handler := hostMiddleware(mux)

	// API routes
	mux.HandleFunc("/api/data", handleData)
	mux.HandleFunc("/api/nav", handleNav)
	mux.HandleFunc("/api/snapshot", handleSnapshot)
	mux.HandleFunc("/api/quote", handleQuote)
	mux.HandleFunc("/api/quote/detail", handleQuoteDetail)
	mux.HandleFunc("/api/fund/suggest", handleFundSuggest)
	mux.HandleFunc("/api/fund/list", handleFundList)

	// Static files
	mux.HandleFunc("/", handleStatic)

	port := 8889
	if rawPort := strings.TrimSpace(os.Getenv("PORTFOLIO_PORT")); rawPort != "" {
		if parsed, err := strconv.Atoi(rawPort); err == nil && parsed >= 1024 && parsed <= 65535 {
			port = parsed
		} else {
			log.Printf("Invalid PORTFOLIO_PORT=%q; using 8889", rawPort)
		}
	}
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	log.Printf("API listening on %s", addr)
	server := &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	serverErr := make(chan error, 1)
	go func() {
		serverErr <- server.ListenAndServe()
	}()

	stopSignal := make(chan os.Signal, 1)
	signal.Notify(stopSignal, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(stopSignal)

	select {
	case sig := <-stopSignal:
		log.Printf("Shutdown requested: %s", sig)
	case err := <-serverErr:
		if err != nil && err != http.ErrServerClosed {
			log.Printf("Server failed: %v", err)
		}
	}

	close(workerStop)
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelShutdown()
	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Printf("Server shutdown failed: %v", err)
	}
	<-workerDone
}

// ── Host protection ──

func hostMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := strings.ToLower(r.Host)
		if host != "127.0.0.1:8889" && host != "localhost:8889" {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
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

func readJSON(w http.ResponseWriter, r *http.Request, v interface{}) error {
	if !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
		return fmt.Errorf("Content-Type must be application/json")
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBody)
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(v); err != nil {
		return err
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		if err == nil {
			return fmt.Errorf("only one JSON value is allowed")
		}
		return err
	}
	return nil
}

func validateHoldings(items []Holding) error {
	if items == nil {
		return fmt.Errorf("需要 JSON 数组")
	}
	if len(items) > maxHoldings {
		return fmt.Errorf("持仓数量不能超过 %d 条", maxHoldings)
	}
	validMarkets := map[string]bool{"sh": true, "sz": true, "us": true, "hk": true, "of": true, "manual": true}
	validCurrencies := map[string]bool{"CNY": true, "USD": true, "HKD": true}
	validTypes := map[string]bool{"stock": true, "etf": true, "fund": true, "money": true, "cash": true}
	for i, h := range items {
		if h.ID == "" || h.Code == "" || len(h.ID) > 128 || len(h.Code) > 32 {
			return fmt.Errorf("第 %d 条持仓缺少合法的 id/code", i+1)
		}
		if !validMarkets[h.Market] || !validCurrencies[h.Currency] || !validTypes[h.Type] {
			return fmt.Errorf("第 %d 条持仓的 market/currency/type 不受支持", i+1)
		}
		if h.Quantity <= 0 || math.IsNaN(h.Quantity) || math.IsInf(h.Quantity, 0) || h.Cost < 0 || math.IsNaN(h.Cost) || math.IsInf(h.Cost, 0) {
			return fmt.Errorf("第 %d 条持仓的数量或成本无效", i+1)
		}
		if len(h.Name) > 200 || len(h.Index) > 200 || len(h.Account) > 200 || len(h.Note) > 1000 {
			return fmt.Errorf("第 %d 条持仓的文本字段过长", i+1)
		}
	}
	return nil
}

func validateNavEntries(items []NavEntry) error {
	if items == nil {
		return fmt.Errorf("需要 JSON 数组")
	}
	if len(items) > maxNavRows {
		return fmt.Errorf("净值记录不能超过 %d 条", maxNavRows)
	}
	for i, item := range items {
		if _, err := time.Parse("2006-01-02", item.Date); err != nil {
			return fmt.Errorf("第 %d 条净值日期无效", i+1)
		}
		if item.Count < 0 || item.Total < 0 || math.IsNaN(item.Total) || math.IsInf(item.Total, 0) || math.IsNaN(item.TodayPnl) || math.IsInf(item.TodayPnl, 0) || math.IsNaN(item.TodayPnlPct) || math.IsInf(item.TodayPnlPct, 0) {
			return fmt.Errorf("第 %d 条净值数据无效", i+1)
		}
	}
	return nil
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
		if err := readJSON(w, r, &items); err != nil {
			writeJSON(w, 400, map[string]interface{}{"ok": false, "error": err.Error()})
			return
		}
		if err := validateHoldings(items); err != nil {
			writeJSON(w, 400, map[string]interface{}{"ok": false, "error": err.Error()})
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
		if err := readJSON(w, r, &items); err != nil {
			writeJSON(w, 400, map[string]interface{}{"ok": false, "error": err.Error()})
			return
		}
		if err := validateNavEntries(items); err != nil {
			writeJSON(w, 400, map[string]interface{}{"ok": false, "error": err.Error()})
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
	if err := readJSON(w, r, &holdings); err != nil {
		writeJSON(w, 400, map[string]interface{}{"ok": false, "error": err.Error()})
		return
	}
	if err := validateHoldings(holdings); err != nil {
		writeJSON(w, 400, map[string]interface{}{"ok": false, "error": err.Error()})
		return
	}

	result, errors := buildSnapshot(holdings, r.URL.Query().Get("refresh_fx") == "1")
	if result == nil {
		writeJSON(w, 500, map[string]interface{}{"ok": false, "error": "快照计算失败", "errors": errors})
		return
	}
	writeJSON(w, 200, map[string]interface{}{
		"ts": time.Now().UnixMilli(), "kpi": result.KPI, "rows": result.Rows,
		"charts": map[string]interface{}{"byCategory": result.ChartCat, "byIndex": result.ChartIdx},
		"fx":     result.FX, "errors": errors,
	})
}

type snapshotResult struct {
	KPI      KPI
	Rows     []Holding
	ChartCat []ChartItem
	ChartIdx []ChartItem
	FX       *FxResult
}

// buildSnapshot 是页面 API 和后台净值任务共用的行情计算入口。
func buildSnapshot(holdings []Holding, forceFx bool) (*snapshotResult, []string) {
	start := time.Now()
	var errors []string
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
		quotes map[string]Quote
		fx     *FxResult
		navMap map[string]*NavResult
		wg     sync.WaitGroup
		mu     sync.Mutex
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
		source := "not-required"
		if needFx {
			source = "fallback(hardcoded)"
		}
		fx = &FxResult{Rates: map[string]float64{"USD": 1, "CNY": fallbackUSDCNY, "HKD": fallbackUSDHKD}, TS: 0, Source: source}
	}
	if needFx && fx.Source == "fallback(hardcoded)" {
		errors = append(errors, "汇率: 双源均失败，使用硬编码汇率")
	}
	if quotes == nil {
		quotes = map[string]Quote{}
	}
	if len(nonManual) > 0 {
		for _, item := range nonManual {
			q, ok := quotes[item.Market+item.Code]
			if !ok || !finitePositive(q.Price) {
				errors = append(errors, fmt.Sprintf("行情: %s/%s 无有效报价", item.Market, item.Code))
			}
		}
	}
	if navMap == nil {
		navMap = map[string]*NavResult{}
	}
	if len(ofCodes) > 0 {
		for _, code := range ofCodes {
			nav := navMap[code]
			if nav == nil || !finitePositive(nav.NavPrice) {
				errors = append(errors, fmt.Sprintf("净值: %s 无有效净值", code))
			}
		}
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
	chartCat := aggregateByCategory(rows)
	chartIdx := aggregateByIndex(rows)

	log.Printf("[snapshot] completed in %v", time.Since(start).Round(time.Millisecond))
	return &snapshotResult{KPI: kpi, Rows: rows, ChartCat: chartCat, ChartIdx: chartIdx, FX: fx}, errors
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
	validCode := (market == "sh" || market == "sz") && aShareCodeRe.MatchString(code) ||
		market == "hk" && hkCodeRe.MatchString(code) ||
		market == "us" && usCodeRe.MatchString(code)
	if !validCode {
		writeJSON(w, 400, map[string]string{"error": "不支持的 market/code"})
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
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if r.URL.Path == "/" {
		http.Redirect(w, r, "/assets/index.html", 301)
		return
	}

	// 仅公开前端入口和静态资源。数据库、日志、源码与 .git 永不进入服务范围。
	clean := path.Clean("/" + strings.TrimPrefix(r.URL.Path, "/"))
	allowed := clean == "/assets/index.html" ||
		strings.HasPrefix(clean, "/assets/css/") ||
		strings.HasPrefix(clean, "/assets/js/") ||
		strings.HasPrefix(clean, "/assets/images/")
	if !allowed {
		http.NotFound(w, r)
		return
	}
	rel := strings.TrimPrefix(clean, "/assets/")
	absPath := filepath.Join(baseDir, "assets", filepath.FromSlash(rel))

	if info, err := os.Stat(absPath); err == nil && !info.IsDir() {
		// 本地应用频繁迭代前端资源；始终重新校验，避免浏览器继续执行旧模块。
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("Expires", "0")
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
		file, err := os.Open(absPath)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer file.Close()
		http.ServeContent(w, r, filepath.Base(absPath), info.ModTime(), file)
		return
	}
	http.NotFound(w, r)
}
