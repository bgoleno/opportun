import { expect, type Page } from '@playwright/test';

export interface FieldRow {
  fields: string[];
  /** How far apart the row's labels, and its controls, start. */
  labels: number;
  controls: number;
}

/**
 * Every row of two or more labelled fields side by side on the page, as drawn: the fields are cells
 * of one grid, or items of one flex row, and cross at some height. A checkbox's or a radio's label is
 * beside its control, and a file input is hidden behind its own, so none is one
 * (https://github.com/bgoleno/opportun/issues/951).
 */
export async function fieldRows(page: Page): Promise<FieldRow[]> {
  return await page.evaluate(() => {
    interface Field {
      name: string;
      cell: DOMRect;
      label: number;
      control: number;
    }
    const rows = new Map<Element, Field[]>();
    for (const label of document.querySelectorAll('label')) {
      const control = label.control;
      if (control === null || label.contains(control)) continue;
      if (control instanceof HTMLInputElement && /checkbox|radio|file/.test(control.type)) continue;
      if (control.closest('[role="checkbox"]') || control.getClientRects().length === 0) continue;
      let cell: Element = label;
      while (cell.parentElement !== null && !cell.contains(control)) cell = cell.parentElement;
      const parent = cell.parentElement;
      if (parent === null) continue;
      const box = cell.getBoundingClientRect();
      const style = getComputedStyle(parent);
      const across =
        style.display === 'grid'
          ? style.gridTemplateColumns.split(' ').length > 1
          : style.display === 'flex' && style.flexDirection.startsWith('row');
      if (!across) continue;
      // The words, not the label's box: a label stretched to its share of the row has them in its middle.
      const words = document.createRange();
      words.selectNodeContents(label);
      const list = rows.get(parent) ?? [];
      list.push({
        name: label.textContent,
        cell: box,
        label: words.getBoundingClientRect().top,
        control: control.getBoundingClientRect().top,
      });
      rows.set(parent, list);
    }
    const spread = (xs: number[]) => Math.round((Math.max(...xs) - Math.min(...xs)) * 10) / 10;
    const out: FieldRow[] = [];
    for (const list of rows.values()) {
      let left = list;
      while (left.length > 0) {
        const first = left[0]!;
        const beside = (f: Field) =>
          f === first || (f.cell.top < first.cell.bottom && f.cell.bottom > first.cell.top);
        const row = left.filter(beside).sort((x, y) => x.cell.left - y.cell.left);
        left = left.filter((f) => !beside(f));
        if (row.length > 1)
          out.push({
            fields: row.map((f) => f.name),
            labels: spread(row.map((f) => f.label)),
            controls: spread(row.map((f) => f.control)),
          });
      }
    }
    return out;
  });
}

/**
 * Every row of fields on the page lines up, labels and controls, at each width, and `rows` are among
 * them where there is room for them side by side (none is at 360 px).
 */
export async function expectLinedUp(page: Page, rows: readonly string[]): Promise<void> {
  const before = page.viewportSize();
  for (const width of [360, 768, 1280, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    const drawn = await fieldRows(page);
    const off = drawn.filter((r) => r.labels >= 1 || r.controls >= 1);
    expect.soft(off, `at ${width} px`).toEqual([]);
    if (width < 640) continue;
    expect.soft(drawn.length, `rows at ${width} px`).toBeGreaterThan(0);
    const names = drawn.map((r) => r.fields.join(' | '));
    expect.soft(names, `at ${width} px`).toEqual(expect.arrayContaining([...rows]));
  }
  if (before !== null) await page.setViewportSize(before);
}
