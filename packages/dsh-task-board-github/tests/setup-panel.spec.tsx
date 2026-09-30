// @vitest-environment jsdom
/**
 * The integration block of the settings card, as the operator drives it: the
 * credential line, the token paste, the repository list, and the connection
 * test. Every case renders the real component against a setup API double and
 * asserts what the Host would have been asked to store.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GitHubSetupSummary } from '../src/core/setup.ts'
import type { GitHubRepoConfig } from '../src/core/types.ts'
import { GitHubSetupPanel } from '../src/client/SetupPanel.tsx'
import type { GitHubSetupApi } from '../src/client/setup-api.ts'
import { t, zh } from '../src/client/locales.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

beforeEach(() => { document.documentElement.lang = 'zh' })

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => { root.unmount() })
  }
  document.body.replaceChildren()
})

/** The setup API double: an in-memory configuration recording every call. */
function apiDouble(initial: GitHubRepoConfig[] = []) {
  const calls: string[] = []
  let repositories = [...initial]
  let credential: GitHubSetupSummary['credential'] = { configured: false, writable: true, envName: 'GITHUB_TOKEN' }
  const api: GitHubSetupApi = {
    status: async () => { calls.push('status'); return { credential, repositories: [...repositories], running: true, settingsWritable: true } },
    test: async () => {
      calls.push('test')
      return {
        ok: true,
        login: 'octocat',
        credential,
        checks: [{ owner: 'deepseek-ai', repository: 'dsh-web', ok: true, message: '3 open issues carry the "dsh" label' }],
      }
    },
    setCredential: async (token) => {
      calls.push('setCredential ' + token)
      credential = { configured: true, writable: true, envName: 'GITHUB_TOKEN', source: 'store' }
      return { credential, repositories: [...repositories], running: true, settingsWritable: true }
    },
    clearCredential: async () => {
      calls.push('clearCredential')
      credential = { configured: false, writable: true, envName: 'GITHUB_TOKEN' }
      return { credential, repositories: [...repositories], running: true, settingsWritable: true }
    },
    listRepositories: async () => [...repositories],
    writeRepositories: async (value) => {
      calls.push('writeRepositories')
      repositories = [...value]
      return repositories
    },
  }
  return { api, calls, list: () => repositories }
}

/** Render the panel and let its first status read settle. */
async function renderPanel(api: GitHubSetupApi): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => { root.render(<GitHubSetupPanel t={t} api={api} />) })
  return container
}

/** Type into one input the way a browser does (React reads the native setter). */
function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Find one button by its visible copy. */
function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find(candidate => candidate.textContent === text)
  if (found === undefined) throw new Error('button not found: ' + text)
  return found
}

/** The token input the panel renders. */
function tokenInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('[data-dsh-part="github-token"]')
  if (input === null) throw new Error('the token input did not render')
  return input as HTMLInputElement
}

