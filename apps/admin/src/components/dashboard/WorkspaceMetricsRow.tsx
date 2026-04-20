function formatBytes(bytes: number) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function WorkspaceMetricsRow({
  metrics,
}: {
  metrics?: {
    totalProjects: number;
    activeProjects: number;
    capabilityCoverage: number;
    backupCoverage: number;
    storageUsageBytes: number;
    backupUsageBytes: number;
  } | null;
}) {
  const value = metrics ?? {
    totalProjects: 0,
    activeProjects: 0,
    capabilityCoverage: 0,
    backupCoverage: 0,
    storageUsageBytes: 0,
    backupUsageBytes: 0,
  };

  return (
    <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <MetricCard title="项目总数" value={String(value.totalProjects)} detail={`${value.activeProjects} 个活跃`} />
      <MetricCard title="活跃项目数" value={String(value.activeProjects)} detail="可继续运营的项目" />
      <MetricCard title="能力覆盖率" value={`${value.capabilityCoverage}%`} detail="按 5 个能力域平均" />
      <MetricCard
        title="备份 / 存储覆盖"
        value={`${value.backupCoverage}%`}
        detail={`存储 ${formatBytes(value.storageUsageBytes)} · 备份 ${formatBytes(value.backupUsageBytes)}`}
      />
    </section>
  );
}

function MetricCard({ title, value, detail }: { title: string; value: string; detail: string }) {
  return (
    <div className="rounded-xl border bg-white p-5">
      <p className="text-sm text-muted-foreground">{title}</p>
      <p className="mt-2 text-3xl font-semibold">{value}</p>
      <p className="mt-2 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}
