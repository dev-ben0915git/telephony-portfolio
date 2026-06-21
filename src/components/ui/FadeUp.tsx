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
  const inView = useInView(ref, { once: true, margin: '-40px' });
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0.01, y: 16 }}
      animate={inView ? { opacity: 1, y: 0 } : { opacity: 0.01, y: 16 }}
      transition={{ duration: 0.5, ease: 'easeOut', delay }}
      className={clsx('fade-up-safe', className)}
    >
      {children}
    </motion.div>
  );
}
