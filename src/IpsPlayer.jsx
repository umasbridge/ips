import { useEffect, useRef, useState, useMemo } from 'react';
import { createIpsPlayerRuntime } from './ips-module.js';

const SCRIPT_ORDER = [
  '/bridge-problems/lin.js',
  '/bridge-problems/play.js',
  '/bridge-lib/ips/ips.js',
];
const DDS_PATH = '/bridge-problems/dds/dds-api.js';

const CALL_MAP = { P: 'P', PASS: 'P', D: 'X', X: 'X', DBL: 'X', R: 'XX', XX: 'XX', RDBL: 'XX' };

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload  = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

let _scriptsReady = null;
function ensureScripts() {
  if (!_scriptsReady) {
    _scriptsReady = SCRIPT_ORDER.reduce(
      (p, src) => p.then(() => loadScript(src)),
      Promise.resolve()
    );
  }
  return _scriptsReady;
}

function normalizedVulnerability(value, fallback = 'none') {
  if (value == null || value === '') return fallback;
  const v = String(value).trim().toLowerCase().replace(/[^a-z]/g, '');
  if (v === 'n' || v === 'ns' || v === 'northsouth') return 'ns';
  if (v === 'e' || v === 'ew' || v === 'eastwest') return 'ew';
  if (v === 'b' || v === 'both' || v === 'all') return 'both';
  return 'none';
}

function normalizedPlayerName(value) {
  const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2 && parts.at(-1).toLowerCase() === parts.at(-2).toLowerCase()) parts.pop();
  if (parts.length < 2) return parts[0] || '';
  const initials = parts.slice(0, -1).map(part => part[0].toUpperCase()).join(' ');
  const abbreviated = `${initials} ${parts.at(-1)}`;
  return abbreviated.length > 16 ? `${abbreviated.slice(0, 15).trimEnd()}…` : abbreviated;
}

const PARTNER_SEAT = { N: 'S', S: 'N', E: 'W', W: 'E' };

function playHandAccess(direction, declarer) {
  const selectedSeat = String(direction || '').toUpperCase();
  const declarerSeat = String(declarer || '').toUpperCase();
  if (!PARTNER_SEAT[selectedSeat]) return { visible: [], controlled: null };

  // Declarer plays both their own hand and dummy. Keep only declarer's hand
  // visible initially; the engine reveals dummy after the opening lead.
  if (declarerSeat === selectedSeat || declarerSeat === PARTNER_SEAT[selectedSeat]) {
    return {
      visible: [declarerSeat],
      controlled: [declarerSeat, PARTNER_SEAT[declarerSeat]],
    };
  }

  return { visible: [selectedSeat], controlled: null };
}

function buildRow(boardResult, direction, isView, ddPlay, lin, linData) {
  const contract = boardResult.contract_level && boardResult.contract_denom
    ? `${boardResult.contract_level}${boardResult.contract_denom}${boardResult.contract_x || ''}`
    : undefined;
  const knownLead = boardResult.lead || (boardResult.lead_suit && boardResult.lead_rank
    ? `${boardResult.lead_suit}${String(boardResult.lead_rank).replace('10', 'T')}`
    : undefined);
  const hasRecordedPlay = linData.play.length >= 2;
  const handAccess = playHandAccess(direction, boardResult.declarer);
  return {
    lin,
    play: isView
      ? (hasRecordedPlay ? linData.play : (knownLead ? [knownLead] : []))
      : (knownLead ? [knownLead] : []),
    play_available: hasRecordedPlay,
    problem_visible_hands: (isView || ddPlay) ? ['N', 'S', 'E', 'W'] : handAccess.visible,
    problem_user_hands: (isView || ddPlay) ? undefined : handAccess.controlled,
    contract,
    declarer: boardResult.declarer,
    lead: knownLead,
    completion_user_side: boardResult.completion_user_side,
    completion_other_score: boardResult.completion_other_score,
    completion_scoring: boardResult.completion_scoring,
    completion_traveller_scores: boardResult.completion_traveller_scores,
    completed_result: boardResult.completed_result,
    dealer: boardResult.dealer,
    vul: normalizedVulnerability(boardResult.vulnerability, linData.vul),
    player_names: {
      N: normalizedPlayerName(boardResult.player_n_name),
      S: normalizedPlayerName(boardResult.player_s_name),
      E: normalizedPlayerName(boardResult.player_e_name),
      W: normalizedPlayerName(boardResult.player_w_name),
    },
  };
}

