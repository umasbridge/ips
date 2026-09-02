import '../../public/bridge-problems/lin.js';
import '../../public/bridge-problems/play.js';
import './ips.js';
import { loadDds, Dds } from '../../public/bridge-problems/dds/dds-api.js';

const P = globalThis.bpPlay;
const IPS = globalThis.bpIps;
let failures = 0;

function check(condition, message) {
  console.log(`${condition ? '✓' : '✗'} ${message}`);
  if (!condition) failures++;
}

function cardIsInClass(ft, card) {
  const rv = P.RVAL[card.rank];
  for (let i = 0; i < ft.cards; i++) {
    if (P.SUITS[ft.suit[i]] !== card.suit) continue;
    if (ft.rank[i] === rv || ((ft.equals[i] >> rv) & 1)) return i;
  }
  return -1;
}

const dds = new Dds(await loadDds());
const hands = {
  N: { S: 'A', H: '2', D: '2', C: '2' },
  E: { S: 'K', H: '3', D: '3', C: '3' },
  S: { S: 'Q', H: '4', D: '4', C: '4' },
  W: { S: 'J', H: '5', D: '5', C: '5' },
};
const state = P.initPlay({ hands, declarer: 'S', trump: null });
const before = dds.SolveBoardPBN(P.toDealPbn(state), -1, 3, 0);
const best = Math.max(...Array.from({ length: before.cards }, (_, i) => before.score[i]));
const selected = IPS.selectCard(dds, state, new Set(['S', 'N']), 'S');
const selectedClass = cardIsInClass(before, selected);

check(selectedClass >= 0, 'IPS returns a legal DDS card');
check(selectedClass >= 0 && before.score[selectedClass] === best,
  'practical search never leaves the DD-optimal root set');

const diagnostic = IPS.getLastDecision();
check(diagnostic && diagnostic.selected === selected.suit + selected.rank,
  'selected card has an explainable diagnostic record');
check(diagnostic && diagnostic.fallback !== true,
  'practical evaluator completes without the safety fallback');
check(diagnostic && diagnostic.candidates.every(candidate =>
  Number.isFinite(candidate.practicalValue) && candidate.trapCount >= 0),
  'every candidate has finite practical-tree scores');
check(diagnostic && diagnostic.candidates.every(candidate =>
  candidate.solves <= IPS.practicalConfig.maxSolvesPerCandidate),
  'each candidate respects the DDS solve budget');

// A program-controlled declarer or dummy must not use the defensive swindle
// policy. The lower-scoring spade represents a practical concession; North
// must choose the strictly DD-optimal heart while the user defends as East.
const declarerRoleState = P.initPlay({ hands, declarer: 'S', trump: null, contractLevel: 3 });
declarerRoleState.turn = 'N';
declarerRoleState.trickLeader = 'N';
const roleDds = {
  SolveBoardPBN() {
    return {
      cards: 2,
      suit: [0, 1],
      rank: [9, 2],
      equals: [0, 0],
      score: [3, 4],
    };
  },
};
const declarerRolePlay = IPS.selectCard(roleDds, declarerRoleState, new Set(['E']), 'S');
const declarerRoleDiagnostic = IPS.getLastDecision();
check(declarerRolePlay.suit === 'H' && declarerRolePlay.rank === '2',
  'program-controlled dummy keeps strict DD optimality when the user defends');
check(declarerRoleDiagnostic?.role === 'declarer' && declarerRoleDiagnostic.strictDd,
  'declarer-side selection is separated from defensive swindle evaluation');

function hiddenWorldSignatures(worlds, seats) {
  return worlds.map(world => seats.map(seat => seat + ':' + P.SUITS.map(suit =>
    world.remaining[seat][suit].join('')).join('.')).join('|'));
}

const beliefStateA = P.cloneState(state);
beliefStateA.turn = 'N'; beliefStateA.trickLeader = 'N';
const beliefStateB = P.cloneState(beliefStateA);
[beliefStateB.remaining.E, beliefStateB.remaining.W]
  = [beliefStateB.remaining.W, beliefStateB.remaining.E];
const beliefA = IPS.sampleHiddenWorlds(beliefStateA, 'N');
const beliefB = IPS.sampleHiddenWorlds(beliefStateB, 'N');
check(JSON.stringify(hiddenWorldSignatures(beliefA, ['E', 'W']))
    === JSON.stringify(hiddenWorldSignatures(beliefB, ['E', 'W'])),
  'belief sampling depends on visible information, not the true hidden split');

const voidBeliefState = P.cloneState(beliefStateA);
voidBeliefState.playHistory = [
  { seat: 'N', suit: 'H', rank: '2', trickIndex: 0, position: 0, leader: 'N', isDiscard: false },
  { seat: 'E', suit: 'H', rank: '3', trickIndex: 0, position: 1, leader: 'N', isDiscard: false },
  { seat: 'S', suit: 'H', rank: '4', trickIndex: 0, position: 2, leader: 'N', isDiscard: false },
  { seat: 'W', suit: 'S', rank: 'J', trickIndex: 0, position: 3, leader: 'N', isDiscard: true },
];
voidBeliefState.tricks = [{
  leader: 'N', winner: 'S', cards: voidBeliefState.playHistory.map(({ seat, suit, rank }) => ({ seat, suit, rank })),
}];
const voidWorlds = IPS.sampleHiddenWorlds(voidBeliefState, 'N');
check(voidWorlds.every(world => world.remaining.W.H.length === 0),
  'belief sampling respects voids revealed by failure to follow suit');

