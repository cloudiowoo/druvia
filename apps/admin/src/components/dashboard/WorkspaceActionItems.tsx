import Link from 'next/link';

export function WorkspaceActionItems({
  items,
}: {
  items: Array<{
    severity: 'high' | 'medium' | 'low';
    title: string;
    description: string;
    href: string;
  }>;
}) {
  if (items.length === 0) {
    return (
      <section className="rounded-xl border bg-white p-6">
        <h2 className="text-base font-semibold">待处理事项</h2>
        <p className="mt-4 text-sm text-muted-foreground">当前没有需要立即处理的事项。</p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border bg-white p-6">
      <h2 className="text-base font-semibold">待处理事项</h2>
      <div className="mt-4 space-y-3">
        {items.map((item) => (
          <div key={`${item.severity}-${item.title}`} className="rounded-lg border p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium">{item.title}</p>
                <p className="mt-1 text-sm text-muted-foreground">{item.description}</p>
              </div>
              <Link className="text-sm font-medium text-primary" href={item.href}>
                查看
              </Link>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
