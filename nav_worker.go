package main

import (
	"log"
	"math"
	"sync"
	"time"
)

const navWorkerInterval = time.Minute

// startNavWorker 持续记录数据库中当前组合的每日净值。任务不依赖浏览器页面是否打开。
func startNavWorker(stop <-chan struct{}) {
	runNavWorker(stop, navWorkerInterval, recordNavSnapshot)
}

func runNavWorker(stop <-chan struct{}, interval time.Duration, record func()) {
	log.Printf("[nav-worker] started interval=%s", interval)
	var active sync.WaitGroup
	running := make(chan struct{}, 1)
	trigger := func() {
		select {
		case running <- struct{}{}:
		default:
			log.Printf("[nav-worker] skipped: previous run still active")
			return
		}
		active.Add(1)
		go func() {
			defer active.Done()
			defer func() { <-running }()
			record()
		}()
	}
	trigger()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			trigger()
		case <-stop:
			active.Wait()
			log.Printf("[nav-worker] stopped")
			return
		}
	}
}

func recordNavSnapshot() {
	holdings, err := getAllHoldings()
	if err != nil {
		log.Printf("[nav-worker] failed: holdings read: %v", err)
		return
	}
	if len(holdings) == 0 {
		log.Printf("[nav-worker] skipped: no holdings")
		return
	}

	// 启用带 30 分钟 TTL 的汇率缓存，避免后台进程永久沿用启动时汇率。
	snapshot, errors := buildSnapshot(holdings, true)
	if len(errors) > 0 {
		log.Printf("[nav-worker] failed: incomplete snapshot: %s", errors[0])
		return
	}
	if snapshot == nil || !finiteNonNegative(snapshot.KPI.Total) || !finiteNumber(snapshot.KPI.TodayPnl) {
		log.Printf("[nav-worker] failed: invalid snapshot values")
		return
	}

	previousTotal := snapshot.KPI.Total - snapshot.KPI.TodayPnl
	todayPnlPct := 0.0
	if previousTotal > 0 && finiteNumber(previousTotal) {
		todayPnlPct = snapshot.KPI.TodayPnl / previousTotal * 100
	}
	if !finiteNumber(todayPnlPct) {
		log.Printf("[nav-worker] failed: invalid daily change")
		return
	}
	date := todayDate()
	if err := upsertTodayNav(date, snapshot.KPI.Total, snapshot.KPI.TodayPnl, todayPnlPct, snapshot.KPI.Count); err != nil {
		log.Printf("[nav-worker] failed: save date=%s: %v", date, err)
		return
	}
	log.Printf("[nav-worker] recorded date=%s total=%.2f count=%d", date, snapshot.KPI.Total, snapshot.KPI.Count)
}

func finiteNumber(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

func finitePositive(value float64) bool {
	return finiteNumber(value) && value > 0
}

func finiteNonNegative(value float64) bool {
	return finiteNumber(value) && value >= 0
}
