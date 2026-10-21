import { type ReactNode } from 'react';

/** One 24h-activity sparkline drawn with inline SVG (no chart dependency). */
export function Sparkbars({ buckets, height = 56 }: { buckets: { bucket: number; total: number; errors: number }[]; height?: number }): ReactNode {
  const width = 480;
  const cols = buckets.slice(-48); // 30-min buckets → 24h
  const max = Math.max(1, ...cols.map((b) => b.total));
  const slot = width / cols.length || width;
  const barW = Math.max(2, slot - 2);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="activity last 24h">
      <line x1="0" y1={height - 6} x2={width} y2={height - 6} className="stroke-hairline-strong" />
      {cols.map((b, i) => {
        const h = Math.max(b.total > 0 ? 2 : 0, (b.total / max) * (height - 10));
        const errored = b.errors > 0;
        return (
          <rect
            key={b.bucket + ':' + i}
            x={i * slot + 1}
            y={height - 6 - h}
            width={barW}
            height={h}
            rx="1"
            className={errored ? 'fill-danger/70' : 'fill-cyan/60'}
          />
        );
      })}
    </svg>
  );
}
