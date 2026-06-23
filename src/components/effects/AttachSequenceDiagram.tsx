'use client';

import { useEffect, useRef, useState } from 'react';

interface AttachEvent {
  from: string;
  to: string;
  label: string;
  type?: 'request' | 'response' | 'auth';
}

const events: AttachEvent[] = [
  { from: 'UE', to: 'eNB', label: 'RRC Connection Request', type: 'request' },
  { from: 'eNB', to: 'UE', label: 'RRC Connection Setup', type: 'response' },
  { from: 'UE', to: 'eNB', label: 'Attach Request', type: 'request' },
  { from: 'eNB', to: 'MME', label: 'Initial UE Message', type: 'request' },
  { from: 'MME', to: 'HSS', label: 'Authentication Info Req', type: 'auth' },
  { from: 'HSS', to: 'MME', label: 'Authentication Info Ans', type: 'auth' },
  { from: 'MME', to: 'UE', label: 'Authentication Request', type: 'auth' },
  { from: 'UE', to: 'MME', label: 'Authentication Response', type: 'auth' },
  { from: 'MME', to: 'HSS', label: 'Update Location Req', type: 'request' },
  { from: 'HSS', to: 'MME', label: 'Update Location Ack', type: 'response' },
  { from: 'MME', to: 'UE', label: 'Attach Accept', type: 'response' },
  { from: 'UE', to: 'MME', label: 'Attach Complete', type: 'response' },
];

const actors = ['UE', 'eNB', 'MME', 'HSS'];

