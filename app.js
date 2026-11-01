(() => {
'use strict';

const CFG = window.LEDGER_CONFIG || {};
const CLOUD = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);

const KEY = 'ledger.v1';
const BASE_EXPENSE_CATS = ['Food','Housing','Transport','Bills','Health','Fun','Shopping','Other'];
const INCOME_CATS  = ['Salary','Side income','Gift','Other'];

const DEFAULT_AVATAR_EMOJIS = [
  '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', 
  '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', 
  '🐧', '🐦', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗', 
  '🐴', '🦄', '🐝', '🐛', '🦋', '🐢'
];

const CAT_COLORS = {
  'Food':      'var(--c-food)',
  'Housing':   'var(--c-housing)',
  'Transport': 'var(--c-transport)',
  'Bills':     'var(--c-bills)',
  'Health':    'var(--c-health)',
  'Fun':       'var(--c-fun)',
  'Shopping':  'var(--c-shopping)',
  'Other':     'var(--c-other)'
};

const DYNAMIC_PALETTE = [
  '#f59e0b', '#10b981', '#6366f1', '#ec4899', '#8b5cf6', 
  '#14b8a6', '#f43f5e', '#3b82f6', '#84cc16', '#a855f7'
];

function getCategoryColor(catName) {
  if (CAT_COLORS[catName]) return CAT_COLORS[catName];
  let hash = 0;
  for (let i = 0; i < catName.length; i++) {
    hash = catName.charCodeAt(i) + ((hash << 5) - hash);
  }
  const idx = Math.abs(hash) % DYNAMIC_PALETTE.length;
  return DYNAMIC_PALETTE[idx];
}

const METHOD_LABEL = { cash: 'Cash', debit: 'Debit card', card: 'Credit card' };
const PAGES = ['home','expenses','split','settings'];

const $  = id => document.getElementById(id);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = s => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const lsDel = k => { try { localStorage.removeItem(k); } catch {} };

const pad = n => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; };
const ym = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}`;
const sum = (arr, type) => (arr || []).filter(t => t && t.type === type).reduce((s, t) => s + (Number(t.amount) || 0), 0);

let state = blank();
let mode = 'none';
let user = null;
let sb = null;
let view = new Date(); view.setDate(1);
let formType = 'expense', formMethod = 'cash';
let fMethod = 'all';
let txViewTab = 'expenses';
let expensesLimit = 10;

let selectedGroupId = null;
let activeSplitTab = 'expenses';
let activeRealtimeChannel = null;
let selectedSplitParticipants = [];
let pendingParticipants = [];
let groupExpensesExpanded = false;

const money = n => {
  n = Number(n) || 0;
  const frac = Math.abs(n - Math.round(n)) > 0.004 ? 2 : 0;
  return (state.cur || '₱') + n.toLocaleString(undefined, { minimumFractionDigits: frac, maximumFractionDigits: 2 });
};
const short = n => {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
};

/* iOS Compatible Clipboard Helper */
function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
    return Promise.resolve();
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.style.top = '0';
  ta.setAttribute('readonly', '');
  document.body.appendChild(ta);
  ta.focus();
  
  const range = document.createRange();
  range.selectNodeContents(ta);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  ta.setSelectionRange(0, 999999);

  try {
    document.execCommand('copy');
  } catch (err) {}
  document.body.removeChild(ta);
}

function generateUserCode() {
  return 'USR-' + Math.floor(1000 + Math.random() * 9000);
}

function blank() {
  return {
    userCode: generateUserCode(),
    nickname: '',
    tx: [],
    customCats: [],
    cards: [],
    tricounts: [],
    fixedTx: [],
    budget: 0,
    cur: '₱',
    updated: 0
  };
}

function normalize(raw) {
  const s = Object.assign(blank(), raw && typeof raw === 'object' ? raw : {});
  s.userCode = String(s.userCode || generateUserCode()).toUpperCase();
  s.nickname = String(s.nickname || '').trim();

  s.cards = (Array.isArray(s.cards) ? s.cards : []).map(c => ({
    id: String((c && c.id) || Date.now() + Math.random()),
    bank: String((c && c.bank) || 'Bank').trim(),
    name: String((c && c.name) || 'Card').trim(),
    statementDay: Math.max(1, Math.min(31, parseInt(c && c.statementDay) || 1)),
    dueDaysAfter: Math.max(1, Math.min(90, parseInt(c && (c.dueDaysAfter || c.dueDays || c.dueDay)) || 21))
  }));

  s.customCats = Array.isArray(s.customCats) ? s.customCats.map(c => String(c).trim()).filter(Boolean) : [];

  s.tx = (Array.isArray(s.tx) ? s.tx : []).map(t => ({
    id: t && t.id != null ? t.id : Date.now() + Math.random(),
    type: t && t.type === 'income' ? 'income' : 'expense',
    amount: Number(t && t.amount) || 0,
    category: String((t && t.category) || 'Other'),
    method: t && ['card','debit'].includes(t.method) ? t.method : 'cash',
    cardId: String((t && t.cardId) || ''),
    note: String((t && t.note) || ''),
    date: String((t && t.date) || today())
  })).filter(t => t.amount > 0);

  const meIdentifier = s.nickname || s.userCode || 'Me';

  s.tricounts = (Array.isArray(s.tricounts) ? s.tricounts : []).map(p => ({
    id: String(p.id || 'g_' + Date.now() + Math.random()),
    name: String(p.name || 'Shared Group / Person').trim(),
    emoji: String(p.emoji || '🐶'),
    archived: !!p.archived,
    participants: Array.isArray(p.participants) ? p.participants : [meIdentifier],
    settlements: Array.isArray(p.settlements) ? p.settlements : [],
    expenses: (Array.isArray(p.expenses) ? p.expenses : []).map(e => ({
      id: String(e.id || 'e_' + Date.now() + Math.random()),
      title: String(e.title || 'Expense').trim(),
      amount: Number(e.amount) || 0,
      paidBy: String(e.paidBy || meIdentifier).trim(),
      participants: Array.isArray(e.participants) ? e.participants : [],
      date: String(e.date || today())
    }))
  }));

  s.fixedTx = (Array.isArray(s.fixedTx) ? s.fixedTx : []).map(f => ({
    id: String(f.id || 'f_' + Date.now() + Math.random()),
    title: String(f.title || f.note || 'Recurring Expense').trim(),
    amount: Number(f.amount) || 0,
    category: String(f.category || 'Bills').trim(),
    type: f.type === 'income' ? 'income' : 'expense',
    method: f.method || 'cash',
    cardId: f.cardId || '',
    indefinite: f.indefinite !== false,
    totalMonths: parseInt(f.totalMonths) || 12,
    monthsElapsed: parseInt(f.monthsElapsed) || 0,
    startDate: String(f.startDate || today())
  }));

  s.budget = Number(s.budget) > 0 ? Number(s.budget) : 0;
  s.cur = String(s.cur || '₱').slice(0, 4);
  s.updated = Number(s.updated) || 0;
  return s;
}

function readStore(key) {
  const raw = lsGet(key);
  if (!raw) return null;
  try { return normalize(JSON.parse(raw)); } catch { return null; }
}
const storeKey = () => (mode === 'cloud' && user) ? 'ledger.cloud.' + user.id : KEY;
const cacheWrite = () => lsSet(storeKey(), JSON.stringify(state));
const dirtyKey = () => 'ledger.dirty.' + (user ? user.id : '');
const isDirty = () => lsGet(dirtyKey()) === '1';
const setDirty = v => v ? lsSet(dirtyKey(), '1') : lsDel(dirtyKey());

function save() {
  state.updated = Date.now();
  cacheWrite();
  if (mode === 'cloud') { setDirty(true); schedulePush(); }
}

let toastTimer;
function toast(msg, actionLabel, action) {
  const t = $('toast');
  if (!t) return;
  t.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = msg;
  t.appendChild(span);
  if (actionLabel) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = actionLabel;
    b.onclick = () => { t.hidden = true; action && action(); };
    t.appendChild(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, actionLabel ? 6000 : 3000);
}

function showActionSheet(title, sub, buttons) {
  const modal = $('actionSheetModal');
  if (!modal) return;
  $('actionSheetTitle').textContent = title || 'Options';
  $('actionSheetSub').textContent = sub || '';

  const btnContainer = $('actionSheetButtons');
  btnContainer.innerHTML = '';

  buttons.forEach(btn => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `action-sheet-btn ${btn.danger ? 'danger-btn' : ''}`;
    b.textContent = btn.text;
    b.onclick = () => {
      modal.hidden = true;
      if (btn.action) btn.action();
    };
    btnContainer.appendChild(b);
  });

  $('actionSheetCancel').onclick = () => { modal.hidden = true; };
  modal.hidden = false;
}

function attachLongPress(element, callback) {
  let timer = null;
  let startX = 0, startY = 0;

  const start = e => {
    element.classList.add('long-pressing');
    const touch = e.touches ? e.touches[0] : e;
    startX = touch.clientX; startY = touch.clientY;
    timer = setTimeout(() => {
      element.classList.remove('long-pressing');
      if (navigator.vibrate) navigator.vibrate(40);
      callback(e);
    }, 500);
  };

  const cancel = e => {
    if (e.type === 'touchmove') {
      const touch = e.touches[0];
      if (Math.abs(touch.clientX - startX) > 10 || Math.abs(touch.clientY - startY) > 10) {
        clearTimeout(timer); element.classList.remove('long-pressing');
      }
    } else {
      clearTimeout(timer); element.classList.remove('long-pressing');
    }
  };

  element.addEventListener('touchstart', start, { passive: true });
  element.addEventListener('touchmove', cancel, { passive: true });
  element.addEventListener('touchend', cancel);
  element.addEventListener('touchcancel', cancel);
  element.addEventListener('mousedown', start);
  element.addEventListener('mousemove', cancel);
  element.addEventListener('mouseup', cancel);
  element.addEventListener('mouseleave', cancel);
}

function openCardModal(cardToEdit) {
  if (!$('cardModal')) return;
  if ($('cardModalTitle')) $('cardModalTitle').textContent = cardToEdit ? 'Edit Credit Card' : 'Add Credit Card';
  if ($('cardId')) $('cardId').value = cardToEdit ? cardToEdit.id : '';
  if ($('cardBank')) $('cardBank').value = cardToEdit ? cardToEdit.bank : '';
  if ($('cardName')) $('cardName').value = cardToEdit ? cardToEdit.name : '';
  if ($('cardStmtDay')) $('cardStmtDay').value = cardToEdit ? cardToEdit.statementDay : 15;
  if ($('cardDueDays')) $('cardDueDays').value = cardToEdit ? (cardToEdit.dueDaysAfter || 21) : 21;
  $('cardModal').hidden = false;
  if ($('cardBank')) $('cardBank').focus();
}

function closeCardModal() {
  if ($('cardModal')) $('cardModal').hidden = true;
  if ($('cardForm')) $('cardForm').reset();
}

function route() {
  let name = (location.hash || '').replace('#', '');
  if (!PAGES.includes(name)) name = 'home';
  PAGES.forEach(p => { 
    const el = $('page-' + p);
    if (el) el.hidden = p !== name; 
  });
  $$('#dock button').forEach(b => b.classList.toggle('on', b.dataset.go === name));
  try { window.scrollTo(0, 0); } catch {}
  renderAll();
}

function showApp() {
  if ($('auth')) $('auth').hidden = true;
  if ($('app')) $('app').hidden = false;
  if ($('dock')) $('dock').hidden = false;
  ensureDockGradient();
  route();
}

function ensureDockGradient() {
  if (document.body.querySelector('.dock-fade-gradient')) return;
  const gradientDiv = document.createElement('div');
  gradientDiv.className = 'dock-fade-gradient';
  gradientDiv.style.cssText = 'position: fixed; bottom: 0; left: 0; right: 0; height: 95px; pointer-events: none; z-index: 3; background: linear-gradient(to top, var(--bg) 40%, rgba(0,0,0,0) 100%);';
  document.body.appendChild(gradientDiv);
}

function showAuth() {
  if ($('app')) $('app').hidden = true;
  if ($('dock')) $('dock').hidden = true;
  if ($('auth')) $('auth').hidden = false;
  authMsg('');
  if ($('authLocal')) {
    $('authLocal').className = CLOUD ? 'ghost' : 'primary';
    $('authLocal').textContent = mode === 'local' ? 'Back to the app' : (CLOUD ? 'Continue without an account' : 'Continue');
  }
}

function getAllExpenseCats() {
  const merged = BASE_EXPENSE_CATS.concat(state.customCats || []);
  return Array.from(new Set(merged));
}

function renderAll() {
  processRecurringExpensesForCurrentMonth();

  $$('.monthLabel').forEach(el => {
    el.textContent = view.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  });

  if ($('homeGreeting')) {
    let nameStr = state.nickname;
    if (!nameStr && user && user.email) {
      nameStr = user.email.split('@')[0];
      nameStr = nameStr.charAt(0).toUpperCase() + nameStr.slice(1);
    }
    if (!nameStr) nameStr = 'Eric';
    $('homeGreeting').textContent = `Hi ${nameStr}!`;
  }

  populateCardDropdowns();
  fillCats($('category'), 'expense');
  
  renderHome();
  renderFixedExpenses();
  renderExpenses();
  renderSettings();
  renderTricountsList();
  if (selectedGroupId) renderTricountDetail();
}

function getEffectiveExpenseYm(t) {
  if (t.type === 'expense' && t.method === 'card' && t.cardId) {
    const card = (state.cards || []).find(c => c.id === t.cardId);
    if (card) {
      const stmtDay = parseInt(card.statementDay) || 15;
      const dueDaysAfter = parseInt(card.dueDaysAfter || card.dueDays || card.dueDay) || 21;
      const [y, m, d] = t.date.split('-').map(Number);
      const maxDayInM = new Date(y, m, 0).getDate();
      const cutoffDate = new Date(y, m - 1, Math.min(stmtDay, maxDayInM));
      const expDate = new Date(y, m - 1, d);

      let cycleYear = y; let cycleMonth = m - 1;
      if (expDate > cutoffDate) cycleMonth += 1;
      
      const dueDate = new Date(cycleYear, cycleMonth, Math.min(stmtDay, new Date(cycleYear, cycleMonth + 1, 0).getDate()));
      dueDate.setDate(dueDate.getDate() + dueDaysAfter);
      return `${dueDate.getFullYear()}-${pad(dueDate.getMonth() + 1)}`;
    }
  }
  return t.date.slice(0, 7);
}

function monthTx() { 
  const key = ym(view); 
  return (state.tx || []).filter(t => t && t.date && getEffectiveExpenseYm(t) === key); 
}

function populateCardDropdowns() {
  const options = (state.cards || []).map(c => `<option value="${esc(c.id)}">${esc(c.bank)} - ${esc(c.name)}</option>`).join('');
  const fallback = '<option value="">No Cards Added</option>';
  const finalOptions = options || fallback;
  if ($('cardSelect')) $('cardSelect').innerHTML = finalOptions;
  if ($('editCardSelect')) $('editCardSelect').innerHTML = finalOptions;
}

function processRecurringExpensesForCurrentMonth() {
  const currentYm = ym(view);
  
  state.fixedTx = (state.fixedTx || []).filter(f => {
    if (f.indefinite) return true;
    return f.monthsElapsed < f.totalMonths;
  });

  state.fixedTx.forEach(f => {
    const startYm = f.startDate ? f.startDate.slice(0, 7) : currentYm;
    if (currentYm >= startYm) {
      const [sY, sM] = startYm.split('-').map(Number);
      const [vY, vM] = currentYm.split('-').map(Number);
      const monthDiff = (vY - sY) * 12 + (vM - sM);

      if (monthDiff >= 0 && (f.indefinite || monthDiff < f.totalMonths)) {
        const autoId = 'auto_' + f.id + '_' + currentYm;
        const alreadyLogged = state.tx.some(t => t.id === autoId || (t.note === f.title && t.amount === f.amount && t.date && t.date.startsWith(currentYm)));

        if (!alreadyLogged) {
          state.tx.push({
            id: autoId,
            type: f.type || 'expense',
            amount: f.amount,
            category: f.category,
            method: f.method || 'cash',
            cardId: f.cardId || '',
            note: f.title,
            date: currentYm + '-01'
          });
          f.monthsElapsed = monthDiff + 1;
        }
      }
    }
  });
}

function renderHome() {
  const txs = monthTx();
  const inc = sum(txs, 'income'), exp = sum(txs, 'expense');
  const hasBudget = state.budget > 0;
  const left = hasBudget ? state.budget - exp : inc - exp;

  if ($('leftLabel')) $('leftLabel').textContent = hasBudget ? 'Left of budget' : 'Net this month';
  if ($('left')) {
    $('left').textContent = (left < 0 ? '−' : '') + money(Math.abs(left));
    $('left').classList.toggle('neg', left < 0);
  }
  if ($('inc')) $('inc').textContent = money(inc);
  if ($('exp')) $('exp').textContent = money(exp);
  if ($('bud')) $('bud').textContent = hasBudget ? money(state.budget) : '—';

  if ($('prog')) {
    $('prog').hidden = !hasBudget;
    if (hasBudget && $('prog').firstElementChild) {
      $('prog').firstElementChild.style.width = Math.min(100, exp / state.budget * 100) + '%';
      $('prog').classList.toggle('over', exp > state.budget);
    }
  }

  renderCardReminders();

  if ($('homeEmpty')) $('homeEmpty').hidden = state.tx.length > 0;
  if ($('homeCharts')) $('homeCharts').hidden = state.tx.length === 0;
  if (!state.tx.length) return;

  // DONUT PIE CHART
  const by = {};
  txs.filter(t => t.type === 'expense').forEach(t => { by[t.category] = (by[t.category] || 0) + t.amount; });
  const entries = Object.entries(by).sort((a, b) => b[1] - a[1]);
  if ($('donutBody')) {
    if (exp > 0) {
      const R = 42, C = 2 * Math.PI * R;
      let off = 0;
      const arcs = entries.map(([c, v], idx) => {
        const len = (v / exp) * C;
        const color = getCategoryColor(c);
        const dasharray = `${len.toFixed(2)} ${(C - len).toFixed(2)}`;
        const dashoffset = -off;
        off += len;
        return `<circle class="animated-donut-segment" cx="60" cy="60" r="${R}" fill="none" stroke="${color}" stroke-width="16" stroke-dasharray="${dasharray}" stroke-dashoffset="${dashoffset.toFixed(2)}" transform="rotate(-90 60 60)" style="animation: donutSegmentFade 0.6s cubic-bezier(0.4, 0, 0.2, 1) ${idx * 0.08}s both;" />`;
      }).join('');

      $('donutBody').innerHTML = `
        <div class="donut-wrap">
          <div class="donut">
            <svg viewBox="0 0 120 120" role="img" aria-label="Spending by category">
              ${arcs}
              <text x="60" y="55" text-anchor="middle" class="d-sub">Spent</text>
              <text x="60" y="72" text-anchor="middle" class="d-val">${esc(state.cur)}${short(exp)}</text>
            </svg>
          </div>
          <ul class="legend">${entries.map(([c, v], idx) => `
            <li style="animation: fadeInLegend 0.4s ease ${idx * 0.06}s both;">
              <i style="background:${getCategoryColor(c)}"></i>
              <span>${esc(c)}</span>
              <b>${money(v)}</b>
              <em>${Math.round(v / exp * 100)}%</em>
            </li>`).join('')}
          </ul>
        </div>`;
    } else {
      $('donutBody').innerHTML = '<p class="muted center-text" style="padding:16px 0;">No spending logged this month.</p>';
    }
  }

  // 6-MONTH BAR CHART
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(view.getFullYear(), view.getMonth() - i, 1);
    const key = ym(d);
    const spent = state.tx.filter(t => t.type === 'expense' && getEffectiveExpenseYm(t) === key).reduce((s, t) => s + t.amount, 0);
    months.push({ d, spent, cur: i === 0 });
  }
  const max = Math.max(...months.map(m => m.spent), 1);
  const bw = 34, gap = (300 - 6 * bw) / 6;
  const bars = months.map((m, i) => {
    const targetH = m.spent > 0 ? Math.max(4, (m.spent / max) * 78) : 2;
    const x = Math.round(gap / 2 + i * (bw + gap));
    const finalY = Math.round(100 - targetH);
    return `<g class="animated-bar-group">
      <title>${esc(m.d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}: ${money(m.spent)}</title>
      <rect x="${x}" y="${finalY}" width="${bw}" height="${targetH}" rx="5" 
        style="fill:var(--accent); opacity:${m.cur ? 1 : 0.25}; transform-origin: ${x + bw/2}px 100px; animation: barGrow 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275) ${i * 0.08}s both;" />
      ${m.spent > 0 ? `<text x="${x + bw / 2}" y="${finalY - 6}" class="b-val" text-anchor="middle" style="font-size: 11px; fill: var(--text); animation: fadeInLabel 0.4s ease ${0.2 + i * 0.08}s both;">${short(m.spent)}</text>` : ''}
      <text x="${x + bw / 2}" y="117" class="b-lbl${m.cur ? ' cur' : ''}" text-anchor="middle" style="font-size: 11px; fill: var(--text); opacity: ${m.cur ? 1 : 0.6};">${m.d.toLocaleDateString(undefined, { month: 'short' })}</text>
    </g>`;
  }).join('');

  if ($('barsBody')) {
    $('barsBody').innerHTML = `<div class="bars" style="overflow: visible;"><svg viewBox="0 0 300 126" role="img" aria-label="Spending over six months" style="width:100%; height:auto;">${bars}</svg></div>`;
  }

  // PAYMENT METHOD BREAKDOWN BAR
  const cash  = txs.filter(t => t.type === 'expense' && t.method === 'cash').reduce((s, t) => s + t.amount, 0);
  const debit = txs.filter(t => t.type === 'expense' && t.method === 'debit').reduce((s, t) => s + t.amount, 0);
  const card  = txs.filter(t => t.type === 'expense' && t.method === 'card').reduce((s, t) => s + t.amount, 0);

  if ($('splitBody')) {
    if (exp > 0) {
      $('splitBody').innerHTML = `
        <div class="split" role="img" aria-label="Cash ${Math.round(cash / exp * 100)}%, Debit ${Math.round(debit / exp * 100)}%, Credit ${Math.round(card / exp * 100)}%" style="display:flex; height:8px; border-radius:4px; overflow:hidden; margin-bottom:10px; background:var(--bar);">
          <i style="width:${cash / exp * 100}%; background:var(--c-cash, #10b981); transition: width 0.5s ease;"></i>
          <i style="width:${debit / exp * 100}%; background:var(--c-debit, #3b82f6); transition: width 0.5s ease;"></i>
          <i style="width:${card / exp * 100}%; background:var(--c-card, #f59e0b); transition: width 0.5s ease;"></i>
        </div>
        <div class="split-legend" style="display:flex; justify-content:space-between; gap:8px;">
          <div><small style="display:flex; align-items:center; gap:4px; font-size:11px; opacity:0.75;"><i style="display:inline-block; width:6px; height:6px; border-radius:50%; background:var(--c-cash, #10b981)"></i>Cash · ${Math.round(cash / exp * 100)}%</small><b style="display:block; font-size:12px; font-weight:600; margin-top:2px;">${money(cash)}</b></div>
          <div><small style="display:flex; align-items:center; gap:4px; font-size:11px; opacity:0.75;"><i style="display:inline-block; width:6px; height:6px; border-radius:50%; background:var(--c-debit, #3b82f6)"></i>Debit · ${Math.round(debit / exp * 100)}%</small><b style="display:block; font-size:12px; font-weight:600; margin-top:2px;">${money(debit)}</b></div>
          <div><small style="display:flex; align-items:center; gap:4px; font-size:11px; opacity:0.75;"><i style="display:inline-block; width:6px; height:6px; border-radius:50%; background:var(--c-card, #f59e0b)"></i>Credit · ${Math.round(card / exp * 100)}%</small><b style="display:block; font-size:12px; font-weight:600; margin-top:2px;">${money(card)}</b></div>
        </div>`;
    } else {
      $('splitBody').innerHTML = '<p class="muted center-text" style="padding:16px 0;">No spending logged this month.</p>';
    }
  }
}

function renderCardReminders() {
  const el = $('cardReminders');
  if (!el) return;
  if (!state.cards || state.cards.length === 0) {
    el.innerHTML = '<p class="muted">No credit cards added. Click <b>+ Manage Cards</b> to add bank cards with due date reminders.</p>';
    return;
  }

  const now = new Date();
  const todayZero = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const cardStatusList = (state.cards || []).map(c => {
    if (!c) return null;
    const stmtDay = parseInt(c.statementDay) || 1;
    const dueDaysAfter = parseInt(c.dueDaysAfter || c.dueDays || c.dueDay) || 21;

    let y = now.getFullYear(); let m = now.getMonth();
    let maxDayInM = new Date(y, m + 1, 0).getDate();
    let cutoffDate = new Date(y, m, Math.min(stmtDay, maxDayInM));

    if (now < cutoffDate) {
      m -= 1;
      maxDayInM = new Date(y, m + 1, 0).getDate();
      cutoffDate = new Date(y, m, Math.min(stmtDay, maxDayInM));
    }

    const dueDate = new Date(cutoffDate.getTime());
    dueDate.setDate(dueDate.getDate() + dueDaysAfter);

    const diffMs = dueDate - todayZero;
    const daysLeft = Math.round(diffMs / 86400000);

    const cardExpenses = state.tx.filter(t => t.type === 'expense' && t.method === 'card' && t.cardId === c.id);

    const currentDueSpent = cardExpenses.filter(t => new Date(t.date + 'T00:00') <= cutoffDate).reduce((s, t) => s + t.amount, 0);
    const nextCycleSpent = cardExpenses.filter(t => new Date(t.date + 'T00:00') > cutoffDate).reduce((s, t) => s + t.amount, 0);

    return { ...c, statementDay: stmtDay, dueDaysAfter, dueDate, cutoffDate, daysLeft, currentDueSpent, nextCycleSpent };
  }).filter(Boolean).sort((a, b) => a.daysLeft - b.daysLeft);

  el.innerHTML = cardStatusList.map(c => {
    let badgeClass = 'good';
    let badgeText = `${c.daysLeft} days left`;
    if (c.daysLeft === 0) { badgeClass = 'bad'; badgeText = 'Due Today'; }
    else if (c.daysLeft < 0) { badgeClass = 'bad'; badgeText = `${Math.abs(c.daysLeft)}d Overdue`; }
    else if (c.daysLeft <= 3) { badgeClass = 'bad'; badgeText = `Due in ${c.daysLeft}d`; }
    else if (c.daysLeft <= 7) { badgeClass = 'warn'; badgeText = `Due in ${c.daysLeft}d`; }

    const dateFormatted = c.dueDate ? c.dueDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—';
    const cutoffFormatted = c.cutoffDate ? c.cutoffDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—';

    return `
      <div class="card-reminder-item">
        <div class="card-info">
          <div class="card-title"><span class="bank-tag">${esc(c.bank)}</span><span>${esc(c.name)}</span></div>
          <small class="card-dates">Due: <b>${dateFormatted}</b> (Cutoff: ${cutoffFormatted})</small>
        </div>
        <div class="card-status">
          <span class="due-badge ${badgeClass}">${badgeText}</span>
          <div class="card-spent-current">Due: ${money(c.currentDueSpent)}</div>
          ${c.nextCycleSpent > 0 ? `<div class="card-spent-next">Next Cycle: ${money(c.nextCycleSpent)}</div>` : ''}
        </div>
      </div>`;
  }).join('');
}

function fillCats(sel, type, keep) {
  if (!sel) return;
  const prev = keep ? sel.value : '';
  const catsList = type === 'expense' ? getAllExpenseCats() : INCOME_CATS;
  sel.innerHTML = catsList.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if (prev && Array.from(sel.options).some(o => o.value === prev)) sel.value = prev;
}

function renderFixedExpenses() {
  const el = $('fixedExpensesList');
  if (!el) return;
  if (!state.fixedTx || state.fixedTx.length === 0) {
    el.innerHTML = '<p class="muted">No recurring items added yet. Check <b>Recurring monthly</b> when adding a transaction to save it here.</p>';
    return;
  }
  el.innerHTML = state.fixedTx.map(f => `
    <div class="fixed-item" data-id="${esc(f.id)}" style="display: flex; justify-content: space-between; align-items: center; cursor: pointer;">
      <div>
        <strong>${esc(f.title)}</strong>
        <small class="muted" style="display: block;">${esc(f.category)} (${f.type === 'income' ? 'Income' : 'Expense'}) · ${f.indefinite ? 'Ongoing monthly' : `Month ${f.monthsElapsed || 0} of ${f.totalMonths}`}</small>
      </div>
      <div style="display: flex; align-items: center; gap: 10px;">
        <b class="${f.type === 'income' ? 'in' : ''}">${f.type === 'income' ? '+' : ''}${money(f.amount)}/mo</b>
        <button type="button" class="del-fixed-btn" data-id="${esc(f.id)}" style="color: var(--bad); background: none; border: none; cursor: pointer; font-size: 16px;">✕</button>
      </div>
    </div>`).join('');

  $$('#fixedExpensesList .fixed-item').forEach(item => {
    item.onclick = (e) => {
      if (e.target.closest('.del-fixed-btn')) return;
      const f = state.fixedTx.find(x => x.id === item.dataset.id);
      if (!f) return;
      $('editTxId').value = f.id;
      $('editIsRecurringItem').value = 'true';
      $('editAmount').value = f.amount;
      $('editCategory').value = f.category;
      $('editNote').value = f.title;
      $('editDate').value = f.startDate || today();
      formType = f.type || 'expense'; setSeg('editTypeSeg', formType); fillCats($('editCategory'), formType);
      $('editCategory').value = f.category;
      formMethod = f.method || 'cash'; setSeg('editMethodSeg', formMethod);
      if ($('editCardSelectWrap')) $('editCardSelectWrap').hidden = formMethod !== 'card';
      if ($('editCardSelect')) $('editCardSelect').value = f.cardId || '';
      if ($('editRecurringSection')) $('editRecurringSection').hidden = false;
      if ($('editIsIndefinite')) $('editIsIndefinite').checked = f.indefinite;
      if ($('editRecurMonthsWrap')) $('editRecurMonthsWrap').hidden = f.indefinite;
      if ($('editRecurTotalMonths')) $('editRecurTotalMonths').value = f.totalMonths || 12;
      $('editModalTitle').textContent = 'Edit Recurring Expense';
      $('editExpenseModal').hidden = false;
    };
  });

  $$('#fixedExpensesList .del-fixed-btn').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const fId = btn.dataset.id;
      state.tx = state.tx.filter(t => !String(t.id).startsWith('auto_' + fId));
      state.fixedTx = state.fixedTx.filter(x => x.id !== fId);
      save(); renderFixedExpenses(); renderExpenses(); renderHome();
      toast('Recurring schedule and all logged instances removed.');
    };
  });
}

function renderExpenses() {
  const all = monthTx();
  const spentCash  = all.filter(t => t.type === 'expense' && t.method === 'cash').reduce((s, t) => s + t.amount, 0);
  const spentDebit = all.filter(t => t.type === 'expense' && t.method === 'debit').reduce((s, t) => s + t.amount, 0);
  const spentCard  = all.filter(t => t.type === 'expense' && t.method === 'card').reduce((s, t) => s + t.amount, 0);
  
  if ($('minis')) {
    $('minis').innerHTML = `
      <div class="mini"><small>Cash</small><b>${money(spentCash)}</b></div>
      <div class="mini"><small>Debit card</small><b>${money(spentDebit)}</b></div>
      <div class="mini"><small>Credit card</small><b>${money(spentCard)}</b></div>`;
  }

  let txs = all;
  if (fMethod !== 'all') txs = txs.filter(t => t.type === 'expense' && t.method === fMethod);
  txs = txs.slice().sort((a, b) => b.date.localeCompare(a.date) || Number(b.id) - Number(b.id));

  if ($('empty')) {
    $('empty').hidden = txs.length > 0;
    $('empty').textContent = all.length ? 'No entries match these filters.' : 'Nothing logged this month.';
  }

  const visibleTxs = txs.slice(0, expensesLimit);
  if ($('btnSeeMoreExpenses')) {
    $('btnSeeMoreExpenses').hidden = txs.length <= expensesLimit;
    $('btnSeeMoreExpenses').textContent = `See More (${txs.length - expensesLimit} remaining)`;
  }
  
  if ($('list')) {
    $('list').innerHTML = visibleTxs.map(t => {
      let methodDetail = METHOD_LABEL[t.method];
      if (t.method === 'card' && t.cardId) {
        const found = state.cards.find(c => c.id === t.cardId);
        if (found) methodDetail = `${found.bank} (${found.name})`;
      }
      return `
      <li class="tx" data-id="${esc(t.id)}" style="cursor: pointer;">
        <span class="cat-dot" style="background:${getCategoryColor(t.category)}"></span>
        <div class="meta"><div>${esc(t.note || t.category)}</div>
          <small>${esc(t.category)} · ${new Date(t.date + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          ${t.type === 'expense' ? `<span class="tag">${esc(methodDetail)}</span>` : ''}</small></div>
        <span class="amt ${t.type === 'income' ? 'in' : ''}">${t.type === 'income' ? '+' : '−'}${money(t.amount)}</span>
      </li>`;
    }).join('');

    $$('#list li.tx').forEach(li => {
      li.onclick = () => {
        const tx = state.tx.find(t => String(t.id) === li.dataset.id);
        if (!tx) return;
        $('editTxId').value = tx.id;
        $('editIsRecurringItem').value = 'false';
        $('editAmount').value = tx.amount;
        $('editCategory').value = tx.category;
        $('editNote').value = tx.note || '';
        $('editDate').value = tx.date;
        formType = tx.type || 'expense'; setSeg('editTypeSeg', formType); fillCats($('editCategory'), formType);
        $('editCategory').value = tx.category;
        formMethod = tx.method || 'cash'; setSeg('editMethodSeg', formMethod);
        if ($('editCardSelectWrap')) $('editCardSelectWrap').hidden = formMethod !== 'card';
        if ($('editCardSelect')) $('editCardSelect').value = tx.cardId || '';
        if ($('editRecurringSection')) $('editRecurringSection').hidden = true;
        $('editModalTitle').textContent = 'Edit / Delete Expense';
        $('editExpenseModal').hidden = false;
      };
    });
  }
}

function renderPendingParticipants() {
  const list = $('billParticipantsList');
  if (!list) return;
  list.innerHTML = pendingParticipants.map((p, idx) => `
    <li class="participant-item">
      <span class="participant-name">${esc(p)}</span>
      <button type="button" class="del-participant-btn" data-idx="${idx}" aria-label="Remove participant">&times;</button>
    </li>`).join('');

  $$('#billParticipantsList .del-participant-btn').forEach(btn => {
    btn.onclick = () => {
      pendingParticipants.splice(btn.dataset.idx, 1);
      renderPendingParticipants();
    };
  });
}

function updateModalEmojiDisplay(emojiVal) {
  const val = emojiVal || '🐶';
  if ($('emojiAvatarBtn')) $('emojiAvatarBtn').textContent = val;
  if ($('customEmojiInput')) $('customEmojiInput').value = val;
}

function initEmojiPickerPopover() {
  const btn = $('emojiAvatarBtn');
  const hiddenInput = $('customEmojiInput');
  const popover = $('emojiPickerPopover');
  const grid = $('emojiGrid');
  const typeInput = $('typeEmojiInput');
  const closeBtn = $('closeEmojiPickerBtn');

  if (!btn || !popover || !grid) return;

  grid.innerHTML = DEFAULT_AVATAR_EMOJIS.map(e => `
    <button type="button" class="emoji-grid-item" data-emoji="${e}">${e}</button>
  `).join('');

  const selectEmoji = (emoji) => {
    const symbol = emoji || '🐶';
    btn.textContent = symbol;
    if (hiddenInput) hiddenInput.value = symbol;
    popover.hidden = true;
  };

  btn.onclick = (e) => {
    e.stopPropagation();
    popover.hidden = !popover.hidden;
    if (!popover.hidden && typeInput) typeInput.focus();
  };

  if (closeBtn) closeBtn.onclick = () => { popover.hidden = true; };

  grid.onclick = (e) => {
    const item = e.target.closest('.emoji-grid-item');
    if (item && item.dataset.emoji) selectEmoji(item.dataset.emoji);
  };

  if (typeInput) {
    typeInput.oninput = (e) => {
      const val = e.target.value.trim();
      if (val) {
        selectEmoji(Array.from(val).pop() || '🐶');
        typeInput.value = '';
      }
    };
  }

  document.addEventListener('click', (e) => {
    if (popover && !popover.hidden && !popover.contains(e.target) && e.target !== btn) {
      popover.hidden = true;
    }
  });
}

function renderTricountsList() {
  const el = $('tricountsList');
  if (!el) return;
  const activeGroups = (state.tricounts || []).filter(g => !g.archived);

  if (activeGroups.length === 0) {
    el.innerHTML = '<div class="empty-card card">No active bill added. Tap <b>+ Add a Bill</b> to add one or check <b>Archives</b>!</div>';
    return;
  }

  el.innerHTML = activeGroups.map(g => `
    <div class="tricount-card" data-id="${esc(g.id)}">
      <div class="tricount-card-left">
        <span class="tricount-emoji">${esc(g.emoji)}</span>
        <div>
          <div class="tricount-name">${esc(g.name)}</div>
          <small class="muted fine">${g.participants ? g.participants.length : 1} members (${g.participants.join(', ')})</small>
        </div>
      </div>
      <span class="tricount-chevron">›</span>
    </div>`).join('');

  $$('#tricountsList .tricount-card').forEach(card => {
    const group = state.tricounts.find(g => g.id === card.dataset.id);
    if (!group) return;
    card.onclick = () => openTricountDetail(group.id);

    attachLongPress(card, () => {
      showActionSheet(group.name, `Members: ${group.participants ? group.participants.join(', ') : ''}`, [
        {
          text: '📁 Archive Bill',
          action: () => {
            group.archived = true; save(); renderTricountsList(); toast(`Archived ${group.name}`);
          }
        },
        {
          text: '✏️ Edit Bill Details',
          action: () => {
            $('groupModalTitle').textContent = 'Edit Bill';
            $('editGroupId').value = group.id;
            $('personNameInput').value = group.name;
            updateModalEmojiDisplay(group.emoji || '🐶');
            if ($('btnDeleteGroup')) $('btnDeleteGroup').hidden = false;
            pendingParticipants = group.participants ? [...group.participants] : [state.nickname || state.userCode || 'Me'];
            renderPendingParticipants();
            $('addPersonModal').hidden = false;
          }
        },
        {
          text: '🗑️ Delete Bill',
          danger: true,
          action: () => {
            if (confirm(`Delete bill "${group.name}" permanently?`)) {
              state.tricounts = state.tricounts.filter(g => g.id !== group.id);
              if (sb && mode === 'cloud') sb.from('split_groups').delete().eq('id', group.id);
              save(); renderTricountsList(); toast('Bill deleted');
            }
          }
        }
      ]);
    });
  });
}

function renderArchivedTricountsList() {
  const el = $('archivedTricountsList');
  if (!el) return;
  const archivedGroups = (state.tricounts || []).filter(g => g.archived);

  if (archivedGroups.length === 0) {
    el.innerHTML = '<div class="empty-card card">No archived bills found.</div>';
    return;
  }

  el.innerHTML = archivedGroups.map(g => `
    <div class="tricount-card" data-id="${esc(g.id)}">
      <div class="tricount-card-left">
        <span class="tricount-emoji">${esc(g.emoji)}</span>
        <div class="tricount-card-info">
          <div class="tricount-name">${esc(g.name)}</div>
          <small class="muted fine">Archived · ${g.participants ? g.participants.length : 1} members</small>
        </div>
      </div>
      <button type="button" class="unarchive-btn" data-id="${esc(g.id)}">Restore</button>
    </div>`).join('');

  $$('#archivedTricountsList .tricount-card').forEach(card => {
    const group = state.tricounts.find(g => g.id === card.dataset.id);
    if (!group) return;
    card.onclick = (e) => {
      if (e.target.closest('.unarchive-btn')) return;
      openTricountDetail(group.id);
    };
  });

  $$('#archivedTricountsList .unarchive-btn').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const group = state.tricounts.find(g => g.id === btn.dataset.id);
      if (group) {
        group.archived = false;
        save();
        renderArchivedTricountsList();
        renderTricountsList();
        toast(`Restored "${group.name}" to active bills!`);
      }
    };
  });
}

function openTricountDetail(id) {
  selectedGroupId = id;
  groupExpensesExpanded = false;
  $('splitMainView').hidden = true;
  if ($('splitArchiveView')) $('splitArchiveView').hidden = true;
  $('splitDetailView').hidden = false;
  subscribeRealtimeGroup(id);
  renderTricountDetail();
}

function closeTricountDetail() {
  if (activeRealtimeChannel && sb) {
    sb.removeChannel(activeRealtimeChannel); activeRealtimeChannel = null;
  }
  selectedGroupId = null;
  groupExpensesExpanded = false;
  $('splitDetailView').hidden = true;
  if ($('splitArchiveView')) $('splitArchiveView').hidden = true;
  $('splitMainView').hidden = false;
  renderTricountsList();
}

function subscribeRealtimeGroup(groupId) {
  if (!sb || mode !== 'cloud') return;
  if (activeRealtimeChannel) sb.removeChannel(activeRealtimeChannel);

  activeRealtimeChannel = sb.channel('group:' + groupId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'group_expenses', filter: 'group_id=eq.' + groupId }, () => {
      syncSharedGroupExpenses(groupId);
    }).subscribe();
}

async function syncSharedGroupExpenses(groupId) {
  if (!sb || mode !== 'cloud') return;
  try {
    const { data } = await sb.from('group_expenses').select('*').eq('group_id', groupId).order('date', { ascending: false });
    const group = state.tricounts.find(g => g.id === groupId);
    if (group && data) {
      group.expenses = data.map(e => ({
        id: e.id, title: e.title, amount: Number(e.amount),
        paidBy: e.paid_by_name, date: e.date
      }));
      save(); renderTricountDetail();
    }
  } catch (err) {}
}

function calculateGroupBalance(group) {
  const meStr = state.nickname || state.userCode || 'Me';
  const participants = new Set(group.participants || [meStr]);
  (group.expenses || []).forEach(e => {
    participants.add(e.paidBy || meStr);
    if (Array.isArray(e.participants)) e.participants.forEach(p => participants.add(p));
  });

  const balances = {};
  participants.forEach(p => balances[p] = 0);

  let totalExpenses = 0;
  (group.expenses || []).forEach(e => {
    const amt = Number(e.amount) || 0;
    const paidBy = e.paidBy || meStr;
    balances[paidBy] = (balances[paidBy] || 0) + amt;
    totalExpenses += amt;

    const beneficiaries = (Array.isArray(e.participants) && e.participants.length > 0)
      ? e.participants
      : Array.from(participants);

    const share = amt / (beneficiaries.length || 1);
    beneficiaries.forEach(p => { balances[p] = (balances[p] || 0) - share; });
  });

  (group.settlements || []).forEach(s => {
    const amt = Number(s.amount) || 0;
    balances[s.from] = (balances[s.from] || 0) + amt;
    balances[s.to] = (balances[s.to] || 0) - amt;
  });

  const debtors = [];
  const creditors = [];
  for (const [person, balance] of Object.entries(balances)) {
    if (balance < -0.01) debtors.push({ person, amount: -balance });
    else if (balance > 0.01) creditors.push({ person, amount: balance });
  }

  const settlements = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const debtor = debtors[i];
    const creditor = creditors[j];
    const amount = Math.min(debtor.amount, creditor.amount);
    settlements.push({ from: debtor.person, to: creditor.person, amount });
    debtor.amount -= amount; creditor.amount -= amount;
    if (debtor.amount < 0.01) i++;
    if (creditor.amount < 0.01) j++;
  }

  const myNet = balances[meStr] !== undefined ? balances[meStr] : (balances[state.userCode] !== undefined ? balances[state.userCode] : (balances['Me'] || 0));
  return { balances, settlements, totalExpenses, myNet };
}

function renderTricountDetail() {
  const group = (state.tricounts || []).find(g => g.id === selectedGroupId);
  if (!group) { closeTricountDetail(); return; }

  if ($('splitPersonAvatar')) $('splitPersonAvatar').textContent = group.emoji || '🐶';
  if ($('splitPersonName')) $('splitPersonName').textContent = group.name;

  const { totalExpenses, myNet } = calculateGroupBalance(group);

  if ($('splitMyExpensesVal')) {
    $('splitMyExpensesVal').textContent = (myNet < 0 ? '−' : myNet > 0 ? '+' : '') + money(Math.abs(myNet));
    $('splitMyExpensesVal').className = myNet < 0 ? 'neg-text' : myNet > 0 ? 'pos-text' : '';
  }
  if ($('splitTotalExpensesVal')) $('splitTotalExpensesVal').textContent = money(totalExpenses);

  if ($('splitTabExpenses')) $('splitTabExpenses').hidden = activeSplitTab !== 'expenses';
  if ($('splitTabBalances')) $('splitTabBalances').hidden = activeSplitTab !== 'balances';
  if ($('splitTabHistory')) $('splitTabHistory').hidden = activeSplitTab !== 'history';
  setSeg('splitDetailTabs', activeSplitTab);

  if (activeSplitTab === 'expenses') renderTricountExpensesList(group);
  else if (activeSplitTab === 'balances') renderTricountBalancesTab(group);
  else if (activeSplitTab === 'history') renderTricountHistoryTab(group);
}

function renderTricountExpensesList(group) {
  const el = $('splitExpensesGroupedList');
  const seeAllBtn = $('btnSeeAllGroupExpenses');
  if (!el) return;

  if (!group.expenses || group.expenses.length === 0) {
    el.innerHTML = '<div class="empty card" style="padding: 20px 16px;">No expenses logged in <b>' + esc(group.name) + '</b>. Tap <b>+ Add Expense to Bill</b> above to start logging.</div>';
    if (seeAllBtn) seeAllBtn.hidden = true;
    return;
  }

  const totalCount = group.expenses.length;
  let allSortedExps = group.expenses.slice().sort((a, b) => b.date.localeCompare(a.date) || Number(b.id) - Number(a.id));

  if (!groupExpensesExpanded && totalCount > 10) {
    allSortedExps = allSortedExps.slice(0, 10);
  }

  if (seeAllBtn) {
    seeAllBtn.hidden = totalCount <= 10;
    seeAllBtn.textContent = groupExpensesExpanded ? 'Show Less' : `See All Expenses (${totalCount - 10} more)`;
  }

  const groups = {};
  allSortedExps.forEach(e => {
    const dateStr = e.date || today();
    if (!groups[dateStr]) groups[dateStr] = [];
    groups[dateStr].push(e);
  });

  const sortedDates = Object.keys(groups).sort((a, b) => b.localeCompare(a));

  el.innerHTML = sortedDates.map(dateKey => {
    const d = new Date(dateKey + 'T00:00');
    const dateLabel = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const items = groups[dateKey].map(exp => {
      const beneficiaries = (Array.isArray(exp.participants) && exp.participants.length > 0)
        ? exp.participants
        : (group.participants || ['Me']);

      const chipsHtml = beneficiaries.map(p => `
        <span class="share-avatar-chip">👤 ${esc(p)}</span>
      `).join('');

      return `
        <div class="tricount-expense-card edit-split-exp-btn" data-id="${esc(exp.id)}" style="cursor: pointer;">
          <div class="exp-left">
            <div>
              <div class="exp-title">
                <b>${esc(exp.title)}</b>
              </div>
              <div class="exp-sub" style="margin-top: 2px;">Paid by <b>${esc(exp.paidBy)}</b></div>
              <div class="shares-chips-row">${chipsHtml}</div>
            </div>
          </div>
          <div class="exp-amount-wrap" style="text-align: right;">
            <span class="exp-amount">${money(exp.amount)}</span>
            <small class="muted text-link" style="display: block; margin-top: 2px;">Edit</small>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="date-group" style="margin-bottom: 14px;">
        <div class="date-header">${esc(dateLabel)}</div>
        ${items}
      </div>`;
  }).join('');
}

function renderTricountBalancesTab(group) {
  const { settlements, myNet } = calculateGroupBalance(group);
  const status = $('splitBannerStatus');
  const sub = $('splitBannerSub');

  if (status && sub) {
    if (myNet < -0.01) {
      status.textContent = `You owe ${money(Math.abs(myNet))}`;
      status.className = 'neg-text'; sub.textContent = 'Your overall net balance in this group';
    } else if (myNet > 0.01) {
      status.textContent = `Owed ${money(Math.abs(myNet))}`;
      status.className = 'pos-text'; sub.textContent = 'Your overall net balance in this group';
    } else {
      status.textContent = `Settled up`;
      status.className = 'pos-text'; sub.textContent = `All group balances are completely even!`;
    }
  }

  const list = $('splitBalancesList');
  if (!list) return;

  if (settlements.length === 0) {
    list.innerHTML = `<div class="empty" style="padding: 16px;">All group balances are settled!</div>`;
    return;
  }

  list.innerHTML = settlements.map(s => `
    <div class="srow">
      <div class="user-item">
        <div class="user-avatar-circle" style="background: var(--bar); color: var(--text);">💸</div>
        <div><strong>${esc(s.from)}</strong> owes <strong>${esc(s.to)}</strong></div>
      </div>
      <span class="bold">${money(s.amount)}</span>
    </div>`).join('');
}

function renderTricountHistoryTab(group) {
  const el = $('splitHistoryList');
  if (!el) return;

  const history = group.settlements || [];
  if (history.length === 0) {
    el.innerHTML = '<p class="muted">No payments or reimbursements recorded yet.</p>';
    return;
  }

  el.innerHTML = history.slice().reverse().map(s => `
    <div class="history-item">
      <div>
        <strong>${esc(s.from)}</strong> paid <strong>${esc(s.to)}</strong>
        <small class="muted" style="display: block;">${esc(s.method || 'GCash')} · ${s.date || today()} ${s.note ? '· ' + esc(s.note) : ''}</small>
      </div>
      <b class="pos-text">+${money(s.amount)}</b>
    </div>
  `).join('');
}

function parseCsvLine(line) {
  const result = [];
  let current = ''; let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; } else { inQuotes = !inQuotes; }
    } else if (char === ',' && !inQuotes) { result.push(current.trim()); current = '';
    } else { current += char; }
  }
  result.push(current.trim());
  return result;
}

function importSplitwiseCsv(file) {
  if (!file || !selectedGroupId) return;
  const reader = new FileReader();
  reader.onload = async e => {
    const text = e.target.result;
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) { toast('CSV file is empty or invalid.'); return; }

    const header = parseCsvLine(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9_ ]/g, ''));
    const dateIdx = header.findIndex(h => h.includes('date'));
    const descIdx = header.findIndex(h => h.includes('description') || h.includes('title') || h.includes('details') || h.includes('item'));
    const costIdx = header.findIndex(h => h.includes('cost') || h.includes('amount') || h.includes('total'));
    const payerIdx = header.findIndex(h => h.includes('paid') || h.includes('payer') || h.includes('who paid'));

    let imported = 0;
    const group = state.tricounts.find(g => g.id === selectedGroupId);
    if (!group) return;

    const meStr = state.nickname || state.userCode || 'Me';

    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i]);
      if (cols.length < 2) continue;
      const title = cols[descIdx >= 0 ? descIdx : 1] || 'Imported Expense';
      const amount = parseFloat((cols[costIdx >= 0 ? costIdx : 2] || '0').replace(/[^0-9.]/g, '')) || 0;
      const paidBy = cols[payerIdx >= 0 ? payerIdx : 3] || meStr;
      const date = cols[dateIdx >= 0 ? dateIdx : 0] || today();

      if (amount > 0) {
        group.expenses.push({ id: 'e_' + Date.now() + Math.random(), title, amount, paidBy, participants: [...group.participants], date });
        imported++;
      }
    }
    save(); renderTricountDetail(); toast(`Successfully imported ${imported} expenses!`);
  };
  reader.readAsText(file);
}

function importCsv(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const text = e.target.result;
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) { toast('CSV file is empty or invalid.'); return; }

    const header = parseCsvLine(lines[0]).map(h => h.toLowerCase().replace(/[^a-z_]/g, ''));
    const dateIdx = header.findIndex(h => h.includes('date'));
    const typeIdx = header.findIndex(h => h.includes('type'));
    const catIdx  = header.findIndex(h => h.includes('cat'));
    const paidIdx = header.findIndex(h => h.includes('paid') || h.includes('method'));
    const amtIdx  = header.findIndex(h => h.includes('amt') || h.includes('amount'));
    const noteIdx = header.findIndex(h => h.includes('note') || h.includes('desc') || h.includes('store'));

    let importedCount = 0;
    const newTxList = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i]);
      if (cols.length < 2) continue;

      const amtVal = parseFloat(cols[amtIdx >= 0 ? amtIdx : 4] || 0);
      if (!(amtVal > 0)) continue;

      const rawType = (cols[typeIdx >= 0 ? typeIdx : 1] || 'expense').toLowerCase();
      const type = rawType.includes('inc') ? 'income' : 'expense';
      const cat = cols[catIdx >= 0 ? catIdx : 2] || 'Other';
      const rawPaid = (cols[paidIdx >= 0 ? paidIdx : 3] || 'cash').toLowerCase();
      let method = 'cash';
      if (rawPaid.includes('debit')) method = 'debit';
      else if (rawPaid.includes('card') || rawPaid.includes('credit')) method = 'card';

      newTxList.push({
        id: Date.now() + Math.random(), type, amount: amtVal, category: cat, method, cardId: '', note: cols[noteIdx >= 0 ? noteIdx : 5] || '', date: cols[dateIdx >= 0 ? dateIdx : 0] || today()
      });
      importedCount++;
    }

    if (importedCount > 0) {
      if (confirm(`Replace current ledger with ${importedCount} imported transactions?`)) state.tx = newTxList;
      else state.tx = state.tx.concat(newTxList);
      save(); renderAll(); toast(`Successfully imported ${importedCount} transactions!`);
    }
  };
  reader.readAsText(file);
}

function renderSettings() {
  const cl = $('cardsList');
  if (cl) {
    if (!state.cards.length) {
      cl.innerHTML = '<div class="srow"><span class="fine">No credit cards added yet.</span></div>';
    } else {
      cl.innerHTML = state.cards.map(c => `
        <div class="card-item">
          <div class="card-item-details">
            <strong>${esc(c.bank)} - ${esc(c.name)}</strong>
            <small>Statement: Day ${c.statementDay} · Due: ${c.dueDaysAfter || 21} days after statement</small>
          </div>
          <div class="card-item-actions">
            <button type="button" class="icon-btn edit-card-btn" data-id="${esc(c.id)}">Edit</button>
            <button type="button" class="icon-btn del-card-btn" data-id="${esc(c.id)}">✕</button>
          </div>
        </div>`).join('');
    }
  }

  if ($('displayUserCode')) $('displayUserCode').textContent = state.userCode || 'USR-0000';
  if ($('acctCloud')) $('acctCloud').hidden = mode !== 'cloud';
  if ($('acctLocal')) $('acctLocal').hidden = mode === 'cloud';
  if (mode === 'cloud' && user && $('acctEmail')) $('acctEmail').textContent = user.email || '';
  if ($('signInRow')) $('signInRow').hidden = !CLOUD;
  if ($('noCloudRow')) $('noCloudRow').hidden = CLOUD;
  const th = getTheme();
  $$('#themeSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === th));
  if ($('setNickname') && document.activeElement !== $('setNickname')) $('setNickname').value = state.nickname || '';
  if ($('setCur') && document.activeElement !== $('setCur')) $('setCur').value = state.cur;
  if ($('setBudget') && document.activeElement !== $('setBudget')) $('setBudget').value = state.budget || '';
}

const THEMES = ['system', 'light', 'dark'];
function getTheme() { const t = lsGet('ledger.theme'); return THEMES.includes(t) ? t : 'system'; }
function applyTheme(t) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  $$('#themeSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === t));
}

function addTx(t) {
  state.tx.push(Object.assign({ id: Date.now() }, t));
  save();
  const d = new Date(t.date + 'T00:00'); d.setDate(1); view = d;
  renderAll();
}

function saveCard(cardData) {
  if (cardData.id) {
    const idx = state.cards.findIndex(c => c.id === cardData.id);
    if (idx >= 0) state.cards[idx] = cardData;
  } else {
    cardData.id = 'c_' + Date.now();
    state.cards.push(cardData);
  }
  save(); renderAll();
}

function deleteCard(id) {
  if (!confirm('Delete this credit card reminder? Existing transactions will stay intact.')) return;
  state.cards = state.cards.filter(c => c.id !== id);
  save(); renderAll();
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = src; s.async = true;
    s.onload = resolve; s.onerror = () => reject(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}
const loadSupabase = () => window.supabase ? Promise.resolve() : loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2');

function setSync(text) { const el = $('syncState'); if (el) el.textContent = text; }

let pushTimer = null, pushing = false, pushAgain = false;
function schedulePush(ms) { clearTimeout(pushTimer); pushTimer = setTimeout(push, ms == null ? 800 : ms); }

async function push() {
  if (mode !== 'cloud' || !sb || !user) return;
  if (pushing) { pushAgain = true; return; }
  pushing = true; setSync('Syncing…');
  const stamp = state.updated;
  try {
    const { error } = await sb.from('ledger_data').upsert({
      user_id: user.id, data: JSON.parse(JSON.stringify(state)), updated_at: new Date().toISOString()
    });
    if (error) throw error;
    if (state.updated === stamp) setDirty(false);
    setSync('Synced');
  } catch (e) {
    setSync('Offline. Will sync when you are back online.');
  }
  pushing = false;
  if (pushAgain) { pushAgain = false; schedulePush(200); }
}

async function pull() {
  if (mode !== 'cloud' || !sb || !user) return;
  setSync('Syncing…');
  try {
    const { data, error } = await sb.from('ledger_data').select('data,updated_at').eq('user_id', user.id).maybeSingle();
    if (error) throw error;
    if (data) {
      const remote = normalize(data.data);
      if (isDirty() || state.updated > remote.updated) {
        schedulePush(0);
      } else if (remote.updated > state.updated) {
        state = remote; cacheWrite(); renderAll();
      }
    }
    if (!pushing && !isDirty()) setSync('Synced');
  } catch (e) {
    setSync('Offline. Will sync when you are back online.');
  }
}

function enterLocal() {
  mode = 'local'; user = null; lsSet('ledger.mode', 'local');
  state = readStore(KEY) || blank();
  showApp();
}

async function enterCloud(u) {
  mode = 'cloud'; user = u;
  lsDel('ledger.mode');
  lsSet('ledger.lastUser', JSON.stringify({ id: u.id, email: u.email || '' }));
  state = readStore(storeKey()) || blank();
  showApp(); setSync('Syncing…'); await pull();
}

async function signOut() {
  if (mode === 'cloud' && isDirty()) {
    await push();
    if (isDirty() && !confirm('Unsynced changes exist. Sign out anyway?')) return;
  }
  const uid = user && user.id;
  try { if (sb) await sb.auth.signOut(); } catch {}
  if (uid) { lsDel('ledger.cloud.' + uid); lsDel('ledger.dirty.' + uid); }
  lsDel('ledger.lastUser'); lsDel('ledger.mode');
  mode = 'none'; user = null; state = blank();
  location.hash = ''; showAuth();
}

function authMsg(text, ok) { const m = $('authMsg'); if (m) { m.textContent = text || ''; m.classList.toggle('ok', !!ok); } }

function friendlyAuthError(err) {
  const m = (err && err.message) || 'Something went wrong. Please try again.';
  if (/rate limit|too many/i.test(m)) return 'Too many attempts. Please wait a bit and try again.';
  if (/fetch|network/i.test(m)) return "Can't reach the server. Check your connection.";
  return m;
}

async function signInWithGoogle() {
  if (!CLOUD || !sb) {
    authMsg("Supabase credentials missing in config.js. Add valid SUPABASE_URL & SUPABASE_ANON_KEY to enable Google Sign-In.");
    return;
  }
  authMsg("Redirecting to Google...", true);
  try {
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin + window.location.pathname
      }
    });
    if (error) throw error;
  } catch (err) {
    authMsg(friendlyAuthError(err));
  }
}

function updateSplitCalculationExplanation() {
  const textEl = $('splitCalcExplanation');
  if (!textEl) return;
  const count = selectedSplitParticipants.length;
  if (count === 0) {
    textEl.textContent = 'Please select at least 1 participant.';
  } else if (count === 1) {
    textEl.textContent = `The selected participant (${selectedSplitParticipants[0]}) will owe 100% of the bill.`;
  } else {
    textEl.textContent = `The bill total will be split equally among the ${count} selected participants.`;
  }
}

function bind() {
  const on = (id, evt, fn) => { const el = $(id); if (el) el.addEventListener(evt, fn); };

  if ($('dock')) {
    $('dock').addEventListener('click', e => {
      const b = e.target.closest('button[data-go]'); if (!b) return;
      if (location.hash === '#' + b.dataset.go) route(); else location.hash = '#' + b.dataset.go;
    });
  }

  initEmojiPickerPopover();

  if ($('displayUserCode')) {
    $('displayUserCode').onclick = () => {
      if (state.userCode) {
        copyToClipboard(state.userCode);
        toast(`Copied Account ID: ${state.userCode}`);
      }
    };
  }

  on('txViewSeg', 'click', e => {
    const b = e.target.closest('button'); if (!b) return;
    txViewTab = b.dataset.v; setSeg('txViewSeg', txViewTab);
    if ($('tabExpensesView')) $('tabExpensesView').hidden = txViewTab !== 'expenses';
    if ($('tabRecurringView')) $('tabRecurringView').hidden = txViewTab !== 'recurring';
  });

  if ($('btnAddExpenseBtn')) {
    $('btnAddExpenseBtn').onclick = () => {
      if ($('addExpenseModal')) $('addExpenseModal').hidden = false;
      if ($('note')) $('note').focus();
    };
  }

  if ($('addExpenseCancel')) $('addExpenseCancel').onclick = () => { if ($('addExpenseModal')) $('addExpenseModal').hidden = true; };
  window.addEventListener('hashchange', () => { if ($('app') && !$('app').hidden) route(); });

  document.addEventListener('click', e => {
    const b = e.target.closest('button[data-m]'); if (!b) return;
    view = new Date(view.getFullYear(), view.getMonth() + Number(b.dataset.m), 1);
    expensesLimit = 10; renderAll();
  });

  if ($('btnManageCardsHome')) $('btnManageCardsHome').onclick = () => { location.hash = '#settings'; };

  on('typeSeg', 'click', e => {
    const b = e.target.closest('button'); if (!b) return;
    formType = b.dataset.v; setSeg('typeSeg', formType);
    if ($('methodWrap')) $('methodWrap').hidden = formType !== 'expense';
    if ($('cardSelectWrap')) $('cardSelectWrap').hidden = formType !== 'expense' || formMethod !== 'card';
    fillCats($('category'), formType);
  });

  on('methodSeg', 'click', e => {
    const b = e.target.closest('button'); if (!b) return;
    formMethod = b.dataset.v; setSeg('methodSeg', formMethod);
    if ($('cardSelectWrap')) $('cardSelectWrap').hidden = formMethod !== 'card';
  });

  on('form', 'submit', e => {
    e.preventDefault();
    const amount = parseFloat($('amount').value);
    if (!(amount > 0)) return;

    let catVal = $('category') ? $('category').value : 'Other';
    const cardId = (formType === 'expense' && formMethod === 'card' && $('cardSelect')) ? $('cardSelect').value : '';
    const noteVal = $('note').value.trim();
    const dateVal = $('date').value || today();

    addTx({ type: formType, amount, category: catVal, method: formType === 'expense' ? formMethod : 'cash', cardId, note: noteVal, date: dateVal });
    $('amount').value = ''; $('note').value = '';
    if ($('addExpenseModal')) $('addExpenseModal').hidden = true;
  });

  on('editExpenseForm', 'submit', e => {
    e.preventDefault();
    const id = $('editTxId').value;
    const isRecur = $('editIsRecurringItem').value === 'true';
    const amt = parseFloat($('editAmount').value) || 0;
    const cat = $('editCategory').value;
    const note = $('editNote').value.trim();
    const date = $('editDate').value || today();
    const activeType = $$('#editTypeSeg button.on')[0]?.dataset.v || 'expense';
    const activeMethod = $$('#editMethodSeg button.on')[0]?.dataset.v || 'cash';
    const cardId = activeMethod === 'card' && $('editCardSelect') ? $('editCardSelect').value : '';

    if (isRecur) {
      const f = state.fixedTx.find(x => x.id === id);
      if (f) {
        f.amount = amt; f.category = cat; f.title = note || cat; f.type = activeType; f.method = activeMethod; f.cardId = cardId;
        save(); $('editExpenseModal').hidden = true; renderAll(); toast('Recurring expense updated!');
      }
    } else {
      const tx = state.tx.find(t => String(t.id) === id);
      if (tx) {
        tx.amount = amt; tx.category = cat; tx.note = note; tx.date = date; tx.type = activeType; tx.method = activeMethod; tx.cardId = cardId;
        save(); $('editExpenseModal').hidden = true; renderAll(); toast('Expense updated!');
      }
    }
  });

  if ($('editExpenseCancel')) $('editExpenseCancel').onclick = () => { $('editExpenseModal').hidden = true; };

  if ($('btnOpenArchiveSubpage')) {
    $('btnOpenArchiveSubpage').onclick = () => {
      $('splitMainView').hidden = true;
      $('splitArchiveView').hidden = false;
      renderArchivedTricountsList();
    };
  }

  if ($('btnArchiveBack')) {
    $('btnArchiveBack').onclick = () => {
      $('splitArchiveView').hidden = true;
      $('splitMainView').hidden = false;
      renderTricountsList();
    };
  }

  if ($('btnSplitBack')) $('btnSplitBack').onclick = closeTricountDetail;

  if ($('btnAddPersonFabTop')) {
    $('btnAddPersonFabTop').onclick = () => {
      $('groupModalTitle').textContent = 'Add a Bill';
      $('editGroupId').value = '';
      $('personNameInput').value = '';
      updateModalEmojiDisplay('🐶');
      if ($('btnDeleteGroup')) $('btnDeleteGroup').hidden = true;
      pendingParticipants = [state.nickname || state.userCode || 'Me'];
      renderPendingParticipants();
      $('addPersonModal').hidden = false;
      $('personNameInput').focus();
    };
  }

  if ($('btnEditGroupTitle')) {
    $('btnEditGroupTitle').onclick = () => {
      const group = state.tricounts.find(g => g.id === selectedGroupId);
      if (!group) return;
      $('groupModalTitle').textContent = 'Edit Bill';
      $('editGroupId').value = group.id;
      $('personNameInput').value = group.name;
      updateModalEmojiDisplay(group.emoji || '🐶');
      if ($('btnDeleteGroup')) $('btnDeleteGroup').hidden = false;
      pendingParticipants = group.participants ? [...group.participants] : [state.nickname || state.userCode || 'Me'];
      renderPendingParticipants();
      $('addPersonModal').hidden = false;
    };
  }

  if ($('addPersonCancel')) $('addPersonCancel').onclick = () => { $('addPersonModal').hidden = true; };

  if ($('btnAddParticipantBtn')) {
    $('btnAddParticipantBtn').onclick = () => {
      const nameInput = $('newParticipantName');
      const name = nameInput.value.trim();
      if (name && !pendingParticipants.includes(name)) {
        pendingParticipants.push(name);
        nameInput.value = '';
        renderPendingParticipants();
      }
    };
  }

  on('addPersonForm', 'submit', async e => {
    e.preventDefault();
    const name = $('personNameInput').value.trim();
    const editId = $('editGroupId').value;
    const finalEmoji = ($('customEmojiInput') ? $('customEmojiInput').value.trim() : '') || '🐶';

    if (!name || pendingParticipants.length === 0) {
      toast('Please enter a bill name and add at least 1 participant.');
      return;
    }

    if (editId) {
      const group = state.tricounts.find(g => g.id === editId);
      if (group) {
        group.name = name; group.emoji = finalEmoji; group.participants = [...pendingParticipants];
      }
    } else {
      state.tricounts.push({
        id: 'g_' + Date.now(), name, emoji: finalEmoji, archived: false,
        participants: [...pendingParticipants], settlements: [], expenses: []
      });
    }

    save(); $('addPersonModal').hidden = true;
    if (selectedGroupId) renderTricountDetail(); else renderTricountsList();
    toast(editId ? 'Saved bill updates!' : 'Bill created!');
  });

  if ($('btnImportSplitwise')) $('btnImportSplitwise').onclick = () => $('splitwiseCsvInput').click();
  on('splitwiseCsvInput', 'change', e => {
    importSplitwiseCsv(e.target.files[0]); e.target.value = '';
  });

  on('splitDetailTabs', 'click', e => {
    const b = e.target.closest('button'); if (!b) return;
    activeSplitTab = b.dataset.v; renderTricountDetail();
  });

  if ($('btnSeeAllGroupExpenses')) {
    $('btnSeeAllGroupExpenses').onclick = () => {
      groupExpensesExpanded = !groupExpensesExpanded;
      const group = state.tricounts.find(g => g.id === selectedGroupId);
      if (group) renderTricountExpensesList(group);
    };
  }

  if ($('btnOpenAddSplitExpense')) {
    $('btnOpenAddSplitExpense').onclick = () => {
      const group = state.tricounts.find(g => g.id === selectedGroupId);
      if (!group) return;

      $('splitExpenseModalTitle').textContent = 'Add Shared Expense';
      $('splitExpId').value = '';
      $('splitExpTitle').value = '';
      $('splitExpAmount').value = '';
      $('splitExpDate').value = today();

      $('splitExpPaidBy').innerHTML = group.participants.map(p => `
        <option value="${esc(p)}">${esc(p)}</option>
      `).join('');
      $('splitExpPaidBy').value = state.nickname || state.userCode || group.participants[0] || 'Me';

      selectedSplitParticipants = [...group.participants];
      renderParticipantToggleGrid(group);

      if ($('btnDeleteSplitExpense')) $('btnDeleteSplitExpense').hidden = true;
      $('addSplitExpenseModal').hidden = false;
      $('splitExpTitle').focus();
    };
  }

  function renderParticipantToggleGrid(group) {
    const grid = $('splitParticipantsToggleGrid');
    if (!grid) return;
    grid.innerHTML = group.participants.map(p => {
      const isSelected = selectedSplitParticipants.includes(p);
      return `<button type="button" class="part-chip-toggle ${isSelected ? 'on' : ''}" data-person="${esc(p)}">${isSelected ? '✓ ' : ''}${esc(p)}</button>`;
    }).join('');

    $$('#splitParticipantsToggleGrid .part-chip-toggle').forEach(btn => {
      btn.onclick = () => {
        const person = btn.dataset.person;
        if (selectedSplitParticipants.includes(person)) {
          if (selectedSplitParticipants.length > 1) {
            selectedSplitParticipants = selectedSplitParticipants.filter(x => x !== person);
          } else {
            toast('At least 1 participant must be selected.');
          }
        } else {
          selectedSplitParticipants.push(person);
        }
        renderParticipantToggleGrid(group);
        updateSplitCalculationExplanation();
      };
    });
    updateSplitCalculationExplanation();
  }

  if ($('addSplitExpenseCancel')) $('addSplitExpenseCancel').onclick = () => { $('addSplitExpenseModal').hidden = true; };

  on('addSplitExpenseForm', 'submit', async e => {
    e.preventDefault();
    const expId = $('splitExpId').value;
    const title = $('splitExpTitle').value.trim();
    const amount = parseFloat($('splitExpAmount').value) || 0;
    const dateVal = $('splitExpDate').value || today();
    const paidBy = $('splitExpPaidBy').value.trim();

    if (!title || !(amount > 0)) return;

    const group = state.tricounts.find(g => g.id === selectedGroupId);
    if (group) {
      if (expId) {
        const exp = group.expenses.find(e => e.id === expId);
        if (exp) {
          exp.title = title; exp.amount = amount; exp.date = dateVal; exp.paidBy = paidBy;
          exp.participants = [...selectedSplitParticipants];
        }
      } else {
        group.expenses.push({
          id: 'e_' + Date.now(), title, amount, paidBy,
          participants: [...selectedSplitParticipants], date: dateVal
        });
      }
      save(); $('addSplitExpenseModal').hidden = true; renderTricountDetail(); toast('Expense saved to bill!');
    }
  });

  on('splitExpensesGroupedList', 'click', e => {
    const card = e.target.closest('.edit-split-exp-btn');
    if (!card) return;
    const group = state.tricounts.find(g => g.id === selectedGroupId);
    if (!group) return;

    const exp = group.expenses.find(e => e.id === card.dataset.id);
    if (exp) {
      $('splitExpenseModalTitle').textContent = 'Edit Shared Expense';
      $('splitExpId').value = exp.id;
      $('splitExpTitle').value = exp.title;
      $('splitExpAmount').value = exp.amount;
      $('splitExpDate').value = exp.date;

      $('splitExpPaidBy').innerHTML = group.participants.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
      $('splitExpPaidBy').value = exp.paidBy;

      selectedSplitParticipants = Array.isArray(exp.participants) && exp.participants.length > 0 ? [...exp.participants] : [...group.participants];
      renderParticipantToggleGrid(group);

      if ($('btnDeleteSplitExpense')) $('btnDeleteSplitExpense').hidden = false;
      $('addSplitExpenseModal').hidden = false;
    }
  });

  if ($('btnDeleteSplitExpense')) {
    $('btnDeleteSplitExpense').onclick = () => {
      const expId = $('splitExpId').value;
      const group = state.tricounts.find(g => g.id === selectedGroupId);
      if (group && expId && confirm('Delete this bill expense?')) {
        group.expenses = group.expenses.filter(e => e.id !== expId);
        save(); $('addSplitExpenseModal').hidden = true; renderTricountDetail(); toast('Expense deleted');
      }
    };
  }

  if ($('btnSettleUp')) {
    $('btnSettleUp').onclick = () => {
      const group = state.tricounts.find(g => g.id === selectedGroupId);
      if (!group) return;

      const opts = group.participants.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
      if ($('settlePayer')) $('settlePayer').innerHTML = opts;
      if ($('settleReceiver')) $('settleReceiver').innerHTML = opts;
      if ($('settleAmount')) $('settleAmount').value = '';
      if ($('settleNote')) $('settleNote').value = '';
      if ($('settleModal')) $('settleModal').hidden = false;
    };
  }

  if ($('settleCancel')) $('settleCancel').onclick = () => { if ($('settleModal')) $('settleModal').hidden = true; };

  on('settleForm', 'submit', e => {
    e.preventDefault();
    const group = state.tricounts.find(g => g.id === selectedGroupId);
    if (!group) return;

    const from = $('settlePayer').value;
    const to = $('settleReceiver').value;
    const amount = parseFloat($('settleAmount').value) || 0;
    const method = $('settleMethod').value;
    const note = $('settleNote').value.trim();

    if (from === to) { toast('Payer and receiver cannot be the same person.'); return; }
    if (!(amount > 0)) return;

    if (!group.settlements) group.settlements = [];
    group.settlements.push({ id: 's_' + Date.now(), from, to, amount, method, note, date: today() });

    save(); $('settleModal').hidden = true; renderTricountDetail(); toast(`Recorded payment of ${money(amount)}!`);
  });

  if ($('btnLogShareToMainExpenses')) {
    $('btnLogShareToMainExpenses').onclick = () => {
      const group = state.tricounts.find(g => g.id === selectedGroupId);
      if (!group) return;
      const { myNet } = calculateGroupBalance(group);
      if (Math.abs(myNet) < 0.01) { toast('Fully settled up. No net share to log.'); return; }

      const shareAmount = Math.abs(myNet);
      const isExpense = myNet < 0;

      addTx({
        type: isExpense ? 'expense' : 'income', amount: shareAmount, category: 'Bills', method: 'cash',
        cardId: '', note: `Net share for ${group.name}`, date: today()
      });
      toast(`Logged ${money(shareAmount)} as ${isExpense ? 'expense' : 'income'} to Main Expenses!`);
      location.hash = '#expenses';
    };
  }

  on('methodChips', 'click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    fMethod = b.dataset.v; expensesLimit = 10;
    $$('#methodChips .chip').forEach(c => c.classList.toggle('on', c === b));
    renderExpenses();
  });

  if ($('btnAddCardModal')) $('btnAddCardModal').onclick = () => openCardModal();
  if ($('cardModalCancel')) $('cardModalCancel').onclick = closeCardModal;

  on('cardForm', 'submit', e => {
    e.preventDefault();
    const bank = $('cardBank') ? $('cardBank').value.trim() : '';
    const name = $('cardName') ? $('cardName').value.trim() : '';
    const statementDay = parseInt($('cardStmtDay') ? $('cardStmtDay').value : '') || 1;
    const dueDaysAfter = parseInt($('cardDueDays') ? $('cardDueDays').value : '') || 21;
    const id = $('cardId') ? $('cardId').value : '';

    if (!bank || !name) return;
    saveCard({ id, bank, name, statementDay, dueDaysAfter });
    closeCardModal(); toast('Credit card saved');
  });

  on('cardsList', 'click', e => {
    const editBtn = e.target.closest('.edit-card-btn');
    if (editBtn) {
      const card = state.cards.find(c => c.id === editBtn.dataset.id);
      if (card) openCardModal(card);
      return;
    }
    const delBtn = e.target.closest('.del-card-btn');
    if (delBtn) deleteCard(delBtn.dataset.id);
  });

  on('themeSeg', 'click', e => {
    const b = e.target.closest('button'); if (!b) return;
    lsSet('ledger.theme', b.dataset.v); applyTheme(b.dataset.v);
  });

  on('setNickname', 'input', () => { state.nickname = $('setNickname').value.trim(); save(); renderAll(); });
  on('setCur', 'change', () => {
    const v = $('setCur').value.trim();
    if (v) { state.cur = v.slice(0, 4); save(); renderAll(); }
  });
  on('setBudget', 'change', () => {
    const n = parseFloat($('setBudget').value);
    state.budget = n > 0 ? n : 0; save(); renderAll();
  });

  if ($('csv')) $('csv').onclick = exportCsv;
  if ($('importCsvBtn')) $('importCsvBtn').onclick = () => $('csvFileInput').click();
  on('csvFileInput', 'change', e => { importCsv(e.target.files[0]); e.target.value = ''; });

  if ($('wipe')) {
    $('wipe').onclick = () => {
      if (confirm('Erase all data permanently?') && confirm('Final Warning: Delete everything?')) {
        state = blank(); save(); renderAll(); toast('All data erased');
      }
    };
  }

  if ($('signOut')) $('signOut').onclick = signOut;
  if ($('signInBtn')) $('signInBtn').onclick = () => showAuth();
  if ($('authGoogle')) $('authGoogle').onclick = signInWithGoogle;
  if ($('authLocal')) $('authLocal').onclick = () => { if (mode === 'cloud') showApp(); else enterLocal(); };

  fillCats($('category'), 'expense');
  if ($('date')) $('date').value = today();
}

function setSeg(id, value) { $$('#' + id + ' button').forEach(b => b.classList.toggle('on', b.dataset.v === value)); }

function exportCsv() {
  const q = s => '"' + String(s).replace(/"/g, '""') + '"';
  const rows = [['date', 'type', 'category', 'paid_with', 'amount', 'note']]
    .concat(state.tx.slice().sort((a, b) => a.date.localeCompare(b.date))
      .map(t => [t.date, t.type, t.category, t.type === 'expense' ? METHOD_LABEL[t.method] : '', t.amount, t.note]));
  const blob = new Blob([rows.map(r => r.map(q).join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'ledger.csv';
  document.body.appendChild(a); a.click(); a.remove();
}

async function boot() {
  try {
    applyTheme(getTheme());
    bind();

    if (CLOUD) {
      try {
        await loadSupabase();
        sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);

        sb.auth.onAuthStateChange(async (event, session) => {
          if (session && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED')) {
            await enterCloud(session.user);
          } else if (event === 'SIGNED_OUT' && mode === 'cloud') {
            mode = 'none'; user = null; showAuth();
          }
        });
      } catch (e) {
        console.error('Supabase load error:', e);
        sb = null;
      }
    }

    if (sb) {
      const { data } = await sb.auth.getSession();
      if (data && data.session) {
        await enterCloud(data.session.user);
        return;
      }
    } else if (CLOUD) {
      let last = null;
      try { last = JSON.parse(lsGet('ledger.lastUser') || 'null'); } catch {}
      if (last && last.id && readStore('ledger.cloud.' + last.id)) {
        mode = 'cloud'; user = { id: last.id, email: last.email };
        state = readStore(storeKey());
        showApp(); setSync('Offline. Will sync when back online.');
        return;
      }
    }

    if (lsGet('ledger.mode') === 'local') { enterLocal(); return; }
    showAuth();
  } catch (err) {
    console.error('Boot error:', err);
    enterLocal();
  }
}

boot();
})();