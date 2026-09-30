/**
 * Browser-half extension assembly.
 *
 * The board declares the child seats; the providers that render into them are
 * assembled here. The GitHub provider is the one in-package consumer while the
 * extension still lives in this package; when it moves to its own bundle it
 * resolves the `taskBoard` service and installs itself, and this file goes
 * away.
 *
 * @module dsh-task-board/client/extensions
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { TaskBoardClientFace } from '../core/extension.ts'
import { installGitHubClientExtension } from './github/extension.ts'

/**
 * Install every provider's browser half against the board's client face.
 * @param ctx - client context.
 * @param face - the board's client capability face.
 * @returns disposer releasing every provider contribution.
 */
export function installBoardClientExtensions(ctx: ClientContext, face: TaskBoardClientFace): () => void {
  return installGitHubClientExtension(ctx, face)
}
