import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Provider, useDispatch, useSelector } from 'react-redux';
import './styles.css';
import {
  store, actions,
  makeGridlinesPx, makePasToX,
  selectMarket, selectOrders, selectOptionPasBounds, selectFilteredOptions, selectPriceRange
} from './logic';
import {
  TAG_ROW_H, TAG_HEIGHT, layoutTagsGrouped,
  priceColor, clamp
} from './util';
import broker from './broker';

function useResizeObserver() {
  const ref = useRef(null);
  const [rect, setRect] = useState({ width: 1, height: 1 });
  useEffect(() => {
    if (!ref.current) return;
    const obs = new (window.ResizeObserver || class { constructor(cb){ this.cb=cb; } observe(){ const r=ref.current.getBoundingClientRect(); this.cb([{contentRect:r}]); } disconnect(){} })(entries => {
      const r = entries[0].contentRect;
      setRect({ width: r.width || 1, height: r.height || 1 });
    });
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, []);
  return [ref, rect];
}

/** === Header === */
function Header() {
  const price = useSelector(s => selectMarket(s).price);
  const cash = useSelector(s => selectOrders(s).availableCash);
  const symbol = useSelector(s => selectMarket(s).symbol);
  const dispatch = useDispatch();
  const [sym, setSym] = useState(symbol);
  useEffect(() => setSym(symbol), [symbol]);

  const [remaining, setRemaining] = useState('--:--:--');
  useEffect(() => {
    const id = setInterval(() => {
      const now = new Date();
      const close = new Date(); close.setHours(16, 0, 0, 0);
      const diff = Math.max(0, close - now);
      const h = String(Math.floor(diff / 3_600_000)).padStart(2, '0');
      const m = String(Math.floor((diff % 3_600_000) / 60_000)).padStart(2, '0');
      const s = String(Math.floor((diff % 60_000) / 1000)).padStart(2, '0');
      setRemaining(`${h}:${m}:${s}`);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="hdr">
      <div className="pill">Acct …0757 · Margin</div>
      <button className="pill" onClick={() => alert('Settings (v0 placeholder)')}>⚙️ Settings</button>
      <input value={sym} onChange={e => setSym(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') dispatch(actions.setSymbol(sym)); }} placeholder="Symbol" />
      <div className="spacer" />
      <div className="pill">${price.toFixed(2)}</div>
      <div className="pill">${cash.toLocaleString()} cash</div>
      <div className="pill">{remaining}</div>
    </div>
  );
}

/** === Price Axis (dynamic height, stacked tags, guidelines from tag bottom) === */
function Tag({ x, text, color, onTrash, top, row }) {
  return (
    <div className={`tag ${color}`} style={{ left: x, top, zIndex: 200 + (row || 0) }}>
      {text} {onTrash && <span className="trash" onClick={onTrash}>🗑️</span>}
    </div>
  );
}

function PriceAxis({ onHeight, axisH }) {
  const dispatch = useDispatch();
  const [ref, { width }] = useResizeObserver();
  const gridSel = useMemo(makeGridlinesPx, []);
  const { values, toPx } = useSelector(s => gridSel(s, width));
  const pasSel = useMemo(makePasToX, []);
  const pas2x = useSelector(s => pasSel(s, width));

  const bounds = useSelector(selectOptionPasBounds);
  const price = useSelector(s => selectMarket(s).price);
  const hist = useSelector(s => selectMarket(s).history);
  const prev = hist.length > 1 ? hist[hist.length - 2].p : (hist[0]?.p ?? null);
  const pClr = priceColor(price, prev);

  const prov = useSelector(s => selectOrders(s).provisional);
  const openOrders = useSelector(s => selectOrders(s).openOrders);

  async function cancel(id) {
    const res = await broker.cancelOrder(id);
    if (res?.ok) dispatch(actions.removeOpenOrder(id));
    else alert('Cancel failed (mock)');
  }

  const group0 = [];
  if (bounds.min != null) group0.push({ key: 'min', x: pas2x(bounds.min), text: `$${bounds.min}`, color: 'white' });
  if (bounds.max != null) group0.push({ key: 'max', x: pas2x(bounds.max), text: `$${bounds.max}`, color: 'white' });

  const group1 = [{ key: 'm', x: pas2x(price), text: `$${price.toFixed(2)}`, color: pClr }];

  const group2 = [];
  openOrders.forEach(o => group2.push({ key: 'o-' + o.id, x: pas2x(o.pas), text: `${o.qty} × $${o.pas.toFixed(2)}`, color: 'yellow', onTrash: () => cancel(o.id) }));
  if (prov) group2.push({ key: 'p', x: pas2x(prov.pas), text: `${prov.qty} × $${prov.pas.toFixed(2)}`, color: 'blue' });

  const { placed: tags, totalRows } = layoutTagsGrouped([group0, group1, group2], width);
  const needH = Math.max(56, 6 + totalRows * TAG_ROW_H + 6);
  useEffect(() => { if (onHeight && needH !== axisH) onHeight(needH); }, [needH, axisH, onHeight]);

  return (
    <div className="axis" ref={ref} style={{ height: axisH }}>
      {values.map(v => (
        <React.Fragment key={v}>
          <div className="gridline" style={{ left: toPx(v) }} />
          <div className="label" style={{ left: toPx(v) }}>${v}</div>
        </React.Fragment>
      ))}
      {tags.map(t => (
        <div key={t.key + '-g'} className="tagGuide"
          style={{ left: t.x, top: (t.top + TAG_HEIGHT), background: (t.color === 'yellow' ? '#e6cc00' : t.color === 'blue' ? '#3b82f6' : t.color === 'green' ? '#22c55e' : t.color === 'red' ? '#ff5454' : '#e5e7eb'), zIndex: 200 + t.row }} />
      ))}
      {tags.map(t => <Tag key={t.key} {...t} />)}
    </div>
  );
}

/** === Historical Chart (SVG) === */
function HistoricalChart() {
  const [ref, { width, height }] = useResizeObserver();
  const pasSel = useMemo(makePasToX, []);
  const x = useSelector(s => pasSel(s, width));
  const gridSel = useMemo(makeGridlinesPx, []);
  const { values, toPx } = useSelector(s => gridSel(s, width));

  const history = useSelector(s => selectMarket(s).history);
  const latestTs = useSelector(s => selectMarket(s).lastTs);
  const windowMin = useSelector(s => s.settings.timeWindowMin);
  const minTs = latestTs - windowMin * 60 * 1000;
  const pts = history.filter(h => h.t >= minTs);

  const y = (t) => height - ((t - minTs) / (windowMin * 60 * 1000)) * height;
  const path = pts.map((p, i) => `${i ? 'L' : 'M'} ${x(p.p)} ${y(p.t)}`).join(' ');

  const bounds = useSelector(selectOptionPasBounds);
  const price = useSelector(s => selectMarket(s).price);
  const openOrders = useSelector(s => selectOrders(s).openOrders);
  const prov = useSelector(s => selectOrders(s).provisional);

  return (
    <div className="chart" ref={ref}>
      <svg width={width} height={height}>
        {values.map(v => <line key={v} x1={toPx(v)} x2={toPx(v)} y1="0" y2={height} stroke="#1a1a1a" strokeWidth="1" />)}
        {bounds.min != null && <line x1={x(bounds.min)} x2={x(bounds.min)} y1="0" y2={height} stroke="#777" strokeWidth="2" />}
        {bounds.max != null && <line x1={x(bounds.max)} x2={x(bounds.max)} y1="0" y2={height} stroke="#777" strokeWidth="2" />}
        <line x1={x(price)} x2={x(price)} y1="0" y2={height} stroke="#ff5454" strokeWidth="2" />
        {openOrders.map(o => <line key={o.id} x1={x(o.pas)} x2={x(o.pas)} y1="0" y2={height} stroke="#e6cc00" strokeWidth="3" />)}
        {prov && <line x1={x(prov.pas)} x2={x(prov.pas)} y1="0" y2={height} stroke="#3b82f6" strokeWidth="3" />}
        <path d={path} fill="none" stroke="#e5e7eb" strokeWidth="2" />
      </svg>
    </div>
  );
}

/** === Options list === */
function OptionsList() {
  const [ref, { width, height }] = useResizeObserver();
  const options = useSelector(selectFilteredOptions);
  const pasSel = useMemo(makePasToX, []);
  const x = useSelector(s => pasSel(s, width));
  const gridSel = useMemo(makeGridlinesPx, []);
  const { values, toPx } = useSelector(s => gridSel(s, width));
  const bounds = useSelector(selectOptionPasBounds);
  const openOrders = useSelector(s => selectOrders(s).openOrders);
  const prov = useSelector(s => selectOrders(s).provisional);
  const dispatch = useDispatch();

  function beginDrag(option, e) {
    e.preventDefault();
    const rect = ref.current.getBoundingClientRect();
    const startY = e.clientY; const startQty = 1;
    const getPas = (clientX) => {
      const localX = clientX - rect.left;
      const s = store.getState(); const r = selectPriceRange(s); const span = r.max - r.min;
      return Math.round((r.min + (localX / Math.max(1, width)) * span) * 100) / 100;
    };
    const startPas = clamp(getPas(e.clientX), option.askPAS, option.bidPAS);
    const p = { id: `prov-${Date.now()}`, optionId: option.id, limitPrice: option.askPremium, pas: startPas, qty: startQty, strike: option.strike };
    dispatch(actions.setProvisional(p));

    function mm(ev) {
      const dy = ev.clientY - startY;
      const deltaQty = Math.floor(-dy / (height * 0.05));
      const qty = Math.max(1, startQty + deltaQty);
      const pas = clamp(getPas(ev.clientX), option.askPAS, option.bidPAS);
      dispatch(actions.setProvisional({ ...p, qty, pas }));
    }
    function up() { window.removeEventListener('mousemove', mm); window.removeEventListener('mouseup', up); dispatch(actions.commitProvisional(option)); }
    window.addEventListener('mousemove', mm); window.addEventListener('mouseup', up);
  }

  const price = useSelector(s => selectMarket(s).price);

  return (
    <div className="opts" ref={ref}>
      {values.map(v => <div key={v} className="axisline" style={{ left: toPx(v) }} />)}
      <div className="guideline minmax" style={{ left: x(bounds.min || 0) }} />
      <div className="guideline minmax" style={{ left: x(bounds.max || 0) }} />
      <div className="guideline market" style={{ left: x(price) }} />
      <div style={{ position: 'relative', height: options.length * 42 + 20 }}>
        {openOrders.map(oo => <div key={'f-open-' + oo.id} className="orderGuideFull" style={{ left: x(oo.pas), background: '#e6cc00' }} />)}
        {prov && <div className="orderGuideFull" style={{ left: x(prov.pas), background: '#3b82f6' }} />}
        {options.map((o, idx) => {
          const left = x(o.askPAS), right = x(o.bidPAS), w = Math.max(2, right - left);
          const depth = Math.max(0, Math.min(1, o.bidSize / 24)); const bg = Math.floor(18 + depth * 70);
          const top = idx * 42 + 14;
          return (
            <div key={o.id} className="optRow" style={{ top }}>
              <div className="optBox" style={{ left, width: w, top: 4, background: `rgb(${bg},${bg},${bg})` }}
                title={`AskPAS:${o.askPAS}  BidPAS:${o.bidPAS}`}
                onMouseDown={(e) => beginDrag(o, e)} />
              {openOrders.filter(oo => oo.optionId === o.id).map(oo => <div key={'g-open-' + oo.id} className="orderGuide" style={{ left: x(oo.pas), background: '#e6cc00' }} />)}
              {(prov && prov.optionId === o.id) && <div className="orderGuide" style={{ left: x(prov.pas), background: '#3b82f6' }} />}
              <div className="optText">Prob ITM: {o.probITM}%, Bid Size: {o.bidSize}, Strike: ${o.strike.toFixed(2)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** === Price Axis Controller === */
function PriceAxisController() {
  const dispatch = useDispatch();
  const [ref, { width }] = useResizeObserver();
  const fixed = useSelector(s => selectMarket(s).fixedRange);
  const vp = useSelector(s => selectMarket(s).priceRange);
  const toPx = (v) => ((v - fixed.min) / Math.max(1, fixed.max - fixed.min)) * (width || 1);
  const fromPx = (px) => fixed.min + ((px / (width || 1)) * (fixed.max - fixed.min));
  const [drag, setDrag] = useState(null);
  const left = toPx(vp.min), right = toPx(vp.max); const vw = Math.max(20, right - left);

  function onDown(e, which) { e.preventDefault(); setDrag({ which, startX: e.clientX, left, right }); }
  function onMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    if (drag.which === 'move') {
      let nl = clamp(drag.left + dx, 0, (width || 1) - vw), nr = nl + vw;
      dispatch(actions.setPriceViewport({ min: Math.round(fromPx(nl) * 100) / 100, max: Math.round(fromPx(nr) * 100) / 100 }));
    } else if (drag.which === 'left') {
      let nl = clamp(drag.left + dx, 0, right - 20);
      dispatch(actions.setPriceViewport({ min: Math.round(fromPx(nl) * 100) / 100, max: vp.max }));
    } else if (drag.which === 'right') {
      let nr = clamp(drag.right + dx, left + 20, (width || 1));
      dispatch(actions.setPriceViewport({ min: vp.min, max: Math.round(fromPx(nr) * 100) / 100 }));
    }
  }
  function onUp() { setDrag(null); }
  useEffect(() => {
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [drag, vp, width]);

  return (
    <div className="bottom">
      <div className="pac" ref={ref}>
        <div className="viewport" style={{ left, width: vw }} onMouseDown={(e) => onDown(e, 'move')}>
          <div className="handle" style={{ left: -6 }} onMouseDown={(e) => onDown(e, 'left')}></div>
          <div className="handle" style={{ right: -6 }} onMouseDown={(e) => onDown(e, 'right')}></div>
        </div>
      </div>
    </div>
  );
}

/** === SplitView (fixed options height; chart flex) === */
function SplitView({ topOffset }) {
  const [optsH, setOptsH] = useState(220);
  return (
    <div className="split" style={{ top: topOffset }}>
      <div className="pane" style={{ flex: 1 }}><HistoricalChart /></div>
      <div className="divider" onMouseDown={(e) => {
        e.preventDefault();
        const container = e.currentTarget.parentElement;
        const startY = e.clientY;
        const startH = e.currentTarget.nextSibling.getBoundingClientRect().height;
        const containerH = container.getBoundingClientRect().height;
        const dividerH = e.currentTarget.getBoundingClientRect().height || 8;
        const MIN_CHART = 100, MIN_OPT = 120;
        function mm(ev) {
          const dy = ev.clientY - startY;
          let newH = startH - dy;
          const maxH = Math.max(MIN_OPT, containerH - MIN_CHART - dividerH);
          newH = clamp(newH, MIN_OPT, maxH);
          setOptsH(newH);
        }
        function up() { window.removeEventListener('mousemove', mm); window.removeEventListener('mouseup', up); }
        window.addEventListener('mousemove', mm); window.addEventListener('mouseup', up);
      }} />
      <div className="pane" style={{ height: optsH }}><OptionsList /></div>
    </div>
  );
}

/** === Root / bootstrap === */
function RootApp() {
  const [axisH, setAxisH] = useState(56);
  const dispatch = useDispatch();
  useEffect(() => {
    const off = broker.onUpdate(u => dispatch(actions.streamUpdate(u)));
    broker.start();
    const init = setTimeout(() => dispatch(actions.initRanges()), 700);
    return () => { off(); broker.stop(); clearTimeout(init); };
  }, [dispatch]);

  return (
    <div className="app">
      <Header />
      <PriceAxis axisH={axisH} onHeight={setAxisH} />
      <SplitView topOffset={44 + axisH} />
      <PriceAxisController />
    </div>
  );
}

export default function App() {
  return <Provider store={store}><RootApp /></Provider>;
}
