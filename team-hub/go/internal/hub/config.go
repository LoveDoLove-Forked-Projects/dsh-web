package hub

// Every setting the self-hosted hub reads, resolved from the process
// environment in one place. Nothing falls back to a working default: a group
// that is not configured is reported as closed, and the endpoints that depend
// on it keep answering NOT_CONFIGURED exactly as the Worker does.

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// SessionSecretEnv names the HMAC key that signs session access tokens. It is
// required: without it no session token can be signed or verified.
const SessionSecretEnv = "TEAM_HUB_SESSION_KEY"

// GitHubSettings is the OAuth App the browser and token routes need.
type GitHubSettings struct {
	ClientID     string
	ClientSecret string
}

// AccountSettings is the account service whose assertions this hub trusts.
type AccountSettings struct {
	JWKSURL  string
	Issuer   string
	Audience string
}

// APNSSettings carries the APNs provider credential and topic.
type APNSSettings struct {
	KeyID        string
	TeamID       string
	BundleID     string
	PrivateKeyP8 string
}

// Config is every resolved setting the process runs on.
type Config struct {
	DatabasePath    string
	Host            string
	Port            int
	MigrationsDir   string
	SweepIntervalMS int
	SessionSecret   string
	BootstrapToken  string
	GitHub          *GitHubSettings
	Account         *AccountSettings
	// AccountServiceBase and AccountAdminToken are the account-service admin API
	// the email invite resolves through. They are kept as the raw values rather
	// than a pointer group so the invite can name exactly which one is missing.
	AccountServiceBase string
	AccountAdminToken  string
	APNS               *APNSSettings
}

// ConfigReport is the startup report: one line per setting group, and the
// missing settings that stop the process from starting at all.
type ConfigReport struct {
	Config Config
	Report []string
	Errors []string
}

var loopbackHosts = map[string]bool{"127.0.0.1": true, "::1": true, "localhost": true}

// isInteger is the shape every numeric setting must have before strconv sees it.
func isInteger(raw string) bool {
	body := strings.TrimPrefix(raw, "-")
	if body == "" {
		return false
	}
	for _, character := range body {
		if character < '0' || character > '9' {
			return false
		}
	}
	return true
}

func envText(source map[string]string, name string) string {
	return strings.TrimSpace(source[name])
}

