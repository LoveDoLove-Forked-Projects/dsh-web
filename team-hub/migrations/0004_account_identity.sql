-- The account service is the only identity source once the transition ends: a
-- member carries the account service user id that a verified assertion names.
-- The column is nullable because a member still enters through GitHub during
-- the transition and binds the account from that session afterwards. The unique
-- index is partial for the same reason: many members may be unbound, one account
-- may only ever be one member.
ALTER TABLE members ADD COLUMN account_user_id TEXT;
CREATE UNIQUE INDEX idx_members_account_user_id ON members(account_user_id) WHERE account_user_id IS NOT NULL;
