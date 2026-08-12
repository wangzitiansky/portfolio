package main

import (
	"math"
	"sort"
	"time"
)

type Quote struct {
	Code       string  `json:"code"`
	Market     string  `json:"market"`
	Name       string  `json:"name"`
	Price      float64 `json:"price"`
	Change     float64 `json:"change"`
	ChangePct  float64 `json:"changePct"`
	Currency   string  `json:"currency"`
	TS         int64   `json:"ts"`
}

type NavResult struct {
	Nav       string  `json:"navDate"`
	NavPrice  float64 `json:"nav"`
	Change    float64 `json:"change"`
	ChangePct float64 `json:"changePct"`
}

type FxResult struct {
	Rates  map[string]float64 `json:"rates"`
	TS     int64              `json:"ts"`
	Source string             `json:"source"`
}

type KPI struct {
	Total      float64 `json:"total"`
	TodayPnl   float64 `json:"todayPnl"`
	TotalPnl   float64 `json:"totalPnl"`
	Count      int     `json:"count"`
	IndexCount int     `json:"indexCount"`
}

type ChartItem struct {
	Name  string  `json:"name"`
	Value float64 `json:"value"`
}

func enrich(h Holding, quotes map[string]Quote, fx *FxResult, nav *NavResult) Holding {
	qkey := h.Market + h.Code
	quote, hasQuote := quotes[qkey]

	// stale: 行情 >2min 或净值 >1天视为过期
	stale := false
	if h.Market == "of" && nav != nil && nav.Nav != "" {
		navDate, err := time.ParseInLocation("2006-01-02", nav.Nav, time.FixedZone("CST", 8*3600))
		if err == nil {
			// 30h 宽限期：覆盖 Asia 时区偏移 (8h) + 净值发布延迟（通常 20:00 后才出）
			stale = time.Since(navDate) > 30*time.Hour
		}
	} else if hasQuote {
		stale = (nowMs() - quote.TS) > 120000
	}

	// name backfill
	if hasQuote && quote.Name != "" && (h.Name == "" || h.Name == h.Code) {
		h.Name = quote.Name
	}

	// price
	var price *float64
	priceSource := "none"
	if h.Market == "of" {
		if nav != nil && nav.NavPrice > 0 {
			p := nav.NavPrice
			price = &p
			priceSource = "nav"
		} else {
			p := h.Cost
			price = &p
			priceSource = "nav-stale"
		}
	} else if h.Market == "manual" {
		priceSource = "manual"
	} else if hasQuote {
		p := quote.Price
		price = &p
		priceSource = "quote"
	}

	usePrice := h.Cost
	if price != nil {
		usePrice = *price
	}
	marketValue := usePrice * h.Quantity
	marketValueCNY := toCNY(marketValue, h.Currency, fx)

	var pnl, pnlPct float64
	if price != nil {
		pnl = (*price - h.Cost) * h.Quantity
		if h.Cost > 0 {
			pnlPct = (*price - h.Cost) / h.Cost * 100
		}
	}

	change := 0.0
	changePct := 0.0
	if nav != nil {
		change = nav.Change
		changePct = nav.ChangePct
	}
	if hasQuote {
		change = quote.Change
		changePct = quote.ChangePct
	}

	h.Price = price
	h.PriceSource = priceSource
	h.Stale = stale
	h.MarketValue = marketValue
	h.MarketValueCNY = marketValueCNY
	h.PnL = pnl
	h.PnLPct = pnlPct
	h.Change = change
	h.ChangePct = changePct
	return h
}