export function AttachSequenceDiagram({ compact = false }: { compact?: boolean }) {
  const [progress, setProgress] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mql.matches);
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);
  const [hoveredEvent, setHoveredEvent] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (reducedMotion) {
      setProgress(1);
      return;
    }
    let raf = 0;
    let t = 0;
    const totalFrames = compact ? 80 : 120;
    const tick = () => {
      t += 1;
      setProgress(Math.min(1, t / totalFrames));
      if (t < totalFrames) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [compact, reducedMotion]);

  const width = compact ? 520 : 760;
  const height = compact ? 300 : 440;
  const paddingX = 50;
  const actorXs = actors.map((_, i) => paddingX + (i * (width - paddingX * 2)) / (actors.length - 1));
  const topY = 36;
  const bottomY = height - 28;
  const rowGap = (bottomY - topY) / (events.length + 1);

  const getStrokeColor = (type?: string) => {
    switch (type) {
      case 'auth': return '#fbbf24'; // 黄色 - 认证
      case 'response': return '#4ade80'; // 绿色 - 响应
      default: return '#00d4ff'; // 青色 - 请求
    }
  };

  const getTextColor = (type?: string) => {
    switch (type) {
      case 'auth': return '#fde68a';
      case 'response': return '#bbf7d0';
      default: return '#cfe3f7';
    }
  };

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full max-w-full"
      role="img"
      aria-label="开机驻网 Attach 时序"
    >
      <defs>
        <linearGradient id="grad-auth" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#fbbf24" stopOpacity="0.1" />
          <stop offset="50%" stopColor="#fbbf24" stopOpacity="1" />
          <stop offset="100%" stopColor="#fbbf24" stopOpacity="0.1" />
        </linearGradient>
        <linearGradient id="grad-resp" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#4ade80" stopOpacity="0.1" />
          <stop offset="50%" stopColor="#4ade80" stopOpacity="1" />
          <stop offset="100%" stopColor="#4ade80" stopOpacity="0.1" />
        </linearGradient>
        <linearGradient id="grad-req" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#00d4ff" stopOpacity="0.1" />
          <stop offset="50%" stopColor="#00d4ff" stopOpacity="1" />
          <stop offset="100%" stopColor="#00d4ff" stopOpacity="0.1" />
        </linearGradient>
      </defs>

      {/* 参与者标签和生命线 */}
      {actors.map((a, i) => (
        <g key={a}>
          {/* 参与者框 */}
          <rect
            x={actorXs[i] - 28}
            y={8}
            width={56}
            height={22}
            rx={4}
            fill="rgba(0,212,255,0.08)"
            stroke="rgba(0,212,255,0.35)"
            strokeWidth={1}
          />
          <text
            x={actorXs[i]}
            y={23}
            textAnchor="middle"
            style={{
              fontSize: 11,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fill: '#00d4ff',
              fontWeight: 600,
            }}
          >
            {a}
          </text>
          {/* 生命线 */}
          <line
            x1={actorXs[i]}
            x2={actorXs[i]}
            y1={topY}
            y2={bottomY}
            stroke="rgba(0,212,255,0.12)"
            strokeDasharray="3 3"
          />
        </g>
      ))}

      {/* 事件消息 */}
      {events.map((e, idx) => {
        const fromIdx = actors.indexOf(e.from);
        const toIdx = actors.indexOf(e.to);
        const x1 = actorXs[fromIdx];
        const x2 = actorXs[toIdx];
        const y = topY + (idx + 1) * rowGap;
        const eventProgress = (idx / events.length);
        const visible = progress >= eventProgress;
        const localP = Math.min(1, (progress - eventProgress) * events.length);
        const endX = x1 + (x2 - x1) * localP;
        const isHovered = hoveredEvent === idx;

        const gradId = e.type === 'auth' ? 'grad-auth' : e.type === 'response' ? 'grad-resp' : 'grad-req';
        const strokeColor = getStrokeColor(e.type);
        const textColor = getTextColor(e.type);

        return (
          <g
            key={idx}
            opacity={visible ? 1 : 0}
            style={{ cursor: 'pointer' }}
            onMouseEnter={() => setHoveredEvent(idx)}
            onMouseLeave={() => setHoveredEvent(null)}
          >
            {/* 消息线 */}
            <line
              x1={x1}
              x2={endX}
              y1={y}
              y2={y}
              stroke={isHovered ? strokeColor : `url(#${gradId})`}
              strokeWidth={isHovered ? 2 : 1.4}
              markerEnd={localP >= 1 ? `url(#arrow-${e.type || 'req'})` : undefined}
              style={{ transition: 'stroke-width 0.2s ease' }}
            />
            {/* 箭头标记 */}
            <defs>
              <marker
                id={`arrow-${e.type || 'req'}`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L10,5 L0,10 z" fill={strokeColor} />
              </marker>
            </defs>
            {/* 消息标签 */}
            <text
              x={(x1 + x2) / 2}
              y={y - 6}
              textAnchor="middle"
              style={{
                fontSize: compact ? 8.5 : 10,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fill: isHovered ? '#fff' : textColor,
                fontWeight: isHovered ? 600 : 400,
                transition: 'fill 0.2s ease',
              }}
            >
              {e.label}
            </text>
            {/* 高亮背景 */}
            {isHovered && (
              <rect
                x={Math.min(x1, x2) - 4}
                y={y - 14}
                width={Math.abs(x2 - x1) + 8}
                height={18}
                rx={3}
                fill="rgba(0,212,255,0.06)"
                stroke="rgba(0,212,255,0.15)"
                strokeWidth={0.5}
              />
            )}
          </g>
        );
      })}

      {/* 完成状态 */}
      {progress >= 1 && (
        <g>
          <text
            x={width / 2}
            y={bottomY - 2}
            textAnchor="middle"
            style={{ fontSize: 10, fill: '#4ade80', fontFamily: 'ui-monospace' }}
          >
            {'>> Attach Complete · Network Registered'}
          </text>
          {/* 底部状态条 */}
          <rect
            x={width / 2 - 80}
            y={bottomY + 4}
            width={160}
            height={3}
            rx={1.5}
            fill="rgba(74,222,128,0.2)"
          />
          <rect
            x={width / 2 - 80}
            y={bottomY + 4}
            width={160}
            height={3}
            rx={1.5}
            fill="#4ade80"
            opacity={0.6}
          >
            <animate
              attributeName="opacity"
              values="0.6;1;0.6"
              dur="2s"
              repeatCount="indefinite"
            />
          </rect>
        </g>
      )}

      {/* 图例 */}
      <g transform={`translate(${width - 110}, ${topY})`}>
        <rect x={-6} y={-6} width={110} height={52} rx={4} fill="rgba(0,0,0,0.3)" stroke="rgba(255,255,255,0.08)" />
        {[
          { color: '#00d4ff', label: 'Request' },
          { color: '#4ade80', label: 'Response' },
          { color: '#fbbf24', label: 'Auth' },
        ].map((item, i) => (
          <g key={item.label} transform={`translate(0, ${i * 14})`}>
            <line x1={0} x2={14} y1={0} y2={0} stroke={item.color} strokeWidth={1.5} />
            <text x={18} y={3} style={{ fontSize: 8, fill: '#94a3b8', fontFamily: 'ui-monospace' }}>
              {item.label}
            </text>
          </g>
        ))}
      </g>
    </svg>
  );
}
