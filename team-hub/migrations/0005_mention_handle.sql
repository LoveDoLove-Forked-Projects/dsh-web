-- A member is mentioned through one identifier: mention_handle. github_username
-- could not play that part: an email-invited row carries the reserved "account:"
-- placeholder there (0001 makes both GitHub columns NOT NULL and 0004 explains the
-- placeholder), so a deployment with GitHub login closed had no mentionable member
-- at all. display_name stays free text and takes no part in resolution; the handle
-- is derived once, when the row is written, and then stored.
--
-- Scope: unique per team, the way github_username is scoped. Two teams may each hold
-- "dana"; one team may not.

-- The ALTER is the one statement SQLite cannot spell "IF NOT EXISTS"; the ledger row
-- in d1_migrations is what makes this file apply once, exactly as for the
-- account_user_id column in 0004. Everything below it is written against the rows
-- that still lack a handle, so a second pass over the same rows changes nothing.
ALTER TABLE members ADD COLUMN mention_handle TEXT;

-- Backfill. A GitHub identity contributes its login; a bound member contributes its
-- display name, folded to the characters a mention can carry: lowercase [a-z0-9_-],
-- every run of anything else - the dot an address holds included, so that "mei.lin"
-- becomes "mei-lin" - collapsed into one hyphen, both ends trimmed, and "member" when
-- nothing survives. A GitHub login folds the same way, dots and all. Within one team
-- the first row keeps the base and
-- each later row with the same base counts up -2, -3, stopping at the first value no
-- earlier row of that team took, which is what keeps the unique index satisfiable.
WITH RECURSIVE
sources(id, team_id, created_at, raw) AS (
  SELECT id, team_id, created_at,
         CASE WHEN github_username LIKE 'account:%' THEN display_name ELSE github_username END
  FROM members
  WHERE mention_handle IS NULL
),
chars(id, team_id, created_at, lowered, pos, folded) AS (
  SELECT id, team_id, created_at, lower(raw), 0, '' FROM sources
  UNION ALL
  SELECT id, team_id, created_at, lowered, pos + 1,
         folded || CASE
           WHEN substr(lowered, pos + 1, 1) GLOB '[a-z0-9_-]' THEN substr(lowered, pos + 1, 1)
           WHEN substr(folded, -1, 1) = '-' THEN ''
           ELSE '-'
         END
  FROM chars
  WHERE pos < length(lowered)
),
bases(id, team_id, created_at, base) AS (
  SELECT id, team_id, created_at,
         CASE WHEN trim(folded, '-') = '' THEN 'member' ELSE trim(folded, '-') END
  FROM chars
  WHERE pos = length(lowered)
),
ranked(id, team_id, base, ord) AS (
  SELECT id, team_id, base, ROW_NUMBER() OVER (PARTITION BY team_id ORDER BY created_at, id)
  FROM bases
),
-- One row per candidate tried, in join order: the candidate itself, how many
-- suffixes it has burned through, and the handles the team has already taken. A free
-- candidate settles its member and walks on to the next member of that team; a taken
-- one counts up. The free rows are the answers.
attempts(team_id, member_id, base, ord, tries, cand, taken) AS (
  SELECT team_id, id, base, 1, 1, base, ''
  FROM ranked
  WHERE ord = 1
  UNION ALL
  SELECT
    CASE WHEN instr(',' || a.taken, ',' || a.cand || ',') = 0 THEN n.team_id ELSE a.team_id END,
    CASE WHEN instr(',' || a.taken, ',' || a.cand || ',') = 0 THEN n.id ELSE a.member_id END,
    CASE WHEN instr(',' || a.taken, ',' || a.cand || ',') = 0 THEN n.base ELSE a.base END,
    CASE WHEN instr(',' || a.taken, ',' || a.cand || ',') = 0 THEN n.ord ELSE a.ord END,
    CASE WHEN instr(',' || a.taken, ',' || a.cand || ',') = 0 THEN 1 ELSE a.tries + 1 END,
    CASE WHEN instr(',' || a.taken, ',' || a.cand || ',') = 0
         THEN n.base
         ELSE a.base || '-' || (a.tries + 1) END,
    CASE WHEN instr(',' || a.taken, ',' || a.cand || ',') = 0
         THEN a.taken || a.cand || ','
         ELSE a.taken END
  FROM attempts a
  LEFT JOIN ranked n ON n.team_id = a.team_id AND n.ord = a.ord + 1
  WHERE CASE WHEN instr(',' || a.taken, ',' || a.cand || ',') = 0
             THEN n.id IS NOT NULL
             ELSE 1 END
),
assigned(member_id, handle) AS (
  SELECT member_id, cand FROM attempts
  WHERE instr(',' || taken, ',' || cand || ',') = 0
)
UPDATE members SET mention_handle = (SELECT handle FROM assigned WHERE assigned.member_id = members.id)
WHERE mention_handle IS NULL AND id IN (SELECT member_id FROM assigned);

-- The name a mention may carry is one per team, case-sensitively: every handle above
-- is stored lowercase, so the index is the invariant and resolution folds the input.
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_mention_handle ON members(team_id, mention_handle);
