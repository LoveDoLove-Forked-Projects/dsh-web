package hub

// Hosts and the agents they own: registration, liveness, tokens and the roster
// members read.

import "errors"

// HostOfflineThresholdMS is section 13's three missed heartbeats.
const HostOfflineThresholdMS = 45_000

// AgentDefinition is supplement A4.1's agent definition; preset_id is mandatory.
type AgentDefinition struct {
	Name            string
	PresetID        string
	Model           *string
	ReasoningEffort *string
}

// FindHost resolves a host of one team.
func (h *Hub) FindHost(teamID, hostID string) (*Host, error) {
	host, err := queryHost(h.db, "SELECT "+hostColumns+" FROM hosts WHERE id = ? AND team_id = ?", hostID, teamID)
	if err != nil {
		return nil, err
	}
	if host == nil {
		return nil, FailWith(CodeHostNotFound, "Host not found on this team.", map[string]any{"host_id": hostID})
	}
	return host, nil
}

// FindAgent resolves an agent of one team, or nil.
func (h *Hub) FindAgent(teamID, agentID string) (*Agent, error) {
	return queryAgent(h.db, "SELECT "+agentColumns+" FROM agents WHERE id = ? AND team_id = ?", agentID, teamID)
}

// IssueHostToken mints the credential a Host registers with.
func (h *Hub) IssueHostToken(teamID string, actor *Principal, hostname string, now int64) (map[string]any, error) {
	token, hash := mintHostToken()
	host := &Host{
		ID: NewID("host", now), TeamID: teamID, OwnerMemberID: actor.Member.ID, Hostname: hostname,
		ClientVersion: "", TokenHash: hash, Status: "offline", LastHeartbeatAt: 0,
		CreatedAt: now, UpdatedAt: now,
	}
	_, err := h.db.Exec(
		`INSERT INTO hosts (id, team_id, owner_member_id, hostname, client_version, token_hash,
		 status, last_heartbeat_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		host.ID, host.TeamID, host.OwnerMemberID, host.Hostname, host.ClientVersion, host.TokenHash,
		host.Status, host.LastHeartbeatAt, host.CreatedAt, host.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return map[string]any{"host_id": host.ID, "host_token": token}, nil
}

// RevokeHostToken overwrites the hash so the token stops resolving.
func (h *Hub) RevokeHostToken(teamID, hostID string, now int64) error {
	if _, err := h.FindHost(teamID, hostID); err != nil {
		return err
	}
	_, err := h.db.Exec("UPDATE hosts SET status = 'revoked', token_hash = ?, updated_at = ? WHERE id = ?",
		"revoked:"+RandomHex(16), now, hostID)
	return err
}

func (h *Hub) markHostOnline(host *Host, now int64) (bool, error) {
	wasOffline := host.Status != "online"
	_, err := h.db.Exec("UPDATE hosts SET status = 'online', last_heartbeat_at = ?, updated_at = ? WHERE id = ?",
		now, now, host.ID)
	if err != nil {
		return false, err
	}
	if wasOffline {
		if err := h.publish(host.TeamID, []ChannelEvent{{
			Event:   "host.status_changed",
			Payload: map[string]any{"host_id": host.ID, "status": "online"},
		}}); err != nil {
			return false, err
		}
	}
	host.Status = "online"
	host.LastHeartbeatAt = now
	return wasOffline, nil
}

// RegisterHost announces a host and synchronises the agents it advertises. An
// agent the host stops advertising is marked offline rather than deleted,
// because issues still reference it.
func (h *Hub) RegisterHost(host *Host, hostname, clientVersion string, agents []AgentDefinition, now int64) (*RegistrationResult, error) {
	if _, err := h.markHostOnline(host, now); err != nil {
		return nil, err
	}
	if _, err := h.db.Exec("UPDATE hosts SET hostname = ?, client_version = ?, updated_at = ? WHERE id = ?",
		hostname, clientVersion, now, host.ID); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(agents))
	reported := make([]AgentEntry, 0, len(agents))
	conflicts := make([]AgentConflict, 0)
	for _, definition := range agents {
		existing, err := queryAgent(h.db, "SELECT "+agentColumns+" FROM agents WHERE team_id = ? AND name = ?",
			host.TeamID, definition.Name)
		if err != nil {
			return nil, err
		}
		// Review S4: one clashing name must not take the whole host offline, so
		// the definition is skipped and the host is told which name it lost.
		if existing != nil && existing.HostID != host.ID {
			conflicts = append(conflicts, AgentConflict{
				Name: definition.Name, Reason: "agent name already belongs to another host"})
			continue
		}
		names = append(names, definition.Name)
		if existing != nil {
			_, err := h.db.Exec("UPDATE agents SET preset_id = ?, model = ?, reasoning_effort = ?, "+
				"owner_member_id = ?, status = 'idle', updated_at = ? WHERE id = ?",
				definition.PresetID, definition.Model, definition.ReasoningEffort,
				host.OwnerMemberID, now, existing.ID)
			if err != nil {
				return nil, err
			}
			reported = append(reported, AgentEntry{ID: existing.ID, Name: existing.Name})
			continue
		}
		agentID := NewID("agent", now)
		_, err = h.db.Exec(
			`INSERT INTO agents (id, team_id, host_id, owner_member_id, name, preset_id, model,
			 reasoning_effort, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			agentID, host.TeamID, host.ID, host.OwnerMemberID, definition.Name, definition.PresetID,
			definition.Model, definition.ReasoningEffort, "idle", now, now)
		if err != nil {
			return nil, err
		}
		reported = append(reported, AgentEntry{ID: agentID, Name: definition.Name})
	}
	if len(names) > 0 {
		marks := ""
		args := make([]any, 0, len(names)+2)
		args = append(args, now, host.ID)
		for index, name := range names {
			if index > 0 {
				marks += ", "
			}
			marks += "?"
			args = append(args, name)
		}
		if _, err := h.db.Exec("UPDATE agents SET status = 'offline', updated_at = ? WHERE host_id = ? "+
			"AND name NOT IN ("+marks+")", args...); err != nil {
			return nil, err
		}
	} else if _, err := h.db.Exec("UPDATE agents SET status = 'offline', updated_at = ? WHERE host_id = ?",
		now, host.ID); err != nil {
		return nil, err
	}
	return &RegistrationResult{HostID: host.ID, Status: "online", Agents: reported, Conflicts: conflicts}, nil
}