const guardState = {
  turn: 'E',
  trickLeader: 'N',
  trump: null,
  trick: [{ seat: 'N', suit: 'S', rank: 'Q' }],
  remaining: {
    N: { S: [], H: ['J', '3'], D: ['J', 'T', '4'], C: ['A', 'Q', '3', '2'] },
    E: { S: [], H: ['9', '5'], D: ['6', '2'], C: ['J', '9', '5', '3'] },
    S: { S: ['K', 'T', '6'], H: ['K'], D: ['K', 'Q', '9', '8', '7'], C: ['K', '4'] },
    W: { S: [], H: [], D: [], C: [] },
  },
};
const declarerSide = new Set(['N', 'S']);
check(IPS.unguardsUserSuitOnDiscard(guardState, { suit: 'C', rank: '5' }, declarerSide),
  'discarding from Jxxx to Jxx breaks the guard against AKQxxx');
check(!IPS.unguardsUserSuitOnDiscard(guardState, { suit: 'H', rank: '5' }, declarerSide),
  'a discard without a top-winner length guard is not penalized');

// Kantar 3.5 / viewer Problem 55: cashing DA is the unique perfect-information
// trick, but a passive spade gives declarer a realistic losing route through
// HA-K and West's HQ entry. Since no perfect defense can set 4H, IPS should
// prefer the practical swindle without ever sacrificing a guaranteed set.
const problem55Hands = {
  E: { C: '1072', D: 'AQ852', H: '6', S: 'K854' },
  N: { C: 'KQ953', D: 'K4', H: 'AK108', S: 'Q3' },
  S: { C: 'A84', D: '103', H: '97532', S: 'A72' },
  W: { C: 'J6', D: 'J976', H: 'QJ4', S: 'J1096' },
};
const problem55 = P.initPlay({
  hands: problem55Hands, declarer: 'S', trump: 'H', contractLevel: 4,
});
for (const card of [
  { suit: 'S', rank: 'J' }, { suit: 'S', rank: 'Q' },
  { suit: 'S', rank: 'K' }, { suit: 'S', rank: '2' },
]) P.applyCard(problem55, card);
const swindle = IPS.selectCard(dds, problem55, new Set(['S', 'N']), 'S');
const swindleDiagnostic = IPS.getLastDecision();
check(swindle.suit === 'S',
  'Problem 55 prefers a passive spade that leaves declarer a losing route');
check(swindleDiagnostic && !swindleDiagnostic.perfectDefenseCanSet
    && swindleDiagnostic.candidates[0].swindleCandidate,
  'a one-trick DD concession is allowed only when perfect defense cannot set');

// Kantar 4.6 / viewer Problem 80: after C9-CT-CQ, West must cash CK.
// Ducking C2 creates many apparent later declarer errors, but immediately
// surrenders one DD trick and lets the club winner disappear under CA.
const problem80 = P.initPlay({
  hands: {
    E: { C: 'T', D: 'J8765', H: '652', S: 'K873' },
    N: { C: '9863', D: '2', H: 'AQJ984', S: 'AT' },
    S: { C: 'AQ754', D: 'AKQ43', H: '', S: 'QJ5' },
    W: { C: 'KJ2', D: 'T9', H: 'KT73', S: '9642' },
  },
  declarer: 'S', trump: null, contractLevel: 3,
});
for (const card of [
  { suit: 'S', rank: '2' }, { suit: 'S', rank: 'T' },
  { suit: 'S', rank: 'K' }, { suit: 'S', rank: '5' },
  { suit: 'S', rank: '3' }, { suit: 'S', rank: 'J' },
  { suit: 'S', rank: '4' }, { suit: 'S', rank: 'A' },
  { suit: 'C', rank: '9' }, { suit: 'C', rank: 'T' },
  { suit: 'C', rank: 'Q' },
]) P.applyCard(problem80, card);
const cashClubKing = IPS.selectCard(dds, problem80, new Set(['S', 'N']), 'S');
const problem80Diagnostic = IPS.getLastDecision();
check(cashClubKing.suit === 'C' && cashClubKing.rank === 'K',
  'Problem 80 cashes CK instead of surrendering the trick with C2');
check(problem80Diagnostic && problem80Diagnostic.candidates[0].ddLoss === 0,
  'an in-progress trick cannot be sacrificed for speculative trap value');

// Kantar 4.19 / viewer Problem 93: CQ-CA leaves East third hand. CK cannot
// overtake CA, so third-hand-high is not an excuse to waste the king.
const problem93 = P.initPlay({
  hands: {
    E: { C: 'K974', D: 'KT2', H: 'T976', S: '92' },
    N: { C: 'A3', D: 'J965', H: 'J3', S: 'AK876' },
    S: { C: '5', D: 'AQ3', H: 'AQ42', S: 'QJT54' },
    W: { C: 'QJT862', D: '874', H: 'K85', S: '3' },
  },
  declarer: 'S', trump: 'S', contractLevel: 6,
});
P.applyCard(problem93, { suit: 'C', rank: 'Q' });
P.applyCard(problem93, { suit: 'C', rank: 'A' });
const preserveClubKing = IPS.selectCard(dds, problem93, new Set(['S', 'N']), 'S');
check(preserveClubKing.suit === 'C' && preserveClubKing.rank !== 'K',
  'Problem 93 plays low under CA instead of wasting CK');

