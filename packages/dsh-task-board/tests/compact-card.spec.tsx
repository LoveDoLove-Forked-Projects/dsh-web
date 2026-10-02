// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskCard } from '../src/client/board/TaskCard.tsx'
import type { TaskRecord } from '../src/core/tasks.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  document.body.replaceChildren()
})

describe('Given readable task cards across board views', () => {
  it.each(['backlog', 'todo', 'running', 'done', 'failed', 'archived'] as const)(
    'user sees a %s card contains Markdown, then it exposes a clean summary and opens details',
    (status) => {
      // Given a task with Markdown content in any board column.
      const task: TaskRecord = {
        id: 'readable', title: '## Fix **rendering**', description: '### Steps\n- [x] Check `output`',
        prompt: 'unchanged', status: status === 'archived' ? 'done' : status,
        createdAt: 0, updatedAt: 0, executions: [],
        ...(status === 'archived' ? { archivedAt: 1 } : {}),
      }
      const onClick = vi.fn()
      const container = document.createElement('div')
      document.body.append(container)
      root = createRoot(container)
      // When the user sees its readable card.
      act(() => root!.render(<TaskCard task={task} pending={false} onClick={onClick} />))
      const card = container.querySelector('button')!
      // Then the summary is readable and the source remains unchanged.
      expect(card.getAttribute('aria-label')).toBe('Fix rendering')
      expect(card.firstElementChild?.textContent).toBe('Fix rendering')
      expect(card.title).toContain('Check output')
      expect(card.title).not.toContain('###')
      expect(card.textContent).toContain('Check output')
      expect(card.dataset.status).toBe(status)
      expect(card.draggable).toBe(status !== 'archived')
      act(() => card.click())
      expect(onClick).toHaveBeenCalledOnce()
      expect(task.description).toBe('### Steps\n- [x] Check `output`')
    },
  )
  it('user can identify a task whose title is only Markdown punctuation', () => {
    // Given a nonempty title that parses as a thematic break.
    const task: TaskRecord = { id: 'rule', title: '---', description: '', prompt: '', status: 'todo', createdAt: 0, updatedAt: 0, executions: [] }
    const container = document.createElement('div')
    root = createRoot(container)
    // When its summary is rendered.
    act(() => root!.render(<TaskCard task={task} pending={false} onClick={() => {}} />))
    // Then the original title remains available instead of an empty card.
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('---')
    expect(container.firstElementChild?.firstElementChild?.textContent).toBe('---')
  })
  it('user can inspect a pending card without enabling dragging', () => {
    // Given a card awaiting a Host response.
    const task: TaskRecord = { id: 'pending', title: 'Pending task', description: '', prompt: '', status: 'todo', createdAt: 0, updatedAt: 0, executions: [] }
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    let opened = false
    // When the user opens the pending summary.
    act(() => root!.render(<TaskCard task={task} pending={true} onClick={() => { opened = true }} />))
    const card = container.querySelector('button')!
    act(() => card.click())
    // Then viewing remains available, but dragging remains locked.
    expect(opened).toBe(true)
    expect(card.draggable).toBe(false)
    expect(card.dataset.pending).toBe('true')
  })
})
