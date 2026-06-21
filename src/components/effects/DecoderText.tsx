'use client';

import { useEffect, useRef, useState } from 'react';

interface DecoderTextProps {
  text: string;
  className?: string;
  speed?: number;
  startDelay?: number;
}

const GLYPHS = '01ABCDEF<>/\\|+*#%@$=[]{}()'.split('');

export function DecoderText({
  text,
  className,
  speed = 28,
  startDelay = 120,
}: DecoderTextProps) {
  const [display, setDisplay] = useState(text);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const frame = useRef(0);

  useEffect(() => {
    setDisplay(' '.repeat(text.length));
    frame.current = 0;
    const startTimer = setTimeout(() => {
      const run = () => {
        frame.current += 1;
        const revealed = Math.floor((frame.current * text.length) / 40);
        let out = '';
        for (let i = 0; i < text.length; i++) {
          if (i < revealed) {
            out += text[i];
          } else if (text[i] === ' ') {
            out += ' ';
          } else {
            out += GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
          }
        }
        setDisplay(out);
        if (revealed >= text.length) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          setDisplay(text);
        }
      };
      intervalRef.current = setInterval(run, speed);
    }, startDelay);

    return () => {
      clearTimeout(startTimer);
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  return (
    <span className={className} aria-label={text}>
      {display}
      <span className="ml-1 inline-block h-[1em] w-[0.5em] translate-y-[0.1em] bg-accent/80 shadow-[0_0_12px_#00d4ff] animate-blink" />
    </span>
  );
}