// Kantar 4.24 / viewer Problem 98: C5-C2 to East holding QJT6. Playing C6
// lets declarer's C9 win cheaply; third hand should play the bottom of the
// touching sequence, CT, to force CA.
const problem98 = P.initPlay({
  hands: {
    E: { C: 'QJT6', D: 'A962', H: 'T92', S: 'J8' },
    N: { C: 'K872', D: 'Q3', H: 'K65', S: 'AQ32' },
    S: { C: 'A943', D: 'J8', H: 'AQJ43', S: '54' },
    W: { C: '5', D: 'KT754', H: '87', S: 'KT976' },
  },
  declarer: 'S', trump: 'H', contractLevel: 4,
});
for (const card of [
  { suit: 'D', rank: '5' }, { suit: 'D', rank: '3' },
  { suit: 'D', rank: 'A' }, { suit: 'D', rank: '8' },
  { suit: 'D', rank: '2' }, { suit: 'D', rank: 'J' },
  { suit: 'D', rank: 'K' }, { suit: 'D', rank: 'Q' },
  { suit: 'C', rank: '5' }, { suit: 'C', rank: '2' },
]) P.applyCard(problem98, card);
const forceClubAce = IPS.selectCard(dds, problem98, new Set(['S', 'N']), 'S');
check(forceClubAce.suit === 'C' && forceClubAce.rank === 'T',
  'Problem 98 plays CT, bottom of QJT, instead of allowing C9 to win');

// Kantar 4.25 / viewer Problem 99: North's DT is unsupported. East's DQ is
// the lowest card that covers it, so D7 must not outrank DQ on trap value.
const coverState = {
  turn: 'E', trickLeader: 'N', trump: null,
  trick: [{ seat: 'N', suit: 'D', rank: 'T' }],
  remaining: {
    N: { S: ['K'], H: ['K', '5', '4', '3'], D: ['K'], C: ['K'] },
    E: { S: [], H: [], D: ['Q', '7', '6', '5'], C: [] },
    S: { S: [], H: ['A', '6', '2'], D: ['A', '8', '4', '3', '2'], C: [] },
    W: { S: [], H: [], D: ['J', '9'], C: [] },
  },
};
check(IPS.missesRequiredHonorCover(coverState, { suit: 'D', rank: '7' }, declarerSide),
  'Problem 99 penalizes D7 for failing to cover the unsupported DT');
check(!IPS.missesRequiredHonorCover(coverState, { suit: 'D', rank: 'Q' }, declarerSide),
  'Problem 99 recognizes DQ as the required cover');

const fourthHandState = {
  turn: 'E', trickLeader: 'S', trump: null,
  trick: [
    { seat: 'S', suit: 'D', rank: '2' },
    { seat: 'W', suit: 'D', rank: '9' },
    { seat: 'N', suit: 'D', rank: 'T' },
  ],
  remaining: {
    N: { S: ['K'], H: ['K', '5', '4', '3'], D: ['K'], C: ['K'] },
    E: { S: [], H: ['Q', 'J'], D: ['Q', '7', '6', '5'], C: [] },
    S: { S: [], H: ['A', '6', '2'], D: ['A', '8', '4', '3'], C: [] },
    W: { S: [], H: ['T', '9', '8', '7'], D: ['J'], C: [] },
  },
};
check(!IPS.playsUnnecessaryHonor(
  fourthHandState, { suit: 'D', rank: 'Q' }, declarerSide, new Set(['D'])
), 'Problem 99 does not penalize fourth-hand DQ when it wins DT');

const clubDiscardState = {
  turn: 'S', trick: [{ seat: 'E', suit: 'C', rank: 'T' }],
  remaining: { S: { S: [], H: ['A', '6', '2'], D: ['A', '8', '4', '3'], C: [] } },
};
const clubDiscardOptions = ['HA', 'H6', 'H2', 'DA', 'D8', 'D4', 'D3'].map(card => ({
  suit: card[0], rank: card.slice(1), rankVal: P.RVAL[card.slice(1)],
}));
const realisticDiscards = IPS.plausibleUserOptions(clubDiscardState, clubDiscardOptions)
  .map(card => card.suit + card.rank).sort();
check(JSON.stringify(realisticDiscards) === JSON.stringify(['D3', 'H2']),
  'club return counts only realistic low discards, not HA or high diamonds');

const heartChoiceState = {
  turn: 'S', trick: [{ seat: 'E', suit: 'H', rank: 'Q' }],
  remaining: { S: { S: [], H: ['A', '6', '2'], D: ['A', '8', '4', '3'], C: [] } },
};
const heartOptions = ['HA', 'H6', 'H2'].map(card => ({
  suit: 'H', rank: card.slice(1), rankVal: P.RVAL[card.slice(1)],
}));
const realisticHeartChoices = IPS.plausibleUserOptions(heartChoiceState, heartOptions)
  .map(card => card.suit + card.rank).sort();
