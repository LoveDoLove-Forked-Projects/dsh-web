// Command team-hub is the self-hosted team collaboration hub: one static
// binary, one SQLite file, TLS terminated by a reverse proxy in front of it.
package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"team-hub/internal/hub"
)

func main() {
	report := hub.LoadConfig(hub.EnvMap(), hub.DefaultMigrationsDir())
	for _, line := range report.Report {
		fmt.Println("[config] " + line)
	}
	if len(report.Errors) > 0 {
		for _, line := range report.Errors {
			fmt.Fprintln(os.Stderr, "[config] "+line)
		}
		fmt.Fprintf(os.Stderr, "[config] refusing to start with %d configuration error(s)\n", len(report.Errors))
		os.Exit(1)
	}

	logf := func(format string, args ...any) { fmt.Printf(format+"\n", args...) }
	application, err := hub.New(report.Config, hub.Options{Logf: logf})
	if err != nil {
		fmt.Fprintln(os.Stderr, "[hub] "+err.Error())
		os.Exit(1)
	}
	origin, err := application.Start()
	if err != nil {
		fmt.Fprintln(os.Stderr, "[hub] "+err.Error())
		_ = application.Close()
		os.Exit(1)
	}
	fmt.Printf("[hub] listening on %s (protocol %s, database %s, sweep interval %d ms)\n",
		origin, hub.ProtocolVersion, report.Config.DatabasePath, report.Config.SweepIntervalMS)

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	received := <-signals
	fmt.Printf("[hub] %s received, shutting down\n", received)
	if err := application.Close(); err != nil {
		fmt.Fprintln(os.Stderr, "[hub] shutdown: "+err.Error())
		os.Exit(1)
	}
}
