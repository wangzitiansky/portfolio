package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const (
	fundSuggestURL = "https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx"
	fundListURL    = "https://fund.eastmoney.com/js/fundcode_search.js"
	fundMaxBody    = 8 << 20
)

var (
	fundHTTPClient = &http.Client{Timeout: 10 * time.Second}
	fundCodeRe     = regexp.MustCompile(`^\d{6}$`)
	fundListRe     = regexp.MustCompile(`\["(\d{6})","[^"]*","([^"]*)","([^"]*)"`)
)

type fundSuggestion struct {
	Code      string  `json:"code"`
	Name      string  `json:"name"`
	FType     string  `json:"ftype"`
	OtherName string  `json:"othername"`
	Nav       float64 `json:"nav"`
	NavDate   string  `json:"navDate"`
}

func handleFundSuggest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "GET only"})
		return
	}
	key := strings.TrimSpace(r.URL.Query().Get("key"))
	if !fundCodeRe.MatchString(key) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "基金代码必须是 6 位数字"})
		return
	}

	params := url.Values{"m": {"1"}, "key": {key}}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, fundSuggestURL+"?"+params.Encode(), nil)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "基金查询请求无效"})
		return
	}
	req.Header.Set("User-Agent", "Mozilla/5.0")
	resp, err := fundHTTPClient.Do(req)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "基金查询失败"})
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": fmt.Sprintf("基金查询返回 %d", resp.StatusCode)})
		return
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, fundMaxBody))
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "基金查询响应读取失败"})
		return
	}
	start, end := strings.IndexByte(string(body), '{'), strings.LastIndexByte(string(body), '}')
	if start < 0 || end < start {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "基金查询响应无效"})
		return
	}
	var data struct {
		Datas []struct {
			Code         string `json:"CODE"`
			Name         string `json:"NAME"`
			FundBaseInfo struct {
				ShortName string  `json:"SHORTNAME"`
				FType     string  `json:"FTYPE"`
				OtherName string  `json:"OTHERNAME"`
				Nav       float64 `json:"DWJZ"`
				NavDate   string  `json:"FSRQ"`
			} `json:"FundBaseInfo"`
		} `json:"Datas"`
	}
	if err := json.Unmarshal(body[start:end+1], &data); err != nil || len(data.Datas) == 0 {
		writeJSON(w, http.StatusOK, nil)
		return
	}
	item := data.Datas[0]
	name := item.FundBaseInfo.ShortName
	if name == "" {
		name = item.Name
	}
	writeJSON(w, http.StatusOK, fundSuggestion{
		Code: item.Code, Name: name, FType: item.FundBaseInfo.FType,
		OtherName: item.FundBaseInfo.OtherName, Nav: item.FundBaseInfo.Nav, NavDate: item.FundBaseInfo.NavDate,
	})
}

func handleFundList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "GET only"})
		return
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, fundListURL, nil)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "基金清单请求无效"})
		return
	}
	req.Header.Set("User-Agent", "Mozilla/5.0")
	resp, err := fundHTTPClient.Do(req)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "基金清单加载失败"})
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": fmt.Sprintf("基金清单返回 %d", resp.StatusCode)})
		return
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, fundMaxBody))
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "基金清单响应读取失败"})
		return
	}
	matches := fundListRe.FindAllStringSubmatch(string(body), -1)
	list := make([][]string, 0, len(matches))
	for _, match := range matches {
		list = append(list, []string{match[1], match[2], match[3]})
	}
	writeJSON(w, http.StatusOK, list)
}
