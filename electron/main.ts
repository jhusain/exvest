import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { IbBrokerAdapter } from '../src/broker/IbBrokerAdapter';
import { modeFromArgv, defaultIbPort } from '../src/shared/modes';
import { createLogger } from '../src/shared/log';
import type { ConnectionInfo, TradingMode } from '../src/shared/types';

const log = createLogger('main');

// EXVEST_MODE lets `npm run electron:dev` (which can't pass CLI flags through
// to the auto-spawned dev Electron process) select a mode for local testing;
// the packaged app is driven by --live / --live-noconfirm as specified.
const modeOverride = process.env.EXVEST_MODE as TradingMode | undefined;
const mode: TradingMode = modeOverride ?? modeFromArgv(process.argv.slice(1));
const host = process.env.EXVEST_IB_HOST || '127.0.0.1';
const port = Number(process.env.EXVEST_IB_PORT) || defaultIbPort(mode);
const clientId = Number(process.env.EXVEST_IB_CLIENT_ID) || 7;

log.info(
  `starting: mode=${mode} host=${host} port=${port} clientId=${clientId}` +
    (modeOverride ? ' (mode from EXVEST_MODE)' : '') +
    (process.env.EXVEST_IB_PORT ? ' (port from EXVEST_IB_PORT)' : ` (default port for ${mode})`)
);

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
  adapter.on('orderUpdate', (p) => {
    log.info(`-> renderer orderUpdate ${p.id}: ${p.status} (filled ${p.filled}/${p.filled + p.remaining})`);
    broadcast('exvest:event:orderUpdate', p);
  });
  adapter.on('accountUpdate', (p) => broadcast('exvest:event:accountUpdate', p));
  adapter.on('connectionStatus', (p) => {
    log.info(`connectionStatus: connected=${p.connected}${p.reason ? ` reason="${p.reason}"` : ''}`);
    connectionInfo = p;
    broadcast('exvest:event:connectionStatus', p);
  });
  adapter.on('error', (p) => {
    log.error(`adapter error${p.code ? ` (${p.code})` : ''}: ${p.message}`);
    broadcast('exvest:event:error', p);
  });
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

  // Renderer console output otherwise only exists in DevTools; mirror it into
  // the terminal so `npm run electron:dev` shows main and renderer together.
  const rendererLog = createLogger('renderer');
  mainWindow.webContents.on('console-message', ({ level, message, lineNumber, sourceId }) => {
    const where = sourceId ? ` (${sourceId}:${lineNumber})` : '';
    if (level === 'error') rendererLog.error(`${message}${where}`);
    else if (level === 'warning') rendererLog.warn(`${message}${where}`);
    else rendererLog.info(message);
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
ipcMain.handle('exvest:transmitOrder', (_e, orderId: string) => adapter.transmitOrder(orderId));
ipcMain.handle('exvest:cancelOrder', (_e, orderId: string) => adapter.cancelOrder(orderId));
ipcMain.handle('exvest:getAccountSummary', () => adapter.getAccountSummary());

app.whenReady().then(async () => {
  wireForwarding();
  // Attempted once, at launch. A failure here is what the renderer's
  // createBroker() interprets as "fall back to the client-side simulator".
  connectionInfo = await adapter.connect();
  if (connectionInfo.connected) {
    log.info(`IB connected — running in ${mode}`);
  } else {
    log.warn(
      `IB unavailable (${connectionInfo.reason ?? 'unknown reason'}) — the renderer will fall back to the client-side simulator (sim-client)`
    );
  }
  await createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
