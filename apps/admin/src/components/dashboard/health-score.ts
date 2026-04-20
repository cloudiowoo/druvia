export type HealthTone = 'emerald' | 'amber' | 'red';
export type CapabilityStatus = 'ready' | 'configured' | 'missing' | 'attention';

export function getHealthLabel(score: number) {
  if (score >= 85) return '健康';
  if (score >= 60) return '关注';
  return '风险';
}

export function getHealthTone(score: number): HealthTone {
  if (score >= 85) return 'emerald';
  if (score >= 60) return 'amber';
  return 'red';
}

export function getCapabilityLabel(status: CapabilityStatus) {
  switch (status) {
    case 'ready':
      return '可用';
    case 'configured':
      return '已配置';
    case 'missing':
      return '未覆盖';
    case 'attention':
      return '需关注';
  }
}
