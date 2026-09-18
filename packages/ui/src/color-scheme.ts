/** The two colour schemes the probe-web theme defines. */
export type ColorScheme = 'light' | 'dark';

/**
 * The page's current colour scheme. probe-web follows VitePress's convention: the page is
 * dark when `<html>` has the `dark` class (see `@probe-web/ui/theme.css`).
 */
export function currentScheme(): ColorScheme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

/**
 * Call `callback` whenever the page switches between light and dark. Returns a function
 * that stops listening. Components use this to re-theme what CSS cannot reach: xterm,
 * canvas plots and Monaco.
 */
export function onSchemeChange(callback: (scheme: ColorScheme) => void): () => void {
  let last = currentScheme();
  const observer = new MutationObserver(() => {
    const now = currentScheme();
    if (now !== last) callback((last = now));
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

/** Read a CSS custom property as resolved on `el`, or `fallback` when it is unset. */
export function cssVar(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}
