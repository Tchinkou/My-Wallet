/**
 * My Wallet — graphiques SVG légers (aucune bibliothèque).
 *   - lineChart : évolution de l'argent disponible (crosshair + info-bulle)
 *   - barChart  : revenus vs dépenses par mois (info-bulle par barre)
 *   - meterList : répartition des dépenses par catégorie
 */

import { money, moneyShort, monthLabel, dateLabel, esc } from './ui.js';

const registry = new Map();
let seq = 0;

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * p;
}

/* ------------------------------------------------------------- courbe */

export function lineChart(points, { label = 'Disponible' } = {}) {
  const id = `ch${++seq}`;
  const W = 340, H = 150, padL = 4, padR = 4, padT = 14, padB = 22;
  const vals = points.map((p) => p.value);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (min === max) { min -= Math.abs(min) * 0.1 || 100; max += Math.abs(max) * 0.1 || 100; }
  const span = max - min;
  min -= span * 0.12; max += span * 0.08;
  const x = (i) => padL + (i * (W - padL - padR)) / Math.max(1, points.length - 1);
  const y = (v) => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const area = `${d}L${x(points.length - 1).toFixed(1)},${H - padB}L${x(0).toFixed(1)},${H - padB}Z`;
  const last = points[points.length - 1];
  registry.set(id, { type: 'line', points, x, y, W, H, padT, padB, label });
  const ticks = [0, Math.floor((points.length - 1) / 2), points.length - 1];
  return `
  <div class="chart" data-chart="${id}">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)} sur ${points.length} jours">
      <defs><linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--accent)" stop-opacity=".28"/>
        <stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
      <line x1="0" x2="${W}" y1="${H - padB}" y2="${H - padB}" class="axis"/>
      <path d="${area}" fill="url(#${id}g)"/>
      <path d="${d}" class="line" fill="none"/>
      <circle cx="${x(points.length - 1)}" cy="${y(last.value)}" r="4" class="dot"/>
      ${ticks.map((i) => `<text x="${x(i)}" y="${H - 6}" class="tick" text-anchor="${i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}">${esc(dateLabel(points[i].date, { withYear: false }))}</text>`).join('')}
      <g class="cross" visibility="hidden"><line y1="${padT}" y2="${H - padB}" class="cross-line"/><circle r="4.5" class="cross-dot"/></g>
    </svg>
    <div class="chart-tip" hidden></div>
  </div>`;
}

/* ------------------------------------------------------------- barres */

export function barChart(months) {
  const id = `ch${++seq}`;
  const W = 340, H = 170, padT = 12, padB = 24, padL = 34;
  const max = niceMax(Math.max(1, ...months.flatMap((m) => [m.income, m.expense])));
  const slot = (W - padL) / months.length;
  const bw = Math.min(16, slot / 2 - 5);
  const y = (v) => padT + (1 - v / max) * (H - padT - padB);
  const base = H - padB;
  const bar = (cx, v, cls, i, kind) => {
    const top = y(v), h = Math.max(0, base - top);
    if (h < 0.5) return '';
    const r = Math.min(4, h);
    return `<path class="${cls}" data-i="${i}" data-k="${kind}" d="M${cx - bw / 2},${base}V${top + r}q0,-${r} ${r},-${r}h${bw - 2 * r}q${r},0 ${r},${r}V${base}Z"/>`;
  };
  registry.set(id, { type: 'bar', months });
  const grid = [0.5, 1].map((f) => `<line x1="${padL}" x2="${W}" y1="${y(max * f)}" y2="${y(max * f)}" class="grid"/>
    <text x="${padL - 6}" y="${y(max * f) + 4}" class="tick" text-anchor="end">${esc(moneyShort(max * f))}</text>`).join('');
  return `
  <div class="chart" data-chart="${id}">
    <div class="legend"><span><i class="lkey key-income"></i>Revenus</span><span><i class="lkey key-expense"></i>Dépenses</span></div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Revenus et dépenses des ${months.length} derniers mois">
      ${grid}
      <line x1="${padL}" x2="${W}" y1="${base}" y2="${base}" class="axis"/>
      ${months.map((m, i) => {
        const cx = padL + slot * i + slot / 2;
        return `<rect class="hit" data-i="${i}" x="${cx - slot / 2}" y="${padT}" width="${slot}" height="${base - padT}"/>
          ${bar(cx - bw / 2 - 1, m.income, 'bar-income', i, 'income')}
          ${bar(cx + bw / 2 + 1, m.expense, 'bar-expense', i, 'expense')}
          <text x="${cx}" y="${H - 7}" class="tick" text-anchor="middle">${esc(monthLabel(m.month, true))}</text>`;
      }).join('')}
    </svg>
    <div class="chart-tip" hidden></div>
  </div>`;
}