func calcKPIs(rows []Holding, fx *FxResult) KPI {
	k := KPI{Count: len(rows)}
	for _, r := range rows {
		if !math.IsNaN(r.MarketValueCNY) && !math.IsInf(r.MarketValueCNY, 0) {
			k.Total += r.MarketValueCNY
		}
	}

	rates := map[string]float64{"CNY": fallbackUSDCNY, "HKD": fallbackUSDHKD}
	if fx != nil && fx.Rates != nil {
		for key, val := range fx.Rates {
			rates[key] = val
		}
	}
	usdRate := rates["CNY"]
	var hkdRate float64
	if rates["HKD"] == 0 {
		hkdRate = fallbackUSDCNY / fallbackUSDHKD
	} else {
		hkdRate = usdRate / rates["HKD"]
	}

	for _, r := range rows {
		if r.Change != 0 {
			pnlLocal := r.Change * r.Quantity
			switch r.Currency {
			case "USD":
				k.TodayPnl += pnlLocal * usdRate
			case "HKD":
				k.TodayPnl += pnlLocal * hkdRate
			default:
				k.TodayPnl += pnlLocal
			}
		}
		switch r.Currency {
		case "USD":
			k.TotalPnl += r.PnL * usdRate
		case "HKD":
			k.TotalPnl += r.PnL * hkdRate
		default:
			k.TotalPnl += r.PnL
		}
	}

	seen := map[string]bool{}
	for _, r := range rows {
		if r.Index != "" {
			seen[r.Index] = true
		}
	}
	k.IndexCount = len(seen)
	return k
}

func holdingsCategory(h Holding) string {
	if h.Market == "us" && h.Type == "stock" {
		return "美股"
	}
	if h.Market == "hk" && h.Type == "stock" {
		return "港股"
	}
	if (h.Market == "sh" || h.Market == "sz") && (h.Type == "etf" || h.Type == "fund") {
		return "场内基金"
	}
	if h.Market == "of" && (h.Type == "etf" || h.Type == "fund") {
		return "场外基金"
	}
	switch h.Market {
	case "us":
		return "美股"
	case "hk":
		return "港股"
	case "sh", "sz":
		return "场内"
	case "of":
		return "场外基金"
	case "manual":
		return "手动"
	}
	return "其他"
}

func aggregateByHolding(rows []Holding) []ChartItem {
	var result []ChartItem
	for _, r := range rows {
		name := r.Name
		if name == "" {
			name = r.Code
		}
		result = append(result, ChartItem{Name: name, Value: r.MarketValueCNY})
	}
	sortByValue(result)
	return result
}

func aggregateByCategory(rows []Holding) []ChartItem {
	buckets := map[string]float64{}
	order := []string{"美股", "港股", "场内基金", "场外基金", "场内", "手动", "其他"}
	for _, r := range rows {
		cat := holdingsCategory(r)
		buckets[cat] += r.MarketValueCNY
	}
	var result []ChartItem
	for _, cat := range order {
		if v, ok := buckets[cat]; ok {
			result = append(result, ChartItem{Name: cat, Value: v})
			delete(buckets, cat)
		}
	}
	for cat, v := range buckets {
		result = append(result, ChartItem{Name: cat, Value: v})
	}
	return result
}

func aggregateByIndex(rows []Holding) []ChartItem {
	buckets := map[string]float64{}
	for _, r := range rows {
		key := r.Index
		if key == "" {
			key = r.Name
		}
		if key == "" {
			key = r.Code
		}
		buckets[key] += r.MarketValueCNY
	}
	var result []ChartItem
	for name, val := range buckets {
		result = append(result, ChartItem{Name: name, Value: val})
	}
	sortByValue(result)
	return result
}

func sortByValue(items []ChartItem) {
	sort.Slice(items, func(i, j int) bool {
		return items[i].Value > items[j].Value
	})
}

func toCNY(amount float64, currency string, fx *FxResult) float64 {
	if math.IsNaN(amount) || math.IsInf(amount, 0) {
		return 0
	}
	if currency == "CNY" {
		return amount
	}
	if fx == nil || fx.Rates == nil {
		if currency == "CNY" {
			return amount
		}
		return 0
	}
	rates := fx.Rates
	if currency == "USD" {
		cny := rates["CNY"]
		if cny == 0 {
			cny = fallbackUSDCNY
		}
		return amount * cny
	}
	if currency == "HKD" {
		cny := rates["CNY"]
		if cny == 0 {
			cny = fallbackUSDCNY
		}
		hkd := rates["HKD"]
		if hkd == 0 {
			hkd = fallbackUSDHKD
		}
		return amount * cny / hkd
	}
	return amount
}

func nowMs() int64 {
	return time.Now().UnixMilli()
}
