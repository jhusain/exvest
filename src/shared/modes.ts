import type { TradingMode } from './types';

export interface ModeInfo {
  mode: TradingMode;
  label: string;
  borderClass: string;
  /** IB `order.transmit` value orders should be placed with in this mode. */
  transmit: boolean;
  /** Whether the first order of the session needs an explicit confirmation modal. */
  requiresLiveConfirmModal: boolean;
}

export const MODE_INFO: Record<TradingMode, ModeInfo> = {
  'sim-client': {
    mode: 'sim-client',
    label: 'SIM',
    borderClass: '',
    transmit: true,
    requiresLiveConfirmModal: false
  },
  'ib-paper': {
    mode: 'ib-paper',
    label: 'PAPER',
    borderClass: 'mode-paper',
    transmit: true,
    requiresLiveConfirmModal: false
  },
  'ib-live-confirm': {
    mode: 'ib-live-confirm',
    label: 'LIVE · CONFIRM',
    borderClass: 'mode-live-confirm',
    transmit: false,
    requiresLiveConfirmModal: false
  },
  'ib-live': {
    mode: 'ib-live',
    label: 'LIVE',
    borderClass: 'mode-live',
    transmit: true,
    requiresLiveConfirmModal: true
  }
};

/** Parses Electron CLI args into the requested trading mode (pre-connect; connect failures fall back to sim-client). */
export function modeFromArgv(argv: string[]): Exclude<TradingMode, 'sim-client'> | 'ib-paper' {
  if (argv.includes('--live-noconfirm')) return 'ib-live';
  if (argv.includes('--live')) return 'ib-live-confirm';
  return 'ib-paper';
}

/** Default IB Gateway/TWS ports; override via EXVEST_IB_PORT. */
export function defaultIbPort(mode: TradingMode): number {
  switch (mode) {
    case 'ib-live-confirm':
    case 'ib-live':
      return 4001; // IB Gateway live
    case 'ib-paper':
    default:
      return 4002; // IB Gateway paper
  }
}
