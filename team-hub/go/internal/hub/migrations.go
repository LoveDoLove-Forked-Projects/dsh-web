package hub

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// The schema is team-hub/migrations/*.sql verbatim, the same files the Worker
// applies through D1. Each migration applies once, inside one transaction, and
// is recorded in the same bookkeeping table D1 uses, so the two schemas stay
// interchangeable.

const migrationLedgerDDL = `CREATE TABLE IF NOT EXISTS d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
)`

type migrationFile struct {
	Name string
	SQL  string
}

func readMigrations(dir string) ([]migrationFile, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("read migrations %s: %w", dir, err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	files := make([]migrationFile, 0, len(names))
	for _, name := range names {
		body, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return nil, fmt.Errorf("read migration %s: %w", name, err)
		}
		files = append(files, migrationFile{Name: name, SQL: string(body)})
	}
	return files, nil
}

func ensureLedger(db *DB) error {
	_, err := db.Exec(migrationLedgerDDL)
	return err
}

func appliedNames(db *DB) ([]string, error) {
	rows, err := db.Query("SELECT name FROM d1_migrations ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	names := make([]string, 0)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		names = append(names, name)
	}
	return names, rows.Err()
}

// ApplyMigrations applies every migration the ledger does not hold yet and is
// idempotent: a second call changes nothing.
func ApplyMigrations(db *DB, dir string) (applied []string, newly []string, err error) {
	if err := ensureLedger(db); err != nil {
		return nil, nil, err
	}
	files, err := readMigrations(dir)
	if err != nil {
		return nil, nil, err
	}
	done, err := appliedNames(db)
	if err != nil {
		return nil, nil, err
	}
	seen := make(map[string]bool, len(done))
	for _, name := range done {
		seen[name] = true
	}
	newly = make([]string, 0)
	for _, file := range files {
		if seen[file.Name] {
			continue
		}
		migration := file
		err := db.Tx(func(tx *sql.Tx) error {
			if _, err := tx.Exec(migration.SQL); err != nil {
				return fmt.Errorf("apply %s: %w", migration.Name, err)
			}
			_, err := tx.Exec("INSERT INTO d1_migrations (name) VALUES (?)", migration.Name)
			return err
		})
		if err != nil {
			return nil, nil, err
		}
		newly = append(newly, migration.Name)
	}
	applied = make([]string, 0, len(files))
	for _, file := range files {
		applied = append(applied, file.Name)
	}
	return applied, newly, nil
}

// MigrationStatus reports which migrations on disk are applied and which are
// still pending; readiness reads this without changing anything.
func MigrationStatus(db *DB, dir string) (applied []string, pending []string, err error) {
	if err := ensureLedger(db); err != nil {
		return nil, nil, err
	}
	files, err := readMigrations(dir)
	if err != nil {
		return nil, nil, err
	}
	done, err := appliedNames(db)
	if err != nil {
		return nil, nil, err
	}
	seen := make(map[string]bool, len(done))
	for _, name := range done {
		seen[name] = true
	}
	applied = make([]string, 0, len(files))
	pending = make([]string, 0)
	for _, file := range files {
		if seen[file.Name] {
			applied = append(applied, file.Name)
			continue
		}
		pending = append(pending, file.Name)
	}
	return applied, pending, nil
}