// ── Bidding HTML (vanilla string, injected into pt-pos-tl slot) ───────────────

function normalizeCall(s) {
  const u = (s || '').trim().toUpperCase();
  if (CALL_MAP[u]) return CALL_MAP[u];
  const m = u.match(/^([1-7])(NT?|[CDHS])$/);
  return m ? m[1] + m[2] : null;
}

function parseLinMetadata(lin) {
  if (!lin) return { play: [], bids: null, dealerNumber: 3, vul: 'none' };
  const tags = lin.split('|');
  const play = [];
  const bids = [];
  let hasMb = false;
  let dealerNumber = 3;
  let vul = 'none';
  for (let i = 0; i < tags.length; i++) {
    const tag = String(tags[i] || '').trim().toLowerCase();
    if (tag === 'pc' && i + 1 < tags.length && tags[i + 1]) play.push(tags[i + 1]);
    if (tag === 'md' && i + 1 < tags.length) {
      const parsed = parseInt(tags[i + 1][0]);
      if (parsed >= 1 && parsed <= 4) dealerNumber = parsed;
    }
    if (tag === 'sv' && i + 1 < tags.length) {
      const value = tags[i + 1].toLowerCase();
      vul = value === 'n' ? 'ns' : value === 'e' ? 'ew' : value === 'b' ? 'both' : 'none';
    }
    if (tag === 'mb' && i + 1 < tags.length) {
      hasMb = true;
      const raw = tags[i + 1];
      if (!raw) continue;
      const isAlert = raw.endsWith('!');
      const bidStr = isAlert ? raw.slice(0, -1) : raw;
      let explanation = null;
      if (i + 2 < tags.length && String(tags[i + 2] || '').trim().toLowerCase() === 'an' && i + 3 < tags.length) {
        explanation = tags[i + 3].trim() || null;
      }
      const call = normalizeCall(bidStr);
      if (call) bids.push({ bid: call, alert: isAlert || !!explanation, explanation });
    }
  }
  if (play.length >= 2 && play[0] === play[1]) play.shift();
  return { play, bids: hasMb && bids.length ? bids : null, dealerNumber, vul };
}

