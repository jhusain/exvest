import { describe, it, expect, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { actions, ordersReducer } from '../src/logic';

const createStore = () => configureStore({ reducer: { orders: ordersReducer } });
type TestStore = ReturnType<typeof createStore>;

describe('mergeOrders reducer', () => {
  let store: TestStore;
  const getOrder = (id: string) => store.getState().orders.openOrders.find((o) => o.id === id);

  beforeEach(() => {
    store = createStore();
  });

  it('adds new orders with the provided fields', () => {
    store.dispatch(actions.mergeOrders([{ id: '1', status: 'Submitted', qty: 10 }]));

    const order = getOrder('1');
    expect(order).toEqual({ id: '1', status: 'Submitted', qty: 10 });
  });

  it('adds payload orders that are absent from state without disturbing existing ones', () => {
    store.dispatch(actions.mergeOrders([{ id: '1', status: 'Submitted', qty: 10, limitPrice: 0.5, pas: 100 }]));

    store.dispatch(
      actions.mergeOrders([
        { id: '1', qty: 7 },
        { id: '2', status: 'Submitted', qty: 3, limitPrice: 0.25 }
      ])
    );

    const openOrders = store.getState().orders.openOrders;
    expect(openOrders).toHaveLength(2);
    expect(getOrder('1')).toEqual({ id: '1', status: 'Submitted', qty: 7, limitPrice: 0.5, pas: 100 });
    expect(getOrder('2')).toEqual({ id: '2', status: 'Submitted', qty: 3, limitPrice: 0.25 });
  });

  it('updates each explicit field on an existing order', () => {
    store.dispatch(actions.mergeOrders([{ id: '1', status: 'Submitted', qty: 10, limitPrice: 0.5, pas: 100 }]));

    store.dispatch(actions.mergeOrders([{ id: '1', status: 'Filled', qty: 7, limitPrice: 1.25, pas: 120 }]));

    const order = getOrder('1');
    expect(order).toEqual({ id: '1', status: 'Filled', qty: 7, limitPrice: 1.25, pas: 120 });
  });

  it('does not remove existing field values when updates omit them', () => {
    store.dispatch(actions.mergeOrders([{ id: '1', status: 'Submitted', qty: 10, limitPrice: 0.5, pas: 100 }]));

    store.dispatch(actions.mergeOrders([{ id: '1', status: 'Filled' }]));

    const order = getOrder('1');
    expect(order).toEqual({ id: '1', status: 'Filled', qty: 10, limitPrice: 0.5, pas: 100 });
  });

  it('does not remove orders that are missing from an update payload', () => {
    store.dispatch(
      actions.mergeOrders([
        { id: '1', status: 'Submitted', qty: 10 },
        { id: '2', status: 'Submitted', qty: 5 }
      ])
    );

    store.dispatch(actions.mergeOrders([{ id: '1', qty: 8 }]));

    const openOrders = store.getState().orders.openOrders;
    expect(openOrders).toHaveLength(2);
    expect(getOrder('1')).toEqual({ id: '1', status: 'Submitted', qty: 8 });
    expect(getOrder('2')).toEqual({ id: '2', status: 'Submitted', qty: 5 });
  });

  it('prunes an order once it reaches a terminal Cancelled/Rejected status', () => {
    store.dispatch(actions.mergeOrders([{ id: '1', status: 'Submitted', qty: 10 }]));
    store.dispatch(actions.mergeOrders([{ id: '1', status: 'Cancelled', qty: 10 }]));

    expect(getOrder('1')).toBeUndefined();
  });
});
