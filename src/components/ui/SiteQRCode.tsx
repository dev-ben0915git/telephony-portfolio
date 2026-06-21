'use client';

import { QRCodeSVG } from 'qrcode.react';
import { siteConfig } from '@/config/site';

export function SiteQRCode() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-bg-line bg-bg-card/60 p-5">
      <div className="rounded-lg bg-white p-2 shadow-[0_0_18px_rgba(0,212,255,0.25)]">
        <QRCodeSVG
          value={siteConfig.url}
          size={128}
          bgColor="#ffffff"
          fgColor="#070b13"
          level="M"
        />
      </div>
      <div className="text-xs text-slate-400">扫码访问站点</div>
      <div className="font-mono text-[11px] text-accent/80">{siteConfig.url}</div>
    </div>
  );
}