check(JSON.stringify(realisticHeartChoices) === JSON.stringify(['H2', 'HA']),
  'heart return retains the real HA-versus-low declarer guess');

function signalState(agreement, originalClubs, remainingClubs, leader = 'W') {
  return {
    declarer: 'S', dummy: 'N', turn: 'E', trickLeader: leader, trump: null,
    contractLevel: 3, contractDoubled: false,
    carding: { NS: agreement, EW: agreement },
    trick: [{ seat: leader, suit: 'C', rank: '2' }], tricks: [], playHistory: [],
    discardCount: { N: 0, E: 0, S: 0, W: 0 },
    originalRemaining: { E: { S: [], H: [], D: [], C: originalClubs } },
    remaining: { E: { S: [], H: [], D: [], C: remainingClubs } },
  };
}
const signalPeers = [
  { suit: 'C', rank: '8', rankVal: 8 }, { suit: 'C', rank: '3', rankVal: 3 },
];
let sig = signalState('UDCA', ['K', '8', '3'], ['K', '8', '3']);
check(IPS.cardingPenalty(sig, signalPeers[1], signalPeers, 'S')
    < IPS.cardingPenalty(sig, signalPeers[0], signalPeers, 'S'),
  'UDCA attitude encourages with the low card on partner lead');

const aceLeadPeers = [
  { suit: 'C', rank: '8', rankVal: P.RVAL['8'] },
  { suit: 'C', rank: '3', rankVal: P.RVAL['3'] },
];
sig = signalState('UDCA', ['Q', '8', '3'], ['Q', '8', '3']);
sig.trick[0].rank = 'A';
check(IPS.cardingPenalty(sig, aceLeadPeers[0], aceLeadPeers, 'S')
    < IPS.cardingPenalty(sig, aceLeadPeers[1], aceLeadPeers, 'S'),
  'UDCA discourages on an ace lead without the king or a ruffing prospect');
sig = signalState('UDCA', ['K', '8', '3'], ['K', '8', '3']);
sig.trick[0].rank = 'A';
check(IPS.cardingPenalty(sig, aceLeadPeers[1], aceLeadPeers, 'S')
    < IPS.cardingPenalty(sig, aceLeadPeers[0], aceLeadPeers, 'S'),
  'UDCA encourages on an ace lead when holding the king');

sig.carding.EW = 'STD';
check(IPS.cardingPenalty(sig, signalPeers[0], signalPeers, 'S')
    < IPS.cardingPenalty(sig, signalPeers[1], signalPeers, 'S'),
  'STD attitude encourages with the high card on partner lead');

sig = signalState('UDCA', ['8', '7', '3', '2'], ['8', '3'], 'N');
check(IPS.cardingPenalty(sig, signalPeers[1], signalPeers, 'S')
    < IPS.cardingPenalty(sig, signalPeers[0], signalPeers, 'S'),
  'UDCA count starts low from an original even holding');
sig.carding.EW = 'STD';
check(IPS.cardingPenalty(sig, signalPeers[0], signalPeers, 'S')
    < IPS.cardingPenalty(sig, signalPeers[1], signalPeers, 'S'),
  'STD count starts high from an original even holding');
sig.carding.EW = 'UDCA';
sig.playHistory = [{ seat: 'E', suit: 'C', rank: '3', leader: 'N', isDiscard: false }];
check(IPS.cardingPenalty(sig, signalPeers[0], signalPeers, 'S')
    < IPS.cardingPenalty(sig, signalPeers[1], signalPeers, 'S'),
  'UDCA even count completes low-then-high on the second signal');

const discardSignalState = {
  declarer: 'S', dummy: 'N', turn: 'E', trickLeader: 'N', trump: null,
  contractLevel: 3, carding: { NS: 'UDCA', EW: 'UDCA' },
  trick: [{ seat: 'N', suit: 'S', rank: 'A' }], playHistory: [],
  discardCount: { N: 0, E: 0, S: 0, W: 0 },
  originalRemaining: { E: { S: [], H: [], D: ['9', '6', '4'], C: ['K', '8', '3'] } },
  remaining: { E: { S: [], H: [], D: ['9', '6', '4'], C: ['K', '8', '3'] } },
};
const discardSignalPeers = [
  { suit: 'C', rank: '8', rankVal: 8 }, { suit: 'C', rank: '3', rankVal: 3 },
  { suit: 'D', rank: '9', rankVal: 9 }, { suit: 'D', rank: '4', rankVal: 4 },
];
check(IPS.cardingPenalty(discardSignalState, discardSignalPeers[1], discardSignalPeers, 'S') === 0,
  'UDCA first discard encourages a liked suit with a low card');
discardSignalState.carding.EW = 'STD';
check(IPS.cardingPenalty(discardSignalState, discardSignalPeers[0], discardSignalPeers, 'S') === 0,
  'STD first discard encourages a liked suit with a high card');

