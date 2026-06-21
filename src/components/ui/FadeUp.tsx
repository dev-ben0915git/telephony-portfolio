'use client';

import { motion, useInView } from 'framer-motion';
import { useRef } from 'react';
import { clsx } from 'clsx';
import type { ReactNode } from 'react';

export function FadeUp({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const inView = useInView(ref, { once: true, margin: '-80px' });
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 20 }}
      animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
      transition={{ duration: 0.55, ease: 'easeOut', delay }}
      className={clsx(className)}
    >
      {children}
    </motion.div>
  );
}
