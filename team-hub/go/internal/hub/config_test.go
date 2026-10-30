package hub

// Configuration and schema: the two things that decide whether this process can
// serve at all. Both are exercised without a listener.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadConfigRequiresDatabaseAndSessionKey(t *testing.T) {
	report := LoadConfig(map[string]string{"MIGRATIONS_DIR": migrationsDir(t)}, migrationsDir(t))
	if len(report.Errors) < 2 {
		t.Fatalf("expected at least two configuration errors, got %v", report.Errors)
	}
	joined := strings.Join(report.Errors, "\n")
	if !strings.Contains(joined, "DATABASE_PATH") {
		t.Fatalf("DATABASE_PATH error missing: %v", report.Errors)
	}
	if !strings.Contains(joined, SessionSecretEnv) {
		t.Fatalf("session secret error missing: %v", report.Errors)
	}
	if !strings.Contains(strings.Join(report.Report, "\n"), "503 NOT_CONFIGURED") {
		t.Fatalf("the report does not name the closed routes: %v", report.Report)
	}
}

func TestLoadConfigResolvesDefaults(t *testing.T) {
	report := LoadConfig(map[string]string{
		"DATABASE_PATH":  "/tmp/hub.sqlite",
		SessionSecretEnv: "secret",
		"MIGRATIONS_DIR": migrationsDir(t),
	}, migrationsDir(t))
	if len(report.Errors) > 0 {
		t.Fatalf("unexpected configuration errors: %v", report.Errors)
	}
	config := report.Config
	if config.Host != "127.0.0.1" || config.Port != 8080 || config.SweepIntervalMS != 60_000 {
		t.Fatalf("defaults not resolved: %+v", config)
	}
	if config.GitHub != nil || config.Account != nil || config.APNS != nil || config.BootstrapToken != "" {
		t.Fatalf("an unconfigured group was reported present: %+v", config)
	}
}

func TestLoadConfigRejectsInvalidNumbersAndMissingMigrations(t *testing.T) {
	report := LoadConfig(map[string]string{
		"DATABASE_PATH":     "/tmp/hub.sqlite",
		SessionSecretEnv:    "secret",
		"PORT":              "eighty",
		"SWEEP_INTERVAL_MS": "-5",
		"MIGRATIONS_DIR":    filepath.Join(t.TempDir(), "absent"),
	}, "")
	joined := strings.Join(report.Errors, "\n")
	for _, expected := range []string{"PORT must be an integer", "SWEEP_INTERVAL_MS must be between", "MIGRATIONS_DIR"} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("missing %q in %v", expected, report.Errors)
		}
	}
}

func TestLoadConfigWarnsOnNonLoopbackHost(t *testing.T) {
	report := LoadConfig(map[string]string{
		"DATABASE_PATH":  "/tmp/hub.sqlite",
		SessionSecretEnv: "secret",
		"HOST":           "0.0.0.0",
		"MIGRATIONS_DIR": migrationsDir(t),
	}, migrationsDir(t))
	if len(report.Errors) > 0 {
		t.Fatalf("unexpected configuration errors: %v", report.Errors)
	}
	if !strings.Contains(strings.Join(report.Report, "\n"), "not a loopback address") {
		t.Fatalf("missing loopback warning: %v", report.Report)
	}
}

func TestApplyMigrationsIsIdempotent(t *testing.T) {
	database, err := OpenDB(filepath.Join(t.TempDir(), "hub.sqlite"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer database.Close()

	applied, newly, err := ApplyMigrations(database, migrationsDir(t))
	if err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	if len(applied) != 4 || len(newly) != 4 {
		t.Fatalf("expected four migrations, got applied=%v newly=%v", applied, newly)
	}
	again, secondNewly, err := ApplyMigrations(database, migrationsDir(t))
	if err != nil {
		t.Fatalf("re-apply migrations: %v", err)
	}
	if len(again) != 4 || len(secondNewly) != 0 {
		t.Fatalf("second run was not a no-op: applied=%v newly=%v", again, secondNewly)
	}
	done, pending, err := MigrationStatus(database, migrationsDir(t))
	if err != nil {
		t.Fatalf("migration status: %v", err)
	}
	if len(done) != 4 || len(pending) != 0 {
		t.Fatalf("status wrong: done=%v pending=%v", done, pending)
	}
	var rows int
	if err := database.QueryRow("SELECT COUNT(*) FROM d1_migrations").Scan(&rows); err != nil {
		t.Fatalf("count ledger: %v", err)
	}
	if rows != 4 {
		t.Fatalf("expected four ledger rows, got %d", rows)
	}
}

func TestMigrationsComeFromTheRepositoryDirectory(t *testing.T) {
	entries, err := os.ReadDir(migrationsDir(t))
	if err != nil {
		t.Fatalf("read migrations: %v", err)
	}
	if len(entries) != 4 {
		t.Fatalf("expected the four repository migrations, got %d", len(entries))
	}
}