const negativeDiscardState = {
  ...discardSignalState, carding: { NS: 'UDCA', EW: 'UDCA' },
  originalRemaining: { E: { S: [], H: ['7', '3'], D: ['8', '2'], C: [] } },
  remaining: { E: { S: [], H: ['7', '3'], D: ['8', '2'], C: [] } },
};
const negativeDiscardPeers = [
  { suit: 'D', rank: '8', rankVal: 8 }, { suit: 'D', rank: '2', rankVal: 2 },
  { suit: 'H', rank: '7', rankVal: 7 }, { suit: 'H', rank: '3', rankVal: 3 },
];
check(IPS.cardingPenalty(negativeDiscardState, negativeDiscardPeers[0], negativeDiscardPeers, 'S')
    < IPS.cardingPenalty(negativeDiscardState, negativeDiscardPeers[1], negativeDiscardPeers, 'S'),
  'UDCA first discard uses a high diamond to deny interest, not D2');

function leadState(trump, level, holding, doubled = false) {
  return {
    turn: 'W', trump, contractLevel: level, contractDoubled: doubled,
    playHistory: [],
    remaining: { W: { S: [], H: [], D: [], C: holding } },
    originalRemaining: { W: { S: [], H: [], D: [], C: [...holding] } },
  };
}
check(IPS.preferredLeadRank(leadState('S', 4, ['A', 'K', '4']), 'W', 'C') === 'A',
  'suit opening lead is A from AK at ordinary levels');
check(IPS.preferredLeadRank(leadState('S', 6, ['A', 'K', '4']), 'W', 'C') === 'K',
  'high-level suit opening lead is K from AK asking for count');
check(IPS.preferredLeadRank(leadState('S', 6, ['A', 'K', 'Q', '4']), 'W', 'C') === 'Q',
  'high-level suit opening lead may be Q from AKQ asking for count');
check(IPS.preferredLeadRank(leadState(null, 3, ['A', 'K', '4']), 'W', 'C') === 'K',
  'notrump opening lead is K from AK');
check(IPS.preferredLeadRank(leadState(null, 3, ['9', '4', '2']), 'W', 'C') === '9',
  'notrump opening lead is top from three worthless cards');
check(IPS.preferredLeadRank(leadState(null, 3, ['K', '4', '2']), 'W', 'C') === '2',
  'notrump opening lead is low from Hxx');
check(IPS.preferredLeadRank(leadState('S', 4, ['9', '8', '7', '4', '2']), 'W', 'C') === '2',
  'suit opening lead follows third/fifth style');
check(IPS.preferredLeadRank(leadState(null, 3, ['9', '7', '6', '2']), 'W', 'C') === '2',
  'low-level notrump opening lead follows second/fourth style');

const historyState = P.initPlay({
  hands: {
    N: { S: 'A', H: '2', D: '2', C: '2' }, E: { S: 'K', H: '3', D: '3', C: '3' },
    S: { S: 'Q', H: '4', D: '4', C: '4' }, W: { S: 'J', H: '5', D: '5', C: '5' },
  }, declarer: 'S', trump: null, carding: { NS: 'STD', EW: 'UDCA' },
});
P.applyCard(historyState, { suit: 'S', rank: 'J' });
const historyClone = P.cloneState(historyState);
check(historyClone.carding.NS === 'STD' && historyClone.carding.EW === 'UDCA'
    && historyClone.playHistory.length === 1
    && historyClone.originalRemaining.W.S.includes('J'),
  'play cloning preserves agreements, original holding, and signal history');

const ruffSignalPeers = [
  { suit: 'C', rank: '8', rankVal: 8 }, { suit: 'C', rank: '2', rankVal: 2 },
];
function ruffSignalState(westDiamonds, westSpades) {
  return {
    declarer: 'S', dummy: 'N', turn: 'W', trickLeader: 'W', trump: 'H',
    carding: { NS: 'STD', EW: 'UDCA' }, trick: [], playHistory: [],
    remaining: {
      W: { S: westSpades, H: [], D: westDiamonds, C: ['8', '2'] },
      E: { S: ['7'], H: ['9', '4'], D: ['6'], C: [] },
    },
    originalRemaining: {
      W: { S: [...westSpades], H: [], D: [...westDiamonds], C: ['8', '2'] },
      E: { S: ['7'], H: ['9', '4'], D: ['6'], C: [] },
    },
  };
}
let ruffSignal = ruffSignalState(['K', '3'], ['5', '2']);
check(IPS.suitPreferencePenalty(ruffSignal, ruffSignalPeers[1], ruffSignalPeers) === 0
    && IPS.suitPreferencePenalty(ruffSignal, ruffSignalPeers[0], ruffSignalPeers) > 0,
  'low card for partner to ruff asks for the lower-ranking side suit');
ruffSignal = ruffSignalState(['5', '3'], ['K', '2']);
check(IPS.suitPreferencePenalty(ruffSignal, ruffSignalPeers[0], ruffSignalPeers) === 0
    && IPS.suitPreferencePenalty(ruffSignal, ruffSignalPeers[1], ruffSignalPeers) > 0,
  'high card for partner to ruff asks for the higher-ranking side suit');

