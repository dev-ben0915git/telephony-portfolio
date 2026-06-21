'use client';

import dynamic from 'next/dynamic';

const CellTowerScene = dynamic(() =>
  import('@/components/effects/CellTowerScene').then((m) => m.CellTowerScene),
{
  ssr: false,
  loading: () => (
    <div className="h-[320px] w-full animate-pulse rounded-2xl border border-bg-line/80 bg-bg-card/60" />
  ),
});

export default CellTowerScene;
