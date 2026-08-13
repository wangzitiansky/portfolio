package main

import (
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestCorrectFundMarketKeepsStocks(t *testing.T) {
	if got := correctFundMarket("sh", "600519", "stock"); got != "sh" {
		t.Fatalf("A-share stock was changed to %q", got)
	}
	if got := correctFundMarket("sz", "000001", "stock"); got != "sz" {
		t.Fatalf("A-share stock was changed to %q", got)
	}
}

func TestCorrectFundMarketOnlyCorrectsFundTypes(t *testing.T) {
	if got := correctFundMarket("sh", "000001", "fund"); got != "of" {
		t.Fatalf("off-exchange fund should be corrected to of, got %q", got)
	}
	if got := correctFundMarket("sh", "513500", "etf"); got != "sh" {
		t.Fatalf("exchange-traded fund should remain sh, got %q", got)
	}
}

func TestParseHKUsesCurrentPrice(t *testing.T) {
	parts := make([]string, 40)
	parts[1] = "Tencent"
	parts[3] = "612.50"
	parts[29] = "123456789"
	parts[30] = "2026/08/12 12:30:00"
	parts[31] = "2.50"
	parts[32] = "0.41"
	parts[35] = "HKD"

	quote := parseHK("hk", "00700", parts)
	if quote == nil {
		t.Fatal("expected quote")
	}
	if quote.Price != 612.50 {
		t.Fatalf("expected current price 612.50, got %v", quote.Price)
	}
	if quote.TS == 0 {
		t.Fatal("expected market timestamp to be parsed")
	}
}

func TestParseMarketTsDoesNotMakeInvalidDataFresh(t *testing.T) {
	if got := parseMarketTs("not-a-date", time.Local); got != 0 {
		t.Fatalf("invalid timestamp should be zero, got %d", got)
	}
}

func TestParseUSTsUsesNewYorkTime(t *testing.T) {
	got := parseUSTs("2026-08-12 10:59:20")
	want := time.Date(2026, 8, 12, 10, 59, 20, 0, time.FixedZone("EDT", -4*3600)).UnixMilli()
	if got != want {
		t.Fatalf("expected New York timestamp %d, got %d", want, got)
	}
}

func TestNavWorkerFiniteValueGuards(t *testing.T) {
	if !finitePositive(1.25) || finitePositive(0) || finitePositive(-1) {
		t.Fatal("finitePositive guard failed")
	}
	if !finiteNonNegative(0) || !finiteNonNegative(2.5) || finiteNonNegative(-0.1) {
		t.Fatal("finiteNonNegative guard failed")
	}
	if finiteNumber(math.NaN()) || finiteNumber(math.Inf(1)) || !finiteNumber(-2) {
		t.Fatal("finiteNumber guard failed")
	}
}

func TestNavWorkerSkipsOverlappingRunsAndWaitsOnStop(t *testing.T) {
	stop := make(chan struct{})
	started := make(chan struct{})
	release := make(chan struct{})
	done := make(chan struct{})
	var calls atomic.Int32

	go func() {
		defer close(done)
		runNavWorker(stop, 10*time.Millisecond, func() {
			if calls.Add(1) == 1 {
				close(started)
			}
			<-release
		})
	}()

	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("worker did not run immediately")
	}
	time.Sleep(35 * time.Millisecond)
	if got := calls.Load(); got != 1 {
		t.Fatalf("overlapping ticks started %d runs, want 1", got)
	}

	close(stop)
	select {
	case <-done:
		t.Fatal("worker stopped before its active run completed")
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("worker did not stop after active run completed")
	}
}

func TestIsMarketOpenAtUsesLocalTradingWindows(t *testing.T) {
	loc := time.FixedZone("CST", 8*3600)
	if !isMarketOpenAt("sh", time.Date(2026, 8, 12, 10, 0, 0, 0, loc)) {
		t.Fatal("A-share morning session should be open")
	}
	if isMarketOpenAt("sh", time.Date(2026, 8, 12, 12, 0, 0, 0, loc)) {
		t.Fatal("A-share lunch break should be closed")
	}
	if isMarketOpenAt("hk", time.Date(2026, 8, 15, 10, 0, 0, 0, loc)) {
		t.Fatal("Hong Kong market should be closed on Saturday")
	}
	if isMarketOpenAt("manual", time.Date(2026, 8, 12, 10, 0, 0, 0, loc)) {
		t.Fatal("manual assets are never tradeable")
	}
}

func TestQuoteDetailValidationAndRanges(t *testing.T) {
	if !validQuoteMarketCode("us", "BRK.B") || validQuoteMarketCode("us", "bad code") {
		t.Fatal("quote market/code validation failed")
	}
	if !validQuoteRange("YTD") || validQuoteRange("2Y") {
		t.Fatal("quote range validation failed")
	}
}

func TestAggregateByCategory(t *testing.T) {
	rows := []Holding{
		{Market: "us", Type: "stock", MarketValueCNY: 100},
		{Market: "us", Type: "stock", MarketValueCNY: 50},
		{Market: "of", Type: "fund", MarketValueCNY: 25},
	}
	got := aggregateByCategory(rows)
	if len(got) != 2 {
		t.Fatalf("expected 2 categories, got %#v", got)
	}
	if got[0].Name != "美股" || got[0].Value != 150 {
		t.Fatalf("unexpected US category: %#v", got[0])
	}
}

func TestStaticHandlerOnlyServesPublicAssets(t *testing.T) {
	oldBaseDir := baseDir
	t.Cleanup(func() { baseDir = oldBaseDir })
	baseDir = t.TempDir()

	for name, content := range map[string]string{
		"assets/index.html":   "index",
		"assets/js/main.js":   "js",
		"assets/portfolio.db": "secret db",
		"server.log":          "secret log",
		"main.go":             "secret source",
	} {
		fullPath := filepath.Join(baseDir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(fullPath, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	for _, tc := range []struct {
		path string
		want int
	}{
		{"/assets/index.html", http.StatusOK},
		{"/assets/js/main.js", http.StatusOK},
		{"/assets/portfolio.db", http.StatusNotFound},
		{"/server.log", http.StatusNotFound},
		{"/main.go", http.StatusNotFound},
	} {
		req := httptest.NewRequest(http.MethodGet, tc.path, nil)
		rec := httptest.NewRecorder()
		handleStatic(rec, req)
		if rec.Code != tc.want {
			t.Errorf("GET %s: expected %d, got %d", tc.path, tc.want, rec.Code)
		}
	}
}

func TestHostMiddlewareRejectsOtherHosts(t *testing.T) {
	handler := hostMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodGet, "http://attacker.example/", nil)
	req.Host = "attacker.example"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected forbidden host, got %d", rec.Code)
	}
}
