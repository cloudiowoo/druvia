import Link from 'next/link';
import { getCapabilityLabel, getHealthLabel, type CapabilityStatus } from './health-score';

export function ProjectHealthList({
  tenantId,
  projects,
}: {
  tenantId: string;
  projects: Array<{
    projectId: string;
    name: string;
    alias: string;
    status: string;
    healthScore: number;
    capabilities: {
      database: CapabilityStatus;
      auth: CapabilityStatus;
      storage: CapabilityStatus;
      realtime: CapabilityStatus;
      functions: CapabilityStatus;
    };
    latestSignalAt: string | null;
    latestBackupAt: string | null;
    riskTags: string[];
  }>;
}) {
  return (
    <section className="rounded-xl border bg-white">
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div>
          <h2 className="text-base font-semibold">项目健康</h2>
          <p className="text-sm text-muted-foreground">从项目层解释首页健康结论</p>
        </div>
      </div>
      <div className="divide-y">
        {projects.map((project) => (
          <div
            key={project.projectId}
            className="grid gap-4 px-6 py-4 lg:grid-cols-[1.4fr_120px_1.6fr_1fr_auto] lg:items-center"
          >
            <div>
              <p className="font-medium">{project.name}</p>
              <p className="text-sm text-muted-foreground">{project.alias}</p>
              <div className="mt-2 text-xs text-muted-foreground">
                <p>最近信号：{formatDateTime(project.latestSignalAt)}</p>
                <p>最近备份：{formatDateTime(project.latestBackupAt)}</p>
              </div>
            </div>
            <div>
              <p className="text-2xl font-semibold">{project.healthScore}</p>
              <p className="text-xs text-muted-foreground">{getHealthLabel(project.healthScore)}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {Object.values(project.capabilities).map((status, index) => (
                <span key={`${project.projectId}-${index}`} className="rounded-full border px-2 py-0.5 text-xs">
                  {getCapabilityLabel(status)}
                </span>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              {project.riskTags.map((tag) => (
                <span key={tag} className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
                  {tag}
                </span>
              ))}
            </div>
            <Link href={`/t/${tenantId}/p/${project.projectId}`} className="text-sm font-medium text-primary">
              进入项目
            </Link>
          </div>
        ))}
      </div>
    </section>
  );
}

function formatDateTime(value: string | null) {
  if (!value) return '暂无';
  return new Date(value).toLocaleString('zh-CN');
}
