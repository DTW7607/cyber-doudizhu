// games/doudizhu.js
// Modified 2026-11-12 for the owner: capped scoring, spring, final-round voting, no autoplay.
// Original GameNest contributors; Apache-2.0 attribution retained in LICENSE / NOTICE.
// 斗地主 — Landlord card game with 叫抢 (rob bid) and 叫分 (score bid) modes

var SUITS = ['s','h','c','d'];
var RANKS = ['3','4','5','6','7','8','9','10','J','Q','K','A','2'];

exports.name = 'doudizhu';
exports.minPlayers = 3;
exports.maxPlayers = 3;

function rankVal(rank) {
  if (rank === '小王') return 13;
  if (rank === '大王') return 14;
  return RANKS.indexOf(rank);
}

function createDeck() {
  var deck = [];
  for (var r = 0; r < RANKS.length; r++) {
    for (var s = 0; s < SUITS.length; s++) {
      deck.push({ rank: RANKS[r], suit: SUITS[s], id: RANKS[r] + SUITS[s] });
    }
  }
  deck.push({ rank: '小王', suit: '', id: 'SJ' });
  deck.push({ rank: '大王', suit: '', id: 'BJ' });
  return deck;
}

function shuffle(arr) {
  for (var i = arr.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
}

function sortHand(hand) {
  hand.sort(function(a, b) { return rankVal(a.rank) - rankVal(b.rank); });
}

function syncBoard(state) {
  return {
    phase: state.phase,
    hands: state.hands.map(function(h) { return h.map(function(c) { return { ...c }; }); }),
    bottomCards: state.bottomCards.map(function(c) { return { ...c }; }),
    landlord: state.landlord,
    currentBidder: state.currentBidder,
    currentBid: state.currentBid,
    passCount: state.passCount,
    bids: state.bids ? { ...state.bids } : {},
    currentPlayer: state.currentPlayer,
    lastPlay: state.lastPlay ? { player: state.lastPlay.player, cards: state.lastPlay.cards.map(function(c) { return { ...c }; }), play: { ...state.lastPlay.play } } : null,
    passStreak: state.passStreak,
    passed: Array.isArray(state.passed) ? state.passed.slice() : [false, false, false],
    winner: state.winner,
    // NEW fields
    callPhase: state.callPhase,
    eligibleForRob: state.eligibleForRob ? state.eligibleForRob.slice() : [true, true, true],
    gameMultiplier: state.gameMultiplier || 1,
    baseScore: 1, multiplierCap: 128, spring: state.spring || null,
    playCounts: (state.playCounts || [0, 0, 0]).slice(), roundSettled: !!state.roundSettled,
    currentTurnDeadline: state.currentTurnDeadline,
    cumulativeScore: state.cumulativeScore ? state.cumulativeScore.slice() : [],
    roundHistory: state.roundHistory ? state.roundHistory.slice() : [],
    continueVoting: state.continueVoting ? { ...state.continueVoting, votes: state.continueVoting.votes.slice() } : null,
    totalRounds: state.totalRounds || 1,
    currentRound: state.currentRound || 1,
    dealNumber: state.dealNumber || 0,
  };
}

exports.createState = function() {
  var state = {
    board: null,
    phase: 'bidding',
    hands: [[], [], []],
    bottomCards: [],
    landlord: null,
    currentBidder: 0,
    currentBid: 0,
    passCount: 0,
    bids: {},
    currentPlayer: 0,
    lastPlay: null,
    passStreak: 0,
    passed: [false, false, false],
    winner: null,
    multiplier: 1,
    // 叫抢 fields
    callPhase: 'call',
    calledPlayers: [],
    passedCall: [false, false, false],
    eligibleForRob: [true, true, true],
    robAttempts: [],
    landlordCandidate: null,
    robMultiplier: 3,
    gameMultiplier: 1,
    // timer
    currentTurnDeadline: null,
    // multi-round
    cumulativeScore: [0, 0, 0],
    roundHistory: [],
    continueVoting: null,
    totalRounds: 3,
    currentRound: 1,
    // option defaults
    bidMode: 'rob',
    firstCaller: 'random',
    allowDouble: false,
    allowShowHand: false,
    playTimeLimit: 0,
  };
  dealCards(state);
  return state;
};

exports.initGame = function(state, playerCount) {
  var requested = state._options && state._options.totalRounds;
  state.totalRounds = Number.isInteger(requested) && requested >= 1 && requested <= 30 ? requested : 3;
  dealCards(state);
};

function dealCards(state) {
  var deck = createDeck();
  shuffle(deck);
  state.hands[0] = deck.slice(0, 17);
  state.hands[1] = deck.slice(17, 34);
  state.hands[2] = deck.slice(34, 51);
  state.bottomCards = deck.slice(51, 54);
  for (var i = 0; i < 3; i++) sortHand(state.hands[i]);
  sortHand(state.bottomCards);
  resetRoundState(state);
}

function resetRoundState(state) {
  state.dealNumber = (state.dealNumber || 0) + 1;
  state.phase = 'bidding';
  state.callPhase = 'call';
  state.currentBidder = Math.floor(Math.random() * (state._playerCount || 3));
  state.currentBid = 0;
  state.passCount = 0;
  state.bids = {};
  state.landlord = null;
  state.currentPlayer = state.currentBidder;
  state.lastPlay = null;
  state.passStreak = 0;
  state.passed = [false, false, false];
  state.winner = null;
  state.roundWinner = null;
  state.spring = null; state.playCounts = [0, 0, 0]; state.roundSettled = false;
  state.baseScore = 1; state.multiplierCap = 128;
  state.multiplier = 1;
  state.calledPlayers = [];
  state.passedCall = [false, false, false];
  state.eligibleForRob = [true, true, true];
  state.robAttempts = [];
  state.landlordCandidate = null;
  state.robMultiplier = 3;
  state.gameMultiplier = 1;
  state.currentTurnDeadline = null;
  state.board = syncBoard(state);
  // Read options
  if (state._options) {
    state.bidMode = state._options.bidMode || 'rob';
    state.firstCaller = state._options.firstCaller || 'random';
    state.allowDouble = state._options.allowDouble || false;
    state.allowShowHand = state._options.allowShowHand || false;
    state.playTimeLimit = 0; // This deployment never performs an automatic move.
  }
  state.board = syncBoard(state);
  // 先叫规则「赢家先叫」：上一局最后出完牌的人先叫
  if (state.firstCaller === 'winner' && typeof state.lastRoundWinner === 'number') {
    state.currentBidder = state.lastRoundWinner;
    state.currentPlayer = state.currentBidder;
    state.board = syncBoard(state);
  }
}

function multiply(state) { state.gameMultiplier = Math.min(128, Math.max(1, state.gameMultiplier || 1) * 2); }
function calculatePerRoundScores(state) {
  if (state.roundSettled) return;
  state.roundSettled = true;
  var counts = state.playCounts || [0, 0, 0];
  state.spring = null;
  if (state.roundWinner === -2 && counts.every(function(n, i) { return i === state.landlord || n === 0; })) state.spring = 'spring';
  else if (state.roundWinner === -3 && counts[state.landlord] <= 1) state.spring = 'reverse';
  if (state.spring) multiply(state);
  var multiplier = state.gameMultiplier = Math.min(128, Math.max(1, state.gameMultiplier || 1));
  var direction = state.roundWinner === -2 ? 1 : -1;
  var deltas = state.cumulativeScore.map(function(_, i) { return (i === state.landlord ? 2 : -1) * multiplier * direction; });
  deltas.forEach(function(delta, i) { state.cumulativeScore[i] += delta; });
  state.roundHistory.push({ round: state.currentRound, winner: state.roundWinner, multiplier: multiplier, baseScore: 1,
    spring: state.spring, landlord: state.landlord, deltas: deltas, scores: state.cumulativeScore.slice() });
}
function voteToExtend(data, state, playerIndex) {
  if (state.currentRound !== state.totalRounds || !['bidding', 'playing', 'roundEnd', 'over'].includes(state.phase)) {
    // A duplicate successful yes retry is harmless, not another extension.
    if (data.vote === 'yes' && state._extendedFromRound === state.currentRound) return null;
    return 'g_invalid_action';
  }
  if (data.vote !== 'yes' && data.vote !== 'no') return 'ddz_invalid_vote';
  var v = state.continueVoting || { votes: [], totalPlayers: 3, resolved: false };
  v.votes[playerIndex] = data.vote;
  v.continueYesVotes = v.votes.filter(function(x) { return x === 'yes'; }).length;
  v.continueNoVotes = v.votes.filter(function(x) { return x === 'no'; }).length;
  state.continueVoting = v;
  if (v.continueYesVotes === 3) {
    state._extendedFromRound = state.currentRound;
    state.totalRounds += 3;
    if (state._options) state._options.totalRounds = state.totalRounds;
    state.continueVoting = null;
    if (state.roundSettled) { state.winner = null; state.phase = 'roundEnd'; }
  }
  state.board = syncBoard(state);
  return null;
}

// ---- Card type detection ----

function detectType(cards) {
  if (!cards || cards.length === 0) return null;
  var n = cards.length;
  var rvals = cards.map(function(c) { return rankVal(c.rank); }).sort(function(a,b) { return a-b; });

  if (n === 2 && cards.some(function(c) { return c.id === 'SJ'; }) && cards.some(function(c) { return c.id === 'BJ'; }))
    return { type: 'rocket', rank: 15 };

  if (n === 4 && rvals[0] === rvals[3])
    return { type: 'bomb', rank: rvals[0] };

  var countMap = Object.create(null);
  for (var i = 0; i < rvals.length; i++) countMap[rvals[i]] = (countMap[rvals[i]] || 0) + 1;
  var groups = { 1: [], 2: [], 3: [], 4: [] };
  for (var r in countMap) groups[countMap[r]].push(parseInt(r));
  for (var k in groups) groups[k].sort(function(a,b) { return a-b; });

  if (n === 1) return { type: 'single', rank: rvals[0] };
  if (n === 2 && rvals[0] === rvals[1]) return { type: 'pair', rank: rvals[0] };
  if (groups[3].length === 1 && n === 3) return { type: 'triple', rank: groups[3][0] };
  if (groups[3].length === 1 && n === 4) return { type: 'triple_one', rank: groups[3][0] };
  if (groups[3].length === 1 && n === 5 && groups[2].length === 1) return { type: 'triple_two', rank: groups[3][0] };
  if (n >= 5 && groups[1].length === n && isConsecutive(groups[1], n) && groups[1][n-1] < 12)
    return { type: 'straight', rank: groups[1][0], length: n };
  if (n >= 6 && n % 2 === 0 && groups[2].length === n/2 && isConsecutive(groups[2], n/2) && groups[2][n/2-1] < 12)
    return { type: 'consecutive_pairs', rank: groups[2][0], length: n/2 };
  if (n >= 6 && n % 3 === 0 && groups[3].length === n/3 && isConsecutive(groups[3], n/3) && groups[3][n/3-1] < 12)
    return { type: 'plane', rank: groups[3][0], length: n/3 };
  if (groups[3].length >= 2 && isConsecutive(groups[3], groups[3].length) && groups[3][groups[3].length-1] < 12) {
    var triCount = groups[3].length;
    var remaining = n - triCount * 3;
    if (remaining === triCount) return { type: 'plane_wings_1', rank: groups[3][0], length: triCount };
    if (remaining === triCount * 2 && groups[2].length === triCount && n === triCount * 5)
      return { type: 'plane_wings_2', rank: groups[3][0], length: triCount };
  }
  if (groups[4].length === 1 && n === 6) return { type: 'four_two', rank: groups[4][0] };
  if (groups[4].length === 1 && n === 8 && groups[2].length === 2) return { type: 'four_two_pairs', rank: groups[4][0] };
  return null;
}

function isConsecutive(arr, len) {
  for (var i = 0; i < len - 1; i++) {
    if (arr[i + 1] - arr[i] !== 1) return false;
  }
  return true;
}

function canBeat(newPlay, lastPlay) {
  if (!lastPlay) return true;
  if (newPlay.type === 'rocket') return true;
  if (newPlay.type === 'bomb') {
    if (lastPlay.type === 'rocket') return false;
    if (lastPlay.type === 'bomb') return newPlay.rank > lastPlay.rank;
    return true;
  }
  if (newPlay.type !== lastPlay.type) return false;
  if ((newPlay.length || 0) !== (lastPlay.length || 0)) return false;
  return newPlay.rank > lastPlay.rank;
}

// ---- Handle Move ----

exports.handleMove = function(data, state, playerIndex) {
  if (!Number.isInteger(playerIndex) || playerIndex < 0 || playerIndex >= 3 || !data || typeof data !== 'object' || Array.isArray(data)) return 'g_invalid_action';
  // Extension is a normal-player vote, including after the last round's result.
  if (data.action === 'continue_vote') return voteToExtend(data, state, playerIndex);
  if (state.winner !== null) return 'g_game_over';

  // ---- ROUND END phase ----
  if (state.phase === 'roundEnd') {
    if (data.action === 'next_round' && state.currentRound < state.totalRounds) {
      startNewBiddingRound(state);
      return null;
    }
    return 'ddz_click_next_round';
  }

  // ---- BIDDING PHASE ----
  if (state.phase === 'bidding') {
    if (playerIndex !== state.currentBidder) return 'ddz_not_your_bid';
    var options = state._options || {};
    var bidMode = options.bidMode || state.bidMode || 'rob';

    if (bidMode === 'score') {
      // ---- 叫分 mode (keep existing 1-3 bidding logic) ----
      var score = data.score;
      // {pass:true} / {} (server bot fallback) count as "no bid"
      if (score === undefined && (data.pass === true || Object.keys(data).length === 0)) score = 0;
      if (!Number.isInteger(score) || score < 0 || score > 3) return 'ddz_bid_must_be_0_3';
      if (score !== 0 && score <= state.currentBid) return 'ddz_bid_must_be_0_3';
      state.bids[playerIndex] = score;
      if (score > state.currentBid) { state.currentBid = score; state.landlord = playerIndex; }
      state.passCount++;
      if (score === 3) { state.gameMultiplier = 3; finalizeLandlord(state, playerIndex); return null; }
      state.currentBidder = (state.currentBidder + 1) % (state._playerCount || 3);
      state.currentPlayer = state.currentBidder;
      if (state.passCount >= (state._playerCount || 3)) {
        if (state.landlord === null) { dealCards(state); return null; }
        state.gameMultiplier = state.currentBid;
        finalizeLandlord(state, state.landlord);
        return null;
      }
      state.board = syncBoard(state);
      return null;
    }

    // ---- 叫抢 mode ----
    // Server bot fallback ({pass:true} / {}) is "不叫" / "不抢"
    if (Object.keys(data).length === 0) data = { pass: true };
    if (data.pass === true && state.callPhase === 'rob') data = { passRob: true };

    if (state.callPhase === 'call') {
      // 叫地主 / 不叫
      if (data.call === true) {
        state.calledPlayers.push(playerIndex);
        state.landlordCandidate = playerIndex;
        state.eligibleForRob[playerIndex] = true;
        state.robMultiplier = 3;
        state.gameMultiplier = 3;
        state.callPhase = 'rob';
        state.currentBidder = nextPlayer(state, playerIndex);
        state.currentPlayer = state.currentBidder;
        if (!hasEligibleRobber(state)) finalizeLandlord(state, state.landlordCandidate);
        state.board = syncBoard(state);
        return null;
      }
      if (data.pass === true) {
        state.passedCall[playerIndex] = true;
        state.eligibleForRob[playerIndex] = false;
        state.passCount++;
        if (state.passCount >= (state._playerCount || 3)) {
          // All passed during call phase → re-deal
          dealCards(state); return null;
        }
        state.currentBidder = nextPlayer(state, playerIndex);
        state.currentPlayer = state.currentBidder;
        state.board = syncBoard(state);
        return null;
      }
      return 'ddz_invalid_bid_action';
    }

    if (state.callPhase === 'rob') {
      // 抢 / 不抢
      if (data.rob === true) {
        if (!state.eligibleForRob[playerIndex]) return 'ddz_not_eligible_to_rob';
        if (state.robAttempts.indexOf(playerIndex) >= 0) return 'ddz_already_robbed';
        state.robAttempts.push(playerIndex);
        state.landlord = playerIndex;
        multiply(state);
        state.robMultiplier = Math.min(128, state.robMultiplier * 2);
        state.currentBidder = nextEligibleRobPlayer(state, playerIndex);
        if (state.currentBidder < 0) { finalizeLandlord(state, state.landlord); return null; }
        state.currentPlayer = state.currentBidder;
        state.board = syncBoard(state);
        return null;
      }
      if (data.passRob === true) {
        state.eligibleForRob[playerIndex] = false;
        // Auto-finalize landlordCandidate if no one robbed and no other eligible players remain
        if (state.landlord === null && state.landlordCandidate !== null) {
          var nonCandidateEligible = false;
          for (var rp = 0; rp < (state._playerCount || 3); rp++) {
            if (rp !== state.landlordCandidate && state.eligibleForRob[rp]) {
              nonCandidateEligible = true; break;
            }
          }
          if (!nonCandidateEligible) { finalizeLandlord(state, state.landlordCandidate); return null; }
        }
        state.currentBidder = nextEligibleRobPlayer(state, playerIndex);
        if (state.currentBidder < 0) {
          if (state.landlord === null && state.landlordCandidate !== null) finalizeLandlord(state, state.landlordCandidate);
          else if (state.landlord !== null) finalizeLandlord(state, state.landlord);
          else { dealCards(state); return null; }
          return null;
        }
        state.currentPlayer = state.currentBidder;
        state.board = syncBoard(state);
        return null;
      }
      return 'ddz_invalid_bid_action';
    }

    return 'ddz_invalid_bid_action';
  }

  // ---- PLAYING PHASE ----
  if (state.phase === 'playing') {
    if (playerIndex !== state.currentPlayer) return 'g_not_your_turn';
    var cardIds = data.cards;
    // Passing is explicit; an empty request must never choose a card for the player.
    if (!Array.isArray(cardIds) && data.pass === true) cardIds = [];
    if (!Array.isArray(cardIds)) return 'ddz_invalid_format';

    // PASS
    if (cardIds.length === 0) {
      if (!state.lastPlay || state.lastPlay.player === playerIndex) return 'ddz_must_lead';
      if (!Array.isArray(state.passed)) state.passed = [false, false, false];
      state.passStreak++;
      state.passed[playerIndex] = true;
      state.currentPlayer = (state.currentPlayer + 1) % (state._playerCount || 3);
      setTurnTimer(state);
      if (state.passStreak >= 2) { state.lastPlay = null; state.passStreak = 0; state.passed = [false, false, false]; }
      state.board = syncBoard(state);
      return null;
    }

    // Validate the entire request before touching the authoritative hand.
    if (cardIds.length > 20 || cardIds.some(function(id) { return typeof id !== 'string'; }) || new Set(cardIds).size !== cardIds.length) return 'ddz_invalid_format';
    // Remove cards from hand
    var hand = state.hands[playerIndex];
    var played = [];
    for (var p = 0; p < cardIds.length; p++) {
      var idx = hand.findIndex(function(c) { return c.id === cardIds[p]; });
      if (idx === -1) { hand.push.apply(hand, played); sortHand(hand); return 'ddz_card_not_in_hand'; }
      played.push(hand.splice(idx, 1)[0]);
    }

    var playType = detectType(played);
    if (!playType) { hand.push.apply(hand, played); sortHand(hand); return 'ddz_invalid_play'; }

    if (!canBeat(playType, state.lastPlay ? state.lastPlay.play : null)) {
      hand.push.apply(hand, played); sortHand(hand); return 'ddz_doesnt_beat';
    }

    state.playCounts = state.playCounts || [0, 0, 0];
    state.playCounts[playerIndex]++;
    state.lastPlay = { player: playerIndex, cards: played, play: playType };
    state.passStreak = 0;
    state.passed = [false, false, false];

    // Bomb/rocket multiplier
    if (playType.type === 'bomb' || playType.type === 'rocket') multiply(state);

    // Check win
    if (hand.length === 0) {
      state.lastRoundWinner = playerIndex;
      state.roundWinner = playerIndex === state.landlord ? -2 : -3;
      state.currentTurnDeadline = null;
      calculatePerRoundScores(state);
      if (state.currentRound >= state.totalRounds) {
        state.winner = state.roundWinner;
        state.phase = 'over';
      } else {
        state.phase = 'roundEnd';
      }
      state.board = syncBoard(state);
      return null;
    }

    state.currentPlayer = (state.currentPlayer + 1) % (state._playerCount || 3);
    setTurnTimer(state);
    state.board = syncBoard(state);
    return null;
  }

  return 'g_unknown_action';
};

// Shared with the bot so it only ever proposes plays the server will accept.
exports.syncBoard = syncBoard;
exports.detectType = detectType;
exports.canBeat = canBeat;

function nextPlayer(state, current) {
  return (current + 1) % (state._playerCount || 3);
}

function hasEligibleRobber(state) {
  for (var i = 0; i < (state._playerCount || 3); i++) {
    if (state.eligibleForRob[i] && i !== state.landlordCandidate) return true;
  }
  return false;
}

function nextEligibleRobPlayer(state, current) {
  var n = state._playerCount || 3;
  for (var step = 1; step <= n; step++) {
    var p = (current + step) % n;
    if (state.eligibleForRob[p] && state.robAttempts.indexOf(p) < 0) {
      return p;
    }
  }
  return -1;
}

function finalizeLandlord(state, landlordIdx) {
  state.landlord = landlordIdx;
  state.callPhase = 'decided';
  state.phase = 'playing';
  state.currentPlayer = landlordIdx;
  state.hands[landlordIdx].push.apply(state.hands[landlordIdx], state.bottomCards);
  sortHand(state.hands[landlordIdx]);
  setTurnTimer(state);
  state.board = syncBoard(state);
}

// Deliberately no autoplay / automatic passing in this deployment.
exports.timeoutMove = function() { return null; };
exports.getPhaseDeadline = function() { return 0; };
exports.onTimeout = function() { return 'g_invalid_action'; };
function setTurnTimer(state) { state.currentTurnDeadline = null; }

function startNewBiddingRound(state) {
  state.continueVoting = null;
  state._extendedFromRound = null;
  state.currentRound = (state.currentRound || 1) + 1;
  state.phase = 'bidding';
  dealCards(state);
}

exports.getCurrentActor = function(state) { return state.currentPlayer; };

// Hide other players' cards (and draw piles) from each client.
const { maskView } = require('./lib/hidden');
exports.playerView = function (state, playerIndex) {
  var opts = { piles: state.phase === 'bidding' ? ['bottomCards'] : [] };
  var view = maskView(state, playerIndex, opts);
  if (view === state) return state;
  // Rebuild the derived board for old checkpoints and seat/vote changes too.
  // Do not mutate the checkpoint merely by viewing it.
  view = { ...view, board: maskView(syncBoard(state), playerIndex, opts) };
  return view;
};
