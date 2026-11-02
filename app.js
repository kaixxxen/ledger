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
const isIsoDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

let state = blank();
let mode = 'none';
let user = null;
let sb = null;
let view = new Date(); view.setDate(1);
let formType = 'expense', formMethod = 'cash';
let fMethod = 'all';
let txViewTab = 'expenses';
const LIMIT = 5;            // list rows shown before "See all"
const expanded = {};        // which lists are expanded
let txSearch = '';
const limited = (key, arr) => expanded[key] ? arr : arr.slice(0, LIMIT);
const moreBtn = (key, total) => total > LIMIT
  ? `<button type="button" class="see-all-btn" data-key="${key}">${expanded[key] ? 'Show less' : `See all (${total})`}</button>` : '';
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
let cardsFilter = 'all';
let currentPage = null;

let selectedGroupId = null;
let activeSplitTab = 'expenses';
let activeRealtimeChannel = null;
let selectedSplitParticipants = [];
let pendingParticipants = [];
let paidModalCardId = null;

// ---- shared bills / permanent Ledger ID ----
let profile = null;            // { code, nick } - permanent Ledger ID issued by the server
let profileTried = false;
let sharedChannel = null;
let sharedReloadTimer = null;
let sharedPollTimer = null;
let loadingShared = false, loadSharedAgain = false;
let nickTimer = null;

const uid = () => (window.crypto && crypto.randomUUID)
  ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });

const ID_RE = /^#?\s*([A-Za-z]{3})\s*-?\s*(\d{6})\s*$/;
function parseLedgerId(s) {
  const m = ID_RE.exec(String(s || ''));
  return m ? (m[1] + '-' + m[2]).toUpperCase() : null;
}
function displayName() {
  if (state.nickname) return state.nickname;
  if (user && user.email) { const n = user.email.split('@')[0]; return n.charAt(0).toUpperCase() + n.slice(1); }
  return 'Me';
}
const legacyMe = () => state.nickname || state.userCode || 'Me';
const myKeyFor = g => g.shared ? (profile ? profile.code : '') : (g.meKey || legacyMe());
function meParticipant() {
  if (mode === 'cloud' && profile) return { key: profile.code, name: displayName(), code: profile.code };
  const n = state.nickname || 'Me';
  return { key: n, name: n, code: null };
}
const isMeParticipant = p => mode === 'cloud' && profile && p.code === profile.code;
const partLabel = p => p.code ? `${p.name || 'Ledger user'} (#${p.code})` : p.name;
const labelFor = (g, key) => { const p = (g.participants || []).find(x => x.key === key); return p ? partLabel(p) : String(key); };
const shortFor = (g, key) => { const p = (g.participants || []).find(x => x.key === key); return p ? p.name : String(key); };

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
    customIncomeCats: [],
    cards: [],
    billGroups: [],
    fixedTx: [],
    budget: 0,
    cur: '₱',
    updated: 0
  };
}

