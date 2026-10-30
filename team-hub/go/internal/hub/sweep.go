package hub

// The hub-system half of the state machine: offline hosts, lapsed leases and
// expired questions. The Worker's cron drives it in production; the Go process
// drives it from a ticker, and tests drive it directly.

// SweepTeam runs one team's sweep.
func (h *Hub) SweepTeam(teamID string, now int64) (SweepResult, error) {
	result := SweepResult{}
	offlineHosts, err := h.SweepOfflineHosts(teamID, now)
	if err != nil {
		return result, err
	}
	result.HostsOffline = len(offlineHosts)
	for _, host := range offlineHosts {
		expired, err := h.SweepHostRunningIssues(teamID, host.ID, now)
		if err != nil {
			return result, err
		}
		result.LeasesExpired += expired
	}
	leases, err := h.SweepExpiredLeases(teamID, now)
	if err != nil {
		return result, err
	}
	result.LeasesExpired += leases
	if _, err := h.SweepAssignedAwaitingHost(teamID, now); err != nil {
		return result, err
	}
	questions, err := h.SweepExpiredQuestions(teamID, now)
	if err != nil {
		return result, err
	}
	result.QuestionsExpired = questions
	return result, nil
}

// SweepAll runs the sweep for every team; the process timer calls this.
func (h *Hub) SweepAll(now int64) (SweepResult, error) {
	total := SweepResult{}
	rows, err := h.db.Query("SELECT id FROM teams")
	if err != nil {
		return total, err
	}
	teamIDs := make([]string, 0)
	for rows.Next() {
		var teamID string
		if err := rows.Scan(&teamID); err != nil {
			rows.Close()
			return total, err
		}
		teamIDs = append(teamIDs, teamID)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return total, err
	}
	for _, teamID := range teamIDs {
		result, err := h.SweepTeam(teamID, now)
		if err != nil {
			return total, err
		}
		total.HostsOffline += result.HostsOffline
		total.LeasesExpired += result.LeasesExpired
		total.QuestionsExpired += result.QuestionsExpired
	}
	return total, nil
}
