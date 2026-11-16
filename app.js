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

// Custom expense categories use shades of the user's current pastel accent.
// A stable hash keeps each category visually consistent when changing themes.
const DYNAMIC_PALETTE = [
  '#6f88a8',
  '#c57a61',
  '#6fa183',
  '#c5a34f',
  '#8c78c2',
  '#5f95aa',
  '#b77897',
  '#7d9660',
  '#c66d6d',
  '#6f7fb0'
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
const PAGES = ['home','expenses','split','journeys','settings'];

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
let creatingTrip = false;
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
    journeys: [],
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
      trip: !!p.trip,
      shared: !!p.shared,
      createdBy: String(p.createdBy || ''),
      createdAt: String(p.createdAt || ''),
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
         tripData: e.tripData && typeof e.tripData === "object" ? e.tripData : null,
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

  // Journeys are plans, not real transactions; never mix estimates into balances.
  s.journeys = (Array.isArray(s.journeys) ? s.journeys : []).filter(Boolean).map(j => ({
    id: String(j.id || uid()),
    title: String(j.title || 'Untitled journey').slice(0,120),
    destination: String(j.destination || '').slice(0,160),
    startDate: isIsoDate(j.startDate) ? j.startDate : '',
    notes: String(j.notes || '').slice(0,1500),
    emoji: String(j.emoji || '🧭').slice(0,8),
    linkedBillId: String(j.linkedBillId || ''),
    inviteCodes: Array.isArray(j.inviteCodes)?j.inviteCodes.map(x=>String(x)).slice(0,20):[],
    travelers: (Array.isArray(j.travelers)?j.travelers:[]).filter(Boolean).map(t=>({name:String(t.name||t.code||'Traveler').slice(0,80),code:t.code?String(t.code).toUpperCase():null})).slice(0,40),
    links: (Array.isArray(j.links)?j.links:[]).filter(l=>l&&imageHttpUrl(l.url)).map(l=>({id:String(l.id||uid()),title:String(l.title||'Link').slice(0,100),url:imageHttpUrl(l.url)})).slice(0,40),
    archived: !!j.archived,
    createdAt: String(j.createdAt||''),
    stops: (Array.isArray(j.stops) ? j.stops : []).filter(Boolean).map(p => ({
      id: String(p.id || uid()), type: ['place','transport','activity','stay','food'].includes(p.type) ? p.type : 'place',
      title: String(p.title || 'Stop').slice(0,120),
      date: isIsoDate(p.date) ? p.date : '',
      time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(p.time||'')) ? p.time : '',
      endTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(p.endTime||'')) ? p.endTime : '',
      location: String(p.location||'').slice(0,200),
      transport: String(p.transport||'').slice(0,120),
      cost: Math.max(0,Math.round((Number(p.cost)||0)*100)/100),
      notes: String(p.notes||'').slice(0,1500),
      photoUrls: (Array.isArray(p.photoUrls)?p.photoUrls:[]).map(imageHttpUrl).filter(Boolean).slice(0,12),
      travelerIds: (Array.isArray(p.travelerIds)?p.travelerIds:[]).map(String).slice(0,30)
    })),
    tickets: (Array.isArray(j.tickets)?j.tickets:[]).filter(Boolean).map(t => ({
      id: String(t.id||uid()), name: String(t.name||'Ticket').slice(0,120),
      category: ['bus','train'].includes(t.category)?t.category:'plane', place: String(t.place||'').slice(0,160),
      route: String(t.route||'').slice(0,80), date: isIsoDate(t.date)?t.date:'',
      time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t.time||''))?t.time:'',
      cost: Math.max(0,Math.round((Number(t.cost)||0)*100)/100), archived: !!t.archived,
      travelerPrices: (t.travelerPrices&&typeof t.travelerPrices==='object')?Object.fromEntries(Object.entries(t.travelerPrices).slice(0,30).map(([k,v])=>[String(k).slice(0,80),Math.max(0,Math.round((Number(v)||0)*100)/100)])):{},
      travelerLabels: Array.isArray(t.travelerLabels)?t.travelerLabels.map(x=>String(x).slice(0,100)).slice(0,30):[],
      attachmentLinks: (t.attachmentLinks&&typeof t.attachmentLinks==='object')?Object.fromEntries(Object.entries(t.attachmentLinks).slice(0,40).filter(([k,v])=>typeof v==='string'&&/^https:\/\//i.test(v)).map(([k,v])=>[String(k).slice(0,100),String(v).slice(0,2048)])):{},
    }))
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
    if (e.target && e.target.closest && e.target.closest('.bill-drag-handle,.bill-pin-btn')) return;
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
    const a = el.animate(
      [{ opacity: 0, transform: `translate(${dx}px, ${dy}px)` }, { opacity: 1, transform: 'translate(0, 0)' }],
      { duration: calm ? 180 : 340, easing: 'cubic-bezier(.22,.8,.3,1)', fill: 'backwards' }
    );
    // iOS can leave the animated layer rasterized at low resolution (blurry text) once it ends,
    // so drop the animation and force a fresh repaint when it finishes.
    const settle = () => {
      try { a.cancel(); } catch (e) {}
      el.style.willChange = 'auto';
      void el.offsetHeight;
    };
    a.onfinish = settle;
    a.oncancel = () => { el.style.willChange = 'auto'; };
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

// In-app notification center: local inbox, fed by card reminders and authorized shared-bill sync.
// No background push, no new server tables, and no financial data mutations.
const notificationScope = () => mode === 'cloud' && user ? user.id : 'local';
const notificationKey = () => 'ledger.notifications.v1.' + notificationScope();
const sharedSnapshotKey = () => 'ledger.sharedSnapshot.v1.' + notificationScope();
function readNotifications() {
  try { const value = JSON.parse(lsGet(notificationKey()) || '[]'); return Array.isArray(value) ? value.slice(0, 80) : []; }
  catch { return []; }
}
function addNotification(kind, title, detail, dedupeId, billId = '') {
  const entries = readNotifications();
  if (entries.some(n => n.dedupe === dedupeId)) return;
  entries.unshift({ id: uid(), kind, title, detail, dedupe: dedupeId, billId, at: Date.now(), read: false });
  lsSet(notificationKey(), JSON.stringify(entries.slice(0, 80)));
  renderNotifications();
}
function collectCardNotifications() {
  if (mode === 'none') return;
  const day = today();
  (state.cards || []).filter(c => c.type !== 'debit').forEach(c => {
    const status = computeCardStatus(c);
    if (status.paid || status.currentDueSpent <= 0 || status.daysLeft > 7) return;
    const message = status.daysLeft < 0 ? `${Math.abs(status.daysLeft)} days overdue` : status.daysLeft === 0 ? 'Due today' : `Due in ${status.daysLeft} days`;
    addNotification('reminder', `${c.bank} card payment`, `${c.name} · ${message}`, `card:${day}:${c.id}:${status.cutoffStr}`);
  });
}
function snapshotSharedBills(groups) {
  const result = {};
  groups.forEach(g => {
    result[g.id] = { name:g.name, emoji:g.emoji, participants:JSON.stringify(g.participants.map(p => [p.key,p.code,p.name])),
      expenses:Object.fromEntries(g.expenses.map(e=>[e.id,JSON.stringify([e.title,e.amount,e.paidBy,e.participants,e.date,e.tripData])])),
      settlements:Object.fromEntries(g.settlements.map(s=>[s.id,JSON.stringify([s.from,s.to,s.amount,s.method,s.date])])) };
  });
  return result;
}
function compareSharedSnapshots(groups) {
  if (!user) return;
  const next = snapshotSharedBills(groups);
  const key = sharedSnapshotKey();
  const oldRaw = lsGet(key);
  let old = {};
  try { if (oldRaw) old = JSON.parse(oldRaw) || {}; } catch {}
  // A first sync establishes baseline rather than flooding old bills as new notifications.
  if (oldRaw) {
    for (const [id, bill] of Object.entries(next)) {
      const prior = old[id];
      if (!prior) { addNotification('invite','Added to a shared bill',bill.name,`bill-invite:${id}`,id); continue; }
      if (bill.name !== prior.name || bill.emoji !== prior.emoji || bill.participants !== prior.participants) {
        addNotification('bill','Bill details changed',bill.name,`bill-details:${id}:${JSON.stringify([bill.name,bill.emoji,bill.participants])}`,id);
      }
      for (const [expenseId, signature] of Object.entries(bill.expenses)) {
        if (prior.expenses?.[expenseId] === signature) continue;
        addNotification('bill', prior.expenses?.[expenseId] ? 'Expense updated' : 'Expense added',bill.name,
          `bill-expense:${id}:${expenseId}:${signature}`,id);
      }
      for (const [paymentId, signature] of Object.entries(bill.settlements)) {
        if (prior.settlements?.[paymentId] === signature) continue;
        addNotification('bill', prior.settlements?.[paymentId] ? 'Payment updated' : 'Payment recorded',bill.name,
          `bill-payment:${id}:${paymentId}:${signature}`,id);
      }
    }
  }
  lsSet(key,JSON.stringify(next));
  renderNotifications();
}
function renderNotifications() {
  const box = $('notificationList'), dot = $('notificationDot');
  if (!box) return;
  const entries = readNotifications();
  if (dot) dot.hidden = !entries.some(n => !n.read);
  box.innerHTML = entries.length ? entries.map(n => `<button type="button" class="notification-entry ${n.read ? '' : 'unread'}" data-notify-id="${esc(n.id)}">
    <span class="notification-entry-icon" aria-hidden="true">${n.kind === 'reminder' ? '◷' : n.kind === 'invite' ? '✦' : '↗'}</span>
    <span class="notification-entry-body"><strong>${esc(n.title)}</strong><small>${esc(n.detail)}</small><time>${new Date(n.at).toLocaleDateString(undefined,{month:'short',day:'numeric'})}</time></span>
  </button>`).join('') : '<p class="notification-empty">All caught up. New reminders and bill changes will appear here.</p>';
}
function closeNotifications() {
  const p=$('notificationPanel'), d=$('notificationDismiss'), b=$('notificationToggle');
  if (p) p.hidden=true;
  if (d) d.hidden=true;
  if (b) b.setAttribute('aria-expanded','false');
}
// Keep the notification bell in the active page header instead of pinning it
// to the viewport. The existing button and inbox are moved, never recreated,
// so their event handlers and unread state are preserved.
function placeNotificationInHeader() {
  const center = $('notificationCenter');
  if (!center) return;
  const splitVisible = currentPage === 'split';
  let target;
  if(currentPage==='journeys'&&activeJourneyId){target=document.querySelector('#journeyDetail .route-detail-actions');}
  else if(currentPage==='journeys'&&routeArchiveView){target=document.querySelector('#routeArchiveView > .top');}
  else
  if (splitVisible && $('splitDetailView') && !$('splitDetailView').hidden) {
    target = document.querySelector('#splitDetailView .split-header-actions');
  } else if (splitVisible && $('splitArchiveView') && !$('splitArchiveView').hidden) {
    target = document.querySelector('#splitArchiveView > .top > div:last-child');
  } else if (splitVisible) {
    target = document.querySelector('#splitMainView > .top .top-actions');
  } else {
    target = document.querySelector('#page-' + (currentPage || 'home') + ' > .top');
  }
  if (target && center.parentElement !== target) {
    closeNotifications();
    target.appendChild(center);
  }
}
function initNotifications() {
  const toggle=$('notificationToggle');
  if (!toggle) return;
  // The bell follows page headers, but the inbox and its backdrop belong at
  // document level. Otherwise a narrow header can clip or offset the inbox.
  const inbox = $('notificationPanel');
  const backdrop = $('notificationDismiss');
  if (inbox && inbox.parentElement !== document.body) document.body.appendChild(inbox);
  if (backdrop && backdrop.parentElement !== document.body) document.body.appendChild(backdrop);
  toggle.addEventListener('click',()=>{
    const open=$('notificationPanel').hidden;
    closeGlobalActions(true);
    $('notificationPanel').hidden=!open; $('notificationDismiss').hidden=!open;
    toggle.setAttribute('aria-expanded',String(open));
    if (open) { const entries=readNotifications();entries.forEach(n=>n.read=true);lsSet(notificationKey(),JSON.stringify(entries));renderNotifications(); }
  });
  $('notificationClose').addEventListener('click',closeNotifications);
  $('notificationDismiss').addEventListener('click',closeNotifications);
  $('notificationClear').addEventListener('click',()=>{lsDel(notificationKey());renderNotifications();});
  $('notificationList').addEventListener('click',e=>{
    const target=e.target.closest('[data-notify-id]');if(!target)return;
    const n=readNotifications().find(x=>x.id===target.dataset.notifyId);
    closeNotifications();
    if(n?.billId && state.billGroups.some(g=>g.id===n.billId)) {
      location.hash='#split';
      if(currentPage!=='split') route();
      openBillDetail(n.billId);
    } else if(n?.kind==='reminder') {location.hash='#home';route();}
  });
  // Page routing and Split subviews switch by toggling their hidden attribute.
  // Watch only those view boundaries; don't watch inner UI changes.
  const views = ['page-home','page-expenses','page-split','page-journeys','page-settings',
                 'splitMainView','splitArchiveView','splitDetailView'];
  const headerObserver = new MutationObserver(placeNotificationInHeader);
  views.forEach(id => { const el = $(id); if(el) headerObserver.observe(el,
    {attributes:true,attributeFilter:['hidden']}); });
  placeNotificationInHeader();
  document.addEventListener('keydown',e=>{if(e.key==='Escape')closeNotifications();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){collectCardNotifications();renderNotifications();}});
  renderNotifications();
}

// Floating creation menu. No duplicate business logic: delegate to the established modal handlers.
let globalActionsCloseTimer = null;
function closeGlobalActions(immediate = false) {
  const menu = $('globalActionsMenu'), dismiss = $('globalActionsDismiss'), toggle = $('globalActionsToggle');
  clearTimeout(globalActionsCloseTimer);
  if (!menu) return;
  if (dismiss) dismiss.hidden = true;
  if (toggle) { toggle.setAttribute('aria-expanded', 'false'); toggle.classList.remove('is-open'); }
  menu.classList.remove('is-visible');
  if (immediate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { menu.hidden = true; return; }
  globalActionsCloseTimer = setTimeout(() => { menu.hidden = true; }, 260);
}
function setGlobalActionsOpen(open) {
  const menu = $('globalActionsMenu'), dismiss = $('globalActionsDismiss'), toggle = $('globalActionsToggle');
  if (!menu || !toggle) return;
  clearTimeout(globalActionsCloseTimer);
  const inBill = currentPage === 'split' && !!selectedGroupId && !!$('splitDetailView') && !$('splitDetailView').hidden;
  const inRoute = currentPage === 'journeys' && !!activeJourneyId && !!$('journeyDetail') && !$('journeyDetail').hidden;
  if ($('globalAddToBill')) $('globalAddToBill').hidden = !inBill;
  if ($('globalRecordPayment')) $('globalRecordPayment').hidden = !inBill;
  if ($('globalRouteTicket')) $('globalRouteTicket').hidden = !inRoute;
  if ($('globalRouteStop')) $('globalRouteStop').hidden = !inRoute || !journeyOwner(journeyById(activeJourneyId));
  $$('#globalActionsMenu button[data-create]').forEach(b => {
    const kind=b.dataset.create;
    if (['in-bill','payment','route-ticket','route-stop'].includes(kind)) return;
    b.hidden = inBill || inRoute;
  });
  if (open) {
    closeNotifications();
    menu.hidden = false;
    requestAnimationFrame(() => menu.classList.add('is-visible'));
  } else { closeGlobalActions(); }
  if (dismiss) dismiss.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  toggle.classList.toggle('is-open', open);
}
function initGlobalActions() {
  const toggle = $('globalActionsToggle'), menu = $('globalActionsMenu');
  if (!toggle || !menu) return;
  toggle.addEventListener('click', () => setGlobalActionsOpen(!toggle.classList.contains('is-open')));
  $('globalActionsDismiss')?.addEventListener('click', closeGlobalActions);
  menu.addEventListener('click', e => {
    const btn = e.target.closest('button[data-create]'); if (!btn) return;
    const action = btn.dataset.create;
    closeGlobalActions(true);
    if (action === 'route-stop') { openStopForm(); return; }
    if (action === 'route-ticket') { openRouteTicketForm(); return; }
    if (action === 'payment') { openBillPayment(); return; }
    if (action === 'journey') { if (currentPage !== 'journeys') { location.hash='#journeys'; route(); } openJourneyForm(); return; }
    const targets = {expense:'btnAddExpenseBtn',bill:'btnAddPersonFabTop','in-bill':'btnOpenAddSplitExpense'};
    const target = $(targets[action]);
    if (target) target.click();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !menu.hidden) { closeGlobalActions(); toggle.focus(); }
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
  placeNotificationInHeader();
  closeGlobalActions(true);
  closeNotifications();
  renderAll();
}

function showApp() {
  if ($('auth')) $('auth').hidden = true;
  if ($('app')) $('app').hidden = false;
  if ($('dock')) $('dock').hidden = false;
  if ($('globalActions')) $('globalActions').hidden = false;
  if ($('notificationCenter')) $('notificationCenter').hidden = false;
  ensureDockGradient();
  ensureTopEdgeFade();
  route();
}

function ensureDockGradient() {
  if (document.body.querySelector('.dock-fade-gradient')) return;
  const gradientDiv = document.createElement('div');
  gradientDiv.className = 'dock-fade-gradient';
  gradientDiv.style.cssText = 'position: fixed; bottom: 0; left: 0; right: 0; height: 95px; pointer-events: none; z-index: 3; background: linear-gradient(to top, var(--bg) 40%, rgba(0,0,0,0) 100%);';
  document.body.appendChild(gradientDiv);
}

// A narrow iOS safe-area scrim, ending before page headings and action icons.
// Do not blur the headers themselves: only content passing under the top screen edge.
function ensureTopEdgeFade() {
  let el = document.getElementById('topEdgeFade');
  if (!el) {
    el = document.createElement('div');
    el.id = 'topEdgeFade';
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
  }
  el.hidden = false;
}

function showAuth() {
  if (document.getElementById('topEdgeFade')) document.getElementById('topEdgeFade').hidden = true;
  closeNotifications();
  if ($('app')) $('app').hidden = true;
  if ($('dock')) $('dock').hidden = true;
  closeGlobalActions();
  if ($('globalActions')) $('globalActions').hidden = true;
  if ($('notificationCenter')) $('notificationCenter').hidden = true;
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
    // Only a nickname sets the personal greeting; never substitute an email address.
    const nickname = String(state.nickname || '').trim();
    const greeting = nickname ? `Hi ${nickname}!` : 'Hi there!';
    $('homeGreeting').textContent = greeting;
    $('homeGreeting').title = greeting;
  }

  populateCardDropdowns();
  fillCats($('category'), addFormType(), true);
  
  renderHome();
  armCharts();
  renderFixedExpenses();
  renderExpenses();
  renderSettings();
  renderBillList();
  if (selectedGroupId) renderBillDetail();
  renderJourneys();
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

// Charts play their animation only once they scroll into view
let chartObserver = null;
function armCharts() {
  if (!('IntersectionObserver' in window)) return;
  if (!chartObserver) {
    chartObserver = new IntersectionObserver(entries => {
      entries.forEach(en => {
        if (!en.isIntersecting) return;
        en.target.classList.remove('anim-wait');
        chartObserver.unobserve(en.target);
      });
    }, { threshold: 0.3 });
  }
  ['donutBody', 'barsBody'].forEach(id => {
    const el = $(id);
    if (!el || !el.firstElementChild) return;
    chartObserver.unobserve(el);
    el.classList.add('anim-wait');
    chartObserver.observe(el);
  });
}

let barsDrawnW = 0, resizeTimer = null;

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
  collectCardNotifications();

  if ($('homeEmpty')) $('homeEmpty').hidden = state.tx.length > 0;
  $$('.home-chart').forEach(el => { el.hidden = state.tx.length === 0; });
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
  // Drawn 1:1 with the card's real width, so labels keep their true size on phone and desktop alike.
  const holder = $('barsBody');
  const W = Math.max(240, Math.round((holder && holder.clientWidth) || 300));
  barsDrawnW = W;
  const H = 154, base = 120, topY = 30;
  const slot = W / 6, bw = Math.max(18, Math.min(44, Math.round(slot * 0.5)));
  const gridLines = [0, 0.5, 1].map(f => {
    const y = Math.round(base - f * (base - topY));
    return `<line x1="0" x2="${W}" y1="${y}" y2="${y}" class="b-grid${f === 0 ? ' base' : ''}" />`;
  }).join('');
  const bars = months.map((m, i) => {
    const h = m.spent > 0 ? Math.max(8, (m.spent / max) * (base - topY)) : 0;
    const x = Math.round(slot * i + (slot - bw) / 2);
    const y = Math.round(base - h);
    const cx = x + bw / 2;
    const r = Math.min(8, h, bw / 2);
    const shape = h
      ? `<path class="b-bar${m.cur ? ' cur' : ''}" d="M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${base} Z"
          style="transform-origin:${cx}px ${base}px; animation: barGrow 0.6s cubic-bezier(0.22, 0.9, 0.3, 1) ${i * 0.07}s both;" />`
      : `<rect class="b-zero" x="${x}" y="${base - 2}" width="${bw}" height="2" rx="1" />`;
    return `<g>
      <title>${esc(m.d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}: ${money(m.spent)}</title>
      ${shape}
      ${h ? `<text x="${cx}" y="${y - 8}" class="b-val${m.cur ? ' cur' : ''}" style="animation: fadeInLabel 0.4s ease ${0.25 + i * 0.07}s both;">${short(m.spent)}</text>` : ''}
      <text x="${cx}" y="${base + 20}" class="b-lbl${m.cur ? ' cur' : ''}">${m.d.toLocaleDateString(undefined, { month: 'short' })}</text>
    </g>`;
  }).join('');

  if (holder) {
    holder.innerHTML = `<div class="bars"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Spending over six months">
      <defs>
        <linearGradient id="gBarCur" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--chart-bar-current-start,#8d98aa)" /><stop offset="1" style="stop-color:var(--chart-bar-current-end,#5d6f86)" /></linearGradient>
        <linearGradient id="gBarPast" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--muted);stop-opacity:.5" /><stop offset="1" style="stop-color:var(--muted);stop-opacity:.14" /></linearGradient>
      </defs>
      ${gridLines}${bars}</svg></div>`;
  }

  // PAYMENT METHOD BREAKDOWN BAR
  const cash  = txs.filter(t => t.type === 'expense' && t.method === 'cash').reduce((s, t) => s + t.amount, 0);
  const debit = txs.filter(t => t.type === 'expense' && t.method === 'debit').reduce((s, t) => s + t.amount, 0);
  const card  = txs.filter(t => t.type === 'expense' && t.method === 'card').reduce((s, t) => s + t.amount, 0);

  if ($('splitBody')) {
    if (exp > 0) {
      const pct = v => Math.round(v / exp * 100);
      const seg = (label, v, color) => `<div><small><i style="background:${color}"></i>${label} · ${pct(v)}%</small><b>${money(v)}</b></div>`;
      $('splitBody').innerHTML = `
        <div class="split" role="img" aria-label="Cash ${pct(cash)}%, Debit ${pct(debit)}%, Credit ${pct(card)}%">
          <i style="width:${cash / exp * 100}%; background:var(--c-cash)"></i>
          <i style="width:${debit / exp * 100}%; background:var(--c-debit)"></i>
          <i style="width:${card / exp * 100}%; background:var(--c-card)"></i>
        </div>
        <div class="split-legend">
          ${seg('Cash', cash, 'var(--c-cash)')}${seg('Debit', debit, 'var(--c-debit)')}${seg('Credit', card, 'var(--c-card)')}
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
      <div class="card-reminder-item" data-id="${esc(c.id)}" role="button" tabindex="0" aria-label="${esc(c.bank)} ${esc(c.name)} payment details">
        <div class="card-info">
          <div class="card-title"><span class="bank-tag">${esc(c.bank)}</span><span>${esc(c.name)}</span></div>
          <small class="card-dates">Due: <b>${fmtShort(c.dueDate)}</b> (Cutoff: ${fmtShort(c.cutoffDate)})${paidOnTxt}</small>
        </div>
        <div class="card-status">
          <span class="due-badge ${badge.cls}">${badge.text}</span>
          <div class="card-spent-current">Due: ${money(c.currentDueSpent)}</div>
          ${c.nextCycleSpent > 0 ? `<div class="card-spent-next">Next Cycle: ${money(c.nextCycleSpent)}</div>` : ''}
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
    <div class="fixed-item" data-id="${esc(f.id)}">
      <div>
        <strong>${esc(f.title)}</strong>
        <small class="muted" style="display:block;">${esc(f.category)} (${f.type === 'income' ? 'Income' : 'Expense'}) · ${f.indefinite ? 'Ongoing monthly' : `Month ${f.monthsElapsed || 0} of ${f.totalMonths}`}</small>
      </div>
      <div style="display:flex; align-items:center; gap:10px;">
        <b class="${f.type === 'income' ? 'in' : ''}">${f.type === 'income' ? '+' : ''}${money(f.amount)}/mo</b>
        <button type="button" class="del-fixed-btn" data-id="${esc(f.id)}" aria-label="Delete recurring item">✕</button>
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
      setSeg('editRecurLenSeg', f.indefinite ? 'ongoing' : 'fixed');
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
      <div class="mini"><small>Debit</small><b>${money(spentDebit)}</b></div>
      <div class="mini"><small>Credit</small><b>${money(spentCard)}</b></div>`;
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

  if ($('expensesCount')) $('expensesCount').textContent = `${txs.length} ${txs.length === 1 ? 'entry' : 'entries'}`;
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
      <li class="tx" data-id="${esc(t.id)}">
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
      <span class="participant-name">${esc(partLabel(p))}</span>
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
  const confirmBtn = $('confirmEmojiPickerBtn');
  if (!btn || !popover || !grid || !confirmBtn) return;

  // Move to the top-level document so tall content cannot be clipped by the scrolling bill modal.
  document.body.appendChild(popover);
  const names = ['Dog','Cat','Mouse','Hamster','Rabbit','Fox','Bear','Panda','Koala','Tiger','Lion','Cow','Pig','Frog','Monkey','Chicken','Penguin','Bird','Duck','Eagle','Owl','Bat','Wolf','Boar','Horse','Unicorn','Bee','Bug','Butterfly','Turtle'];
  let pendingEmoji = '';
  let priorFocus = null;
  let activeAvatarTarget = 'bill';
  const renderChoices = () => {
    grid.innerHTML = (activeAvatarTarget === 'route' ? ROUTE_EMOJIS : DEFAULT_AVATAR_EMOJIS).map((emoji, i) => ({emoji, name:activeAvatarTarget === 'route' ? 'Route avatar' : (names[i] || 'Animal')}))
      .map(item => `<button type="button" class="emoji-grid-item${item.emoji === pendingEmoji ? ' is-selected' : ''}" data-emoji="${item.emoji}" aria-label="${item.name}" aria-pressed="${item.emoji === pendingEmoji}"><span>${item.emoji}</span></button>`).join('')
;
  };
  const close = () => {
    popover.hidden = true;
    document.body.classList.remove('emoji-picker-open');
    if (priorFocus?.isConnected) priorFocus.focus();
  };
  const open = (target = 'bill') => {
    activeAvatarTarget = target;
    priorFocus = document.activeElement;
    pendingEmoji = target === 'route' ? ($('journeyEmoji')?.value || '🧭') : (hiddenInput?.value || btn.textContent.trim() || '🐶');
    if (typeInput) typeInput.value = '';
    renderChoices();
    popover.hidden = false;
    document.body.classList.add('emoji-picker-open');
    closeBtn?.focus({preventScroll:true});
  };
  btn.onclick = e => { e.stopPropagation(); if (popover.hidden) open('bill'); else close(); };
  $('routeAvatarTrigger')?.addEventListener('click', e => { e.stopPropagation(); if (popover.hidden) open('route'); else close(); });
  closeBtn?.addEventListener('click', close);
  popover.addEventListener('click', e => { if (e.target === popover) close(); });
  grid.addEventListener('click', e => {
    const item = e.target.closest('.emoji-grid-item');
    if (!item) return;
    pendingEmoji = item.dataset.emoji;
    if (typeInput) typeInput.value = '';
    renderChoices();
  });
  typeInput?.addEventListener('input', () => {
    const value = typeInput.value.trim();
    if (value) { pendingEmoji = value; renderChoices(); }
  });
  confirmBtn.addEventListener('click', () => {
    const emoji = (typeInput?.value || '').trim() || pendingEmoji || '🐶';
    if (activeAvatarTarget === 'route') routeEmojiPicker(emoji);
    else { btn.textContent = emoji; if (hiddenInput) hiddenInput.value = emoji; }
    close();
  });
  document.addEventListener('keydown', e => {
    if (popover.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    // Keep keyboard navigation inside the open picker.
    if (e.key === 'Tab') {
      const controls = Array.from(popover.querySelectorAll('button:not([disabled]),input:not([disabled])')).filter(el => el.getClientRects().length);
      if (!controls.length) return;
      const first = controls[0], last = controls[controls.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  // Opening another app modal closes the picker without changing its saved avatar.
  new MutationObserver(() => { if (activeAvatarTarget === 'bill' && $('addPersonModal')?.hidden && !popover.hidden) close(); })
    .observe($('addPersonModal'), {attributes:true,attributeFilter:['hidden']});
}

// Per-account, per-device display preferences. They never modify a shared bill for other members.
const pinnedBillKey = () => 'ledger.pinnedBills.' + (mode === 'cloud' && user ? user.id : 'local');
const billOrderKey = () => 'ledger.billOrder.' + (mode === 'cloud' && user ? user.id : 'local');
const billSortKey = () => 'ledger.billSort.' + (mode === 'cloud' && user ? user.id : 'local');
function readStringArray(key) {
  try { const ids=JSON.parse(lsGet(key)||'[]'); return Array.isArray(ids) ? [...new Set(ids.map(String))] : []; }
  catch { return []; }
}
const pinnedBillIds = () => readStringArray(pinnedBillKey());
const billSortMode = () => lsGet(billSortKey()) || 'manual';
function toggleBillPin(id) {
  const ids=new Set(pinnedBillIds()), wasPinned=ids.has(String(id));
  if(wasPinned) ids.delete(String(id)); else ids.add(String(id));
  lsSet(pinnedBillKey(),JSON.stringify([...ids]));
  // Keep new pins ordered without disturbing the order of other groups.
  renderBillList(); toast(wasPinned?'Bill unpinned':'Bill pinned to the top');
}
function orderedBillSection(groups) {
  const how=billSortMode();
  if(how==='az') return groups.sort((a,b)=>a.name.localeCompare(b.name));
  if(how==='za') return groups.sort((a,b)=>b.name.localeCompare(a.name));
  if(how==='newest') return groups.sort((a,b)=>{
    const da=Date.parse(a.createdAt||'')||0, db=Date.parse(b.createdAt||'')||0;
    return db-da; // Old records without timestamps retain their original relative order.
  });
  const saved=readStringArray(billOrderKey());
  const index=new Map(saved.map((id,i)=>[id,i]));
  return groups.sort((a,b)=>{
    const ia=index.has(String(a.id))?index.get(String(a.id)):1e9;
    const ib=index.has(String(b.id))?index.get(String(b.id)):1e9;
    return ia-ib;
  });
}
function reorderedBill(id, targetId) {
  if(id===targetId) return;
  const pins=new Set(pinnedBillIds());
  if(pins.has(id)!==pins.has(targetId)) { toast('Pinned bills can only move among pinned bills.'); return; }
  const all=(state.billGroups||[]).filter(g=>!g.archived);
  const current=orderedBillSection(all.filter(g=>pins.has(String(g.id))))
    .concat(orderedBillSection(all.filter(g=>!pins.has(String(g.id)))));
  const ids=current.map(g=>String(g.id));
  const from=ids.indexOf(id), to=ids.indexOf(targetId);
  if(from<0||to<0) return;
  ids.splice(from,1); ids.splice(to,0,id);
  lsSet(billOrderKey(),JSON.stringify(ids)); lsSet(billSortKey(),'manual');
  if($('billSortSelect')) $('billSortSelect').value='manual';
  renderBillList();
}
function initBillDrag() {
  const container=$('billsList'); if(!container||container.dataset.dragReady) return;
  container.dataset.dragReady='1';
  let dragging=null, hovering=null;
  const clear=()=>{ container.querySelectorAll('.bill-card').forEach(x=>x.classList.remove('dragging','drop-target')); dragging=null; hovering=null; };
  container.addEventListener('pointerdown',e=>{
    const handle=e.target.closest('.bill-drag-handle'); if(!handle) return;
    const card=handle.closest('.bill-card'); if(!card) return;
    e.preventDefault(); e.stopPropagation();
    dragging=card.dataset.id;
    handle.setPointerCapture(e.pointerId);
    card.classList.add('dragging');
  });
  container.addEventListener('pointermove',e=>{
    if(!dragging) return;
    const target=document.elementFromPoint(e.clientX,e.clientY)?.closest('.bill-card');
    container.querySelectorAll('.bill-card').forEach(x=>x.classList.remove('drop-target'));
    if(target && target.dataset.id!==dragging){hovering=target.dataset.id;target.classList.add('drop-target');}else hovering=null;
  });
  container.addEventListener('pointerup',e=>{
    if(!dragging) return;
    const a=dragging,b=hovering; clear();if(b) reorderedBill(a,b);
  });
  container.addEventListener('pointercancel',clear);
  // Keyboard-accessible reorder. Pointer dragging doesn't fire a second click movement.
  container.addEventListener('keydown',e=>{
    const handle=e.target.closest('.bill-drag-handle');
    if(!handle || !['ArrowUp','ArrowDown'].includes(e.key)) return;
    e.preventDefault();e.stopPropagation();
    const card=handle.closest('.bill-card'),list=[...container.querySelectorAll('.bill-card')];
    const pins=new Set(pinnedBillIds());
    const allowed=list.filter(x=>pins.has(x.dataset.id)===pins.has(card.dataset.id));
    const i=allowed.indexOf(card),next=allowed[i+(e.key==='ArrowUp'?-1:1)];
    if(next) reorderedBill(card.dataset.id,next.dataset.id);
  });
}
function renderBillList() {
  const el=$('billsList');if(!el)return;
  const all=(state.billGroups||[]).filter(g=>!g.archived);
  if(!all.length){el.innerHTML='<div class="empty-card card">No bills yet. Tap + to add one.</div>';return;}
  const pins=new Set(pinnedBillIds());
  const pinned=orderedBillSection(all.filter(g=>pins.has(String(g.id))));
  const others=orderedBillSection(all.filter(g=>!pins.has(String(g.id))));
  const visible=[...pinned,...limited('bills',others)];
  el.innerHTML=visible.map(g=>`<div class="bill-card ${pins.has(String(g.id))?'is-pinned':''}" data-id="${esc(g.id)}">
    <div class="bill-card-left"><span class="bill-emoji">${esc(g.emoji)}</span><div class="bill-card-info">
      <div class="bill-name-row"><span class="bill-name">${esc(g.name)}</span></div>
      <div class="bill-card-meta">
        ${g.trip?'<span class="tag shared-tag">Detailed Split</span>':''}
        ${g.shared?'<span class="tag shared-tag">Shared</span>':''}
        <small class="muted fine">${g.participants.length} ${g.participants.length===1?'member':'members'}</small>
      </div>
    </div></div>
    <button type="button" class="bill-pin-btn ${pins.has(String(g.id))?'on':''}" aria-label="${pins.has(String(g.id))?'Unpin':'Pin'} ${esc(g.name)}" aria-pressed="${pins.has(String(g.id))}" title="Pin to top">📌</button>
    <button type="button" class="bill-drag-handle" aria-label="Move ${esc(g.name)} within ${pins.has(String(g.id))?'pinned':'unpinned'} bills" title="Drag to reorder" draggable="false"><svg class="bill-grip-icon" viewBox="0 0 20 24" aria-hidden="true" focusable="false" fill="currentColor"><circle cx="6" cy="5" r="1.6"/><circle cx="14" cy="5" r="1.6"/><circle cx="6" cy="12" r="1.6"/><circle cx="14" cy="12" r="1.6"/><circle cx="6" cy="19" r="1.6"/><circle cx="14" cy="19" r="1.6"/></svg></button>
    <span class="bill-chevron">›</span></div>`).join('')+moreBtn('bills',others.length);
  $$('#billsList .bill-card').forEach(card=>{
    const group=state.billGroups.find(g=>String(g.id)===card.dataset.id); if(!group)return;
    card.querySelector('.bill-pin-btn').onclick=e=>{e.stopPropagation();toggleBillPin(group.id);};
    card.onclick=e=>{if(e.target.closest('.bill-pin-btn,.bill-drag-handle'))return;if(card._lpFired){card._lpFired=false;return;}openBillDetail(group.id);};
    attachLongPress(card,e=>{
      if(e.target?.closest?.('.bill-pin-btn,.bill-drag-handle'))return;
      const leaving=group.shared&&user&&group.createdBy!==user.id;
      showActionSheet(group.name,`Members: ${group.participants.map(p=>p.name).join(', ')}`,[
        {text:pins.has(String(group.id))?'📌 Unpin Bill':'📌 Pin to Top',action:()=>toggleBillPin(group.id)},
        {text:'📁 Archive Bill',action:async()=>{if(await setArchived(group,true)){renderBillList();toast(`Archived ${group.name}`);}}},
        {text:'✏️ Edit Bill Details',action:()=>openBillEditor(group)},
        {text:leaving?'🚪 Leave Bill':'🗑️ Delete Bill',danger:true,action:()=>removeBill(group)}
      ]);
    });
  });
  initBillDrag();
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
      id: x.id, name: x.name, emoji: x.emoji || '🐶', shared: true, trip: !!x.is_trip,
      createdBy: x.created_by, createdAt: x.created_at || '', archived: !!arch[x.id],
      participants: (x.participants || []).map(p => ({
        key: p.key || p.code || p.name, code: p.code || null,
        name: (p.code && nick[p.code]) || p.name || 'Ledger user'
      })),
      expenses: (e.data || []).filter(r => r.bill_id === x.id).map(r => ({
        id: r.id, title: r.title, amount: Number(r.amount), paidBy: r.paid_by,
        participants: r.participants || [], date: r.date, tripData: r.trip_data || null
      })),
      settlements: (s.data || []).filter(r => r.bill_id === x.id).map(r => ({
        id: r.id, from: r.from_key, to: r.to_key, amount: Number(r.amount),
        method: r.method || '', note: r.note || '', date: r.date
      }))
    }));

    compareSharedSnapshots(shared);
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
  participants: e.participants, date: e.date, trip_data: e.tripData || null, updated_at: new Date().toISOString()
});
const persistGroup = g => { if (g.shared) cacheWrite(); else save(); };

function openBillEditor(group) {
  if (!group) creatingTrip = !!creatingTrip;
  else creatingTrip = !!group.trip;
  $('groupModalTitle').textContent = group ? (group.trip ? 'Edit Detailed Split' : 'Edit Bill') : (creatingTrip ? 'Create Detailed Split' : 'Add a Bill');
  if ($('billKindField')) $('billKindField').hidden = !!group;
  if ($('billKind')) $('billKind').value = creatingTrip ? 'detailed' : 'standard';
  if ($('groupTripHint')) $('groupTripHint').hidden = !creatingTrip;
  $('editGroupId').value = group ? group.id : '';
  $('personNameInput').value = group ? group.name : '';
  updateModalEmojiDisplay(group ? (group.emoji || '🐶') : '🐶');
  if ($('btnDeleteGroup')) {
    $('btnDeleteGroup').hidden = !group;
    const others = group && group.shared && user && group.createdBy !== user.id;
    $('btnDeleteGroup').textContent = others ? 'Leave Bill' : 'Delete Bill';
  }
  pendingParticipants = group ? group.participants.map(p => ({ ...p })) : [meParticipant()];
  { const meKey = group ? myKeyFor(group) : meParticipant().key; const isMe = p => isMeParticipant(p) || p.key === meKey;
    pendingParticipants = [...pendingParticipants.filter(isMe), ...pendingParticipants.filter(p => !isMe(p))]; }
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

// All money calculations use integer cents. The paid amount includes the
// payer's own portion; their share is then deducted like everybody else's.
function calculateGroupBalance(group) {
  const me = myKeyFor(group);
  const keys = new Set((group.participants || []).map(p => p.key));
  if (me) keys.add(me);
  const cents = value => Math.round((Number(value) || 0) * 100);
  const balancesCents = {};
  const ensure = key => { if (key && !Object.hasOwn(balancesCents, key)) balancesCents[key] = 0; };
  keys.forEach(ensure);
  let totalCents = 0;
  const issues = [];
  // Preserve the actual payer/participant relationship for EVERY bill type.
  // Global creditor/debtor netting can redirect a debt through an unrelated member.
  // Net only reciprocal obligations between the same pair of people.
  const pairOwed = new Map();
  function addPairDebt(from, to, amount) {
    if (!from || !to || from === to || !amount) return;
    const [first, second] = [from, to].sort();
    const key = JSON.stringify([first, second]);
    pairOwed.set(key, (pairOwed.get(key) || 0) + (from === first ? amount : -amount));
  }

  (group.expenses || []).forEach(exp => {
    const amount = cents(exp.amount);
    if (!Number.isSafeInteger(amount) || amount < 0) {
      issues.push(`Invalid amount for ${exp.title || 'expense'}`);
      return;
    }
    const payer = exp.paidBy || me;
    ensure(payer);
    if (!payer) { issues.push(`Missing payer for ${exp.title || 'expense'}`); return; }
    let shares;
    if (group.trip && exp.tripData && exp.tripData.shares &&
        Object.keys(exp.tripData.shares).length) {
      // These shares already include the allocated service charge.
      shares = Object.entries(exp.tripData.shares).map(([key, value]) => [key, cents(value)]);
    } else {
      const participants = [...new Set((exp.participants || []).length
        ? exp.participants : (group.participants || []).map(p => p.key))].filter(Boolean);
      if (!participants.length) {
        issues.push(`Missing participants for ${exp.title || 'expense'}`);
        return;
      }
      const each = Math.floor(amount / participants.length);
      let remainder = amount - each * participants.length;
      shares = participants.map(key => [key, each + (remainder-- > 0 ? 1 : 0)]);
    }
    const assigned = shares.reduce((sum, [key, amountCents]) => {
      ensure(key);
      return sum + amountCents;
    }, 0);
    if (shares.some(([, v]) => !Number.isSafeInteger(v) || v < 0) || assigned !== amount) {
      issues.push(`Shares for ${exp.title || 'expense'} total ${((assigned || 0) / 100).toFixed(2)} instead of ${(amount / 100).toFixed(2)}`);
      return; // Don't generate incorrect settlements from inconsistent records.
    }
    totalCents += amount;
    balancesCents[payer] += amount;
    shares.forEach(([key, amountCents]) => {
      balancesCents[key] -= amountCents;
      addPairDebt(key, payer, amountCents);
    });
  });

  (group.settlements || []).forEach(payment => {
    const amount = cents(payment.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0 || !payment.from || !payment.to) return;
    ensure(payment.from); ensure(payment.to);
    balancesCents[payment.from] += amount;
    balancesCents[payment.to] -= amount;
    addPairDebt(payment.from, payment.to, -amount);
  });

  // A balanced ledger must sum to precisely zero cents.
  const check = Object.values(balancesCents).reduce((sum, value) => sum + value, 0);
  if (check !== 0) issues.push(`Ledger is out of balance by ${(check / 100).toFixed(2)}`);

  // Direct settlement suggestions: each expense creates a debt from its
  // participants to its payer. Only offset opposing debts for the SAME pair;
  // never move A's debt to B merely because B paid C for a different expense.
  const settlements = [];
  if (!issues.length) {
    for (const [pairKey, net] of pairOwed) {
      if (net === 0) continue;
      const [first, second] = JSON.parse(pairKey);
      settlements.push({
        from: net > 0 ? first : second,
        to: net > 0 ? second : first,
        amount: Math.abs(net) / 100
      });
    }
    // Verify the suggested pairwise transfers exactly explain every balance.
    const expected = Object.fromEntries(Object.keys(balancesCents).map(k => [k, 0]));
    for (const row of settlements) {
      expected[row.from] = (expected[row.from] || 0) - cents(row.amount);
      expected[row.to] = (expected[row.to] || 0) + cents(row.amount);
    }
    if (Object.keys(balancesCents).some(key => expected[key] !== balancesCents[key])) {
      issues.push('Direct obligations do not reconcile with member balances');
    }
  }
  const balances = Object.fromEntries(Object.entries(balancesCents).map(([key, value]) => [key, value / 100]));
  return { balances, settlements: issues.length ? [] : settlements,
    totalExpenses: totalCents / 100, myNet: (balancesCents[me] || 0) / 100, issues };
}

// Shared helper: payment creation and editing are invoked outside bind().
// Keep this at module scope so the floating menu and payment row can use it.
function billPaymentParticipantOptions(group) {
  return (group.participants || []).map(p =>
    `<option value="${esc(p.key)}">${esc(partLabel(p))}</option>`
  ).join('');
}

function openBillPayment(preselected = null, editPaymentId = null) {
  const group = (state.billGroups || []).find(g => g.id === selectedGroupId);
  if (!group) return;
  const opts = billPaymentParticipantOptions(group);
  if ((group.participants || []).length < 2) { toast('Add two members to record a payment.'); return; }
  const existing = editPaymentId ? (group.settlements || []).find(p => String(p.id) === String(editPaymentId)) : null;
  if (editPaymentId && !existing) { toast('Payment not found. Refresh this bill.'); return; }
  $('settleEditId').value = existing?.id || '';
  $('settleModalTitle').textContent = existing ? 'Edit Payment' : 'Record Payment';
  const saveButton = $('settleForm')?.querySelector('button[type="submit"]');
  if (saveButton) saveButton.textContent = existing ? 'Save Changes' : 'Record Payment';
  $('settleDelete').hidden = !existing;
  $('settlePayer').innerHTML = opts;
  $('settleReceiver').innerHTML = opts;
  const outstanding = calculateGroupBalance(group).settlements;
  const selected = (preselected && outstanding.find(s => s.from === preselected.from && s.to === preselected.to)) || outstanding[0];
  $('settlePayer').value = existing?.from || selected?.from || group.participants[0].key;
  $('settleReceiver').value = existing?.to || selected?.to || group.participants.find(p => p.key !== $('settlePayer').value)?.key || '';
  $('settleNote').value = existing?.note || '';
  $('settleMethod').value = existing?.method || 'Bank Transfer';
  if ($('settleModal').parentElement !== document.body) document.body.appendChild($('settleModal'));
  $('settleModal').hidden = false;
  if (existing) $('settleAmount').value = Number(existing.amount).toFixed(2);
  else syncPaymentAmountToPair();
}
function syncPaymentAmountToPair() {
  const group = (state.billGroups || []).find(g => g.id === selectedGroupId);
  if (!group || $('settleModal')?.hidden) return;
  const outstanding = calculateGroupBalance(group).settlements.find(s => s.from === $('settlePayer').value && s.to === $('settleReceiver').value);
  // Suggestions are convenience only. Manual payments may be recorded when
  // there is no outstanding settlement, e.g., advance payments or corrections.
  $('settleAmount').value = outstanding ? outstanding.amount.toFixed(2) : '';
  $('settleAmount').removeAttribute('max');
}


// Monthly bill expenses use a stable month-specific UUID, so simultaneous
// clients cannot accidentally create duplicate charges. Source expense remains
// the editable schedule; generated expenses are ordinary bill entries.
function recurringUuid(source, month) {
  const input = `${source}:${month}`;
  let bytes = [];
  for (let seed = 0; seed < 4; seed++) {
    let h = (2166136261 ^ (seed * 0x9e3779b9)) >>> 0;
    for (let i = 0; i < input.length; i++) { h ^= input.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    for (let b = 3; b >= 0; b--) bytes.push((h >>> (b*8)) & 255);
  }
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.map(v => v.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function dueRecurringExpenses(group, now = today()) {
  const additions = [], seen = new Set((group.expenses||[]).map(e=>e.id));
  for (const e of [...(group.expenses||[])]) {
    const config = e.tripData?.recurring;
    if (config?.frequency !== 'monthly' || !/^\d{4}-\d{2}-\d{2}$/.test(config.startDate||'')) continue;
    const base = config.startDate;
    const startYear = Number(base.slice(0,4)), startMonth = Number(base.slice(5,7)) - 1;
    const untilYear = Number(now.slice(0,4)), untilMonth = Number(now.slice(5,7)) - 1;
    // Limit catch-up to 120 months to guard corrupt data / runaway schedules.
    const limit = Math.min(120, (untilYear-startYear)*12+untilMonth-startMonth);
    for (let n=1;n<=limit;n++) {
      const dt = new Date(Date.UTC(startYear, startMonth+n, 1));
      const year = dt.getUTCFullYear(), month = dt.getUTCMonth();
      const day = Math.min(Number(config.day)||1, new Date(Date.UTC(year,month+1,0)).getUTCDate());
      const date = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      if (date > now || (config.endDate && date > config.endDate)) continue;
      const id = recurringUuid(e.id, date.slice(0,7));
      if (seen.has(id)) continue;
      seen.add(id);
      const tripData = {...(e.tripData||{})}; delete tripData.recurring;
      tripData.recurringInstance = {sourceId:e.id,month:date.slice(0,7)};
      additions.push({...e,id,date,tripData});
    }
  }
  return additions;
}
let recurringSyncBusy = false;
async function syncBillRecurrences(group) {
  if (!group || recurringSyncBusy) return;
  const due = dueRecurringExpenses(group);
  if (!due.length) return;
  recurringSyncBusy = true;
  try {
    if (group.shared) {
      if (!sb || mode !== 'cloud') return;
      const { error } = await sb.from('bill_expenses').upsert(due.map(e => expenseRow(group.id,e)),{onConflict:'id',ignoreDuplicates:true});
      if (error) { console.warn('Recurring bill charge not synced',error); return; }
    }
    const seen = new Set(group.expenses.map(e=>e.id));
    due.forEach(e=>{if(!seen.has(e.id))group.expenses.push(e);});
    persistGroup(group);renderBillDetail();
  } finally { recurringSyncBusy=false; }
}
function renderBillDetail() {
  const group = (state.billGroups || []).find(g => g.id === selectedGroupId);
  if (!group) { closeBillDetail(); return; }
  if (dueRecurringExpenses(group).length) queueMicrotask(() => syncBillRecurrences(group));

  if ($('splitPersonAvatar')) $('splitPersonAvatar').textContent = group.emoji || '🐶';
  if ($('splitPersonName')) $('splitPersonName').textContent = group.name;
  if ($('btnOpenAddSplitExpense')) $('btnOpenAddSplitExpense').textContent = group.trip ? '+ Add Trip Expense' : '+ Add Expense to Bill';
  if ($('tripSummary')) { $('tripSummary').hidden = !group.trip; if (group.trip) renderTripSummary(group); }

  const { totalExpenses, myNet } = calculateGroupBalance(group);

  if ($('splitMyExpensesVal')) {
    $('splitMyExpensesVal').textContent = (myNet < 0 ? '−' : myNet > 0 ? '+' : '') + money(Math.abs(myNet));
    $('splitMyExpensesVal').className = myNet < 0 ? 'neg-text' : myNet > 0 ? 'pos-text' : '';
  }
  if ($('splitTotalExpensesVal')) $('splitTotalExpensesVal').textContent = money(totalExpenses);

  if ($('splitTabExpenses')) $('splitTabExpenses').hidden = activeSplitTab !== 'expenses';
  if ($('splitTabBalances')) $('splitTabBalances').hidden = activeSplitTab !== 'balances';
  setSeg('splitDetailTabs', activeSplitTab);

  if (activeSplitTab === 'expenses') renderBillExpensesList(group);
  else if (activeSplitTab === 'balances') renderBillBalancesTab(group);

  // Keep the balance banner and settlement rows current even when the user
  // deletes/edits an expense from the Expenses tab. The next Balances visit
  // must never display the old suggested transfers.
  if (activeSplitTab !== 'balances') renderBillBalancesTab(group);
}

function renderBillExpensesList(group) {
  const el = $('splitExpensesGroupedList');
  const seeAllBtn = $('btnSeeAllGroupExpenses');
  if (!el) return;
  const events = [
    ...(group.expenses || []).map(exp => ({kind:'expense',id:exp.id,date:exp.date || today(),exp})),
    ...(group.settlements || []).map(payment => ({kind:'payment',id:payment.id,date:payment.date || today(),payment}))
  ];
  if (!events.length) {
    el.innerHTML = '<div class="empty card">Nothing recorded yet. Use + to add an expense or payment.</div>';
    if (seeAllBtn) seeAllBtn.hidden = true;
    return;
  }
  events.sort((a,b) => b.date.localeCompare(a.date) || String(b.id).localeCompare(String(a.id)));
  const selected = limited('groupExp',events);
  if (seeAllBtn) { seeAllBtn.hidden=events.length<=LIMIT; seeAllBtn.textContent=expanded.groupExp?'Show less':`See all (${events.length})`; }
  const dated = new Map();
  selected.forEach(row => { if (!dated.has(row.date)) dated.set(row.date,[]); dated.get(row.date).push(row); });
  el.innerHTML = [...dated.entries()].map(([date,rows]) => {
    const parsed = new Date(date+'T00:00');
    const heading = Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});
    return `<div class="date-group"><div class="date-header">${esc(heading)}</div>${rows.map(row => {
      if (row.kind === 'payment') {
        const pay=row.payment;
        return `<div class="bill-expense-card bill-activity-row bill-payment-row edit-payment-row" data-id="${esc(pay.id)}" role="button" tabindex="0" aria-label="Edit payment by ${esc(shortFor(group,pay.from))} to ${esc(shortFor(group,pay.to))}">
          <span class="activity-glyph payment-glyph" aria-hidden="true">✓</span>
          <div class="activity-copy"><strong>Payment</strong><small>${esc(shortFor(group,pay.from))} → ${esc(shortFor(group,pay.to))} · ${esc(pay.method||'Payment')}</small></div>
          <span class="activity-amount is-payment">+${money(pay.amount)}</span>
        </div>`;
      }
      const exp=row.exp;
      const detail=(group.trip && exp.tripData) ? exp.tripData : null;
      const type=detail ? (detail.category==='delivery'?'Food delivery':detail.category==='food'?'Individual':'Group') : 'Shared';
      return `<div class="bill-expense-card edit-split-exp-btn bill-activity-row" data-id="${esc(exp.id)}" role="button" tabindex="0" aria-label="Edit ${esc(exp.title)}">
        <span class="activity-glyph expense-glyph" aria-hidden="true">−</span>
        <div class="activity-copy"><strong>${esc(exp.title)}</strong><small>${esc(type)} · Paid by ${esc(shortFor(group,exp.paidBy))}${exp.tripData?.recurring ? " · ↻ Monthly" : exp.tripData?.recurringInstance ? " · ↻ Recurring" : ""}</small></div>
        <span class="activity-amount is-expense">−${money(exp.amount)}</span>
      </div>`;
    }).join('')}</div>`;
  }).join('');
}

function renderBillBalancesTab(group) {
  const { settlements, myNet, issues } = calculateGroupBalance(group);
  const status = $('splitBannerStatus');
  const sub = $('splitBannerSub');

  if (status && sub) {
    if (issues && issues.length) {
      status.textContent = 'Balances need review';
      status.className = 'neg-text';
      sub.textContent = 'Some expense shares do not match their totals';
    } else if (myNet < -0.005) {
      status.textContent = `You owe ${money(Math.abs(myNet))}`;
      status.className = 'neg-text'; sub.textContent = 'Your overall net balance in this group';
    } else if (myNet > 0.005) {
      status.textContent = `Owed ${money(Math.abs(myNet))}`;
      status.className = 'pos-text'; sub.textContent = 'Your overall net balance in this group';
    } else {
      status.textContent = `Settled up`;
      status.className = 'pos-text'; sub.textContent = `All group balances are completely even!`;
    }
  }

  const list = $('splitBalancesList');
  if (!list) return;

  if (issues && issues.length) {
    list.innerHTML = `<div class="card" role="alert"><strong>Check expense shares</strong><p class="fine">Some saved expenses do not add up to their total. Edit these expenses to correct their shares before settlements can be suggested.</p>${issues.map(issue => `<p class="fine">${esc(issue)}</p>`).join('')}</div>`;
    return;
  }
  // Show outstanding pairwise debts and recently completed pairwise payments.
  // Status belongs to a payer/recipient settlement, not to the original bill
  // expense (an expense can involve several people who pay at different times).
  const original = calculateGroupBalance({ ...group, settlements: [] });
  const remaining = new Map(settlements.map(s =>
    [JSON.stringify([s.from, s.to]), Math.round(s.amount * 100)]));
  const completed = [];
  const paidProgress = new Map();
  for (const s of original.settlements) {
    const key = JSON.stringify([s.from, s.to]);
    const payments = (group.settlements || []).filter(p => p.from === s.from && p.to === s.to)
      .reduce((v, p) => v + Math.round(Number(p.amount || 0) * 100), 0);
    if (payments <= 0) continue;
    const originalCents = Math.round(s.amount * 100);
    const remainingCents = remaining.get(key) || 0;
    const paidCents = Math.min(originalCents, Math.max(0, originalCents - remainingCents));
    if (paidCents <= 0) continue;
    paidProgress.set(key, paidCents);
    if (remainingCents === 0) completed.push({ ...s, paidAmount: paidCents / 100 });
  }

  const pendingHtml = settlements.map(s => {
    const key = JSON.stringify([s.from, s.to]);
    const paidCents = paidProgress.get(key) || 0;
    return `<button type="button" class="srow settle-row settlement-action" data-from="${esc(s.from)}" data-to="${esc(s.to)}" data-amount="${s.amount}" aria-label="Record payment: ${esc(shortFor(group, s.from))} owes ${esc(shortFor(group, s.to))} ${esc(money(s.amount))}">
      <span class="user-item">
        <span class="user-avatar-circle" aria-hidden="true">↗</span>
        <span class="settlement-copy"><strong>${esc(shortFor(group, s.from))}</strong> owes <strong>${esc(shortFor(group, s.to))}</strong>
          <small class="muted settlement-status">${paidCents ? `${money(paidCents / 100)} paid · ` : ''}Tap to record payment</small>
        </span>
      </span>
      <span class="settlement-amount"><strong>${money(s.amount)}</strong><small class="settlement-hint">Record payment ›</small></span>
    </button>`;
  }).join('');

  const completedHtml = completed.map(s => `<div class="srow settle-row settlement-complete">
    <span class="user-item">
      <span class="user-avatar-circle" aria-hidden="true">✓</span>
      <span class="settlement-copy"><strong>${esc(shortFor(group, s.from))}</strong> paid <strong>${esc(shortFor(group, s.to))}</strong>
        <small class="muted settlement-status">Settled</small>
      </span>
    </span>
    <span class="settlement-amount"><strong>${money(s.paidAmount)}</strong><small class="settlement-paid">✓ Paid</small></span>
  </div>`).join('');

  if (!pendingHtml && !completedHtml) {
    list.innerHTML = '<div class="empty" style="padding:16px;">No outstanding payments.</div>';
    return;
  }
  // Paid rows remain visible after full payment instead of disappearing.
  const allRows = [pendingHtml, completedHtml].filter(Boolean).join('');
  list.innerHTML = allRows;

}

function renderBillHistoryTab(group) {
  const el = $('splitHistoryList');
  if (!el) return;

  const history = group.settlements || [];
  if (history.length === 0) {
    el.innerHTML = '<div class="audit-empty"><span class="audit-empty-icon" aria-hidden="true">🧾</span><strong>No payments or reimbursements recorded yet.</strong><span>Recorded payments will appear here.</span></div>';
    return;
  }

  el.innerHTML = limited('history', history.slice().reverse()).map(s => `
    <div class="history-item">
      <div>
        <strong>${esc(shortFor(group, s.from))}</strong> paid <strong>${esc(shortFor(group, s.to))}</strong>
        <small class="muted" style="display:block;">${esc(s.method || 'GCash')} · ${esc(s.date || today())}${s.note ? ' · ' + esc(s.note) : ''}</small>
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
  $$('#accentPicker button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.accentChoice === getAccent())));
  const fs = getFontScale();
  $$('#fontSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === fs));
  if ($('setNickname') && document.activeElement !== $('setNickname')) $('setNickname').value = state.nickname || '';
  if ($('setCur') && document.activeElement !== $('setCur')) $('setCur').value = state.cur;
  if ($('setBudget') && document.activeElement !== $('setBudget')) $('setBudget').value = state.budget || '';
}

const THEMES = ['system', 'light', 'dark'];
function getTheme() { const t = lsGet('ledger.theme'); return THEMES.includes(t) ? t : 'dark'; }
const ACCENTS = ['graphite','lavender','sage','rose','peach','mist'];
function getAccent(){const v=lsGet('ledger.accent');return ACCENTS.includes(v)?v:'graphite';}
function applyAccent(value){const v=ACCENTS.includes(value)?value:'graphite';document.documentElement.setAttribute('data-accent',v);$$('#accentPicker button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.accentChoice===v)));}
const FONT_SCALES = ['1', '1.1', '1.2', '1.35'];   // 1 = the original (smallest) sizes
function getFontScale() { const v = lsGet('ledger.fontScale'); return FONT_SCALES.includes(v) ? v : '1'; }
function applyFontScale(v) {
  if (!FONT_SCALES.includes(v)) v = '1';
  document.documentElement.style.setProperty('--fs-scale', v);
  $$('#fontSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
}
function applyTheme(t) {
  const activeTheme = t === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t;
  document.documentElement.setAttribute('data-theme', activeTheme);
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
  snap.journeys=(snap.journeys||[]).filter(j=>!j.shared);
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
  await loadSharedJourneys();
  clearInterval(journeySyncTimer);
  journeySyncTimer=setInterval(()=>{if(mode==='cloud'&&!document.hidden)loadSharedJourneys();},30000);
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
    textEl.textContent = 'Selected member pays 100% of this bill.';
  } else {
    textEl.textContent = `Split equally among ${count} selected members.`;
  }
}


// Detailed Split: General sheet (equal/custom costs) + Individual sheet (orders and service charges).
const tripRound = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
function allocateTripCents(amount, weights) {
  const entries = Object.entries(weights).filter(([,w]) => Number(w) > 0);
  const totalWeight = entries.reduce((s,[,w])=>s+Number(w),0);
  if (!entries.length || totalWeight <= 0) return null;
  const cents = Math.round(amount * 100);
  const exact = entries.map(([k,w]) => ({ k, exact:cents*Number(w)/totalWeight }));
  const base = exact.map(v=>({ ...v, cents:Math.floor(v.exact), remainder:v.exact-Math.floor(v.exact) }));
  let rest = cents - base.reduce((s,v)=>s+v.cents,0);
  base.sort((x,y)=>y.remainder-x.remainder || x.k.localeCompare(y.k));
  for (let i=0;i<rest;i++) base[i%base.length].cents++;
  return Object.fromEntries(base.map(v=>[v.k,tripRound(v.cents/100)]));
}
async function saveTripTypeRemote(id) {
  return rpcOk(sb.rpc('set_bill_trip_type', { p_bill:id, p_is_trip:true }),
    'Trip sharing requires the trip-split SQL migration in Supabase.');
}
// Delivery order arithmetic stays in integer cents and feeds the existing
// Detailed Split share/settlement engine; no change to legacy data formats.
const tripCents = n => Math.round(Number(n) * 100);
const tripCash = c => (c / 100).toFixed(2);
function deliveryValue(id) {
  const node = $(id);
  const s = node ? node.value.trim() : '';
  const n = s === '' ? 0 : Number(s);
  return Number.isFinite(n) && n >= 0 && /^\d*(?:\.\d{0,2})?$/.test(s) ? tripCents(n) : null;
}
// Largest-remainder allocation with deterministic member order.
function allocateDeliveryCents(totalCents, weights) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  if (!entries.length || totalCents < 0) return null;
  if (totalCents === 0) return Object.fromEntries(Object.keys(weights).map(k => [k, 0]));
  const weightSum = entries.reduce((sum, [, w]) => sum + w, 0);
  const splits = entries.map(([key, weight]) => {
    const exact = totalCents * weight / weightSum;
    return {key, value:Math.floor(exact), rem:exact-Math.floor(exact)};
  });
  let left = totalCents - splits.reduce((sum, s) => sum + s.value, 0);
  splits.sort((a,b)=>b.rem-a.rem || a.key.localeCompare(b.key));
  for (let i=0;i<left;i++) splits[i % splits.length].value++;
  return Object.fromEntries(Object.keys(weights).map(k => [k, splits.find(s=>s.key===k)?.value || 0]));
}
function deliveryDiscountParts(discount, capacities, mode) {
  const out=Object.fromEntries(Object.keys(capacities).map(k=>[k,0]));
  if (!discount) return out;
  if (discount > Object.values(capacities).reduce((s,v)=>s+v,0)) return null;
  if (mode === 'proportional') return allocateDeliveryCents(discount, capacities);
  // Equal reductions without making any person's share negative.
  let left=discount;
  while(left > 0) {
    const eligible=Object.keys(capacities).filter(k=>capacities[k]>out[k]);
    if(!eligible.length) return null;
    const attempt=allocateDeliveryCents(left,Object.fromEntries(eligible.map(k=>[k,1])));
    let paid=0;
    for (const k of eligible) {
      const delta=Math.min(attempt[k],capacities[k]-out[k]);
      out[k]+=delta; paid+=delta;
    }
    if(!paid) return null;
    left-=paid;
  }
  return out;
}
function readDeliveryOrders() {
  const chosen=$$('#tripMembersGrid [data-trip-member]').filter(x=>x.checked);
  const values={};
  for (const member of chosen) {
    const key=member.dataset.tripMember;
    const input=$$('#tripMembersGrid [data-trip-amount]').find(x=>x.dataset.tripAmount===key);
    const raw=input.value.trim();
    const n=raw === ''?0:Number(raw);
    if(!Number.isFinite(n)||n<0||!/^\d*(?:\.\d{0,2})?$/.test(raw)) return null;
    values[key]=tripCents(n);
  }
  return values;
}
function calculateDeliveryBill() {
  const orders=readDeliveryOrders();
  const fee=deliveryValue('deliveryFee'), platform=deliveryValue('deliveryPlatformFee'), discount=deliveryValue('deliveryDiscount');
  if (!orders||fee===null||platform===null||discount===null) return {error:'Use nonnegative amounts with up to 2 decimal places.'};
  const keys=Object.keys(orders);
  if(!keys.length) return {error:'Select at least one member.'};
  const subtotal=Object.values(orders).reduce((s,v)=>s+v,0), fees=fee+platform;
  const feeMode=$('deliveryFeeMode').value, discountMode=$('deliveryDiscountMode').value;
  // Equal splits are permitted for zero-value orders; proportional fees require positive orders.
  if(fees && feeMode==='proportional' && !subtotal) return {error:'Enter an order amount or split fees equally.'};
  const feeWeights=Object.fromEntries(keys.map(k=>[k,feeMode==='equal'?1:orders[k]]));
  const feeShares=allocateDeliveryCents(fees,feeWeights);
  if(!feeShares) return {error:'Could not allocate the fees.'};
  const preDiscount=Object.fromEntries(keys.map(k=>[k,orders[k]+feeShares[k]]));
  if(discount>subtotal+fees) return {error:'The discount cannot exceed the bill subtotal plus fees.'};
  const discountShares=deliveryDiscountParts(discount,preDiscount,discountMode);
  if(!discountShares) return {error:'Could not distribute the discount.'};
  const shares=Object.fromEntries(keys.map(k=>[k,preDiscount[k]-discountShares[k]]));
  return {orders,fee,platform,discount,subtotal,fees,feeMode,discountMode,shares,total:subtotal+fees-discount};
}
function setupTripExpenseForm(group, exp) {
  const wrap=$('tripExpenseFields'), normal=$('normalSplitParticipants');
  if (wrap) wrap.hidden=!group.trip;
  if (normal) normal.hidden=!!group.trip;
  if (!group.trip) return;
  const data=exp && exp.tripData || {};
  $('tripCategory').value=['food','delivery','general'].includes(data.category)?data.category:'general';
  $('tripAllocation').value='equal';
  $('tripServiceCharge').value=data.serviceCharge || '';
  $('deliveryFee').value=data.deliveryFee || '';
  $('deliveryPlatformFee').value=data.platformFee || '';
  $('deliveryDiscount').value=data.discount || '';
  $('deliveryFeeMode').value=data.feeMode || 'equal';
  $('deliveryDiscountMode').value=data.discountMode || 'proportional';
  $('tripMembersGrid').innerHTML=group.participants.map(p=>{
    const chosen=!exp || (data.shares && Object.hasOwn(data.shares,p.key));
    const value=data.orders && data.orders[p.key]!=null ? data.orders[p.key] :
      data.mode==='custom'&&data.shares ? data.shares[p.key] : '';
    return `<div class="trip-member-row"><label><input type="checkbox" data-trip-member="${esc(p.key)}" ${chosen?'checked':''}> ${esc(p.name)}</label><input type="number" inputmode="decimal" min="0" step="0.01" placeholder="Amount" data-trip-amount="${esc(p.key)}" value="${esc(value)}"></div>`;
  }).join('');
  updateTripFormMode();
  if (data.category==='general' && data.mode==='custom') {
    $('tripModeHelp').textContent='Previously custom: saving will split this expense equally. Review before saving.';
  }
}
function tripIsAutoAmount() {
  return $('tripCategory').value==='food' || $('tripCategory').value==='delivery';
}
function updateTripAmount() {
  const amountEl=$('splitExpAmount');
  if(!amountEl||!tripIsAutoAmount()) return;
  if($('tripCategory').value==='delivery') {
    const bill=calculateDeliveryBill();
    $('deliveryBreakdown').textContent=bill.error||`Orders ${money(bill.subtotal/100)} + fees ${money(bill.fees/100)} − discount ${money(bill.discount/100)} = ${money(bill.total/100)}`;
    $('deliveryBreakdown').classList.toggle('delivery-error',!!bill.error);
    amountEl.value=bill.error?'':tripCash(bill.total);
    return;
  }
  const orders=readDeliveryOrders();
  if(!orders) {amountEl.value='';return;}
  const subtotal=Object.values(orders).reduce((s,v)=>s+v,0);
  const fee=deliveryValue('tripServiceCharge');
  amountEl.value=fee===null?'':tripCash(subtotal+fee);
}
function updateTripFormMode() {
  const cat=$('tripCategory').value, food=cat==='food', delivery=cat==='delivery';
  const auto=tripIsAutoAmount();
  $('tripAllocationWrap').hidden=true; // Group is always equal; Individual and Food Delivery use dedicated calculations.
  $('tripServiceWrap').hidden=!food;
  $('deliveryExtras').hidden=!delivery;
  $$('#tripMembersGrid [data-trip-amount]').forEach(i=>i.hidden=!auto);
  $('tripMembersLabel').textContent=auto?'Members & individual order amounts':'Members';
  $('splitExpAmount').readOnly=auto;
  $('splitExpAmount').classList.toggle('trip-amount-auto',auto);
  $('splitExpAmount').title=auto?'Calculated automatically from member amounts and adjustments':'';
  $('tripModeHelp').textContent=delivery
    ? 'Check each person who ordered, then enter their food subtotal before fees and discounts.'
    : food ? 'Enter each person’s amount. Service charge is shared proportionally.'
    : 'Total is split equally among checked members.';
  if(auto) updateTripAmount();
}
function collectTripExpense(group,amount) {
  const chosen=$$('#tripMembersGrid [data-trip-member]').filter(x=>x.checked);
  if(!chosen.length){toast('Choose at least one member.');return null;}
  const cat=$('tripCategory').value;
  if(cat==='delivery') {
    const bill=calculateDeliveryBill();
    if(bill.error){toast(bill.error);return null;}
    if(bill.total<=0){toast('The bill total must be greater than zero.');return null;}
    if(bill.total!==tripCents(amount)){toast('Recheck the delivery total.');return null;}
    return {category:'delivery',mode:'delivery',serviceCharge:tripRound(bill.fees/100),
      deliveryFee:tripRound(bill.fee/100),platformFee:tripRound(bill.platform/100),discount:tripRound(bill.discount/100),
      feeMode:bill.feeMode,discountMode:bill.discountMode,
      orders:Object.fromEntries(Object.entries(bill.orders).map(([k,v])=>[k,tripRound(v/100)])),
      shares:Object.fromEntries(Object.entries(bill.shares).map(([k,v])=>[k,tripRound(v/100)]))};
  }
  if(cat==='general') {
    const shares=allocateTripCents(amount,Object.fromEntries(chosen.map(x=>[x.dataset.tripMember,1])));
    return {category:'general',mode:'equal',serviceCharge:0,orders:null,shares};
  }
  const orders=readDeliveryOrders();
  if(!orders){toast('Enter nonnegative amounts with up to two decimals.');return null;}
  const fee=deliveryValue('tripServiceCharge');
  if(fee===null){toast('Enter a valid service charge.');return null;}
  const subtotal=Object.values(orders).reduce((s,v)=>s+v,0);
  if(subtotal+fee!==tripCents(amount)){toast('Total must equal orders plus service charge.');return null;}
  if(fee && !subtotal){toast('Enter an order amount to distribute the fee.');return null;}
  const feeShares=fee?allocateDeliveryCents(fee,orders):Object.fromEntries(Object.keys(orders).map(k=>[k,0]));
  if(!feeShares){toast('Could not distribute the service charge.');return null;}
  const shares=Object.fromEntries(Object.keys(orders).map(k=>[k,tripRound((orders[k]+feeShares[k])/100)]));
  return {category:'food',mode:'food',serviceCharge:tripRound(fee/100),
    orders:Object.fromEntries(Object.entries(orders).map(([k,v])=>[k,tripRound(v/100)])),shares};
}
function renderTripSummary(group) {
  const all=group.expenses||[];
  const general=all.filter(e=>!e.tripData || e.tripData.category==='general');
  const food=all.filter(e=>e.tripData && e.tripData.category==='food');
  const delivery=all.filter(e=>e.tripData && e.tripData.category==='delivery');
  const total=xs=>tripRound(xs.reduce((s,e)=>s+Number(e.amount||0),0));
  const spent=Object.fromEntries(group.participants.map(p=>[p.key,0]));
  const owed=Object.fromEntries(group.participants.map(p=>[p.key,0]));
  all.forEach(e=>{
    spent[e.paidBy]=(spent[e.paidBy]||0)+Number(e.amount||0);
    const keys=e.participants&&e.participants.length?e.participants:group.participants.map(p=>p.key);
    const shares=e.tripData&&e.tripData.shares || allocateTripCents(Number(e.amount||0),Object.fromEntries(keys.map(k=>[k,1]))) || {};
    Object.entries(shares).forEach(([k,v])=>owed[k]=(owed[k]||0)+Number(v||0));
  });
  $('tripSummary').innerHTML=`<div class="trip-stat-grid"><div><small>Shared expenses</small><strong>${money(total(general))}</strong></div><div><small>Individual expenses</small><strong>${money(total(food))}</strong></div><div><small>Food delivery</small><strong>${money(total(delivery))}</strong></div></div><h2>Member breakdown</h2><div class="trip-table-wrap"><table class="trip-table"><thead><tr><th>Member</th><th>Paid</th><th>Share</th><th>Net*</th></tr></thead><tbody>${group.participants.map(p=>`<tr><td>${esc(p.name)}</td><td>${money(spent[p.key]||0)}</td><td>${money(owed[p.key]||0)}</td><td>${money((spent[p.key]||0)-(owed[p.key]||0))}</td></tr>`).join('')}</tbody></table></div><p class="fine">*Net before recorded reimbursements. See Balances for outstanding settlements.</p>`;
}

function bind() {
  const on = (id, evt, fn) => { const el = $(id); if (el) el.addEventListener(evt, fn); };

  if ($('dock')) {
    $('dock').addEventListener('click', e => {
      const b = e.target.closest('button[data-go]'); if (!b) return;
      if (location.hash === '#' + b.dataset.go) route(); else location.hash = '#' + b.dataset.go;
    });
  }

  if ($('billSortSelect')) {
    $('billSortSelect').value=billSortMode();
    $('billSortSelect').addEventListener('change', e=>{lsSet(billSortKey(),e.target.value);renderBillList();});
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
    const item = e.target.closest('.card-reminder-item'); if (!item) return;
    openPaidModal(item.dataset.id);
  });
  on('cardReminders', 'keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const item = e.target.closest('.card-reminder-item'); if (!item) return;
    e.preventDefault(); openPaidModal(item.dataset.id);
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

  const toggleExpenseSearch = (open) => {
    const panel = $('expenseSearchPanel');
    const button = $('btnExpenseSearch');
    if (!panel || !button) return;
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    button.classList.toggle('is-active', open);
    if (open) $('txSearch')?.focus();
    else if ($('txSearch')) {
      $('txSearch').value = '';
      txSearch = '';
      expanded.tx = false;
      renderExpenses();
      button.focus();
    }
  };
  on('btnExpenseSearch', 'click', () => toggleExpenseSearch($('expenseSearchPanel').hidden));
  on('btnExpenseSearchClose', 'click', () => toggleExpenseSearch(false));
  on('txSearch', 'keydown', e => { if (e.key === 'Escape') { e.preventDefault(); toggleExpenseSearch(false); } });
  on('txSearch', 'input', () => { txSearch = $('txSearch').value.trim().toLowerCase(); expanded.tx = false; renderExpenses(); });

  // A payment opens the same floating editor as a bill expense, never an inline X.
  on('splitExpensesGroupedList', 'click', e => {
    const paymentRow = e.target.closest('.edit-payment-row');
    if (paymentRow) openBillPayment(null, paymentRow.dataset.id);
  });
  on('splitExpensesGroupedList', 'keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('.edit-payment-row')) {
      e.preventDefault();openBillPayment(null,e.target.closest('.edit-payment-row').dataset.id);
    }
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
  // redraw the bar chart when its card changes width (rotation, window resize, sidebar layout)
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const h = $('barsBody');
      if (h && h.clientWidth && Math.abs(h.clientWidth - barsDrawnW) > 16 && currentPage === 'home') renderHome();
    }, 200);
  });
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
  on('recurSeg', 'click', e => {
    const b = e.target.closest('button'); if (!b) return;
    setSeg('recurSeg', b.dataset.v);
    if ($('recurringOptionsWrap')) $('recurringOptionsWrap').hidden = b.dataset.v !== 'monthly';
  });
  on('recurLenSeg', 'click', e => {
    const b = e.target.closest('button'); if (!b) return;
    setSeg('recurLenSeg', b.dataset.v);
    if ($('recurMonthsWrap')) $('recurMonthsWrap').hidden = b.dataset.v !== 'fixed';
  });

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

    const makeRecurring = segVal('recurSeg') === 'monthly';
    if (makeRecurring) {
      noteVal = noteVal || catVal;
      const indefinite = segVal('recurLenSeg') !== 'fixed';
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
    setSeg('recurSeg', 'once'); setSeg('recurLenSeg', 'ongoing');
    if ($('recurringOptionsWrap')) $('recurringOptionsWrap').hidden = true;
    if ($('recurMonthsWrap')) $('recurMonthsWrap').hidden = true;
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
  on('editRecurLenSeg', 'click', e => {
    const b = e.target.closest('button'); if (!b) return;
    setSeg('editRecurLenSeg', b.dataset.v);
    if ($('editRecurMonthsWrap')) $('editRecurMonthsWrap').hidden = b.dataset.v !== 'fixed';
  });

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
        f.indefinite = segVal('editRecurLenSeg') !== 'fixed';
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
  on('tripCategory','change',() => { $('tripAllocation').value='equal'; updateTripFormMode(); });
  on('tripAllocation','change',updateTripFormMode);
  on('tripServiceCharge','input',updateTripAmount);
  ['deliveryFee','deliveryPlatformFee','deliveryDiscount'].forEach(id=>on(id,'input',updateTripAmount));
  ['deliveryFeeMode','deliveryDiscountMode'].forEach(id=>on(id,'change',updateTripAmount));
  on('tripMembersGrid','input',updateTripAmount);
  on('tripMembersGrid','change',updateTripAmount);

  on('billKind','change',()=>{
    creatingTrip = $('billKind').value === 'detailed';
    if ($('groupTripHint')) $('groupTripHint').hidden = !creatingTrip;
  });
  if ($('btnAddPersonFabTop')) $('btnAddPersonFabTop').onclick = () => { creatingTrip = false; openBillEditor(null); };
  if ($('btnCreateTripSplit')) $('btnCreateTripSplit').onclick = () => { creatingTrip = true; openBillEditor(null); };

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
    if (!editId) creatingTrip = $('billKind').value === 'detailed';
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
        id: uid(), name, emoji: finalEmoji, archived: false, shared: true, trip: creatingTrip,
        createdBy: user.id, createdAt: new Date().toISOString(), meKey: profile.code, participants: parts, settlements: [], expenses: []
      };
      if (!(await saveBillRemote(g.id, name, finalEmoji, parts))) return;
      if (creatingTrip && !(await saveTripTypeRemote(g.id))) { await sb.from("bills").delete().eq("id",g.id); return; }
      state.billGroups.push(g); cacheWrite();
      sharedWith = parts.filter(p => p.code && !isMeParticipant(p)).length;
    } else {
      if (mode === 'cloud') toast('Sync is not set up yet, so this bill stays on this device.');
      state.billGroups.push({
        id: 'g_' + Date.now(), name, emoji: finalEmoji, archived: false, shared: false, trip: creatingTrip, createdAt: new Date().toISOString(),
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

  if ($('btnImportSplitwise')) $('btnImportSplitwise').onclick = () => {
    showActionSheet('Import expenses to this bill',
      'Choose a Splitwise-style CSV export. Imported transactions are added to this bill and shared equally across its current members. Review the CSV first; existing entries are not replaced.',
      [{text:'Choose CSV file', action:()=>$('splitwiseCsvInput')?.click()}]);
  };
  on('splitwiseCsvInput', 'change', e => {
    importSplitwiseCsv(e.target.files[0]); e.target.value = '';
  });

  on('splitDetailTabs', 'click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const order = ['expenses', 'balances'];
    const was = activeSplitTab;
    activeSplitTab = b.dataset.v; renderBillDetail();
    if (was !== activeSplitTab) slideIn($({ expenses: 'splitTabExpenses', balances: 'splitTabBalances' }[activeSplitTab]), order.indexOf(activeSplitTab) > order.indexOf(was) ? 1 : -1);
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

      $('splitExpenseModalTitle').textContent = group.trip ? 'Add Detailed Expense' : 'Add Shared Expense';
      setupTripExpenseForm(group, null);
      $('splitExpId').value = '';
      $('splitExpTitle').value = '';
      $('splitExpAmount').value = '';
      if (group.trip) updateTripFormMode();
      $('splitExpDate').value = today();
      if ($('splitExpRepeat')) $('splitExpRepeat').checked = false;
      if ($('splitRepeatStart')) $('splitRepeatStart').value = today();
      if ($('splitRepeatEnd')) $('splitRepeatEnd').value = '';
      if ($('splitRepeatDates')) $('splitRepeatDates').hidden = true;

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

  on('splitExpRepeat', 'change', () => { $('splitRepeatDates').hidden = !$('splitExpRepeat').checked; if (!$('splitRepeatStart').value) $('splitRepeatStart').value = $('splitExpDate').value || today(); });

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
    let tripData = null;
    if (group.trip) {
      tripData = collectTripExpense(group, amount);
      if (!tripData) return;
    }
    if (!group.trip && !selectedSplitParticipants.length) { toast('Select at least one person.'); return; }
    const repeats = !!$('splitExpRepeat')?.checked;
    const repeatStart = $('splitRepeatStart')?.value || dateVal;
    const repeatEnd = $('splitRepeatEnd')?.value || null;
    if (repeats && !/^\d{4}-\d{2}-\d{2}$/.test(repeatStart)) { toast('Choose a start date for the recurring expense.'); return; }
    if (repeats && repeatEnd && repeatEnd < repeatStart) { toast('End date must be on or after the start date.'); return; }
    const recurring = repeats ? { frequency:'monthly', startDate:repeatStart, endDate:repeatEnd, day:Number(repeatStart.slice(-2)) } : null;
    // The existing trip_data JSON column holds recurrence metadata for both
    // Standard and Detailed bills; no table or migration is required.
    tripData = { ...(tripData || {}), ...(recurring ? { recurring } : {}) };
    const exp = { id: existing ? existing.id : uid(), title, amount, paidBy, participants: group.trip ? Object.keys(tripData.shares) : [...selectedSplitParticipants], date: repeats ? repeatStart : dateVal, tripData };

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
      $('splitExpenseModalTitle').textContent = group.trip ? 'Edit Detailed Expense' : 'Edit Shared Expense';
      setupTripExpenseForm(group, exp);
      $('splitExpId').value = exp.id;
      $('splitExpTitle').value = exp.title;
      $('splitExpAmount').value = exp.amount;
      if (group.trip) updateTripFormMode();
      $('splitExpDate').value = exp.date;
      if ($('splitExpRepeat')) $('splitExpRepeat').checked = !!exp.tripData?.recurring;
      if ($('splitRepeatStart')) $('splitRepeatStart').value = exp.tripData?.recurring?.startDate || exp.date;
      if ($('splitRepeatEnd')) $('splitRepeatEnd').value = exp.tripData?.recurring?.endDate || '';
      if ($('splitRepeatDates')) $('splitRepeatDates').hidden = !exp.tripData?.recurring;

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
      if (!group.expenses.some(x => String(x.id) === expId)) {
        toast('Expense no longer exists. Refreshing bill.');
        renderBillDetail();
        return;
      }
      if (group.shared) {
        // Supabase can return no error when row-level security filters out a
        // deletion. Verify one row was actually removed before changing the UI.
        const r = await rpcOk(
          sb.from('bill_expenses').delete().eq('bill_id', group.id).eq('id', expId).select('id'),
          "Couldn't delete the expense."
        );
        if (!r) return;
        if (!Array.isArray(r.data) || !r.data.some(row => String(row.id) === expId)) {
          toast('Expense was not deleted in the cloud. Check access and retry.');
          scheduleSharedReload(0);
          return;
        }
      }
      group.expenses = group.expenses.filter(x => String(x.id) !== expId);
      persistGroup(group);
      $('splitExpId').value = '';
      $('addSplitExpenseModal').hidden = true;
      // renderBillDetail recalculates totals, the balance banner, and all
      // payer-to-person settlement suggestions from the remaining expenses.
      renderBillDetail();
      renderBillList();
      toast('Expense deleted. Balances updated.');
    };
  }

  // Balances and the contextual floating menu share the same payment dialog.
  on('splitBalancesList', 'click', e => {
    const r = e.target.closest('.settlement-action');
    if (!r) return;
    openBillPayment({ from: r.dataset.from, to: r.dataset.to });
  });

  on('settlePayer', 'change', syncPaymentAmountToPair);
  on('settleReceiver', 'change', syncPaymentAmountToPair);
  if ($('settleCancel')) $('settleCancel').onclick = () => { if ($('settleModal')) $('settleModal').hidden = true; };
  on('settleDelete', 'click', async () => {
    const group = state.billGroups.find(g => g.id === selectedGroupId);
    const paymentId = $('settleEditId').value;
    if (!group || !paymentId || !confirm('Delete this payment?')) return;
    if (group.shared) {
      const r = await rpcOk(sb.from('bill_settlements').delete().eq('id',paymentId).eq('bill_id',group.id).select('id'),"Couldn't delete the payment.");
      if (!r) return;
      if (!Array.isArray(r.data) || !r.data.length) { toast('Payment could not be deleted.'); return; }
    }
    group.settlements = (group.settlements || []).filter(p=>String(p.id)!==paymentId);
    persistGroup(group); $('settleModal').hidden=true; renderBillDetail(); toast('Payment deleted');
  });

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
    // Do not require an outstanding suggestion: payments are manually entered.
    // Overpayments become an opposite-direction balance, never vanish.
    if (!group.participants.some(p => p.key === from) || !group.participants.some(p => p.key === to)) { toast('Choose valid members.'); return; }

    const editId = $('settleEditId').value;
    const previous = editId ? (group.settlements || []).find(p => String(p.id) === editId) : null;
    if (editId && !previous) { toast('Original payment no longer exists. Refresh and retry.'); return; }
    const s = { id: previous?.id || uid(), from, to, amount, method, note, date: previous?.date || today() };
    if (group.shared) {
      const row = {from_key:from,to_key:to,amount,method,note};
      const query = previous
        ? sb.from('bill_settlements').update(row).eq('id',s.id).eq('bill_id',group.id).select('id')
        : sb.from('bill_settlements').insert({id:s.id,bill_id:group.id,...row,date:s.date}).select('id');
      const r = await rpcOk(query, "Couldn't save the payment. Check your connection and permissions.");
      if (!r) return;
      if (!Array.isArray(r.data) || !r.data.length) { toast('Payment was not saved. Check permissions.'); return; }
    }
    if (!group.settlements) group.settlements = [];
    if (previous) Object.assign(previous,s); else group.settlements.push(s);
    persistGroup(group);
    $('settleModal').hidden = true; renderBillDetail(); toast(previous ? 'Payment updated' : 'Payment recorded');
  });

  on('methodChips', 'click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    fMethod = b.dataset.v; expanded.tx = false;
    if ($('expenseFilterLabel')) $('expenseFilterLabel').textContent = ({all:'All methods',cash:'Cash',debit:'Debit',card:'Credit'})[fMethod] || 'All methods';
    if ($('expenseFilterDetails')) $('expenseFilterDetails').open = false;
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

  on('accentPicker', 'click', e => { const btn=e.target.closest('button[data-accent-choice]'); if (!btn) return; const v=btn.dataset.accentChoice; lsSet('ledger.accent',v); applyAccent(v); });

  on('fontSeg', 'click', e => {
    const b = e.target.closest('button'); if (!b) return;
    lsSet('ledger.fontScale', b.dataset.v); applyFontScale(b.dataset.v);
  });

  on('themeSeg', 'click', e => {
    const b = e.target.closest('button'); if (!b) return;
    lsSet('ledger.theme', b.dataset.v); applyTheme(b.dataset.v);
  });

  on('btnShareLedger', 'click', async () => {
    const url = new URL('./', window.location.href).href;
    const payload = { title: 'Ledger', text: 'Track expenses and split bills with Ledger.', url };
    try {
      if (navigator.share) { await navigator.share(payload); return; }
      await copyToClipboard(url);
      toast('Ledger link copied. Send it to a friend!');
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      try { await copyToClipboard(url); toast('Ledger link copied'); }
      catch { toast('Could not share link. Copy it from your browser address bar.'); }
    }
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
  on('emailLinkForm', 'submit', signInWithEmailLink);
  if ($('authLocal')) $('authLocal').onclick = () => { if (mode === 'cloud') showApp(); else enterLocal(); };

  fillCats($('category'), 'expense');
  if ($('date')) $('date').value = today();
}

function segVal(id) { const b = $$('#' + id + ' button.on')[0]; return b ? b.dataset.v : ''; }
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


// v60 — Journeys: a planned itinerary with estimates, independent from expenses.
let activeJourneyId = null;
let sharedJourneys = [];
let journeyFiles = [];
let journeyMembers = [];
let journeySyncTimer = null;
let journeySharedReady = false;
const ROUTE_BUCKET = 'ledger-route-files';
const CLOUD_FILE_LIMIT = 15 * 1024 * 1024;
const uploadMime = new Set(['image/jpeg','image/png','image/webp','image/gif','application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword','text/plain','application/zip']);
function journeysAll(){return [...(state.journeys||[]), ...sharedJourneys];}
function isSharedJourney(j){return !!j?.shared;}
function journeyOwner(j){return !j?.shared || (!!user && j.ownerId === user.id);}
function imageHttpUrl(value){try{const u=new URL(value);return u.protocol==='https:'?u.href:'';}catch{return '';}}
function safeFileName(name){return String(name||'attachment').replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,100);}
function stopPhotoUrls(p){return Array.isArray(p?.photoUrls)?p.photoUrls.filter(Boolean).slice(0,12):[];}
async function loadSharedJourneys(){
  if(mode!=='cloud'||!sb||!user)return;
  const {data,error}=await sb.from('ledger_routes').select('id,owner_id,data,updated_at').order('updated_at',{ascending:false});
  if(error){
    console.error('Shared Routes could not load:',error);
    journeySharedReady=false;
    if(currentPage==='journeys')toast('Could not load shared Routes: '+error.message);
    return;
  }
  sharedJourneys=(data||[]).map(row=>({...(row.data||{}),id:row.id,ownerId:row.owner_id,shared:true}));
  journeySharedReady=true;
  if(activeJourneyId&&!journeyById(activeJourneyId))activeJourneyId=null;
  if(currentPage==='journeys')renderJourneys();
}
async function loadJourneyExtras(j){
  journeyFiles=[];journeyMembers=[];
  if(!j?.shared||!sb)return;
  const [a,b]=await Promise.all([
    sb.from('ledger_route_files').select('id,route_id,stop_id,display_name,mime_type,storage_path,owner_id,assigned_user_id,created_at').eq('route_id',j.id).order('created_at',{ascending:false}),
    sb.from('ledger_route_members').select('user_id,display_name,ledger_code').eq('route_id',j.id)]);
  if(a.error)toast('Could not load files: '+a.error.message);else journeyFiles=a.data||[];
  if(b.error)toast('Could not load travelers: '+b.error.message);else journeyMembers=b.data||[];
  renderJourneyExtras();
  // Repaint after legacy Route extras in case an older cached fragment mutates the detail DOM.
  paintRouteSummary();
  requestAnimationFrame(paintRouteSummary);
}
async function persistJourney(j){
  if(!j.shared){save();return true;}
  if(!sb||!user){toast('Sign in to edit shared routes');return false;}
  const data={title:j.title,destination:j.destination,startDate:j.startDate,notes:j.notes,stops:j.stops,tickets:j.tickets||[],links:j.links||[],emoji:j.emoji||"🧭",linkedBillId:j.linkedBillId||"",archived:!!j.archived,travelers:j.travelers||[],createdAt:j.createdAt||""};
  const {error}=await sb.from('ledger_routes').update({data,updated_at:new Date().toISOString()}).eq('id',j.id);
  if(error){toast('Could not save shared route: '+error.message);await loadSharedJourneys();return false;}
  return true;
}
function journeyFileRows(stopId){
  return journeyFiles.filter(f=>stopId===undefined||f.stop_id===stopId).map(f=>{
    const name=esc(f.display_name), assigned=journeyMembers.find(m=>m.user_id===f.assigned_user_id),stop=journeyById(activeJourneyId)?.stops.find(p=>p.id===f.stop_id);
    return `<div class="route-file-row"><span class="route-file-name">📎 ${name}<small>${f.assigned_user_id?'Private · '+esc(assigned?.display_name||'Assigned traveler'):'Shared with everyone'}${stop?' · '+esc(stop.title):''}</small></span><button type="button" class="secondary" data-route-file-open="${esc(f.id)}">Open</button>${user&&f.owner_id===user.id||journeyOwner(journeyById(activeJourneyId))?`<button class="secondary" type="button" data-route-file-remove="${esc(f.id)}">Remove</button>`:''}</div>`;
  }).join('');
}
function renderJourneyExtras(){
  const j=journeyById(activeJourneyId);if(!j)return;
  const panel=$('journeyCollab');if(!panel)return;
  const shared=!!j.shared;
  panel.hidden=false;
  if($('journeyShareBtn'))$('journeyShareBtn').hidden=shared||mode!=='cloud'||!sb;
  if($('journeySharingStatus'))$('journeySharingStatus').textContent=shared?'Shared · '+(journeyOwner(j)?'You manage this route':'Member access'):'Private route · saved to your Ledger';
  if($('journeyShareHint'))$('journeyShareHint').textContent=mode==='cloud'?'Share a route to invite people by Ledger ID and securely attach files.':'Sign in to sync routes and upload shared files.';
  if($('journeyInviteForm'))$('journeyInviteForm').hidden=!shared||!journeyOwner(j);
  if($('journeyMemberList'))$('journeyMemberList').innerHTML=shared?(journeyMembers.map(m=>`<div class="route-member"><span>👤 ${esc(m.display_name||'Ledger user')} ${m.ledger_code?'· #'+esc(m.ledger_code):''} ${m.user_id===j.ownerId?'· Owner':''}</span>${journeyOwner(j)&&m.user_id!==j.ownerId?`<button type="button" class="secondary" data-route-remove-member="${esc(m.user_id)}">Remove</button>`:''}</div>`).join('')||'<p class="fine">Loading travelers…</p>'):'<p class="fine">Share this route to manage travelers.</p>';
  if($('journeyFilesSection'))$('journeyFilesSection').hidden=!shared;
  if($('journeyFiles'))$('journeyFiles').innerHTML=journeyFileRows()||'<p class="fine">No shared files yet. Add an itinerary, PDF, PowerPoint, or exported Canva file.</p>';
  if($('journeyDocTraveler'))$('journeyDocTraveler').innerHTML='<option value="">All route members</option>'+journeyMembers.map(m=>`<option value="${esc(m.user_id)}">${esc(m.display_name||'Traveler')}${m.user_id===j.ownerId?' (owner)':''}</option>`).join('');
  if($('journeyDocStop'))$('journeyDocStop').innerHTML='<option value="">General itinerary / documents</option>'+(j.stops||[]).map(p=>`<option value="${esc(p.id)}">${esc(p.title)}</option>`).join('');
  if($('journeyLinkForm'))$('journeyLinkForm').hidden=!shared||!journeyOwner(j);
  if($('journeyLinks'))$('journeyLinks').innerHTML=(j.links||[]).map(l=>{
    const url=imageHttpUrl(l.url);if(!url)return '';
    return `<div class="route-file-row"><span class="route-file-name">🔗 ${esc(l.title||'Link')}</span><a class="route-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open</a>${journeyOwner(j)?`<button type="button" class="secondary" data-route-link-remove="${esc(l.id)}">Remove</button>`:''}</div>`;
  }).join('')||'<p class="fine">No links yet. Keep a Canva or booking link handy for the group.</p>';
  // Non-owners can share files or attach files addressed only to themselves.
  if(!journeyOwner(j)&&$('journeyDocTraveler'))Array.from($('journeyDocTraveler').options).forEach(o=>{if(o.value&&o.value!==user?.id)o.remove();});
  const selected=$('stopPhotoGallery'); if(selected){
    const stop=j.stops.find(p=>p.id===$('stopId').value);
    const photos=stopPhotoUrls(stop);
    selected.innerHTML=photos.map((url,i)=>`<div class="route-photo"><img src="${esc(url)}" loading="lazy" alt="Destination photo"><button type="button" data-route-photo-remove="${i}" aria-label="Remove photo">×</button></div>`).join('');
    const attached=journeyFiles.filter(f=>f.stop_id===stop?.id&&f.mime_type?.startsWith('image/'));
    selected.innerHTML+=attached.map(f=>`<button class="route-photo route-photo-file" type="button" data-route-file-open="${esc(f.id)}">📷 ${esc(f.display_name)}</button>`).join('');
    if(sb)attached.forEach(async f=>{
      const response=await sb.storage.from(ROUTE_BUCKET).createSignedUrl(f.storage_path,120);
      if(!response.error&&response.data?.signedUrl){
        const el=Array.from(selected.querySelectorAll('[data-route-file-open]')).find(x=>x.dataset.routeFileOpen===f.id);
        if(el){el.textContent='';const img=document.createElement('img');img.src=response.data.signedUrl;img.alt=f.display_name;img.loading='lazy';el.appendChild(img);}
      }
    });
  }
}
async function signedFileOpen(id){
  const f=journeyFiles.find(x=>x.id===id);if(!f||!sb)return;
  // Open an empty tab during the user's click, before awaiting the network.
  // Otherwise iOS Safari blocks the signed URL as an unsolicited popup.
  const tab=window.open('about:blank','_blank');
  if(tab){tab.opener=null;tab.document.title='Opening document…';}
  const {data,error}=await sb.storage.from(ROUTE_BUCKET).createSignedUrl(f.storage_path,60);
  if(error||!data?.signedUrl){if(tab)tab.close();toast('Access denied or file unavailable');return;}
  // Private Storage object; URL expires after 60 seconds.
  if(tab)tab.location.replace(data.signedUrl);
  else window.location.assign(data.signedUrl);
}
async function uploadJourneyFile(){
  let j=journeyById(activeJourneyId);if(!j){toast('Open a Route first');return;}
  const ticketId=$('routeTicketId')?.value||'',existing=ticketId?(j.tickets||[]).find(t=>String(t.id)===String(ticketId)):null;
  const category=$('routeTicketCategory')?.value||'plane',place=$('routeTicketPlace')?.value.trim()||'',route=$('routeTicketRoute')?.value.trim()||'',dt=$('routeTicketDateTime')?.value||'';
  if(!place){toast('Enter the '+((ticketCategoryMeta[category]||ticketCategoryMeta.plane).place.toLowerCase()));return;}
  if(!route){toast('Enter the route');return;} if(!dt){toast('Add the date and time');return;}
  const [date,timeRaw]=dt.split('T'),time=(timeRaw||'').slice(0,5);
  const priceInputs=[...document.querySelectorAll('#routeTicketTravelerFiles [data-ticket-price]')],travelerPrices={};
  for(const i of priceInputs){const v=Number(i.value||0);if(!Number.isFinite(v)||v<0){toast('Enter valid ticket prices');return;}travelerPrices[i.dataset.ticketPrice]=Math.round(v*100)/100;}
  const cost=Math.round(Object.values(travelerPrices).reduce((n,v)=>n+(Number(v)||0),0)*100)/100;
  if($('routeTicketCost'))$('routeTicketCost').value=money(cost);
  // Links live in the ticket metadata; no file bytes are uploaded to Supabase.
  const attachmentLinks={};
  for(const input of document.querySelectorAll('#routeTicketTravelerFiles [data-ticket-link]')){
    const link=input.value.trim();
    if(!link)continue;
    let url;
    try{url=new URL(link);}catch{toast('Enter a valid HTTPS attachment link');input.focus();return;}
    if(url.protocol!=='https:'||!url.hostname){toast('Attachment links must use HTTPS');input.focus();return;}
    if(link.length>2048){toast('Attachment link is too long');input.focus();return;}
    attachmentLinks[input.dataset.ticketLink]=url.href;
  }
  const ticket=existing||{id:uid(),archived:false,travelerLabels:[]};
  Object.assign(ticket,{name:(place+(route?' ('+route+')':'')).slice(0,120),category,place:place.slice(0,160),route:route.slice(0,80),date,time,cost,travelerPrices,attachmentLinks});
  j.tickets ||= [];if(!existing)j.tickets.push(ticket);
  const btn=$('journeyUploadBtn');if(btn){btn.disabled=true;btn.textContent=existing?'Saving…':'Adding…';}
  let metadataSaved=false;
  try{
    if(!await persistJourney(j))throw Error('Ticket details could not be saved');metadataSaved=true;
    closeRouteOverlays();renderJourneys();toast(existing?'Ticket updated':'Ticket added');
  }catch(e){if(!metadataSaved&&!existing)j.tickets=(j.tickets||[]).filter(t=>t!==ticket);toast('Could not save ticket: '+String(e?.message||e||'Unknown error'));}
  finally{if(btn){btn.disabled=false;btn.textContent=existing?'Save changes':'Add ticket/s';}}
}
async function shareJourney(j){
  if(mode!=='cloud'||!sb||!user){toast('Sign in first to share a route');return;}
  const data={title:j.title,destination:j.destination,startDate:j.startDate,notes:j.notes,stops:j.stops,tickets:j.tickets||[],links:j.links||[],emoji:j.emoji||"🧭",linkedBillId:j.linkedBillId||"",archived:!!j.archived,travelers:j.travelers||[],createdAt:j.createdAt||""};
  // The RPC derives the route owner from the verified JWT, not local cached account state.
  // It also avoids requiring a SELECT of the newly inserted row in the same browser request.
  const {data:authData,error:authError}=await sb.auth.getUser();
  const activeUser=authData?.user;
  if(authError||!activeUser){toast('Your sign-in session has expired. Sign in again to share this route.');return;}
  if(!activeUser.id||activeUser.id!==user.id){toast('Your account session changed. Refresh Ledger and try again.');return;}
  const res=await sb.rpc('ledger_route_create',{p_route_id:j.id,p_data:data});
  if(res.error){
    console.error('Route sharing failed', {code:res.error.code, message:res.error.message, details:res.error.details, hint:res.error.hint});
    const missing=res.error.code==='PGRST202'||/ledger_route_create.*(not found|schema cache)/i.test(res.error.message||'');
    toast(missing?'Route sharing setup is missing. Run FIX-ROUTE-SHARING-v63.sql in Supabase first.':'Could not share route: '+res.error.message);
    return;
  }
  state.journeys=state.journeys.filter(x=>x.id!==j.id);save();
  await loadSharedJourneys();await loadJourneyExtras(journeyById(j.id));
  const shared=journeyById(j.id);
  let invited=true;
  if(shared&&j.inviteCodes?.length){shared.inviteCodes=j.inviteCodes;invited=await sendRouteInvitations(shared);}
  if(shared&&invited)await syncRouteTravelersToLinkedBill(shared);
  if(shared&&invited)toast('Route shared with invited travelers.');
  return !!shared&&invited;
}

let routeArchiveView=false;
let routeTravelerDraft=[];
const ROUTE_EMOJIS = ['🧭','🏕️','✈️','🏖️','🏔️','🌸','🚗','🚆','⛵','🌆','🎒','🌴','🌅','🗺️','🏛️','🎡'];
const JTYPE = {place:'Place',transport:'Transport',activity:'Activity',stay:'Stay',food:'Food'};
function journeyById(id){return journeysAll().find(j=>j.id===id);}
// Keep one document upload form: it is moved into the dedicated floating Ticket sheet.
function showRouteOverlay(id, cardId){
  const overlay=$(id);
  if(!overlay)return false;
  if(overlay.parentElement!==document.body)document.body.appendChild(overlay);
  overlay.hidden=false;
  overlay.removeAttribute('hidden');
  overlay.style.display='flex';
  if(cardId){const card=$(cardId);if(card){card.hidden=false;card.removeAttribute('hidden');}}
  requestAnimationFrame(()=>overlay.classList.add('route-overlay-open'));
  return true;
}
function hideRouteOverlay(id){
  const overlay=$(id);if(!overlay)return;
  overlay.classList.remove('route-overlay-open');
  overlay.style.display='';
  overlay.hidden=true;
}
function routeTicketTravelers(j){
  const out=[],seen=new Set();
  const add=(label,key,isOwner=false)=>{label=String(label||'').trim();key=String(key||label).trim().toUpperCase();if(!label||seen.has(key))return;seen.add(key);out.push({label,key,isOwner,isSelf:!!user&&String(key)===String(user.id).toUpperCase()});};
  const owner=journeyMembers.find(m=>m.user_id===j.ownerId);
  const ownerName=owner?.display_name||(journeyOwner(j)?displayName():'')||'Owner';
  add(ownerName,j.ownerId||profile?.code||'owner',true);
  (journeyMembers||[]).forEach(m=>add(m.display_name||'Traveler',m.user_id,m.user_id===j.ownerId));
  const memberCodes=new Set((journeyMembers||[]).map(m=>parseLedgerId(m.ledger_code||'')).filter(Boolean));
  (j.travelers||[]).forEach(t=>{
    const code=parseLedgerId(t.code||'');
    if(code&&(memberCodes.has(code)||code===profile?.code))return;
    if(!code&&String(t.name||'').trim().toLowerCase()===ownerName.toLowerCase())return;
    add(t.name||t.code||'Traveler',t.code||t.name,false);
  });
  const me=out.findIndex(p=>p.isSelf);
  if(me>0)out.unshift(...out.splice(me,1));
  return out;
}
const ticketCategoryMeta={plane:{icon:'✈️',label:'Airplane',place:'Airport',placePh:'Bicol International Airport',route:'Flight route',routePh:'LEG-MNL'},bus:{icon:'🚌',label:'Bus',place:'Terminal',placePh:'PITX',route:'Bus route',routePh:'CUBAO-SAGADA'},train:{icon:'🚉',label:'Train',place:'Station',placePh:'Tokyo Station',route:'Train route',routePh:'TOKYO-KYOTO'}};
function routeTicketTotalFromInputs(){
  const total=[...document.querySelectorAll('#routeTicketTravelerFiles [data-ticket-price]')].reduce((n,i)=>n+(Number(i.value)||0),0);
  if($('routeTicketCost'))$('routeTicketCost').value=money(total);
  return Math.round(total*100)/100;
}
function updateRouteTicketLabels(){
  const cat=$('routeTicketCategory')?.value||'plane',m=ticketCategoryMeta[cat]||ticketCategoryMeta.plane;
  if($('routeTicketCategoryIcon'))$('routeTicketCategoryIcon').textContent=m.icon;
  if($('routeTicketPlaceLabel'))$('routeTicketPlaceLabel').textContent=m.place;
  if($('routeTicketPlace'))$('routeTicketPlace').placeholder=m.placePh;
  if($('routeTicketRouteLabel'))$('routeTicketRouteLabel').textContent=m.route;
  if($('routeTicketRoute'))$('routeTicketRoute').placeholder=m.routePh;
}
function openRouteTicketForm(ticket=null){
  try{
    const j=journeyById(activeJourneyId);if(!j){toast('Open a Route first');return;}
    closeRouteOverlays();
    if($('routeTicketId'))$('routeTicketId').value=ticket?.id||'';
    if($('routeTicketTitle'))$('routeTicketTitle').textContent=ticket?'Edit Ticket':'Add a Ticket';
    if($('routeTicketCategory'))$('routeTicketCategory').value=ticket?.category||'plane';
    if($('routeTicketPlace'))$('routeTicketPlace').value=ticket?.place||'';
    if($('routeTicketRoute'))$('routeTicketRoute').value=ticket?.route||'';
    const d=ticket?.date||j.startDate||today(),tm=ticket?.time||'';
    if($('routeTicketDateTime'))$('routeTicketDateTime').value=d+(tm?'T'+tm:'T12:00');
    if($('journeyUploadBtn'))$('journeyUploadBtn').textContent=ticket?'Save changes':'Add ticket/s';
    updateRouteTicketLabels();
    const host=$('routeTicketTravelerFiles');
    if(host){
      const people=routeTicketTravelers(j),prices=ticket?.travelerPrices||{},links=ticket?.attachmentLinks||{};
      host.innerHTML=people.length?people.map(p=>`<div class="route-ticket-person"><div class="route-ticket-person-name">${esc(p.label)}${p.isSelf?' <small>(You)</small>':p.isOwner?' <small>(Owner)</small>':''}</div><div class="row2"><input type="number" min="0" max="999999999" step="0.01" inputmode="decimal" placeholder="0.00" aria-label="Ticket price for ${esc(p.label)}" data-ticket-price="${esc(p.key)}" value="${esc(prices[p.key]??'')}"><input type="url" inputmode="url" autocomplete="off" placeholder="Paste Drive link" aria-label="Ticket attachment link for ${esc(p.label)}" data-ticket-link="${esc(p.key)}" value="${esc(links[p.key]||'')}"></div></div>`).join(''):'<p class="fine">Add travelers to this Route first.</p>';
    }
    routeTicketTotalFromInputs();
    if(!showRouteOverlay('routeTicketOverlay'))toast(`Could not open ${ticket?'Edit Ticket':'Add a Ticket'}`);
  }catch(err){console.error('openRouteTicketForm failed',err);toast('Could not open Ticket form: '+(err?.message||'Unknown error'));}
}
function closeRouteOverlays(){
  hideRouteOverlay('routeEditorOverlay');
  hideRouteOverlay('routeStopOverlay');
  hideRouteOverlay('routeOptionsOverlay');
  hideRouteOverlay('routeCollabOverlay');
  hideRouteOverlay('routeTicketOverlay');
  hideRouteOverlay('routeTicketDetailOverlay');
  if($('journeyEditor'))$('journeyEditor').hidden=true;
  if($('stopEditor'))$('stopEditor').hidden=true;
}
function showJourneyEditor(open){
  const el=$('journeyEditor');if(!el)return;
  hideRouteOverlay('routeOptionsOverlay');
  if($('stopEditor'))$('stopEditor').hidden=true;
  if(open)showRouteOverlay('routeEditorOverlay','journeyEditor');
  else hideRouteOverlay('routeEditorOverlay');
}
function routeEmojiPicker(value='🧭'){
  $('journeyEmoji').value=value;
  if($('routeAvatarTrigger'))$('routeAvatarTrigger').textContent=value;
}
function routeAvailableBills(selected=''){
  $('journeyLinkedBillSelect').innerHTML='<option value="">No linked bill</option>'+(state.billGroups||[]).filter(g=>!g.archived).map(g=>`<option value="${esc(g.id)}" ${String(g.id)===selected?'selected':''}>${esc(g.name)}</option>`).join('');
}
// v73 — Route -> linked Bill membership (additive, owner-authorized).
// A name-only traveler is a bill participant, but not an account with cloud access.
// Account sharing occurs only after a Ledger ID is a confirmed Route member.
async function syncRouteTravelersToLinkedBill(j, {quiet=false}={}) {
  if(!j?.linkedBillId)return true;
  if(!j.shared||!sb||!user||mode!=='cloud'){
    if(!quiet)toast('Share this Route first to sync travelers with its linked Bill.');
    return false;
  }
  if(!journeyOwner(j))return false;
  try {
    // Re-read both source and target from Supabase: never grant Bill access on
    // the strength of a locally typed (possibly failed) invitation alone.
    const [routeResponse,billResponse,membersResponse]=await Promise.all([
      sb.from('ledger_routes').select('id,owner_id,data').eq('id',j.id).single(),
      sb.from('bills').select('id,name,emoji,participants,created_by').eq('id',j.linkedBillId).single(),
      sb.from('ledger_route_members').select('user_id,ledger_code,display_name').eq('route_id',j.id)
    ]);
    for(const result of [routeResponse,billResponse,membersResponse])if(result.error)throw result.error;
    const routeRow=routeResponse.data,bill=billResponse.data;
    if(routeRow.owner_id!==user.id || String(routeRow.data?.linkedBillId||'')!==String(bill.id)){
      throw Error('Save the Route link as its owner before syncing members.');
    }
    if(bill.created_by!==user.id){
      throw Error('Only the linked Bill owner can automatically share it. Ask the Bill owner to link a Bill they own.');
    }
    const parts=(Array.isArray(bill.participants)?bill.participants:[]).map(p=>({...p}));
    const knownCodes=new Set(parts.map(p=>String(p.code||'').toUpperCase()).filter(Boolean));
    const knownNames=new Set(parts.filter(p=>!p.code).map(p=>String(p.name||'').trim().toLocaleLowerCase()).filter(Boolean));
    let added=0;
    // Names are shown as Bill participants; without a Ledger ID there is no
    // account to authorize and no cloud invitation to issue.
    for(const t of (Array.isArray(routeRow.data?.travelers)?routeRow.data.travelers:[])){
      if(t.code)continue;
      const name=String(t.name||'').trim().slice(0,80);
      if(!name||knownNames.has(name.toLocaleLowerCase()))continue;
      parts.push({key:name,name,code:null});knownNames.add(name.toLocaleLowerCase());added++;
    }
    // Only verified Route members, not unconfirmed typed IDs, can access Bill.
    for(const m of (membersResponse.data||[])){
      const code=parseLedgerId(m.ledger_code||'');
      if(!code||knownCodes.has(code))continue;
      const name=String(m.display_name||'Ledger user').trim().slice(0,80)||'Ledger user';
      parts.push({key:code,name,code});knownCodes.add(code);added++;
    }
    if(!added)return true;
    const result=await sb.rpc('upsert_bill',{
      p_id:bill.id,p_name:bill.name,p_emoji:bill.emoji,
      p_participants:partsPayload(parts)
    });
    if(result.error)throw result.error;
    // Verify members are actually persisted; only then update the local view.
    const checked=await sb.from('bills').select('participants').eq('id',bill.id).single();
    if(checked.error)throw checked.error;
    const stored=checked.data?.participants||[];
    if(parts.some(p=>!stored.some(x=>String(x.key)===String(p.key)))){
      throw Error('The Bill update could not be verified. Please refresh and retry.');
    }
    const localBill=(state.billGroups||[]).find(g=>String(g.id)===String(bill.id));
    if(localBill){localBill.participants=stored.map(p=>({...p}));cacheWrite();}
    scheduleSharedReload(0);
    if(!quiet)toast(`${added} traveler${added===1?'':'s'} added to linked Bill.`);
    return true;
  } catch(error){
    console.error('Route -> Bill membership sync failed:',error);
    toast('Linked Bill not synced: '+String(error.message||error).slice(0,170));
    return false;
  }
}

async function sendRouteInvitations(j){
  if(!j?.shared||!journeyOwner(j)||!sb)return false;
  const codes=[...new Set((j.inviteCodes||[]).map(parseLedgerId).filter(Boolean))];
  if(!codes.length)return true;
  const failed=[];
  const reasons=[];
  for(const code of codes){
    const {error}=await sb.rpc('ledger_route_invite',{p_route_id:j.id,p_ledger_code:code});
    if(error){
      console.error('Route invitation failed',code,error);
      failed.push(code);
      reasons.push(`#${code}: ${error.message}`);
    }
  }
  j.inviteCodes=failed;
  // Store retry state on the owner's local account; never report an invitation
  // as successful when Supabase rejected the member insert.
  if(failed.length){
    const key='ledger.route.pending.'+(user?.id||'local')+'.'+j.id;
    lsSet(key,JSON.stringify(failed));
    toast('Route invite failed: '+reasons.join(' | ').slice(0,250));
  }else{
    lsDel('ledger.route.pending.'+(user?.id||'local')+'.'+j.id);
    toast('Travelers invited. The Route will appear on their Routes page.');
  }
  // Verify membership directly from Supabase instead of relying on legacy UI state.
  if(!failed.length){
    const check=await sb.from('ledger_route_members').select('ledger_code').eq('route_id',j.id);
    if(check.error){
      console.error('Route invitation verification failed',check.error);
      toast('Travelers were invited, but Ledger could not verify membership: '+check.error.message);
      return false;
    }
    const visible=new Set((check.data||[]).map(m=>parseLedgerId(m.ledger_code||'')).filter(Boolean));
    const missing=codes.filter(code=>!visible.has(code));
    if(missing.length){
      console.warn('Route invitations not visible after save:',missing);
      j.inviteCodes=missing;
      const key='ledger.route.pending.'+(user?.id||'local')+'.'+j.id;
      lsSet(key,JSON.stringify(missing));
      toast('Could not verify these Ledger IDs: '+missing.map(c=>'#'+c).join(', '));
      return false;
    }
  }
  await loadJourneyExtras(j);
  return failed.length===0;
}

// Route list preferences use the same account-specific, device-local model as Bill Splitter.
const routePrefsKey = part => 'ledger.route.'+part+'.'+(mode==='cloud'&&user?user.id:'local');
const routePinnedIds = () => readStringArray(routePrefsKey('pins'));
const routeSortMode = () => lsGet(routePrefsKey('sort'))||'manual';
function routeOrdered(items){
  const how=routeSortMode(), xs=items.slice();
  if(how==='az')return xs.sort((a,b)=>a.title.localeCompare(b.title));
  if(how==='za')return xs.sort((a,b)=>b.title.localeCompare(a.title));
  if(how==='date')return xs.sort((a,b)=>(a.startDate||'9999').localeCompare(b.startDate||'9999'));
  if(how==='newest')return xs.sort((a,b)=>(Date.parse(b.createdAt||'')||0)-(Date.parse(a.createdAt||'')||0));
  const order=readStringArray(routePrefsKey('order'));
  const pos=new Map(order.map((id,i)=>[id,i]));
  return xs.sort((a,b)=>(pos.get(String(a.id))??1e9)-(pos.get(String(b.id))??1e9));
}
function toggleRoutePin(id){
  const pins=new Set(routePinnedIds()),key=String(id),was=pins.has(key);
  if(was)pins.delete(key);else pins.add(key);
  lsSet(routePrefsKey('pins'),JSON.stringify([...pins]));
  renderJourneys();toast(was?'Route unpinned':'Route pinned to top');
}
function moveRoute(id,targetId){
  const pins=new Set(routePinnedIds());
  if(pins.has(id)!==pins.has(targetId)){toast('Move pinned routes within the pinned section');return;}
  const all=journeysAll().filter(j=>!j.archived),ordered=[...routeOrdered(all.filter(j=>pins.has(String(j.id)))),...routeOrdered(all.filter(j=>!pins.has(String(j.id))))];
  const ids=ordered.map(j=>String(j.id)),from=ids.indexOf(id),to=ids.indexOf(targetId);
  if(from<0||to<0||from===to)return;
  ids.splice(from,1);ids.splice(to,0,id);
  lsSet(routePrefsKey('order'),JSON.stringify(ids));lsSet(routePrefsKey('sort'),'manual');
  if($('routeSortSelect'))$('routeSortSelect').value='manual';
  renderJourneys();
}
function initRouteDrag(){
  const host=$('journeyList');if(!host||host.dataset.dragReady)return;
  host.dataset.dragReady='1';let dragging=null,target=null;
  const clear=()=>{host.querySelectorAll('.journey-tile').forEach(x=>x.classList.remove('dragging','drop-target'));dragging=null;target=null;};
  host.addEventListener('pointerdown',e=>{const h=e.target.closest('.bill-drag-handle'),card=h?.closest('.journey-tile');if(!card)return;
    e.preventDefault();e.stopPropagation();dragging=card.dataset.journeyOpen;h.setPointerCapture(e.pointerId);card.classList.add('dragging');});
  host.addEventListener('pointermove',e=>{if(!dragging)return;const c=document.elementFromPoint(e.clientX,e.clientY)?.closest('.journey-tile');
    host.querySelectorAll('.journey-tile').forEach(x=>x.classList.remove('drop-target'));
    target=c&&c.dataset.journeyOpen!==dragging?c.dataset.journeyOpen:null;if(target)c.classList.add('drop-target');});
  host.addEventListener('pointerup',()=>{const from=dragging,to=target;clear();if(from&&to)moveRoute(from,to);});
  host.addEventListener('pointercancel',clear);
  host.addEventListener('keydown',e=>{const h=e.target.closest('.bill-drag-handle');if(!h||!['ArrowUp','ArrowDown'].includes(e.key))return;
    const c=h.closest('.journey-tile');if(!c)return;e.preventDefault();const pins=new Set(routePinnedIds());
    const cards=[...host.querySelectorAll('.journey-tile')].filter(x=>pins.has(x.dataset.journeyOpen)===pins.has(c.dataset.journeyOpen));
    const next=cards[cards.indexOf(c)+(e.key==='ArrowUp'?-1:1)];if(next)moveRoute(c.dataset.journeyOpen,next.dataset.journeyOpen);});
}
async function setRouteArchived(j,archived){
  if(!j||!journeyOwner(j)){toast('Only the route owner can do that');return false;}
  const old=j.archived;j.archived=archived;
  if(!await persistJourney(j)){j.archived=old;return false;}
  if(activeJourneyId===j.id&&archived)activeJourneyId=null;
  renderJourneys();toast(archived?'Route archived':'Route restored');return true;
}
async function deleteJourney(j){
  if(!j)return false;
  const owner=journeyOwner(j);
  if(!confirm(j.shared&&!owner?`Leave route “${j.title}”?`:`Permanently delete “${j.title}” and its itinerary and files? Its linked bill will be kept.`))return false;
  if(j.shared){
    if(owner){
      const docs=await sb.from('ledger_route_files').select('storage_path').eq('route_id',j.id);
      if(docs.error){toast('Could not list route documents: '+docs.error.message);return false;}
      const paths=(docs.data||[]).map(f=>f.storage_path);
      if(paths.length){const r=await sb.storage.from(ROUTE_BUCKET).remove(paths);if(r.error){toast('Could not remove route documents: '+r.error.message);return false;}}
    }
    const result=await (owner?sb.from('ledger_routes').delete().eq('id',j.id):sb.from('ledger_route_members').delete().eq('route_id',j.id).eq('user_id',user.id));
    if(result.error){toast(result.error.message);return false;}
    await loadSharedJourneys();
  }else{state.journeys=state.journeys.filter(x=>x.id!==j.id);save();}
  if(activeJourneyId===j.id)activeJourneyId=null;
  closeRouteOverlays();renderJourneys();toast(owner?'Route deleted':'You left the route');return true;
}
function routeActionMenu(j){
  const pins=new Set(routePinnedIds()),actions=[];
  if(journeyOwner(j)){
    actions.push({text:pins.has(String(j.id))?'📌 Unpin Route':'📌 Pin Route',action:()=>toggleRoutePin(j.id)});
    actions.push({text:'📁 Archive Route',action:()=>setRouteArchived(j,true)});
    actions.push({text:'✏️ Edit Route Details',action:()=>openJourneyForm(j)});
    actions.push({text:'🗑️ Delete Route',danger:true,action:()=>deleteJourney(j)});
  }else{
    actions.push({text:pins.has(String(j.id))?'📌 Unpin Route':'📌 Pin Route',action:()=>toggleRoutePin(j.id)});
    actions.push({text:'🚪 Leave Route',danger:true,action:()=>deleteJourney(j)});
  }
  showActionSheet(j.title,j.destination||'Route',actions);
}
function routeTravelerChips(){
  const el=$('routeParticipantChips');if(!el)return;
  el.innerHTML=routeTravelerDraft.map((p,i)=>`<span class="route-person-chip"><span>${esc(p.name)}${p.code?' (#'+esc(p.code)+')':''}</span>${isSelfTraveler(p)?'':`<button type="button" aria-label="Remove ${esc(p.name)}" data-remove-route-person="${i}">×</button>`}</span>`).join('');
}
async function addRouteTraveler(){
  const el=$('routeParticipantInput'),button=$('routeParticipantAdd');if(!el)return;
  const raw=el.value.trim();if(!raw)return;
  const code=parseLedgerId(raw);let person;
  if(code){
    if(mode!=='cloud'||!sb||!user){toast('Sign in to invite someone by Ledger ID');return;}
    if(routeTravelerDraft.some(p=>p.code===code)){toast('Already added');return;}
    button.disabled=true;
    try{
      const result=await sb.rpc('lookup_profiles',{p_codes:[code]});
      if(result.error){toast('Could not look up Ledger ID: '+result.error.message);return;}
      const hit=(result.data||[])[0];if(!hit){toast('Ledger ID not found: #'+code);return;}
      person={name:hit.nick||'Ledger user',code};
    }finally{button.disabled=false;}
  }else{
    if(/^#|^[a-zA-Z]{3}-?\d/.test(raw)){toast('Enter a valid Ledger ID (ABC-123456) or a person’s name');return;}
    if(routeTravelerDraft.some(p=>!p.code&&p.name.toLowerCase()===raw.toLowerCase())){toast('Already added');return;}
    person={name:raw.slice(0,80),code:null};
  }
  routeTravelerDraft.push(person);el.value='';routeTravelerChips();el.focus();
}
function openRouteArchives(){routeArchiveView=true;activeJourneyId=null;renderJourneys();}
function openJourneyForm(j=null){
  location.hash='#journeys';
  if(currentPage!=='journeys')route();
  $('journeyId').value=j?.id||'';
  $('journeyTitle').value=j?.title||'';
  $('journeyDestination').value=j?.destination||'';
  $('journeyStartDate').value=j?.startDate||'';
  $('journeyModalTitle').textContent=j?'Edit Route':'Plan a Route';
  routeEmojiPicker(j?.emoji||'🧭');routeAvailableBills(j?.linkedBillId||'');
  routeTravelerDraft=Array.isArray(j?.travelers)?j.travelers.map(p=>({name:p.name||p.code||'Traveler',code:p.code||null})):(j?.inviteCodes||[]).map(code=>({name:'Ledger user',code}));
  routeTravelerDraft=ensureSelfFirst(routeTravelerDraft);
  // v87: Only the travelers currently shown in the editor are eligible for invites.
  // Older failed invite codes must not be silently re-added after the user removes/fixes them.
  if(j?.shared && user){
    const currentCodes=new Set(routeTravelerDraft.map(p=>parseLedgerId(p.code||'')).filter(Boolean));
    j.inviteCodes=(j.inviteCodes||[]).map(parseLedgerId).filter(code=>code&&currentCodes.has(code));
    const retryKey='ledger.route.pending.'+user.id+'.'+j.id;
    try{
      const pending=JSON.parse(lsGet(retryKey)||'[]').map(parseLedgerId).filter(code=>code&&currentCodes.has(code));
      if(pending.length)lsSet(retryKey,JSON.stringify([...new Set(pending)]));else lsDel(retryKey);
    }catch{lsDel(retryKey);}
  }
  routeTravelerChips();$('routeParticipantInput').value='';
  const removeBtn=$('journeyDeleteFromEditor');
  if(removeBtn){
    removeBtn.hidden=!j;
    if(j)removeBtn.textContent=j.shared&&!journeyOwner(j)?'Leave Route':'Delete Route';
  }
  showJourneyEditor(true);
  $('journeyTitle').focus();
}
function openStopForm(stop=null){
  try{
    const j=journeyById(activeJourneyId);if(!j){toast('Open a Route first');return;}
    closeRouteOverlays();
    $('stopId').value=stop?.id||'';
    $('stopType').value=stop?.type||'place';
    $('stopTitle').value=stop?.title||'';
    $('stopDate').value=stop?.date||j.startDate||today();
    $('stopTime').value=stop?.time||'';
    $('stopEndTime').value=stop?.endTime||'';
    $('stopLocation').value=stop?.location||'';
    $('stopTransport').value=stop?.transport||'';
    $('stopCost').value=stop?.cost??'';
    $('stopNotes').value=stop?.notes||'';
    $('stopPhotoUrl').value='';
    $('stopTravelersWrap').hidden=!j.shared;
    const assigned=Array.isArray(stop?.travelerIds)?stop.travelerIds:[];
    $('stopTravelers').innerHTML=journeyMembers.map(m=>`<label class="route-traveler-choice"><input type="checkbox" value="${esc(m.user_id)}" ${assigned.includes(m.user_id)?'checked':''} ${!journeyOwner(j)?'disabled':''}><span>${esc(m.display_name||'Traveler')}</span></label>`).join('');
    $('stopForm').querySelectorAll('input,textarea,select').forEach(el=>{if(!['stopId','stopPhotoUrl'].includes(el.id))el.disabled=!journeyOwner(j);});
    $('stopSave').hidden=!journeyOwner(j);$('stopDelete').hidden=!journeyOwner(j);
    if($('routeStopTitle'))$('routeStopTitle').textContent=stop?'Edit Stop':'Add a Stop';
    if(!showRouteOverlay('routeStopOverlay','stopEditor')){toast('Could not open Add a Stop');return;}
    setTimeout(()=>$('stopTitle')?.focus(),0);
  }catch(err){
    console.error('openStopForm failed',err);
    toast('Could not open Add a Stop: '+(err?.message||'Unknown error'));
  }
}
// Date-only strings must not be interpreted in the device's time zone.
function routeClockTime(value){
  const m=/^(\d{2}):(\d{2})$/.exec(String(value||''));if(!m)return '';
  let h=Number(m[1]);const min=m[2];const ap=h>=12?'PM':'AM';h=h%12||12;return `${h}:${min} ${ap}`;
}
function routeCardDate(iso){
  const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso||''));
  if(!match)return '';
  const year=Number(match[1]), month=Number(match[2]), day=Number(match[3]);
  const date=new Date(Date.UTC(year,month-1,day));
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return '';
  return `${String(day).padStart(2,'0')} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][month-1]} ${year}`;
}
function routeCostTotal(j){
  const stops=(j.stops||[]).reduce((n,p)=>n+(Number(p.cost)||0),0);
  const tickets=(j.tickets||[]).reduce((n,t)=>{
    const vals=t&&t.travelerPrices&&typeof t.travelerPrices==='object'?Object.values(t.travelerPrices).map(Number).filter(Number.isFinite):[];
    const v=vals.length?vals.reduce((a,b)=>a+b,0):Number(t?.cost);
    return n+(Number.isFinite(v)&&v>0?v:0);
  },0);
  return stops+tickets;
}
function paintRouteSummary(){
  const j=journeyById(activeJourneyId);if(!j)return;
  const avatar=String(j.emoji||'🗺️'),title=String(j.title||'Untitled Route');
  const stops=(j.stops||[]).length;
  if($('journeyHeroTitle'))$('journeyHeroTitle').textContent=title;
  if($('journeyOverviewMain'))$('journeyOverviewMain').dataset.routeEmoji=avatar;
  if($('journeyHeroDate'))$('journeyHeroDate').textContent=routeCardDate(j.startDate)||'Date not set';
  if($('journeyDetailSubtitle'))$('journeyDetailSubtitle').textContent=String(j.destination||'Destination not set');
  if($('journeyTotal'))$('journeyTotal').textContent=money(routeCostTotal(j));
  if($('journeyStopsCount'))$('journeyStopsCount').textContent=`${stops} ${stops===1?'stop':'stops'}`;
  if($('journeyDetailTitle'))$('journeyDetailTitle').textContent=title;
  if($('journeyDetailAvatar'))$('journeyDetailAvatar').textContent=avatar;
}
const ticketMoney=n=>(state.cur||'₱')+(Number(n)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
const ticketIcon=c=>c==='bus'?'🚌':c==='train'?'🚉':'✈️';
const itineraryTab=()=>lsGet('ledger.route.itineraryTab')==='stops'?'stops':'tickets';
// The signed-in user is always the first traveler / participant shown.
const selfTraveler=()=>({name:displayName(),code:(mode==='cloud'&&profile)?profile.code:null});
const isSelfTraveler=p=>{const me=selfTraveler();return !!p&&(me.code?p.code===me.code:(!p.code&&String(p.name||'').toLowerCase()===me.name.toLowerCase()));};
function ensureSelfFirst(list){const me=selfTraveler();return [{name:me.name,code:me.code},...list.filter(p=>!isSelfTraveler(p))];}
function renderJourneys(){
  const list=$('journeyList'),detail=$('journeyDetail');if(!list||!detail)return;
  const journeys=journeysAll();
  if(activeJourneyId&&!journeyById(activeJourneyId))activeJourneyId=null;
  const inDetail=!!activeJourneyId;
  $('routesMainHeader').hidden=inDetail||routeArchiveView;
  $('journeyOverview').hidden=inDetail||routeArchiveView;
  $('routeArchiveView').hidden=!routeArchiveView||inDetail;
  detail.hidden=!inDetail;
  if(!inDetail){
    if(routeArchiveView){
      const archived=journeys.filter(j=>j.archived);
      $('routeArchivedList').innerHTML=archived.length?archived.map(j=>`<div class="bill-card route-archived-card" data-archived-route="${esc(j.id)}"><div class="bill-card-left"><span class="bill-emoji">${esc(j.emoji||'🧭')}</span><div class="bill-card-info"><div class="bill-name-row"><span class="bill-name">${esc(j.title)}</span></div><small class="muted fine">${esc(j.destination||'Archived route')}</small></div></div><button type="button" class="unarchive-btn secondary" data-restore-route="${esc(j.id)}">Restore</button>${journeyOwner(j)?`<button type="button" class="route-archive-delete secondary" data-delete-archived-route="${esc(j.id)}" aria-label="Delete ${esc(j.title)}">Delete</button>`:''}</div>`).join(''):'<div class="empty-card card">No archived routes yet.</div>';
      placeNotificationInHeader();return;
    }
    const pins=new Set(routePinnedIds()),visible=journeys.filter(j=>!j.archived);
    const ordered=[...routeOrdered(visible.filter(j=>pins.has(String(j.id)))),...routeOrdered(visible.filter(j=>!pins.has(String(j.id))))];
    $('routeSortSelect').value=routeSortMode();
    list.innerHTML=ordered.length?ordered.map(j=>{
      const pin=pins.has(String(j.id));
      const displayDate=routeCardDate(j.startDate);
      return `<div class="bill-card journey-tile ${pin?'is-pinned':''}" data-journey-open="${esc(j.id)}" tabindex="0" role="button" aria-label="Open ${esc(j.title)}"><div class="bill-card-left"><span class="bill-emoji journey-tile-icon">${esc(j.emoji||'🧭')}</span><div class="bill-card-info journey-tile-info"><div class="bill-name-row"><span class="bill-name">${esc(j.title)}</span>${j.shared?'<span class="tag shared-tag">Shared</span>':''}</div><div class="route-card-address muted fine" title="${esc([j.destination,displayDate].filter(Boolean).join(' · '))}">${esc([j.destination,displayDate].filter(Boolean).join(' · ')||'No address added')}</div></div></div><button type="button" class="bill-pin-btn ${pin?'on':''}" aria-label="${pin?'Unpin':'Pin'} ${esc(j.title)}" aria-pressed="${pin}" title="${pin?'Unpin':'Pin Route'}">📌</button><button type="button" class="bill-drag-handle" aria-label="Reorder ${esc(j.title)}" title="Drag to reorder"><svg class="bill-grip-icon" viewBox="0 0 20 24" aria-hidden="true" focusable="false" fill="currentColor"><circle cx="6" cy="5" r="1.6"/><circle cx="14" cy="5" r="1.6"/><circle cx="6" cy="12" r="1.6"/><circle cx="14" cy="12" r="1.6"/><circle cx="6" cy="19" r="1.6"/><circle cx="14" cy="19" r="1.6"/></svg></button><span class="bill-chevron" aria-hidden="true">›</span></div>`;
    }).join(''):'<div class="empty-card card">No routes yet. Tap + to plan one.</div>';
    list.querySelectorAll('.journey-tile').forEach(card=>{
      const j=journeyById(card.dataset.journeyOpen);if(!j)return;
      card.querySelector('.bill-pin-btn').onclick=e=>{e.stopPropagation();toggleRoutePin(j.id);};
      attachLongPress(card,e=>{if(!e.target?.closest?.('.bill-pin-btn,.bill-drag-handle'))routeActionMenu(j);});
    });
    initRouteDrag();placeNotificationInHeader();return;
  }
  placeNotificationInHeader();
  const j=journeyById(activeJourneyId), stopTotal=(j.stops||[]).reduce((n,p)=>n+(Number(p.cost)||0),0), ticketTotal=(j.tickets||[]).reduce((n,t)=>{const vals=t&&t.travelerPrices&&typeof t.travelerPrices==='object'?Object.values(t.travelerPrices).map(Number).filter(Number.isFinite):[];const v=vals.length?vals.reduce((a,b)=>a+b,0):Number(t?.cost);return n+(Number.isFinite(v)&&v>=0?v:0);},0), total=stopTotal+ticketTotal;
  paintRouteSummary();
  $('journeyOpenLinkedBillHeader').hidden=!(state.billGroups||[]).some(g=>String(g.id)===String(j.linkedBillId||''));
  const linked=(state.billGroups||[]).find(g=>String(g.id)===String(j.linkedBillId||''));
  const linkedPanel=$('journeyLinkedBill');linkedPanel.hidden=!linked;
  if(linked)linkedPanel.innerHTML=`<span>Linked bill</span><strong>${esc(linked.emoji||'🧾')} ${esc(linked.name)}</strong><button type="button" id="routeOpenLinkedBill">Open bill →</button>`;
  linkedPanel.hidden=true; // Header link is now the only visible bill shortcut.
  $('journeyDetailNotes').textContent=j.notes||'';
  $('journeyDetailNotes').hidden=!j.notes;
  $('journeyEdit').hidden=false;$('journeyDelete').hidden=true;
  $('journeyAddStop').hidden=true; // Added from the floating + menu only.
  renderJourneyExtras();
  const ordered=sortedRouteStops(j);
  const tickets=sortedRouteTickets(j);
  const ticketHtml=tickets.length?tickets.map(t=>{
    const top=[t.place,t.route?`(${t.route})`:''].filter(Boolean).join(' ')||t.name;
    const subtitle=[routeCardDate(t.date),t.time?routeClockTime(t.time):'',ticketMoney(t.cost||0)].filter(Boolean).join(' · ');
    return `<article class="route-ticket-itinerary${t.archived?' is-archived':''}" data-ticket-id="${esc(t.id)}" tabindex="0" role="button" aria-label="Ticket ${esc(top)}"><span class="route-ticket-icon" aria-hidden="true">${ticketIcon(t.category)}</span><div class="route-ticket-main"><strong title="${esc(top)}">${esc(top)}</strong><small title="${esc(subtitle)}">${esc(subtitle||'Schedule not set')}</small></div></article>`;
  }).join(''):`<div class="journey-empty route-subempty">${(lsGet(ticketSortKey())||'date')==='archived'?'No archived tickets.':'No tickets yet. Tap + to add one.'}</div>`;
  const stopHtml=ordered.length?ordered.map((p,i)=>{
    const dateLabel=[p.date,p.time+(p.endTime?`–${p.endTime}`:'')].filter(Boolean).join(' · ');
    const summary=[p.location,p.transport].filter(Boolean).join(' · ');
    const last=i>0&&ordered[i-1].date!==p.date;
    return `${i===0||last?`<div class="journey-day-label">${esc(p.date||'Unscheduled')}</div>`:''}<article class="journey-stop" data-stop-id="${esc(p.id)}"><span class="journey-type-dot ${esc(p.type)}" aria-hidden="true"></span><div class="journey-stop-main"><div class="journey-stop-meta">${esc(JTYPE[p.type]||'Place')} · ${esc(dateLabel||'Time not set')}</div><strong>${esc(p.title)}</strong>${summary?`<small>${esc(summary)}</small>`:''}${p.notes?`<p>${esc(p.notes)}</p>`:''}${Array.isArray(p.travelerIds)&&p.travelerIds.length?`<small>👤 ${esc(p.travelerIds.map(id=>journeyMembers.find(m=>m.user_id===id)?.display_name||'Traveler').join(', '))}</small>`:''}${stopPhotoUrls(p).length?`<div class="route-stop-photos">${stopPhotoUrls(p).map(url=>`<img src="${esc(url)}" alt="${esc(p.title)}" loading="lazy">`).join('')}</div>`:''}</div><div class="journey-stop-right"><strong>${money(p.cost)}</strong><button type="button" class="journey-stop-edit" data-stop-edit="${esc(p.id)}" aria-label="View ${esc(p.title)}">${journeyOwner(j)?'Details':'View'}</button></div></article>`;
  }).join(''):'<div class="journey-empty route-subempty">No stops yet. Tap + to add one.</div>';
  const tab=itineraryTab();
  const sortOpts=tab==='tickets'?[['date','Date'],['name','Name'],['price','Price'],['archived','Archived']]:[['date','Date'],['name','Name'],['price','Price']];
  const savedSort=lsGet(tab==='tickets'?ticketSortKey():stopSortKey())||'date';
  const activeSort=sortOpts.some(o=>o[0]===savedSort)?savedSort:'date';
  if($('journeyItinerarySort'))$('journeyItinerarySort').innerHTML=sortOpts.map(([v,l])=>`<option value="${v}"${v===activeSort?' selected':''}>${l}</option>`).join('');
  const tabCounts={tickets:(j.tickets||[]).filter(t=>!t.archived).length,stops:(j.stops||[]).length};
  $$('#journeyItineraryTabs button').forEach(b=>{b.textContent=`${b.dataset.v==='tickets'?'Tickets':'Stops'} (${tabCounts[b.dataset.v]})`;});
  setSeg('journeyItineraryTabs',tab);
  $('journeyStops').innerHTML=tab==='tickets'?ticketHtml:stopHtml;
  $$('#journeyStops .route-ticket-itinerary').forEach(card=>{const t=routeTicketById(card.dataset.ticketId);if(!t)return;attachLongPress(card,e=>routeTicketActionMenu(t));});
}
const ticketSortKey=()=>`ledger.route.ticketSort.${activeJourneyId||'none'}`;
const stopSortKey=()=>`ledger.route.stopSort.${activeJourneyId||'none'}`;
function sortedRouteTickets(j){
  const mode=lsGet(ticketSortKey())||'date';
  const xs=(j.tickets||[]).filter(t=>mode==='archived'?t.archived:!t.archived).slice();
  if(mode==='name')return xs.sort((a,b)=>a.name.localeCompare(b.name));
  if(mode==='price')return xs.sort((a,b)=>(b.cost||0)-(a.cost||0)||a.name.localeCompare(b.name));
  return xs.sort((a,b)=>(a.date||'9999').localeCompare(b.date||'9999')||(a.time||'99').localeCompare(b.time||'99')||a.name.localeCompare(b.name));
}
function sortedRouteStops(j){
  const mode=lsGet(stopSortKey())||'date';
  const xs=(j.stops||[]).slice();
  if(mode==='name')return xs.sort((a,b)=>a.title.localeCompare(b.title));
  if(mode==='price')return xs.sort((a,b)=>(b.cost||0)-(a.cost||0)||a.title.localeCompare(b.title));
  return xs.sort((a,b)=>(a.date||'9999').localeCompare(b.date||'9999')||(a.time||'99').localeCompare(b.time||'99')||a.title.localeCompare(b.title));
}
function routeTicketById(id){const j=journeyById(activeJourneyId);return j?.tickets?.find(t=>String(t.id)===String(id));}
function ticketFilesFor(t){return (journeyFiles||[]).filter(f=>String(f.stop_id||'')===String(t?.id||''));}
function openRouteTicketDetail(t){
  if(!t)return;closeRouteOverlays();
  const icon=ticketIcon(t.category), files=ticketFilesFor(t);
  const when=[routeCardDate(t.date),t.time?routeClockTime(t.time):''].filter(Boolean).join(' • ');
  const linkRows=Object.entries(t.attachmentLinks||{}).filter(([,url])=>{try{const u=new URL(url);return u.protocol==='https:';}catch{return false;}}).map(([key,url])=>{
    const person=routeTicketTravelers(journeyById(activeJourneyId)).find(p=>p.key===key);
    return `<a class="route-ticket-detail-file" href="${esc(url)}" target="_blank" rel="noopener noreferrer"><span>${esc(person?.label||'Traveler')} · Drive attachment</span><span>Open ↗</span></a>`;
  }).join('');
  const legacyRows=files.map(f=>`<button type="button" class="route-ticket-detail-file" data-route-file-open="${esc(f.id)}"><span>${esc(f.display_name||'Ticket file')}</span><span>Open</span></button>`).join('');
  const fileRows=linkRows+legacyRows||'<p class="fine">No links attached.</p>';
  const priceRows=Object.entries(t.travelerPrices||{}).map(([k,v])=>{const person=routeTicketTravelers(journeyById(activeJourneyId)).find(p=>p.key===k);return `<div class="route-ticket-detail-price"><span>${esc(person?.label||'Traveler')}${person?.isOwner?' (Owner)':''}</span><strong>${money(v||0)}</strong></div>`;}).join('');
  $('routeTicketDetailTitle').textContent='Ticket details';
  $('routeTicketDetailBody').innerHTML=`<div class="route-ticket-detail-hero"><span>${icon}</span><div><strong>${esc(t.place||'')}</strong><small>${esc(t.route||'')}</small></div></div><div class="route-ticket-detail-grid"><div><small>Date & time</small><strong>${esc(when||'Not set')}</strong></div><div><small>Total price</small><strong>${money(t.cost||0)}</strong></div><div><small>Category</small><strong>${t.category==='bus'?'Bus':t.category==='train'?'Train':'Airplane'}</strong></div></div>${priceRows?`<div class="route-ticket-detail-prices"><small>Traveler prices</small>${priceRows}</div>`:''}<div class="route-ticket-detail-files"><small>Ticket attachments</small>${fileRows}</div>`;
  $('routeTicketDetailEdit').hidden=!journeyOwner(journeyById(activeJourneyId));
  $('routeTicketDetailEdit').dataset.ticketEdit=t.id;
  showRouteOverlay('routeTicketDetailOverlay');
}
async function archiveRouteTicket(t,archived=true){
  const j=journeyById(activeJourneyId);if(!j||!t||!journeyOwner(j))return;
  const old=!!t.archived;t.archived=archived;
  if(!await persistJourney(j)){t.archived=old;return;}
  renderJourneys();toast(archived?'Ticket archived':'Ticket restored');
}
async function deleteRouteTicket(t){
  const j=journeyById(activeJourneyId);if(!j||!t||!journeyOwner(j))return;
  if(!confirm(`Delete ${t.name||'this ticket'}?`))return;
  const files=ticketFilesFor(t),paths=files.map(f=>f.storage_path).filter(Boolean);
  if(j.shared&&sb&&files.length){
    const ids=files.map(f=>f.id).filter(Boolean);if(ids.length)await sb.from('ledger_route_files').delete().in('id',ids);
    if(paths.length)await sb.storage.from(ROUTE_BUCKET).remove(paths);
    journeyFiles=(journeyFiles||[]).filter(f=>!files.some(x=>x.id===f.id));
  }
  j.tickets=(j.tickets||[]).filter(x=>x.id!==t.id);
  if(!await persistJourney(j))return;
  renderJourneys();toast('Ticket deleted');
}
function routeTicketActionMenu(t){
  if(!t)return;
  const archived=!!t.archived;
  showActionSheet(t.name||'Ticket',[t.place,t.route].filter(Boolean).join(' · '),[
    {text:archived?'📁 Unarchive ticket':'📁 Archive ticket',action:()=>archiveRouteTicket(t,!archived)},
    {text:'✏️ Edit ticket details',action:()=>openRouteTicketForm(t)},
    {text:'🗑️ Delete ticket',danger:true,action:()=>deleteRouteTicket(t)}
  ]);
}
function openLinkedBillFromRoute(){
  const j=journeyById(activeJourneyId);
  const billId=j?.linkedBillId;
  if(!billId)return;
  const exists=(state.billGroups||[]).some(g=>String(g.id)===String(billId));
  if(!exists){toast('The linked Bill is no longer available');return;}
  if(currentPage==='split'){openBillDetail(billId);return;}
  const onHash=()=>{window.removeEventListener('hashchange',onHash);requestAnimationFrame(()=>openBillDetail(billId));};
  window.addEventListener('hashchange',onHash);
  location.hash='#split';
}
function initJourneys(){
  // Fixed dialogs must not be descendants of the animated/scrolled app root on iOS Safari.
  ['routeEditorOverlay','routeStopOverlay','routeCollabOverlay','routeOptionsOverlay','routeTicketOverlay','routeTicketDetailOverlay'].forEach(id => {
    const dialog = $(id); if (dialog && dialog.parentElement !== document.body) document.body.appendChild(dialog);
  });
  // Reuse the already-working secure attachment uploader, never create a second storage path.
  const ticketHost=$('routeTicketFormHost'), existingUpload=$('journeyDocFile')?.closest('.route-upload');
  if(ticketHost&&existingUpload)ticketHost.appendChild(existingUpload);
  $('routeTicketCancel')?.addEventListener('click',closeRouteOverlays);

  $('routeTicketCategory')?.addEventListener('change',updateRouteTicketLabels);
  // The category select sits transparently over the emoji tile. Its native
  // iOS/Android picker stays interactive inside the modal scroll container.
  $('routeTicketTravelerFiles')?.addEventListener('input',e=>{if(e.target.matches('[data-ticket-price]'))routeTicketTotalFromInputs();});
  
  $('routeTicketOverlay')?.addEventListener('click',e=>{if(e.target.id==='routeTicketOverlay')closeRouteOverlays();});
  $('routeTicketDetailOverlay')?.addEventListener('click',e=>{if(e.target.id==='routeTicketDetailOverlay')closeRouteOverlays();});
  $('routeTicketDetailClose')?.addEventListener('click',closeRouteOverlays);
  $('routeTicketDetailEdit')?.addEventListener('click',()=>{const t=routeTicketById($('routeTicketDetailEdit').dataset.ticketEdit);if(t)openRouteTicketForm(t);});
  $('routeStopOverlay')?.addEventListener('click',e=>{if(e.target.id==='routeStopOverlay')closeRouteOverlays();});
  $('journeyCancel')?.addEventListener('click',closeRouteOverlays);
  $('journeyDeleteFromEditor')?.addEventListener('click',async()=>{
    const j=journeyById($('journeyId').value||activeJourneyId);if(!j)return;
    if(await deleteJourney(j))closeRouteOverlays();
  });
  $('routeParticipantAdd')?.addEventListener('click',addRouteTraveler);
  $('routeParticipantInput')?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();addRouteTraveler();}});
  $('routeParticipantChips')?.addEventListener('click',e=>{const b=e.target.closest('[data-remove-route-person]');if(!b)return;routeTravelerDraft.splice(Number(b.dataset.removeRoutePerson),1);routeTravelerChips();});
  $('routeArchiveOpen')?.addEventListener('click',openRouteArchives);
  $('routeArchiveBack')?.addEventListener('click',()=>{routeArchiveView=false;renderJourneys();});
  $('routeSortSelect')?.addEventListener('change',e=>{lsSet(routePrefsKey('sort'),e.target.value);renderJourneys();});
  $('routeArchivedList')?.addEventListener('click',async e=>{const restore=e.target.closest('[data-restore-route]'),del=e.target.closest('[data-delete-archived-route]'),row=e.target.closest('[data-archived-route]');if(!row)return;const j=journeyById(row.dataset.archivedRoute);if(!j)return;if(restore){await setRouteArchived(j,false);return;}if(del){await deleteJourney(j);return;}routeArchiveView=false;activeJourneyId=j.id;renderJourneys();await loadJourneyExtras(j);renderJourneys();});
  $('routeEditorOverlay')?.addEventListener('click',e=>{if(e.target.id==='routeEditorOverlay')closeRouteOverlays();});
  $('routeOptionsOverlay')?.addEventListener('click',e=>{if(e.target.id==='routeOptionsOverlay')closeRouteOverlays();});
  $('routeOptionClose')?.addEventListener('click',closeRouteOverlays);
  $('routeOptionEdit')?.addEventListener('click',()=>openJourneyForm(journeyById(activeJourneyId)));
  $('routeOptionRefresh')?.addEventListener('click',()=>{$('routeOptionsOverlay').hidden=true;$('journeyRefresh').click();});
  $('routeOptionDelete')?.addEventListener('click',()=>{$('routeOptionsOverlay').hidden=true;$('journeyDelete').click();});
  $('routeOptionShare')?.addEventListener('click',()=>{$('routeOptionsOverlay').hidden=true;$('routeCollabOverlay').hidden=false;});
  $('journeyManageTravelers')?.addEventListener('click',()=>{$('routeCollabOverlay').hidden=false;});
  $('routeCollabClose')?.addEventListener('click',closeRouteOverlays);
  $('routeCollabOverlay')?.addEventListener('click',e=>{if(e.target.id==='routeCollabOverlay')closeRouteOverlays();});
  // A new Route uses the SAME verified Ledger-ID invitation RPC as Travelers & Files.
  // Do not close the sheet before the route and its members have been saved.
  let routeSaveInProgress=false;
  $('journeyForm')?.addEventListener('submit',async e=>{
    e.preventDefault();
    if(routeSaveInProgress)return;
    const title=$('journeyTitle').value.trim();if(!title)return;
    // Mobile users often type a final Ledger ID and press Save without tapping Add.
    // Resolve that input first; never silently omit it from the shared Route.
    const pending=$('routeParticipantInput')?.value.trim();
    if(pending){
      await addRouteTraveler();
      if($('routeParticipantInput').value.trim())return; // lookup failed: keep sheet open
    }
    const saveButton=$('journeyForm').querySelector('button[type="submit"]');
    routeSaveInProgress=true;if(saveButton){saveButton.disabled=true;saveButton.textContent='Saving…';}
    try{
      const old=journeyById($('journeyId').value);
      const newCodes=[...new Set(routeTravelerDraft.map(p=>parseLedgerId(p.code||'')).filter(code=>code&&code!==profile?.code))];
      // v87: Invite only Ledger IDs that are still present in this editor. Never carry
      // stale failed IDs from a previous save after the user removes or corrects them.
      const confirmed=new Set((old?.shared?journeyMembers:[]).map(m=>parseLedgerId(m.ledger_code||'')).filter(Boolean));
      const toInvite=newCodes.filter(code=>!confirmed.has(code));
      const j={id:old?.id||uid(),title,destination:$('journeyDestination').value.trim(),startDate:$('journeyStartDate').value,notes:old?.notes||'',emoji:$('journeyEmoji').value||'🧭',linkedBillId:$('journeyLinkedBillSelect').value,
        travelers:routeTravelerDraft.map(p=>({...p})),inviteCodes:toInvite,archived:!!old?.archived,createdAt:old?.createdAt||new Date().toISOString(),stops:old?.stops||[],tickets:old?.tickets||[],...(old?.shared?{shared:true,ownerId:old.ownerId}:{})};
      if(user){
        const retryKey='ledger.route.pending.'+user.id+'.'+j.id;
        if(toInvite.length)lsSet(retryKey,JSON.stringify(toInvite));else lsDel(retryKey);
      }
      if(old)Object.assign(old,j);else state.journeys.push(j);
      // Keep this ID in the sheet so retrying cannot accidentally create a duplicate.
      $('journeyId').value=j.id;
      activeJourneyId=j.id;
      if(j.shared){
        if(!await persistJourney(j))return;
        if(j.inviteCodes?.length && !await sendRouteInvitations(j)){
          closeRouteOverlays();renderJourneys();toast('Route saved, but a traveler invitation failed. Check the message above and retry.');
          return;
        }
        if(j.linkedBillId)await syncRouteTravelersToLinkedBill(j);
      } else {
        save();
        // Creating a Route with travelers automatically shares it with Ledger-ID accounts.
        // Name-only travelers are saved as participants, not granted cloud access.
        if(mode==='cloud'&&sb&&user&&(j.travelers.length||j.linkedBillId)){
          if(!await shareJourney(j)){
            closeRouteOverlays();renderJourneys();toast('Route saved, but sharing is incomplete.');
            return;
          }
        }else if(newCodes.length){
          toast('Route saved locally. Sign in to invite Ledger users.');
        }
      }
      closeRouteOverlays();renderJourneys();toast('Route saved');
    }finally{
      routeSaveInProgress=false;
      if(saveButton){saveButton.disabled=false;saveButton.textContent='Save Route';}
    }
  });
  $('journeyList')?.addEventListener('click',async e=>{const b=e.target.closest('[data-journey-open]');if(!b||e.target.closest('.bill-pin-btn,.bill-drag-handle'))return;if(b._lpFired){b._lpFired=false;return;}routeArchiveView=false;activeJourneyId=b.dataset.journeyOpen;renderJourneys();const openedRoute=journeyById(activeJourneyId);await loadJourneyExtras(openedRoute);if(openedRoute?.shared&&openedRoute.linkedBillId&&journeyOwner(openedRoute))await syncRouteTravelersToLinkedBill(openedRoute,{quiet:true});renderJourneys();});
  $('journeyList')?.addEventListener('keydown',e=>{if(e.target.closest('.bill-pin-btn,.bill-drag-handle')||!['Enter',' '].includes(e.key))return;const b=e.target.closest('[data-journey-open]');if(!b)return;e.preventDefault();b.click();});
  $('journeyBack')?.addEventListener('click',()=>{activeJourneyId=null;$('stopEditor').hidden=true;renderJourneys();});
  $('journeyOpenLinkedBillHeader')?.addEventListener('click',openLinkedBillFromRoute);
  $('journeyEdit')?.addEventListener('click',()=>openJourneyForm(journeyById(activeJourneyId)));
  $('journeyLinkedBill')?.addEventListener('click',e=>{if(e.target.closest('#routeOpenLinkedBill'))openLinkedBillFromRoute();});
  $('journeyDelete')?.addEventListener('click',()=>deleteJourney(journeyById(activeJourneyId)));
  $('journeyAddStop')?.addEventListener('click',()=>openStopForm());
  $('stopCancel')?.addEventListener('click',closeRouteOverlays);
  $('stopForm')?.addEventListener('submit',async e=>{
    e.preventDefault();const j=journeyById(activeJourneyId);if(!j)return;
    const title=$('stopTitle').value.trim();if(!title)return;
    const cost=Number($('stopCost').value||0);if(!Number.isFinite(cost)||cost<0){toast('Enter a valid estimated cost');return;}
    const p={id:$('stopId').value||uid(),title,type:$('stopType').value,date:$('stopDate').value,time:$('stopTime').value,endTime:$('stopEndTime').value,location:$('stopLocation').value.trim(),transport:$('stopTransport').value.trim(),cost:Math.round(cost*100)/100,notes:$('stopNotes').value.trim(),travelerIds:Array.from($('stopTravelers').querySelectorAll('input:checked')).map(el=>el.value).filter(id=>journeyMembers.some(m=>m.user_id===id))};
    if(p.time&&p.endTime&&p.endTime<p.time){toast('End time cannot be earlier than start time');return;}
    if(!journeyOwner(j))return;
    const old=j.stops.find(x=>x.id===p.id);p.photoUrls=old?.photoUrls||[];
    const url=imageHttpUrl($('stopPhotoUrl').value.trim());
    if($('stopPhotoUrl').value.trim()&&!url){toast('Use a direct HTTPS image URL');return;}
    if(url&&!p.photoUrls.includes(url))p.photoUrls.push(url);
    if(old)Object.assign(old,p);else j.stops.push(p);
    if(!await persistJourney(j))return;
    closeRouteOverlays();renderJourneys();toast('Stop saved');
  });
  $('journeyStops')?.addEventListener('click',e=>{
    const ticket=e.target.closest('[data-ticket-id]');if(ticket){if(ticket._lpFired){ticket._lpFired=false;return;}const t=routeTicketById(ticket.dataset.ticketId);if(t)openRouteTicketDetail(t);return;}
    const b=e.target.closest('[data-stop-id]');if(!b)return;const j=journeyById(activeJourneyId);const p=j?.stops.find(x=>x.id===b.dataset.stopId);if(p)openStopForm(p);
  });
  $('journeyItinerarySort')?.addEventListener('change',e=>{lsSet(itineraryTab()==='tickets'?ticketSortKey():stopSortKey(),e.target.value);renderJourneys();});
  $('journeyItineraryTabs')?.addEventListener('click',e=>{const b=e.target.closest('button[data-v]');if(!b)return;lsSet('ledger.route.itineraryTab',b.dataset.v);renderJourneys();});
  $('journeyStops')?.addEventListener('keydown',e=>{if(!['Enter',' '].includes(e.key))return;const c=e.target.closest('[data-ticket-id]');if(!c)return;e.preventDefault();const t=routeTicketById(c.dataset.ticketId);if(t)openRouteTicketDetail(t);});
  $('stopDelete')?.addEventListener('click',async()=>{const j=journeyById(activeJourneyId),id=$('stopId').value;if(!j||!id)return;if(!confirm('Delete this stop?'))return;j.stops=j.stops.filter(p=>p.id!==id);await persistJourney(j);closeRouteOverlays();renderJourneys();toast('Stop deleted');});
  $('journeyShareBtn')?.addEventListener('click',()=>{const j=journeyById(activeJourneyId);if(j)shareJourney(j);});
  $('journeyInviteForm')?.addEventListener('submit',async e=>{
    e.preventDefault();const j=journeyById(activeJourneyId),code=parseLedgerId($('journeyInviteId').value);
    if(!j?.shared||!journeyOwner(j))return;
    if(!code){toast('Enter a valid Ledger ID, e.g. ABC-123456');return;}
    const {error}=await sb.rpc('ledger_route_invite',{p_route_id:j.id,p_ledger_code:code});
    if(error){toast('Could not add traveler: '+error.message);return;}
    $('journeyInviteId').value='';
    await loadJourneyExtras(j);
    if(!journeyMembers.some(m=>String(m.ledger_code||'').toUpperCase()===code)){
      toast('Invitation submitted, but membership is not visible yet. Refresh Routes.');
    }else{
      toast('Traveler added. The Route should now appear in their Routes page.');
      await syncRouteTravelersToLinkedBill(j);
    }
  });
  $('journeyMemberList')?.addEventListener('click',async e=>{
    const b=e.target.closest('[data-route-remove-member]');if(!b)return;
    const j=journeyById(activeJourneyId);if(!j?.shared||!journeyOwner(j))return;
    if(!confirm('Remove this traveler? They will lose access to this route and their private files.'))return;
    const {error}=await sb.from('ledger_route_members').delete().eq('route_id',j.id).eq('user_id',b.dataset.routeRemoveMember);
    if(error){toast(error.message);return;}await loadJourneyExtras(j);
    if(j.linkedBillId)toast('Traveler removed from Route. Review the linked Bill separately: past expenses and Bill membership were not deleted.');
  });
  $('journeyUploadBtn')?.addEventListener('click',uploadJourneyFile);
  $('journeyLinkForm')?.addEventListener('submit',async e=>{
    e.preventDefault();const j=journeyById(activeJourneyId),url=imageHttpUrl($('journeyLinkUrl').value.trim());
    if(!j?.shared||!journeyOwner(j))return;
    if(!url){toast('Use an HTTPS link');return;}
    j.links ||= [];
    j.links.push({id:uid(),title:$('journeyLinkTitle').value.trim().slice(0,100)||'Shared link',url});
    if(!await persistJourney(j)){j.links.pop();return;}
    $('journeyLinkForm').reset();renderJourneyExtras();toast('Link added');
  });
  document.addEventListener('click',async e=>{
    const open=e.target.closest('[data-route-file-open]');if(open){await signedFileOpen(open.dataset.routeFileOpen);return;}
    const rm=e.target.closest('[data-route-file-remove]');if(rm){
      const f=journeyFiles.find(x=>x.id===rm.dataset.routeFileRemove);if(!f||!confirm('Remove this attachment?'))return;
      const rmObj=await sb.storage.from(ROUTE_BUCKET).remove([f.storage_path]);
      if(rmObj.error){toast('Could not remove file: '+rmObj.error.message);return;}
      const d=await sb.from('ledger_route_files').delete().eq('id',f.id);
      if(d.error){toast(d.error.message);return;}
      await loadJourneyExtras(journeyById(activeJourneyId));return;
    }
    const link=e.target.closest('[data-route-link-remove]');if(link){
      const j=journeyById(activeJourneyId);if(!j?.shared||!journeyOwner(j))return;
      j.links=(j.links||[]).filter(x=>x.id!==link.dataset.routeLinkRemove);
      if(await persistJourney(j))renderJourneyExtras();return;
    }
    const photo=e.target.closest('[data-route-photo-remove]');if(photo){
      const j=journeyById(activeJourneyId),stop=j?.stops.find(x=>x.id===$('stopId').value);
      if(!stop||!journeyOwner(j))return;
      stop.photoUrls=stopPhotoUrls(stop).filter((_,i)=>i!==Number(photo.dataset.routePhotoRemove));
      await persistJourney(j);renderJourneyExtras();renderJourneys();
    }
  });
  $('journeyRefresh')?.addEventListener('click',async()=>{await loadSharedJourneys();const j=journeyById(activeJourneyId);if(j){await loadJourneyExtras(j);if(j.shared&&j.linkedBillId&&journeyOwner(j))await syncRouteTravelersToLinkedBill(j,{quiet:true});}renderJourneys();toast('Routes refreshed');});

}

async function boot() {
  initGlobalActions();
  initNotifications();
  initJourneys();
  try {
    registerServiceWorker();
    applyTheme(getTheme());
    applyFontScale(getFontScale());
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


/* Receipt scanner: client-side optical character recognition (OCR), suggestions only.
   This intentionally does NOT upload receipt images or silently save recognized fields. */
let receiptOcrLibraryPromise = null;
function loadReceiptOcr() {
  if (window.Tesseract && window.Tesseract.recognize) return Promise.resolve(window.Tesseract);
  if (receiptOcrLibraryPromise) return receiptOcrLibraryPromise;
  receiptOcrLibraryPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
    script.crossOrigin = 'anonymous';
    script.onload = () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error('OCR unavailable'));
    script.onerror = () => reject(new Error('Could not load the receipt scanner. Check internet connection.'));
    document.head.appendChild(script);
  }).catch(err => { receiptOcrLibraryPromise = null; throw err; });
  return receiptOcrLibraryPromise;
}
function receiptCandidates(text) {
  const lines = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const matches = [];
  const priceRx = /(?:₱|PHP\s*|P\s*)?([0-9]{1,3}(?:[, ][0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})\b/ig;
  lines.forEach((line, i) => {
    const words = line.toLowerCase();
    if (/change|cash given|tendered|cash received|card no|reference|balance due after/i.test(words)) return;
    const totals = [...line.matchAll(priceRx)].map(m=>Number(m[1].replace(/[, ]/g,''))).filter(n=>Number.isFinite(n)&&n>0&&n<10000000);
    if (!totals.length) return;
    let rank = 0;
    if (/grand\s*total|amount\s*due|total\s*amount|total\s*due|net\s*total/i.test(line)) rank += 9;
    else if (/\btotal\b/i.test(line)) rank += 7;
    if (/subtotal|sub total/i.test(line)) rank -= 7;
    if (/tax|vat|discount|service charge|svc|tip/i.test(line)) rank -= 5;
    totals.forEach(n => matches.push({amount:n,rank,index:i}));
  });
  matches.sort((a,b)=>b.rank-a.rank||b.index-a.index);
  const chosen = matches[0] || null;
  const dateMatch = text.match(/\b(20\d{2})[-/.](0?[1-9]|1[0-2])[-/.]([0-2]?\d|3[01])\b/) || text.match(/\b(0?[1-9]|[12]\d|3[01])[-/.](0?[1-9]|1[0-2])[-/.](20\d{2})\b/);
  let date = '';
  if (dateMatch) {
    const y=dateMatch[1].length===4?dateMatch[1]:dateMatch[3];
    const m=dateMatch[2].padStart(2,'0');
    const d=(dateMatch[1].length===4?dateMatch[3]:dateMatch[1]).padStart(2,'0');
    const candidate=`${y}-${m}-${d}`;
    if (!Number.isNaN(new Date(candidate+'T12:00:00').getTime())) date=candidate;
  }
  const merchant=lines.find(line => /[a-zA-Z]{3}/.test(line) && !/receipt|invoice|official|sales|date|time|terminal|cashier|order no|transaction|tin:|vat|welcome/i.test(line)) || '';
  return {amount:chosen?chosen.amount:null,confidentTotal:!!chosen&&chosen.rank>=7,date,merchant:merchant.slice(0,60),lineCount:lines.length};
}
function initReceiptScanner() {
  document.querySelectorAll('[data-receipt-target]').forEach(section => {
    const target=section.dataset.receiptTarget;
    const result=section.querySelector('.receipt-scan-result');
    section.querySelectorAll('input[type="file"]').forEach(input => input.addEventListener('change', async () => {
      const file=input.files && input.files[0];
      if (!file) return;
      result.hidden = true; result.classList.remove('warn'); result.textContent = '';
      // Check type and size before decoding to protect low-memory phones.
      if (!file.type.startsWith('image/') || file.size > 12*1024*1024) {
        result.classList.add('warn');result.textContent='Choose a JPG, PNG or other image under 12 MB.';input.value='';return;
      }
      section.querySelectorAll('input[type="file"]').forEach(el=>{el.disabled=true;});
      try {
        const api=await loadReceiptOcr();
        const output=await api.recognize(file,'eng');
        const text=output?.data?.text || '';
        const confidence=Number(output?.data?.confidence)||0;
        const info=receiptCandidates(text);
        // Fill only blanks. For prefilled fields, let the user compare against the receipt.
        const fields=target==='split' ? {amount:'splitExpAmount',name:'splitExpTitle',date:'splitExpDate'} : target==='edit' ? {amount:'editAmount',name:'editNote',date:'editDate'} : {amount:'amount',name:'note',date:'date'};
        const applied=[];
        const totalField=$(fields.amount);
        if (info.amount != null && totalField && !totalField.readOnly && (!totalField.value || Number(totalField.value)===0)) {
          totalField.value=info.amount.toFixed(2);totalField.dispatchEvent(new Event('input',{bubbles:true}));applied.push('total');
        }
        if (info.merchant && $(fields.name) && !$(fields.name).value.trim()) {$(fields.name).value=info.merchant;applied.push('merchant');}
        // Default dates usually prefilled with today; suggest receipt date without overwriting.
        // No verbose OCR report; show a short verification note only when uncertain.
        result.hidden = confidence < 70 || !info.confidentTotal;
        result.classList.toggle('warn', !result.hidden);
        result.textContent = result.hidden ? '' : 'Please verify the scanned details.';
      } catch(err) {
        result.hidden=false; result.classList.add('warn'); result.textContent='Could not read receipt. Enter details manually.';
      } finally {
        section.querySelectorAll('input[type="file"]').forEach(el=>{el.disabled=false;el.value='';});
      }
    }));
  });
}
initReceiptScanner();

boot();
})();
