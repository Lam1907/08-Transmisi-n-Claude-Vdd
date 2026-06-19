// ═══════════════════════════════════════════════════════
//   DANZAD MALDITOS — BROADCAST v5
//   Firebase 10.12.2 · Clean rewrite · No legacy code
// ═══════════════════════════════════════════════════════

import { initializeApp }             from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getDatabase, ref, onValue } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const FB_CONFIG = {
  apiKey:            "AIzaSyCxd2sdNJZaQ0Rq_mF6Sn1wLQra4Eabp1U",
  authDomain:        "danzad-maldit0s.firebaseapp.com",
  databaseURL:       "https://danzad-maldit0s-default-rtdb.firebaseio.com",
  projectId:         "danzad-maldit0s",
  storageBucket:     "danzad-maldit0s.firebasestorage.app",
  messagingSenderId: "774607843671",
  appId:             "1:774607843671:web:ec64876ba81b6b50acce12"
};

const db = getDatabase(initializeApp(FB_CONFIG));
const $  = id => document.getElementById(id);

// ── Rutas Firebase (sync con panel_de_control.js) ────
// /state → votingOpen, votingEnded, timerEnd, totalVotes, votingDuration
// /participants → { participant_N: { name, image, number } }
// /results/pairs → { pair_N: { participants:[n,n], eliminated, votes } }
// /results/winner → "pair_X"

// ── Estados ──────────────────────────────────────────
const S = { WAITING:'waiting', VOTING:'voting', CONSOLIDATION:'consolidation', PAIRS:'pairs', WINNER:'winner' };

// ── App state ─────────────────────────────────────────
let state        = null;
let participants = {};
let pairs        = {};
let winner       = null;
let votingOpen   = false;
let votingEnded  = false;
let timerEnd     = 0;
let timerDur     = 300;  // duración total del timer (seg)
let timerRef     = 0;    // timerEnd capturado al abrir votación
let prevPairs    = {};   // snapshot anterior para detectar eliminaciones

// ── DOM ───────────────────────────────────────────────
const screens = {
  waiting:       $('screen-waiting'),
  voting:        $('screen-voting'),
  consolidation: $('screen-consolidation'),
  pairs:         $('screen-pairs'),
  winner:        $('screen-winner')
};

// Ring SVG — circunferencia = 2π × 68 = 427.26
const RING_CIRCUM = 427.26;
const ringEl      = $('ring-progress');
const timerNumEl  = $('timer-number');
const voteCountEl = $('vote-count');
const waitPiecesEl= $('waiting-pieces');
const cfWrapEl    = $('coverflow-wrap');
const cfTrackEl   = $('coverflow-track');
const pairsGridEl = $('pairs-grid');
const pairRevEl   = $('pair-reveal');
const consTitleEl = $('cons-title');
const overlayElim = $('overlay-elim');
const winContent  = $('winner-content');
const winCanvas   = $('winner-canvas');
const connDot     = $('conn-dot');
const connLabel   = $('conn-label');

// ── Timers / loops ─────────────────────────────────────
let timerInterval = null;
let cfRaf         = null;
let cfAngle       = 0;
let cfLastT       = null;
let cfCards       = [];
let cfDegPerSec   = 360 / 50;  // se recalcula en buildCoverFlow
let revealRunning = false;
let elimQueue     = [];
let elimBusy      = false;
let winRaf        = null;
let winParticles  = [];

// ══════════════════════════════════════════════════════
//   STATE MANAGER
// ══════════════════════════════════════════════════════

function goTo(next) {
  if (state === next) return;
  console.log(`[Broadcast] ${state || 'boot'} → ${next}`);
  if (state === S.VOTING) stopCoverFlow();
  if (state === S.WINNER) stopWinnerCanvas();
  Object.values(screens).forEach(s => s && s.classList.remove('active'));
  state = next;
  if (screens[next]) screens[next].classList.add('active');
  switch (next) {
    case S.WAITING:       initWaiting();       break;
    case S.VOTING:        initVoting();        break;
    case S.CONSOLIDATION: initConsolidation(); break;
    case S.PAIRS:         initPairs();         break;
    case S.WINNER:        initWinner();        break;
  }
}

