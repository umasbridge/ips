// ips-module.js — Self-contained IPS play table module.
//
// Depends on globals set by:
//   lin.js   → globalThis.bpLin
//   play.js  → globalThis.bpPlay
//   ips.js   → globalThis.bpIps
//
// These must be loaded (as <script> tags or dynamic script injection) before
// calling mountIpsPlayer.
//
// API:
//   import { mountIpsPlayer } from '/bridge-lib/ips/ips-module.js';
//
//   const player = mountIpsPlayer(containerEl, {
//     row,         // { lin, problem_visible_hands, contract, problem_id, ... }
//     ddsPath,     // absolute URL to dds-api.js, e.g. '/bridge-problems/dds/dds-api.js'
//     format,      // 'MP' | 'IMP' | null  — for alert severity
//     cardingNS,   // 'UDCA' | 'STD'
//     cardingEW,   // 'UDCA' | 'STD'
//     onComplete,  // fn(result) called when the play session ends
//                  // result: { interactive, gaveUp, solved, tricksMade, optimal, retries, timestamp }
//   });
//
//   player.unmount();             // tear down and remove the DOM
//   player.finalizeIfInteracted();// record a give-up if user played any cards

const sharedDdsByPath = new Map();

export function createIpsPlayerRuntime() {

// ── Internal constants ────────────────────────────────────────────────────────

const SUIT_ORDER = ['S', 'H', 'D', 'C'];
const SUIT_SYM   = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_COLOR = { S: 'black', H: 'red', D: 'red', C: 'black' };
const SEAT_FULL  = { N: 'North', S: 'South', E: 'East', W: 'West' };

const suitHex = su => SUIT_COLOR[su] === 'red' ? '#c0241c' : '#111';
const ptSleep = ms => new Promise(r => setTimeout(r, ms));

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function parseContractStr(str) {
  if (!str) return null;
  const m = String(str).match(/^(\d)([SHDCN])(X{0,2})/i);
  if (!m) return null;
  return { level: m[1], denom: m[2].toUpperCase(), doubled: m[3].toUpperCase() };
}

// ── Module-level singleton state ──────────────────────────────────────────────
// Only one play table is active at a time.

let _pt       = null;   // active play table state object
let _ptGen    = 0;      // bumped on every (re)start; stale async loops bail when gen changes
let _ptDds    = null;   // loaded DDS solver instance
let _ptDdsLoading = null;
let _ptDdsPath    = null;   // set on each mount
let _ptAlertOn    = localStorage.getItem('bpAlertOn') === '1';
let _ptOnComplete     = null;   // onComplete callback from current mount
let _ptDeferComplete  = false;  // when true, delay onComplete until user advances past completion
let _ptFormat     = null;   // 'MP' | 'IMP' | null
let _ptNavEl      = null;   // optional external element for nav controls
let _ptBiddingHtml   = '';
let _ptDdOn              = false;
let _ptHideDdButton      = false;
let _ptHideAlertButton   = false;
let _ptBottomLeftEl      = null;   // optional external element injected into .pt-pos-bl

// ── DDS lazy loader ───────────────────────────────────────────────────────────

function ensureDds() {
  if (_ptDds) return Promise.resolve(_ptDds);
  if (!_ptDdsLoading) {
    if (!sharedDdsByPath.has(_ptDdsPath)) {
      sharedDdsByPath.set(_ptDdsPath, import(/* @vite-ignore */ _ptDdsPath)
        .then(m => m.loadDds().then(mod => new m.Dds(mod))));
    }
    _ptDdsLoading = sharedDdsByPath.get(_ptDdsPath)
      .then(dds => { _ptDds = dds; return dds; });
  }
  return _ptDdsLoading;
}

// ── Alert toggle ──────────────────────────────────────────────────────────────

function ptToggleAlert() {
  _ptAlertOn = !_ptAlertOn;
  localStorage.setItem('bpAlertOn', _ptAlertOn ? '1' : '0');
  if (!_ptAlertOn && _pt) _pt.warn = null;
  ptRender();
}

function ptToggleDd() {
  // Show the static DD tricks table when: the deal is fully complete (no cards left
  // to annotate), OR before a hand has been played and there's no recorded play.
  // After advancing into replay mode, DD becomes a card-analysis overlay instead.
  const atEnd = _pt && _pt.P.isComplete(_pt.state) && !_pt.reviewReplay;
  if (atEnd || (_pt && !_pt.reviewAvailable && (!Array.isArray(_pt.row.play) || _pt.row.play.length < 2))) {
    _pt.ddTableOpen = !_pt.ddTableOpen;
    if (_pt.ddTableOpen && !_pt.ddTable && !_pt.ddTableError) {
      try {
        const seats = ['N', 'E', 'S', 'W'];
        const suits = ['S', 'H', 'D', 'C'];
        const cards = 'N:' + seats.map(seat => suits.map(suit =>
          String(_pt.hands?.[seat]?.[suit] || '').replace(/10/g, 'T')
        ).join('.')).join(' ');
        _pt.ddTable = _ptDds.CalcDDTablePBN({ cards });
      } catch (err) {
        _pt.ddTableError = String(err?.message || err);
      }
    }
    ptRender();
    return;
  }
  _ptDdOn = !_ptDdOn;
  ptRender();
}

function ptCloseDdTable() {
  if (!_pt) return;
  _pt.ddTableOpen = false;
  ptRender();
}

// ── Session tracking ──────────────────────────────────────────────────────────

function ptFreshSession() {
  return { interacted: false, recorded: false, retries: [], optimalUserFinal: null, userSide: null };
}

// ── Game flow ─────────────────────────────────────────────────────────────────

// Reveal dummy after the opening lead. Called after every applyCard/programMove.
// visible is static at setup time; this mutates it once when the lead is played.
function ptMaybeRevealDummy() {
  if (!_pt || _pt.dummyRevealed) return;
  const st = _pt.state;
  if (st.tricks.length === 0 && st.trick.length >= 1) {
    if (!_pt.visible.includes(_pt.dummy)) _pt.visible = [..._pt.visible, _pt.dummy];
    _pt.dummyRevealed = true;
  }
}

function ptStart() {
  if (!_pt) return;
  const P = _pt.P;
  const savedPlayerNames = _pt.row.player_names;
  let setup = P.setupFromRow(_pt.row);

  // A LIN may contain a complete deal and contract without a recorded play
  // sequence (or without the auction's closing passes). Initialise a fresh
  // table from that data so it can still be played from the opening lead or
  // displayed in view mode.
  if (!setup && (_pt.mode === 'view' || _pt.mode === 'play')) {
    const parsed = P.parseLin(_pt.row.lin);
    const declarer = parsed?.declarer || _pt.row.declarer;
    if (declarer && parsed?.hands) {
      const hands = parsed.hands;
      const denom = String(_pt.row.contract || '').replace(/^\d+/, '').replace(/x/ig, '').toUpperCase();
      const trump = parsed.trump ?? (denom === 'NT' || denom === 'N' ? null : denom || null);
      const dummy = P.partner(declarer);
      const leader = P.lho(declarer);
      const visible = _pt.row.problem_visible_hands || ['N', 'E', 'S', 'W'];
      const contractLevel = Number.parseInt(_pt.row.contract, 10) || null;
      const parsedScript = Array.isArray(_pt.row.play)
        ? _pt.row.play.map(card => globalThis.bpLin?.parseLeadCard?.(card)).filter(Boolean)
        : [];
      const validScript = parsedScript.length
        && globalThis.bpLin?.seatHoldingLead?.(hands, parsedScript[0]) === leader
        ? parsedScript
        : [];
      setup = {
        state: P.initPlay({
          hands,
          declarer,
          trump,
          contractLevel,
          contractDoubled: /x/i.test(_pt.row.contract || ''),
        }),
        hands,
        declarer,
        dummy,
        trump,
        leader,
        solver: null,
        visible,
        userSeats: _pt.mode === 'play' ? P.computeUserSeats(declarer, visible) : new Set(),
        script: validScript,
        usedPlayPrefix: false,
      };
    }
  }
  if (!setup) {
    _pt.root.innerHTML = '<div class="pt-loading">This deal is not playable.</div>';
    return;
  }
  if (_pt.mode === 'play' && Array.isArray(_pt.row.problem_user_hands)) {
    setup.userSeats = new Set(_pt.row.problem_user_hands);
  }
  const originalHands = {};
  for (const seat of ['N', 'E', 'S', 'W']) {
    originalHands[seat] = {};
    for (const suit of SUIT_ORDER) {
      originalHands[seat][suit] = [...(setup.state?.remaining?.[seat]?.[suit] || [])];
    }
  }
  Object.assign(_pt, setup, {
    locked: false, illegalKey: null, warn: null, scriptIdx: 0, userActed: false,
    retryArmed: false, awaitingAdvance: false, claiming: false, claimMax: null,
    claimMin: null, claimError: null, claimed: false, result: null,
    gen: ++_ptGen, history: [], viewTrick: null, dummyRevealed: false,
    trickCheckpoints: [], scriptHighwater: 0,
    ddTableOpen: false, ddTable: null, ddTableError: null,
    originalHands,
  });
  if (savedPlayerNames) _pt.row = { ..._pt.row, player_names: savedPlayerNames };
  _pt.contract = parseContractStr(_pt.row.contract);
  const completedResult = !_pt.reviewReplay ? _pt.row.completed_result : null;
  const completedDeclarerTricks = Number(completedResult?.declarerTricks);
  const restoredCompletion = Number.isFinite(completedDeclarerTricks);
  if (restoredCompletion) {
    const declarerSide = P.sideOf(_pt.declarer);
    _pt.state.nsTricks = declarerSide === 'NS' ? completedDeclarerTricks : 13 - completedDeclarerTricks;
    _pt.state.ewTricks = declarerSide === 'NS' ? 13 - completedDeclarerTricks : completedDeclarerTricks;
    for (const seat of P.SEATS) {
      for (const suit of P.SUITS) _pt.state.remaining[seat][suit] = [];
    }
    _pt.state.trick = [];
    _pt.reviewAvailable = true;
  }
  if (!restoredCompletion && _pt.script.length >= 1) {
    _pt.trickCheckpoints.push({ state: P.cloneState(_pt.state), scriptIdx: 0 });
    P.applyCard(_pt.state, _pt.script[0]); _pt.scriptIdx = 1; _pt.scriptHighwater = 1; ptMaybeRevealDummy();
  }
  ptRender();
  if (_pt.mode !== 'view' && _pt.scriptIdx >= _pt.script.length && !P.isComplete(_pt.state) && !_pt.userSeats.has(_pt.state.turn)) {
    ptRunProgram();
  }
}

function ptStepping() { return !!(_pt && _pt.script && _pt.scriptIdx < _pt.script.length); }

function ptStepForward() {
  if (!_pt || _pt.scriptIdx >= _pt.script.length) return;
  const P = _pt.P;
  if (_pt.state.trick.length === 0) {
    _pt.trickCheckpoints.push({ state: P.cloneState(_pt.state), scriptIdx: _pt.scriptIdx });
  }
  P.applyCard(_pt.state, _pt.script[_pt.scriptIdx++]);
  if (_pt.scriptIdx > _pt.scriptHighwater) _pt.scriptHighwater = _pt.scriptIdx;
  ptMaybeRevealDummy();
  ptRender();
  if (_pt.scriptIdx >= _pt.script.length && !P.isComplete(_pt.state) && !_pt.userSeats.has(_pt.state.turn)) {
    ptRunProgram();
  }
}

function ptUndoTrick() {
  if (!_pt || !_pt.trickCheckpoints.length) return;
  const cp = _pt.trickCheckpoints.pop();
  _pt.state = cp.state;
  _pt.scriptIdx = cp.scriptIdx;
  _pt.viewTrick = null;
  _pt.awaitingAdvance = false;
  _pt.locked = false;
  _pt.result = null;
  ptRender();
}

async function ptRunProgram() {
  if (!_pt) return;
  const mine = _pt, gen = mine.gen, P = mine.P;
  const alive = () => _pt === mine && mine.gen === gen;
  mine.locked = true;
  ptRender();
  while (alive() && !P.isComplete(mine.state) && !mine.userSeats.has(mine.state.turn) && !mine.awaitingAdvance) {
    await ptSleep(700);
    if (!alive()) return;
    P.programMove(_ptDds, mine.state, mine.userSeats, mine.declarer);
    ptMaybeRevealDummy();
    if (!P.isComplete(mine.state) && mine.state.trick.length === 0) {
      if (!mine.userSeats.has(mine.state.turn)) mine.awaitingAdvance = true;
      mine.locked = false;
      ptRender();
      return;
    }
    ptRender();
  }
  if (!alive()) return;
  mine.locked = false;
  ptRender();
  if (P.isComplete(mine.state)) ptCommitAttempt(false);
}

function ptOnCardClick(seat, suit, rank) {
  if (!_pt || _pt.locked || ptStepping() || _pt.awaitingAdvance || _pt.viewTrick !== null) return;
  const P = _pt.P;
  if (_pt.state.turn !== seat || !_pt.userSeats.has(seat)) return;
  if (!P.isLegal(_pt.state, { suit, rank }, seat)) {
    const mine = _pt;
    mine.illegalKey = seat + suit + rank;
    ptRender();
    setTimeout(() => { if (_pt === mine) { mine.illegalKey = null; ptRender(); } }, 400);
    return;
  }
  _pt.illegalKey = null;
  _pt.warn = _ptAlertOn ? ptEvaluateCard(seat, { suit, rank }) : null;
  ptCaptureTarget();
  _pt.session.interacted = true;
  _pt.userActed = true;
  _pt.history.push(_pt.P.cloneState(_pt.state));
  P.applyCard(_pt.state, { suit, rank });
  ptMaybeRevealDummy();
  if (P.isComplete(_pt.state)) {
    ptRender();
    ptCommitAttempt(false);
    return;
  }
  if (_pt.state.trick.length === 0) {
    if (!_pt.userSeats.has(_pt.state.turn)) _pt.awaitingAdvance = true;
    ptRender();
    return;
  }
  ptRender();
  if (!_pt.userSeats.has(_pt.state.turn)) ptRunProgram();
}

function ptAdvance() {
  if (!_pt || !_pt.awaitingAdvance) return;
  _pt.awaitingAdvance = false;
  ptRender();
  if (!_pt.P.isComplete(_pt.state) && !_pt.userSeats.has(_pt.state.turn)) ptRunProgram();
}

function ptUndo() {
  if (!_pt || !_pt.history.length || ptStepping()) return;
  _pt.state = _pt.history.pop();
  _pt.awaitingAdvance = false;
  _pt.locked = false;
  _pt.warn = null;
  _pt.viewTrick = null;
  ptRender();
}

function ptPrevTrick() {
  if (!_pt) return;
  const n = _pt.state.tricks.length;
  if (n === 0) return;
  _pt.viewTrick = _pt.viewTrick === null ? n - 1 : Math.max(0, _pt.viewTrick - 1);
  ptRender();
}

function ptNextTrick() {
  if (!_pt || _pt.viewTrick === null) return;
  _pt.viewTrick = _pt.viewTrick >= _pt.state.tricks.length - 1 ? null : _pt.viewTrick + 1;
  ptRender();
}

function ptAdvanceTrick() {
  if (!_pt || !ptStepping()) return;
  const P = _pt.P, st = _pt.state;
  if (st.trick.length === 0) {
    _pt.trickCheckpoints.push({ state: P.cloneState(st), scriptIdx: _pt.scriptIdx });
  }
  do {
    P.applyCard(_pt.state, _pt.script[_pt.scriptIdx++]);
    ptMaybeRevealDummy();
  } while (_pt && ptStepping() && _pt.state.trick.length > 0);
  ptRender();
  if (_pt && _pt.scriptIdx >= _pt.script.length && !_pt.P.isComplete(_pt.state) && !_pt.userSeats.has(_pt.state.turn)) {
    ptRunProgram();
  }
}

function ptProceed() {
  if (!_pt) return;
  if (_pt.pendingComplete) {
    const { fn, data } = _pt.pendingComplete;
    _pt.pendingComplete = null;
    _pt.session = ptFreshSession();
    fn(data);
    return;
  }
  if (_pt.awaitingAdvance) return ptAdvance();
  const st = _pt.state;
  const atBoundary = st.trick.length === 0 && st.tricks.length > 0;
  if (atBoundary && ptStepping() && _pt.scriptIdx < _pt.scriptHighwater) {
    return ptAdvanceTrick();
  }
  return ptStepForward();
}

function ptRetryClick() {
  if (!_pt) return;
  const s = _pt.session;
  if (s.interacted && !s.recorded) s.retries.push({ tricks: _pt.state.tricks.length, at: Date.now() });
  s.interacted = true;
  // Replay from a completed board is an analysis replay: keep all four hands
  // visible and turn on the per-card double-dummy overlay automatically.
  if (_pt.reviewAvailable) _ptDdOn = true;
  _pt.reviewReplay = !!_pt.reviewAvailable;
  _pt.pendingComplete = null;
  ptStart();
}

function ptUserSide() { return _pt.P.sideOf([..._pt.userSeats][0]); }
function ptTricksRemaining() { return 13 - _pt.state.tricks.length; }

// ── Claim / concede ───────────────────────────────────────────────────────────

function ptDeclarerDdFuture() {
  const P = _pt.P, declSide = P.sideOf(_pt.declarer);
  const c = JSON.parse(JSON.stringify(_pt.state));
  const before = declSide === 'NS' ? c.nsTricks : c.ewTricks;
  let guard = 0;
  while (!P.isComplete(c) && guard++ < 80) P.programMove(_ptDds, c);
  return (declSide === 'NS' ? c.nsTricks : c.ewTricks) - before;
}

function ptDeclarerDdMinFuture() {
  if (!_ptDds) return 0;
  const P = _pt.P, declSide = P.sideOf(_pt.declarer), state = _pt.state;
  const ft = _ptDds.SolveBoardPBN(P.toDealPbn(state), -1, 3, 0);
  let minScore = Infinity, hasDegenerate = false;
  for (let i = 0; i < ft.cards; i++) {
    if (ft.score[i] < 0) { hasDegenerate = true; break; }
    if (ft.score[i] < minScore) minScore = ft.score[i];
  }
  if (!hasDegenerate) return minScore === Infinity ? 0 : minScore;
  const moves = P.legalMoves(state);
  let minFuture = Infinity;
  for (const card of moves) {
    const c = JSON.parse(JSON.stringify(state));
    const before = declSide === 'NS' ? c.nsTricks : c.ewTricks;
    P.applyCard(c, card);
    let guard = 0;
    while (!P.isComplete(c) && guard++ < 80) P.programMove(_ptDds, c);
    const future = (declSide === 'NS' ? c.nsTricks : c.ewTricks) - before;
    if (future < minFuture) minFuture = future;
  }
  return minFuture === Infinity ? 0 : minFuture;
}

function ptCanClaim() {
  if (!_pt || !_pt.contract) return false;
  const st = _pt.state;
  if (_pt.P.isComplete(st) || ptStepping() || _pt.locked || _pt.claiming) return false;
  const makeTricks = Number(_pt.contract.level) + 6;
  const declSide = _pt.P.sideOf(_pt.declarer);
  const declWon = declSide === 'NS' ? st.nsTricks : st.ewTricks;
  const defWon  = declSide === 'NS' ? st.ewTricks : st.nsTricks;
  return ptUserSide() === declSide ? declWon >= makeTricks : defWon >= (14 - makeTricks);
}

function ptClaimOpen() {
  if (!ptCanClaim()) return;
  const declFuture = _ptDds ? ptDeclarerDdFuture() : 0;
  ptFinishWith(declFuture);
}

function ptClaimCancel() {
  if (!_pt) return;
  _pt.claiming = false; _pt.claimError = null;
  ptRender();
}

function ptFinishWith(declFuture) {
  const st = _pt.state, P = _pt.P;
  ptCaptureTarget();
  _pt.session.interacted = true;
  _pt.userActed = true;
  const declSide = P.sideOf(_pt.declarer);
  const declNow  = declSide === 'NS' ? st.nsTricks : st.ewTricks;
  const declTotal = declNow + declFuture;
  st.nsTricks = declSide === 'NS' ? declTotal : 13 - declTotal;
  st.ewTricks = declSide === 'NS' ? 13 - declTotal : declTotal;
  for (const s of P.SEATS) for (const su of P.SUITS) st.remaining[s][su] = [];
  st.trick = [];
  _pt.claiming = false;
  _pt.claimed  = true;
  ptRender();
  ptCommitAttempt(false);
}

function ptConcedeAll() { if (_pt) ptFinishWith(ptTricksRemaining()); }

function ptDeclarerClaim(n) {
  if (!_pt) return;
  const remaining = ptTricksRemaining();
  const max = _pt.claimMax == null ? 0 : _pt.claimMax;
  const min = _pt.claimMin == null ? max : _pt.claimMin;
  n = Math.floor(Number(n));
  if (!Number.isFinite(n) || n < 0 || n > remaining) {
    _pt.claimError = `Enter a number between 0 and ${remaining}.`; ptRender(); return;
  }
  if (n > max) {
    _pt.claimError = `Double-dummy you can take only ${max} more trick${max === 1 ? '' : 's'} from here against best defense — claim rejected.`;
    ptRender(); return;
  }
  if (n > min) {
    _pt.claimError = `You could go wrong from here — not all lines guarantee ${n} trick${n === 1 ? '' : 's'}. You can safely claim at most ${min}.`;
    ptRender(); return;
  }
  ptFinishWith(n);
}

// ── Alert evaluation ──────────────────────────────────────────────────────────

function ptEvaluateCard(seat, card) {
  if (!_ptDds || !_pt.contract) return null;
  const P = _pt.P, st = _pt.state;
  const side = P.sideOf(seat), declSide = P.sideOf(_pt.declarer);
  const won = side === 'NS' ? st.nsTricks : st.ewTricks;
  const { best, played } = P.ddScores(_ptDds, st, card);
  if (best == null || played == null || best < 0 || played < 0) return null;
  const makeTricks = Number(_pt.contract.level) + 6;
  const goal = side === declSide ? makeTricks : 14 - makeTricks;
  if ((won + best) >= goal && (won + played) < goal) {
    return side === declSide ? 'That play costs you the contract.' : 'That play sells the contract.';
  }
  if (_ptFormat === 'MP') {
    const drop = best - played;
    if (drop > 0) {
      const declPlayed = side === declSide ? (won + played) : 13 - (won + played);
      const makes = declPlayed >= makeTricks;
      const qty = drop === 1 ? 'an' : String(drop), s = drop === 1 ? '' : 's';
      if (side === declSide) return makes ? `That play costs ${qty} overtrick${s}.` : `That play costs ${qty} extra undertrick${s}.`;
      return makes ? `That play gives declarer ${qty} overtrick${s}.` : `That play costs ${qty} undertrick${s}.`;
    }
  }
  return null;
}

function ptCaptureTarget() {
  const s = _pt.session;
  if (s.optimalUserFinal != null || !_ptDds) return;
  const P = _pt.P, st = _pt.state, side = ptUserSide();
  const won = side === 'NS' ? st.nsTricks : st.ewTricks;
  const sug = P.ddSuggest(_ptDds, st);
  s.userSide = side;
  s.optimalUserFinal = won + (sug ? sug.score : 0);
}

// ── Attempt commit ────────────────────────────────────────────────────────────

function ptCommitAttempt(gaveUp) {
  const s = _pt.session;
  if (!s || s.recorded) return;
  s.recorded = true;
  const P = _pt.P, st = _pt.state;
  const side = s.userSide || ptUserSide();
  const made = side === 'NS' ? st.nsTricks : st.ewTricks;
  const userIsDecl = side === P.sideOf(_pt.declarer);
  const contractTarget = _pt.contract ? Number(_pt.contract.level) + 6 : null;
  const solved = gaveUp ? null : (contractTarget == null ? null
    : made >= (userIsDecl ? contractTarget : 14 - contractTarget));
  // A DD review replay is analysis of an already-recorded result.  It must not
  // replace the result stored for the board.
  if (_ptOnComplete && !_pt.reviewReplay) {
    const completion = ptCompletionSummary();
    const payload = {
      interactive: true, gaveUp: !!gaveUp, solved,
      retries: s.retries.slice(),
      tricksMade: gaveUp ? null : made,
      optimal: s.optimalUserFinal,
      grade: null, remarks: '',
      timestamp: new Date().toISOString(),
      ...(completion || {}),
    };
    if (_ptDeferComplete) {
      // Hold the callback until the user clicks ▶ past the completion state.
      _pt.pendingComplete = { fn: _ptOnComplete, data: payload };
      ptRender();
      return;
    }
    _ptOnComplete(payload);
  }
  _pt.session = ptFreshSession();
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function ptDdCardScores() {
  const scores = new Map();
  if (!_ptDdOn || !_ptDds || !_pt || _pt.viewTrick !== null || _pt.P.isComplete(_pt.state)) return scores;
  const P = _pt.P;
  const ft = _ptDds.SolveBoardPBN(P.toDealPbn(_pt.state), -1, 3, 0);
  const declarerSide = P.sideOf(_pt.declarer);
  const actingSide = P.sideOf(_pt.state.turn);
  const declarerWon = declarerSide === 'NS' ? _pt.state.nsTricks : _pt.state.ewTricks;
  const defendersWon = declarerSide === 'NS' ? _pt.state.ewTricks : _pt.state.nsTricks;
  const target = _pt.contract ? Number(_pt.contract.level) + 6 : null;
  const contractResult = futureTricks => {
    if (target == null) return futureTricks;
    const finalDeclarerTricks = actingSide === declarerSide
      ? declarerWon + futureTricks
      : 13 - (defendersWon + futureTricks);
    return finalDeclarerTricks - target;
  };
  scores.contractRelative = target != null;
  for (let i = 0; i < ft.cards; i++) {
    const result = contractResult(ft.score[i]);
    const suit = P.SUITS[ft.suit[i]];
    scores.set(suit + P.IVAL[ft.rank[i]], result);
    for (let rank = 2; rank < ft.rank[i]; rank++)
      if ((ft.equals[i] >> rank) & 1) scores.set(suit + P.IVAL[rank], result);
  }
  return scores;
}

function ptRenderHand(seat, ddScores = new Map()) {
  const P = _pt.P, st = _pt.state;
  const complete = P.isComplete(st);
  const visible = complete || (_pt.reviewAvailable && _ptDdOn) || _pt.visible.includes(seat);
  const isUser  = _pt.userSeats.has(seat);
  const yourTurn = !_pt.locked && !ptStepping() && !_pt.awaitingAdvance
    && _pt.viewTrick === null && isUser && st.turn === seat && !P.isComplete(st);
  if (!visible) return `<div class="pt-hand pt-hidden"><span class="pt-back">🂠</span></div>`;
  const legalSet = new Set(yourTurn ? P.legalMoves(st, seat).map(c => c.suit + c.rank) : []);
  const rows = SUIT_ORDER.map(su => {
    // Once play is complete, restore the original deal so the result can be
    // reviewed with all 52 cards visible in the same board layout.
    const originalCards = _pt.originalHands?.[seat]?.[su];
    const cards = complete && Array.isArray(originalCards)
      ? originalCards
      : st.remaining[seat][su];
    const spans = cards.map(r => {
      const disp = r === 'T' ? '10' : r;
      const playable = legalSet.has(su + r);
      const bad = _pt.illegalKey === seat + su + r;
      const ddScore = seat === st.turn ? ddScores.get(su + r) : null;
      const ddText = ddScore == null ? '' : ddScores.contractRelative
        ? (ddScore === 0 ? '=' : String(Math.abs(ddScore)))
        : String(ddScore);
      const ddTitle = ddScore == null || !ddScores.contractRelative ? ''
        : (ddScore === 0 ? 'Contract makes exactly' : ddScore > 0 ? `${ddScore} overtrick${ddScore === 1 ? '' : 's'}` : `${Math.abs(ddScore)} undertrick${ddScore === -1 ? '' : 's'}`);
      const badge = ddScore == null ? '' : `<span class="pt-dd-badge ${ddScore >= 0 ? 'pt-dd-best' : 'pt-dd-loss'}" title="${ddTitle}">${ddText}</span>`;
      return `<span class="pt-card${playable ? ' pt-playable' : ''}${bad ? ' pt-bad' : ''}${ddScore == null ? '' : ' pt-card-dd'}" data-seat="${seat}" data-suit="${su}" data-rank="${r}" style="color:#111">${disp}${badge}</span>`;
    }).join('');
    return `<div class="pt-row"><span class="pt-suit" style="color:${suitHex(su)}">${SUIT_SYM[su]}</span>${spans || '<span class="pt-void">—</span>'}</div>`;
  }).join('');
  const showingDd = ddScores.size > 0 && seat === st.turn;
  return `<div class="pt-hand${yourTurn ? ' pt-active' : ''}${showingDd ? ' pt-hand-dd' : ''}">${rows}</div>`;
}

function ptVulClass(seat) {
  const vul = _pt.row.vul || 'none';
  const nsVul = vul === 'ns' || vul === 'both';
  const ewVul = vul === 'ew' || vul === 'both';
  const isVul = (nsVul && (seat === 'N' || seat === 'S')) || (ewVul && (seat === 'E' || seat === 'W'));
  return isVul ? 'pt-seatlabel-vul' : 'pt-seatlabel-nvul';
}

function ptSeatLabelHtml(seat) {
  const playerName = _pt.row.player_names?.[seat] || _pt.player_names?.[seat];
  const displayName = playerName || SEAT_FULL[seat];
  const titleAttr = playerName ? ` title="${escHtml(playerName)}"` : '';
  return `<div class="pt-seatlabel ${ptVulClass(seat)}"${titleAttr}>${escHtml(displayName)}</div>`;
}

function ptTrickCenter() {
  const st = _pt.state, vt = _pt.viewTrick;
  const viewingPast = vt !== null;
  const atBoundary = st.trick.length === 0 && st.tricks.length > 0;
  let cards, winner;
  if (viewingPast) {
    const t = st.tricks[vt]; cards = t.cards; winner = t.winner;
  } else {
    const last = atBoundary ? st.tricks[st.tricks.length - 1] : null;
    cards = st.trick.length ? st.trick : (last ? last.cards : []);
    winner = last ? last.winner : null;
  }
  const bySeat = {}; cards.forEach(c => { bySeat[c.seat] = c; });
  const showStep = !viewingPast && ptStepping() && !_pt.locked;
  const slot = seat => {
    const c = bySeat[seat];
    if (showStep && !atBoundary && seat === st.turn && !c) {
      return `<div class="pt-slot pt-slot-${seat.toLowerCase()}"><button class="pt-stepbtn" id="ptStepBtn" title="Play ${SEAT_FULL[seat]}'s card">▶</button></div>`;
    }
    const won = winner === seat ? ' pt-won' : '';
    return `<div class="pt-slot pt-slot-${seat.toLowerCase()}${won}">${c ? `<span style="color:${suitHex(c.suit)}">${SUIT_SYM[c.suit]}${c.rank === 'T' ? '10' : c.rank}</span>` : ''}</div>`;
  };
  const label = viewingPast ? `<div class="pt-trick-hist-label">Trick ${vt + 1}</div>` : '';
  const centerAdvance = _pt.mode === 'play' && atBoundary ? ptAdvanceBtn() : '';
  return `${label}<div class="pt-trick">${slot('N')}${slot('W')}${slot('E')}${slot('S')}${centerAdvance ? `<div class="pt-trick-center-action">${centerAdvance}</div>` : ''}</div>`;
}

function ptCountsHtml() {
  // Tricks taken is an interactive Play-mode control. It is always shown in
  // Play and never shown in View, regardless of recorded-play availability.
  if (_pt.mode !== 'play') return '';
  const st = _pt.state, nsWon = _pt.P.sideOf(_pt.declarer) === 'NS';
  const declWon = nsWon ? st.nsTricks : st.ewTricks;
  const defWon  = nsWon ? st.ewTricks : st.nsTricks;
  return `<div class="pt-counts">
    <div class="pt-counts-title">Tricks taken</div>
    <div class="pt-count-row"><span>NS</span><b>${nsWon ? declWon : defWon}</b></div>
    <div class="pt-count-row"><span>EW</span><b>${nsWon ? defWon : declWon}</b></div>
  </div>`;
}

function ptAdvanceBtn() {
  const st = _pt.state;
  const atBoundary = st.trick.length === 0 && st.tricks.length > 0;
  const showStep = !_pt.viewTrick && ptStepping() && !_pt.locked;
  const hasPrev = _pt.trickCheckpoints.length > 1;
  if ((showStep && atBoundary) || _pt.awaitingAdvance || _pt.pendingComplete) {
    return `<span class="pt-view-nav">
      ${hasPrev ? `<button class="pt-stepbtn" id="ptPrevTrickInline" title="Previous trick">◀</button>` : ''}
      <button class="pt-stepbtn" id="ptStepBtn" title="${_pt.pendingComplete ? 'Switch to view mode' : 'Continue'}">▶</button>
    </span>`;
  }
  if (showStep && hasPrev) {
    return `<span class="pt-view-nav"><button class="pt-stepbtn" id="ptPrevTrickInline" title="Previous trick">◀</button></span>`;
  }
  return '';
}

function ptDdTableHtml() {
  if (!_pt.ddTableOpen) return '';
  const strains = [
    { label: '♣', index: 3, color: '#111827' },
    { label: '♦', index: 2, color: '#dc2626' },
    { label: '♥', index: 1, color: '#dc2626' },
    { label: '♠', index: 0, color: '#111827' },
    { label: 'NT', index: 4, color: '#374151' },
  ];
  const seats = [
    { label: 'N', index: 0 },
    { label: 'S', index: 2 },
    { label: 'E', index: 1 },
    { label: 'W', index: 3 },
  ];
  const header = strains.map(s => `<th style="color:${s.color}">${s.label}</th>`).join('');
  const body = _pt.ddTable
    ? seats.map(seat => `<tr><th>${seat.label}</th>${strains.map(s => `<td>${_pt.ddTable.resTable[s.index][seat.index]}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="6" class="pt-dd-table-error">${escHtml(_pt.ddTableError || 'Calculating…')}</td></tr>`;
  return `<div class="pt-dd-backdrop">
    <div class="pt-dd-dialog" role="dialog" aria-modal="true" aria-label="Double-dummy tricks">
      <div class="pt-dd-dialog-head"><strong>Double-dummy tricks</strong><button id="ptDdTableClose" aria-label="Close">×</button></div>
      <table class="pt-dd-table"><thead><tr><th></th>${header}</tr></thead><tbody>${body}</tbody></table>
    </div>
  </div>`;
}

function ptComputeResult() {
  const P = _pt.P, st = _pt.state, s = _pt.session;
  const nsDecl = P.sideOf(_pt.declarer) === 'NS';
  const declWon = nsDecl ? st.nsTricks : st.ewTricks;
  const userSide = (s && s.userSide) || ptUserSide();
  const userWon = userSide === 'NS' ? st.nsTricks : st.ewTricks;
  let solved = null;
  if (_pt.contract) {
    const target = Number(_pt.contract.level) + 6;
    const userIsDecl = userSide === P.sideOf(_pt.declarer);
    solved = userIsDecl ? userWon >= target : userWon >= (14 - target);
  }
  let detail;
  if (_pt.contract) {
    const target = Number(_pt.contract.level) + 6;
    const diff = declWon - target;
    detail = diff >= 0 ? `${_pt.row.contract} made${diff ? ' +' + diff : ''} — ${declWon} tricks`
                       : `${_pt.row.contract} down ${-diff}`;
  } else {
    detail = `Declarer took ${declWon} trick${declWon === 1 ? '' : 's'}`;
  }
  return { solved, detail, claimed: !!_pt.claimed, declarerTricks: declWon };
}

const PT_IMP_TABLE = [
  [0,10,0],[20,40,1],[50,80,2],[90,120,3],[130,160,4],[170,210,5],
  [220,260,6],[270,310,7],[320,360,8],[370,420,9],[430,490,10],
  [500,590,11],[600,740,12],[750,890,13],[900,1090,14],[1100,1290,15],
  [1300,1490,16],[1500,1740,17],[1750,1990,18],[2000,2240,19],
  [2250,2490,20],[2500,2990,21],[3000,3490,22],[3500,3990,23],[4000,Infinity,24],
];

function ptScoreToImps(swing) {
  const amount = Math.abs(swing);
  const sign = swing < 0 ? -1 : 1;
  const row = PT_IMP_TABLE.find(([, hi]) => amount <= hi);
  return sign * (row?.[2] ?? 24);
}

function ptDeclarerIsVulnerable() {
  const vul = String(_pt.row.vul || 'none').toLowerCase();
  const side = _pt.P.sideOf(_pt.declarer).toLowerCase();
  return vul === 'both' || vul === side;
}

function ptContractScore(declarerTricks) {
  if (!_pt.contract) return null;
  const level = Number(_pt.contract.level);
  const denom = _pt.contract.denom === 'N' ? 'NT' : _pt.contract.denom;
  const target = level + 6;
  const vulnerable = ptDeclarerIsVulnerable();
  const multiplier = _pt.contract.doubled === 'XX' ? 4 : _pt.contract.doubled === 'X' ? 2 : 1;

  if (declarerTricks < target) {
    const down = target - declarerTricks;
    if (multiplier === 1) return -(vulnerable ? 100 : 50) * down;
    let penalty = 0;
    if (vulnerable) penalty = 200 + Math.max(0, down - 1) * 300;
    else penalty = down === 1 ? 100 : down === 2 ? 300 : down === 3 ? 500 : 500 + (down - 3) * 300;
    return -penalty * (multiplier === 4 ? 2 : 1);
  }

  const basePerLevel = denom === 'C' || denom === 'D' ? 20 : 30;
  const undoubledTrickPoints = denom === 'NT' ? 40 + (level - 1) * 30 : level * basePerLevel;
  const contractPoints = undoubledTrickPoints * multiplier;
  const over = declarerTricks - target;
  const overPoints = multiplier === 1
    ? over * (denom === 'C' || denom === 'D' ? 20 : 30)
    : over * (vulnerable ? 200 : 100) * (multiplier === 4 ? 2 : 1);
  const gameBonus = contractPoints >= 100 ? (vulnerable ? 500 : 300) : 50;
  const slamBonus = level === 7 ? (vulnerable ? 1500 : 1000) : level === 6 ? (vulnerable ? 750 : 500) : 0;
  const insult = multiplier === 4 ? 100 : multiplier === 2 ? 50 : 0;
  return contractPoints + overPoints + gameBonus + slamBonus + insult;
}

function ptCompletionSummary() {
  const declarerTricks = _pt.result?.declarerTricks;
  const declarerScore = ptContractScore(declarerTricks);
  if (declarerScore == null) return null;
  const declarerSide = _pt.P.sideOf(_pt.declarer);
  const userSide = String(_pt.row.completion_user_side || declarerSide).toUpperCase();
  const score = userSide === declarerSide ? declarerScore : -declarerScore;
  const target = Number(_pt.contract.level) + 6;
  const diff = declarerTricks - target;
  const resultText = diff === 0 ? '=' : diff > 0 ? `+${diff}` : String(diff);
  const denom = _pt.contract.denom === 'N' ? 'NT' : (SUIT_SYM[_pt.contract.denom] || _pt.contract.denom);
  const scoring = String(_pt.row.completion_scoring || '').toUpperCase();
  const hasOtherScore = _pt.row.completion_other_score != null
    && Number.isFinite(Number(_pt.row.completion_other_score));
  const otherScore = hasOtherScore ? Number(_pt.row.completion_other_score) : null;
  const travellerScores = Array.isArray(_pt.row.completion_traveller_scores)
    ? _pt.row.completion_traveller_scores.map(Number).filter(Number.isFinite)
    : [];
  let imps = null;
  let mpPercent = null;
  if (scoring === 'IMP' && hasOtherScore) {
    // Teams: both room scores are already expressed for the user's team.
    imps = ptScoreToImps(score + otherScore);
  } else if (scoring === 'IMP' && travellerScores.length) {
    // IMP pairs: average the IMP difference against every traveller result.
    const total = travellerScores.reduce((sum, reference) => sum + ptScoreToImps(score - reference), 0);
    imps = Math.round((total / travellerScores.length) * 10) / 10;
  } else if (scoring === 'MP' && travellerScores.length) {
    const matchpoints = travellerScores.reduce((sum, reference) =>
      sum + (score > reference ? 1 : score === reference ? 0.5 : 0), 0);
    mpPercent = Math.round((1000 * matchpoints) / travellerScores.length) / 10;
  }
  return { contract: `${_pt.contract.level}${denom}${_pt.contract.doubled || ''}`, level: _pt.contract.level, denomCode: _pt.contract.denom, doubled: _pt.contract.doubled || '', declarer: _pt.declarer, resultText, score, imps, mpPercent, declarerTricks };
}

function ptCompletionResultHtml() {
  const summary = ptCompletionSummary();
  if (!summary) return escHtml(_pt.result?.detail || '');
  const denomHtml = summary.denomCode === 'N' ? 'NT' : `<span style="color:${suitHex(summary.denomCode)}">${SUIT_SYM[summary.denomCode] || escHtml(summary.denomCode)}</span>`;
  const comparison = summary.imps != null
    ? ` (IMPs = ${summary.imps > 0 ? '+' : ''}${summary.imps})`
    : summary.mpPercent != null ? ` (MP% = ${summary.mpPercent})` : '';
  return `<div>Result: ${summary.level}${denomHtml}${escHtml(summary.doubled)} ${escHtml(summary.declarer)} ${summary.resultText}</div>
    <div class="pt-complete-score">Score: ${summary.score > 0 ? '+' : ''}${summary.score}${comparison}</div>`;
}

function ptContractOnlyHtml() {
  if (_pt.mode !== 'play' || !_pt.contract || !_pt.declarer) {
    return '<div class="pt-auction-placeholder" aria-hidden="true"></div>';
  }
  const denom = _pt.contract.denom === 'N'
    ? 'NT'
    : `<span style="color:${suitHex(_pt.contract.denom)}">${SUIT_SYM[_pt.contract.denom] || escHtml(_pt.contract.denom)}</span>`;
  return `<div class="pt-contract-only"><span class="pt-contract-only-label">Contract</span>
    <span>${_pt.contract.level}${denom}${escHtml(_pt.contract.doubled || '')} by ${escHtml(_pt.declarer)}</span></div>`;
}

function ptResultPanelHtml() {
  const r = _pt.result || {};
  const cls  = r.solved === true ? 'pt-result-win' : r.solved === false ? 'pt-result-lose' : 'pt-result-neutral';
  const head = r.solved === true ? 'Success'        : r.solved === false ? 'Failure'        : 'Deal complete';
  const n = _pt.state.tricks.length;
  return `<div class="pt-result ${cls}">
    <div class="pt-result-head">${head}</div>
    <div class="pt-result-sub">${escHtml(r.detail || '')}${r.claimed ? ' (claimed)' : ''}</div>
    ${n > 0 ? `<div style="display:inline-flex;gap:6px;margin-top:6px"><button class="pt-stepbtn pt-view-nav" id="ptBrowseBtn" title="Browse tricks">◀</button></div>` : ''}
  </div>`;
}

function ptStatusText() {
  const P = _pt.P, st = _pt.state;
  if (P.isComplete(st)) {
    const lead = _pt.claimed ? 'Claimed' : 'Done';
    const nsWon = P.sideOf(_pt.declarer) === 'NS';
    const declWon = nsWon ? st.nsTricks : st.ewTricks;
    if (_pt.contract) {
      const target = Number(_pt.contract.level) + 6, diff = declWon - target;
      const verdict = diff >= 0 ? `made${diff ? ' +' + diff : ''}` : `down ${-diff}`;
      return `${lead} — ${SEAT_FULL[_pt.declarer]} took ${declWon} trick${declWon === 1 ? '' : 's'} in ${_pt.row.contract}: <b>${verdict}</b>.`;
    }
    return `${lead} — declarer took ${declWon} tricks.`;
  }
  if (ptStepping()) return '';
  if (_pt.viewTrick !== null) return `Trick ${_pt.viewTrick + 1} of ${_pt.state.tricks.length}.`;
  if (_pt.awaitingAdvance) return '';
  // Keep solver turns silent. Rendering a temporary status row changes the
  // player's height and makes the surrounding board jump while DDS responds.
  if (_pt.locked) return '';
  return '';
}

function ptClaimPanelHtml() {
  const remaining = ptTricksRemaining();
  const err = _pt.claimError ? `<div class="pt-claim-err">${escHtml(_pt.claimError)}</div>` : '';
  if (ptUserSide() !== _pt.P.sideOf(_pt.declarer)) {
    return `<div class="pt-claimpanel">
      <div>Concede all ${remaining} remaining trick${remaining === 1 ? '' : 's'} to declarer?</div>
      <div class="pt-claimrow"><button class="pt-claim-go" id="ptConcedeGo">Concede</button>
      <button class="pt-claim-cancel" id="ptClaimCancel">Cancel</button></div>${err}</div>`;
  }
  const max = _pt.claimMax == null ? 0 : _pt.claimMax;
  const min = _pt.claimMin == null ? max : _pt.claimMin;
  const hintLine = min < max
    ? `<div>Best play: <b>${max}</b> more tricks. But you could misplay — only <b>${min}</b> guaranteed.</div>`
    : `<div>All lines guarantee <b>${max}</b> more tricks — you can't go wrong.</div>`;
  return `<div class="pt-claimpanel">
    <div class="pt-claimrow">Claim
      <input id="ptClaimInput" type="number" min="0" max="${remaining}" value="${min}" />
      of ${remaining} remaining trick${remaining === 1 ? '' : 's'}.</div>
    ${hintLine}
    <div class="pt-claimrow"><button class="pt-claim-go" id="ptClaimGo">Claim</button>
    <button class="pt-claim-cancel" id="ptClaimCancel">Cancel</button></div>${err}</div>`;
}

function ptPlayCornerHtml(canUndo) {
  return `<div class="pt-play-corner">
    ${_ptHideAlertButton ? '' : `<button class="pt-alert${_ptAlertOn ? ' pt-alert-on' : ''}" id="ptAlertBtn"
      title="${_ptAlertOn ? 'Alerts on — click to silence' : 'Alerts off — click to enable'}">Alert: ${_ptAlertOn ? 'on' : 'off'}</button>`}
    <div class="pt-play-corner-row">
      <button class="pt-histbtn pt-undobtn" id="ptUndoBtn" ${canUndo ? '' : 'disabled'} title="Undo your last card">⎌ Undo</button>
    </div>
  </div>`;
}

function ptRender() {
  if (!_pt) return;
  ensurePlayTableStyle();
  const root = _pt.root, st = _pt.state;
  const firstTrickCollected = st && st.tricks.length >= 1 && (st.trick.length >= 1 || _pt.P.isComplete(st));
  if (_pt.userActed || firstTrickCollected) _pt.retryArmed = true;

  if (_pt.P.isComplete(st)) {
    if (!_pt.result) _pt.result = ptComputeResult();
    if (_pt.mode === 'play') _pt.reviewAvailable = true;
  }

  if (_pt.claiming) {
    if (_ptNavEl) _ptNavEl.innerHTML = '';
    root.innerHTML = ptClaimPanelHtml();
    root.querySelector('#ptClaimGo')?.addEventListener('click', () => {
      ptDeclarerClaim(root.querySelector('#ptClaimInput')?.value ?? 0);
    });
    root.querySelector('#ptConcedeGo')?.addEventListener('click', ptConcedeAll);
    root.querySelector('#ptClaimCancel')?.addEventListener('click', ptClaimCancel);
    return;
  }

  const canUndo  = _pt.history.length > 0 && !ptStepping();
  if (_ptNavEl) _ptNavEl.innerHTML = '';

  const complete = _pt.P.isComplete(st);
  const statusTxt = complete ? '' : ptStatusText();
  const showTopbar = !!statusTxt;
  const ddScores = ptDdCardScores();
  const hasAuction = !_ptBiddingHtml.includes('pt-auction-placeholder');
  const biddingContent = hasAuction ? _ptBiddingHtml : ptContractOnlyHtml();
  root.innerHTML = `
    ${showTopbar ? `<div class="pt-topbar">
      <span class="pt-status">${statusTxt}</span>
    </div>` : ''}
    ${_pt.warn ? `<div class="pt-warn">${escHtml(_pt.warn)}</div>` : ''}
    <div class="pt-deal${hasAuction ? '' : ' pt-deal-noauction'}" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));width:100%;max-width:478px;box-sizing:border-box;">
      <div class="pt-pos-tl${hasAuction ? '' : ' pt-pos-tl-noauction'}">
        ${biddingContent}
      </div>
      <div class="pt-pos-n">${ptSeatLabelHtml('N')}${ptRenderHand('N', ddScores)}</div>
      <div class="pt-pos-tr">${_pt.mode === 'play'
        ? (complete ? '' : ptPlayCornerHtml(canUndo))
        : ptAdvanceBtn()}</div>
      <div class="pt-pos-w">${ptSeatLabelHtml('W')}${ptRenderHand('W', ddScores)}</div>
      <div class="pt-pos-c">${ptTrickCenter()}</div>
      <div class="pt-pos-e">${ptSeatLabelHtml('E')}${ptRenderHand('E', ddScores)}</div>
      <div class="pt-pos-s">${ptSeatLabelHtml('S')}${ptRenderHand('S', ddScores)}</div>
      <div class="pt-pos-bl">
        ${complete ? `<div class="pt-complete-result">${ptCompletionResultHtml()}</div>` : ''}
        ${_ptHideDdButton && !_pt.reviewAvailable ? '' : `<button class="pt-dd-toggle${_ptDdOn || _pt.ddTableOpen ? ' pt-dd-on' : ''}" id="ptDdToggle" title="${_pt.reviewAvailable || (Array.isArray(_pt.row.play) && _pt.row.play.length >= 2) ? 'Show double-dummy future tricks for every legal card' : 'Show double-dummy tricks table'}">DD</button>`}
      </div>
      <div class="pt-pos-br">${ptCountsHtml()}${ptDdTableHtml()}</div>
    </div>`;

  if (_ptBottomLeftEl) {
    const bl = root.querySelector('.pt-pos-bl');
    if (bl) bl.appendChild(_ptBottomLeftEl);
  }

  root.querySelectorAll('.pt-card').forEach(el => {
    el.addEventListener('click', () => ptOnCardClick(el.dataset.seat, el.dataset.suit, el.dataset.rank));
  });
  root.querySelector('#ptStepBtn')?.addEventListener('click', ptProceed);
  root.querySelector('#ptPrevTrickInline')?.addEventListener('click', ptUndoTrick);
  root.querySelector('#ptDdToggle')?.addEventListener('click', ptToggleDd);
  root.querySelector('#ptDdTableClose')?.addEventListener('click', ptCloseDdTable);
  root.querySelector('#ptAlertBtn')?.addEventListener('click', ptToggleAlert);
  root.querySelector('#ptUndoBtn')?.addEventListener('click', ptUndo);

  // Nav controls may be in external navEl or inline in root
  const navRoot = _ptNavEl || root;
  navRoot.querySelector('#ptClaimBtn')?.addEventListener('click', ptClaimOpen);
  navRoot.querySelector('#ptAlertBtn')?.addEventListener('click', ptToggleAlert);
  navRoot.querySelector('#ptPrevTrick')?.addEventListener('click', ptPrevTrick);
  navRoot.querySelector('#ptNextTrick')?.addEventListener('click', ptNextTrick);
  navRoot.querySelector('#ptUndoBtn')?.addEventListener('click', ptUndo);
}

// ── CSS (self-contained, injected once) ───────────────────────────────────────

function ensurePlayTableStyle() {
  let s = document.getElementById('pt-play-table-style');
  if (!s) {
    s = document.createElement('style');
    s.id = 'pt-play-table-style';
    document.head.appendChild(s);
  }
  s.textContent = `
    .pt-mount{position:relative;}
    .pt-deal{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));max-width:478px;width:100%;grid-template-rows:auto auto auto;
      column-gap:14px;row-gap:5px;align-items:center;justify-items:center;
      font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;}
    .pt-pos-tl{grid-column:1;grid-row:1;align-self:start;justify-self:start;
      display:flex;flex-direction:column;align-items:flex-start;}
    .pt-pos-n{grid-column:2;grid-row:1;align-self:start;transform:translateX(20px);} .pt-pos-w{grid-column:1;grid-row:2;justify-self:start;}
    .pt-pos-c{grid-column:2;grid-row:2;} .pt-pos-e{grid-column:3;grid-row:2;justify-self:end;} .pt-pos-s{grid-column:2;grid-row:3;transform:translateX(20px);}
    .pt-pos-bl{grid-column:1;grid-row:3;align-self:end;justify-self:start;width:auto;position:relative;
      display:flex;gap:6px;justify-content:flex-start;}
    .pt-complete-result{position:absolute;left:0;bottom:40px;box-sizing:border-box;width:max-content;min-width:108px;
      padding:4px 8px;border:1px solid #e5e7eb;border-radius:5px;background:#fff;color:#1f2937;
      font-family:ui-sans-serif,system-ui;font-size:0.82rem;font-weight:700;white-space:nowrap;}
    .pt-complete-score{margin-top:2px;font-weight:600;}
    .pt-pos-tr{grid-column:3;grid-row:1;align-self:start;justify-self:center;min-width:150px;padding-top:calc(6px + var(--ips-top-right-offset, 0px));}
    .pt-pos-br{grid-column:3;grid-row:3;align-self:end;justify-self:end;position:relative;
      width:150px;display:flex;justify-content:flex-end;font-family:ui-sans-serif,system-ui;}
    .pt-auction-placeholder{width:108px;height:76px;}
    .pt-contract-only{box-sizing:border-box;min-width:108px;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;
      background:#fff;color:#111;font-family:ui-sans-serif,system-ui;font-size:0.82rem;font-weight:700;
      display:flex;flex-direction:column;gap:2px;white-space:nowrap;}
    .pt-contract-only-label{color:#6b7280;font-size:0.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.03em;}
    .pt-deal-noauction .pt-pos-tl{transform:none;align-self:stretch;}
    .pt-deal-noauction .pt-pos-w{justify-self:start;}
    .pt-pos-tl-noauction{position:relative;box-sizing:border-box;}
    .pt-pos-tl-noauction .pt-auction-placeholder{position:absolute;inset:0;}
    .pt-seatlabel{font-family:ui-sans-serif,system-ui;font-size:0.8rem;font-weight:600;text-align:center;margin-bottom:3px;padding:3px 8px;border-radius:4px;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;box-sizing:border-box;}
    .pt-seatlabel-vul{background:#e00000!important;}
    .pt-seatlabel-nvul{background:#15803d!important;}
    .pt-role{color:rgba(255,255,255,0.75);font-weight:400;}
    .pt-hand{padding:4px 8px;border:1px solid #e5e7eb;border-radius:8px;background:#fff;min-width:108px;}
    .pt-hand.pt-active{border-color:#2563eb;box-shadow:0 0 0 2px rgba(37,99,235,0.15);}
    .pt-row{white-space:nowrap;line-height:1.5;font-size:1.08rem;}
    .pt-suit{display:inline-block;width:1.1em;}
    .pt-void{color:#d1d5db;}
    .pt-card{display:inline-block;padding:0 2px;border-radius:3px;}
    .pt-card.pt-playable{cursor:pointer;background:#eff6ff;outline:1px solid #bfdbfe;}
    .pt-card.pt-playable:hover{background:#dbeafe;}
    .pt-card.pt-bad{background:#fee2e2;outline:1px solid #fca5a5;}
    .pt-card-dd{position:relative;display:inline-block;margin-right:0;}
    .pt-dd-badge{position:absolute;right:-4px;bottom:0;display:flex;align-items:center;justify-content:center;
      width:10px;height:9px;padding:0;border:0;border-radius:1px;color:#fff;font-family:ui-sans-serif,system-ui;
      font-size:0.45rem;font-weight:900;line-height:1;box-shadow:none;text-shadow:none;z-index:1;}
    .pt-dd-best{background:#15803d;color:#fff;}
    .pt-dd-loss{background:#dc2626;color:#fff;}
    .pt-dd-toggle{box-sizing:border-box;width:54px;height:28px;border:0!important;background:#16a34a!important;color:#fff!important;
      border-radius:4px!important;padding:0 10px!important;font-family:ui-sans-serif,system-ui;font-size:0.8rem!important;
      font-weight:700;line-height:28px!important;cursor:pointer;box-shadow:none!important;}
    .pt-dd-toggle:hover{background:#15803d!important;}
    .pt-dd-toggle.pt-dd-on{background:#15803d!important;color:#fff!important;box-shadow:none!important;}
    .pt-dd-backdrop{position:absolute;right:0;bottom:0;z-index:20;font-family:ui-sans-serif,system-ui;}
    .pt-dd-dialog{width:142px;box-sizing:border-box;padding:6px;background:#fff;border:1px solid #cbd5e1;border-radius:8px;
      box-shadow:0 12px 30px rgba(15,23,42,0.24);}
    .pt-dd-dialog-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:3px;color:#334155;font-size:0.64rem;}
    .pt-dd-dialog-head button{border:0;background:transparent;color:#64748b;font-size:0.95rem;line-height:1;cursor:pointer;padding:0 1px;}
    .pt-dd-table{width:100%;border-collapse:collapse;text-align:center;font-size:0.64rem;color:#334155;}
    .pt-dd-table th,.pt-dd-table td{padding:2px 3px;border:1px solid #dbe3ee;line-height:1.2;}
    .pt-dd-table thead th,.pt-dd-table tbody th{background:#f8fafc;font-weight:800;}
    .pt-dd-table td{font-weight:700;color:#0f172a;}
    .pt-dd-table-error{padding:14px!important;color:#dc2626!important;font-weight:600!important;}
    .pt-warn{margin:6px 0;padding:6px 10px;border-radius:6px;background:#fef2f2;border:1px solid #fca5a5;
      color:#dc2626;font-family:ui-sans-serif,system-ui;font-size:0.82rem;font-weight:600;}
    .pt-hidden{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;
      min-width:96px;min-height:96px;border:1px dashed #d1d5db;border-radius:8px;color:#9ca3af;background:#f9fafb;}
    .pt-back{font-size:2rem;line-height:1;color:#9ca3af;}
    .pt-trick{position:relative;width:150px;height:150px;}
    .pt-slot{position:absolute;font-size:1.1rem;font-weight:600;}
    .pt-slot-n{top:0;left:50%;transform:translateX(-50%);}
    .pt-slot-s{bottom:0;left:50%;transform:translateX(-50%);}
    .pt-slot-w{left:0;top:50%;transform:translateY(-50%);}
    .pt-slot-e{right:0;top:50%;transform:translateY(-50%);}
    .pt-slot.pt-won{background:#fef3c7;border-radius:4px;padding:0 3px;}
    .pt-stepbtn{border:1px solid #2563eb;background:#2563eb;color:#fff;border-radius:999px;
      width:30px;height:30px;font-size:0.95rem;line-height:1;cursor:pointer;padding:0;
      display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(37,99,235,0.4);}
    .pt-stepbtn:hover{background:#1d4ed8;}
    .pt-stepbtn-center{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);}
    .pt-trick-hist-label{text-align:center;font-family:ui-sans-serif,system-ui;font-size:0.75rem;color:#6b7280;margin-bottom:2px;}
    .pt-counts{width:100px;max-width:100%;box-sizing:border-box;font-family:ui-sans-serif,system-ui;color:#64748b;
      border:1px solid #dbe3ee;border-radius:10px;padding:7px 11px 7px 9px;background:linear-gradient(180deg,#fff,#f8fafc);
      box-shadow:0 2px 7px rgba(15,23,42,0.08);white-space:nowrap;}
    .pt-counts-title{padding-bottom:5px;margin-bottom:4px;border-bottom:1px solid #e5eaf1;text-align:center;
      font-size:0.64rem;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#94a3b8;}
    .pt-count-row{display:flex;align-items:center;justify-content:space-between;gap:18px;font-size:0.75rem;line-height:1.55;}
    .pt-count-row b{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;
      border-radius:6px;background:#e8eef8;color:#172033;font-size:0.82rem;}
    .pt-result{display:flex;flex-direction:column;align-items:center;gap:8px;width:100%;max-width:440px;
      box-sizing:border-box;border-radius:10px;padding:22px 18px;font-family:ui-sans-serif,system-ui;text-align:center;}
    .pt-result-win{border:1px solid #a7f3d0;background:#f0fdf4;}
    .pt-result-lose{border:1px solid #fecaca;background:#fef2f2;}
    .pt-result-neutral{border:1px solid #e5e7eb;background:#f9fafb;}
    .pt-result-head{font-size:1.35rem;font-weight:700;}
    .pt-result-win .pt-result-head{color:#047857;}
    .pt-result-lose .pt-result-head{color:#dc2626;}
    .pt-result-neutral .pt-result-head{color:#374151;}
    .pt-result-sub{font-size:0.92rem;color:#374151;}
    .pt-replay{margin-top:4px;background:#fff;border:1px solid #2563eb;color:#2563eb;border-radius:6px;
      padding:6px 18px;font-size:0.85rem;font-weight:600;cursor:pointer;font-family:ui-sans-serif,system-ui;}
    .pt-replay:hover{background:#eff6ff;}
    .pt-mount{display:flex;flex-direction:column;align-items:center;gap:8px;margin:6px 0 12px;}
    .pt-topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;max-width:440px;min-height:30px;}
    .pt-status{font-size:0.86rem;color:#1d4ed8;font-family:ui-sans-serif,system-ui;}
    .pt-claim{background:#fff;border:1px solid #059669;color:#059669;border-radius:6px;padding:4px 14px;
      flex-shrink:0;font-size:0.82rem;font-weight:600;cursor:pointer;font-family:ui-sans-serif,system-ui;}
    .pt-claim:hover{background:#ecfdf5;}
    .pt-alert{background:#fff;border:1px solid #9ca3af;color:#6b7280;border-radius:6px;padding:4px 14px;
      flex-shrink:0;font-size:0.82rem;font-weight:600;cursor:pointer;font-family:ui-sans-serif,system-ui;}
    .pt-alert:hover{background:#f3f4f6;}
    .pt-alert.pt-alert-on{border-color:#d97706;color:#d97706;}
    .pt-alert.pt-alert-on:hover{background:#fffbeb;}
    .pt-play-corner{display:flex;flex-direction:column;align-items:center;gap:5px;margin-top:0;}
    .pt-play-corner>.pt-alert{min-width:104px;padding:4px 10px;}
    .pt-play-corner-row{display:flex;align-items:center;justify-content:center;gap:5px;}
    .pt-play-corner-row .pt-histbtn{padding:3px 7px;font-size:0.72rem;line-height:1.4;}
    .pt-view-nav{display:inline-flex;gap:4px;margin-top:4px;}
    .pt-trick-center-action{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2;}
    .pt-trick-center-action .pt-view-nav{margin-top:0;}
    .pt-histbtn{font-size:0.82rem;font-weight:600;padding:3px 8px;border:1px solid #d1d5db;border-radius:5px;
      background:#f9fafb;cursor:pointer;font-family:ui-sans-serif,system-ui;line-height:1.4;}
    .pt-histbtn:hover:not(:disabled){background:#f3f4f6;}
    .pt-histbtn:disabled{opacity:0.3;cursor:default;}
    .pt-loading{padding:2rem;color:#6b7280;font-family:ui-sans-serif,system-ui;font-size:0.9rem;text-align:center;}
    .pt-claimpanel{font-family:ui-sans-serif,system-ui;font-size:0.88rem;padding:12px;border:1px solid #e5e7eb;
      border-radius:8px;background:#fff;display:flex;flex-direction:column;gap:8px;max-width:340px;}
    .pt-claimrow{display:flex;align-items:center;gap:8px;}
    .pt-claim-go{background:#2563eb;color:#fff;border:none;border-radius:6px;padding:5px 14px;
      font-size:0.82rem;font-weight:600;cursor:pointer;}
    .pt-claim-go:hover{background:#1d4ed8;}
    .pt-claim-cancel{background:#fff;border:1px solid #d1d5db;color:#374151;border-radius:6px;
      padding:5px 14px;font-size:0.82rem;cursor:pointer;}
    .pt-claim-cancel:hover{background:#f3f4f6;}
    .pt-claim-err{color:#dc2626;font-size:0.8rem;}
    #ptClaimInput{width:60px;padding:3px 6px;border:1px solid #d1d5db;border-radius:4px;font-size:0.88rem;}
    @media (max-width:499px){
      .pt-mount{align-items:stretch;}
      .pt-deal{column-gap:6px;}
      .pt-pos-c{justify-self:stretch;}
      .pt-pos-n{transform:none;}
      .pt-pos-s{transform:none;}
      .pt-pos-tr{min-width:0;}
      .pt-pos-br{width:auto;}
      .pt-pos-bl{width:auto;flex-direction:column;align-items:flex-start;}
      .pt-trick{width:100%;height:auto;aspect-ratio:1;}
      .pt-hand{min-width:0;width:100%;box-sizing:border-box;}
      .pt-row{font-size:0.85rem;white-space:normal;}
      .pt-seatlabel{font-size:0.7rem;padding:2px 4px;margin-bottom:1px;}
      .pt-play-corner>.pt-alert{min-width:0;}
      .pt-complete-result{position:static;margin-top:4px;box-sizing:border-box;white-space:normal;}
    }
  `;
}

// ── Public API ────────────────────────────────────────────────────────────────

function mountIpsPlayer(container, options) {
  const { row, ddsPath, format, cardingNS, cardingEW, onComplete, deferComplete, navEl, mode, biddingHtml, hideDdButton, ddOn, hideAlertButton, bottomLeftEl } = options;

  _ptOnComplete    = onComplete || null;
  _ptDeferComplete = !!deferComplete;
  _ptFormat      = format || null;
  _ptDdsPath     = ddsPath;
  _ptNavEl       = navEl || null;
  _ptBottomLeftEl = bottomLeftEl || null;
  _ptBiddingHtml = biddingHtml || '';
  _ptDdOn            = !!ddOn;
  _ptHideDdButton    = !!hideDdButton;
  _ptHideAlertButton = !!hideAlertButton;

  // Apply carding to IPS engine
  const carding = { NS: cardingNS || 'UDCA', EW: cardingEW || 'UDCA' };
  if (typeof globalThis.bpCardingPreferences !== 'undefined') globalThis.bpCardingPreferences = carding;
  globalThis.bpIps?.setCardingAgreements?.(carding);

  ensurePlayTableStyle();

  // Mount into the container
  const root = document.createElement('div');
  root.className = 'pt-mount';
  container.innerHTML = '';
  container.appendChild(root);

  _pt = { root, row: { ...row }, P: globalThis.bpPlay, session: ptFreshSession(), mode: mode || 'play' };
  root.innerHTML = '<div class="pt-loading">Loading solver…</div>';

  ensureDds()
    .then(() => {
      if (!_pt || _pt.root !== root) return;
      try {
        ptStart();
      } catch (err) {
        if (_pt && _pt.root === root)
          root.innerHTML = `<div class="pt-loading" style="color:#dc2626">Could not display this deal — ${escHtml(String(err?.message || err))}</div>`;
      }
    })
    .catch(err => {
      if (_pt && _pt.root === root)
        root.innerHTML = `<div class="pt-loading" style="color:#dc2626">Could not load the double-dummy solver — ${escHtml(String(err?.message || err))}</div>`;
    });

  return {
    toggleDd() {
      if (_pt && _pt.root === root) ptToggleDd();
    },
    unmount() {
      if (_pt && _pt.root === root) {
        _ptGen++; // abort any running program loop
        _pt = null;
        root.remove();
        if (_ptNavEl) { _ptNavEl.innerHTML = ''; _ptNavEl = null; }
      }
    },
    finalizeIfInteracted() {
      if (_pt && _pt.root === root && _pt.session?.interacted && !_pt.session?.recorded) {
        ptCommitAttempt(true);
      }
    },
  };
}

return { mountIpsPlayer };
}

const defaultRuntime = createIpsPlayerRuntime();
export const mountIpsPlayer = defaultRuntime.mountIpsPlayer;
