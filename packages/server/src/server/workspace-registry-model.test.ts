import { describe, expect, test, vi } from 'vitest'

import { detectStaleWorkspaces } from './workspace-registry-model.js'
import { createPersistedWorkspaceRecord } from './workspace-registry.js'

function createWorkspaceRecord(workspaceId: string) {
  return createPersistedWorkspaceRecord({
    workspaceId,
    projectId: workspaceId,
    cwd: workspaceId,
    kind: 'directory',
    displayName: workspaceId.split('/').at(-1) ?? workspaceId,
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
  })
}

describe('detectStaleWorkspaces', () => {
  test('returns workspace ids whose directories no longer exist', async () => {
    const checkDirectoryExists = vi.fn(async (cwd: string) => cwd !== '/tmp/missing')

    const staleWorkspaceIds = await detectStaleWorkspaces({
      activeWorkspaces: [
        createWorkspaceRecord('/tmp/existing'),
        createWorkspaceRecord('/tmp/missing'),
      ],
      agentRecords: [],
      checkDirectoryExists,
    })

    expect(Array.from(staleWorkspaceIds)).toEqual(['/tmp/missing'])
    expect(checkDirectoryExists.mock.calls).toEqual([['/tmp/existing'], ['/tmp/missing']])
  })

  test('returns workspace ids when all matching agents are archived', async () => {
    const staleWorkspaceIds = await detectStaleWorkspaces({
      activeWorkspaces: [
        createWorkspaceRecord('/tmp/repo'),
        createWorkspaceRecord('/tmp/other'),
      ],
      agentRecords: [
        {
          cwd: '/tmp/repo',
          archivedAt: '2026-03-02T00:00:00.000Z',
        },
        {
          cwd: '/tmp/other',
          archivedAt: null,
        },
      ],
      checkDirectoryExists: async () => true,
    })

    expect(Array.from(staleWorkspaceIds)).toEqual(['/tmp/repo'])
  })

  test('keeps workspaces with no agents or at least one active agent', async () => {
    const staleWorkspaceIds = await detectStaleWorkspaces({
      activeWorkspaces: [
        createWorkspaceRecord('/tmp/active'),
        createWorkspaceRecord('/tmp/no-agents'),
      ],
      agentRecords: [
        {
          cwd: '/tmp/active',
          archivedAt: '2026-03-02T00:00:00.000Z',
        },
        {
          cwd: '/tmp/active/../active',
          archivedAt: null,
        },
      ],
      checkDirectoryExists: async () => true,
    })

    expect(Array.from(staleWorkspaceIds)).toEqual([])
  })
})
