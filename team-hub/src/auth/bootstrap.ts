import { fail } from '../errors'
import { sha256Hex } from '../ids'

/** Header the operator presents once, on the deployment that has no team yet. */
export const BOOTSTRAP_TOKEN_HEADER = 'X-Bootstrap-Token'

/**
 * The bootstrap endpoint cannot be guarded by a session: it runs on a hub where
 * no member exists yet, which is the state it exists to leave. The Worker secret
 * BOOTSTRAP_TOKEN is the whole gate, and an unset secret closes the endpoint
 * instead of leaving it open.
 */
export async function requireBootstrapToken(env: Env, request: Request): Promise<void> {
  const secret = env.BOOTSTRAP_TOKEN
  if (typeof secret !== 'string' || secret === '') {
    fail('NOT_CONFIGURED', 'BOOTSTRAP_TOKEN is not configured on this hub; bootstrap is closed.')
  }
  const presented = request.headers.get(BOOTSTRAP_TOKEN_HEADER)
  if (presented === null || presented === '') {
    fail('UNAUTHORIZED', 'Bootstrap requires the ' + BOOTSTRAP_TOKEN_HEADER + ' header.')
  }
  // Both sides are hashed first, so the comparison cannot leak the secret's
  // length or a matching prefix.
  if ((await sha256Hex(presented)) !== (await sha256Hex(secret))) {
    fail('UNAUTHORIZED', 'The bootstrap token is not valid.')
  }
}
