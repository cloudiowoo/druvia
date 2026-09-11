// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DeviceWipeConfigPanel } from '../../../apps/admin/src/components/auth/DeviceWipeConfigPanel'

describe('DeviceWipeConfigPanel', () => {
  it('keeps enablement unavailable until project Hooks are ready', () => {
    render(
      <DeviceWipeConfigPanel
        config={{ enabled: false, hooksReady: false, activeKeyId: null, verificationKeyCount: 0 }}
        loading={false}
        saving={false}
        rotating={false}
        onToggle={vi.fn()}
        onRotate={vi.fn()}
      />,
    )

    expect(screen.getByText('项目设备擦除接口未就绪')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '启用设备擦除指令' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '轮换签名密钥' })).toBeDisabled()
  })

  it('exposes enablement and key rotation without displaying private material', () => {
    const onToggle = vi.fn()
    const onRotate = vi.fn()
    render(
      <DeviceWipeConfigPanel
        config={{
          enabled: true,
          hooksReady: true,
          activeKeyId: 'dwk_project_key_v2',
          verificationKeyCount: 2,
        }}
        loading={false}
        saving={false}
        rotating={false}
        onToggle={onToggle}
        onRotate={onRotate}
      />,
    )

    fireEvent.click(screen.getByRole('switch', { name: '启用设备擦除指令' }))
    fireEvent.click(screen.getByRole('button', { name: '轮换签名密钥' }))

    expect(onToggle).toHaveBeenCalledWith(false)
    expect(onRotate).toHaveBeenCalledTimes(1)
    expect(screen.getByText('dwk_project_key_v2')).toBeInTheDocument()
    expect(screen.queryByText(/private/i)).not.toBeInTheDocument()
  })
})