function evaluate() {
  if (winner)                      { goTo(S.WINNER); return; }
  if (votingOpen && !votingEnded)  { goTo(S.VOTING); return; }
  if (votingEnded && !votingOpen)  {
    if (state !== S.CONSOLIDATION && state !== S.PAIRS) goTo(S.CONSOLIDATION);
    return;
  }
  goTo(S.WAITING);
}

// ══════════════════════════════════════════════════════
//   FIREBASE
// ══════════════════════════════════════════════════════

function listenAll() {
  // /state
  onValue(ref(db, 'state'), snap => {
    const s = snap.val() || {};
    console.log('[FB] /state', JSON.stringify(s));
    votingOpen  = !!s.votingOpen;
    votingEnded = !!s.votingEnded;
    timerEnd    = s.timerEnd || 0;

    if (votingOpen && timerEnd) {
      if (timerRef !== timerEnd) {
        timerDur = s.votingDuration
          ? parseInt(s.votingDuration, 10)
          : Math.max(10, Math.round((timerEnd - Date.now()) / 1000));
        timerRef = timerEnd;
      }
      startTimer();
    } else {
      timerRef = 0;
      stopTimer();
      resetRing();
    }

    evaluate();
  });

  // /participants
  onValue(ref(db, 'participants'), snap => {
    participants = snap.val() || {};
    console.log('[FB] /participants', Object.keys(participants).length);
    if (state === S.WAITING) renderWaitingPieces();
    if (state === S.VOTING)  { stopCoverFlow(); buildCoverFlow(); }
    if (state === S.PAIRS)   renderPairsGrid();
  });

  // /results/pairs
  onValue(ref(db, 'results/pairs'), snap => {
    const next = snap.val() || {};
    console.log('[FB] /results/pairs', Object.keys(next).length);
    detectElim(prevPairs, next);
    prevPairs = JSON.parse(JSON.stringify(next));
    pairs = next;
    if (state === S.PAIRS) renderPairsGrid();
  });

  // /results/winner
  onValue(ref(db, 'results/winner'), snap => {
    const val = snap.val();
    console.log('[FB] /results/winner', val);
    if (val && val !== winner) { winner = val; evaluate(); }
    else if (!val) winner = null;
  });

  // votos
  onValue(ref(db, 'state/totalVotes'), snap => {
    if (voteCountEl) voteCountEl.textContent = snap.val() || 0;
  });

  // conexión
  onValue(ref(db, '.info/connected'), snap => {
    const ok = !!snap.val();
    console.log('[FB] connected:', ok);
    if (connDot)   connDot.className    = 'conn-dot ' + (ok ? 'live' : 'error');
    if (connLabel) connLabel.textContent = ok ? 'EN VIVO' : 'RECONECTANDO';
  });
}

// ══════════════════════════════════════════════════════
//   HELPERS
// ══════════════════════════════════════════════════════

const FB_IMG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'/%3E";

function imgTag(p, cls = '') {
  const src = p?.image || FB_IMG;
  return `<img src="${src}" alt="${p?.name || ''}"${cls ? ` class="${cls}"` : ''} onerror="this.src='${FB_IMG}'">`;
}

function sorted() {
  return Object.values(participants)
    .sort((a, b) => (parseInt(a.number,10)||0) - (parseInt(b.number,10)||0));
}

function byNum(n) {
  if (n == null) return null;
  return Object.values(participants).find(p => parseInt(p.number,10) === parseInt(n,10)) || null;
}

function pairNum(key) { return parseInt(key.replace('pair_',''),10); }

