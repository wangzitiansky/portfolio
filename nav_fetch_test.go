package main

import (
	"context"
	"fmt"
	"io"
	"math"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type navTestTransport func(*http.Request) (*http.Response, error)

func (transport navTestTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return transport(req)
}

func useNavTestTransport(t *testing.T, transport navTestTransport) {
	t.Helper()
	original := navHTTPClient
	navHTTPClient = &http.Client{Transport: transport, Timeout: 8 * time.Second}
	t.Cleanup(func() { navHTTPClient = original })
}

func navTestResponse(req *http.Request, status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    req,
	}
}

func navTestHistoryBody(latest, previous float64) string {
	return fmt.Sprintf(`{"ErrCode":0,"Data":{"LSJZList":[{"FSRQ":"2026-10-08","DWJZ":"%.4f"},{"FSRQ":"2026-09-30","DWJZ":"%.4f"}]}}`, latest, previous)
}

func navTestTrendBody(code string, latest, previous float64) string {
	location := time.FixedZone("CST", 8*3600)
	latestTime := time.Date(2026, 10, 8, 0, 0, 0, 0, location).UnixMilli()
	previousTime := time.Date(2026, 9, 30, 0, 0, 0, 0, location).UnixMilli()
	return fmt.Sprintf("var fS_code = %q;\nvar Data_netWorthTrend = [{\"x\":%d,\"y\":%.4f},{\"x\":%d,\"y\":%.4f}];\nvar Data_ACWorthTrend = [];", code, previousTime, previous, latestTime, latest)
}

func requireNavValues(t *testing.T, got *NavResult, latest, previous float64) {
	t.Helper()
	if got == nil {
		t.Fatal("expected valid NAV result")
	}
	if got.Nav != "2026-10-08" || got.NavPrice != latest {
		t.Fatalf("unexpected latest NAV: %#v", got)
	}
	wantChange := latest - previous
	wantPct := wantChange / previous * 100
	if math.Abs(got.Change-wantChange) > 1e-12 || math.Abs(got.ChangePct-wantPct) > 1e-12 {
		t.Fatalf("incorrect change: got %.12f / %.12f%%, want %.12f / %.12f%%", got.Change, got.ChangePct, wantChange, wantPct)
	}
}

func TestParseNavHistoryAcceptsJSONAndJSONP(t *testing.T) {
	jsonBody := `{
		"ErrCode": 0,
		"Data": {"LSJZList": [
			{"FSRQ":"2026-09-30", "DWJZ":"2.2406"},
			{"FSRQ":"2026-10-08", "DWJZ":2.2691},
			{"FSRQ":"2026-10-08", "DWJZ":"2.2691"}
		]}
	}`
	want := []navEntry{{Date: "2026-10-08", Value: 2.2691}, {Date: "2026-09-30", Value: 2.2406}}
	for _, tc := range []struct{ name, body string }{
		{"multiline JSON", jsonBody},
		{"multiline JSONP", "callback(" + jsonBody + ");"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseNavHistory([]byte(tc.body))
			if err != nil {
				t.Fatalf("parse error: %v", err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("expected sorted, deduplicated valid values: got %#v, want %#v", got, want)
			}
		})
	}
}