function normalize(raw) {
  const s = Object.assign(blank(), raw && typeof raw === 'object' ? raw : {});
  // older saves stored bill groups under a different key
  if (raw && Array.isArray(raw.tricounts) && !(Array.isArray(raw.billGroups) && raw.billGroups.length)) s.billGroups = raw.tricounts;
  delete s.tricounts;
  s.userCode = String(s.userCode || generateUserCode()).toUpperCase();
  s.nickname = String(s.nickname || '').trim();

  s.cards = (Array.isArray(s.cards) ? s.cards : []).map(c => ({
    id: String((c && c.id) || Date.now() + Math.random()),
    bank: String((c && c.bank) || 'Bank').trim(),
    name: String((c && c.name) || 'Card').trim(),
    type: c && c.type === 'debit' ? 'debit' : 'credit',
    lastPaid: String((c && c.lastPaid) || ''),
    paidOn: String((c && c.paidOn) || ''),
    statementDay: Math.max(1, Math.min(31, parseInt(c && c.statementDay) || 1)),
    dueDaysAfter: Math.max(1, Math.min(90, parseInt(c && (c.dueDaysAfter || c.dueDays || c.dueDay)) || 21))
  }));

  s.customCats = Array.isArray(s.customCats) ? s.customCats.map(c => String(c).trim()).filter(Boolean) : [];
  s.customIncomeCats = Array.isArray(s.customIncomeCats) ? s.customIncomeCats.map(c => String(c).trim()).filter(Boolean) : [];

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
  const toPart = x => (x && typeof x === 'object')
    ? { key: String(x.key || x.name || '').trim(), name: String(x.name || x.key || '').trim(), code: x.code ? String(x.code).toUpperCase() : null }
    : { key: String(x == null ? '' : x).trim(), name: String(x == null ? '' : x).trim(), code: null };

  s.billGroups = (Array.isArray(s.billGroups) ? s.billGroups : []).map(p => {
    const seen = new Set();
    const parts = (Array.isArray(p.participants) ? p.participants : [meIdentifier]).map(toPart)
      .filter(x => x.key && !seen.has(x.key) && seen.add(x.key));
    if (!parts.length) parts.push(toPart(meIdentifier));
    return {
      id: String(p.id || 'g_' + Date.now() + Math.random()),
      name: String(p.name || 'Shared Group / Person').trim(),
      emoji: String(p.emoji || '🐶'),
      archived: !!p.archived,
      shared: !!p.shared,
      createdBy: String(p.createdBy || ''),
      meKey: String(p.meKey || ''),
      participants: parts,
      settlements: (Array.isArray(p.settlements) ? p.settlements : []).map(x => ({
        id: String(x.id || 's_' + Date.now() + Math.random()),
        from: String(x.from || ''), to: String(x.to || ''),
        amount: Number(x.amount) || 0,
        method: String(x.method || ''), note: String(x.note || ''),
        date: String(x.date || today())
      })),
      expenses: (Array.isArray(p.expenses) ? p.expenses : []).map(e => ({
        id: String(e.id || 'e_' + Date.now() + Math.random()),
        title: String(e.title || 'Expense').trim(),
        amount: Number(e.amount) || 0,
        paidBy: String(e.paidBy || meIdentifier).trim(),
        participants: Array.isArray(e.participants) ? e.participants.map(String) : [],
        date: String(e.date || today())
      }))
    };
  });

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
    startDate: String(f.startDate || today()),
    skip: Array.isArray(f.skip) ? f.skip.map(String) : []
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
    element._lpFired = false;
    element.classList.add('long-pressing');
    const touch = e.touches ? e.touches[0] : e;
    startX = touch.clientX; startY = touch.clientY;
    clearTimeout(timer);
    timer = setTimeout(() => {
      element._lpFired = true;   // lets the card's click handler ignore the release that follows
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
  element.addEventListener('contextmenu', e => { if (element._lpFired) e.preventDefault(); });
}

const cardModalType = () => (($$('#cardTypeSeg button.on')[0] || {}).dataset || {}).v || 'credit';
function syncCardModalType() {
  const t = cardModalType(), credit = t === 'credit';
  if ($('cardCycleWrap')) $('cardCycleWrap').hidden = !credit;
  if ($('cardStmtDay')) $('cardStmtDay').required = credit;
  if ($('cardDueDays')) $('cardDueDays').required = credit;
  if ($('cardModalTitle')) {
    const editing = $('cardId') && $('cardId').value;
    $('cardModalTitle').textContent = (editing ? 'Edit ' : 'Add ') + (credit ? 'Credit Card' : 'Debit Card');
  }
  if ($('cardName')) $('cardName').placeholder = credit ? 'e.g. World Elite Mastercard (1234)' : 'e.g. Savings Debit (5678)';
}

function openCardModal(cardToEdit, defaultType) {
  if (!$('cardModal')) return;
  if ($('cardId')) $('cardId').value = cardToEdit ? cardToEdit.id : '';
  setSeg('cardTypeSeg', cardToEdit ? (cardToEdit.type || 'credit') : (defaultType || 'credit'));
  if ($('cardBank')) $('cardBank').value = cardToEdit ? cardToEdit.bank : '';
  if ($('cardName')) $('cardName').value = cardToEdit ? cardToEdit.name : '';
  if ($('cardStmtDay')) $('cardStmtDay').value = cardToEdit ? cardToEdit.statementDay : 15;
  if ($('cardDueDays')) $('cardDueDays').value = cardToEdit ? (cardToEdit.dueDaysAfter || 21) : 21;
  syncCardModalType();
  $('cardModal').hidden = false;
  if ($('cardBank')) $('cardBank').focus();
}

function closeCardModal() {
  if ($('cardModal')) $('cardModal').hidden = true;
  if ($('cardForm')) $('cardForm').reset();
}

// iOS-friendly animations use the Web Animations API (no dependence on CSS class timing).
const reduceMotion = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

// Slide/fade an element in. dir: 1 = from the right, -1 = from the left, 0 = fade up.
function slideIn(el, dir) {
  if (!el || !el.animate) return;
  const calm = reduceMotion();               // Reduce Motion on: fade only, no movement
  const dx = calm ? 0 : dir * 34;
  const dy = calm || dir !== 0 ? 0 : 10;
  try {
    el.animate(
      [{ opacity: 0, transform: `translate3d(${dx}px, ${dy}px, 0)` }, { opacity: 1, transform: 'translate3d(0, 0, 0)' }],
      { duration: calm ? 180 : 340, easing: 'cubic-bezier(.22,.8,.3,1)', fill: 'backwards' }
    );
  } catch (e) {}
}

// Modals & action sheet animate every time they are opened.
function initModalAnimations() {
  $$('.modal-backdrop, .action-sheet-backdrop').forEach(bd => {
    const sheet = bd.classList.contains('action-sheet-backdrop');
    new MutationObserver(() => {
      if (bd.hidden || !bd.animate) return;
      const calm = reduceMotion();
      try {
        bd.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
        const card = bd.firstElementChild;
        if (card && !calm) {
          card.animate(
            sheet
              ? [{ transform: 'translate3d(0, 56px, 0)', opacity: .4 }, { transform: 'translate3d(0, 0, 0)', opacity: 1 }]
              : [{ transform: 'translate3d(0, 26px, 0) scale(.95)', opacity: 0 }, { transform: 'translate3d(0, 0, 0) scale(1)', opacity: 1 }],
            { duration: 340, easing: 'cubic-bezier(.2,.9,.3,1)' }
          );
        }
      } catch (e) {}
    }).observe(bd, { attributes: true, attributeFilter: ['hidden'] });
  });
}

function route() {
  let name = (location.hash || '').replace('#', '');
  if (!PAGES.includes(name)) name = 'home';
  const prev = currentPage;
  PAGES.forEach(p => {
    const el = $('page-' + p);
    if (el) el.hidden = p !== name;
  });
  $$('#dock button').forEach(b => b.classList.toggle('on', b.dataset.go === name));
  try { window.scrollTo(0, 0); } catch {}
  if (prev && prev !== name) slideIn($('page-' + name), PAGES.indexOf(name) > PAGES.indexOf(prev) ? 1 : -1);
  currentPage = name;
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
  // Without a cloud config there is nothing to sign in to, so hide the provider options.
  ['googleAuthWrap', 'authDivider', 'emailLinkForm'].forEach(id => { if ($(id)) $(id).hidden = !CLOUD; });
  if ($('authLocal')) {
    $('authLocal').className = CLOUD ? 'ghost' : 'primary';
    $('authLocal').textContent = mode === 'local' ? 'Back to the app' : (CLOUD ? 'Continue without an account' : 'Continue');
  }
}

function mergeCats(base, custom) {
  const seen = new Set();
  const out = [];
  base.filter(c => c !== 'Other').concat(custom || []).concat(['Other']).forEach(c => {
    const k = String(c).trim().toLowerCase();
    if (k && !seen.has(k)) { seen.add(k); out.push(String(c).trim()); }
  });
  return out;
}
function getAllExpenseCats() { return mergeCats(BASE_EXPENSE_CATS, state.customCats); }
function getAllIncomeCats()  { return mergeCats(INCOME_CATS, state.customIncomeCats); }

// Turns a typed custom category into a stored one (reusing an existing name if it matches).
function registerCustomCategory(name, type) {
  const clean = String(name || '').trim().replace(/\s+/g, ' ');
  if (!clean) return null;
  const all = type === 'income' ? getAllIncomeCats() : getAllExpenseCats();
  const hit = all.find(c => c.toLowerCase() === clean.toLowerCase());
  if (hit) return hit;
  const key = type === 'income' ? 'customIncomeCats' : 'customCats';
  if (!Array.isArray(state[key])) state[key] = [];
  state[key].push(clean);
  return clean;
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
    $('homeGreeting').textContent = nameStr ? `Hi ${nameStr}!` : 'Hi there!';
  }

  populateCardDropdowns();
  fillCats($('category'), addFormType(), true);
  
  renderHome();
  renderFixedExpenses();
  renderExpenses();
  renderSettings();
  renderBillList();
  if (selectedGroupId) renderBillDetail();
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

const cardsOfMethod = method => (state.cards || []).filter(c => c.type === (method === 'debit' ? 'debit' : 'credit'));
function fillCardSelect(sel, method, selected) {
  if (!sel) return;
  const list = cardsOfMethod(method);
  const prev = selected != null ? selected : sel.value;
  const opts = list.map(c => `<option value="${esc(c.id)}">${esc(c.bank)} - ${esc(c.name)}</option>`);
  if (method === 'debit') opts.unshift('<option value="">Not specified</option>');
  else if (!opts.length) opts.push('<option value="">No credit cards added</option>');
  sel.innerHTML = opts.join('');
  if (prev && Array.from(sel.options).some(o => o.value === prev)) sel.value = prev;
}
const addFormType   = () => ($$('#typeSeg button.on')[0] || {}).dataset?.v || 'expense';
const addFormMethod = () => ($$('#methodSeg button.on')[0] || {}).dataset?.v || 'cash';
const editFormType   = () => ($$('#editTypeSeg button.on')[0] || {}).dataset?.v || 'expense';
const editFormMethod = () => ($$('#editMethodSeg button.on')[0] || {}).dataset?.v || 'cash';

function syncAddCardSelect() {
  const m = addFormMethod(), isExp = addFormType() === 'expense';
  const show = isExp && (m === 'card' || m === 'debit');
  if ($('cardSelectWrap')) $('cardSelectWrap').hidden = !show;
  if ($('cardSelectLabel')) $('cardSelectLabel').textContent = m === 'debit' ? 'Select Debit Card' : 'Select Credit Card';
  if (show) fillCardSelect($('cardSelect'), m);
}
function syncEditCardSelect(selected) {
  const m = editFormMethod(), isExp = editFormType() === 'expense';
  const show = isExp && (m === 'card' || m === 'debit');
  if ($('editMethodWrap')) $('editMethodWrap').hidden = !isExp;
  if ($('editCardSelectWrap')) $('editCardSelectWrap').hidden = !show;
  if ($('editCardSelectLabel')) $('editCardSelectLabel').textContent = m === 'debit' ? 'Select Debit Card' : 'Select Credit Card';
  if (show) fillCardSelect($('editCardSelect'), m, selected);
}
function syncCustomCatField() {
  const show = $('category') && $('category').value === 'Other';
  if ($('customCatWrap')) $('customCatWrap').hidden = !show;
  if (show && $('customCategoryInput')) $('customCategoryInput').focus();
}

function populateCardDropdowns() {
  syncAddCardSelect();
  if ($('editExpenseModal') && !$('editExpenseModal').hidden) syncEditCardSelect();
}

function processRecurringExpensesForCurrentMonth() {
  // Logs every missing month from each schedule's start up to the month being viewed
  // (never more than a year ahead, so browsing doesn't create endless future entries).
  const now = new Date();
  const maxAhead = new Date(now.getFullYear(), now.getMonth() + 12, 1);
  const endDate = view > maxAhead ? maxAhead : (view > now ? view : now);
  const endYm = ym(endDate);
  const [eY, eM] = endYm.split('-').map(Number);
  let changed = false;

  state.fixedTx = (state.fixedTx || []).filter(f => {
    const startYm = (f.startDate || today()).slice(0, 7);
    const [sY, sM] = startYm.split('-').map(Number);
    const last = (eY - sY) * 12 + (eM - sM);
    const startDay = parseInt((f.startDate || '').slice(8, 10)) || 1;
    let generated = 0;
    for (let i = 0; i <= last; i++) {
      if (!f.indefinite && i >= f.totalMonths) break;
      generated = i + 1;
      const d = new Date(sY, sM - 1 + i, 1);
      const mYm = ym(d);
      if ((f.skip || []).includes(mYm)) continue;
      const autoId = 'auto_' + f.id + '_' + mYm;
      const logged = state.tx.some(t => t.id === autoId ||
        (t.note === f.title && t.amount === f.amount && t.date && t.date.startsWith(mYm)));
      if (logged) continue;
      const day = Math.min(startDay, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate());
      state.tx.push({
        id: autoId, type: f.type || 'expense', amount: f.amount, category: f.category,
        method: f.method || 'cash', cardId: f.cardId || '', note: f.title, date: `${mYm}-${pad(day)}`
      });
      changed = true;
    }
    if (f.monthsElapsed !== generated) { f.monthsElapsed = generated; }
    // finished fixed-length schedules drop off once every month is logged
    return f.indefinite || generated < f.totalMonths;
  });
  if (changed) save();
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
          <div><small style="display:flex; align-items:center; gap:4px; font-size:10px; opacity:0.75;"><i style="display:inline-block; width:6px; height:6px; border-radius:50%; background:var(--c-cash, #10b981)"></i>Cash · ${Math.round(cash / exp * 100)}%</small><b style="display:block; font-size:12px; font-weight:600; margin-top:2px;">${money(cash)}</b></div>
          <div><small style="display:flex; align-items:center; gap:4px; font-size:10px; opacity:0.75;"><i style="display:inline-block; width:6px; height:6px; border-radius:50%; background:var(--c-debit, #3b82f6)"></i>Debit · ${Math.round(debit / exp * 100)}%</small><b style="display:block; font-size:12px; font-weight:600; margin-top:2px;">${money(debit)}</b></div>
          <div><small style="display:flex; align-items:center; gap:4px; font-size:10px; opacity:0.75;"><i style="display:inline-block; width:6px; height:6px; border-radius:50%; background:var(--c-card, #f59e0b)"></i>Credit · ${Math.round(card / exp * 100)}%</small><b style="display:block; font-size:12px; font-weight:600; margin-top:2px;">${money(card)}</b></div>
        </div>`;
    } else {
      $('splitBody').innerHTML = '<p class="muted center-text" style="padding:16px 0;">No spending logged this month.</p>';
    }
  }
}

/* ---------- credit card statement status (shared by the home list and the paid modal) ---------- */
const fmtShort = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtLong  = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function computeCardStatus(c) {
  const now = new Date();
  const todayZero = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const clampDay = (y, m, d) => new Date(y, m, Math.min(d, new Date(y, m + 1, 0).getDate()));

  const stmtDay = parseInt(c.statementDay) || 1;
  const dueDaysAfter = parseInt(c.dueDaysAfter || c.dueDays || c.dueDay) || 21;

  // latest statement date that has already happened
  let cutoffDate = clampDay(now.getFullYear(), now.getMonth(), stmtDay);
  if (todayZero < cutoffDate) cutoffDate = clampDay(now.getFullYear(), now.getMonth() - 1, stmtDay);
  const prevCutoff = clampDay(cutoffDate.getFullYear(), cutoffDate.getMonth() - 1, stmtDay);

  const dueDate = new Date(cutoffDate.getTime());
  dueDate.setDate(dueDate.getDate() + dueDaysAfter);
  const daysLeft = Math.round((dueDate - todayZero) / 86400000);

  const cardExpenses = state.tx.filter(t => t.type === 'expense' && t.method === 'card' && t.cardId === c.id);
  const at = t => new Date(t.date + 'T00:00');
  // only purchases on THIS statement (after the previous cutoff, up to this cutoff)
  const currentDueSpent = cardExpenses.filter(t => at(t) > prevCutoff && at(t) <= cutoffDate).reduce((s, t) => s + t.amount, 0);
  const nextCycleSpent = cardExpenses.filter(t => at(t) > cutoffDate).reduce((s, t) => s + t.amount, 0);
  const cutoffStr = ymd(cutoffDate);
  const paid = !!c.lastPaid && c.lastPaid >= cutoffStr;

  return { ...c, statementDay: stmtDay, dueDaysAfter, dueDate, cutoffDate, cutoffStr, paid, daysLeft, currentDueSpent, nextCycleSpent };
}

function dueBadge(s) {
  if (s.paid) return { cls: 'good', text: 'Paid ✓' };
  if (s.daysLeft === 0) return { cls: 'bad', text: 'Due Today' };
  if (s.daysLeft < 0) return { cls: 'bad', text: `${Math.abs(s.daysLeft)}d Overdue` };
  if (s.daysLeft <= 3) return { cls: 'bad', text: `Due in ${s.daysLeft}d` };
  if (s.daysLeft <= 7) return { cls: 'warn', text: `Due in ${s.daysLeft}d` };
  return { cls: 'good', text: `${s.daysLeft} days left` };
}

function renderCardReminders() {
  const el = $('cardReminders');
  if (!el) return;
  const creditCards = (state.cards || []).filter(c => c && c.type !== 'debit');
  if (creditCards.length === 0) {
    el.innerHTML = '<p class="muted">No credit cards added. Click <b>+ Manage Cards</b> to add bank cards with due date reminders.</p>';
    return;
  }

  const cardStatusList = creditCards.map(computeCardStatus)
    .sort((a, b) => (a.paid - b.paid) || (a.daysLeft - b.daysLeft));

  el.innerHTML = limited('reminders', cardStatusList).map(c => {
    const badge = dueBadge(c);
    const paidOnTxt = c.paid && isIsoDate(c.paidOn) ? ` · Paid ${fmtShort(new Date(c.paidOn + 'T00:00'))}` : '';
    return `
      <div class="card-reminder-item">
        <div class="card-info">
          <div class="card-title"><span class="bank-tag">${esc(c.bank)}</span><span>${esc(c.name)}</span></div>
          <small class="card-dates">Due: <b>${fmtShort(c.dueDate)}</b> (Cutoff: ${fmtShort(c.cutoffDate)})${paidOnTxt}</small>
        </div>
        <div class="card-status">
          <span class="due-badge ${badge.cls}">${badge.text}</span>
          <div class="card-spent-current">Due: ${money(c.currentDueSpent)}</div>
          ${c.nextCycleSpent > 0 ? `<div class="card-spent-next">Next Cycle: ${money(c.nextCycleSpent)}</div>` : ''}
          <button type="button" class="mark-paid-btn ${c.paid ? 'is-paid' : ''}" data-id="${esc(c.id)}">${c.paid ? 'Paid · Details' : 'Mark as paid'}</button>
        </div>
      </div>`;
  }).join('') + moreBtn('reminders', cardStatusList.length);
}

/* ---------- Mark as paid modal ---------- */
function openPaidModal(cardId) {
  const card = (state.cards || []).find(c => c.id === cardId);
  if (!card || !$('markPaidModal')) return;
  const s = computeCardStatus(card);
  const badge = dueBadge(s);
  paidModalCardId = cardId;

  $('paidModalTitle').textContent = s.paid ? 'Payment details' : 'Mark as paid';
  $('paidBank').textContent = card.bank;
  $('paidCardName').textContent = card.name;
  $('paidAmount').textContent = money(s.currentDueSpent);
  $('paidStatusBadge').className = 'due-badge ' + badge.cls;
  $('paidStatusBadge').textContent = badge.text;
  $('paidCutoff').textContent = fmtLong(s.cutoffDate);
  $('paidDueDate').textContent = fmtLong(s.dueDate);
  $('paidNextRow').hidden = !(s.nextCycleSpent > 0);
  $('paidNext').textContent = money(s.nextCycleSpent);
  $('paidDate').value = s.paid && isIsoDate(card.paidOn) ? card.paidOn : today();
  $('paidConfirm').textContent = s.paid ? 'Update paid date' : 'Mark as paid';
  $('paidUndo').hidden = !s.paid;
  $('markPaidModal').hidden = false;
}

function closePaidModal() {
  if ($('markPaidModal')) $('markPaidModal').hidden = true;
  paidModalCardId = null;
}

function ensureOption(sel, val) {
  if (!sel || !val) return;
  if (!Array.from(sel.options).some(o => o.value === val)) {
    const o = document.createElement('option'); o.value = val; o.textContent = val;
    sel.insertBefore(o, sel.lastElementChild);
  }
}

function fillCats(sel, type, keep) {
  if (!sel) return;
  const prev = keep ? sel.value : '';
  const catsList = type === 'expense' ? getAllExpenseCats() : getAllIncomeCats();
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
  el.innerHTML = limited('fixed', state.fixedTx).map(f => `
    <div class="fixed-item" data-id="${esc(f.id)}" style="display: flex; justify-content: space-between; align-items: center; cursor: pointer;">
      <div>
        <strong>${esc(f.title)}</strong>
        <small class="muted" style="display: block;">${esc(f.category)} (${f.type === 'income' ? 'Income' : 'Expense'}) · ${f.indefinite ? 'Ongoing monthly' : `Month ${f.monthsElapsed || 0} of ${f.totalMonths}`}</small>
      </div>
      <div style="display: flex; align-items: center; gap: 10px;">
        <b class="${f.type === 'income' ? 'in' : ''}">${f.type === 'income' ? '+' : ''}${money(f.amount)}/mo</b>
        <button type="button" class="del-fixed-btn" data-id="${esc(f.id)}" style="color: var(--bad); background: none; border: none; cursor: pointer; font-size: 16px;">✕</button>
      </div>
    </div>`).join('') + moreBtn('fixed', state.fixedTx.length);

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
      setSeg('editTypeSeg', f.type || 'expense'); fillCats($('editCategory'), f.type || 'expense');
      ensureOption($('editCategory'), f.category); $('editCategory').value = f.category;
      setSeg('editMethodSeg', f.method || 'cash'); syncEditCardSelect(f.cardId || '');
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
  if (txSearch) {
    txs = txs.filter(t => `${t.note} ${t.category} ${t.amount}`.toLowerCase().includes(txSearch));
  }
  txs = txs.slice().sort((a, b) => b.date.localeCompare(a.date) || String(b.id).localeCompare(String(a.id), undefined, { numeric: true }));

  if ($('empty')) {
    $('empty').hidden = txs.length > 0;
    $('empty').textContent = all.length ? 'No entries match your filters.' : 'Nothing logged this month.';
  }

  const visibleTxs = limited('tx', txs);
  if ($('btnSeeMoreExpenses')) {
    $('btnSeeMoreExpenses').hidden = txs.length <= LIMIT;
    $('btnSeeMoreExpenses').textContent = expanded.tx ? 'Show less' : `See all (${txs.length})`;
  }
  
  if ($('list')) {
    $('list').innerHTML = visibleTxs.map(t => {
      let methodDetail = METHOD_LABEL[t.method];
      if ((t.method === 'card' || t.method === 'debit') && t.cardId) {
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
        setSeg('editTypeSeg', tx.type || 'expense'); fillCats($('editCategory'), tx.type || 'expense');
        ensureOption($('editCategory'), tx.category); $('editCategory').value = tx.category;
        setSeg('editMethodSeg', tx.method || 'cash'); syncEditCardSelect(tx.cardId || '');
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
      <span class="participant-name" style="max-width:220px;">${esc(partLabel(p))}</span>
      ${isMeParticipant(p) ? '' : `<button type="button" class="del-participant-btn" data-idx="${idx}" aria-label="Remove participant">&times;</button>`}
    </li>`).join('');

  $$('#billParticipantsList .del-participant-btn').forEach(btn => {
    btn.onclick = () => {
      pendingParticipants.splice(Number(btn.dataset.idx), 1);
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

function renderBillList() {
  const el = $('billsList');
  if (!el) return;
  const activeGroups = (state.billGroups || []).filter(g => !g.archived);

  if (activeGroups.length === 0) {
    el.innerHTML = '<div class="empty-card card">No active bill added. Tap <b>+ Add a Bill</b> to add one or check <b>Archives</b>!</div>';
    return;
  }

  el.innerHTML = limited('bills', activeGroups).map(g => `
    <div class="bill-card" data-id="${esc(g.id)}">
      <div class="bill-card-left">
        <span class="bill-emoji">${esc(g.emoji)}</span>
        <div>
          <div class="bill-name-row"><span class="bill-name">${esc(g.name)}</span>${g.shared ? '<span class="tag shared-tag">Shared</span>' : ''}</div>
          <small class="muted fine">${g.participants.length} members (${esc(g.participants.map(p => p.name).join(', '))})</small>
        </div>
      </div>
      <span class="bill-chevron">›</span>
    </div>`).join('') + moreBtn('bills', activeGroups.length);

  $$('#billsList .bill-card').forEach(card => {
    const group = state.billGroups.find(g => g.id === card.dataset.id);
    if (!group) return;
    card.onclick = () => {
      // a long-press already opened the action sheet; don't also open the bill on release
      if (card._lpFired) { card._lpFired = false; return; }
      openBillDetail(group.id);
    };

    attachLongPress(card, () => {
      const leaving = group.shared && user && group.createdBy !== user.id;
      showActionSheet(group.name, `Members: ${group.participants.map(p => p.name).join(', ')}`, [
        {
          text: '📁 Archive Bill',
          action: async () => {
            if (await setArchived(group, true)) { renderBillList(); toast(`Archived ${group.name}`); }
          }
        },
        { text: '✏️ Edit Bill Details', action: () => openBillEditor(group) },
        { text: leaving ? '🚪 Leave Bill' : '🗑️ Delete Bill', danger: true, action: () => removeBill(group) }
      ]);
    });
  });
}

function renderArchivedBillList() {
  const el = $('archivedBillsList');
  if (!el) return;
  const archivedGroups = (state.billGroups || []).filter(g => g.archived);

  if (archivedGroups.length === 0) {
    el.innerHTML = '<div class="empty-card card">No archived bills found.</div>';
    return;
  }

  el.innerHTML = limited('archived', archivedGroups).map(g => `
    <div class="bill-card" data-id="${esc(g.id)}">
      <div class="bill-card-left">
        <span class="bill-emoji">${esc(g.emoji)}</span>
        <div class="bill-card-info">
          <div class="bill-name">${esc(g.name)}</div>
          <small class="muted fine">Archived · ${g.participants.length} members</small>
        </div>
      </div>
      <button type="button" class="unarchive-btn" data-id="${esc(g.id)}">Restore</button>
    </div>`).join('') + moreBtn('archived', archivedGroups.length);

  $$('#archivedBillsList .bill-card').forEach(card => {
    const group = state.billGroups.find(g => g.id === card.dataset.id);
    if (!group) return;
    card.onclick = (e) => {
      if (e.target.closest('.unarchive-btn')) return;
      openBillDetail(group.id);
    };
  });

  $$('#archivedBillsList .unarchive-btn').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const group = state.billGroups.find(g => g.id === btn.dataset.id);
      if (group && await setArchived(group, false)) {
        renderArchivedBillList();
        renderBillList();
        toast(`Restored "${group.name}" to active bills!`);
      }
    };
  });
}

function openBillDetail(id) {
  selectedGroupId = id;
  expanded.groupExp = false; expanded.history = false; expanded.balances = false;
  $('splitMainView').hidden = true;
  if ($('splitArchiveView')) $('splitArchiveView').hidden = true;
  $('splitDetailView').hidden = false;
  slideIn($('splitDetailView'), 1);
  renderBillDetail();
  if (mode === 'cloud') scheduleSharedReload(0);
}

function closeBillDetail() {
  selectedGroupId = null;
  expanded.groupExp = false; expanded.history = false; expanded.balances = false;
  $('splitDetailView').hidden = true;
  if ($('splitArchiveView')) $('splitArchiveView').hidden = true;
  $('splitMainView').hidden = false;
  slideIn($('splitMainView'), -1);
  renderBillList();
}


async function rpcOk(promise, failMsg) {
  try {
    const r = await promise;
    if (r && r.error) throw r.error;
    return r || {};
  } catch (e) {
    console.error(e);
    toast(failMsg || "Couldn't sync. Check your connection and try again.");
    return null;
  }
}

async function loadProfile() {
  if (!sb || mode !== 'cloud' || !user) return;
  try {
    const { data, error } = await sb.rpc('ensure_profile', { p_nickname: displayName() });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (row && row.code) {
      profile = { code: row.code, nick: row.nick || '' };
      lsSet('ledger.profile.' + user.id, JSON.stringify(profile));
    }
  } catch (e) {
    console.error('Profile error (did you run supabase-sharing.sql?):', e);
  }
  profileTried = true;
  renderSettings();
}

function scheduleNicknameSync() {
  clearTimeout(nickTimer);
  nickTimer = setTimeout(async () => { await loadProfile(); scheduleSharedReload(0); }, 900);
}

async function loadSharedBills() {
  if (!sb || mode !== 'cloud' || !user) return;
  if (loadingShared) { loadSharedAgain = true; return; }
  loadingShared = true;
  try {
    const [b, m, e, s] = await Promise.all([
      sb.from('bills').select('*'),
      sb.from('bill_members').select('bill_id,archived').eq('user_id', user.id),
      sb.from('bill_expenses').select('*'),
      sb.from('bill_settlements').select('*')
    ]);
    for (const r of [b, m, e, s]) if (r.error) throw r.error;

    const codes = new Set();
    (b.data || []).forEach(x => (x.participants || []).forEach(p => p && p.code && codes.add(p.code)));
    const nick = {};
    if (codes.size) {
      const r = await sb.rpc('lookup_profiles', { p_codes: Array.from(codes) });
      (r.data || []).forEach(x => { nick[x.code] = x.nick; });
    }
    const arch = {};
    (m.data || []).forEach(x => { arch[x.bill_id] = !!x.archived; });

    const shared = (b.data || []).map(x => ({
      id: x.id, name: x.name, emoji: x.emoji || '🐶', shared: true,
      createdBy: x.created_by, archived: !!arch[x.id],
      participants: (x.participants || []).map(p => ({
        key: p.key || p.code || p.name, code: p.code || null,
        name: (p.code && nick[p.code]) || p.name || 'Ledger user'
      })),
      expenses: (e.data || []).filter(r => r.bill_id === x.id).map(r => ({
        id: r.id, title: r.title, amount: Number(r.amount), paidBy: r.paid_by,
        participants: r.participants || [], date: r.date
      })),
      settlements: (s.data || []).filter(r => r.bill_id === x.id).map(r => ({
        id: r.id, from: r.from_key, to: r.to_key, amount: Number(r.amount),
        method: r.method || '', note: r.note || '', date: r.date
      }))
    }));

    state.billGroups = (state.billGroups || []).filter(g => !g.shared).concat(shared);
    cacheWrite();
    refreshSplitUi();
  } catch (err) {
    console.error('Shared bills load error:', err);
  }
  loadingShared = false;
  if (loadSharedAgain) { loadSharedAgain = false; scheduleSharedReload(200); }
}

function refreshSplitUi() {
  if (selectedGroupId && !state.billGroups.some(g => g.id === selectedGroupId)) {
    closeBillDetail(); toast('That bill is no longer available.');
  } else if (selectedGroupId) {
    renderBillDetail();
  }
  renderBillList();
  if ($('splitArchiveView') && !$('splitArchiveView').hidden) renderArchivedBillList();
}

function scheduleSharedReload(ms) {
  clearTimeout(sharedReloadTimer);
  sharedReloadTimer = setTimeout(loadSharedBills, ms == null ? 400 : ms);
}

function startSharedSync() {
  if (!sb || mode !== 'cloud' || !user) return;
  if (!sharedChannel) {
    try {
      sharedChannel = sb.channel('ledger-shared-' + user.id);
      ['bills', 'bill_members', 'bill_expenses', 'bill_settlements'].forEach(t => {
        sharedChannel.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => scheduleSharedReload());
      });
      sharedChannel.subscribe();
    } catch (e) { console.error('Realtime error:', e); sharedChannel = null; }
  }
  // Safety net in case a realtime message is missed (e.g. a deleted row).
  if (!sharedPollTimer) sharedPollTimer = setInterval(() => { if (!document.hidden) loadSharedBills(); }, 30000);
}

function stopSharedSync() {
  clearTimeout(sharedReloadTimer); clearInterval(sharedPollTimer); sharedPollTimer = null;
  if (sharedChannel && sb) { try { sb.removeChannel(sharedChannel); } catch {} }
  sharedChannel = null;
}

const partsPayload = parts => parts.map(p => ({ key: p.key, name: p.name, code: p.code || null }));
const saveBillRemote = (id, name, emoji, parts) =>
  rpcOk(sb.rpc('upsert_bill', { p_id: id, p_name: name, p_emoji: emoji, p_participants: partsPayload(parts) }),
        "Couldn't save the bill. Check your connection and try again.");
const expenseRow = (billId, e) => ({
  id: e.id, bill_id: billId, title: e.title, amount: e.amount, paid_by: e.paidBy,
  participants: e.participants, date: e.date, updated_at: new Date().toISOString()
});
const persistGroup = g => { if (g.shared) cacheWrite(); else save(); };

function openBillEditor(group) {
  $('groupModalTitle').textContent = group ? 'Edit Bill' : 'Add a Bill';
  $('editGroupId').value = group ? group.id : '';
  $('personNameInput').value = group ? group.name : '';
  updateModalEmojiDisplay(group ? (group.emoji || '🐶') : '🐶');
  if ($('btnDeleteGroup')) {
    $('btnDeleteGroup').hidden = !group;
    const others = group && group.shared && user && group.createdBy !== user.id;
    $('btnDeleteGroup').textContent = others ? 'Leave Bill' : 'Delete Bill';
  }
  pendingParticipants = group ? group.participants.map(p => ({ ...p })) : [meParticipant()];
  renderPendingParticipants();
  $('addPersonModal').hidden = false;
  if (!group) $('personNameInput').focus();
}

async function setArchived(group, val) {
  if (group.shared) {
    const r = await rpcOk(sb.from('bill_members').update({ archived: val }).eq('bill_id', group.id).eq('user_id', user.id),
                          "Couldn't update the bill.");
    if (!r) return false;
  }
  group.archived = val; persistGroup(group);
  return true;
}

async function removeBill(group) {
  const creator = !group.shared || (user && group.createdBy === user.id);
  const msg = !group.shared ? `Delete bill "${group.name}" permanently?`
    : creator ? `Delete "${group.name}" for everyone? This can't be undone.`
    : `Leave "${group.name}"? It will disappear from your Split tab.`;
  if (!confirm(msg)) return;
  if (group.shared) {
    const r = creator
      ? await rpcOk(sb.from('bills').delete().eq('id', group.id), "Couldn't delete the bill.")
      : await rpcOk(sb.rpc('leave_bill', { p_bill: group.id }), "Couldn't leave the bill.");
    if (!r) return;
  }
  state.billGroups = state.billGroups.filter(g => g.id !== group.id);
  persistGroup(group);
  if (selectedGroupId === group.id) closeBillDetail(); else renderBillList();
  if ($('splitArchiveView') && !$('splitArchiveView').hidden) renderArchivedBillList();
  toast(creator ? 'Bill deleted' : 'You left the bill');
}

function calculateGroupBalance(group) {
  const me = myKeyFor(group);
  const keys = new Set((group.participants || []).map(p => p.key));
  if (!group.shared && me) keys.add(me);
  (group.expenses || []).forEach(e => {
    keys.add(e.paidBy || me);
    if (Array.isArray(e.participants)) e.participants.forEach(k => keys.add(k));
  });
  (group.settlements || []).forEach(s => { keys.add(s.from); keys.add(s.to); });

  const balances = {};
  keys.forEach(k => balances[k] = 0);

  let totalExpenses = 0;
  (group.expenses || []).forEach(e => {
    const amt = Number(e.amount) || 0;
    const paidBy = e.paidBy || me;
    balances[paidBy] = (balances[paidBy] || 0) + amt;
    totalExpenses += amt;

    const beneficiaries = (Array.isArray(e.participants) && e.participants.length > 0)
      ? e.participants
      : (group.participants || []).map(p => p.key);

    const share = amt / (beneficiaries.length || 1);
    beneficiaries.forEach(k => { balances[k] = (balances[k] || 0) - share; });
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

  const myNet = balances[me] || 0;
  return { balances, settlements, totalExpenses, myNet };
}

function renderBillDetail() {
  const group = (state.billGroups || []).find(g => g.id === selectedGroupId);
  if (!group) { closeBillDetail(); return; }

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

  if (activeSplitTab === 'expenses') renderBillExpensesList(group);
  else if (activeSplitTab === 'balances') renderBillBalancesTab(group);
  else if (activeSplitTab === 'history') renderBillHistoryTab(group);
}

function renderBillExpensesList(group) {
  const el = $('splitExpensesGroupedList');
  const seeAllBtn = $('btnSeeAllGroupExpenses');
  if (!el) return;

  if (!group.expenses || group.expenses.length === 0) {
    el.innerHTML = '<div class="empty card" style="padding: 20px 16px;">No expenses logged in <b>' + esc(group.name) + '</b>. Tap <b>+ Add Expense to Bill</b> above to start logging.</div>';
    if (seeAllBtn) seeAllBtn.hidden = true;
    return;
  }

  const totalCount = group.expenses.length;
  let allSortedExps = group.expenses.slice().sort((a, b) => b.date.localeCompare(a.date) || String(b.id).localeCompare(String(a.id)));

  allSortedExps = limited('groupExp', allSortedExps);

  if (seeAllBtn) {
    seeAllBtn.hidden = totalCount <= LIMIT;
    seeAllBtn.textContent = expanded.groupExp ? 'Show less' : `See all (${totalCount})`;
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
        : (group.participants || []).map(p => p.key);

      const chipsHtml = beneficiaries.map(k => `
        <span class="share-avatar-chip">👤 ${esc(shortFor(group, k))}</span>
      `).join('');

      return `
        <div class="bill-expense-card edit-split-exp-btn" data-id="${esc(exp.id)}" style="cursor: pointer;">
          <div class="exp-left">
            <div>
              <div class="exp-title">
                <b>${esc(exp.title)}</b>
              </div>
              <div class="exp-sub" style="margin-top: 2px;">Paid by <b>${esc(labelFor(group, exp.paidBy))}</b></div>
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

function renderBillBalancesTab(group) {
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

  list.innerHTML = limited('balances', settlements).map(s => `
    <div class="srow settle-row" data-from="${esc(s.from)}" data-to="${esc(s.to)}" data-amount="${s.amount}" title="Tap to record this payment">
      <div class="user-item">
        <div class="user-avatar-circle" style="background: var(--bar); color: var(--text);">💸</div>
        <div><strong>${esc(labelFor(group, s.from))}</strong> owes <strong>${esc(labelFor(group, s.to))}</strong></div>
      </div>
      <span class="bold">${money(s.amount)}</span>
    </div>`).join('') + moreBtn('balances', settlements.length);
}

function renderBillHistoryTab(group) {
  const el = $('splitHistoryList');
  if (!el) return;

  const history = group.settlements || [];
  if (history.length === 0) {
    el.innerHTML = '<p class="muted">No payments or reimbursements recorded yet.</p>';
    return;
  }

  el.innerHTML = limited('history', history.slice().reverse()).map(s => `
    <div class="history-item">
      <div>
        <strong>${esc(labelFor(group, s.from))}</strong> paid <strong>${esc(labelFor(group, s.to))}</strong>
        <small class="muted" style="display: block;">${esc(s.method || 'GCash')} · ${s.date || today()} ${s.note ? '· ' + esc(s.note) : ''}</small>
      </div>
      <div style="display:flex;align-items:center;gap:10px;"><b class="pos-text">+${money(s.amount)}</b><button type="button" class="del-settle-btn" data-id="${esc(s.id)}" aria-label="Delete payment">✕</button></div>
    </div>
  `).join('') + moreBtn('history', history.length);
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

    const group = state.billGroups.find(g => g.id === selectedGroupId);
    if (!group) return;

    const me = myKeyFor(group);
    const allKeys = group.participants.map(p => p.key);
    const keyForName = n => {
      const t = String(n || '').trim().toLowerCase();
      const hit = group.participants.find(p => p.key.toLowerCase() === t || p.name.toLowerCase() === t);
      return hit ? hit.key : me;
    };

    const imported = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i]);
      if (cols.length < 2) continue;
      const title = cols[descIdx >= 0 ? descIdx : 1] || 'Imported Expense';
      const amount = Math.round((parseFloat((cols[costIdx >= 0 ? costIdx : 2] || '0').replace(/[^0-9.]/g, '')) || 0) * 100) / 100;
      const paidBy = keyForName(cols[payerIdx >= 0 ? payerIdx : 3]);
      const rawDate = cols[dateIdx >= 0 ? dateIdx : 0] || '';
      const date = isIsoDate(rawDate) ? rawDate : today();
      if (amount > 0) imported.push({ id: uid(), title, amount, paidBy, participants: [...allKeys], date });
    }
    if (!imported.length) { toast('No valid expenses found in that file.'); return; }

    if (group.shared) {
      const r = await rpcOk(sb.from('bill_expenses').insert(imported.map(x => expenseRow(group.id, x))),
                            "Couldn't import. Check your connection and try again.");
      if (!r) return;
    }
    group.expenses.push(...imported);
    persistGroup(group);
    renderBillDetail(); toast(`Successfully imported ${imported.length} expenses!`);
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

      const rawDate = cols[dateIdx >= 0 ? dateIdx : 0] || '';
      newTxList.push({
        id: Date.now() + Math.random(), type, amount: amtVal, category: cat, method, cardId: '',
        note: cols[noteIdx >= 0 ? noteIdx : 5] || '', date: isIsoDate(rawDate) ? rawDate : today()
      });
      importedCount++;
    }

    if (importedCount > 0) {
      if (confirm(`Replace current ledger with ${importedCount} imported transactions?`)) state.tx = newTxList;
      else state.tx = state.tx.concat(newTxList);
      save(); renderAll(); toast(`Successfully imported ${importedCount} transactions!`);
    } else {
      toast('No valid transactions found in that file.');
    }
  };
  reader.readAsText(file);
}

function renderSettings() {
  const cl = $('cardsList');
  if (cl) {
    const all = (state.cards || []).slice().sort((a, b) => (a.type === b.type ? 0 : a.type === 'credit' ? -1 : 1));
    const nCredit = all.filter(c => c.type === 'credit').length, nDebit = all.length - nCredit;
    if ($('cardsSummary')) $('cardsSummary').textContent = all.length ? `${nCredit} credit · ${nDebit} debit` : '';
    setSeg('cardsFilterSeg', cardsFilter);
    const shown = all.filter(c => cardsFilter === 'all' || c.type === cardsFilter);
    if (!shown.length) {
      cl.innerHTML = `<div class="srow"><span class="fine">${all.length ? 'No ' + cardsFilter + ' cards yet.' : 'No cards added yet.'}</span></div>`;
    } else {
      cl.innerHTML = limited('cards', shown).map(c => `
        <div class="card-item">
          <div class="card-item-details">
            <strong><span class="type-pill ${c.type}">${c.type === 'debit' ? 'Debit' : 'Credit'}</span>${esc(c.bank)} - ${esc(c.name)}</strong>
            <small>${c.type === 'debit' ? 'Used for debit card payments' : `Statement: Day ${c.statementDay} · Due: ${c.dueDaysAfter || 21} days after statement`}</small>
          </div>
          <div class="card-item-actions">
            <button type="button" class="icon-btn edit-card-btn" data-id="${esc(c.id)}">Edit</button>
            <button type="button" class="icon-btn del-card-btn" data-id="${esc(c.id)}">✕</button>
          </div>
        </div>`).join('') + moreBtn('cards', shown.length);
    }
  }

  if ($('displayUserCode')) {
    $('displayUserCode').textContent = mode === 'cloud'
      ? (profile ? '#' + profile.code : (profileTried ? 'Unavailable' : 'Loading…'))
      : 'Sign in to get one';
  }
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
    if (idx >= 0) state.cards[idx] = Object.assign({}, state.cards[idx], cardData);
  } else {
    cardData.id = 'c_' + Date.now();
    state.cards.push(cardData);
  }
  save(); renderAll();
}

function deleteCard(id) {
  if (!confirm('Delete this card? Existing transactions will stay intact.')) return;
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

// Shared bills live in their own server tables, so they are never copied into the private ledger_data row.
function ledgerSnapshot() {
  const snap = JSON.parse(JSON.stringify(state));
  snap.billGroups = (snap.billGroups || []).filter(g => !g.shared);
  return snap;
}

let pushTimer = null, pushing = false, pushAgain = false;
function schedulePush(ms) { clearTimeout(pushTimer); pushTimer = setTimeout(push, ms == null ? 800 : ms); }

async function push() {
  if (mode !== 'cloud' || !sb || !user) return;
  if (pushing) { pushAgain = true; return; }
  pushing = true; setSync('Syncing…');
  const stamp = state.updated;
  try {
    const { error } = await sb.from('ledger_data').upsert({
      user_id: user.id, data: ledgerSnapshot(), updated_at: new Date().toISOString()
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
        const keepShared = (state.billGroups || []).filter(g => g.shared);
        state = remote;
        state.billGroups = (remote.billGroups || []).filter(g => !g.shared).concat(keepShared);
        cacheWrite(); renderAll();
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
  if (mode === 'cloud' && user && user.id === u.id) { user = u; return; }
  mode = 'cloud'; user = u;
  lsDel('ledger.mode');
  lsSet('ledger.lastUser', JSON.stringify({ id: u.id, email: u.email || '' }));
  state = readStore(storeKey()) || blank();
  try { profile = JSON.parse(lsGet('ledger.profile.' + u.id) || 'null'); } catch { profile = null; }
  profileTried = !!profile;
  showApp(); setSync('Syncing…');
  await pull();
  await loadProfile();
  await loadSharedBills();
  startSharedSync();
}

async function signOut() {
  if (mode === 'cloud' && isDirty()) {
    await push();
    if (isDirty() && !confirm('Unsynced changes exist. Sign out anyway?')) return;
  }
  const uid0 = user && user.id;
  stopSharedSync();
  try { if (sb) await sb.auth.signOut(); } catch {}
  if (uid0) { lsDel('ledger.cloud.' + uid0); lsDel('ledger.dirty.' + uid0); lsDel('ledger.profile.' + uid0); }
  lsDel('ledger.lastUser'); lsDel('ledger.mode');
  mode = 'none'; user = null; profile = null; profileTried = false; state = blank();
  selectedGroupId = null;
  location.hash = ''; showAuth();
}

function authMsg(text, ok) { const m = $('authMsg'); if (m) { m.textContent = text || ''; m.classList.toggle('ok', !!ok); } }

function friendlyAuthError(err) {
  const m = (err && (err.message || err.msg || err.error_description)) || 'Something went wrong. Please try again.';
  if (/rate limit|too many/i.test(m)) return 'Too many attempts. Please wait a bit and try again.';
  if (/fetch|network/i.test(m)) return "Can't reach the server. Check your connection.";
  if (/provider is not enabled|unsupported provider/i.test(m)) return 'That sign-in method is not turned on yet. Enable it in your Supabase dashboard (Authentication → Providers).';
  if (/invalid.*email|email.*invalid/i.test(m)) return 'That email address does not look right.';
  return m;
}

const authRedirect = () => window.location.origin + window.location.pathname;

async function signInWithProvider(provider, label) {
  if (!CLOUD || !sb) {
    authMsg('Supabase credentials missing in config.js. Add valid SUPABASE_URL & SUPABASE_ANON_KEY to enable sign-in.');
    return;
  }
  authMsg(`Redirecting to ${label}...`, true);
  try {
    const { error } = await sb.auth.signInWithOAuth({
      provider,
      options: { redirectTo: authRedirect() }
    });
    if (error) throw error;
  } catch (err) {
    authMsg(friendlyAuthError(err));
  }
}
const signInWithGoogle = () => signInWithProvider('google', 'Google');
const signInWithApple  = () => signInWithProvider('apple', 'Apple');

async function signInWithEmailLink(e) {
  if (e) e.preventDefault();
  if (!CLOUD || !sb) {
    authMsg('Supabase credentials missing in config.js. Add valid SUPABASE_URL & SUPABASE_ANON_KEY to enable sign-in.');
    return;
  }
  const email = ($('authEmail') ? $('authEmail').value : '').trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) { authMsg('Enter a valid email address.'); return; }
  const btn = $('authEmailBtn');
  if (btn) btn.disabled = true;
  authMsg('Sending your sign-in link...', true);
  try {
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: authRedirect() } });
    if (error) throw error;
    authMsg('Check your inbox and tap the link to finish signing in.', true);
  } catch (err) {
    authMsg(friendlyAuthError(err));
  }
  if (btn) btn.disabled = false;
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
  initModalAnimations();

  // "See all" / "Show less" for every long list
  document.addEventListener('click', e => {
    const b = e.target.closest('.see-all-btn'); if (!b) return;
    const key = b.dataset.key;
    expanded[key] = !expanded[key];
    const fn = { cards: renderSettings, tx: renderExpenses, fixed: renderFixedExpenses, bills: renderBillList,
                 archived: renderArchivedBillList, reminders: renderCardReminders, groupExp: renderBillDetail,
                 history: renderBillDetail, balances: renderBillDetail }[key] || renderAll;
    fn();
  });

  // credit card: open the "Mark as paid" sheet
  on('cardReminders', 'click', e => {
    const b = e.target.closest('.mark-paid-btn'); if (!b) return;
    openPaidModal(b.dataset.id);
  });

  on('paidForm', 'submit', e => {
    e.preventDefault();
    const card = state.cards.find(c => c.id === paidModalCardId); if (!card) { closePaidModal(); return; }
    const s = computeCardStatus(card);
    const when = isIsoDate($('paidDate').value) ? $('paidDate').value : today();
    card.lastPaid = s.cutoffStr;
    card.paidOn = when;
    save(); closePaidModal(); renderCardReminders();
    toast(`${card.bank} marked as paid`);
  });
  on('paidUndo', 'click', () => {
    const card = state.cards.find(c => c.id === paidModalCardId); if (!card) { closePaidModal(); return; }
    card.lastPaid = ''; card.paidOn = '';
    save(); closePaidModal(); renderCardReminders();
    toast('Paid mark removed');
  });
  on('paidCancel', 'click', closePaidModal);

  on('txSearch', 'input', () => { txSearch = $('txSearch').value.trim().toLowerCase(); expanded.tx = false; renderExpenses(); });

  on('splitHistoryList', 'click', async e => {
    const b = e.target.closest('.del-settle-btn'); if (!b) return;
    const group = state.billGroups.find(g => g.id === selectedGroupId);
    if (!group || !confirm('Delete this recorded payment?')) return;
    if (group.shared) {
      const r = await rpcOk(sb.from('bill_settlements').delete().eq('id', b.dataset.id).select('id'), "Couldn't delete the payment.");
      if (!r) return;
      if (!(r.data || []).length) { toast("Couldn't delete that payment (no permission)."); return; }
    }
    group.settlements = (group.settlements || []).filter(x => String(x.id) !== b.dataset.id);
    persistGroup(group); renderBillDetail(); toast('Payment deleted');
  });

  // tap outside a sheet / press Escape to close it
  let downTarget = null;
  document.addEventListener('pointerdown', e => { downTarget = e.target; });
  document.addEventListener('click', e => {
    const t = e.target;
    if (t === downTarget && t.classList && (t.classList.contains('modal-backdrop') || t.classList.contains('action-sheet-backdrop'))) t.hidden = true;
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') $$('.modal-backdrop:not([hidden]), .action-sheet-backdrop:not([hidden])').forEach(m => { m.hidden = true; });
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && mode === 'cloud') loadSharedBills();
  });
  window.addEventListener('online', () => { if (mode === 'cloud') { schedulePush(0); loadSharedBills(); } });

  if ($('displayUserCode')) {
    $('displayUserCode').onclick = () => {
      if (profile && profile.code) {
        copyToClipboard('#' + profile.code);
        toast(`Copied your Ledger ID: #${profile.code}`);
      }
    };
  }

  on('txViewSeg', 'click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const was = txViewTab;
    txViewTab = b.dataset.v; setSeg('txViewSeg', txViewTab);
    if ($('tabExpensesView')) $('tabExpensesView').hidden = txViewTab !== 'expenses';
    if ($('tabRecurringView')) $('tabRecurringView').hidden = txViewTab !== 'recurring';
    if (was !== txViewTab) slideIn($(txViewTab === 'expenses' ? 'tabExpensesView' : 'tabRecurringView'), txViewTab === 'recurring' ? 1 : -1);
  });

  if ($('btnAddExpenseBtn')) {
    $('btnAddExpenseBtn').onclick = () => {
      if ($('date')) $('date').value = today();
      if ($('addExpenseModal')) $('addExpenseModal').hidden = false;
    };
  }

  if ($('addExpenseCancel')) $('addExpenseCancel').onclick = () => { if ($('addExpenseModal')) $('addExpenseModal').hidden = true; };
  window.addEventListener('hashchange', () => { if ($('app') && !$('app').hidden) route(); });

  document.addEventListener('click', e => {
    const b = e.target.closest('button[data-m]'); if (!b) return;
    view = new Date(view.getFullYear(), view.getMonth() + Number(b.dataset.m), 1);
    expanded.tx = false; renderAll();
  });

  if ($('btnManageCardsHome')) $('btnManageCardsHome').onclick = () => { location.hash = '#settings'; };

  on('typeSeg', 'click', e => {
    const b = e.target.closest('button'); if (!b) return;
    setSeg('typeSeg', b.dataset.v);
    const type = addFormType();
    if ($('methodWrap')) $('methodWrap').hidden = type !== 'expense';
    fillCats($('category'), type);
    syncCustomCatField();
    syncAddCardSelect();
  });

  on('methodSeg', 'click', e => {
    const b = e.target.closest('button'); if (!b) return;
    setSeg('methodSeg', b.dataset.v);
    syncAddCardSelect();
  });

  on('category', 'change', syncCustomCatField);
  on('isRecurring', 'change', () => { if ($('recurringOptionsWrap')) $('recurringOptionsWrap').hidden = !$('isRecurring').checked; });
  on('isIndefinite', 'change', () => { if ($('recurMonthsWrap')) $('recurMonthsWrap').hidden = $('isIndefinite').checked; });

  on('form', 'submit', e => {
    e.preventDefault();
    const amount = parseFloat($('amount').value);
    if (!(amount > 0)) return;

    const type = addFormType();
    const method = type === 'expense' ? addFormMethod() : 'cash';
    let catVal = $('category') ? $('category').value : 'Other';
    if (catVal === 'Other') {
      const typed = $('customCategoryInput') ? $('customCategoryInput').value.trim() : '';
      if (typed) catVal = registerCustomCategory(typed, type) || 'Other';
    }
    const cardId = (type === 'expense' && (method === 'card' || method === 'debit') && $('cardSelect')) ? $('cardSelect').value : '';
    let noteVal = $('note').value.trim();
    const dateVal = $('date').value || today();

    const makeRecurring = $('isRecurring') && $('isRecurring').checked;
    if (makeRecurring) {
      noteVal = noteVal || catVal;
      const indefinite = !$('isIndefinite') || $('isIndefinite').checked;
      state.fixedTx.push({
        id: 'f_' + Date.now(), title: noteVal, amount, category: catVal, type, method, cardId,
        indefinite, totalMonths: Math.max(1, parseInt($('recurTotalMonths') && $('recurTotalMonths').value) || 12),
        monthsElapsed: 1, startDate: dateVal
      });
    }

    addTx({ type, amount, category: catVal, method, cardId, note: noteVal, date: dateVal });

    // reset the modal for next time
    $('amount').value = ''; $('note').value = '';
    if ($('customCategoryInput')) $('customCategoryInput').value = '';
    if ($('category')) $('category').selectedIndex = 0;
    syncCustomCatField();
    if ($('isRecurring')) { $('isRecurring').checked = false; if ($('recurringOptionsWrap')) $('recurringOptionsWrap').hidden = true; }
    if ($('date')) $('date').value = today();
    if ($('addExpenseModal')) $('addExpenseModal').hidden = true;
    toast(makeRecurring ? 'Logged and set to recur monthly' : 'Logged!');
  });

  // ----- edit modal wiring -----
  on('editTypeSeg', 'click', e => {
    const b = e.target.closest('button'); if (!b) return;
    setSeg('editTypeSeg', b.dataset.v);
    const keepCat = $('editCategory').value;
    fillCats($('editCategory'), b.dataset.v);
    ensureOption($('editCategory'), keepCat);
    if (Array.from($('editCategory').options).some(o => o.value === keepCat)) $('editCategory').value = keepCat;
    syncEditCardSelect();
  });
  on('editMethodSeg', 'click', e => {
    const b = e.target.closest('button'); if (!b) return;
    setSeg('editMethodSeg', b.dataset.v);
    syncEditCardSelect();
  });
  on('editIsIndefinite', 'change', () => { if ($('editRecurMonthsWrap')) $('editRecurMonthsWrap').hidden = $('editIsIndefinite').checked; });

  if ($('btnDeleteExpenseFromModal')) {
    $('btnDeleteExpenseFromModal').onclick = () => {
      const id = $('editTxId').value;
      const isRecur = $('editIsRecurringItem').value === 'true';
      if (!confirm(isRecur ? 'Delete this recurring schedule and all logged instances?' : 'Delete this entry?')) return;
      if (isRecur) {
        state.tx = state.tx.filter(t => !String(t.id).startsWith('auto_' + id));
        state.fixedTx = state.fixedTx.filter(x => x.id !== id);
      } else {
        const removed = state.tx.find(t => String(t.id) === id);
        state.tx = state.tx.filter(t => String(t.id) !== id);
        // deleting an auto-logged recurring entry should not bring it back
        const m = /^auto_(.+)_(\d{4}-\d{2})$/.exec(id);
        const sched = m ? state.fixedTx.find(x => x.id === m[1]) : null;
        if (sched) { sched.skip = (sched.skip || []).concat(m[2]); }
        save(); $('editExpenseModal').hidden = true; renderAll();
        toast('Entry deleted', 'Undo', () => {
          if (!removed) return;
          if (sched) sched.skip = (sched.skip || []).filter(x => x !== m[2]);
          state.tx.push(removed); save(); renderAll();
        });
        return;
      }
      save(); $('editExpenseModal').hidden = true; renderAll(); toast('Deleted');
    };
  }

  on('editExpenseForm', 'submit', e => {
    e.preventDefault();
    const id = $('editTxId').value;
    const isRecur = $('editIsRecurringItem').value === 'true';
    const amt = parseFloat($('editAmount').value) || 0;
    const cat = $('editCategory').value;
    const note = $('editNote').value.trim();
    const date = $('editDate').value || today();
    const activeType = editFormType();
    const activeMethod = activeType === 'expense' ? editFormMethod() : 'cash';
    const cardId = activeType === 'expense' && (activeMethod === 'card' || activeMethod === 'debit') && $('editCardSelect') ? $('editCardSelect').value : '';

    if (isRecur) {
      const f = state.fixedTx.find(x => x.id === id);
      if (f) {
        f.amount = amt; f.category = cat; f.title = note || cat; f.type = activeType; f.method = activeMethod; f.cardId = cardId;
        f.indefinite = !$('editIsIndefinite') || $('editIsIndefinite').checked;
        f.totalMonths = Math.max(1, parseInt($('editRecurTotalMonths') && $('editRecurTotalMonths').value) || 12);
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
      renderArchivedBillList();
    };
  }

  if ($('btnArchiveBack')) {
    $('btnArchiveBack').onclick = () => {
      $('splitArchiveView').hidden = true;
      $('splitMainView').hidden = false;
      renderBillList();
    };
  }

  if ($('btnSplitBack')) $('btnSplitBack').onclick = closeBillDetail;

  if ($('btnAddPersonFabTop')) $('btnAddPersonFabTop').onclick = () => openBillEditor(null);

  if ($('btnEditGroupTitle')) {
    $('btnEditGroupTitle').onclick = () => {
      const group = state.billGroups.find(g => g.id === selectedGroupId);
      if (group) openBillEditor(group);
    };
  }

  if ($('addPersonCancel')) $('addPersonCancel').onclick = () => { $('addPersonModal').hidden = true; };

  async function addPendingParticipant() {
    const input = $('newParticipantName');
    const btn = $('btnAddParticipantBtn');
    const raw = input.value.trim();
    if (!raw) return;
    const code = parseLedgerId(raw);

    if (code) {
      if (mode !== 'cloud' || !sb) { toast('Sign in to add people by Ledger ID.'); return; }
      if (pendingParticipants.some(p => p.code === code)) { toast('That person is already added.'); return; }
      btn.disabled = true;
      const r = await rpcOk(sb.rpc('lookup_profiles', { p_codes: [code] }), "Couldn't look up that ID. Check your connection.");
      btn.disabled = false;
      if (!r) return;
      const hit = (r.data || [])[0];
      if (!hit) { toast(`No Ledger account found for #${code}.`); return; }
      pendingParticipants.push({ key: code, name: hit.nick || 'Ledger user', code });
      toast(`Added ${hit.nick || 'Ledger user'} (#${code})`);
    } else {
      if (pendingParticipants.some(p => !p.code && p.name.toLowerCase() === raw.toLowerCase())) { toast('That name is already added.'); return; }
      pendingParticipants.push({ key: raw, name: raw, code: null });
    }
    input.value = '';
    renderPendingParticipants();
  }

  if ($('btnAddParticipantBtn')) $('btnAddParticipantBtn').onclick = addPendingParticipant;
  on('newParticipantName', 'keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addPendingParticipant(); } });

  on('addPersonForm', 'submit', async e => {
    e.preventDefault();
    const name = $('personNameInput').value.trim();
    const editId = $('editGroupId').value;
    const finalEmoji = ($('customEmojiInput') ? $('customEmojiInput').value.trim() : '') || '🐶';

    if (!name || pendingParticipants.length === 0) {
      toast('Please enter a bill name and add at least 1 participant.');
      return;
    }
    const parts = pendingParticipants.map(p => ({ ...p }));
    let sharedWith = 0;

    if (editId) {
      const group = state.billGroups.find(g => g.id === editId);
      if (!group) return;
      if (group.shared && !(await saveBillRemote(group.id, name, finalEmoji, parts))) return;
      group.name = name; group.emoji = finalEmoji; group.participants = parts;
      persistGroup(group);
      sharedWith = group.shared ? parts.filter(p => p.code && !isMeParticipant(p)).length : 0;
    } else if (mode === 'cloud' && sb && profile) {
      const g = {
        id: uid(), name, emoji: finalEmoji, archived: false, shared: true,
        createdBy: user.id, meKey: profile.code, participants: parts, settlements: [], expenses: []
      };
      if (!(await saveBillRemote(g.id, name, finalEmoji, parts))) return;
      state.billGroups.push(g); cacheWrite();
      sharedWith = parts.filter(p => p.code && !isMeParticipant(p)).length;
    } else {
      if (mode === 'cloud') toast('Sync is not set up yet, so this bill stays on this device.');
      state.billGroups.push({
        id: 'g_' + Date.now(), name, emoji: finalEmoji, archived: false, shared: false,
        meKey: meParticipant().key, participants: parts, settlements: [], expenses: []
      });
      save();
    }

    $('addPersonModal').hidden = true;
    if (selectedGroupId) renderBillDetail(); else renderBillList();
    toast(sharedWith ? `Saved and shared with ${sharedWith} ${sharedWith === 1 ? 'person' : 'people'}` : (editId ? 'Saved bill updates!' : 'Bill created!'));
  });

  if ($('btnDeleteGroup')) {
    $('btnDeleteGroup').onclick = () => {
      const g = state.billGroups.find(x => x.id === $('editGroupId').value);
      if (!g) return;
      $('addPersonModal').hidden = true;
      removeBill(g);
    };
  }

  if ($('btnImportSplitwise')) $('btnImportSplitwise').onclick = () => $('splitwiseCsvInput').click();
  on('splitwiseCsvInput', 'change', e => {
    importSplitwiseCsv(e.target.files[0]); e.target.value = '';
  });

  on('splitDetailTabs', 'click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const order = ['expenses', 'balances', 'history'];
    const was = activeSplitTab;
    activeSplitTab = b.dataset.v; renderBillDetail();
    if (was !== activeSplitTab) slideIn($({ expenses: 'splitTabExpenses', balances: 'splitTabBalances', history: 'splitTabHistory' }[activeSplitTab]), order.indexOf(activeSplitTab) > order.indexOf(was) ? 1 : -1);
  });

  function renderParticipantToggleGrid(group) {
    const grid = $('splitParticipantsToggleGrid');
    if (!grid) return;
    grid.innerHTML = group.participants.map(p => {
      const isSelected = selectedSplitParticipants.includes(p.key);
      return `<button type="button" class="part-chip-toggle ${isSelected ? 'on' : ''}" data-person="${esc(p.key)}">${isSelected ? '✓ ' : ''}${esc(partLabel(p))}</button>`;
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

  const paidByOptions = group => group.participants.map(p => `<option value="${esc(p.key)}">${esc(partLabel(p))}</option>`).join('');

  if ($('btnOpenAddSplitExpense')) {
    $('btnOpenAddSplitExpense').onclick = () => {
      const group = state.billGroups.find(g => g.id === selectedGroupId);
      if (!group) return;
      if (!group.participants.length) { toast('Add participants to this bill first.'); return; }

      $('splitExpenseModalTitle').textContent = 'Add Shared Expense';
      $('splitExpId').value = '';
      $('splitExpTitle').value = '';
      $('splitExpAmount').value = '';
      $('splitExpDate').value = today();

      $('splitExpPaidBy').innerHTML = paidByOptions(group);
      const me = myKeyFor(group);
      $('splitExpPaidBy').value = group.participants.some(p => p.key === me) ? me : group.participants[0].key;

      selectedSplitParticipants = group.participants.map(p => p.key);
      renderParticipantToggleGrid(group);

      if ($('btnDeleteSplitExpense')) $('btnDeleteSplitExpense').hidden = true;
      $('addSplitExpenseModal').hidden = false;
      $('splitExpTitle').focus();
    };
  }

  if ($('addSplitExpenseCancel')) $('addSplitExpenseCancel').onclick = () => { $('addSplitExpenseModal').hidden = true; };

  on('addSplitExpenseForm', 'submit', async e => {
    e.preventDefault();
    const expId = $('splitExpId').value;
    const title = $('splitExpTitle').value.trim();
    const amount = Math.round((parseFloat($('splitExpAmount').value) || 0) * 100) / 100;
    const dateVal = $('splitExpDate').value || today();
    const paidBy = $('splitExpPaidBy').value;

    const group = state.billGroups.find(g => g.id === selectedGroupId);
    if (!group || !title || !(amount > 0)) return;

    const existing = expId ? group.expenses.find(x => x.id === expId) : null;
    const exp = { id: existing ? existing.id : uid(), title, amount, paidBy, participants: [...selectedSplitParticipants], date: dateVal };

    if (group.shared) {
      const r = await rpcOk(sb.from('bill_expenses').upsert(expenseRow(group.id, exp)), "Couldn't save the expense. Check your connection and try again.");
      if (!r) return;
    }
    if (existing) Object.assign(existing, exp); else group.expenses.push(exp);
    persistGroup(group);
    $('addSplitExpenseModal').hidden = true; renderBillDetail(); toast('Expense saved to bill!');
  });

  on('splitExpensesGroupedList', 'click', e => {
    const card = e.target.closest('.edit-split-exp-btn');
    if (!card) return;
    const group = state.billGroups.find(g => g.id === selectedGroupId);
    if (!group) return;

    const exp = group.expenses.find(x => String(x.id) === card.dataset.id);
    if (exp) {
      $('splitExpenseModalTitle').textContent = 'Edit Shared Expense';
      $('splitExpId').value = exp.id;
      $('splitExpTitle').value = exp.title;
      $('splitExpAmount').value = exp.amount;
      $('splitExpDate').value = exp.date;

      $('splitExpPaidBy').innerHTML = paidByOptions(group);
      $('splitExpPaidBy').value = exp.paidBy;

      selectedSplitParticipants = Array.isArray(exp.participants) && exp.participants.length > 0
        ? [...exp.participants] : group.participants.map(p => p.key);
      renderParticipantToggleGrid(group);

      if ($('btnDeleteSplitExpense')) $('btnDeleteSplitExpense').hidden = false;
      $('addSplitExpenseModal').hidden = false;
    }
  });

  if ($('btnDeleteSplitExpense')) {
    $('btnDeleteSplitExpense').onclick = async () => {
      const expId = $('splitExpId').value;
      const group = state.billGroups.find(g => g.id === selectedGroupId);
      if (!group || !expId || !confirm('Delete this bill expense?')) return;
      if (group.shared) {
        const r = await rpcOk(sb.from('bill_expenses').delete().eq('id', expId), "Couldn't delete the expense.");
        if (!r) return;
      }
      group.expenses = group.expenses.filter(x => String(x.id) !== expId);
      persistGroup(group);
      $('addSplitExpenseModal').hidden = true; renderBillDetail(); toast('Expense deleted');
    };
  }

  if ($('btnSettleUp')) {
    const openSettle = pre => {
      const group = state.billGroups.find(g => g.id === selectedGroupId);
      if (!group) return;

      const opts = paidByOptions(group);
      if ($('settlePayer')) $('settlePayer').innerHTML = opts;
      if ($('settleReceiver')) $('settleReceiver').innerHTML = opts;
      const me = myKeyFor(group);
      if ($('settlePayer') && group.participants.some(p => p.key === me)) $('settlePayer').value = me;
      const other = group.participants.find(p => p.key !== $('settlePayer').value);
      if ($('settleReceiver') && other) $('settleReceiver').value = other.key;
      if ($('settleAmount')) $('settleAmount').value = '';
      if ($('settleNote')) $('settleNote').value = '';
      if (pre) {
        if (pre.from) $('settlePayer').value = pre.from;
        if (pre.to) $('settleReceiver').value = pre.to;
        if (pre.amount) $('settleAmount').value = pre.amount;
      }
      if ($('settleModal')) $('settleModal').hidden = false;
    };
    $('btnSettleUp').onclick = () => openSettle();
    on('splitBalancesList', 'click', e => {
      const r = e.target.closest('.settle-row'); if (!r) return;
      openSettle({ from: r.dataset.from, to: r.dataset.to, amount: Number(r.dataset.amount).toFixed(2) });
    });
  }

  if ($('settleCancel')) $('settleCancel').onclick = () => { if ($('settleModal')) $('settleModal').hidden = true; };

  on('settleForm', 'submit', async e => {
    e.preventDefault();
    const group = state.billGroups.find(g => g.id === selectedGroupId);
    if (!group) return;

    const from = $('settlePayer').value;
    const to = $('settleReceiver').value;
    const amount = Math.round((parseFloat($('settleAmount').value) || 0) * 100) / 100;
    const method = $('settleMethod').value;
    const note = $('settleNote').value.trim();

    if (from === to) { toast('Payer and receiver cannot be the same person.'); return; }
    if (!(amount > 0)) return;

    const s = { id: uid(), from, to, amount, method, note, date: today() };
    if (group.shared) {
      const r = await rpcOk(sb.from('bill_settlements').insert({
        id: s.id, bill_id: group.id, from_key: from, to_key: to, amount, method, note, date: s.date
      }), "Couldn't record the payment. Check your connection and try again.");
      if (!r) return;
    }
    if (!group.settlements) group.settlements = [];
    group.settlements.push(s);
    persistGroup(group);
    $('settleModal').hidden = true; renderBillDetail(); toast(`Recorded payment of ${money(amount)}!`);
  });

  if ($('btnLogShareToMainExpenses')) {
    $('btnLogShareToMainExpenses').onclick = () => {
      const group = state.billGroups.find(g => g.id === selectedGroupId);
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
    fMethod = b.dataset.v; expanded.tx = false;
    $$('#methodChips .chip').forEach(c => c.classList.toggle('on', c === b));
    renderExpenses();
  });

  if ($('btnAddCardModal')) $('btnAddCardModal').onclick = () => openCardModal(null, cardsFilter === 'debit' ? 'debit' : 'credit');
  on('cardTypeSeg', 'click', e => {
    const b = e.target.closest('button'); if (!b) return;
    setSeg('cardTypeSeg', b.dataset.v); syncCardModalType();
  });
  on('cardsFilterSeg', 'click', e => {
    const b = e.target.closest('button'); if (!b) return;
    cardsFilter = b.dataset.v; expanded.cards = false; renderSettings();
  });
  if ($('cardModalCancel')) $('cardModalCancel').onclick = closeCardModal;

  on('cardForm', 'submit', e => {
    e.preventDefault();
    const bank = $('cardBank') ? $('cardBank').value.trim() : '';
    const name = $('cardName') ? $('cardName').value.trim() : '';
    const statementDay = parseInt($('cardStmtDay') ? $('cardStmtDay').value : '') || 1;
    const dueDaysAfter = parseInt($('cardDueDays') ? $('cardDueDays').value : '') || 21;
    const id = $('cardId') ? $('cardId').value : '';
    const type = cardModalType();

    if (!bank || !name) return;
    saveCard({ id, type, bank, name, statementDay, dueDaysAfter });
    closeCardModal(); toast(type === 'debit' ? 'Debit card saved' : 'Credit card saved');
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

  on('setNickname', 'input', () => { state.nickname = $('setNickname').value.trim(); save(); renderAll(); if (mode === 'cloud') scheduleNicknameSync(); });
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
  if ($('authApple')) $('authApple').onclick = signInWithApple;
  on('emailLinkForm', 'submit', signInWithEmailLink);
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

// The service worker (sw.js) was never registered before, so offline mode and installability never kicked in.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service worker not registered:', err));
  });
}

async function boot() {
  try {
    registerServiceWorker();
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
