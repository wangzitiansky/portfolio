package main

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var db *gorm.DB

// ── Models ──

type Holding struct {
	ID        string  `json:"id" gorm:"primaryKey"`
	Code      string  `json:"code" gorm:"not null"`
	Market    string  `json:"market" gorm:"not null"`
	Name      string  `json:"name" gorm:"not null"`
	Type      string  `json:"type" gorm:"not null"`
	Index     string  `json:"index" gorm:"column:index_name;default:''"`
	Quantity  float64 `json:"quantity" gorm:"not null"`
	Cost      float64 `json:"cost" gorm:"not null"`
	Currency  string  `json:"currency" gorm:"default:CNY"`
	Account   string  `json:"account" gorm:"default:''"`
	Note      string  `json:"note" gorm:"default:''"`
	CreatedAt int64   `json:"createdAt" gorm:"not null"`
	UpdatedAt int64   `json:"updatedAt" gorm:"not null"`

	// enriched — 不入库
	Price          *float64 `json:"price" gorm:"-"`
	PriceSource    string   `json:"priceSource" gorm:"-"`
	Stale          bool     `json:"stale" gorm:"-"`
	MarketValue    float64  `json:"marketValue" gorm:"-"`
	MarketValueCNY float64  `json:"marketValueCNY" gorm:"-"`
	PnL            float64  `json:"pnl" gorm:"-"`
	PnLPct         float64  `json:"pnlPct" gorm:"-"`
	Change         float64  `json:"change" gorm:"-"`
	ChangePct      float64  `json:"changePct" gorm:"-"`
	Category       string   `json:"category" gorm:"-"`
}

type NavEntry struct {
	Date        string  `json:"date" gorm:"primaryKey"`
	Total       float64 `json:"total" gorm:"not null"`
	TodayPnl    float64 `json:"todayPnl" gorm:"column:today_pnl;not null"`
	TodayPnlPct float64 `json:"todayPnlPct" gorm:"column:today_pnl_pct;not null"`
	Count       int     `json:"count" gorm:"not null"`
}

// ── 初始化 ──

func initDB() error {
	exe, _ := os.Executable()
	baseDir := filepath.Dir(exe)
	if _, err := os.Stat(filepath.Join(baseDir, "assets")); os.IsNotExist(err) {
		baseDir, _ = os.Getwd()
	}
	dbFile := filepath.Join(baseDir, "assets", "portfolio.db")

	var err error
	db, err = gorm.Open(sqlite.Open(dbFile+"?_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)"), &gorm.Config{})
	if err != nil {
		return err
	}

	if err := db.AutoMigrate(&Holding{}, &NavEntry{}); err != nil {
		return err
	}

	maybeMigrateFromJSON(baseDir)
	return nil
}

func closeDB() {
	if db != nil {
		sqlDB, _ := db.DB()
		if sqlDB != nil {
			sqlDB.Close()
		}
	}
}

// ── holdings ──

func getAllHoldings() ([]Holding, error) {
	var result []Holding
	if err := db.Order("updated_at DESC").Find(&result).Error; err != nil {
		return nil, err
	}
	if result == nil {
		result = []Holding{}
	}
	return result, nil
}

func replaceAllHoldings(items []Holding) error {
	// 纠正基金 market 字段：场外基金代码被误标为 sh/sz 的，修正为 of
	for i := range items {
		if corrected := correctFundMarket(items[i].Market, items[i].Code, items[i].Type); corrected != items[i].Market {
			log.Printf("[db] corrected fund %s market: %s -> %s", items[i].Code, items[i].Market, corrected)
			items[i].Market = corrected
		}
	}
	return db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("1 = 1").Delete(&Holding{}).Error; err != nil {
			return err
		}
		if len(items) > 0 {
			if err := tx.Create(&items).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

// correctFundMarket 根据基金代码修正 market 字段，防止场外基金被误标为 sh/sz
func correctFundMarket(market, code, assetType string) string {
	// 只处理 sh/sz 市场（us/hk/of/manual 不受影响）
	if market != "sh" && market != "sz" {
		return market
	}
	// 股票代码和基金代码存在重叠。只有明确标记为基金类时才允许纠正，
	// 不能把 600519、000001 等普通 A 股误改成场外基金。
	if assetType != "fund" && assetType != "etf" && assetType != "money" {
		return market
	}
	// 非 6 位纯数字代码不处理
	if len(code) != 6 {
		return market
	}
	for _, c := range code {
		if c < '0' || c > '9' {
			return market
		}
	}
	// 检查是否匹配场内交易代码段
	if isExchangeTraded(code) {
		return market // 保持原 market
	}
	return "of" // 修正为场外
}

// isExchangeTraded 判断 6 位基金代码是否为场内交易品种（与前端 fundMarket 保持一致）
func isExchangeTraded(code string) bool {
	// 上交所：501xxx（LOF）、502xxx（分级）、510-518xxx（ETF）、588xxx（科创板 ETF）
	if len(code) >= 3 {
		prefix := code[:3]
		switch prefix {
		case "501", "502": // LOF / 分级
			return true
		case "588": // 科创板 ETF
			return true
		}
		if prefix >= "510" && prefix <= "518" {
			return true
		}
	}
	// 深交所：159xxx（ETF）、16xxxx（LOF）
	if len(code) >= 3 && code[:3] == "159" {
		return true
	}
	if len(code) >= 2 && code[:2] == "16" {
		return true
	}
	return false
}

// ── nav_history ──

func getAllNav() ([]NavEntry, error) {
	var result []NavEntry
	if err := db.Order("date ASC").Find(&result).Error; err != nil {
		return nil, err
	}
	if result == nil {
		result = []NavEntry{}
	}
	return result, nil
}

func replaceAllNav(items []NavEntry) error {
	return db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("1 = 1").Delete(&NavEntry{}).Error; err != nil {
			return err
		}
		if len(items) > 0 {
			if err := tx.Create(&items).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

func upsertTodayNav(date string, total, todayPnl, todayPnlPct float64, count int) error {
	return db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "date"}},
		DoUpdates: clause.AssignmentColumns([]string{"total", "today_pnl", "today_pnl_pct", "count"}),
	}).Create(&NavEntry{
		Date: date, Total: total, TodayPnl: todayPnl,
		TodayPnlPct: todayPnlPct, Count: count,
	}).Error
}

// ── 首次 JSON → DB 迁移 ──

func maybeMigrateFromJSON(baseDir string) {
	var count int64
	if err := db.Model(&Holding{}).Count(&count).Error; err != nil || count > 0 {
		return
	}

	dataFile := filepath.Join(baseDir, "assets", "data.json")
	navFile := filepath.Join(baseDir, "assets", "nav-history.json")

	if b, err := os.ReadFile(dataFile); err == nil {
		var items []Holding
		if json.Unmarshal(b, &items) == nil && len(items) > 0 {
			replaceAllHoldings(items)
		}
	}

	if b, err := os.ReadFile(navFile); err == nil {
		var items []NavEntry
		if json.Unmarshal(b, &items) == nil && len(items) > 0 {
			replaceAllNav(items)
		}
	}
}

// ── 辅助 ──

func todayDate() string {
	return time.Now().Format("2006-01-02")
}
