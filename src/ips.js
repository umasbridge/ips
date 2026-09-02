// bridge-lib/ips/ips.js — Intuitive Play Selection
//
// Load order: lin.js → play.js → ips.js
// Depends only on globalThis.bpPlay and a bridge-dds instance (dds).
// IMPORTANT: dds.SolveBoardPBN uses `this` internally — always call as
// dds.SolveBoardPBN(...), never destructure it.

(function () {
  function P() { return globalThis.bpPlay; }

  let defaultCarding = { NS: 'UDCA', EW: 'UDCA' };
  function normalizeAgreement(value) {
    return String(value || '').toUpperCase() === 'STD' ? 'STD' : 'UDCA';
  }
  function setCardingAgreements(agreements = {}) {
    defaultCarding = {
      NS: normalizeAgreement(agreements.NS ?? defaultCarding.NS),
      EW: normalizeAgreement(agreements.EW ?? defaultCarding.EW),
    };
    globalThis.bpCardingPreferences = { ...defaultCarding };
    return { ...defaultCarding };
  }
  function getCardingAgreements() { return { ...defaultCarding }; }

  // ── IPS rules ─────────────────────────────────────────────────────────────

  function promotesUserCard(state, card, userSeats) {
    const RVAL = P().RVAL;
    const SEATS = P().SEATS;
    const cardRV = RVAL[card.rank];
    for (const uSeat of userSeats) {
      for (const uRank of state.remaining[uSeat][card.suit]) {
        const uRV = RVAL[uRank];
        if (cardRV <= uRV) continue;
        // Count ALL adversary remaining cards above uRV (cards already played this
        // trick have been removed from remaining by applyCard, so we don't double-count).
        // The card being played is still in remaining and will be the 1 we detect.
        let adversaryAbove = 0;
        for (const seat of SEATS) {
          if (userSeats.has(seat)) continue;
          for (const r of state.remaining[seat][card.suit])
            if (RVAL[r] > uRV) adversaryAbove++;
        }
        if (adversaryAbove === 1) return true;
      }
    }
    return false;
  }

  // Total improvement in declarer-side trick-taking potential caused by
  // removing this defender card. TTP is ordinal within a suit: A=1, K=2,
  // Q=3, and so on among cards still in play. Every user card below `card`
  // moves one place closer to becoming a winner when `card` is spent.
  function userTtpGain(state, card, userSeats) {
    const { RVAL } = P();
    const cardValue = RVAL[card.rank];
    let gain = 0;
    for (const seat of userSeats) {
      for (const rank of state.remaining?.[seat]?.[card.suit] || [])
        if (RVAL[rank] < cardValue) gain++;
    }
    return gain;
  }

  function discardsIntoDeclarerSuit(state, card, userSeats) {
    if (state.trick.length === 0) return false;
    const ledSuit = state.trick[0].suit;
    if (card.suit === ledSuit) return false;
    const SEATS = P().SEATS;
    let userCount = 0, adversaryCount = 0;
    for (const seat of SEATS) {
      const n = state.remaining[seat][card.suit].length;
      if (userSeats.has(seat)) userCount += n; else adversaryCount += n;
    }
    return userCount > adversaryCount;
  }

  // True when a discard abandons a length guard immediately. If the user side
  // owns N consecutive top winners in this suit and also has lower cards, a
  // defender needs more than N cards to retain a stopper after those winners
  // are cashed. Discarding from N+1 cards down to N releases the suit now.
  // Example: user side has AKQxxx; East's Jxxx is a guard, but Jxx is not.
  function unguardsUserSuitOnDiscard(state, card, userSeats) {
    if (state.trick.length === 0) return false;
    const ledSuit = state.trick[0].suit;
    if (card.suit === ledSuit) return false;

    const { RVAL, SEATS } = P();
    const suit = card.suit;
    const ordered = [];
    let userCount = 0;
    for (const seat of SEATS) {
      const isUser = userSeats.has(seat);
      for (const rank of state.remaining[seat][suit]) {
        ordered.push({ rank, isUser });
        if (isUser) userCount++;
      }
    }
    ordered.sort((a, b) => RVAL[b.rank] - RVAL[a.rank]);

    let topUserWinners = 0;
    for (const entry of ordered) {
      if (!entry.isUser) break;
      topUserWinners++;
    }
    if (topUserWinners === 0 || userCount <= topUserWinners) return false;

    const defenderLength = state.remaining[state.turn][suit].length;
    return defenderLength > topUserWinners
      && defenderLength - 1 <= topUserWinners;
  }

  // True when this defender is the only defender still matching the length of
  // a user hand in the discarded suit, and the discard breaks that parity.
  // This is the classic positional length guard in a squeeze: even if the
  // contract is eventually makeable, do not release the long card early when
  // another discard preserves resistance.
  function breaksUserLengthGuardOnDiscard(state, card, userSeats) {
    if (state.trick.length === 0) return false;
    const ledSuit = state.trick[0].suit;
    if (card.suit === ledSuit) return false;
    const { SEATS } = P();
    const maxUserLength = Math.max(0, ...[...userSeats]
      .map(seat => (state.remaining?.[seat]?.[card.suit] || []).length));
    if (maxUserLength < 2) return false;

    const ownLength = (state.remaining?.[state.turn]?.[card.suit] || []).length;
    if (ownLength < maxUserLength || ownLength - 1 >= maxUserLength) return false;

    return SEATS.filter(seat => !userSeats.has(seat) && seat !== state.turn)
      .every(seat => (state.remaining?.[seat]?.[card.suit] || []).length < maxUserLength);
  }

  function overtakesPartnerWinner(state, card, userSeats) {
    if (state.trick.length === 0) return false;
    const RVAL = P().RVAL;
    const ledSuit = state.trick[0].suit;
    if (card.suit !== ledSuit) return false;
    const cardRV = RVAL[card.rank];
    let partnerBest = -1;
    for (const t of state.trick) {
      if (!userSeats.has(t.seat) && t.suit === ledSuit)
        partnerBest = Math.max(partnerBest, RVAL[t.rank]);
    }
    if (partnerBest < 0) return false;
    let userBest = -1;
    for (const t of state.trick) {
      if (userSeats.has(t.seat) && t.suit === ledSuit)
        userBest = Math.max(userBest, RVAL[t.rank]);
    }
    if (!(partnerBest > userBest && cardRV > partnerBest)) return false;

    // Do not protect a merely temporary winner. If a user-side hand still to
    // play can beat partner's card, overtaking is normal third-hand play.
    const playedSeats = new Set(state.trick.map(t => t.seat));
    for (const seat of userSeats) {
      if (playedSeats.has(seat)) continue;
      const hand = state.remaining[seat] || {};
      const legalRanks = (hand[ledSuit] || []).length
        ? (hand[ledSuit] || []).map(rank => ({ suit: ledSuit, rank }))
        : Object.entries(hand).flatMap(([suit, ranks]) => ranks.map(rank => ({ suit, rank })));
      if (legalRanks.some(userCard => overtakesCurrentWinner(state.trick, userCard, state.trump)))
        return false;
    }
    return true;
  }

  // ── Honor-avoidance rule ──────────────────────────────────────────────────

  const HONOR_RANKS = new Set(['A', 'K', 'Q', 'J', 'T']);
  const COVERABLE_HONORS = new Set(['K', 'Q', 'J', 'T']);

  function hasAdjacentBelow(handInSuit, rank) {
    const RVAL = P().RVAL;
    const rv = RVAL[rank];
    if (rv == null || !handInSuit || handInSuit.length === 0) return false;
    return handInSuit.some(r => RVAL[r] === rv - 1);
  }

  // True when the seat that played trick[0] is currently winning the partial trick.
  function partnerIsWinning(trick, partnerSeat, trump) {
    const RVAL = P().RVAL;
    let winner = trick[0];
    for (const t of trick.slice(1)) {
      const wT = trump && winner.suit === trump;
      const tT = trump && t.suit === trump;
      if ((tT && !wT) || (tT === wT && t.suit === winner.suit && RVAL[t.rank] > RVAL[winner.rank]))
        winner = t;
    }
    return winner.seat === partnerSeat;
  }

  // True when `card` would overtake the winner of the partial trick. This is
  // intentionally weaker than winsCurrentTrick: third hand may correctly
  // force fourth hand to spend a higher card even when it cannot win for sure.
  function overtakesCurrentWinner(trick, card, trump) {
    const RVAL = P().RVAL;
    let winner = trick[0];
    for (const t of trick.slice(1)) {
      const winnerIsTrump = !!(trump && winner.suit === trump);
      const tIsTrump = !!(trump && t.suit === trump);
      if ((tIsTrump && !winnerIsTrump)
          || (tIsTrump === winnerIsTrump
              && t.suit === winner.suit
              && RVAL[t.rank] > RVAL[winner.rank]))
        winner = t;
    }
    const winnerIsTrump = !!(trump && winner.suit === trump);
    const cardIsTrump = !!(trump && card.suit === trump);
    if (cardIsTrump !== winnerIsTrump) return cardIsTrump;
    return card.suit === winner.suit && RVAL[card.rank] > RVAL[winner.rank];
  }

  // True when playing an honor is unnecessary given the bridge situation.
  // Exceptions where an honor IS correct (returns false):
  //   • Leading top of a sequence (touching lower card still in hand)
  //   • 2nd hand covering an unsupported honor led by user side
  //   • 3rd hand when partner is NOT already winning (3rd-hand-high to try to win)
  // `suitHasNonHonorCand` pre-computed by selectAdversaryCard.
  function playsUnnecessaryHonor(state, card, userSeats, suitHasNonHonorCand) {
    if (!HONOR_RANKS.has(card.rank)) return false;
    if (!suitHasNonHonorCand.has(card.suit)) return false;

    const trick = state.trick;
    const hand = (state.remaining || {})[state.turn] || {};
    const handInSuit = hand[card.suit] || [];

    // 1st hand: sequence lead is natural; isolated honor is not.
    if (trick.length === 0)
      return !hasAdjacentBelow(handInSuit, card.rank);

    // 2nd hand (user led): second-hand-low, except cover an unsupported honor.
    if (trick.length === 1 && state.trickLeader && userSeats.has(state.trickLeader)) {
      const ledCard = trick[0];
      if (COVERABLE_HONORS.has(ledCard.rank)) {
        const leaderHand = (state.remaining || {})[state.trickLeader] || {};
        const leaderInSuit = leaderHand[ledCard.suit] || [];
        if (!hasAdjacentBelow(leaderInSuit, ledCard.rank)
            && !promotesUserCard(state, card, userSeats)) return false; // unsupported → cover
      }
      return true; // second-hand-low otherwise
    }

    // 3rd hand (adversary partner led):
    // Third-hand-high applies when the honor overtakes the current winner,
    // even if partner is temporarily in front: fourth hand may otherwise win
    // cheaply (for example, C5-C2-C6 lets C9 score). An honor that cannot
    // overtake the current winner is still wasted (for example CK under CA).
    if (trick.length === 2 && state.trickLeader && !userSeats.has(state.trickLeader))
      return !overtakesCurrentWinner(trick, card, state.trump);

    // Fourth hand: an honor that takes the trick is purposeful. Without this
    // exception Q was incorrectly penalized in D2-D9-DT-DQ, allowing D7 to
    // concede the trick instead.
    if (trick.length === 3)
      return !winsCurrentTrick(state, card);

    return true;
  }

  // With touching honors third hand plays the lowest card that does the job:
  // from Q-J-T over partner's low card, play T rather than Q or J.
  function playsAboveBottomOfSequence(state, card, userSeats) {
    const trick = state.trick;
    if (trick.length !== 2 || !state.trickLeader || userSeats.has(state.trickLeader))
      return false;
    if (!overtakesCurrentWinner(trick, card, state.trump)) return false;
    const { RVAL } = P();
    const hand = state.remaining[state.turn]?.[card.suit] || [];
    const cardRV = RVAL[card.rank];
    return hand.some(rank => RVAL[rank] === cardRV - 1
      && overtakesCurrentWinner(trick, { suit: card.suit, rank }, state.trump));
  }

  function playsBelowThirdHandHigh(state, card, userSeats) {
    const trick = state.trick;
    if (trick.length !== 2 || !state.trickLeader || userSeats.has(state.trickLeader))
      return false;
    const ledSuit = trick[0].suit;
    if (card.suit !== ledSuit) return false;
    // Third-hand high is unnecessary when this low card still guarantees that
    // the partnership wins the trick. Preserve the honor and let partner's
    // existing winner hold.
    if (state.tricks && sideWinsCurrentTrick(state, card)) return false;
    const { RVAL } = P();
    const sufficientHonors = (state.remaining[state.turn]?.[ledSuit] || [])
      .filter(rank => RVAL[rank] >= RVAL.T
        && overtakesCurrentWinner(trick, { suit: ledSuit, rank }, state.trump))
      .sort((a, b) => RVAL[a] - RVAL[b]);
    return sufficientHonors.length > 0 && RVAL[card.rank] < RVAL[sufficientHonors[0]];
  }

  // Second hand should cover an unsupported honor when an available card can
  // overtake it. Merely exempting the covering card from honor avoidance is
  // insufficient: a low card could otherwise win on practical-tree traps.
  function missesRequiredHonorCover(state, card, userSeats) {
    const trick = state.trick;
    if (trick.length !== 1 || !state.trickLeader || !userSeats.has(state.trickLeader))
      return false;
    const ledCard = trick[0];
    if (!COVERABLE_HONORS.has(ledCard.rank)) return false;
    const leaderSuit = state.remaining[state.trickLeader]?.[ledCard.suit] || [];
    if (hasAdjacentBelow(leaderSuit, ledCard.rank)) return false;

    const { RVAL } = P();
    const hand = state.remaining[state.turn]?.[ledCard.suit] || [];
    const covering = hand
      .filter(rank => RVAL[rank] > RVAL[ledCard.rank])
      .sort((a, b) => RVAL[a] - RVAL[b]);
    if (!covering.length) return false;
    // Do not force a textbook cover when that cover immediately establishes
    // another visible declarer card. Problem 42: SQ over ST promotes SJ.
    if (promotesUserCard(state, { suit: ledCard.suit, rank: covering[0] }, userSeats))
      return false;
    return card.suit !== ledCard.suit || card.rank !== covering[0];
  }

  // True when leading this suit reveals which finesse to take, removing a declarer guess.
  // Patterns: declarer holds KJ (adversary has A), AQ (adversary has K), AJ (adversary has Q).
  // The leading seat itself must hold the resolving honor — partner holding it doesn't resolve it.
  function resolvesDeclarerGuess(state, card, userSeats, declarer) {
    if (state.trick.length !== 0) return false; // only applies to leads
    const { RVAL, SEATS, partner } = P();
    const dummy = partner(declarer);
    const suit = card.suit;

    // Combined honors held by declarer+dummy in this suit
    const decl = new Set(
      [...(state.remaining[declarer]?.[suit] || []), ...(state.remaining[dummy]?.[suit] || [])]
        .map(r => RVAL[r])
    );
    // Honors held specifically by the seat that is leading
    const leadHand = (state.remaining[state.turn]?.[suit] || []).map(r => RVAL[r]);

    const A = 14, K = 13, Q = 12, J = 11;
    const dHas = rv => decl.has(rv);
    const lHas = rv => leadHand.includes(rv);

    // Declarer has KJ without A — leading seat holds A → reveals which way to finesse
    if (dHas(K) && dHas(J) && !dHas(A) && lHas(A)) return true;
    // Declarer has AQ without K — leading seat holds K → resolves AQ finesse
    if (dHas(A) && dHas(Q) && !dHas(K) && lHas(K)) return true;
    // Declarer has AJ without K or Q — leading seat holds Q → resolves AJ guess
    if (dHas(A) && dHas(J) && !dHas(K) && !dHas(Q) && lHas(Q)) return true;

    return false;
  }

  // Avoid a passive lead into declarer's long, honor-rich suit when partner's
  // honor is surrounded by declarer-side honors. Such a lead often performs
  // declarer's finesse for them. This is only a tie-break among DD-equivalent
  // cards; tactical and setting plays remain protected by DDS.
  function leadsIntoUserLongTenace(state, card, userSeats) {
    if (state.trick.length !== 0) return false;
    const { RVAL, SEATS, partner } = P();
    const suit = card.suit;
    let userLength = 0, defenderLength = 0, userHonors = 0;
    const userRanks = new Set();
    for (const seat of SEATS) {
      for (const rank of state.remaining?.[seat]?.[suit] || []) {
        if (userSeats.has(seat)) {
          userLength++;
          userRanks.add(RVAL[rank]);
          if (RVAL[rank] >= RVAL.J) userHonors++;
        } else defenderLength++;
      }
    }
    if (userLength <= defenderLength || userHonors < 2) return false;

    const partnerSeat = partner(state.turn);
    return (state.remaining?.[partnerSeat]?.[suit] || []).some(rank => {
      const rv = RVAL[rank];
      return rv >= RVAL.T && [...userRanks].some(value => value > rv)
        && [...userRanks].some(value => value < rv);
    });
  }

  function ipsPenalty(state, card, userSeats, declarer) {
    return (promotesUserCard(state, card, userSeats) ? 1 : 0)
         + (discardsIntoDeclarerSuit(state, card, userSeats) ? 1 : 0)
         + (unguardsUserSuitOnDiscard(state, card, userSeats) ? 1 : 0)
         + (breaksUserLengthGuardOnDiscard(state, card, userSeats) ? 1 : 0)
         + (overtakesPartnerWinner(state, card, userSeats) ? 1 : 0)
         + (resolvesDeclarerGuess(state, card, userSeats, declarer) ? 1 : 0)
         + (leadsIntoUserLongTenace(state, card, userSeats) ? 1 : 0);
  }

  // ── Partnership carding ──────────────────────────────────────────────────

  function agreementFor(state, seat) {
    const side = P().sideOf(seat);
    return normalizeAgreement(state.carding?.[side] ?? defaultCarding[side]);
  }

  function originalHolding(state, seat, suit) {
    return state.originalRemaining?.[seat]?.[suit]
      || state.remaining?.[seat]?.[suit]
      || [];
  }

  function likesSuit(state, seat, suit) {
    const hand = state.remaining?.[seat]?.[suit] || [];
    const { RVAL } = P();
    const hasProspectiveHonor = hand.some(rank => RVAL[rank] >= RVAL.T);
    const canRuffSoon = !!(state.trump && suit !== state.trump
      && (state.remaining?.[seat]?.[state.trump] || []).length > 0
      && originalHolding(state, seat, suit).length <= 2);
    return hasProspectiveHonor || canRuffSoon;
  }

  // Attitude to partner's honor lead is about a card that can actually help
  // cash the suit, not merely about holding some honor.  In particular, on an
  // ace lead Q/J/T do not justify encouragement: partner needs the king (or a
  // genuine ruffing prospect).  The same sequence logic applies to the other
  // standard honor leads.
  function likesPartnerLeadSuit(state, seat, suit) {
    const hand = state.remaining?.[seat]?.[suit] || [];
    const lead = state.trick?.[0];
    const requestedSupport = { A: 'K', K: 'Q', Q: 'J', J: 'T', T: '9' }[lead?.rank];
    const canRuffSoon = !!(state.trump && suit !== state.trump
      && (state.remaining?.[seat]?.[state.trump] || []).length > 0
      && originalHolding(state, seat, suit).length <= 2);
    return requestedSupport ? hand.includes(requestedSupport) || canRuffSoon
      : likesSuit(state, seat, suit);
  }

  function extremePenalty(card, peers, preferLow) {
    const sameSuit = peers.filter(peer => peer.suit === card.suit);
    if (sameSuit.length < 2) return 0;
    const target = preferLow
      ? Math.min(...sameSuit.map(peer => peer.rankVal))
      : Math.max(...sameSuit.map(peer => peer.rankVal));
    return card.rankVal === target ? 0 : 1;
  }

  function attitudePrefersLow(agreement, encourage) {
    return agreement === 'UDCA' ? encourage : !encourage;
  }

  function countPrefersLow(agreement, even) {
    return agreement === 'UDCA' ? even : !even;
  }

  function priorCountSignals(state, seat, suit, declarer) {
    const dummy = P().partner(declarer);
    return (state.playHistory || []).filter(play => play.seat === seat
      && play.suit === suit && !play.isDiscard
      && (play.leader === declarer || play.leader === dummy));
  }

  function preferredLeadRank(state, seat, suit) {
    const { RVAL } = P();
    const opening = (state.playHistory || []).length === 0;
    const holding = [...(state.remaining?.[seat]?.[suit] || [])]
      .sort((a, b) => RVAL[b] - RVAL[a]);
    if (!holding.length) return null;
    const has = rank => holding.includes(rank);
    const suitContract = !!state.trump;
    const highLevelOrDoubled = (state.contractLevel || 0) >= 5 || state.contractDoubled;

    // Honor leads and their card-request meanings.
    if (suitContract && has('A') && has('K')) {
      if (highLevelOrDoubled) return has('Q') ? 'Q' : 'K';
      return 'A';
    }
    if (!suitContract && has('A') && has('K')) return 'K';
    if (!suitContract && has('Q') && has('J')) return 'Q';
    if (opening && suitContract) {
      for (const rank of ['K', 'Q', 'J', 'T'])
        if (has(rank) && has(IVAL_OR_NULL(RVAL[rank] - 1))) return rank;
    }

    // In NT, when returning partner's suit from an original five-card holding,
    // return original fourth best.
    if (!opening && !suitContract && originalHolding(state, seat, suit).length === 5) {
      const partnerSeat = P().partner(seat);
      const partnerLedSuit = (state.playHistory || []).some(play =>
        play.seat === partnerSeat && play.position === 0 && play.suit === suit);
      if (partnerLedSuit) return originalHolding(state, seat, suit)[3];
    }

    const n = holding.length;
    const hasHonor = holding.some(rank => RVAL[rank] >= RVAL.T);
    if (!suitContract && n === 3)
      return hasHonor ? holding[n - 1] : holding[0]; // low from Hxx; top from 9xx or worse

    const useThirdFifth = suitContract || (state.contractLevel || 0) >= 4;
    const index = useThirdFifth
      ? (n % 2 === 1 ? Math.min(4, n - 1) : Math.min(2, n - 1))
      : (n % 2 === 1 ? Math.min(1, n - 1) : Math.min(3, n - 1));
    return holding[index];
  }

  function IVAL_OR_NULL(value) { return P().IVAL[value] || null; }

  const SUIT_PREFERENCE_ORDER = ['C', 'D', 'H', 'S'];

  function requestedSuitFromLastRuff(state) {
    if (!state.trump || state.trick.length !== 0 || !state.tricks?.length) return null;
    const last = state.tricks[state.tricks.length - 1];
    if (last.winner !== state.turn || !last.cards?.length) return null;
    const ledSuit = last.cards[0].suit;
    const winningCard = last.cards.find(play => play.seat === last.winner);
    if (!winningCard || winningCard.suit !== state.trump || ledSuit === state.trump) return null;

    const partnerSeat = P().partner(state.turn);
    const signal = last.cards.find(play => play.seat === partnerSeat);
    if (!signal) return null;
    const { RVAL } = P();
    const holdingAtSignal = [...(state.remaining?.[partnerSeat]?.[signal.suit] || []), signal.rank]
      .sort((a, b) => RVAL[a] - RVAL[b]);
    if (holdingAtSignal.length < 2) return null;
    const lowSignal = signal.rank === holdingAtSignal[0];
    const highSignal = signal.rank === holdingAtSignal[holdingAtSignal.length - 1];
    if (!lowSignal && !highSignal) return null;

    const sideSuits = SUIT_PREFERENCE_ORDER
      .filter(suit => suit !== state.trump && suit !== ledSuit);
    if (sideSuits.length < 2) return null;
    return lowSignal ? sideSuits[0] : sideSuits[sideSuits.length - 1];
  }

  function leadCardingPenalty(state, card) {
    const requestedSuit = requestedSuitFromLastRuff(state);
    const rankPenalty = card.rank === preferredLeadRank(state, state.turn, card.suit) ? 0 : 1;
    return requestedSuit ? (card.suit === requestedSuit ? rankPenalty : 2) : rankPenalty;
  }

  // Returns null when this is not a suit-preference situation. Otherwise low
  // asks for the lower-ranking remaining side suit and high for the higher,
  // independent of STD/UDCA.
  function suitPreferencePenalty(state, card, peers) {
    if (!state.trump) return null;
    const { partner } = P();
    const partnerSeat = partner(state.turn);
    if (state.trick.some(play => play.seat === partnerSeat)) return null;

    const signalSuit = state.trick.length ? state.trick[0].suit : card.suit;
    const partnerHand = state.remaining?.[partnerSeat] || {};
    if ((partnerHand[signalSuit] || []).length > 0
        || (partnerHand[state.trump] || []).length === 0) return null;

    const sideSuits = SUIT_PREFERENCE_ORDER
      .filter(suit => suit !== state.trump && suit !== signalSuit);
    if (sideSuits.length < 2) return null;
    const lowerSuit = sideSuits[0], higherSuit = sideSuits[sideSuits.length - 1];
    const likesLower = likesSuit(state, state.turn, lowerSuit);
    const likesHigher = likesSuit(state, state.turn, higherSuit);
    if (likesLower === likesHigher) return null; // no unambiguous preference

    return extremePenalty(card, peers, likesLower);
  }

  function cardingPenalty(state, card, peers, declarer) {
    const { sideOf, partner, RVAL } = P();
    if (sideOf(state.turn) === sideOf(declarer)) return 0;
    const agreement = agreementFor(state, state.turn);
    const trick = state.trick;

    const suitPreference = suitPreferencePenalty(state, card, peers);
    if (suitPreference != null) return suitPreference;

    if (trick.length === 0) return leadCardingPenalty(state, card);

    const ledSuit = trick[0].suit;
    const isDiscard = card.suit !== ledSuit;
    const partnerLed = state.trickLeader === partner(state.turn);
    const declarerLed = state.trickLeader === declarer || state.trickLeader === partner(declarer);

    // First discard is attitude. Prefer a suit with a real prospect, then use
    // the selected partnership's high/low encoding within that suit.
    if (isDiscard && (state.discardCount?.[state.turn] || 0) === 0) {
      const likedSuits = new Set(peers.filter(peer => likesSuit(state, state.turn, peer.suit))
        .map(peer => peer.suit));
      const encourage = likesSuit(state, state.turn, card.suit);
      const suitPenalty = likedSuits.size && !encourage ? 1 : 0;
      const sameSuitCount = peers.filter(peer => peer.suit === card.suit).length;
      const anotherSuitCanSignal = peers.some(peer => peer.suit !== card.suit
        && peers.filter(other => other.suit === peer.suit).length > 1);
      const clarityPenalty = sameSuitCount < 2 && anotherSuitCanSignal ? 1 : 0;
      const honorSignalPenalty = RVAL[card.rank] >= RVAL.T
        && peers.some(peer => RVAL[peer.rank] < RVAL.T) ? 2 : 0;
      return suitPenalty + clarityPenalty + honorSignalPenalty
        + extremePenalty(card, peers, attitudePrefersLow(agreement, encourage));
    }

    if (!isDiscard && partnerLed) {
      const encourage = likesPartnerLeadSuit(state, state.turn, ledSuit);
      let penalty = extremePenalty(card, peers,
        attitudePrefersLow(agreement, encourage));
      // Do not spend an honor merely as an attitude signal when a spot card is
      // available. Honors required to overtake are genuine plays, not signals.
      if (RVAL[card.rank] >= RVAL.T
          && !overtakesCurrentWinner(trick, card, state.trump)
          && peers.some(peer => peer.suit === ledSuit && RVAL[peer.rank] < RVAL.T))
        penalty += 2;
      return penalty;
    }

    if (!isDiscard && declarerLed) {
      const even = originalHolding(state, state.turn, ledSuit).length % 2 === 0;
      const prior = priorCountSignals(state, state.turn, ledSuit, declarer).length;
      const preferLow = prior % 2 === 0
        ? countPrefersLow(agreement, even)
        : !countPrefersLow(agreement, even);
      const honorSignalPenalty = RVAL[card.rank] >= RVAL.T
        && peers.some(peer => peer.suit === ledSuit && RVAL[peer.rank] < RVAL.T)
        ? 2 : 0;
      return honorSignalPenalty + extremePenalty(card, peers, preferLow);
    }
    return 0;
  }

  // True when playing `card` wins the current trick for certain — no remaining player can beat it.
  // Considers must-follow-suit and ruff rules. No DDS call needed.
  function winsCurrentTrick(state, card) {
    const { RVAL, SEATS } = P();
    const trump = state.trump || null;
    const ledSuit = state.trick.length > 0 ? state.trick[0].suit : card.suit;
    const cardRV = RVAL[card.rank];
    const cardIsTrump = !!(trump && card.suit === trump);
    const cardInLedSuit = card.suit === ledSuit;

    // Check C beats all cards already in the trick
    for (const t of state.trick) {
      const tIsTrump = !!(trump && t.suit === trump);
      const tRV = RVAL[t.rank];
      if (!cardIsTrump && tIsTrump) return false;                               // trump already played beats C
      if (cardIsTrump && tIsTrump && tRV > cardRV) return false;               // higher trump beats C
      if (!cardIsTrump && !tIsTrump && t.suit === ledSuit && !cardInLedSuit) return false; // off-suit C loses to led suit
      if (!cardIsTrump && !tIsTrump && t.suit === ledSuit && cardInLedSuit && tRV > cardRV) return false; // higher led-suit card beats C
    }

    // Check no remaining player can beat C
    const playedSeats = new Set([...state.trick.map(t => t.seat), state.turn]);
    for (const seat of SEATS) {
      if (playedSeats.has(seat)) continue;
      const hand = state.remaining[seat] || {};
      const inLed = hand[ledSuit] || [];
      const inTrump = trump ? (hand[trump] || []) : [];

      if (inLed.length > 0) {
        // Must follow led suit
        if (cardInLedSuit && inLed.some(r => RVAL[r] > cardRV)) return false; // higher led-suit card
        if (!cardInLedSuit && !cardIsTrump) return false;                       // any led-suit card beats a discard
        // If C is trump: following led suit can't beat a trump — OK
      } else {
        // Void in led suit — can ruff or discard
        if (cardIsTrump && inTrump.some(r => RVAL[r] > cardRV)) return false;  // higher trump beats C
        if (!cardIsTrump && inTrump.length > 0) return false;                   // any ruff beats non-trump C
      }
    }
    return true;
  }

  function winsSettingTrick(state, card, declarer) {
    if (state.contractLevel == null || !winsCurrentTrick(state, card)) return false;
    const defenderTricks = P().sideOf(declarer) === 'NS' ? state.ewTricks : state.nsTricks;
    return defenderTricks + 1 >= 8 - state.contractLevel;
  }

  // True when this defender can win the current trick personally, retain the
  // lead, and then lead a side suit that partner can ruff for the setting
  // trick. This is different from merely guaranteeing that the partnership
  // wins the current trick: the entry may need to be in this particular hand.
  function winsThenGivesSettingRuff(state, card, declarer) {
    if (state.contractLevel == null || !state.trump || state.trick.length === 0
        || !winsCurrentTrick(state, card)) return false;

    const { cloneState, applyCard, legalMoves, partner, sideOf, RVAL, SEATS } = P();
    const winningSeat = state.turn;
    const defendingSide = sideOf(winningSeat);
    if (defendingSide === sideOf(declarer)) return false;
    const partnerSeat = partner(winningSeat);
    const defenderTricks = sideOf(declarer) === 'NS' ? state.ewTricks : state.nsTricks;
    const tricksToSet = 8 - state.contractLevel;
    if (defenderTricks + 2 < tricksToSet) return false;

    const afterCard = cloneState(state);
    applyCard(afterCard, { suit: card.suit, rank: card.rank });

    function hasCertainRuff(position) {
      const completed = position.tricks?.[position.tricks.length - 1];
      if (!completed || completed.winner !== winningSeat || position.turn !== winningSeat)
        return false;
      const partnerTrumps = position.remaining?.[partnerSeat]?.[position.trump] || [];
      if (!partnerTrumps.length) return false;
      const partnerTopTrump = Math.max(...partnerTrumps.map(rank => RVAL[rank]));

      return Object.keys(position.remaining[winningSeat] || {}).some(suit => {
        if (suit === position.trump || !(position.remaining[winningSeat]?.[suit] || []).length)
          return false;
        if ((position.remaining[partnerSeat]?.[suit] || []).length) return false;

        // Every opponent must either follow suit or be unable to overruff
        // partner's highest trump.
        return SEATS.filter(seat => sideOf(seat) !== defendingSide).every(seat => {
          if ((position.remaining?.[seat]?.[suit] || []).length) return true;
          return !(position.remaining?.[seat]?.[position.trump] || [])
            .some(rank => RVAL[rank] > partnerTopTrump);
        });
      });
    }

    function canArrange(position) {
      if (position.trick.length === 0) return hasCertainRuff(position);
      const moves = legalMoves(position, position.turn);
      if (!moves.length) return false;
      const results = moves.map(move => {
        const next = cloneState(position);
        applyCard(next, move);
        return canArrange(next);
      });
      return sideOf(position.turn) === defendingSide
        ? results.some(Boolean)
        : results.every(Boolean);
    }
    return canArrange(afterCard);
  }

  // Whether this play guarantees that the partnership—not necessarily this
  // particular card—wins the current trick against every legal continuation.
  // This avoids confusing "play an overtaking card" with "preserve the trick"
  // when partner is already winning.
  function sideWinsCurrentTrick(state, card) {
    if (state.trick.length === 0) return false;
    const { cloneState, applyCard, legalMoves, sideOf } = P();
    const targetSide = sideOf(state.turn);
    const clone = cloneState(state);
    applyCard(clone, { suit: card.suit, rank: card.rank });

    function everyContinuationWins(position) {
      if (position.trick.length === 0) {
        const completed = position.tricks[position.tricks.length - 1];
        return !!completed && sideOf(completed.winner) === targetSide;
      }
      const moves = legalMoves(position, position.turn);
      return moves.length > 0 && moves.every(move => {
        const next = cloneState(position);
        applyCard(next, move);
        return everyContinuationWins(next);
      });
    }
    return everyContinuationWins(clone);
  }

  // ── Adversary selection ───────────────────────────────────────────────────

  // DDS protects any line that can defeat the contract. If perfect defense
  // cannot set the contract, the practical search may also consider cards one
  // DD trick below best: conceding an overtrick can be worthwhile when it
  // creates a realistic chance for declarer to go down (a bridge "swindle").
  const PRACTICAL_CONFIG = Object.freeze({
    userDecisionDepth: 3,
    futureDiscount: 0.6,
    lossStepValue: 0.5,
    maxSolvesPerCandidate: 12,
    maxOptimalBranches: 2,
    maxDeepCandidates: 4,
    maxSwindleDdLoss: 1,
  });

  // Small, deterministic imperfect-information sample. One DDS call scores
  // every candidate in a sampled world, so this is a world budget rather than
  // a candidates × worlds budget. The seed contains only information visible to
  // the acting player; changing the actual hidden split therefore cannot change
  // the generated sample.
  const BELIEF_CONFIG = Object.freeze({
    maxWorlds: 8,
    maxAttempts: 240,
  });

  function cardKey(card) { return card.suit + card.rank; }

  function visibleSeatsFor(state, actor) {
    const { partner } = P();
    const declarer = state.declarer;
    const dummy = state.dummy || partner(declarer);
    if (actor === declarer || actor === dummy) return new Set([declarer, dummy]);
    // Dummy is exposed only after the opening lead.
    return new Set((state.playHistory || []).length || state.trick.length
      ? [actor, dummy]
      : [actor]);
  }

  function publicVoids(state) {
    const voids = Object.fromEntries(P().SEATS.map(seat => [seat, new Set()]));
    for (const play of state.playHistory || []) {
      if (!play.isDiscard) continue;
      const trick = (state.tricks || [])[play.trickIndex];
      const ledSuit = trick?.cards?.[0]?.suit
        || (play.trickIndex === (state.tricks || []).length ? state.trick?.[0]?.suit : null);
      if (ledSuit) voids[play.seat].add(ledSuit);
    }
    return voids;
  }

  function beliefSeed(state, actor, visible, hidden, pool) {
    const visibleCards = [...visible].sort().map(seat =>
      seat + ':' + P().SUITS.map(suit => (state.remaining?.[seat]?.[suit] || []).join('')).join('.'));
    const publicPlay = (state.playHistory || []).map(p => p.seat + p.suit + p.rank).join('');
    const counts = hidden.map(seat => seat + P().cardsInHand(state, seat).length).join('');
    const text = [actor, state.turn, state.trump || 'N', publicPlay, counts,
      visibleCards.join('|'), [...pool].sort().join('')].join('#');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function seededRandom(seed) {
    let value = seed >>> 0;
    return () => {
      value += 0x6D2B79F5;
      let t = value;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffled(items, random) {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  function sampleHiddenWorlds(state, actor, limit = BELIEF_CONFIG.maxWorlds) {
    const { SEATS, SUITS, cloneState, cardsInHand } = P();
    const visible = visibleSeatsFor(state, actor);
    const hidden = SEATS.filter(seat => !visible.has(seat));
    if (hidden.length < 2 || limit <= 0) return [cloneState(state)];

    const capacities = Object.fromEntries(hidden.map(seat => [seat, cardsInHand(state, seat).length]));
    const pool = hidden.flatMap(seat => cardsInHand(state, seat)
      .map(card => ({ suit: card.suit, rank: card.rank })))
      .sort((a, b) => cardKey(a).localeCompare(cardKey(b)));
    const voids = publicVoids(state);
    const random = seededRandom(beliefSeed(state, actor, visible, hidden,
      pool.map(cardKey)));
    const worlds = [];
    const seen = new Set();

    for (let attempt = 0; attempt < BELIEF_CONFIG.maxAttempts && worlds.length < limit; attempt++) {
      const allocation = Object.fromEntries(hidden.map(seat => [seat, []]));
      const remaining = { ...capacities };
      let failed = false;
      for (const card of shuffled(pool, random)) {
        const eligible = hidden.filter(seat => remaining[seat] > 0 && !voids[seat].has(card.suit));
        if (!eligible.length) { failed = true; break; }
        // Prefer the seat with most capacity left, randomizing exact ties.
        const maxLeft = Math.max(...eligible.map(seat => remaining[seat]));
        const choices = eligible.filter(seat => remaining[seat] === maxLeft);
        const seat = choices[Math.floor(random() * choices.length)];
        allocation[seat].push(card);
        remaining[seat]--;
      }
      if (failed || hidden.some(seat => remaining[seat] !== 0)) continue;

      const signature = hidden.map(seat => seat + ':' + allocation[seat]
        .map(cardKey).sort().join(',')).join('|');
      if (seen.has(signature)) continue;
      seen.add(signature);

      const world = cloneState(state);
      for (const seat of hidden) {
        world.remaining[seat] = Object.fromEntries(SUITS.map(suit => [suit,
          allocation[seat].filter(card => card.suit === suit).map(card => card.rank)
            .sort((a, b) => P().RVAL[b] - P().RVAL[a])
        ]));
      }
      worlds.push(world);
    }
    return worlds.length ? worlds : [cloneState(state)];
  }

  function scoreInFutureTricks(ft, card) {
    const { SUITS, RVAL } = P();
    const rv = RVAL[card.rank];
    for (let i = 0; i < ft.cards; i++) {
      if (SUITS[ft.suit[i]] !== card.suit) continue;
      if (ft.rank[i] === rv || ((ft.equals[i] >> rv) & 1)) return ft.score[i];
    }
    return null;
  }

  function evaluateBeliefCandidates(dds, state, candidates, actor = state.turn) {
    const worlds = sampleHiddenWorlds(state, actor);
    const values = new Map(candidates.map(card => [cardKey(card), []]));
    for (const world of worlds) {
      const ft = dds.SolveBoardPBN(P().toDealPbn(world), -1, 3, 0);
      for (const card of candidates) {
        const score = scoreInFutureTricks(ft, card);
        if (score != null) values.get(cardKey(card)).push(score);
      }
    }
    return new Map(candidates.map(card => {
      const scores = values.get(cardKey(card));
      return [cardKey(card), {
        expected: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : -Infinity,
        worst: scores.length ? Math.min(...scores) : -Infinity,
        scores,
        worlds: worlds.length,
      }];
    }));
  }

  let lastDecision = null;

  function expandFutureTricks(ft) {
    const { SUITS, IVAL } = P();
    const cards = [];
    for (let i = 0; i < ft.cards; i++) {
      const suitIdx = ft.suit[i];
      cards.push({
        suit: SUITS[suitIdx], rank: IVAL[ft.rank[i]], rankVal: ft.rank[i],
        suitIdx, score: ft.score[i], classIndex: i,
      });
      for (let r = 2; r < ft.rank[i]; r++) {
        if ((ft.equals[i] >> r) & 1) {
          cards.push({
            suit: SUITS[suitIdx], rank: IVAL[r], rankVal: r,
            suitIdx, score: ft.score[i], classIndex: i,
          });
        }
      }
    }
    return cards;
  }

  function makeSearchContext(dds, userSeats) {
    const cache = new Map();
    return {
      dds,
      userSeats,
      cache,
      solves: 0,
      truncated: false,
      solve(state) {
        const deal = P().toDealPbn(state);
        const key = JSON.stringify(deal);
        if (cache.has(key)) return cache.get(key);
        if (this.solves >= PRACTICAL_CONFIG.maxSolvesPerCandidate) {
          this.truncated = true;
          return null;
        }
        const ft = dds.SolveBoardPBN(deal, -1, 3, 0);
        this.solves++;
        cache.set(key, ft);
        return ft;
      },
    };
  }

  function advanceToUser(ctx, state) {
    const { applyCard } = P();
    while (!isComplete(state) && !ctx.userSeats.has(state.turn)) {
      const ft = ctx.solve(state);
      if (!ft || !ft.cards) return false;
      const cards = expandFutureTricks(ft);
      const bestScore = Math.max(...cards.map(card => card.score));
      const card = cards
        .filter(candidate => candidate.score === bestScore)
        .sort((a, b) => a.rankVal - b.rankVal || a.suitIdx - b.suitIdx)[0];
      if (!card) return false;
      applyCard(state, card);
    }
    return !isComplete(state);
  }

  // Reduce legal cards to choices a human declarer might realistically make.
  // DDS still grades the result; this filter only prevents absurd plays from
  // inflating a line's trap score.
  function plausibleUserOptions(state, options) {
    if (!options.length || state.trick.length === 0) return options;
    const { RVAL } = P();
    const ledSuit = state.trick[0].suit;
    const followsSuit = (state.remaining[state.turn]?.[ledSuit] || []).length > 0;

    if (followsSuit) {
      const inSuit = options.filter(option => option.suit === ledSuit);
      if (!inSuit.length) return options;
      const low = inSuit.reduce((a, b) => a.rankVal < b.rankVal ? a : b);
      const overtakers = inSuit
        .filter(option => overtakesCurrentWinner(state.trick, option, state.trump))
        .sort((a, b) => a.rankVal - b.rankVal);
      const hasCompleteDeal = P().SEATS.every(seat => state.remaining?.[seat]);
      const certainWinners = inSuit
        .filter(option => hasCompleteDeal
          ? sideWinsCurrentTrick(state, option)
          : winsCurrentTrick(state, option))
        .sort((a, b) => a.rankVal - b.rankVal);
      // Keep the natural low play, the cheapest card that overtakes, and the
      // cheapest card that guarantees the trick. The latter is essential for
      // real finesse guesses: over a low spade, SJ may overtake but lose to a
      // hidden SK, while SA wins for certain. Those are distinct human choices.
      const realistic = [low, overtakers[0], certainWinners[0]].filter(Boolean);
      return realistic.filter((option, index) => realistic.findIndex(other =>
        other.suit === option.suit && other.rank === option.rank) === index);
    }

    // If void in the led suit but able to ruff, trump ranks are materially
    // different choices (under-ruffing can be the whole trap), so retain them.
    const trumpOptions = state.trump
      ? options.filter(option => option.suit === state.trump)
      : [];
    let ruffs = [];
    if (trumpOptions.length) {
      const lowRuff = trumpOptions.reduce((a, b) => a.rankVal < b.rankVal ? a : b);
      const safeRuffs = trumpOptions
        .filter(option => winsCurrentTrick(state, option))
        .sort((a, b) => a.rankVal - b.rankVal);
      ruffs = safeRuffs.length && safeRuffs[0] !== lowRuff
        ? [lowRuff, safeRuffs[0]]
        : [lowRuff];
    }

    // On an ordinary discard, represent each possible side suit by its lowest available card.
    // Thus HA from A62 or D8 from A843 is not counted as a realistic mistake
    // while H2 and D3 remain genuine suit-choice alternatives.
    const lowestBySuit = new Map();
    for (const option of options) {
      if (state.trump && option.suit === state.trump) continue;
      const prior = lowestBySuit.get(option.suit);
      if (!prior || option.rankVal < prior.rankVal) lowestBySuit.set(option.suit, option);
    }
    return [...ruffs, ...lowestBySuit.values()];
  }

  function evaluateUserDecision(ctx, state, depth) {
    const empty = {
      trapCount: 0, immediateValue: 0, futureValue: 0,
      practicalValue: 0, bestScore: null, options: [], truncated: false,
    };
    if (depth <= 0 || isComplete(state) || !ctx.userSeats.has(state.turn)) return empty;

    const ft = ctx.solve(state);
    if (!ft || !ft.cards) return { ...empty, truncated: ctx.truncated };
    const allOptions = expandFutureTricks(ft);
    if (!allOptions.length) return empty;
    const options = plausibleUserOptions(state, allOptions);

    // Following with the only legal card is not a decision and must not consume
    // search depth. This lets the tree see a later, genuine guess in the next
    // trick instead of stopping at a forced card from dummy.
    if (options.length === 1) {
      const clone = P().cloneState(state);
      P().applyCard(clone, options[0]);
      if (!advanceToUser(ctx, clone)) return empty;
      return evaluateUserDecision(ctx, clone, depth);
    }

    const bestScore = Math.max(...options.map(option => option.score));
    let trapCount = 0;
    let immediateValue = 0;
    const details = [];
    const optimal = [];

    for (const option of options) {
      const loss = Math.max(0, bestScore - option.score);
      const trapValue = loss > 0
        ? 1 + (loss - 1) * PRACTICAL_CONFIG.lossStepValue
        : 0;
      if (loss > 0) {
        trapCount++;
        immediateValue += trapValue;
      } else {
        optimal.push(option);
      }
      details.push({ card: option.suit + option.rank, ddScore: option.score, loss, trapValue });
    }

    let futureValue = 0;
    if (depth > 1 && optimal.length && !ctx.truncated) {
      const branches = optimal.slice(0, PRACTICAL_CONFIG.maxOptimalBranches);
      let total = 0;
      let evaluated = 0;
      for (const option of branches) {
        if (ctx.truncated) break;
        const clone = P().cloneState(state);
        P().applyCard(clone, option);
        if (!advanceToUser(ctx, clone)) continue;
        total += evaluateUserDecision(ctx, clone, depth - 1).practicalValue;
        evaluated++;
      }
      if (evaluated) futureValue = total / evaluated;
    }

    return {
      trapCount,
      immediateValue,
      futureValue,
      practicalValue: immediateValue + PRACTICAL_CONFIG.futureDiscount * futureValue,
      bestScore,
      options: details,
      truncated: ctx.truncated,
    };
  }

  function compareEvaluations(a, b, isDiscardTurn, trickInProgress) {
    // A swindle may choose a deceptive lead, but it must not throw away a DD
    // trick after the trick has begun.  At that point DDS can distinguish a
    // genuine duck from allowing an already available winner to disappear.
    if (trickInProgress && a.ddLoss !== b.ddLoss)
      return a.ddLoss - b.ddLoss;
    if (a.winsThenSettingRuff !== b.winsThenSettingRuff)
      return a.winsThenSettingRuff ? -1 : 1;
    if (trickInProgress && a.sideWinsTrick !== b.sideWinsTrick)
      return a.sideWinsTrick ? -1 : 1;
    if (a.winsSettingTrick !== b.winsSettingTrick)
      return a.winsSettingTrick ? -1 : 1;
    if (a.penalty !== b.penalty) return a.penalty - b.penalty;
    // A decoded suit-preference return is mandatory only among equally DD-
    // effective cards. It outranks speculative trap value but never costs a
    // double-dummy trick.
    if (a.suitPreferenceReturn) {
      if (a.ddLoss !== b.ddLoss) return a.ddLoss - b.ddLoss;
      if (a.cardingPenalty !== b.cardingPenalty)
        return a.cardingPenalty - b.cardingPenalty;
    }
    // Once a trick has started, do not surrender a certain defensive trick for
    // a merely speculative declarer trap.  This is deliberately not applied
    // to leads: a passive lead may legitimately create a later losing choice
    // (for example the Problem 55 spade-return swindle).
    if (trickInProgress && a.winsTrick !== b.winsTrick)
      return a.winsTrick ? -1 : 1;
    // During a trick, preserving declarer's TTP outranks a count/attitude
    // signal. On lead, practical trap value remains more important.
    if (trickInProgress && a.ttpGain !== b.ttpGain)
      return a.ttpGain - b.ttpGain;
    // Compare equally DD-effective cards across layouts that are plausible from
    // the acting player's perspective. Never let imperfect-information scoring
    // excuse an actual-deal DD loss.
    if (a.ddLoss === b.ddLoss && a.belief.expected !== b.belief.expected)
      return b.belief.expected - a.belief.expected;
    if (a.ddLoss === b.ddLoss && a.belief.worst !== b.belief.worst)
      return b.belief.worst - a.belief.worst;
    if (a.practical.practicalValue !== b.practical.practicalValue)
      return b.practical.practicalValue - a.practical.practicalValue;
    if (a.practical.trapCount !== b.practical.trapCount)
      return b.practical.trapCount - a.practical.trapCount;
    if (a.ddLoss !== b.ddLoss) return a.ddLoss - b.ddLoss;
    if (a.cardingPenalty !== b.cardingPenalty)
      return a.cardingPenalty - b.cardingPenalty;
    if (a.ttpGain !== b.ttpGain) return a.ttpGain - b.ttpGain;
    if (a.winsTrick !== b.winsTrick) return a.winsTrick ? -1 : 1;
    if (a.card.rankVal !== b.card.rankVal)
      return isDiscardTurn
        ? a.card.rankVal - b.card.rankVal
        : b.card.rankVal - a.card.rankVal;
    return a.card.suitIdx - b.card.suitIdx;
  }

  function selectAdversaryCard(dds, state, userSeats, declarer) {
    const { SUITS, IVAL, toDealPbn, cloneState, applyCard, sideOf } = P();

    const ft = dds.SolveBoardPBN(toDealPbn(state), -1, 3, 0);
    let bestScore = -Infinity;
    for (let i = 0; i < ft.cards; i++)
      if (ft.score[i] > bestScore) bestScore = ft.score[i];

    const contractLevel = state.contractLevel ?? null;
    const defenderTricks = sideOf(declarer) === 'NS' ? state.ewTricks : state.nsTricks;
    const tricksNeededToSet = contractLevel == null
      ? null
      : Math.max(0, (8 - contractLevel) - defenderTricks);
    const perfectDefenseCanSet = tricksNeededToSet != null && bestScore >= tricksNeededToSet;
    const allowedDdLoss = contractLevel != null && !perfectDefenseCanSet
      ? PRACTICAL_CONFIG.maxSwindleDdLoss
      : 0;

    const cands = [];
    for (let i = 0; i < ft.cards; i++) {
      if (ft.score[i] >= bestScore - allowedDdLoss) {
        const suitIdx = ft.suit[i], suit = SUITS[suitIdx];
        cands.push({
          suit, rank: IVAL[ft.rank[i]], rankVal: ft.rank[i], suitIdx,
          ddScore: ft.score[i], ddLoss: bestScore - ft.score[i], classIndex: i,
        });
        for (let r = 2; r < ft.rank[i]; r++)
          if ((ft.equals[i] >> r) & 1)
            cands.push({
              suit, rank: IVAL[r], rankVal: r, suitIdx,
              ddScore: ft.score[i], ddLoss: bestScore - ft.score[i], classIndex: i,
            });
      }
    }

    const ledSuit = state.trick.length > 0 ? state.trick[0].suit : null;
    const isDiscardTurn = ledSuit !== null && state.remaining[state.turn][ledSuit].length === 0;

    const suitHasNonHonorCand = new Set();
    for (const c of cands) if (!HONOR_RANKS.has(c.rank)) suitHasNonHonorCand.add(c.suit);
    const beliefByCard = evaluateBeliefCandidates(dds, state, cands, state.turn);

    const metadata = cands.map(cand => ({
      card: cand,
      ddLoss: cand.ddLoss,
      penalty: ipsPenalty(state, cand, userSeats, declarer)
        + (playsUnnecessaryHonor(state, cand, userSeats, suitHasNonHonorCand) ? 1 : 0)
        + (playsAboveBottomOfSequence(state, cand, userSeats) ? 1 : 0)
        + (playsBelowThirdHandHigh(state, cand, userSeats) ? 1 : 0)
        + (missesRequiredHonorCover(state, cand, userSeats) ? 1 : 0),
      cardingPenalty: cardingPenalty(state, cand, cands, declarer),
      suitPreferenceReturn: requestedSuitFromLastRuff(state),
      winsTrick: winsCurrentTrick(state, cand),
      sideWinsTrick: sideWinsCurrentTrick(state, cand),
      winsSettingTrick: winsSettingTrick(state, cand, declarer),
      winsThenSettingRuff: winsThenGivesSettingRuff(state, cand, declarer),
      ttpGain: userTtpGain(state, cand, userSeats),
      belief: beliefByCard.get(cardKey(cand)),
    }));
    const minPenalty = Math.min(...metadata.map(entry => entry.penalty));
    const representatives = new Map();
    for (const entry of metadata) {
      if (entry.penalty === minPenalty && !representatives.has(entry.card.classIndex))
        representatives.set(entry.card.classIndex, entry.card);
    }

    function practicalFor(cand, depth) {
      const clone = cloneState(state);
      applyCard(clone, { suit: cand.suit, rank: cand.rank });
      const ctx = makeSearchContext(dds, userSeats);
      const hasUserDecision = advanceToUser(ctx, clone);
      const practical = hasUserDecision
        ? evaluateUserDecision(ctx, clone, depth)
        : { trapCount: 0, immediateValue: 0, futureValue: 0, practicalValue: 0, options: [] };
      return { practical, solves: ctx.solves, truncated: ctx.truncated, searchDepth: depth };
    }

    // First inspect the next genuine user choice for every unpenalized class.
    // If that already exposes a trap, deeper work cannot change which classes
    // offer an immediate mistake and is skipped for responsiveness.
    const searchByClass = new Map();
    for (const [classIndex, cand] of representatives)
      searchByClass.set(classIndex, practicalFor(cand, 1));
    const bestImmediate = Math.max(0, ...[...searchByClass.values()]
      .map(result => result.practical.immediateValue));

    if (bestImmediate === 0 && PRACTICAL_CONFIG.userDecisionDepth > 1) {
      const deep = [...representatives.entries()]
        .sort(([, a], [, b]) => b.ddLoss - a.ddLoss || b.rankVal - a.rankVal)
        .slice(0, PRACTICAL_CONFIG.maxDeepCandidates);
      for (const [classIndex, cand] of deep)
        searchByClass.set(classIndex, practicalFor(cand, PRACTICAL_CONFIG.userDecisionDepth));
    }

    const noPractical = {
      practical: { trapCount: 0, immediateValue: 0, futureValue: 0, practicalValue: 0, options: [] },
      solves: 0, truncated: false, searchDepth: 0,
    };
    const evaluations = metadata.map(entry => ({
      ...entry,
      ...(searchByClass.get(entry.card.classIndex) || noPractical),
    }));

    evaluations.sort((a, b) => compareEvaluations(a, b, isDiscardTurn, state.trick.length > 0));
    const chosen = evaluations[0];
    lastDecision = {
      turn: state.turn,
      declarer,
      ddBestScore: bestScore,
      contractLevel,
      tricksNeededToSet,
      perfectDefenseCanSet,
      selected: chosen.card.suit + chosen.card.rank,
      config: { ...PRACTICAL_CONFIG },
      candidates: evaluations.map(e => ({
        card: e.card.suit + e.card.rank,
        ddScore: e.card.ddScore,
        ddLoss: e.ddLoss,
        swindleCandidate: e.ddLoss > 0,
        penalty: e.penalty,
        cardingPenalty: e.cardingPenalty,
        suitPreferenceReturn: e.suitPreferenceReturn,
        winsTrick: e.winsTrick,
        sideWinsTrick: e.sideWinsTrick,
        winsSettingTrick: e.winsSettingTrick,
        winsThenSettingRuff: e.winsThenSettingRuff,
        ttpGain: e.ttpGain,
        beliefExpected: e.belief.expected,
        beliefWorst: e.belief.worst,
        beliefScores: e.belief.scores,
        beliefWorlds: e.belief.worlds,
        trapCount: e.practical.trapCount,
        immediateValue: e.practical.immediateValue,
        futureValue: e.practical.futureValue,
        practicalValue: e.practical.practicalValue,
        solves: e.solves,
        searchDepth: e.searchDepth,
        truncated: e.truncated,
        userOptions: e.practical.options,
      })),
    };
    if (globalThis.BP_IPS_DEBUG) console.table(lastDecision.candidates);
    return { suit: chosen.card.suit, rank: chosen.card.rank, score: chosen.card.ddScore };
  }

  // ── Partner selection ─────────────────────────────────────────────────────

  // Declarer and dummy need a different policy from the defenders. The
  // defensive practical search may consider a one-trick DD concession as a
  // swindle when perfect defense cannot set the contract. Applied to
  // declarer/dummy, that can surrender a makeable contract. Keep their root
  // choice strictly DD-optimal until a declarer-play evaluator is added.
  function selectDeclarerCard(dds, state) {
    const { SUITS, IVAL, toDealPbn } = P();
    const ft = dds.SolveBoardPBN(toDealPbn(state), -1, 3, 0);
    let bestScore = -Infinity;
    for (let i = 0; i < ft.cards; i++) bestScore = Math.max(bestScore, ft.score[i]);
    const optimal = [];
    for (let i = 0; i < ft.cards; i++) {
      if (ft.score[i] !== bestScore) continue;
      const suit = SUITS[ft.suit[i]], suitIdx = ft.suit[i];
      optimal.push({ suit, rank: IVAL[ft.rank[i]], rankVal: ft.rank[i], suitIdx });
      for (let r = 2; r < ft.rank[i]; r++)
        if ((ft.equals[i] >> r) & 1)
          optimal.push({ suit, rank: IVAL[r], rankVal: r, suitIdx });
    }
    if (!optimal.length) return null;
    const belief = evaluateBeliefCandidates(dds, state, optimal, state.turn);
    optimal.sort((a, b) => {
      const av = belief.get(cardKey(a)), bv = belief.get(cardKey(b));
      return bv.expected - av.expected || bv.worst - av.worst
        || a.rankVal - b.rankVal || a.suitIdx - b.suitIdx;
    });
    const chosen = optimal[0];
    lastDecision = {
      turn: state.turn,
      declarer: state.declarer,
      role: 'declarer',
      strictDd: true,
      selected: chosen.suit + chosen.rank,
      ddBestScore: bestScore,
      beliefWorlds: belief.get(cardKey(chosen)).worlds,
      candidates: optimal.map(card => ({
        card: cardKey(card),
        ddScore: bestScore,
        ddLoss: 0,
        beliefExpected: belief.get(cardKey(card)).expected,
        beliefWorst: belief.get(cardKey(card)).worst,
        beliefScores: belief.get(cardKey(card)).scores,
      })),
    };
    return { suit: chosen.suit, rank: chosen.rank, score: bestScore };
  }

  function selectPartnerCard(dds, state, userSeats, declarer) {
    const { SUITS, IVAL, toDealPbn } = P();

    const ft = dds.SolveBoardPBN(toDealPbn(state), -1, 3, 0);
    let bestScore = -Infinity;
    for (let i = 0; i < ft.cards; i++) if (ft.score[i] > bestScore) bestScore = ft.score[i];

    const optimal = [];
    for (let i = 0; i < ft.cards; i++) {
      if (ft.score[i] === bestScore) {
        const suit = SUITS[ft.suit[i]], suitIdx = ft.suit[i];
        optimal.push({ suit, rank: IVAL[ft.rank[i]], rankVal: ft.rank[i], suitIdx });
        for (let r = 2; r < ft.rank[i]; r++)
          if ((ft.equals[i] >> r) & 1)
            optimal.push({ suit, rank: IVAL[r], rankVal: r, suitIdx });
      }
    }
    if (optimal.length === 1) return { suit: optimal[0].suit, rank: optimal[0].rank, score: bestScore };
    const declarerSeats = new Set([declarer, P().partner(declarer)]);
    const suitHasNonHonorCand = new Set();
    for (const card of optimal) if (!HONOR_RANKS.has(card.rank)) suitHasNonHonorCand.add(card.suit);
    const beliefByCard = evaluateBeliefCandidates(dds, state, optimal, state.turn);
    const evaluated = optimal.map(card => ({
      card,
      winsSettingTrick: winsSettingTrick(state, card, declarer),
      winsThenSettingRuff: winsThenGivesSettingRuff(state, card, declarer),
      ttpGain: userTtpGain(state, card, declarerSeats),
      winsTrick: winsCurrentTrick(state, card),
      sideWinsTrick: sideWinsCurrentTrick(state, card),
      hardPenalty: ipsPenalty(state, card, declarerSeats, declarer)
        + (playsUnnecessaryHonor(state, card, declarerSeats, suitHasNonHonorCand) ? 1 : 0)
        + (playsAboveBottomOfSequence(state, card, declarerSeats) ? 1 : 0)
        + (playsBelowThirdHandHigh(state, card, declarerSeats) ? 1 : 0)
        + (missesRequiredHonorCover(state, card, declarerSeats) ? 1 : 0),
      cardingPenalty: cardingPenalty(state, card, optimal, declarer),
      belief: beliefByCard.get(cardKey(card)),
    }));
    evaluated.sort((a, b) =>
      (a.winsSettingTrick !== b.winsSettingTrick ? (a.winsSettingTrick ? -1 : 1) : 0)
      || (a.winsThenSettingRuff !== b.winsThenSettingRuff ? (a.winsThenSettingRuff ? -1 : 1) : 0)
      || (a.sideWinsTrick !== b.sideWinsTrick ? (a.sideWinsTrick ? -1 : 1) : 0)
      || a.hardPenalty - b.hardPenalty
      || (a.winsTrick !== b.winsTrick ? (a.winsTrick ? -1 : 1) : 0)
      || a.ttpGain - b.ttpGain
      // Once safety and promotion costs are equal, send the honest signal
      // before using sampled-world estimates as a speculative tie-breaker.
      || a.cardingPenalty - b.cardingPenalty
      || b.belief.expected - a.belief.expected
      || b.belief.worst - a.belief.worst
      || a.card.rankVal - b.card.rankVal || a.card.suitIdx - b.card.suitIdx);
    const chosen = evaluated[0].card;
    return { suit: chosen.suit, rank: chosen.rank, score: bestScore };
  }

  // ── Public API ────────────────────────────────────────────────────────────

  function isComplete(state) {
    return state.trick.length === 0 && P().cardsInHand(state, 'N').length === 0;
  }

  function selectCard(dds, state, userSeats, declarer) {
    try {
      const { partner } = P();
      const dummy = partner(declarer);
      const isDefending = userSeats.size === 1
        && !userSeats.has(declarer)
        && !userSeats.has(dummy);
      if (isDefending) {
        const partnerSeat = partner([...userSeats][0]);
        if (state.turn === partnerSeat)
          return selectPartnerCard(dds, state, userSeats, declarer);
        if (state.turn === declarer || state.turn === dummy)
          return selectDeclarerCard(dds, state);
      }
      return selectAdversaryCard(dds, state, userSeats, declarer);
    } catch (error) {
      // Never strand the UI in "Solver playing…" if practical evaluation fails.
      console.error('[IPS] practical search failed; using DD fallback', error);
      const fallback = P().ddSuggest(dds, state);
      lastDecision = {
        turn: state.turn,
        declarer,
        fallback: true,
        error: error instanceof Error ? error.message : String(error),
        selected: fallback ? fallback.suit + fallback.rank : null,
        candidates: [],
      };
      if (fallback) return fallback;
      throw error;
    }
  }

  globalThis.bpIps = {
    selectCard, selectAdversaryCard, selectPartnerCard, selectDeclarerCard,
    setCardingAgreements, getCardingAgreements,
    promotesUserCard, userTtpGain,
    discardsIntoDeclarerSuit, unguardsUserSuitOnDiscard,
    breaksUserLengthGuardOnDiscard,
    overtakesPartnerWinner,
    playsUnnecessaryHonor, playsAboveBottomOfSequence, playsBelowThirdHandHigh,
    missesRequiredHonorCover,
    resolvesDeclarerGuess, leadsIntoUserLongTenace,
    winsCurrentTrick, sideWinsCurrentTrick,
    winsSettingTrick, winsThenGivesSettingRuff, ipsPenalty,
    evaluateUserDecision,
    plausibleUserOptions,
    cardingPenalty, suitPreferencePenalty, requestedSuitFromLastRuff,
    preferredLeadRank, likesSuit,
    visibleSeatsFor, sampleHiddenWorlds, evaluateBeliefCandidates,
    getLastDecision: () => lastDecision,
    practicalConfig: PRACTICAL_CONFIG,
    beliefConfig: BELIEF_CONFIG,
  };
})();