/* --------------------------------------------- répartition par catégorie */

export function meterList(items, total, maxRows = 6) {
  if (!items.length) return '<p class="empty-sm">Aucune dépense ce mois-ci.</p>';
  let rows = items;
  if (items.length > maxRows) {
    const rest = items.slice(maxRows - 1).reduce((t, c) => t + c.amount, 0);
    rows = [...items.slice(0, maxRows - 1), { id: '_other', name: 'Autres catégories', amount: rest }];
  }
  const top = rows[0].amount || 1;
  return `<ul class="meters">${rows.map((c) => `
    <li>
      <div class="meter-head"><span class="meter-name">${esc(c.name)}</span>
        <span class="meter-val">${money(c.amount)} <small>${Math.round((c.amount / total) * 100)} %</small></span></div>
      <div class="meter-track"><div class="meter-fill" style="width:${Math.max(2, (c.amount / top) * 100).toFixed(1)}%"></div></div>
    </li>`).join('')}</ul>`;
}

/* ------------------------------------------------------ interactions */

function setTip(tip, rows, title) {
  tip.replaceChildren();
  const t = document.createElement('div');
  t.className = 'tip-title';
  t.textContent = title;
  tip.appendChild(t);
  for (const [cls, value, name] of rows) {
    const r = document.createElement('div');
    r.className = 'tip-row';
    const k = document.createElement('i'); k.className = `tip-key ${cls}`;
    const v = document.createElement('b'); v.textContent = value;
    const n = document.createElement('span'); n.textContent = name;
    r.append(k, v, n);
    tip.appendChild(r);
  }
  tip.hidden = false;
}

function placeTip(container, tip, clientX) {
  const box = container.getBoundingClientRect();
  const w = tip.offsetWidth;
  let left = clientX - box.left - w / 2;
  left = Math.max(0, Math.min(box.width - w, left));
  tip.style.left = `${left}px`;
}

/** Active les info-bulles sur tous les graphiques du conteneur. */
export function attachCharts(root) {
  root.querySelectorAll('[data-chart]').forEach((el) => {
    const cfg = registry.get(el.dataset.chart);
    if (!cfg) return;
    const svg = el.querySelector('svg');
    const tip = el.querySelector('.chart-tip');
    const hide = () => {
      tip.hidden = true;
      el.querySelector('.cross')?.setAttribute('visibility', 'hidden');
      el.querySelectorAll('.lift').forEach((n) => n.classList.remove('lift'));
    };
    if (cfg.type === 'line') {
      const cross = el.querySelector('.cross');
      const move = (e) => {
        const r = svg.getBoundingClientRect();
        const fx = ((e.clientX - r.left) / r.width) * cfg.W;
        const n = cfg.points.length;
        let i = Math.round(((fx - 4) / (cfg.W - 8)) * (n - 1));
        i = Math.max(0, Math.min(n - 1, i));
        const p = cfg.points[i];
        const cx = cfg.x(i), cy = cfg.y(p.value);
        cross.setAttribute('visibility', 'visible');
        cross.querySelector('line').setAttribute('x1', cx);
        cross.querySelector('line').setAttribute('x2', cx);
        cross.querySelector('circle').setAttribute('cx', cx);
        cross.querySelector('circle').setAttribute('cy', cy);
        setTip(tip, [['key-line', money(p.value), cfg.label]], dateLabel(p.date));
        placeTip(el, tip, r.left + (cx / cfg.W) * r.width);
      };
      svg.addEventListener('pointermove', move);
      svg.addEventListener('pointerdown', move);
      svg.addEventListener('pointerleave', hide);
    } else if (cfg.type === 'bar') {
      const show = (e) => {
        const t = e.target.closest('[data-i]');
        if (!t) return;
        const i = Number(t.dataset.i);
        const m = cfg.months[i];
        el.querySelectorAll('.lift').forEach((n) => n.classList.remove('lift'));
        el.querySelectorAll(`path[data-i="${i}"]`).forEach((n) => n.classList.add('lift'));
        setTip(tip, [
          ['key-income', money(m.income), 'Revenus'],
          ['key-expense', money(m.expense), 'Dépenses'],
          ['key-net', money(m.income - m.expense, { sign: true }), 'Solde'],
        ], monthLabel(m.month));
        const r = t.getBoundingClientRect();
        placeTip(el, tip, r.left + r.width / 2);
      };
      svg.addEventListener('pointermove', show);
      svg.addEventListener('pointerdown', show);
      svg.addEventListener('pointerleave', hide);
    }
  });
}

export function resetCharts() { registry.clear(); }
