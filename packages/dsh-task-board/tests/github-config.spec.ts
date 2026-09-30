/**
 * The GitHub fields on the board's own Config schema. These are
 * deployment-level (a profile patch declares them) rather than volatile page
 * fields, so the cases below pin the defaults a patch inherits and the fact
 * that the nested repository object validates one entry at a time.
 */
import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'

/** Resolve one schema field's plain value (volatile fields arrive as references). */
function plain(config: ReturnType<typeof Config>, field: string): unknown {
  const value = (config as Record<string, unknown>)[field] as { get?: () => unknown } | undefined
  return typeof value?.get === 'function' ? value.get() : value
}

describe('Task Board GitHub configuration schema', () => {
  it('operator configuring no GitHub repository gets an empty list and the default token variable', () => {
    // Given a profile patch that configures no GitHub integration at all
    const resolved = Config({})

    // When the GitHub fields are read
    // Then the integration is inert and looks for the conventional variable,
    // so an unconfigured deployment behaves exactly as before the feature
    expect(plain(resolved, 'githubRepositories')).toEqual([])
    expect(plain(resolved, 'githubTokenEnv')).toBe('GITHUB_TOKEN')
  })

  it('operator declaring only owner and repository gets every per-repository default filled in', () => {
    // Given a minimal repository entry
    const resolved = Config({ githubRepositories: [{ owner: 'deepseek-ai', repository: 'dsh' }] })

    // When the resolved entry is read
    // Then the inclusion label, managed prefix, state labels, PR policy and
    // auto-PR switch all carry their documented defaults
    const repos = plain(resolved, 'githubRepositories') as Array<Record<string, unknown>>
    expect(repos).toHaveLength(1)
    expect(repos[0]).toMatchObject({
      owner: 'deepseek-ai',
      repository: 'dsh',
      inclusionLabel: 'dsh',
      managedLabelPrefix: 'dsh:',
      prPhaseLabel: 'dsh:phase:pr',
      prCreationEnabled: false,
      draftPrPolicy: 'draft',
      closeIssueOnMerge: true,
      baseBranch: 'main',
    })
    expect(repos[0]?.stateLabels).toMatchObject({
      backlog: 'dsh:state:backlog',
      todo: 'dsh:state:todo',
      running: 'dsh:state:running',
      done: 'dsh:state:done',
      failed: 'dsh:state:failed',
    })
  })

  it('operator keeping several repositories configured gets each one resolved independently', () => {
    // Given two repositories with different inclusion labels
    const resolved = Config({
      githubRepositories: [
        { owner: 'deepseek-ai', repository: 'dsh', inclusionLabel: 'dsh' },
        { owner: 'other-org', repository: 'other-repo', inclusionLabel: 'board', prCreationEnabled: true },
      ],
    })

    // When the resolved list is read
    // Then both survive with their own labels and PR policy
    const repos = plain(resolved, 'githubRepositories') as Array<Record<string, unknown>>
    expect(repos).toHaveLength(2)
    expect(repos[0]?.inclusionLabel).toBe('dsh')
    expect(repos[0]?.prCreationEnabled).toBe(false)
    expect(repos[1]?.inclusionLabel).toBe('board')
    expect(repos[1]?.prCreationEnabled).toBe(true)
  })
})
