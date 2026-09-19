let reducedMotionQuery: MediaQueryList | undefined;

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;

  if (!reducedMotionQuery) {
    reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  }

  return reducedMotionQuery.matches;
}
