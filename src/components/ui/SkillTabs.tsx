'use client';

import { useState } from 'react';
import { skills } from '@/data/portfolio';
import { TechCard } from './TechCard';
import { SkillBar } from './SkillBar';
import { FadeUp } from './FadeUp';
import { clsx } from 'clsx';

export function SkillTabs() {
  const [active, setActive] = useState(skills[0].key);
  const activeGroup = skills.find((g) => g.key === active)!;

  return (
    <div>
      {/* 移动端横向滚动 Tab */}
      <div className="mb-6 flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
        {skills.map((g) => (
          <button
            key={g.key}
            onClick={() => setActive(g.key)}
            className={clsx(
              'shrink-0 rounded-lg border px-3.5 py-2 text-sm transition',
              active === g.key
                ? 'border-accent/50 bg-accent/10 text-accent'
                : 'border-bg-line bg-bg-card/60 text-slate-300 hover:border-accent/30 hover:text-white',
            )}
          >
            {g.title}
          </button>
        ))}
      </div>

      {/* 当前选中内容 */}
      <FadeUp key={active}>
        <TechCard title={activeGroup.title} subtitle={activeGroup.description}>
          <div className="space-y-3">
            {activeGroup.skills.map((s) => (
              <SkillBar key={s.name} label={s.name} value={s.level} />
            ))}
          </div>
        </TechCard>
      </FadeUp>
    </div>
  );
}