const receivedRuffSignal = {
  declarer: 'S', dummy: 'N', turn: 'W', trickLeader: 'W', trump: 'S',
  contractLevel: 4, contractDoubled: false, carding: { NS: 'STD', EW: 'UDCA' },
  trick: [], playHistory: [], discardCount: { N: 0, E: 0, S: 0, W: 0 },
  tricks: [{
    leader: 'N', winner: 'W', cards: [
      { seat: 'N', suit: 'C', rank: '8' }, { seat: 'E', suit: 'C', rank: '6' },
      { seat: 'S', suit: 'C', rank: '9' }, { seat: 'W', suit: 'S', rank: '5' },
    ],
  }],
  remaining: {
    W: { S: [], H: ['K', '4'], D: ['8', '3'], C: [] },
    E: { S: [], H: ['T', '6', '3'], D: ['Q', 'J', '9', '4'], C: ['Q', '7'] },
  },
  originalRemaining: {
    W: { S: ['5'], H: ['K', '4'], D: ['8', '3'], C: [] },
    E: { S: [], H: ['T', '6', '3'], D: ['Q', 'J', '9', '4'], C: ['Q', '7', '6'] },
  },
};
check(IPS.requestedSuitFromLastRuff(receivedRuffSignal) === 'D',
  'ruffing defender decodes partner low club as a diamond request');
const returnPeers = [
  { suit: 'D', rank: '3', rankVal: 3 }, { suit: 'H', rank: '4', rankVal: 4 },
];
check(IPS.cardingPenalty(receivedRuffSignal, returnPeers[0], returnPeers, 'S')
    < IPS.cardingPenalty(receivedRuffSignal, returnPeers[1], returnPeers, 'S'),
  'requested diamond return outranks an unrequested heart return');

const partnerThirdHandState = {
  declarer: 'S', dummy: 'N', turn: 'W', trickLeader: 'E', trump: 'S',
  contractLevel: 4, nsTricks: 2, ewTricks: 3,
  trick: [
    { seat: 'E', suit: 'H', rank: '3' },
    { seat: 'S', suit: 'H', rank: '9' },
  ],
  remaining: {
    N: { S: ['T', '9'], H: ['Q', '5'], D: ['A', 'K'], C: ['K', 'T'] },
    E: { S: [], H: ['T', '6'], D: ['Q', '9', '4'], C: ['Q', '7'] },
    S: { S: [], H: [], D: [], C: [] },
    W: { S: [], H: ['A', '2'], D: [], C: [] },
  },
};
check(IPS.playsBelowThirdHandHigh(
  partnerThirdHandState, { suit: 'H', rank: '2' }, declarerSide
), 'computer partner recognizes H2 as below the required third-hand-high card');
check(!IPS.playsBelowThirdHandHigh(
  partnerThirdHandState, { suit: 'H', rank: 'A' }, declarerSide
), 'computer partner recognizes HA as correct third-hand high');
check(IPS.winsSettingTrick(partnerThirdHandState, { suit: 'H', rank: 'A' }, 'S'),
  'HA is recognized as the certain setting trick');

const declarerDiamondState = {
  declarer: 'S', dummy: 'N', turn: 'N', trickLeader: 'W', trump: 'S',
  contractLevel: 4, nsTricks: 2, ewTricks: 2,
  trick: [{ seat: 'W', suit: 'D', rank: '3' }], tricks: [], playHistory: [],
  carding: { NS: 'UDCA', EW: 'UDCA' }, discardCount: { N: 0, E: 0, S: 0, W: 0 },
  remaining: {
    N: { S: ['T', '9'], H: ['Q'], D: ['A', 'K', '7'], C: ['K', 'T'] },
    E: { S: [], H: ['T', '6', '3'], D: ['Q', 'J', '9', '4'], C: ['Q', '7'] },
    S: { S: [], H: [], D: ['8', '2'], C: [] },
    W: { S: [], H: [], D: [], C: [] },
  },
  originalRemaining: {
    N: { S: ['T', '9'], H: ['Q'], D: ['A', 'K', '7'], C: ['K', 'T'] },
    E: { S: [], H: ['T', '6', '3'], D: ['Q', 'J', '9', '4'], C: ['Q', '7'] },
    S: { S: [], H: [], D: ['8', '2'], C: [] },
    W: { S: [], H: [], D: ['3'], C: [] },
  },
};
check(IPS.sideWinsCurrentTrick(declarerDiamondState, { suit: 'D', rank: 'A' }),
  'playing DA guarantees declarer side wins the current trick');
check(!IPS.sideWinsCurrentTrick(declarerDiamondState, { suit: 'D', rank: '7' }),
  'ducking D7 does not guarantee the trick when East can win DQ');

// Kantar 1.41 / viewer Problem 41: East must win SQ personally and return a
// spade. West, now void in spades, ruffs with DT for the immediate setting
// trick. Ducking to West's SJ wins this trick but leaves the lead in the wrong
// defensive hand.
const problem41 = P.initPlay({
  hands: {
    E: { C: 'Q543', D: '98', H: 'J62', S: 'QT94' },
    N: { C: '', D: 'QJ4', H: 'A9543', S: 'AK876' },
    S: { C: 'KT82', D: 'AK765', H: 'K', S: '532' },
    W: { C: 'AJ976', D: 'T32', H: 'QT87', S: 'J' },
  },
  declarer: 'S', trump: 'D', contractLevel: 6,
});
for (const card of [
  { suit: 'C', rank: 'A' }, { suit: 'D', rank: '4' },
  { suit: 'C', rank: '3' }, { suit: 'C', rank: '2' },
  { suit: 'D', rank: 'Q' }, { suit: 'D', rank: '8' },
  { suit: 'D', rank: 'A' }, { suit: 'D', rank: '2' },
  { suit: 'D', rank: '5' }, { suit: 'D', rank: '3' },
  { suit: 'D', rank: 'J' }, { suit: 'D', rank: '9' },
  { suit: 'S', rank: '6' },
]) P.applyCard(problem41, card);
check(IPS.winsThenGivesSettingRuff(problem41, { suit: 'S', rank: 'Q' }, 'S'),
  'Problem 41 recognizes SQ followed by a spade ruff as the setting sequence');
