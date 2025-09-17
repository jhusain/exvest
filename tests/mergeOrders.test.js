import { describe, it, expect, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { actions, ordersReducer } from '../src/logic';

const createStore = () => configureStore({ reducer: { orders: ordersReducer } });

describe('mergeOrders reducer', () => {
  let store;
  const getOrder = (id) => store.getState().orders.openOrders.find(o => o.id === id);

  beforeEach(() => {
    store = createStore();
  });

  it('adds new orders with the provided fields', () => {
    store.dispatch(actions.mergeOrders([
      { id: '1', status: 'open', quantity: 10 }
    ]));

    const order = getOrder('1');
    expect(order).toEqual({ id: '1', status: 'open', quantity: 10 });
  });

  it('adds payload orders that are absent from state without disturbing existing ones', () => {
    store.dispatch(actions.mergeOrders([
      { id: '1', status: 'open', quantity: 10, commission: 0.5, limit: 100 }
    ]));

    store.dispatch(actions.mergeOrders([
      { id: '1', quantity: 7 },
      { id: '2', status: 'open', quantity: 3, commission: 0.25 }
    ]));

    const openOrders = store.getState().orders.openOrders;
    expect(openOrders).toHaveLength(2);
    expect(getOrder('1')).toEqual({ id: '1', status: 'open', quantity: 7, commission: 0.5, limit: 100 });
    expect(getOrder('2')).toEqual({ id: '2', status: 'open', quantity: 3, commission: 0.25 });
  });

  it('updates each explicit field on an existing order', () => {
    store.dispatch(actions.mergeOrders([
      { id: '1', status: 'open', quantity: 10, commission: 0.5, limit: 100 }
    ]));

    store.dispatch(actions.mergeOrders([
      { id: '1', status: 'filled', quantity: 7, commission: 1.25, limit: 120 }
    ]));

    const order = getOrder('1');
    expect(order).toEqual({ id: '1', status: 'filled', quantity: 7, commission: 1.25, limit: 120 });
  });

  it('does not remove existing field values when updates omit them', () => {
    store.dispatch(actions.mergeOrders([
      { id: '1', status: 'open', quantity: 10, commission: 0.5, limit: 100 }
    ]));

    store.dispatch(actions.mergeOrders([
      { id: '1', status: 'filled' }
    ]));

    const order = getOrder('1');
    expect(order).toEqual({ id: '1', status: 'filled', quantity: 10, commission: 0.5, limit: 100 });
  });

  it('does not remove orders that are missing from an update payload', () => {
    store.dispatch(actions.mergeOrders([
      { id: '1', status: 'open', quantity: 10 },
      { id: '2', status: 'open', quantity: 5 }
    ]));

    store.dispatch(actions.mergeOrders([
      { id: '1', quantity: 8 }
    ]));

    const openOrders = store.getState().orders.openOrders;
    expect(openOrders).toHaveLength(2);
    expect(getOrder('1')).toEqual({ id: '1', status: 'open', quantity: 8 });
    expect(getOrder('2')).toEqual({ id: '2', status: 'open', quantity: 5 });
  });
});