describe('GitHub setup panel', () => {
  it('operator opening an unconfigured integration is told the credential is missing and gets the paste box', async () => {
    // Given a deployment with no credential and no repository
    const { api } = apiDouble()

    // When the panel renders
    const container = await renderPanel(api)

    // Then the credential line explains what is missing, the paste box and the
    // integration heading are on screen, and the empty repository list is stated
    const text = container.textContent ?? ''
    expect(text).toContain(zh['summary.title'])
    expect(text).toContain(zh['setup.credentialMissing'].replace('{name}', 'GITHUB_TOKEN'))
    expect(text).toContain(zh['setup.repositoriesEmpty'])
    expect(tokenInput(container).type).toBe('password')
    expect(tokenInput(container).placeholder).toBe(zh['setup.tokenPlaceholder'])
  })

  it('operator pasting a token stores it through the same-origin API and sees the credential configured', async () => {
    // Given a rendered panel with no credential
    const { api, calls } = apiDouble()
    const container = await renderPanel(api)

    // When the operator pastes a token and saves it
    type(tokenInput(container), 'ghp_pasted_token')
    await act(async () => { button(container, zh['setup.tokenSave']).click() })

    // Then the token reached the setup API once and the status now reads configured
    expect(calls).toContain('setCredential ghp_pasted_token')
    expect(container.textContent).toContain(zh['setup.credentialConfigured'].replace('{name}', 'GITHUB_TOKEN').replace('{source}', 'store'))
    // And the paste box was cleared so the secret is not left on screen
    expect(tokenInput(container).value).toBe('')
  })

  it('operator adding a repository writes the list and clears the input', async () => {
    // Given a rendered panel with no repository
    const { api, calls, list } = apiDouble()
    const container = await renderPanel(api)

    // When the operator types a repository and adds it
    const input = container.querySelector('[data-dsh-part="github-repository-input"]') as HTMLInputElement
    type(input, 'https://github.com/deepseek-ai/dsh-web')
    await act(async () => { button(container, zh['setup.repositoryAdd']).click() })

    // Then the Host stored exactly that repository and the row is on screen
    expect(calls).toContain('writeRepositories')
    expect(list()).toEqual([{ owner: 'deepseek-ai', repository: 'dsh-web' }])
    expect(container.textContent).toContain('deepseek-ai/dsh-web')
    expect(input.value).toBe('')
  })

  it('operator adding the same repository twice is told instead of silently getting one row', async () => {
    // Given a configuration that already carries the repository
    const { api, calls } = apiDouble([{ owner: 'deepseek-ai', repository: 'dsh-web' }])
    const container = await renderPanel(api)

    // When the same repository is typed again
    const input = container.querySelector('[data-dsh-part="github-repository-input"]') as HTMLInputElement
    type(input, 'deepseek-ai/dsh-web')
    await act(async () => { button(container, zh['setup.repositoryAdd']).click() })

    // Then the refusal is shown and nothing was written
    expect(container.textContent).toContain('already configured')
    expect(calls.filter(call => call === 'writeRepositories')).toHaveLength(0)
  })

  it('operator removing a repository writes the remaining list', async () => {
    // Given two configured repositories
    const { api, calls, list } = apiDouble([{ owner: 'deepseek-ai', repository: 'dsh-web' }, { owner: 'other', repository: 'thing' }])
    const container = await renderPanel(api)

    // When the operator removes one of them
    const rows = Array.from(container.querySelectorAll('[data-dsh-part="github-repository"]'))
    expect(rows).toHaveLength(2)
    const removeButtons = Array.from(rows[1]!.querySelectorAll('button'))
    await act(async () => { removeButtons[0]!.click() })

    // Then only the other repository is stored
    expect(calls).toContain('writeRepositories')
    expect(list()).toEqual([{ owner: 'deepseek-ai', repository: 'dsh-web' }])
  })

  it('operator testing the connection sees the authenticated account and each repository check', async () => {
    // Given a configured repository
    const { api } = apiDouble([{ owner: 'deepseek-ai', repository: 'dsh-web' }])
    const container = await renderPanel(api)

    // When the operator runs the test
    await act(async () => { button(container, zh['setup.test']).click() })

    // Then the account and the per-repository outcome are on screen
    const text = container.textContent ?? ''
    expect(text).toContain(zh['setup.testLogin'].replace('{login}', 'octocat'))
    expect(text).toContain('deepseek-ai/dsh-web')
    expect(text).toContain('3 open issues')
  })

  it('operator on a page that cannot reach the host API is told so instead of seeing an empty form', async () => {
    // Given an API whose status read fails
    const failing: GitHubSetupApi = {
      ...apiDouble().api,
      status: async () => { throw new Error('Failed to fetch') },
    }

    // When the panel renders
    const container = await renderPanel(failing)

    // Then the failure is reported with its reason
    expect(container.textContent).toContain('Failed to fetch')
    expect(container.textContent).toContain(zh['summary.title'])
  })
})