const problem41Play = IPS.selectCard(dds, problem41, new Set(['S', 'N']), 'S');
check(problem41Play.suit === 'S' && problem41Play.rank === 'Q',
  'Problem 41 wins SQ and keeps the lead to give partner a spade ruff');

// Kantar 1.42 / viewer Problem 42: South leads ST toward dummy's ace.
// West must not cover automatically when SQ promotes South's SJ immediately;
// a low card preserves declarer's guess.
const problem42 = P.initPlay({
  hands: {
    E: { C: '5', D: 'J642', H: 'AQ6432', S: '32' },
    N: { C: 'QJ983', D: '987', H: '', S: 'A9874' },
    S: { C: 'AKT', D: 'AKQT5', H: 'J5', S: 'KJT' },
    W: { C: '7642', D: '3', H: 'KT987', S: 'Q65' },
  },
  declarer: 'S', trump: 'D', contractLevel: 7,
});
for (const card of [
  { suit: 'C', rank: '2' }, { suit: 'C', rank: '3' },
  { suit: 'C', rank: '5' }, { suit: 'C', rank: 'A' },
  { suit: 'D', rank: 'A' }, { suit: 'D', rank: '3' },
  { suit: 'D', rank: '7' }, { suit: 'D', rank: '2' },
  { suit: 'D', rank: 'K' }, { suit: 'H', rank: '7' },
  { suit: 'D', rank: '8' }, { suit: 'D', rank: '4' },
  { suit: 'S', rank: 'T' },
]) P.applyCard(problem42, card);
check(!IPS.missesRequiredHonorCover(problem42, { suit: 'S', rank: '5' }, declarerSide),
  'Problem 42 does not force a cover that immediately promotes SJ');
const problem42Play = IPS.selectCard(dds, problem42, new Set(['S', 'N']), 'S');
check(problem42Play.suit === 'S' && problem42Play.rank !== 'Q',
  'Problem 42 plays low instead of SQ, preserving declarer’s spade guess');

// A Great Deal of Bridge Problems 1.3: after the trump endplay, West has a
// choice between a diamond and a spade exit. A spade preserves North's real
// SA-versus-SJ finesse guess; D8 gives declarer a safe route through diamonds.
const problem13Endplay = P.initPlay({
  hands: {
    N: { S: 'AJ', H: '5', D: 'K64', C: '' },
    E: { S: 'K9654', H: '', D: 'Q', C: '' },
    S: { S: '', H: '76', D: 'AJ53', C: '' },
    W: { S: 'T872', H: '', D: 'T8', C: '' },
  },
  declarer: 'S', trump: 'H', contractLevel: 6,
});
problem13Endplay.turn = 'W';
problem13Endplay.trickLeader = 'W';
problem13Endplay.nsTricks = 6;
problem13Endplay.ewTricks = 1;
const spadeGuessState = P.cloneState(problem13Endplay);
P.applyCard(spadeGuessState, { suit: 'S', rank: '7' });
const spadeOptions = IPS.plausibleUserOptions(spadeGuessState,
  [{ suit: 'S', rank: 'A', rankVal: P.RVAL.A, score: 6 },
    { suit: 'S', rank: 'J', rankVal: P.RVAL.J, score: 6 }]);
check(spadeOptions.some(card => card.rank === 'J') && spadeOptions.some(card => card.rank === 'A'),
  'Problem 1.3 retains both SJ finesse and certain SA as realistic choices');
check(IPS.leadsIntoUserLongTenace(problem13Endplay, { suit: 'D', rank: '8' }, declarerSide),
  'Problem 1.3 recognizes D8 as leading into declarer’s long diamond tenace');
check(!IPS.leadsIntoUserLongTenace(problem13Endplay, { suit: 'S', rank: '7' }, declarerSide),
  'Problem 1.3 recognizes a spade as the safer passive exit');
const problem13Defense = IPS.selectCard(dds, problem13Endplay, new Set(['S', 'N']), 'S');
check(problem13Defense.suit === 'S',
  'Problem 1.3 chooses the spade exit that preserves declarer’s finesse guess');

