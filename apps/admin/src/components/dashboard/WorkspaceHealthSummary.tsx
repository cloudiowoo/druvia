import { getHealthLabel, getHealthTone } from './health-score';

export function WorkspaceHealthSummary({
  score,
  summary,
  factors,
}: {
  score: number;
  summary: string;
  factors: {
    availability: number;
    stability: number;
    risk: number;
  };
}) {
  const tone = getHealthTone(score);
  const toneClass = {
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    red: 'bg-red-50 text-red-700 border-red-200',
  }[tone];

  return (
    <section className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
      <div className={`rounded-xl border p-6 ${toneClass}`}>
        <p className="text-sm font-medium">系统健康</p>
        <div className="mt-3 flex items-end gap-3">
          <p className="text-4xl font-bold">{score} / 100</p>
          <span className="mb-1 inline-flex rounded-full border px-2 py-0.5 text-xs">
            {getHealthLabel(score)}
          </span>
        </div>
        <p className="mt-3 text-sm">{summary}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
        <FactorCard label="可用性" value={factors.availability} />
        <FactorCard label="稳定性" value={factors.stability} />
        <FactorCard label="配置风险" value={factors.risk} />
      </div>
    </section>
  );
}

function FactorCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border bg-white p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
    </div>
  );
}
