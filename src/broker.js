/** Brokerage logic and mock data utilities */
import { clamp } from './util';

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Perlin1D {
  constructor(seed = 1) {
    this.rand = mulberry32(seed);
    this.grad = [...Array(512)].map(() => this.rand() * 2 - 1);
  }
  fade(t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }
  lerp(a, b, t) {
    return a + (b - a) * t;
  }
  noise(x) {
    const X = Math.floor(x) & 255;
    const xf = x - Math.floor(x);
    const g0 = this.grad[X];
    const g1 = this.grad[(X + 1) & 255];
    const u = this.fade(xf);
    return this.lerp(g0 * xf, g1 * (xf - 1), u);
  }
}

function mkBroker(seed = 42) {
  const noise = new Perlin1D(seed);
  let t = 0,
    base = 100,
    vol = 1.2;
  const listeners = new Set();
  const orders = new Map();

  function tick() {
    t += 0.05;
    base = base + noise.noise(t) * 0.35;
    const price = clamp(base + noise.noise(t * 0.25) * vol, 5, 2000);
    const now = Date.now();
    const opts = synthOptions(price, now);
    listeners.forEach((fn) => fn({ price, now, options: opts }));
  }
  let h = null;

  return {
    start() {
      if (!h) {
        h = setInterval(tick, 600);
        tick();
      }
    },
    stop() {
      if (h) {
        clearInterval(h);
        h = null;
      }
    },
    onUpdate(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async openOrder({ option, limitPrice, qty }) {
      const spread = Math.max(0.01, option.bidPremium - option.askPremium);
      const closeness = clamp(1 - (option.bidPremium - limitPrice) / spread, 0, 1);
      const sizeFactor = clamp(option.bidSize / 50, 0, 1);
      const p = 0.15 + 0.6 * closeness + 0.25 * sizeFactor;
      await new Promise((r) => setTimeout(r, 350 + Math.random() * 500));
      if (Math.random() >= p) return { ok: false };
      const orderId = `ORD-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      orders.set(orderId, { option, limitPrice, qty, created: Date.now() });
      return { ok: true, orderId };
    },
    async cancelOrder(orderId) {
      await new Promise((r) => setTimeout(r, 250 + Math.random() * 400));
      if (!orders.has(orderId)) return { ok: false, reason: 'not_found' };
      const ok = Math.random() < 0.95;
      if (ok) orders.delete(orderId);
      return { ok };
    }
  };
}

function synthOptions(under, now) {
  const MIN_PREMIUM_SPREAD = 7;
  const arr = [];
  const startStrike = Math.ceil(under * 1.01);
  const perlinOpt = new Perlin1D(9001);
  const round2 = (n) => Math.round(n * 100) / 100;
  for (let i = 0; i < 12; i++) {
    const strike = startStrike + i;
    const intrinsic = Math.max(0, strike - under);
    const timeExtr = clamp(0.35 + i / 12, 0.1, 3.0);
    const n = perlinOpt.noise(now * 0.0008 + i * 0.2);
    let askPremium = intrinsic + 0.1 + timeExtr * 0.5 + n * 0.15;
    if (askPremium < MIN_PREMIUM_SPREAD + 0.01) askPremium = MIN_PREMIUM_SPREAD + 0.01;
    let bidPremium = askPremium - (0.05 + 0.15 * Math.exp(-i / 3)) + n * 0.05;
    if (askPremium - bidPremium < MIN_PREMIUM_SPREAD) bidPremium = askPremium - MIN_PREMIUM_SPREAD;
    askPremium = clamp(askPremium, 0.05, 1000);
    bidPremium = clamp(bidPremium, 0.01, askPremium - 0.01);
    const bidSize = Math.max(1, Math.round((12 - i) * (0.5 + Math.random())));
    const depth = (strike - under) / Math.max(under * 0.01, 0.5);
    const sigmoid = 1 / (1 + Math.exp(-0.6 * depth));
    const probITM = clamp(0.65 + 0.35 * sigmoid + 0.05 * (bidSize / 20), 0.5, 0.995);
    arr.push({
      id: `put-${strike}`,
      strike,
      bidSize,
      probITM: Math.round(probITM * 100),
      askPremium: round2(askPremium),
      bidPremium: round2(bidPremium)
    });
  }
  return arr;
}

/** expose single broker instance */
const broker = mkBroker(1337);
export default broker;

