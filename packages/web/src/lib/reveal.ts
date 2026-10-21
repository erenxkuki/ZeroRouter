/**
 * Scroll-reveal driver for the public pages. One IntersectionObserver per
 * mount: elements with `.zr-reveal` get `.zr-in` when they enter the viewport,
 * trace boxes (`.zr-tracebox`) switch their child lines on with staggered
 * delays. Decorative only — under `prefers-reduced-motion: reduce` the CSS
 * initial states are lifted, so content is always visible even if this hook
 * never runs.
 *
 * Hardened for non-visible browsing contexts (background tabs, embedded
 * viewports, automation): IO callbacks are starved while a document is
 * hidden, so above-the-fold content is force-revealed on a short fallback
 * timer and everything is revealed when the document hides — content is never
 * stuck invisible because an event queue was asleep.
 */
import { useEffect } from 'react';

export function useReveal(reviveKey: unknown = undefined): void {
  useEffect(() => {
    const reveals = document.querySelectorAll<HTMLElement>('.zr-reveal');
    const traceboxes = document.querySelectorAll<HTMLElement>('.zr-tracebox');
    if (reveals.length === 0 && traceboxes.length === 0) return;

    const revealAll = () => {
      reveals.forEach((el) => el.classList.add('zr-in'));
      traceboxes.forEach((box) => box.querySelectorAll<HTMLElement>('.zr-trace').forEach((l) => l.classList.add('is-on')));
    };
    const revealInView = () => {
      const vh = window.innerHeight;
      for (const el of reveals) {
        if (!el.classList.contains('zr-in') && el.getBoundingClientRect().top < vh) el.classList.add('zr-in');
      }
      for (const box of traceboxes) {
        if (box.getBoundingClientRect().top < vh) {
          box.querySelectorAll<HTMLElement>('.zr-trace').forEach((l) => l.classList.add('is-on'));
        }
      }
    };

    if (document.visibilityState === 'hidden') {
      // Static presentation: no animation dependency in hidden contexts.
      revealAll();
      // Also re-reveal if the page becomes scrollable-hidden later.
      document.addEventListener('visibilitychange', revealAll, { once: true });
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLElement;
          if (el.classList.contains('zr-reveal')) el.classList.add('zr-in');
          if (el.classList.contains('zr-tracebox')) {
            el.querySelectorAll<HTMLElement>('.zr-trace').forEach((line) => line.classList.add('is-on'));
          }
          io.unobserve(el);
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -6% 0px' },
    );
    reveals.forEach((el) => io.observe(el));
    traceboxes.forEach((el) => io.observe(el));

    // Fallback for starved/lost IO events: reveal whatever is already in the
    // first viewport a moment after mount, and everything when the document
    // is (or becomes) hidden.
    const fallback = window.setTimeout(revealInView, 1200);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') revealAll();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearTimeout(fallback);
      document.removeEventListener('visibilitychange', onVisibility);
      io.disconnect();
    };
  }, [reviveKey]);
}
