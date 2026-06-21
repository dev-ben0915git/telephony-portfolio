'use client';

import { useEffect, useRef } from 'react';

export function CellTowerFallback() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let w = 0;
    let h = 0;
    let t = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.parentElement?.clientWidth || canvas.clientWidth || 640;
      h = canvas.parentElement?.clientHeight || canvas.clientHeight || 320;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const cx = () => w / 2;
    const cy = () => h * 0.62;
    const scale = () => Math.min(w, h) / 420;

    const draw = () => {
      t += 0.012;
      ctx.clearRect(0, 0, w, h);
      const s = scale();
      const x = cx();
      const y = cy();

      // 六边形网格背景
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(s, s);
      ctx.rotate(t * 0.15);

      const hexR = 28;
      const rings = 4;
      for (let r = 1; r <= rings; r++) {
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const angle = (Math.PI / 3) * i - Math.PI / 6;
          const px = Math.cos(angle) * hexR * r;
          const py = Math.sin(angle) * hexR * r;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.strokeStyle = `rgba(0,212,255,${0.08 + r * 0.04})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // 网格节点
      for (let q = -3; q <= 3; q++) {
        for (let r = -3; r <= 3; r++) {
          const sCoord = -q - r;
          if (Math.abs(sCoord) > 3) continue;
          const px = hexR * (3 / 2) * q;
          const pz = hexR * (Math.sqrt(3) / 2 * q + Math.sqrt(3) * r);
          if (Math.hypot(px, pz) > hexR * 3.5) continue;
          ctx.beginPath();
          ctx.arc(px, pz, 1.8, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(106,228,255,0.5)';
          ctx.fill();
        }
      }
      ctx.restore();

      // 基站主体
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(s, s);

      const towerH = 90;
      const towerW = 14;
      const baseY = 40;

      // 基站轮廓
      ctx.beginPath();
      ctx.moveTo(-towerW / 2, baseY);
      ctx.lineTo(0, baseY - towerH);
      ctx.lineTo(towerW / 2, baseY);
      ctx.closePath();
      ctx.strokeStyle = 'rgba(0,212,255,0.55)';
      ctx.lineWidth = 1.2;
      ctx.stroke();

      // 交叉支撑
      for (let i = 0; i < 4; i++) {
        const yy = baseY - towerH * 0.15 - i * (towerH * 0.22);
        const ww = towerW * (0.3 + i * 0.18);
        ctx.beginPath();
        ctx.moveTo(-ww / 2, yy);
        ctx.lineTo(ww / 2, yy);
        ctx.strokeStyle = 'rgba(0,212,255,0.25)';
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }

      // 天线节点
      for (let i = 0; i < 3; i++) {
        const ay = baseY - towerH + 8 + i * 14;
        const ax = Math.cos((i / 3) * Math.PI * 2 + t * 0.3) * 10;
        ctx.beginPath();
        ctx.arc(ax, ay, 5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,212,255,0.7)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(ax, ay, 2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,212,255,0.5)';
        ctx.fill();
      }

      // 信号脉冲环
      const pulseCount = 3;
      for (let i = 0; i < pulseCount; i++) {
        const phase = (t * 0.8 + i * (Math.PI * 2 / pulseCount)) % (Math.PI * 2);
        const radius = 20 + phase * 25;
        const opacity = Math.max(0, 0.5 - phase * 0.15);
        if (opacity <= 0) continue;
        ctx.beginPath();
        ctx.arc(0, baseY - towerH * 0.5, radius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(0,212,255,${opacity})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      ctx.restore();

      // 信息标签
      ctx.fillStyle = 'rgba(0,212,255,0.8)';
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.fillText('cell_tower · 5G · signal', 16, 24);
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(148,163,184,0.6)';
      ctx.fillText('BTS / gNB · eCPRI', w - 16, 24);

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <div className="relative h-[320px] w-full overflow-hidden rounded-2xl border border-bg-line/80 bg-gradient-to-b from-bg-base via-bg-soft/80 to-bg-base">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-hidden="true" />
    </div>
  );
}
