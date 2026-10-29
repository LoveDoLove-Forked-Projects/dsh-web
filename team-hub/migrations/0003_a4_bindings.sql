-- Supplement A4 changes that need storage.

-- A4.1: the Host reports the model and reasoning effort it bound to each agent.
-- The hub keeps them with the agent record instead of dropping the fields.
ALTER TABLE agents ADD COLUMN model TEXT;
ALTER TABLE agents ADD COLUMN reasoning_effort TEXT;

-- A4.8: POST /auth/token carries only the authorization code, so the pending
-- authorization (and its code_challenge) is looked up by that code. The callback
-- records the code on the row it already holds for the client's state.
ALTER TABLE oauth_states ADD COLUMN code TEXT;
CREATE UNIQUE INDEX idx_oauth_states_code ON oauth_states(code) WHERE code IS NOT NULL;
