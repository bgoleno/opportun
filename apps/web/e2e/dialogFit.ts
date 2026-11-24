import type { Locator } from '@playwright/test';

/**
 * How a dialog's content fits it: how far it scrolls sideways, and what is drawn past its edges. A
 * dialog's content scrolls, so one long word in it (a name, a subject) widens all of it, and the
 * buttons start out of sight (https://github.com/bgoleno/opportun/issues/921).
 */
export async function fit(dialog: Locator): Promise<{ sideways: number; outside: string[] }> {
  return await dialog.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const all = [...el.querySelectorAll<HTMLElement>('*')].filter(
      (e) => e.getClientRects().length > 0,
    );
    return {
      sideways: Math.max(...[el, ...all].map((e) => e.scrollWidth - e.clientWidth), 0),
      outside: all
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return r.left < box.left || r.right > box.right;
        })
        .map((e) => {
          const r = e.getBoundingClientRect();
          return `<${e.tagName.toLowerCase()}> "${e.textContent.slice(0, 20)}" ${r.left} to ${r.right}, dialog ${box.left} to ${box.right}`;
        }),
    };
  });
}
