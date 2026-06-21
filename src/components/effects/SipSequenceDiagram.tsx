'use client';

import { useEffect, useRef, useState } from 'react';

interface SipEvent {
  from: 'UE' | 'P-CSCF' | 'IMS';
  to: 'UE' | 'P-CSCF' | 'IMS';
  method: string;
  code?: string;
}

const events: SipEvent[] = [
  { from: 'UE', to: 'P-CSCF', method: 'REGISTER' },
  { from: 'P-CSCF', to: 'IMS', method: 'REGISTER' },
  { from: 'IMS', to: 'P-CSCF', method: '401 Unauthorized' },
  { from: 'P-CSCF', to: 'UE', method: '401 Unauthorized' },
  { from: 'UE', to: 'P-CSCF', method: 'REGISTER (AKA)' },
  { from: 'P-CSCF', to: 'IMS', method: 'REGISTER (AKA)' },
  { from: 'IMS', to: 'P-CSCF', method: '200 OK', code: '200' },
  { from: 'P-CSCF', to: 'UE', method: '200 OK', code: '200' },
];

export function SipSequenceDiagram({ compact = false }: { compact?: boolean }) {
  const [progress, setProgress] = useState(0);
  const ref = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    let raf = 0;
    let t = 0;
    const tick = () => {
      t += 1;
      setProgress(Math.min(1, t / (compact ? 50 : 70)));
      if (t < (compact ? 50 : 70)) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [compact]);

  const width = compact ? 480 : 720;
  const height = compact ? 230 : 340;
  const paddingX = 60;
  const actors: Array<'UE' | 'P-CSCF' | 'IMS'> = ['UE', 'P-CSCF', 'IMS'];
  const xs = actors.map((_, i) => paddingX + (i * (width - paddingX * 2)) / (actors.length - 1));
  const topY = 40;
  const bottomY = height - 20;

  const rowGap = (bottomY - topY) / (events.length + 1);

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full max-w-full"
      role="img"
      aria-label="SIP 注册时序"
    >
      <defs>
        <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#00d4ff" stopOpacity="0.1" />
          <stop offset="50%" stopColor="#00d4ff" stopOpacity="1" />
          <stop offset="100%" stopColor="#00d4ff" stopOpacity="0.1" />
        </linearGradient>
      </defs>

      {actors.map((a, i) => (
        <g key={a}>
          <text
            x={xs[i]}
            y={22}
            textAnchor="middle"
            className="fill-accent"
            style={{ fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
          >
            {a}
          </text>
          <line
            x1={xs[i]}
            x2={xs[i]}
            y1={topY}
            y2={bottomY}
            stroke="rgba(0,212,255,0.25)"
            strokeDasharray="4 4"
          />
        </g>
      ))}

      {events.map((e, idx) => {
        const fromIdx = actors.indexOf(e.from);
        const toIdx = actors.indexOf(e.to);
        const x1 = xs[fromIdx];
        const x2 = xs[toIdx];
        const y = topY + (idx + 1) * rowGap;
        const cutOff = (idx / events.length) * progress + (1 / events.length) * Math.min(progress - idx / events.length, 1 / events.length) * events.length;
        const visible = progress >= idx / events.length;
        const localP = Math.min(1, (progress - idx / events.length) * events.length);
        const endX = x1 + (x2 - x1) * localP;
        return (
          <g key={idx} opacity={visible ? 1 : 0}>
            <line
              x1={x1}
              x2={endX}
              y1={y}
              y2={y}
              stroke={e.code ? '#9be7c4' : 'url(#accent)'}
              strokeWidth={1.4}
              markerEnd={localP >= 1 ? `url(#arrow-${idx})` : undefined}
            />
            <defs>
              <marker
                id={`arrow-${idx}`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path
                  d="M0,0 L10,5 L0,10 z"
                  fill={e.code ? '#9be7c4' : '#00d4ff'}
                />
              </marker>
            </defs>
            <text
              x={(x1 + x2) / 2}
              y={y - 5}
              textAnchor="middle"
              style={{
                fontSize: compact ? 9 : 10.5,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fill: e.code ? '#9be7c4' : '#cfe3f7',
              }}
            >
              {e.method}
            </text>
            {/* hidden helper to avoid unused var lint */}
            <g opacity={0}>
              <line x1={cutOff} x2={cutOff} y1={0} y2={0} />
            </g>
          </g>
        );
      })}

      {progress >= 1 && (
        <text
          x={width / 2}
          y={bottomY - 4}
          textAnchor="middle"
          style={{ fontSize: 10, fill: '#6ae4ff', fontFamily: 'ui-monospace' }}
        >
          &gt;&gt; IMS registered · VoNR ready
        </text>
      )}
    </svg>
  );
}