// A Great Deal of Bridge Problems 1.7: after H9-HA-H4-H5 and dummy's SK,
// East must not spend SJ as an UDCA count signal. It improves the TTP of
// declarer's ST and every lower spade; S3 gives away no such promotion.
const problem17 = P.initPlay({
  hands: {
    N: { S: 'K', H: 'AQ7632', D: 'AQ4', C: 'AKQ' },
    E: { S: 'J53', H: 'KT4', D: 'K72', C: 'J875' },
    S: { S: 'AT98764', H: 'J5', D: 'JT8', C: '9' },
    W: { S: 'Q2', H: '98', D: '9653', C: 'T6432' },
  },
  declarer: 'S', trump: 'S', contractLevel: 6,
});
for (const card of [
  { suit: 'H', rank: '9' }, { suit: 'H', rank: 'A' },
  { suit: 'H', rank: '4' }, { suit: 'H', rank: '5' },
  { suit: 'S', rank: 'K' },
]) P.applyCard(problem17, card);
check(IPS.userTtpGain(problem17, { suit: 'S', rank: 'J' }, declarerSide)
    > IPS.userTtpGain(problem17, { suit: 'S', rank: '3' }, declarerSide),
  'Problem 1.7 measures the extra TTP given away by playing SJ');
const problem17Defense = IPS.selectCard(dds, problem17, new Set(['S', 'N']), 'S');
check(problem17Defense.suit === 'S' && problem17Defense.rank === '3',
  'Problem 1.7 plays S3 instead of spending SJ as a count signal');
const problem17Peers = [
  { suit: 'S', rank: 'J', rankVal: P.RVAL.J },
  { suit: 'S', rank: '5', rankVal: P.RVAL['5'] },
  { suit: 'S', rank: '3', rankVal: P.RVAL['3'] },
];
check(IPS.cardingPenalty(problem17, problem17Peers[0], problem17Peers, 'S')
    > IPS.cardingPenalty(problem17, problem17Peers[2], problem17Peers, 'S'),
  'count signaling uses a spot card instead of an honor');

// A Great Deal of Bridge Problems 1.16: West is the sole four-card heart
// guard against dummy's four hearts. Discarding H6 breaks parity immediately;
// a diamond discard keeps the heart guard for another round.
const problem116 = P.initPlay({
  hands: {
    E: { C: '9542', D: 'A973', H: 'K72', S: 'T8' },
    N: { C: 'K8', D: 'KQ4', H: 'AJ953', S: 'Q64' },
    S: { C: 'AQJT73', D: '652', H: '', S: 'AK75' },
    W: { C: '6', D: 'JT8', H: 'QT864', S: 'J932' },
  },
  declarer: 'S', trump: 'C', contractLevel: 6,
});
for (const card of [
  { suit: 'D', rank: 'J' }, { suit: 'D', rank: 'K' },
  { suit: 'D', rank: 'A' }, { suit: 'D', rank: '2' },
  { suit: 'D', rank: '3' }, { suit: 'D', rank: '5' },
  { suit: 'D', rank: '8' }, { suit: 'D', rank: 'Q' },
  { suit: 'H', rank: '3' }, { suit: 'H', rank: '2' },
  { suit: 'C', rank: '3' }, { suit: 'H', rank: '4' },
  { suit: 'C', rank: 'A' }, { suit: 'C', rank: '6' },
  { suit: 'C', rank: '8' }, { suit: 'C', rank: '2' },
  { suit: 'C', rank: '7' },
]) P.applyCard(problem116, card);
check(IPS.breaksUserLengthGuardOnDiscard(
  problem116, { suit: 'H', rank: '6' }, declarerSide
), 'Problem 1.16 recognizes H6 as breaking the sole four-card heart guard');
check(!IPS.breaksUserLengthGuardOnDiscard(
  problem116, { suit: 'D', rank: 'T' }, declarerSide
), 'Problem 1.16 recognizes a diamond as preserving the heart guard');
const problem116Defense = IPS.selectCard(dds, problem116, new Set(['S', 'N']), 'S');
check(problem116Defense.suit === 'D',
  'Problem 1.16 discards a diamond instead of releasing hearts early');

// A Great Deal of Bridge Problems 2.3: West leads HK, dummy plays H6,
// and East holds AT2. South's H9 cannot beat HK, so third-hand high does not
// apply; East must preserve HA and play the encouraging spot card H2.
const problem23 = P.initPlay({
  hands: {
    N: { S: 'J4', H: '6543', D: 'KJ5', C: 'AKJ7' },
    E: { S: 'K95', H: 'AT2', D: 'AQ3', C: 'QT93' },
    S: { S: 'AQT862', H: '98', D: 'T9742', C: '' },
    W: { S: '73', H: 'KQJ7', D: '86', C: '86542' },
  },
  declarer: 'S', trump: 'S', contractLevel: 2,
});
P.applyCard(problem23, { suit: 'H', rank: 'K' });
P.applyCard(problem23, { suit: 'H', rank: '6' });
check(!IPS.playsBelowThirdHandHigh(
  problem23, { suit: 'H', rank: '2' }, declarerSide
), 'Problem 2.3 does not invoke third-hand high when partner HK is guaranteed');
const problem23Defense = IPS.selectCard(dds, problem23, new Set(['W']), 'S');
check(problem23Defense.suit === 'H' && problem23Defense.rank === '2',
  'Problem 2.3 preserves HA and plays H2 under partner’s winning HK');

console.log(`\n${failures ? `✗ ${failures} IPS test(s) failed` : '✓ IPS practical-tree smoke test passed'}`);
process.exit(failures ? 1 : 0);
