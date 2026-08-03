import { describe, it, expect, beforeEach } from 'vitest';
import { store, actions } from '../src/logic';

describe('toast queue', () => {
  beforeEach(() => store.dispatch(actions.clearToast()));

  it('stacks multiple messages instead of replacing', () => {
    store.dispatch(actions.showToast('first'));
    store.dispatch(actions.showToast('second'));
    const items = store.getState().toast.items;
    expect(items.map((t) => t.message)).toEqual(['first', 'second']);
  });

  it('gives each toast a distinct id so they can be dismissed individually', () => {
    store.dispatch(actions.showToast('a'));
    store.dispatch(actions.showToast('b'));
    const [a, b] = store.getState().toast.items;
    expect(a.id).not.toBe(b.id);

    store.dispatch(actions.dismissToast(a.id));
    expect(store.getState().toast.items.map((t) => t.message)).toEqual(['b']);
  });

  it('caps the stack so a burst of per-contract errors cannot bury the screen', () => {
    for (let i = 0; i < 12; i++) store.dispatch(actions.showToast(`msg ${i}`));
    const items = store.getState().toast.items;
    expect(items).toHaveLength(5);
    // The newest survive; the oldest are dropped.
    expect(items[items.length - 1].message).toBe('msg 11');
  });

  it('dismissing an unknown id is a no-op', () => {
    store.dispatch(actions.showToast('only'));
    store.dispatch(actions.dismissToast('nope'));
    expect(store.getState().toast.items).toHaveLength(1);
  });
});
