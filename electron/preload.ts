import { contextBridge, ipcRenderer } from 'electron';
import type { ExvestBridge } from '../src/shared/preloadApi';
import type { BrokerEvent } from '../src/shared/types';

const EVENT_CHANNELS: Record<BrokerEvent, string> = {
  underlyingTick: 'exvest:event:underlyingTick',
  optionQuotes: 'exvest:event:optionQuotes',
  orderUpdate: 'exvest:event:orderUpdate',
  accountUpdate: 'exvest:event:accountUpdate',
  connectionStatus: 'exvest:event:connectionStatus',
  error: 'exvest:event:error'
};

const bridge: ExvestBridge = {
  connect: () => ipcRenderer.invoke('exvest:connect'),
  disconnect: () => ipcRenderer.invoke('exvest:disconnect'),
  setUnderlying: (symbol) => ipcRenderer.invoke('exvest:setUnderlying', symbol),
  subscribeMarketData: () => ipcRenderer.send('exvest:subscribeMarketData'),
  unsubscribeMarketData: () => ipcRenderer.send('exvest:unsubscribeMarketData'),
  placeOrder: (req) => ipcRenderer.invoke('exvest:placeOrder', req),
  transmitOrder: (orderId) => ipcRenderer.invoke('exvest:transmitOrder', orderId),
  cancelOrder: (orderId) => ipcRenderer.invoke('exvest:cancelOrder', orderId),
  getAccountSummary: () => ipcRenderer.invoke('exvest:getAccountSummary'),
  on(event, fn) {
    const channel = EVENT_CHANNELS[event];
    const listener = (_e: Electron.IpcRendererEvent, payload: unknown) => fn(payload as never);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  }
};

contextBridge.exposeInMainWorld('exvest', bridge);
