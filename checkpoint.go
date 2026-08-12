// Maintenance helper: checkpoint the SQLite WAL into the main db file.
// Run before committing assets/portfolio.db so the committed snapshot
// contains all data (the server auto-checkpoints, but running this
// guarantees the WAL is empty and the main file is complete).
// Run: go run checkpoint.go
package main

import (
	"database/sql"
	"fmt"
	"os"

	_ "github.com/glebarez/sqlite"
)

func main() {
	db, err := sql.Open("sqlite", "assets/portfolio.db")
	if err != nil {
		fmt.Fprintln(os.Stderr, "open:", err)
		os.Exit(1)
	}
	defer db.Close()

	var busy, logFrames, checkpointed int
	if err := db.QueryRow("PRAGMA wal_checkpoint(TRUNCATE)").Scan(&busy, &logFrames, &checkpointed); err != nil {
		fmt.Fprintln(os.Stderr, "checkpoint:", err)
		os.Exit(1)
	}
	fmt.Printf("wal_checkpoint: busy=%d log=%d checkpointed=%d\n", busy, logFrames, checkpointed)
}
