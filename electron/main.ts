import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IbBrokerAdapter } from '../src/broker/IbBrokerAdapter';
import { modeFromArgv, defaultIbPort } from '../src/shared/modes';
import type { ConnectionInfo, TradingMode } from '../src/shared/types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// EXVEST_MODE lets `npm run electron:dev` (which can't pass CLI flags through
// to the auto-spawned dev Electron process) select a mode for local testing;
// the packaged app is driven by --live / --live-noconfirm as specified.
const modeOverride = process.env.EXVEST_MODE as TradingMode | undefined;
const mode: TradingMode = modeOverride ?? modeFromArgv(process.argv.slice(1));
const host = process.env.EXVEST_IB_HOST || '127.0.0.1';
const port = Number(process.env.EXVEST_IB_PORT) || defaultIbPort(mode);
const clientId = Number(process.env.EXVEST_IB_CLIENT_ID) || 7;

const adapter = new IbBrokerAdapter({ host, port, clientId, mode });

// Populated once app.whenReady() attempts adapter.connect(); the renderer's
// 'exvest:connect' IPC call just reads this, it never re-attempts the socket.
let connectionInfo: ConnectionInfo = { mode: 'sim-client', connected: false, accountId: null };

let mainWindow: BrowserWindow | null = null;

function broadcast(channel: string, payload: unknown) {
  mainWindow?.webContents.send(channel, payload);
}

function wireForwarding() {
  adapter.on('underlyingTick', (p) => broadcast('exvest:event:underlyingTick', p));
  adapter.on('optionQuotes', (p) => broadcast('exvest:event:optionQuotes', p));
  adapter.on('orderUpdate', (p) => broadcast('exvest:event:orderUpdate', p));
  adapter.on('accountUpdate', (p) => broadcast('exvest:event:accountUpdate', p));
  adapter.on('connectionStatus', (p) => {
    connectionInfo = p;
    broadcast('exvest:event:connectionStatus', p);
  });
  adapter.on('error', (p) => broadcast('exvest:event:error', p));
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

ipcMain.handle('exvest:connect', async () => connectionInfo);
ipcMain.handle('exvest:disconnect', () => adapter.disconnect());
ipcMain.handle('exvest:setUnderlying', (_e, symbol: string) => adapter.setUnderlying(symbol));
ipcMain.on('exvest:subscribeMarketData', () => adapter.subscribeMarketData());
ipcMain.on('exvest:unsubscribeMarketData', () => adapter.unsubscribeMarketData());
ipcMain.handle('exvest:placeOrder', (_e, req) => adapter.placeOrder(req));
ipcMain.handle('exvest:cancelOrder', (_e, orderId: string) => adapter.cancelOrder(orderId));
ipcMain.handle('exvest:getAccountSummary', () => adapter.getAccountSummary());

app.whenReady().then(async () => {
  wireForwarding();
  // Attempted once, at launch. A failure here is what the renderer's
  // createBroker() interprets as "fall back to the client-side simulator".
  connectionInfo = await adapter.connect();
  await createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
