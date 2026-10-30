package hub

// Comments and the mention rows they materialise (section 7, supplement A1.5).

import (
	"database/sql"
	"regexp"
)

// CommentLimitBytes is section 13's comment cap.
const CommentLimitBytes = 32_768

// mentionPattern is section 7's mention syntax: an at-sign followed by a
// username or agent name at a word boundary.
var mentionPattern = regexp.MustCompile(`(^|\s)@([a-zA-Z0-9_-]+)`)

// ExtractMentionHandles returns every distinct handle in a comment body.
func ExtractMentionHandles(content string) []string {
	handles := make([]string, 0)
	seen := map[string]bool{}
	for _, match := range mentionPattern.FindAllStringSubmatch(content, -1) {
		handle := match[2]
		if handle == "" || seen[handle] {
			continue
		}
		seen[handle] = true
		handles = append(handles, handle)
	}
	return handles
}

type mentionTarget struct {
	TargetType string
	MemberID   *string
	AgentID    *string
}

// resolveMentionTargets resolves each handle against members first, then agents.
func (h *Hub) resolveMentionTargets(teamID, content string) ([]mentionTarget, error) {
	targets := make([]mentionTarget, 0)
	for _, handle := range ExtractMentionHandles(content) {
		member, err := queryMember(h.db,
			"SELECT "+memberColumns+" FROM members WHERE team_id = ? AND github_username = ? COLLATE NOCASE LIMIT 1",
			teamID, handle)
		if err != nil {
			return nil, err
		}
		if member != nil {
			targets = append(targets, mentionTarget{TargetType: "member", MemberID: strPointer(member.ID)})
			continue
		}
		agent, err := queryAgent(h.db, "SELECT "+agentColumns+" FROM agents WHERE team_id = ? AND name = ? LIMIT 1",
			teamID, handle)
		if err != nil {
			return nil, err
		}
		if agent != nil {
			targets = append(targets, mentionTarget{TargetType: "agent", AgentID: strPointer(agent.ID)})
		}
	}
	return targets, nil
}

// ListComments is the thread of one issue, oldest first.
func (h *Hub) ListComments(teamID, issueID string) ([]CommentView, error) {
	if _, err := h.FindIssue(teamID, issueID); err != nil {
		return nil, err
	}
	rows, err := Collect(h.db, "SELECT "+commentColumns+" FROM comments WHERE issue_id = ? ORDER BY created_at, id",
		scanComment, issueID)
	if err != nil {
		return nil, err
	}
	views := make([]CommentView, 0, len(rows))
	for _, row := range rows {
		views = append(views, toCommentView(row))
	}
	return views, nil
}

// CreateComment writes one comment and its mentions in one transaction, so a
// reader never sees a mention of a comment that failed to land.
func (h *Hub) CreateComment(teamID string, principal *Principal, issueID, content string,
	authorType string, hasAuthorType bool, authorAgentID string, hasAuthorAgentID bool, now int64) (*Comment, error) {
	issue, err := h.FindIssue(teamID, issueID)
	if err != nil {
		return nil, err
	}
	if err := AssertBytes(content, CommentLimitBytes, "content"); err != nil {
		return nil, err
	}
	commentAuthorType := ""
	var authorMemberID, authorAgentIDValue *string
	authorName := ""
	if principal.Kind == "host" {
		if !hasAuthorType || authorType != "agent" {
			return nil, FailWith(CodeForbidden, "Host tokens may only post agent comments.",
				map[string]any{"field": "author_type"})
		}
		if !hasAuthorAgentID || authorAgentID == "" {
			return nil, FailWith(CodeValidationFailed, "author_agent_id is required for an agent comment.",
				map[string]any{"field": "author_agent_id"})
		}
		agent, err := h.FindAgent(teamID, authorAgentID)
		if err != nil {
			return nil, err
		}
		if agent == nil || agent.HostID != principal.Host.ID {
			return nil, FailWith(CodeHostMismatch, "The author agent belongs to another host.",
				map[string]any{"field": "author_agent_id"})
		}
		commentAuthorType = "agent"
		authorAgentIDValue = strPointer(agent.ID)
		authorName = agent.Name
	} else {
		if hasAuthorType && authorType != "human" {
			return nil, FailWith(CodeForbidden, "A member session may only post human comments.",
				map[string]any{"field": "author_type"})
		}
		commentAuthorType = "human"
		authorMemberID = strPointer(principal.Member.ID)
		authorName = principal.Member.DisplayName
	}
	comment := &Comment{
		ID: NewID("comm", now), TeamID: teamID, IssueID: issueID, AuthorType: commentAuthorType,
		AuthorMemberID: authorMemberID, AuthorAgentID: authorAgentIDValue, Content: content,
		CreatedAt: now, UpdatedAt: now,
	}
	targets, err := h.resolveMentionTargets(teamID, content)
	if err != nil {
		return nil, err
	}
	err = h.db.Tx(func(tx *sql.Tx) error {
		if _, err := tx.Exec(
			`INSERT INTO comments (id, team_id, issue_id, author_type, author_member_id,
			 author_agent_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			comment.ID, comment.TeamID, comment.IssueID, comment.AuthorType, comment.AuthorMemberID,
			comment.AuthorAgentID, comment.Content, comment.CreatedAt, comment.UpdatedAt); err != nil {
			return err
		}
		for _, target := range targets {
			if _, err := tx.Exec(
				"INSERT INTO comment_mentions (comment_id, target_type, target_member_id, "+
					"target_agent_id, read_at) VALUES (?, ?, ?, ?, NULL)",
				comment.ID, target.TargetType, target.MemberID, target.AgentID); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	actor := ActivityActor{Kind: "member", MemberID: deref(authorMemberID)}
	if principal.Kind == "host" {
		actor = ActivityActor{Kind: "agent", AgentID: deref(authorAgentIDValue), HostID: principal.Host.ID}
	}
	if err := h.recordActivity(teamID, issueID, "comment.created", actor,
		map[string]any{"comment_id": comment.ID}, now); err != nil {
		return nil, err
	}
	events := []ChannelEvent{{
		Event: "comment.created", Payload: map[string]any{"comment": toCommentView(comment)},
	}}
	memberMentions := make([]string, 0)
	for _, target := range targets {
		if target.MemberID != nil {
			memberMentions = append(memberMentions, *target.MemberID)
		}
		if target.AgentID == nil {
			continue
		}
		agent, err := h.FindAgent(teamID, *target.AgentID)
		if err != nil {
			return nil, err
		}
		if agent == nil {
			continue
		}
		events = append(events, ChannelEvent{
			Event: "comment.mentioned",
			Payload: map[string]any{
				"issue_id": issueID, "comment_id": comment.ID, "author": authorName, "content": content,
			},
			TargetHostID: strPointer(agent.HostID),
		})
	}
	if err := h.publish(teamID, events); err != nil {
		return nil, err
	}
	if len(memberMentions) > 0 {
		if err := h.sendPush(memberMentions, PushNotification{
			TeamID: teamID, IssueID: issueID, EventType: "mentioned",
			Body: mentionedAlert(authorName, issue.Number),
		}, now); err != nil {
			return nil, err
		}
	}
	return comment, nil
}