func TestParseNavHistoryRejectsInvalidResponses(t *testing.T) {
	for _, tc := range []struct{ name, body string }{
		{"business error", `{"ErrCode":1,"ErrMsg":"upstream unavailable","Data":{"LSJZList":[{"FSRQ":"2026-10-08","DWJZ":"2.2691"}]}}`},
		{"null data", `{"ErrCode":0,"Data":null}`},
		{"empty history", `{"ErrCode":0,"Data":{"LSJZList":[]}}`},
		{"HTML", `<html>Service unavailable</html>`},
		{"invalid JSON", `{"Data":`},
		{"zero", `{"Data":{"LSJZList":[{"FSRQ":"2026-10-08","DWJZ":"0"}]}}`},
		{"negative", `{"Data":{"LSJZList":[{"FSRQ":"2026-10-08","DWJZ":-1}]}}`},
		{"NaN", `{"Data":{"LSJZList":[{"FSRQ":"2026-10-08","DWJZ":"NaN"}]}}`},
		{"infinite", `{"Data":{"LSJZList":[{"FSRQ":"2026-10-08","DWJZ":"+Inf"}]}}`},
		{"missing value", `{"Data":{"LSJZList":[{"FSRQ":"2026-10-08","DWJZ":"--"}]}}`},
		{"invalid date", `{"Data":{"LSJZList":[{"FSRQ":"2026-02-30","DWJZ":"2.2691"}]}}`},
		{"missing date", `{"Data":{"LSJZList":[{"DWJZ":"2.2691"}]}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got, err := parseNavHistory([]byte(tc.body)); err == nil {
				t.Fatalf("expected error for unusable NAV response, got %#v", got)
			}
		})
	}
}

func TestParseNavHistorySkipsInvalidEntries(t *testing.T) {
	body := `{"Data":{"LSJZList":[{"FSRQ":"2026-10-09","DWJZ":"--"},{"FSRQ":"not-a-date","DWJZ":"10"},{"FSRQ":"2026-10-08","DWJZ":"2.2691"}]}}`
	got, err := parseNavHistory([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	want := []navEntry{{Date: "2026-10-08", Value: 2.2691}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("invalid entries were retained: %#v", got)
	}
}

func TestParseNavTrendValidatesCodeAndSortsDates(t *testing.T) {
	got, err := parseNavTrend([]byte(navTestTrendBody("021000", 2.3663, 2.3427)), "021000")
	if err != nil {
		t.Fatal(err)
	}
	want := []navEntry{{Date: "2026-10-08", Value: 2.3663}, {Date: "2026-09-30", Value: 2.3427}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("expected correct China-time dates and prices: got %#v, want %#v", got, want)
	}
	if _, err := parseNavTrend([]byte(navTestTrendBody("007721", 2.2691, 2.2406)), "021000"); err == nil {
		t.Fatal("expected mismatched fund code to be rejected")
	}
}

func TestParseNavTrendRejectsUnusableData(t *testing.T) {
	for _, tc := range []struct{ name, body string }{
		{"missing code", `var Data_netWorthTrend = [{"x":1791388800000,"y":2.2691}];`},
		{"missing trend", `var fS_code = "007721"; var Data_ACWorthTrend = [];`},
		{"empty trend", `var fS_code = "007721"; var Data_netWorthTrend = [];`},
		{"invalid value", `var fS_code = "007721"; var Data_netWorthTrend = [{"x":1791388800000,"y":0},{"x":1791388800000,"y":-1}];`},
		{"invalid JSON", `var fS_code = "007721"; var Data_netWorthTrend = [not JSON];`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got, err := parseNavTrend([]byte(tc.body), "007721"); err == nil {
				t.Fatalf("expected error for unusable trend, got %#v", got)
			}
		})
	}
}

func TestFetchNavRetriesTransientPrimaryFailure(t *testing.T) {
	primaryCalls, fallbackCalls := 0, 0
	useNavTestTransport(t, func(req *http.Request) (*http.Response, error) {
		if strings.Contains(req.URL.Path, "/pingzhongdata/") {
			fallbackCalls++
			return navTestResponse(req, http.StatusInternalServerError, "unnecessary fallback"), nil
		}
		primaryCalls++
		if req.URL.Query().Get("fundCode") != "007721" {
			t.Errorf("wrong fund code in history request: %s", req.URL)
		}
		if primaryCalls == 1 {
			return navTestResponse(req, http.StatusServiceUnavailable, "temporary failure"), nil
		}
		return navTestResponse(req, http.StatusOK, navTestHistoryBody(2.2691, 2.2406)), nil
	})
	requireNavValues(t, fetchNav("007721"), 2.2691, 2.2406)
	if primaryCalls != 2 || fallbackCalls != 0 {
		t.Fatalf("unexpected attempts: primary=%d, fallback=%d", primaryCalls, fallbackCalls)
	}
}

func TestFetchNavFallsBackAfterPrimaryFailures(t *testing.T) {
	primaryCalls, fallbackCalls := 0, 0
	useNavTestTransport(t, func(req *http.Request) (*http.Response, error) {
		if strings.Contains(req.URL.Path, "/pingzhongdata/") {
			fallbackCalls++
			if req.URL.Path != "/pingzhongdata/021000.js" {
				t.Errorf("incorrect fallback fund: %s", req.URL.Path)
			}
			return navTestResponse(req, http.StatusOK, navTestTrendBody("021000", 2.3663, 2.3427)), nil
		}
		primaryCalls++
		return navTestResponse(req, http.StatusOK, `{"ErrCode":0,"Data":null}`), nil
	})
	requireNavValues(t, fetchNav("021000"), 2.3663, 2.3427)
	if primaryCalls != 2 || fallbackCalls != 1 {
		t.Fatalf("unexpected attempts: primary=%d, fallback=%d", primaryCalls, fallbackCalls)
	}
}

func TestFetchNavReturnsNilWhenBothSourcesFail(t *testing.T) {
	primaryCalls, fallbackCalls := 0, 0
	useNavTestTransport(t, func(req *http.Request) (*http.Response, error) {
		if strings.Contains(req.URL.Path, "/pingzhongdata/") {
			fallbackCalls++
			return navTestResponse(req, http.StatusOK, navTestTrendBody("021000", 2.3663, 2.3427)), nil
		}
		primaryCalls++
		return nil, fmt.Errorf("upstream connection failed")
	})
	if got := fetchNav("007721"); got != nil {
		t.Fatalf("must not accept a different fund's fallback NAV: %#v", got)
	}
	if primaryCalls != 2 || fallbackCalls != 1 {
		t.Fatalf("unexpected attempts: primary=%d, fallback=%d", primaryCalls, fallbackCalls)
	}
}

func TestFetchNavSingleEntryHasNoInventedDailyChange(t *testing.T) {
	useNavTestTransport(t, func(req *http.Request) (*http.Response, error) {
		return navTestResponse(req, http.StatusOK, `{"ErrCode":0,"Data":{"LSJZList":[{"FSRQ":"2026-10-08","DWJZ":"2.2691"}]}}`), nil
	})
	got := fetchNav("007721")
	if got == nil || got.NavPrice != 2.2691 || got.Change != 0 || got.ChangePct != 0 {
		t.Fatalf("unexpected one-entry result: %#v", got)
	}
}

func TestFetchAllNavsCollectsEveryBatchAndDeduplicates(t *testing.T) {
	var active, peak atomic.Int32
	var mu sync.Mutex
	calls := map[string]int{}
	codes := make([]string, 0, 24)
	for i := 0; i < 20; i++ {
		codes = append(codes, fmt.Sprintf("%06d", i+1))
	}
	codes = append(codes, codes[0], codes[7], codes[19])
	got := fetchAllNavsWith(codes, func(code string) *NavResult {
		current := active.Add(1)
		defer active.Add(-1)
		for previous := peak.Load(); current > previous; previous = peak.Load() {
			if peak.CompareAndSwap(previous, current) {
				break
			}
		}
		mu.Lock()
		calls[code]++
		mu.Unlock()
		// Keep enough work in flight to exercise multiple worker batches.
		time.Sleep(5 * time.Millisecond)
		return &NavResult{Nav: "2026-10-08", NavPrice: 2.2691}
	})
	if len(got) != 20 {
		t.Fatalf("later batches lost results: got %d, want 20", len(got))
	}
	if peak.Load() > 8 || active.Load() != 0 {
		t.Fatalf("unbounded or unfinished workers: peak=%d active=%d", peak.Load(), active.Load())
	}
	for code, count := range calls {
		if count != 1 || got[code] == nil {
			t.Errorf("fund %s: requests=%d, result=%#v", code, count, got[code])
		}
	}
}

func TestFetchAllNavsOmitsFailedFundsWithoutLosingSuccesses(t *testing.T) {
	got := fetchAllNavsWith([]string{"007721", "021000"}, func(code string) *NavResult {
		if code == "007721" {
			return nil
		}
		return &NavResult{Nav: "2026-10-08", NavPrice: 2.3663}
	})
	if len(got) != 1 || got["021000"] == nil || got["007721"] != nil {
		t.Fatalf("unexpected mixed-success batch: %#v", got)
	}
	if empty := fetchAllNavsWith(nil, func(string) *NavResult {
		t.Error("fetch called for an empty fund list")
		return nil
	}); len(empty) != 0 {
		t.Fatalf("expected empty results, got %#v", empty)
	}
}

func TestFetchAllNavsCancellationStopsActiveAndQueuedRequests(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var active, calls atomic.Int32
	started := make(chan struct{}, 8)
	done := make(chan map[string]*NavResult, 1)
	codes := make([]string, 24)
	for i := range codes {
		codes[i] = fmt.Sprintf("%06d", i+1)
	}
	go func() {
		done <- fetchAllNavsWithContext(ctx, codes, func(ctx context.Context, _ string) *NavResult {
			calls.Add(1)
			active.Add(1)
			defer active.Add(-1)
			started <- struct{}{}
			<-ctx.Done()
			return nil
		})
	}()
	deadline := time.NewTimer(time.Second)
	defer deadline.Stop()
	for i := 0; i < 8; i++ {
		select {
		case <-started:
		case <-deadline.C:
			t.Fatalf("only %d requests started before cancellation", calls.Load())
		}
	}
	cancel()
	select {
	case results := <-done:
		if len(results) != 0 {
			t.Fatalf("canceled requests returned results: %#v", results)
		}
	case <-time.After(time.Second):
		t.Fatal("batch did not finish after context cancellation")
	}
	if active.Load() != 0 {
		t.Fatalf("batch returned with %d requests still active", active.Load())
	}
	if calls.Load() != 8 {
		t.Fatalf("queued requests started after cancellation: calls=%d, want 8", calls.Load())
	}
}

func TestFetchAllNavsKeepsLaterBatchAfterNineSeconds(t *testing.T) {
	var active atomic.Int32
	codes := make([]string, 16)
	for i := range codes {
		codes[i] = fmt.Sprintf("%06d", i+1)
	}
	results := fetchAllNavsWith(codes, func(string) *NavResult {
		active.Add(1)
		defer active.Add(-1)
		// Eight workers need two five-second batches. The former nine-second
		// batch timer discarded the second batch while its requests were active.
		time.Sleep(5 * time.Second)
		return &NavResult{Nav: "2026-10-08", NavPrice: 2.2691}
	})
	if len(results) != len(codes) {
		t.Errorf("later batch discarded after nine seconds: got %d results, want %d", len(results), len(codes))
	}
	if active.Load() != 0 {
		t.Errorf("batch returned with %d requests still active", active.Load())
	}
}