function formatBidHtml(entry) {
  const bid = typeof entry === 'string' ? entry : entry.bid;
  if (!bid) return '';
  if (bid === 'P') return `<span style="color:#15803d">P</span>`;
  if (bid === 'X') return `<span style="color:#dc2626;font-weight:700">X</span>`;
  if (bid === 'XX') return `<span style="color:#2563eb;font-weight:700">XX</span>`;
  const level = bid[0];
  const ds = bid.substring(1);
  const symMap = { C: '♣', D: '♦', H: '♥', S: '♠', NT: 'NT', N: 'NT' };
  const clrMap = { C: '#2e7d32', D: '#c62828', H: '#c62828', S: '#000', NT: '#333', N: '#333' };
  return `${level}<span style="color:${clrMap[ds] || '#333'};font-weight:700">${symMap[ds] || ds}</span>`;
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildAuctionHtml(boardResult, linData) {
  const bids = linData.bids;

  let tableHtml = '';
  if (bids) {
    const dirs = ['W', 'N', 'E', 'S'];
    const vulnerability = normalizedVulnerability(boardResult.vulnerability, linData.vul);
    const isVulnerable = dir => vulnerability === 'both'
      || (vulnerability === 'ns' && (dir === 'N' || dir === 'S'))
      || (vulnerability === 'ew' && (dir === 'E' || dir === 'W'));
    const startDir = ['S', 'W', 'N', 'E'][linData.dealerNumber - 1] || 'N';
    const startIdx = dirs.indexOf(startDir);

    const rows = [];
    let currentRow = new Array(4).fill(null);
    for (let i = 0; i < startIdx; i++) currentRow[i] = '';
    let col = startIdx;
    for (const bid of bids) {
      currentRow[col] = bid;
      col++;
      if (col >= 4) { rows.push(currentRow); currentRow = new Array(4).fill(null); col = 0; }
    }
    if (currentRow.some(c => c !== null)) rows.push(currentRow);

    const headers = dirs.map(d => {
      const background = isVulnerable(d) ? '#e00000' : '#15803d';
      return `<th style="padding:3px 7px;text-align:center;font-weight:700;color:#fff;background:${background};font-size:0.75rem">${d}</th>`;
    }).join('');
    const bodyRows = rows.map(row => {
      const cells = row.map(cell => {
        if (cell === null) return '<td></td>';
        const bg = cell && cell.alert ? 'background:#dbeafe;' : '';
        const explanation = cell && typeof cell === 'object' ? cell.explanation : null;
        const tooltip = explanation
          ? ` title="${escapeHtmlAttribute(explanation)}" aria-label="${escapeHtmlAttribute(`${cell.bid}: ${explanation}`)}"`
          : '';
        const cursor = explanation ? 'cursor:help;' : '';
        return `<td${tooltip} style="padding:2px 7px;text-align:center;${bg}${cursor}">${cell === '' ? '' : formatBidHtml(cell)}</td>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    }).join('');

    tableHtml = `<div style="display:inline-block;margin-bottom:5px;border:1px solid #d1d5db;border-radius:6px;overflow:hidden;font-family:ui-sans-serif,system-ui;"><table style="border-collapse:collapse;font-size:0.8rem"><thead><tr style="border-bottom:1px solid #d1d5db">${headers}</tr></thead><tbody>${bodyRows}</tbody></table></div>`;
  }

  return tableHtml || '<div class="pt-auction-placeholder" aria-hidden="true"></div>';
}

// ── IpsPlayer ─────────────────────────────────────────────────────────────────

// Props:
//   boardResult  — a bg_board_results row (required)
//   mode         — 'play' (default) | 'view'
//   direction    — seat string e.g. 'S', required when mode='play'
//   cardingNS, cardingEW, format, onComplete, autoStart
export default function IpsPlayer({ boardResult, mode, direction = 'S', cardingNS = 'UDCA', cardingEW = 'UDCA', format, onComplete, autoStart, topRightOffset = 0, hideDdButton = false, ddPlay = false, onPlayerReady }) {
  const containerRef = useRef(null);
  const playerRef    = useRef(null);
  const runtimeRef   = useRef(null);
  if (!runtimeRef.current) runtimeRef.current = createIpsPlayerRuntime();
  const [started, setStarted] = useState(false);
  const [error, setError]     = useState(null);

  const resolvedMode = mode || (direction ? 'play' : 'view');
  const isView = resolvedMode === 'view';

  const prepared = useMemo(() => {
    const lin = boardResult?.lin
      ?.replace(/mb\|ap\|/gi, 'mb|p|mb|p|mb|p|')
      .replace(/mb\|P\|/g, 'mb|p|') || '';
    const linData = parseLinMetadata(lin);
    return {
      row: buildRow(boardResult, direction, isView, ddPlay, lin || undefined, linData),
      auctionHtml: buildAuctionHtml(boardResult, linData),
    };
  }, [boardResult, direction, isView, ddPlay]);
  const { row, auctionHtml } = prepared;

  useEffect(() => {
    setStarted(false);
    return () => {
      playerRef.current?.unmount();
      playerRef.current = null;
    };
  }, [row]);

  useEffect(() => {
    if ((autoStart || isView) && !started) handleStart();
  }, [autoStart, isView, started, row]);

  const handleStart = () => {
    setStarted(true);
    setError(null);
    ensureScripts()
      .then(() => {
        if (!containerRef.current) return;
        playerRef.current?.unmount();
        playerRef.current = runtimeRef.current.mountIpsPlayer(containerRef.current, {
          row,
          mode: resolvedMode,
          ddsPath: DDS_PATH,
          format: format || null,
          cardingNS: cardingNS || 'UDCA',
          cardingEW: cardingEW || 'UDCA',
          onComplete,
          deferComplete: !!onComplete && !ddPlay,
          biddingHtml: auctionHtml,
          hideDdButton: hideDdButton || ddPlay,
          ddOn: ddPlay || undefined,
          hideAlertButton: ddPlay || undefined,
        });
        onPlayerReady?.(playerRef.current);
      })
      .catch(err => setError(String(err?.message || err)));
  };

  if (!boardResult?.lin) return null;

  if (error) {
    return (
      <div style={{ color: '#dc2626', fontSize: '0.85rem', padding: '0.5rem 0' }}>
        Could not load IPS player: {error}
      </div>
    );
  }

  return (
    <div style={{ '--ips-top-right-offset': `${topRightOffset}px`, width: '478px', maxWidth: '100%' }}>
      {!started && !isView && !autoStart && (
        <button onClick={handleStart}
          style={{ padding: '8px 24px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, fontSize: '0.95rem', fontWeight: 600, cursor: 'pointer' }}>
          ▶ Play as {direction}
        </button>
      )}
      <div ref={containerRef} style={{ minHeight: 200 }} />
    </div>
  );
}
