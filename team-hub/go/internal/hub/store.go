package hub

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	_ "modernc.org/sqlite"
)

// DB is the one SQLite handle the process owns. A single connection keeps the
// process's writes serialised the way the Worker's Durable Object did, so two
// statements can never interleave inside a transaction.
type DB struct {
	sql  *sql.DB
	path string
}

// OpenDB opens (creating when absent) the hub's SQLite file: foreign keys
// enforced, WAL on, a bounded busy timeout.
func OpenDB(path string) (*DB, error) {
	dsn := "file:" + path + "?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)"
	handle, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	handle.SetMaxOpenConns(1)
	handle.SetMaxIdleConns(1)
	if err := handle.Ping(); err != nil {
		_ = handle.Close()
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	return &DB{sql: handle, path: path}, nil
}

// Path is the file this handle owns.
func (d *DB) Path() string { return d.path }

// Close releases the handle.
func (d *DB) Close() error { return d.sql.Close() }

// Ping proves the database answers, which readiness reports.
func (d *DB) Ping() error { return d.sql.Ping() }

// Exec runs one or more statements and reports the last statement's result.
func (d *DB) Exec(query string, args ...any) (sql.Result, error) {
	return d.sql.Exec(query, args...)
}

// Query runs a statement returning rows.
func (d *DB) Query(query string, args ...any) (*sql.Rows, error) {
	return d.sql.Query(query, args...)
}

// QueryRow runs a statement returning at most one row.
func (d *DB) QueryRow(query string, args ...any) *sql.Row {
	return d.sql.QueryRow(query, args...)
}

// Tx runs fn inside one write transaction.
func (d *DB) Tx(fn func(tx *sql.Tx) error) error {
	tx, err := d.sql.Begin()
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

// Collect reads every row a query returns through one row scanner.
func Collect[T any](db *DB, query string, scan func(scanner) (*T, error), args ...any) ([]*T, error) {
	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]*T, 0)
	for rows.Next() {
		item, err := scan(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// errNoRows is the database/sql sentinel under a name the domain code reads.
var errNoRows = sql.ErrNoRows

// marshalJSON is the one place a value becomes the JSON text a column stores.
func marshalJSON(value any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// joinAnd joins WHERE clauses with the conjunction every query here uses.
func joinAnd(clauses []string) string { return strings.Join(clauses, " AND ") }

// changed reports how many rows the last write touched.
func changed(result sql.Result) int64 {
	if result == nil {
		return 0
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return 0
	}
	return rows
}