func integerSetting(source map[string]string, name string, fallback, minimum, maximum int, errors *[]string) int {
	raw := envText(source, name)
	if raw == "" {
		return fallback
	}
	if !isInteger(raw) {
		*errors = append(*errors, name+" must be an integer, got '"+raw+"'.")
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < minimum || value > maximum {
		*errors = append(*errors, fmt.Sprintf("%s must be between %d and %d, got %s.", name, minimum, maximum, raw))
		return fallback
	}
	return value
}

// missingInviteSettings names the account-service admin settings that close the
// email invite, one entry per absent setting: a hub that has one and not the
// other must say which one to set.
func missingInviteSettings(base, adminToken string) []string {
	missing := make([]string, 0, 2)
	if base == "" {
		missing = append(missing, "ACCOUNT_SERVICE_BASE")
	}
	if adminToken == "" {
		missing = append(missing, "ACCOUNT_ADMIN_TOKEN")
	}
	return missing
}

// EnvMap converts the process environment into the lookup table LoadConfig
// reads, so the same function serves the process and the test suite.
func EnvMap() map[string]string {
	values := make(map[string]string)
	for _, entry := range os.Environ() {
		key, value, found := strings.Cut(entry, "=")
		if !found {
			continue
		}
		values[key] = value
	}
	return values
}

// DefaultMigrationsDir finds team-hub/migrations next to the working directory
// or the binary, so a checkout and an installed binary both work unconfigured.
func DefaultMigrationsDir() string {
	exists := func(path string) bool {
		info, err := os.Stat(path)
		return err == nil && info.IsDir()
	}
	if cwd, err := os.Getwd(); err == nil {
		for _, candidate := range []string{
			filepath.Join(cwd, "migrations"),
			filepath.Join(cwd, "team-hub", "migrations"),
		} {
			if exists(candidate) {
				return candidate
			}
		}
	}
	if executable, err := os.Executable(); err == nil {
		directory := filepath.Dir(executable)
		for _, candidate := range []string{
			filepath.Join(directory, "migrations"),
			filepath.Join(filepath.Dir(directory), "team-hub", "migrations"),
		} {
			if exists(candidate) {
				return candidate
			}
		}
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "team-hub/migrations"
	}
	return filepath.Join(cwd, "team-hub", "migrations")
}

// LoadConfig resolves the environment and reports every group once.
func LoadConfig(source map[string]string, defaultMigrationsDir string) ConfigReport {
	errors := make([]string, 0)
	report := make([]string, 0)

	databasePath := envText(source, "DATABASE_PATH")
	if databasePath == "" {
		errors = append(errors, "DATABASE_PATH is required: it names the SQLite file this hub owns.")
	}

	host := envText(source, "HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	port := integerSetting(source, "PORT", 8080, 0, 65535, &errors)

	migrationsDir := envText(source, "MIGRATIONS_DIR")
	if migrationsDir == "" {
		migrationsDir = defaultMigrationsDir
	}
	if migrationsDir == "" {
		migrationsDir = DefaultMigrationsDir()
	}
	if entries, err := os.ReadDir(migrationsDir); err != nil {
		errors = append(errors, "MIGRATIONS_DIR "+migrationsDir+" cannot be read: "+err.Error()+".")
	} else if count := len(entries); count == 0 {
		errors = append(errors, "MIGRATIONS_DIR "+migrationsDir+" holds no migration files.")
	}

	sweepInterval := integerSetting(source, "SWEEP_INTERVAL_MS", 60_000, 0, 86_400_000, &errors)

	sessionSecret := envText(source, SessionSecretEnv)
	if sessionSecret == "" {
		errors = append(errors, SessionSecretEnv+" is required: without the HMAC key no session token can be "+
			"signed or verified, so every authenticated route would answer 503.")
	}

	github := (*GitHubSettings)(nil)
	githubID := envText(source, "GITHUB_CLIENT_ID")
	githubSecret := envText(source, "GITHUB_CLIENT_SECRET")
	if githubID != "" && githubSecret != "" {
		github = &GitHubSettings{ClientID: githubID, ClientSecret: githubSecret}
	}

	account := (*AccountSettings)(nil)
	jwksURL := envText(source, "ACCOUNT_JWKS_URL")
	issuer := envText(source, "ACCOUNT_ISSUER")
	audience := envText(source, "ACCOUNT_AUDIENCE")
	if jwksURL != "" && issuer != "" && audience != "" {
		account = &AccountSettings{JWKSURL: jwksURL, Issuer: issuer, Audience: audience}
	}

	accountServiceBase := envText(source, "ACCOUNT_SERVICE_BASE")
	accountAdminToken := envText(source, "ACCOUNT_ADMIN_TOKEN")

	apns := (*APNSSettings)(nil)
	keyID := envText(source, "APNS_KEY_ID")
	teamID := envText(source, "APNS_TEAM_ID")
	bundleID := envText(source, "APNS_BUNDLE_ID")
	privateKey := envText(source, "APNS_PRIVATE_KEY_P8")
	if keyID != "" && teamID != "" && bundleID != "" && privateKey != "" {
		apns = &APNSSettings{KeyID: keyID, TeamID: teamID, BundleID: bundleID, PrivateKeyP8: privateKey}
	}

	bootstrapToken := envText(source, "BOOTSTRAP_TOKEN")

	if databasePath != "" {
		report = append(report, "DATABASE_PATH="+databasePath)
	}
	report = append(report, fmt.Sprintf("PORT=%d HOST=%s", port, host))
	if !loopbackHosts[host] {
		report = append(report, "HOST="+host+" is not a loopback address; keep the port unreachable from the "+
			"network and terminate TLS in a reverse proxy.")
	}
	if sessionSecret == "" {
		report = append(report, SessionSecretEnv+": missing")
	} else {
		report = append(report, SessionSecretEnv+": configured")
	}
	if github == nil {
		report = append(report, "GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET: missing -> GET /auth/github/* and "+
			"POST /auth/token answer 503 NOT_CONFIGURED")
	} else {
		report = append(report, "GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET: configured")
	}
	if account == nil {
		report = append(report, "ACCOUNT_JWKS_URL/ACCOUNT_ISSUER/ACCOUNT_AUDIENCE: missing -> "+
			"POST /auth/account and /auth/account/link answer 503 NOT_CONFIGURED")
	} else {
		report = append(report, "ACCOUNT_JWKS_URL/ACCOUNT_ISSUER/ACCOUNT_AUDIENCE: configured")
	}
	if missing := missingInviteSettings(accountServiceBase, accountAdminToken); len(missing) > 0 {
		report = append(report, strings.Join(missing, "/")+": missing -> "+
			"POST /api/v1/teams/:teamId/members/invite answers 503 NOT_CONFIGURED")
	} else {
		report = append(report, "ACCOUNT_SERVICE_BASE/ACCOUNT_ADMIN_TOKEN: configured")
	}
	if apns == nil {
		report = append(report, "APNS_KEY_ID/APNS_TEAM_ID/APNS_BUNDLE_ID/APNS_PRIVATE_KEY_P8: missing -> "+
			"APNs delivery is skipped and /readyz reports push=false")
	} else {
		report = append(report, "APNS_KEY_ID/APNS_TEAM_ID/APNS_BUNDLE_ID/APNS_PRIVATE_KEY_P8: configured")
	}
	if bootstrapToken == "" {
		report = append(report, "BOOTSTRAP_TOKEN: missing -> POST /api/v1/bootstrap answers 503 NOT_CONFIGURED")
	} else {
		report = append(report, "BOOTSTRAP_TOKEN: configured")
	}
	if sweepInterval == 0 {
		report = append(report, "SWEEP_INTERVAL_MS=0 (the startup sweep runs once, the timer is disabled)")
	} else {
		report = append(report, fmt.Sprintf("SWEEP_INTERVAL_MS=%d (sweep once at startup, then every %d ms)",
			sweepInterval, sweepInterval))
	}
	report = append(report, "MIGRATIONS_DIR="+migrationsDir)

	return ConfigReport{
		Config: Config{
			DatabasePath:       databasePath,
			Host:               host,
			Port:               port,
			MigrationsDir:      migrationsDir,
			SweepIntervalMS:    sweepInterval,
			SessionSecret:      sessionSecret,
			BootstrapToken:     bootstrapToken,
			GitHub:             github,
			Account:            account,
			AccountServiceBase: accountServiceBase,
			AccountAdminToken:  accountAdminToken,
			APNS:               apns,
		},
		Report: report,
		Errors: errors,
	}
}
