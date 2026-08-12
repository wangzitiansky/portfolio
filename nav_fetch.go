package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"sync"
	"time"
)

const (
	navHistoryURL = "https://api.fund.eastmoney.com/f10/lsjz"
	navTimeout    = 8
)

var (
	navHTTPClient = &http.Client{Timeout: time.Duration(navTimeout) * time.Second}
	navHistRe     = regexp.MustCompile(`\{.*\}`)
)

func fetchNav(code string) *NavResult {
	start := time.Now()
	entries, err := fetchNavHistory(code, 2)
	if err != nil {
		log.Printf("[nav] %s history fetch error: %v", code, err)
		return nil
	}
	if len(entries) == 0 || entries[0].Value == 0 {
		if len(entries) == 0 {
			log.Printf("[nav] %s returned 0 entries", code)
		} else {
			log.Printf("[nav] %s nav value is 0", code)
		}
		return nil
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

	log.Printf("[nav] %s OK nav=%s %.4f chg=%+.2f%% (%dms)",
		code, entries[0].Date, entries[0].Value, changePct, time.Since(start).Milliseconds())

	return &NavResult{
		Nav:       entries[0].Date,
		NavPrice:  entries[0].Value,
		Change:    change,
		ChangePct: changePct,
	}
}

func fetchAllNavs(codes []string) map[string]*NavResult {
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
				ch <- pair{code, fetchNav(code)}
			}
		}()
	}
	go func() {
		for _, code := range unique {
			jobs <- code
		}
		close(jobs)
		wg.Wait()
		close(ch)
	}()

	results := map[string]*NavResult{}
	timer := time.NewTimer(time.Duration(navTimeout+1) * time.Second)
	defer timer.Stop()
	for {
		select {
		case p, ok := <-ch:
			if !ok {
				return results
			}
			if p.nav != nil {
				results[p.code] = p.nav
			}
		case <-timer.C:
			return results
		}
	}
}

type navEntry struct {
	Date  string
	Value float64
}

func fetchNavHistory(code string, pageSize int) ([]navEntry, error) {
	params := url.Values{}
	params.Set("fundCode", code)
	params.Set("pageIndex", "1")
	params.Set("pageSize", strconv.Itoa(pageSize))
	requestURL := fmt.Sprintf("%s?%s", navHistoryURL, params.Encode())
	req, err := http.NewRequest("GET", requestURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0")
	req.Header.Set("Referer", "https://fund.eastmoney.com/")
	resp, err := navHTTPClient.Do(req)
	if err != nil {
		log.Printf("[nav] %s HTTP error: %v", code, err)
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		log.Printf("[nav] %s bad status %d", code, resp.StatusCode)
		return nil, fmt.Errorf("bad status %d", resp.StatusCode)
	}

	// 使用 io.ReadAll 完整读取，避免截断
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Printf("[nav] %s read body error: %v", code, err)
		return nil, err
	}
	text := string(body)
	m := navHistRe.FindString(text)
	if m == "" {
		log.Printf("[nav] %s no JSON in response (body %d bytes)", code, len(body))
		return nil, fmt.Errorf("no json in response")
	}

	var data struct {
		Data struct {
			LSJZList []struct {
				DWJZ string `json:"DWJZ"`
				FSRQ string `json:"FSRQ"`
			} `json:"LSJZList"`
		} `json:"Data"`
	}
	if err := json.Unmarshal([]byte(m), &data); err != nil {
		log.Printf("[nav] %s JSON parse error: %v", code, err)
		return nil, err
	}

	var entries []navEntry
	for _, item := range data.Data.LSJZList {
		v, _ := strconv.ParseFloat(item.DWJZ, 64)
		if v > 0 {
			entries = append(entries, navEntry{Date: item.FSRQ, Value: v})
		}
	}
	return entries, nil
}
