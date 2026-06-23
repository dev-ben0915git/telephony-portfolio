'use client';

import { useEffect, useRef, useState } from 'react';

export function NetworkSearchHero() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mql.matches);
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const size = 280;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    ctx.scale(dpr, dpr);

    // 信号塔位置
    const towerX = size * 0.35;
    const towerY = size * 0.55;

    // 手机位置
    const phoneX = size * 0.75;
    const phoneY = size * 0.65;

    // 信号波
    interface Wave {
      r: number;
      opacity: number;
      born: number;
    }
    const waves: Wave[] = [];
    let lastWave = 0;

    // 搜索粒子
    interface Particle {
      x: number;
      y: number;
      angle: number;
      speed: number;
      life: number;
      maxLife: number;
    }
    const particles: Particle[] = [];

    // 信号条动画
    let signalBars = 0;
    let signalPhase = 0;

    let frame = 0;
    let raf = 0;

    const drawTower = () => {
      ctx.save();
      ctx.translate(towerX, towerY);

      // 塔身
      ctx.fillStyle = 'rgba(0, 212, 255, 0.15)';
      ctx.strokeStyle = 'rgba(0, 212, 255, 0.5)';
      ctx.lineWidth = 1.5;

      // 塔底
      ctx.beginPath();
      ctx.moveTo(-18, 60);
      ctx.lineTo(18, 60);
      ctx.lineTo(8, -40);
      ctx.lineTo(-8, -40);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // 横杠
      for (let i = 0; i < 4; i++) {
        const y = 40 - i * 22;
        const w = 12 + i * 3;
        ctx.beginPath();
        ctx.moveTo(-w, y);
        ctx.lineTo(w, y);
        ctx.strokeStyle = 'rgba(0, 212, 255, 0.35)';
        ctx.stroke();
      }

      // 顶部天线
      ctx.beginPath();
      ctx.moveTo(0, -40);
      ctx.lineTo(0, -65);
      ctx.strokeStyle = 'rgba(0, 212, 255, 0.7)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // 天线球
      ctx.beginPath();
      ctx.arc(0, -68, 4, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0, 212, 255, 0.8)';
      ctx.fill();

      // 信号发射点
      ctx.beginPath();
      ctx.arc(0, -68, 2, 0, Math.PI * 2);
      ctx.fillStyle = '#00d4ff';
      ctx.fill();

      ctx.restore();
    };

    const drawPhone = () => {
      ctx.save();
      ctx.translate(phoneX, phoneY);

      // 手机外壳
      ctx.fillStyle = 'rgba(0, 212, 255, 0.08)';
      ctx.strokeStyle = 'rgba(0, 212, 255, 0.4)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(-14, -28, 28, 48, 4);
      ctx.fill();
      ctx.stroke();

      // 屏幕
      ctx.fillStyle = 'rgba(0, 212, 255, 0.05)';
      ctx.beginPath();
      ctx.roundRect(-11, -22, 22, 36, 2);
      ctx.fill();

      // 信号条
      const bars = Math.floor(signalBars);
      for (let i = 0; i < 4; i++) {
        const h = 4 + i * 3;
        const alpha = i < bars ? 0.8 : 0.15;
        ctx.fillStyle = i < bars ? `rgba(0, 212, 255, ${alpha})` : `rgba(148, 163, 184, ${alpha})`;
        ctx.fillRect(-8 + i * 5, -8 - h, 3, h);
      }

      // 搜索文字
      ctx.fillStyle = 'rgba(0, 212, 255, 0.6)';
      ctx.font = '6px ui-monospace, monospace';
      ctx.textAlign = 'center';
      const searchTexts = ['Searching...', 'Searching..', 'Searching.', 'Searching...'];
      ctx.fillText(searchTexts[Math.floor(frame / 30) % 4], 0, 18);

      ctx.restore();
    };

    const drawWaves = () => {
      waves.forEach((wave) => {
        ctx.beginPath();
        ctx.arc(towerX, towerY - 68, wave.r, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(0, 212, 255, ${wave.opacity})`;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      });
    };

    const drawParticles = () => {
      particles.forEach((p) => {
        const alpha = p.life / p.maxLife;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(0, 212, 255, ${alpha * 0.7})`;
        ctx.fill();
      });
    };

    const drawConnectionLine = () => {
      // 塔到手机的虚线连接
      const dx = phoneX - towerX;
      const dy = phoneY - towerY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const dashOffset = -(frame * 0.5) % 20;

      ctx.beginPath();
      ctx.moveTo(towerX + 10, towerY - 50);
      ctx.lineTo(phoneX - 10, phoneY - 10);
      ctx.strokeStyle = 'rgba(0, 212, 255, 0.15)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 6]);
      ctx.lineDashOffset = dashOffset;
      ctx.stroke();
      ctx.setLineDash([]);

      // 连接状态指示
      if (signalBars >= 3) {
        const midX = (towerX + phoneX) / 2;
        const midY = (towerY + phoneY) / 2 - 30;
        ctx.fillStyle = 'rgba(74, 222, 128, 0.8)';
        ctx.font = '8px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('● Registered', midX, midY);
      }
    };

    const drawGrid = () => {
      ctx.strokeStyle = 'rgba(0, 212, 255, 0.04)';
      ctx.lineWidth = 0.5;
      for (let i = 0; i < size; i += 20) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, size);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, i);
        ctx.lineTo(size, i);
        ctx.stroke();
      }
    };

    const animate = () => {
      if (reducedMotion) return;
      frame++;
      ctx.clearRect(0, 0, size, size);

      drawGrid();

      // 生成信号波
      if (frame - lastWave > 45) {
        waves.push({ r: 8, opacity: 0.6, born: frame });
        lastWave = frame;
      }

      // 更新信号波
      for (let i = waves.length - 1; i >= 0; i--) {
        waves[i].r += 1.2;
        waves[i].opacity -= 0.008;
        if (waves[i].opacity <= 0) waves.splice(i, 1);
      }

      // 生成搜索粒子
      if (frame % 10 === 0) {
        particles.push({
          x: phoneX + (Math.random() - 0.5) * 20,
          y: phoneY - 20 + (Math.random() - 0.5) * 10,
          angle: Math.random() * Math.PI * 2,
          speed: 0.3 + Math.random() * 0.5,
          life: 1,
          maxLife: 30 + Math.random() * 20,
        });
      }

      // 更新粒子
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += Math.cos(p.angle) * p.speed;
        p.y += Math.sin(p.angle) * p.speed;
        p.life--;
        if (p.life <= 0) particles.splice(i, 1);
      }

      // 信号条动画
      signalPhase += 0.02;
      signalBars = 2 + Math.sin(signalPhase) * 2; // 2~4 格波动

      drawConnectionLine();
      drawWaves();
      drawTower();
      drawPhone();
      drawParticles();

      raf = requestAnimationFrame(animate);
    };

    raf = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="relative flex h-[280px] w-[280px] items-center justify-center">
      {!reducedMotion && <canvas ref={canvasRef} className="rounded-full" />}
      {reducedMotion && (
        <div className="flex h-[240px] w-[240px] items-center justify-center rounded-full border border-accent/30 bg-accent/5">
          <svg viewBox="0 0 24 24" className="h-16 w-16 text-accent/60" fill="none" stroke="currentColor" strokeWidth="1.2">
            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" />
            <circle cx="12" cy="9" r="2.5" />
          </svg>
        </div>
      )}
      {/* 外圈装饰 */}
      <div className="pointer-events-none absolute inset-0 -z-10 rounded-full border border-accent/10" />
      <div className="pointer-events-none absolute -inset-4 -z-10 rounded-full bg-accent/5 blur-2xl" />
    </div>
  );
}
