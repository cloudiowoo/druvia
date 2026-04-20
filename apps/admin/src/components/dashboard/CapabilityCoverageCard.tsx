import type { TenantDashboardCapability } from '@/lib/api';

function getCapabilityStatusLabel(status: TenantDashboardCapability['status']) {
  switch (status) {
    case 'healthy':
      return '健康';
    case 'attention':
      return '关注';
    case 'risk':
      return '风险';
  }
}

function getCapabilityStatusClass(status: TenantDashboardCapability['status']) {
  switch (status) {
    case 'healthy':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    case 'attention':
      return 'bg-amber-50 text-amber-700 border-amber-200';
    case 'risk':
      return 'bg-red-50 text-red-700 border-red-200';
  }
}

export function CapabilityCoverageCard({
  capabilities,
}: {
  capabilities: TenantDashboardCapability[];
}) {
  return (
    <section className="rounded-xl border bg-white p-6">
      <div className="border-b pb-4">
        <h2 className="text-base font-semibold">能力覆盖</h2>
        <p className="text-sm text-muted-foreground">按工作区视角查看 5 个能力域的覆盖情况</p>
      </div>
      <div className="mt-4 space-y-3">
        {capabilities.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无能力覆盖数据。</p>
        ) : (
          capabilities.map((capability) => {
            const uncovered = Math.max(capability.totalProjects - capability.coveredProjects, 0);
            return (
              <div key={capability.key} className="rounded-lg border p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium">{capability.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {capability.coveredProjects} / {capability.totalProjects} 项目已覆盖，未覆盖 {uncovered}
                    </p>
                  </div>
                  <span className={`rounded-full border px-2 py-0.5 text-xs ${getCapabilityStatusClass(capability.status)}`}>
                    {getCapabilityStatusLabel(capability.status)}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
