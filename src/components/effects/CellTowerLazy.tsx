'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { CellTowerFallback } from './CellTowerFallback';

const CellTowerScene = dynamic(() =>
  import('@/components/effects/CellTowerScene').then((m) => m.CellTowerScene),
{
  ssr: false,
  loading: () => <CellTowerFallback />,
});

export default function CellTowerLazy() {
  const [useFallback, setUseFallback] = useState(false);

  useEffect(() => {
    // 检测移动端、低性能设备或不支持 WebGL 的环境
    const isMobile = window.innerWidth < 768;
    const isLowPower =
      (navigator as unknown as { deviceMemory?: number }).deviceMemory !== undefined &&
      (navigator as unknown as { deviceMemory?: number }).deviceMemory! <= 3;
    const noWebGL = (() => {
      try {
        const c = document.createElement('canvas');
        return !c.getContext('webgl') && !c.getContext('experimental-webgl');
      } catch {
        return true;
      }
    })();

    if (isMobile || isLowPower || noWebGL) {
      setUseFallback(true);
    }
  }, []);

  if (useFallback) {
    return <CellTowerFallback />;
  }

  return <CellTowerScene />;
}
