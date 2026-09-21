// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ProjectRuntimeContextPanel } from '../../../apps/admin/src/components/project/ProjectRuntimeContextPanel'

describe('ProjectRuntimeContextPanel', () => {
  it('shows an unconfigured project without granting a client-controlled default', () => {
    render(
      <ProjectRuntimeContextPanel
        context={{ enabled: false }}
        loading={false}
        saving={false}
        canManage={false}
        onSave={vi.fn()}
        onDisable={vi.fn()}
      />,
    )

    expect(screen.getByText('未配置')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '服务环境' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '保存运行环境' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '停用运行环境' })).toBeDisabled()
  })

  it('submits only an allow-listed environment through the owner-controlled action', () => {
    const onSave = vi.fn()
    const onDisable = vi.fn()
    render(
      <ProjectRuntimeContextPanel
        context={{
          enabled: true,
          serviceEnvironment: 'local',
          revision: 2,
          updatedAt: '2026-09-21T00:00:00.000Z',
        }}
        loading={false}
        saving={false}
        canManage={true}
        onSave={onSave}
        onDisable={onDisable}
      />,
    )

    fireEvent.change(screen.getByRole('combobox', { name: '服务环境' }), {
      target: { value: 'sandbox' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存运行环境' }))
    fireEvent.click(screen.getByRole('button', { name: '停用运行环境' }))

    expect(onSave).toHaveBeenCalledWith('sandbox')
    expect(onDisable).toHaveBeenCalledTimes(1)
    expect(screen.getByText('版本 2')).toBeInTheDocument()
  })
})