// Heartbeat is section 5 liveness: the anchor of offline detection.
func (h *Hub) Heartbeat(host *Host, hostID string, now int64) (int64, error) {
	if host.ID != hostID {
		return 0, FailWith(CodeHostMismatch, "This Host token does not belong to the host in the path.",
			map[string]any{"host_id": hostID})
	}
	if _, err := h.markHostOnline(host, now); err != nil {
		return 0, err
	}
	return now, nil
}

// SweepOfflineHosts marks every host silent past the threshold offline.
func (h *Hub) SweepOfflineHosts(teamID string, now int64) ([]*Host, error) {
	hosts, err := Collect(h.db,
		"SELECT "+hostColumns+" FROM hosts WHERE team_id = ? AND status = 'online' AND last_heartbeat_at < ?",
		scanHost, teamID, now-HostOfflineThresholdMS)
	if err != nil {
		return nil, err
	}
	for _, host := range hosts {
		if _, err := h.db.Exec("UPDATE hosts SET status = 'offline', updated_at = ? WHERE id = ?",
			now, host.ID); err != nil {
			return nil, err
		}
		if err := h.publish(teamID, []ChannelEvent{{
			Event:   "host.status_changed",
			Payload: map[string]any{"host_id": host.ID, "status": "offline"},
		}}); err != nil {
			return nil, err
		}
	}
	return hosts, nil
}

// agentHostOnline reports whether the host an agent is bound to is online.
func (h *Hub) agentHostOnline(agentID string) (bool, error) {
	var online int
	err := h.db.QueryRow("SELECT 1 FROM agents a JOIN hosts h ON h.id = a.host_id "+
		"WHERE a.id = ? AND h.status = 'online' LIMIT 1", agentID).Scan(&online)
	if errors.Is(err, errNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// ListAgentBindings is supplement A2.1: the roster with each host's liveness.
func (h *Hub) ListAgentBindings(teamID string) ([]AgentBinding, error) {
	rows, err := h.db.Query("SELECT a.id, a.name, a.host_id, a.owner_member_id, h.status FROM agents a "+
		"JOIN hosts h ON h.id = a.host_id WHERE a.team_id = ? ORDER BY a.name", teamID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	bindings := make([]AgentBinding, 0)
	for rows.Next() {
		var binding AgentBinding
		var status string
		if err := rows.Scan(&binding.ID, &binding.Name, &binding.HostID, &binding.OwnerMemberID, &status); err != nil {
			return nil, err
		}
		binding.HostStatus = "offline"
		if status == "online" {
			binding.HostStatus = "online"
		}
		bindings = append(bindings, binding)
	}
	return bindings, rows.Err()
}
