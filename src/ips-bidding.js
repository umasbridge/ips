const CALL_MAP = { P: 'P', PASS: 'P', D: 'X', X: 'X', DBL: 'X', R: 'XX', XX: 'XX', RDBL: 'XX' };

export function normalizedVulnerability(value, fallback = 'none') {
  if (value == null || value === '') return fallback;
  const v = String(value).trim().toLowerCase().replace(/[^a-z]/g, '');
  if (v === 'n' || v === 'ns' || v === 'northsouth') return 'ns';
  if (v === 'e' || v === 'ew' || v === 'eastwest') return 'ew';
  if (v === 'b' || v === 'both' || v === 'all') return 'both';
  return 'none';
}

function normalizeCall(value) {
  const call = String(value || '').trim().toUpperCase();
  if (CALL_MAP[call]) return CALL_MAP[call];
  const match = call.match(/^([1-7])(NT?|[CDHS])$/);
  return match ? match[1] + match[2] : null;
}

export function parseLinMetadata(lin) {
  if (!lin) return { play: [], bids: null, dealerNumber: 3, vul: 'none' };
  const tags = lin.split('|');
  const play = [];
  const bids = [];
  let hasBids = false;
  let dealerNumber = 3;
  let vul = 'none';
  for (let i = 0; i < tags.length; i++) {
    const tag = String(tags[i] || '').trim().toLowerCase();
    if (tag === 'pc' && tags[i + 1]) play.push(tags[i + 1]);
    if (tag === 'md' && tags[i + 1]) {
      const parsed = Number.parseInt(tags[i + 1][0], 10);
      if (parsed >= 1 && parsed <= 4) dealerNumber = parsed;
    }
    if (tag === 'sv' && tags[i + 1]) vul = normalizedVulnerability(tags[i + 1]);
    if (tag === 'mb' && tags[i + 1]) {
      hasBids = true;
      const raw = tags[i + 1];
      const marked = raw.endsWith('!');
      const bid = normalizeCall(marked ? raw.slice(0, -1) : raw);
      if (!bid) continue;
      const explanation = String(tags[i + 2] || '').trim().toLowerCase() === 'an'
        ? String(tags[i + 3] || '').trim() || null
        : null;
      bids.push({ bid, alert: marked || !!explanation, explanation });
    }
  }
  if (play.length >= 2 && play[0] === play[1]) play.shift();
  return { play, bids: hasBids && bids.length ? bids : null, dealerNumber, vul };
}

function escapeAttribute(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatBid(entry) {
  const bid = entry.bid;
  if (bid === 'P') return '<span style="color:#15803d">P</span>';
  if (bid === 'X') return '<span style="color:#dc2626;font-weight:700">X</span>';
  if (bid === 'XX') return '<span style="color:#2563eb;font-weight:700">XX</span>';
  const denom = bid.slice(1);
  const symbols = { C: '♣', D: '♦', H: '♥', S: '♠', NT: 'NT', N: 'NT' };
  const colors = { C: '#2e7d32', D: '#c62828', H: '#c62828', S: '#000', NT: '#333', N: '#333' };
  return `${bid[0]}<span style="color:${colors[denom] || '#333'};font-weight:700">${symbols[denom] || denom}</span>`;
}

export function buildAuctionHtml(linData, vulnerability) {
  if (!linData?.bids) return '<div class="pt-auction-placeholder" aria-hidden="true"></div>';
  const seats = ['W', 'N', 'E', 'S'];
  const vul = normalizedVulnerability(vulnerability, linData.vul);
  const vulnerable = seat => vul === 'both'
    || (vul === 'ns' && (seat === 'N' || seat === 'S'))
    || (vul === 'ew' && (seat === 'E' || seat === 'W'));
  const dealer = ['S', 'W', 'N', 'E'][linData.dealerNumber - 1] || 'N';
  let column = seats.indexOf(dealer);
  let row = new Array(4).fill(null);
  for (let i = 0; i < column; i++) row[i] = '';
  const rows = [];
  for (const bid of linData.bids) {
    row[column++] = bid;
    if (column === 4) { rows.push(row); row = new Array(4).fill(null); column = 0; }
  }
  if (row.some(cell => cell !== null)) rows.push(row);
  const headers = seats.map(seat => `<th style="padding:3px 7px;text-align:center;font-weight:700;color:#fff;background:${vulnerable(seat) ? '#e00000' : '#15803d'};font-size:0.75rem">${seat}</th>`).join('');
  const body = rows.map(cells => `<tr>${cells.map(cell => {
    if (!cell) return '<td></td>';
    const tooltip = cell.explanation ? ` title="${escapeAttribute(cell.explanation)}" aria-label="${escapeAttribute(`${cell.bid}: ${cell.explanation}`)}"` : '';
    return `<td${tooltip} style="padding:2px 7px;text-align:center;${cell.alert ? 'background:#dbeafe;' : ''}${cell.explanation ? 'cursor:help;' : ''}">${formatBid(cell)}</td>`;
  }).join('')}</tr>`).join('');
  return `<div style="display:inline-block;width:max-content;max-width:100%;margin-bottom:5px;border:1px solid #d1d5db;border-radius:6px;overflow:hidden;font-family:ui-sans-serif,system-ui"><table style="border-collapse:collapse;font-size:0.8rem"><thead><tr style="border-bottom:1px solid #d1d5db">${headers}</tr></thead><tbody>${body}</tbody></table></div>`;
}
