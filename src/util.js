import { createSelector } from 'reselect';

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const TAG_ROW_H = 24;
export const TAG_TOP_PAD = 6;
export const TAG_HEIGHT = 22;

export function niceStep(_pxPerTick, approx) {
  const steps = [1, 2, 5];
  let n = Math.pow(10, Math.floor(Math.log10(Math.max(approx, 1e-6))));
  let best = steps[0] * n,
    err = Infinity;
  for (const k of steps) {
    for (const m of [n / 10, n, n * 10, n * 100]) {
      const s = k * m,
        e = Math.abs(s - approx);
      if (e < err) {
        err = e;
        best = s;
      }
    }
  }
  return Math.max(best, 0.01);
}

export function priceColor(curr, prev) {
  if (prev == null || curr === prev) return 'white';
  return curr > prev ? 'green' : 'red';
}

export function estimateTagWidth(text) {
  const len = String(text || '').length;
  return Math.max(48, 12 + len * 8 + 12);
}

export function layoutTags(tags, width) {
  const ordered = tags.slice().sort((a, b) => a.x - b.x);
  const rowEnds = [];
  const placed = [];
  for (const t of ordered) {
    const w = estimateTagWidth(t.text);
    const left = t.x - w / 2;
    let row = 0;
    while (true) {
      if (rowEnds[row] == null || left > rowEnds[row] + 6) {
        rowEnds[row] = left + w;
        break;
      }
      row++;
    }
    placed.push({ ...t, top: TAG_TOP_PAD + row * TAG_ROW_H, row });
  }
  return placed;
}

export function layoutTagsGrouped(groups, width) {
  const all = [];
  let base = 0;
  let totalRows = 0;
  for (const g of groups) {
    const placed = layoutTags(g, width);
    let maxRow = -1;
    for (const p of placed) {
      all.push({ ...p, top: TAG_TOP_PAD + (base + p.row) * TAG_ROW_H, row: base + p.row });
      maxRow = Math.max(maxRow, p.row);
    }
    const used = Math.max(1, maxRow + 1);
    base += used;
    totalRows += used;
  }
  return { placed: all, totalRows };
}

export const selectMarket = (s) => s.market;
export const selectOrders = (s) => s.orders;
export const selectSettings = (s) => s.settings;
export const selectPriceRange = (s) => s.market.priceRange;

export const selectFilteredOptions = createSelector(
  [s => s.market.options, selectSettings],
  (opts, settings) => (opts || []).filter(o => o.probITM >= settings.minProbITM && o.bidSize >= settings.minBidSize)
);

export const makePasToX = () => createSelector(
  [selectPriceRange, (_s, width) => Math.max(1, width || 1)],
  (range, width) => {
    const span = Math.max(0.01, range.max - range.min);
    return (pas) => ((pas - range.min) / span) * width;
  }
);

export const makeGridlinesPx = () => createSelector(
  [selectPriceRange, (_s, width) => Math.max(1, width || 1)],
  (range, width) => {
    const desiredPx = 90;
    const step = niceStep(1, (range.max - range.min) / Math.max(1, Math.floor(width / desiredPx)));
    const start = Math.ceil(range.min / step) * step;
    const arr = [];
    for (let v = start; v <= range.max + 1e-6; v += step) arr.push(Math.round(v * 100) / 100);
    return { values: arr, toPx: (pas) => ((pas - range.min) / (range.max - range.min)) * width, step };
  }
);

export const selectOptionPasBounds = createSelector([selectFilteredOptions], (opts) => {
  if (!opts || !opts.length) return { min: null, max: null };
  return { min: Math.min(...opts.map(o => o.askPAS)), max: Math.max(...opts.map(o => o.bidPAS)) };
});

