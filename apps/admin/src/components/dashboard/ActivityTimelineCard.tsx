import Link from 'next/link';
import type { TenantDashboardTimelineEntryData } from '@/lib/api';

function formatDateTime(value: string) {
  return new Date(value).toLocaleString('zh-CN');
}

export function ActivityTimelineCard({
  items,
}: {
  items: TenantDashboardTimelineEntryData[];
}) {
  return (
    <section className="rounded-xl border bg-white p-6">
      <div className="border-b pb-4">
        <h2 className="text-base font-semibold">运维与异常时间线</h2>
        <p className="text-sm text-muted-foreground">合并展示最近的工作区运维信号与异常事件</p>
      </div>
      <div className="mt-4 space-y-3">
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无时间线数据。</p>
        ) : (
          items.map((item) => (
            <div key={item.id} className="rounded-lg border p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 rounded-full ${item.kind === 'incident' ? 'bg-red-500' : 'bg-emerald-500'}`} />
                    <p className="text-sm font-medium">{item.title}</p>
                  </div>
                  {item.description ? (
                    <p className="mt-1 text-sm text-muted-foreground">{item.description}</p>
                  ) : null}
                  <p className="mt-2 text-xs text-muted-foreground">{formatDateTime(item.createdAt)}</p>
                </div>
                {item.href ? (
                  <Link href={item.href} className="text-sm font-medium text-primary">
                    查看
                  </Link>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