function sortedPairs() {
  return Object.entries(pairs)
    .filter(([,p]) => p)
    .sort(([a],[b]) => pairNum(a) - pairNum(b));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ══════════════════════════════════════════════════════
//   TIMER
// ══════════════════════════════════════════════════════

function startTimer() {
  stopTimer();
  tickTimer();
  timerInterval = setInterval(tickTimer, 500);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function resetRing() {
  if (timerNumEl) timerNumEl.textContent = '00:00';
  if (ringEl) ringEl.setAttribute('stroke-dashoffset', '0');
  if (timerNumEl) timerNumEl.classList.remove('urgent');
}

function tickTimer() {
  if (!timerEnd) return;
  const rem  = Math.max(0, Math.round((timerEnd - Date.now()) / 1000));
  const mins = Math.floor(rem / 60);
  const secs = rem % 60;

  if (timerNumEl) {
    timerNumEl.textContent = `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
    timerNumEl.classList.toggle('urgent', rem <= 10);
  }

  // Ring: ratio 1→0 a medida que el tiempo avanza
  if (ringEl) {
    const ratio  = timerDur > 0 ? Math.min(1, rem / timerDur) : 0;
    const offset = RING_CIRCUM * (1 - ratio);
    ringEl.setAttribute('stroke-dashoffset', offset.toFixed(2));
  }
}

// ══════════════════════════════════════════════════════
//   SCREEN: WAITING
// ══════════════════════════════════════════════════════

function initWaiting() { renderWaitingPieces(); }

function renderWaitingPieces() {
  if (!waitPiecesEl) return;
  waitPiecesEl.innerHTML = '';
  const list = sorted();
  if (!list.length) return;

  const W = window.innerWidth, H = window.innerHeight;
  const pw = Math.max(62, Math.min(115, W * 0.082));
  const zones = calcZones(W, H, list.length, pw, pw * 1.5);
  const durs  = [7,8.5,9,7.5,8,9.5,7.8,8.2,9.2,7.3];
  const dlys  = [0,.7,1.4,2,.45,1.1,1.8,.3,1,1.6];

  list.forEach((p, i) => {
    const z  = zones[i] || { x: Math.random()*(W-pw), y: Math.random()*(H-pw*1.5) };
    const el = document.createElement('div');
    el.className = 'w-piece';
    el.style.cssText = `left:${z.x}px;top:${z.y}px;width:${pw}px;
      --dur:${durs[i%durs.length]}s;--dly:${dlys[i%dlys.length]}s;
      --rot:${(Math.random()*6-3).toFixed(1)}deg;`;
    el.innerHTML = imgTag(p) + `<div class="w-piece-name">${p.name||'—'}</div>`;
    waitPiecesEl.appendChild(el);
  });
}

function calcZones(W, H, n, pw, ph) {
  const cx = W/2, cy = H/2, ex = W*.22, ey = H*.22;
  const pos = [];
  let tries = 0;
  while (pos.length < n && tries < 700) {
    tries++;
    const x = Math.random()*(W-pw);
    const y = Math.random()*(H-ph);
    if (Math.abs(x+pw/2-cx)<ex && Math.abs(y+ph/2-cy)<ey) continue;
    if (pos.some(p => Math.abs(p.x-x)<pw*.82 && Math.abs(p.y-y)<ph*.82)) continue;
    pos.push({x,y});
  }
  while (pos.length < n) pos.push({x:Math.random()*(W-pw), y:Math.random()*(H-ph)});
  return pos;
}

// ══════════════════════════════════════════════════════
//   SCREEN: VOTING — Cover Flow 3D
//
//   Tarjetas fijas: 200×300px
//   Timing: cada tarjeta pasa exactamente 5s en posición frontal
//   - Llega al frente en seg 1-2
//   - Está completamente al frente en seg 2-3 (centro: sin rotY, scale máxima)
//   - Sale en seg 4-5
// ══════════════════════════════════════════════════════

const CF_CARD_W   = 200;   // px fijo
const CF_CARD_H   = 300;   // px fijo
const CF_SECS     = 5;     // segundos por tarjeta al frente

function initVoting() { buildCoverFlow(); }

function stopCoverFlow() {
  if (cfRaf) { cancelAnimationFrame(cfRaf); cfRaf = null; }
  cfCards = []; cfAngle = 0; cfLastT = null;
  if (cfTrackEl) cfTrackEl.innerHTML = '';
}

function buildCoverFlow() {
  if (!cfTrackEl || !cfWrapEl) return;
  cfTrackEl.innerHTML = '';
  cfCards = [];

  const list = sorted();
  if (!list.length) return;

  const n = list.length;
  // Velocidad: 360° en n*CF_SECS segundos
  cfDegPerSec = 360 / (n * CF_SECS);

  list.forEach(p => {
    const card = document.createElement('div');
    card.className = 'cf-card';
    // Tamaño base fijo; JS aplica transform sin cambiar width/height
    card.style.cssText = `width:${CF_CARD_W}px;height:${CF_CARD_H}px;`;
    card.innerHTML = `
      ${imgTag(p)}
      <div class="cf-card-info">
        <div class="cf-card-num">${String(p.number||'').padStart(2,'0')}</div>
        <div class="cf-card-name">${p.name||'—'}</div>
      </div>`;
    cfTrackEl.appendChild(card);
    cfCards.push(card);
  });

  // Track: punto de origen en el centro del wrap
  cfTrackEl.style.cssText = 'position:absolute;top:50%;left:50%;width:0;height:0;overflow:visible;';

  cfLastT = null;
  cfRaf   = requestAnimationFrame(cfFrame);
}

function cfFrame(ts) {
  if (!cfLastT) cfLastT = ts;
  const dt = Math.min((ts - cfLastT) / 1000, 0.05);
  cfLastT  = ts;

  const n = cfCards.length;
  if (!n) { cfRaf = requestAnimationFrame(cfFrame); return; }

  cfAngle = (cfAngle + cfDegPerSec * dt) % 360;

  const wrapW = cfWrapEl ? cfWrapEl.clientWidth  : window.innerWidth;
  const wrapH = cfWrapEl ? cfWrapEl.clientHeight : window.innerHeight * 0.55;

  // Radio del elipse horizontal del carrusel
  // RX controla cuánto se separan las tarjetas lateralmente
  const RX = Math.min(wrapW * 0.36, 580);

  cfCards.forEach((card, i) => {
    const deg = (cfAngle + (i / n) * 360) % 360;
    const rad = (deg * Math.PI) / 180;

    // sin(rad): +1 = frente, -1 = fondo
    // cos(rad): posición lateral
    const sinA = Math.sin(rad);
    const cosA = Math.cos(rad);

    // t: 0 = fondo, 1 = frente (suavizado con smoothstep)
    const tRaw     = (sinA + 1) / 2;
    const t        = tRaw * tRaw * (3 - 2 * tRaw); // smoothstep

    // Escala: 1.0 al frente, 0.35 al fondo
    const scale    = 0.35 + t * 0.65;

    // Opacidad: 1 al frente, 0.1 al fondo
    const opacity  = 0.1 + t * 0.9;

    // Posición X: proyección del anillo
    const xPos     = cosA * RX;

    // Rotación Y: 0° al frente (plana), ±55° en los laterales
    const rotY     = -cosA * 55;

    // Ligero ajuste Y: tarjetas del fondo bajan un poco
    const yOff     = (1 - t) * 22;

    // Centrado: mover la tarjeta para que su centro coincida con xPos,0
    const tx       = xPos - CF_CARD_W / 2;
    const ty       = -(CF_CARD_H / 2) + yOff;

    const zIdx     = Math.round(t * 100);

    card.style.cssText = `
      width:${CF_CARD_W}px;height:${CF_CARD_H}px;
      transform:translate(${tx.toFixed(1)}px,${ty.toFixed(1)}px)
                perspective(1200px) rotateY(${rotY.toFixed(1)}deg)
                scale(${scale.toFixed(4)});
      opacity:${opacity.toFixed(3)};
      z-index:${zIdx};
      box-shadow:${t > 0.88
        ? '0 0 70px rgba(201,168,76,.42),0 30px 90px rgba(0,0,0,.85)'
        : t > 0.55
          ? '0 8px 35px rgba(0,0,0,.5)'
          : 'none'};
    `;

    const cls = t > 0.82 ? 'cf-front' : t > 0.42 ? 'cf-side' : 'cf-back';
    if (card.dataset.c !== cls) {
      card.classList.remove('cf-front','cf-side','cf-back');
      card.classList.add(cls);
      card.dataset.c = cls;
    }
  });

  cfRaf = requestAnimationFrame(cfFrame);
}

// ══════════════════════════════════════════════════════
//   SCREEN: CONSOLIDATION
// ══════════════════════════════════════════════════════

function initConsolidation() {
  revealRunning = false;
  if (consTitleEl) consTitleEl.style.cssText = 'opacity:1;transition:none;';
  if (pairRevEl)   { pairRevEl.style.display='none'; pairRevEl.className='pair-reveal'; }
  setTimeout(runReveal, 3000);
}

async function runReveal() {
  if (revealRunning) return;
  revealRunning = true;

  const list = sortedPairs().filter(([,p]) => !p.eliminated);
  if (!list.length) { revealRunning = false; goTo(S.PAIRS); return; }

  if (consTitleEl) {
    consTitleEl.style.transition = 'opacity .6s';
    consTitleEl.style.opacity = '0';
  }
  await sleep(700);

  for (let i = 0; i < list.length; i++) {
    const [key, pair] = list[i];
    await showPair(pair, pairNum(key), i+1, list.length);
    await sleep(350);
  }

  revealRunning = false;
  goTo(S.PAIRS);
}

function showPair(pair, num, idx, total) {
  return new Promise(resolve => {
    if (!pairRevEl) { resolve(); return; }

    const pts = pair.participants || [null,null];
    const pA  = byNum(pts[0]);
    const pB  = byNum(pts[1]);

    pairRevEl.innerHTML = `
      <div class="pr-item pr-eyebrow" style="--d:.05s">Consolidando</div>
      <div class="pr-item pr-pair-num" style="--d:.2s">
        Pareja ${String(num).padStart(2,'0')}
        <span class="pr-of-total">de ${total}</span>
      </div>
      <div class="pr-cards">
        <div class="pr-card pr-item" style="--d:.55s">
          ${imgTag(pA)}
          <div class="pr-name">${pA?.name||'—'}</div>
        </div>
        <div class="pr-vs" style="--d:.9s">×</div>
        <div class="pr-card pr-item" style="--d:.72s">
          ${imgTag(pB)}
          <div class="pr-name">${pB?.name||'—'}</div>
        </div>
      </div>
    `;

    pairRevEl.style.display = 'flex';
    void pairRevEl.offsetWidth; // reflow
    pairRevEl.classList.remove('hide');
    pairRevEl.classList.add('show');

    setTimeout(() => {
      pairRevEl.classList.remove('show');
      pairRevEl.classList.add('hide');
      setTimeout(() => {
        pairRevEl.style.display = 'none';
        pairRevEl.className = 'pair-reveal';
        resolve();
      }, 650);
    }, 5000);
  });
}

// ══════════════════════════════════════════════════════
//   SCREEN: PAIRS
// ══════════════════════════════════════════════════════

function initPairs() { renderPairsGrid(); }

function renderPairsGrid() {
  if (!pairsGridEl) return;
  pairsGridEl.innerHTML = '';

  const list = sortedPairs();
  if (!list.length) {
    pairsGridEl.innerHTML = `<p style="grid-column:1/-1;text-align:center;
      font-family:var(--mono);font-size:.68rem;letter-spacing:.3em;
      color:var(--grey);padding:3rem">CARGANDO...</p>`;
    return;
  }

  list.forEach(([key, pair], i) => {
    const pts = pair.participants || [null,null];
    const pA  = byNum(pts[0]);
    const pB  = byNum(pts[1]);
    const num = pairNum(key);
    const el  = document.createElement('div');
    el.className = 'pair-card' + (pair.eliminated ? ' eliminated' : '');
    el.style.setProperty('--d', `${i*.12}s`);
    el.innerHTML = `
      <div class="pair-card-num">Pareja ${String(num).padStart(2,'0')}</div>
      <div class="pair-card-photos">${imgTag(pA)}${imgTag(pB)}</div>
      <div class="pair-card-names">
        <div class="pair-card-name">${pA?.name||'—'}</div>
        <div class="pair-card-name">${pB?.name||'—'}</div>
      </div>`;
    pairsGridEl.appendChild(el);
  });
}

// ══════════════════════════════════════════════════════
//   ELIMINACIONES
// ══════════════════════════════════════════════════════

function detectElim(prev, next) {
  Object.entries(next).forEach(([key, pair]) => {
    if (!pair) return;
    const old    = prev[key] || {};
    const oldPts = old.participants  || [null,null];
    const newPts = pair.participants || [null,null];
    const num    = pairNum(key);

    if (pair.eliminated && !old.eliminated) {
      const pA = byNum(newPts[0] ?? oldPts[0]);
      const pB = byNum(newPts[1] ?? oldPts[1]);
      qElim({ label:`Pareja ${String(num).padStart(2,'0')} — Eliminada`, names:[pA?.name||'—',pB?.name||'—'], photos:[pA,pB] });
      return;
    }
    [0,1].forEach(i => {
      if (oldPts[i] != null && newPts[i] == null) {
        const p = byNum(oldPts[i]);
        qElim({ label:'Participante Eliminado', names:[p?.name||'—'], photos:[p], sub:`De Pareja ${String(num).padStart(2,'0')}` });
      }
    });
  });
}

function qElim(data) { elimQueue.push(data); if (!elimBusy) runElimQ(); }

async function runElimQ() {
  if (elimBusy || !elimQueue.length) return;
  elimBusy = true;
  while (elimQueue.length) { await showElim(elimQueue.shift()); await sleep(450); }
  elimBusy = false;
}

function showElim(data) {
  return new Promise(resolve => {
    if (!overlayElim) { resolve(); return; }
    overlayElim.innerHTML = `
      <div class="elim-flash"></div>
      <div class="elim-tag">${data.label}</div>
      <div class="elim-photos">${data.photos.map(p=>`<div class="elim-photo">${imgTag(p)}</div>`).join('')}</div>
      <div class="elim-name">${data.names.join(' · ')}</div>
      ${data.sub ? `<div class="elim-sub">${data.sub}</div>` : ''}
    `;
    overlayElim.classList.remove('hide');
    overlayElim.classList.add('show');
    setTimeout(() => {
      overlayElim.classList.remove('show');
      overlayElim.classList.add('hide');
      setTimeout(() => { overlayElim.className=''; resolve(); }, 550);
    }, 5000);
  });
}

// ══════════════════════════════════════════════════════
//   SCREEN: WINNER
//   Secuencia espectacular 10s → estático final
//   1. Flash blanco (0s)
//   2. Fondo dorado aparece (0.3s)
//   3. "Y los ganadores..." (1s)
//   4. Número de pareja (1.8s)
//   5. Foto ganador 1 + pulso dorado (2.4s)
//   6. Foto ganador 2 + pulso dorado (3.2s)
//   7. Nombres (4s)
//   8. "¡FELICIDADES!" shimmer (5.2s)
//   9. "Ustedes son seres imprescindibles." (6.4s)
//   10. Partículas masivas en canvas (2s → infinito)
// ══════════════════════════════════════════════════════

function initWinner() {
  if (!winner) return;
  const pair  = pairs[winner] || {};
  const pts   = pair.participants || [null,null];
  const pA    = byNum(pts[0]);
  const pB    = byNum(pts[1]);
  const num   = pairNum(winner);
  const label = `Pareja ${String(num).padStart(2,'0')}`;

  if (!winContent) return;

  winContent.innerHTML = `
    <div class="w-flash"></div>
    <div class="winner-bg"></div>

    <div class="w-intro" style="--d:1s">Y los Ganadores de Danzad Malditos son...</div>
    <div class="w-gold-line" style="--d:1.6s"></div>
    <div class="w-pair-num" style="--d:1.9s">${label}</div>

    <div class="w-cards-row">
      <div class="w-card" style="--d:2.5s">
        <div class="w-photo-frame">
          ${imgTag(pA)}
          <div class="w-photo-label">${label}</div>
        </div>
      </div>

      <div class="w-amp" style="--d:3.8s">&amp;</div>

      <div class="w-card" style="--d:3.2s">
        <div class="w-photo-frame">
          ${imgTag(pB)}
          <div class="w-photo-label"></div>
        </div>
      </div>
    </div>

    <div class="w-names-row">
      <div class="w-name" style="--d:4.2s">${pA?.name||'—'}</div>
      <div class="w-name-sep" style="--d:4.6s">·</div>
      <div class="w-name" style="--d:4.4s">${pB?.name||'—'}</div>
    </div>

    <div class="w-felicidades" style="--d:5.4s">¡Felicidades!</div>
    <div class="w-tagline" style="--d:6.6s">Ustedes son seres imprescindibles.</div>
  `;

  // Agregar CSS inline para w-names-row y w-name-sep (clases nuevas)
  const style = document.createElement('style');
  style.textContent = `
    .w-names-row {
      display: flex; align-items: center; gap: clamp(.6rem,2vw,1.4rem);
      flex-wrap: wrap; justify-content: center;
    }
    .w-name-sep {
      font-family: var(--hero); font-size: 2rem;
      color: var(--gold); opacity: 0;
      animation: kSeqItem .5s var(--expo) both;
      animation-delay: var(--d,0s);
    }
  `;
  document.head.appendChild(style);

  // Lanzar canvas de partículas masivas a los 2s
  setTimeout(startWinnerCanvas, 2000);
}

function stopWinnerCanvas() {
  if (winRaf) { cancelAnimationFrame(winRaf); winRaf = null; }
  winParticles = [];
  if (winCanvas) {
    const ctx = winCanvas.getContext('2d');
    ctx.clearRect(0, 0, winCanvas.width, winCanvas.height);
  }
}

function startWinnerCanvas() {
  if (!winCanvas) return;

  const canvas = winCanvas;
  const ctx    = canvas.getContext('2d');

  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  // Crear 300 partículas desde el centro
  const cx = canvas.width  / 2;
  const cy = canvas.height * 0.38;
  const COLORS = ['#c9a84c','#f5e070','#ffffff','#e8c060','#d4aa4a','#fff8e0'];

  winParticles = [];
  for (let i = 0; i < 300; i++) {
    const angle = Math.random() * 2 * Math.PI;
    const speed = 80 + Math.random() * 420;
    const life  = 2.5 + Math.random() * 4;
    const size  = 1.5 + Math.random() * 4.5;
    winParticles.push({
      x: cx, y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - (Math.random() * 80),  // leve impulso hacia arriba
      ax: 0,
      ay: 120 + Math.random() * 60,  // gravedad
      size,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      life,
      maxLife: life,
      born: false  // se activan escalonados
    });
  }

  // También confetti rectangular
  for (let i = 0; i < 120; i++) {
    const angle = Math.random() * 2 * Math.PI;
    const speed = 60 + Math.random() * 340;
    const life  = 3 + Math.random() * 4;
    winParticles.push({
      x: Math.random() * canvas.width,
      y: -20,
      vx: (Math.random() - 0.5) * 200,
      vy: 80 + Math.random() * 220,
      ay: 40,
      size: 5 + Math.random() * 7,
      w: 5, h: 10 + Math.random() * 8,
      rot: Math.random() * Math.PI * 2,
      rotV: (Math.random() - 0.5) * 6,
      isRect: true,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      life, maxLife: life
    });
  }

  let lastT = null;

  function frame(ts) {
    if (!lastT) lastT = ts;
    const dt = Math.min((ts - lastT) / 1000, 0.04);
    lastT = ts;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    let alive = false;

    winParticles.forEach(p => {
      p.life -= dt;
      if (p.life <= 0) return;
      alive = true;

      p.vy += (p.ay || 0) * dt;
      p.vx += (p.ax || 0) * dt;
      p.x  += p.vx * dt;
      p.y  += p.vy * dt;

      const alpha = Math.min(1, p.life / (p.maxLife * 0.3));

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle   = p.color;

      if (p.isRect) {
        p.rot = (p.rot || 0) + (p.rotV || 0) * dt;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillRect(-p.w/2, -p.h/2, p.w, p.h);
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    });

    // Regenerar partículas cíclicamente mientras estemos en winner
    winParticles = winParticles.filter(p => p.life > 0);
    if (winParticles.length < 150 && state === S.WINNER) {
      // Inyectar más
      for (let i = 0; i < 40; i++) {
        const a = Math.random() * 2 * Math.PI;
        const s = 60 + Math.random() * 360;
        const l = 2 + Math.random() * 3;
        winParticles.push({
          x: cx + (Math.random()-0.5)*80,
          y: cy + (Math.random()-0.5)*40,
          vx: Math.cos(a)*s, vy: Math.sin(a)*s - 50,
          ay: 100, size: 1.5+Math.random()*3.5,
          color: COLORS[Math.floor(Math.random()*COLORS.length)],
          life: l, maxLife: l
        });
      }
    }

    winRaf = requestAnimationFrame(frame);
  }

  winRaf = requestAnimationFrame(frame);
}

// ══════════════════════════════════════════════════════
//   BOOT
// ══════════════════════════════════════════════════════

function boot() {
  console.log('[Broadcast] Danzad Malditos v5 iniciando...');
  listenAll();
  goTo(S.WAITING);
}

boot();
