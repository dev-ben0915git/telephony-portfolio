'use client';

import { useEffect, useRef, useState } from 'react';

interface PacketNode {
  x: number;
  y: number;
  label: string;
  radius: number;
}

interface Packet {
  from: number;
  to: number;
  progress: number;
  speed: number;
  color: string;
}

const COLORS = {
  ril: 'rgba(0, 212, 255, 0.85)',
  qmi: 'rgba(160, 124, 255, 0.85)',
  at: 'rgba(255, 141, 61, 0.85)',
  modem: 'rgba(53, 230, 168, 0.85)',
};

export function SignalParticles() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const nodesRef = useRef<PacketNode[]>([]);
  const packetsRef = useRef<Packet[]>([]);
  const mouseRef = useRef<{ x: number; y: number; active: boolean }>({
    x: 0,
    y: 0,
    active: false,
  });
  const runningRef = useRef(true);

  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mql.matches);
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;

    const setSize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = window.innerWidth + 'px';
      canvas.style.height = window.innerHeight + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const w = window.innerWidth;
      const h = window.innerHeight;
      nodesRef.current = [
        { x: w * 0.15, y: h * 0.28, label: 'RIL Java', radius: 16 },
        { x: w * 0.38, y: h * 0.58, label: 'RILD', radius: 18 },
        { x: w * 0.62, y: h * 0.28, label: 'QCRIL', radius: 18 },
        { x: w * 0.85, y: h * 0.62, label: 'Modem', radius: 20 },
      ];
    };
    setSize();

    const randomPacket = (): Packet => {
      const routes: [number, number, string][] = [
        [0, 1, COLORS.ril],
        [1, 2, COLORS.qmi],
        [2, 3, COLORS.modem],
        [3, 2, COLORS.at],
        [2, 1, COLORS.qmi],
        [1, 0, COLORS.ril],
      ];
      const [from, to, color] = routes[Math.floor(Math.random() * routes.length)];
      return {
        from,
        to,
        progress: Math.random() * 0.2,
        speed: 0.0025 + Math.random() * 0.004,
        color,
      };
    };

    const spawnInitial = () => {
      packetsRef.current = Array.from({ length: 18 }, () => randomPacket());
    };
    spawnInitial();

    let resizeTimer: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => setSize(), 200);
    };
    window.addEventListener('resize', onResize);

    const onMove = (e: MouseEvent) => {
      mouseRef.current.x = e.clientX;
      mouseRef.current.y = e.clientY;
      mouseRef.current.active = true;
    };
    const onLeave = () => (mouseRef.current.active = false);
    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('mouseleave', onLeave);

    const isLowPower = () => {
      if (typeof navigator === 'undefined') return false;
      const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
      if (mem && mem <= 2) return true;
      return window.innerWidth < 640;
    };

    const draw = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      ctx.clearRect(0, 0, w, h);

      const nodes = nodesRef.current;
      const packets = packetsRef.current;
      const mouse = mouseRef.current;
      const low = isLowPower();

      // Edges
      const pairs: [number, number][] = [
        [0, 1],
        [1, 2],
        [2, 3],
        [1, 3],
      ];
      for (const [a, b] of pairs) {
        const n1 = nodes[a];
        const n2 = nodes[b];
        ctx.beginPath();
        ctx.moveTo(n1.x, n1.y);
        ctx.lineTo(n2.x, n2.y);
        const grad = ctx.createLinearGradient(n1.x, n1.y, n2.x, n2.y);
        grad.addColorStop(0, 'rgba(0,212,255,0.08)');
        grad.addColorStop(0.5, 'rgba(0,212,255,0.18)');
        grad.addColorStop(1, 'rgba(0,212,255,0.08)');
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Nodes
      for (const n of nodes) {
        const hover =
          mouse.active &&
          Math.hypot(mouse.x - n.x, mouse.y - n.y) < Math.max(n.radius + 40, 80);
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.radius + (hover ? 8 : 0), 0, Math.PI * 2);
        const grd = ctx.createRadialGradient(n.x, n.y, 1, n.x, n.y, n.radius + 30);
        grd.addColorStop(0, hover ? 'rgba(0,212,255,0.7)' : 'rgba(0,212,255,0.35)');
        grd.addColorStop(1, 'rgba(0,212,255,0)');
        ctx.fillStyle = grd;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(n.x, n.y, n.radius * 0.45, 0, Math.PI * 2);
        ctx.fillStyle = '#00d4ff';
        ctx.fill();

        ctx.fillStyle = 'rgba(191,229,255,0.85)';
        ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(n.label, n.x, n.y + n.radius + 16);
      }

      // Packets moving along edges
      for (let i = 0; i < packets.length; i++) {
        const p = packets[i];
        p.progress += p.speed;
        if (p.progress >= 1) {
          packets[i] = randomPacket();
          continue;
        }
        const from = nodes[p.from];
        const to = nodes[p.to];
        const x = from.x + (to.x - from.x) * p.progress;
        const y = from.y + (to.y - from.y) * p.progress;

        // tail
        const tailCount = low ? 3 : 5;
        for (let t = 1; t <= tailCount; t++) {
          const tp = Math.max(0, p.progress - t * 0.025);
          const tx = from.x + (to.x - from.x) * tp;
          const ty = from.y + (to.y - from.y) * tp;
          ctx.beginPath();
          ctx.arc(tx, ty, 1.8 * (1 - t / tailCount), 0, Math.PI * 2);
          ctx.fillStyle = p.color.replace(/[\d.]+\)/, `${0.12 * (1 - t / tailCount)})`);
          ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 10;
        ctx.fill();
        ctx.shadowBlur = 0;

        // Highlight from mouse
        if (
          mouse.active &&
          Math.hypot(mouse.x - x, mouse.y - y) < 120
        ) {
          ctx.beginPath();
          ctx.arc(x, y, 6, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(0,212,255,0.7)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      // Mouse to nearest node faint lines (only on desktop)
      if (mouse.active && !low) {
        for (const n of nodes) {
          const d = Math.hypot(mouse.x - n.x, mouse.y - n.y);
          if (d < 220) {
            ctx.beginPath();
            ctx.moveTo(mouse.x, mouse.y);
            ctx.lineTo(n.x, n.y);
            ctx.strokeStyle = `rgba(0,212,255,${0.06 * (1 - d / 220)})`;
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }
      }

      if (runningRef.current) {
        rafRef.current = window.requestAnimationFrame(draw);
      }
    };

    rafRef.current = window.requestAnimationFrame(draw);

    return () => {
      runningRef.current = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', onResize);
      clearTimeout(resizeTimer);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseleave', onLeave);
    };
  }, []);

  return (
    <div className="absolute inset-0">
      {reducedMotion ? null : (
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full opacity-70"
          aria-hidden="true"
        />
      )}
    </div>
  );
}
