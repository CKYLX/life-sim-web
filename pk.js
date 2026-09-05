// ============================================================
//  pk.js — 娱乐 PK 对战（吹牛比点数）
//  依赖 index.html 全局：loadWorld/saveWorld/withLock/getPlayer/
//  addLog/toast/$/esc/clamp/randHex/liveEnergy/refreshMe/refreshWorld/
//  settleEnergy/ACTIONS_PER_YEAR/MAX_AGE/myId
// ============================================================

const PK_ATTRS = [
  { key: 'intel', name: '智力', emoji: '🧠' },
  { key: 'health', name: '健康', emoji: '💪' },
  { key: 'happy', name: '快乐', emoji: '😊' },
  { key: 'charm', name: '魅力', emoji: '✨' },
];
const PK_WIN_SCORE = 2;      // 先得 2 分者胜
const PK_MATCH_WAIT = 60000;  // 匹配真人等待时长（毫秒）
const PK_POLL = 1600;        // pvp 轮询间隔（毫秒）
const PK_COST = 10;         // 入场费金币
const PK_ENERGY = 15;        // 精力消耗
const PK_TURN_TIMEOUT = 30000; // 对局中该行动方超过 30 秒未动判离线落败

let pk = null;               // 当前对局对象
let pkMe = null;             // PK 开始时的我方快照 { name, attrs }
let pkCancelFlag = false;    // 匹配阶段取消标记
let pkTimers = [];           // pvp 轮询定时器

// ---------- 工具 ----------
function pkAttrName(key) { const a = PK_ATTRS.find(x => x.key === key); return a ? a.name : String(key); }
function pkAttrEmoji(key) { const a = PK_ATTRS.find(x => x.key === key); return a ? a.emoji : ''; }
function pkSnapshot(p) {
  const s = p ? (p.stats || {}) : {};
  return {
    intel: clamp(s.intel || 0, 0, 100),
    health: clamp(s.health || 0, 0, 100),
    happy: clamp(s.happy || 0, 0, 100),
    charm: clamp(s.charm || 0, 0, 100),
  };
}
function clearPkTimers() { pkTimers.forEach(clearInterval); pkTimers = []; }

// ---------- 入场费 ----------
async function pkPayEntry() {
  try {
    await withLock(async () => {
      const world = await loadWorld();
      const p = getPlayer(world, myId);
      if (!p) return;
      changeMoney(world, p, -PK_COST, '🎮 娱乐 PK 入场费 -¥' + PK_COST);
      settleEnergy(p);
      p.stats.energy = clamp(p.stats.energy - PK_ENERGY, 0, 100);
      p.energyAt = Date.now();
      await saveWorld(world);
    });
  } catch (e) { console.error(e); }
  if (typeof refreshMe === 'function') refreshMe();
}

// ---------- 入口：点娱乐 ----------
async function startPk() {
  if (!myId) return;
  if (pk) { toast('正在 PK 中'); return; }
  pkCancelFlag = false;
  let meInfo = null;
  try {
    const world = await loadWorld();
    const p = getPlayer(world, myId);
    if (!p) { toast('角色不存在'); return; }
    if (p.alive === false) { toast('已故，无法娱乐'); return; }
    if (p.money < PK_COST) { toast('娱乐 PK 需要 ' + PK_COST + ' 金币，先去打工或工作赚金币吧'); return; }
    settleEnergy(p);
    if (p.stats.energy < PK_ENERGY) { toast('精力不足（' + p.stats.energy + '/100），休息或等几分钟再娱乐'); return; }
    meInfo = { name: p.name, attrs: pkSnapshot(p) };
  } catch (e) { toast('网络错误'); return; }
  pkMe = meInfo;
  showPkLoading();
  let matched = null;
  try { matched = await tryMatchPvp(); } catch (e) { matched = null; }
  if (pkCancelFlag) { $('pkModal').classList.add('hidden'); return; }
  if (matched) startPvp(matched); else startAiPk();
}

// ---------- 匹配队列工具（带时间戳，8 秒内有效） ----------
// 取队列中"新鲜"（未过期）的等待者 id 列表，排除 excludeId
function pkFreshWaiters(world, excludeId) {
  const now = Date.now();
  return (world.pkQueue || [])
    .filter((e) => {
      const id = e && typeof e === 'object' ? e.id : e;
      const at = e && typeof e === 'object' ? (e.at || 0) : 0;
      return id && id !== excludeId && (now - at) < PK_MATCH_WAIT;
    })
    .map((e) => (typeof e === 'object' ? e.id : e));
}
// 从队列移除某个 id（兼容旧的字符串格式）
// 判断某玩家是否正在某个未结束的 PVP 对局中（幽灵检测）
function pkIsBusy(world, id) {
  return Object.values(world.pkMatches || {}).some((m) => m.phase !== 'over' && (m.dealer === id || m.follower === id));
}
function pkQueueRemove(world, id) {
  world.pkQueue = (world.pkQueue || []).filter((e) => {
    const eid = e && typeof e === 'object' ? e.id : e;
    return eid !== id;
  });
}
// 入队（先清理过期项，再写入带时间戳的新条目）
function pkQueueJoin(world, id) {
  const now = Date.now();
  world.pkQueue = (world.pkQueue || []).filter((e) => e && typeof e === 'object' && e.at && (now - e.at) < PK_MATCH_WAIT);
  if (!world.pkQueue.some((e) => e && e.id === id)) world.pkQueue.push({ id: id, at: now });
}

function cancelPkMatch() {
  pkCancelFlag = true;
  $('pkModal').classList.add('hidden');
  (async () => {
    try {
      await withLock(async () => {
        const w = await loadWorld();
        pkQueueRemove(w, myId);
        await saveWorld(w);
      });
    } catch (e) {}
  })();
}

// ---------- 匹配真人 ----------
function tryMatchPvp() {
  return new Promise((resolve) => {
    const start = Date.now();
    (async () => {
      try {
        await withLock(async () => {
          const w = await loadWorld();
          if (!Array.isArray(w.pkQueue)) w.pkQueue = [];
          pkQueueJoin(w, myId);
          await saveWorld(w);
        });
      } catch (e) {}
    })();
    const check = async () => {
      try {
        const world = await loadWorld();
        const matches = world.pkMatches || {};
        const now = Date.now();
        // 只认"新鲜"对局：超过一轮超时时间的旧对局视为已废弃，不再命中
        const mine = Object.values(matches).find((m) => (m.dealer === myId || m.follower === myId) && m.phase !== 'over' && (now - (m.updatedAt || m.createdAt)) < PK_TURN_TIMEOUT);
        if (mine) { resolve(mine); return; }
        const others = pkFreshWaiters(world, myId);
        if (others.length) {
          const created = await withLock(async () => {
            if (pkCancelFlag) return null;
            const w = await loadWorld();
            // 只选"空闲"对手：不在其他未结束对局中（防止匹配到已离开/在别的对局里的幽灵玩家）
            const oppId = pkFreshWaiters(w, myId).find((id) => !pkIsBusy(w, id));
            if (!oppId) return null;
            const exist = Object.values(w.pkMatches || {}).find((m) => (m.dealer === myId || m.follower === myId) && m.phase !== 'over');
            if (exist) return exist;
            if (myId < oppId) return null; // 由 id 较大者创建，避免双方重复
            const m = createPvpMatch(w, myId, oppId);
            pkQueueRemove(w, myId);
            pkQueueRemove(w, oppId);
            await saveWorld(w);
            return m;
          });
          if (created) { resolve(created); return; }
        }
      } catch (e) {}
      if (Date.now() - start > PK_MATCH_WAIT) {
        try {
          await withLock(async () => {
            const w = await loadWorld();
            pkQueueRemove(w, myId);
            await saveWorld(w);
          });
        } catch (e) {}
        resolve(null);
        return;
      }
      setTimeout(check, 1200);
    };
    check();
  });
}

function createPvpMatch(w, a, b) {
  const pa = getPlayer(w, a);
  const pb = getPlayer(w, b);
  const dealerIsA = Math.random() < 0.5;
  const dealer = dealerIsA ? a : b;
  const follower = dealerIsA ? b : a;
  const dealerP = dealerIsA ? pa : pb;
  const followerP = dealerIsA ? pb : pa;
  const m = {
    id: 'pk' + (++w.seq) + '_' + randHex(3),
    dealer, follower,
    dealerScore: 0, followerScore: 0,
    dealerAttrs: pkSnapshot(dealerP),
    followerAttrs: pkSnapshot(followerP),
    dealerName: dealerP ? dealerP.name : '玩家',
    followerName: followerP ? followerP.name : '玩家',
    dealerVerifyLeft: 1, followerVerifyLeft: 1,
    round: null,
    roundResult: null,
    phase: 'dealer_turn',
    winner: null,
    roundNum: 0,
    stage: 1,
    stealTurn: 'follower',
    stealLog: '',
    dealerHand: ['intel', 'health', 'happy', 'charm'],
    followerHand: ['intel', 'health', 'happy', 'charm'],
    dealerStolen: [],
    followerStolen: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  if (!w.pkMatches) w.pkMatches = {};
  w.pkMatches[m.id] = m;
  return m;
}

// ---------- AI 对战 ----------
function startAiPk() {
  const myAttrs = pkMe.attrs;
  const aiAttrs = {};
  for (const a of PK_ATTRS) {
    aiAttrs[a.key] = clamp(Math.round(myAttrs[a.key] + (Math.random() * 40 - 20)), 10, 100);
  }
  const iAmDealer = Math.random() < 0.5;
  pk = {
    mode: 'ai',
    matchId: null,
    me: { id: myId, name: pkMe.name, attrs: myAttrs },
    opp: { id: 'ai', name: 'AI 对手 🤖', attrs: aiAttrs, isAI: true },
    iAmDealer,
    myScore: 0, oppScore: 0,
    myVerifyLeft: 1, oppVerifyLeft: 1,
    round: null,
    phase: 'dealer_turn',
    winner: null,
    stage: 1,
    roundNum: 0,
    stealTurn: 'follower',
    stealLog: '',
    hand: PK_ATTRS.map(a => a.key),
    stolen: [],
    logs: [],
  };
  pkPayEntry();
  showPkModal();
  renderPk();
  nextRound();
}

function nextRound() {
  if (!pk) return;
  pk.round = { attr: null, myReport: null, oppReport: null, myVerify: false, oppVerify: false };
  pk.phase = 'dealer_turn';
  if (pk.iAmDealer) {
    renderPk();
    renderDealerUI();
  } else {
    aiDealerTurn();
  }
}

function aiDealerTurn() {
  const attr = aiPickAttr();
  const real = pk.opp.attrs[attr];
  const report = aiReport(real);
  pk.round.attr = attr;
  pk.round.oppReport = report;
  pk.logs.unshift('对手（庄家）出 ' + pkAttrName(attr) + '，报点 ' + report);
  pk.phase = 'follower_turn';
  renderPk();
  renderFollowerUI();
}

function aiPickAttr() {
  if (Math.random() < 0.25) return PK_ATTRS[Math.floor(Math.random() * PK_ATTRS.length)].key;
  let best = PK_ATTRS[0].key, bestV = -1;
  for (const a of PK_ATTRS) if (pk.opp.attrs[a.key] > bestV) { bestV = pk.opp.attrs[a.key]; best = a.key; }
  return best;
}
function aiReport(real) {
  if (Math.random() < 0.4) return clamp(Math.round(real + (Math.random() * 25 + 5)), 0, 100);
  return real;
}
function aiFollowerDecide(dealerReport, attr) {
  const real = pk.opp.attrs[attr];
  let verify = false;
  if (pk.oppVerifyLeft > 0) {
    let p = 0.1;
    if (dealerReport > 90) p = 0.55;
    else if (dealerReport > 80) p = 0.3;
    if (Math.random() < p) verify = true;
  }
  let report = real;
  if (real < dealerReport) {
    if (Math.random() < 0.55) report = clamp(Math.round(dealerReport + Math.random() * 15), 0, 100);
  } else if (Math.random() < 0.3) {
    report = clamp(Math.round(real + (Math.random() * 15 + 3)), 0, 100);
  }
  return { report, verify };
}
function aiDealerVerifyDecide(followerReport, attr) {
  if (pk.oppVerifyLeft <= 0) return false;
  const real = pk.opp.attrs[attr];
  if (followerReport > 90) return Math.random() < 0.55;
  if (followerReport > 80) return Math.random() < 0.3;
  if (followerReport > real + 15) return Math.random() < 0.4;
  return Math.random() < 0.1;
}

// ---------- AI 对战：玩家操作 ----------
function aiFollowerSubmit(verify, reportVal) {
  if (!pk) return;
  if (verify) {
    if (pk.myVerifyLeft <= 0) { toast('查验机会已用完'); return; }
    pk.round.myVerify = true;
    pk.myVerifyLeft--;
    pk.logs.unshift('你选择查验对手！');
    resolveAiRound();
  } else {
    pk.round.myReport = reportVal;
    pk.logs.unshift('你报点 ' + reportVal);
    pk.phase = 'dealer_verify';
    const attr = pk.round.attr;
    const verify = aiDealerVerifyDecide(reportVal, attr);
    pk.round.oppVerify = verify;
    if (verify) { pk.oppVerifyLeft--; pk.logs.unshift('对手（庄家）选择查验你！'); }
    renderPk();
    setTimeout(resolveAiRound, 700);
  }
}

function aiDealerVerifySubmit(verify) {
  if (!pk) return;
  if (verify) {
    if (pk.myVerifyLeft <= 0) { toast('查验机会已用完'); return; }
    pk.round.myVerify = true;
    pk.myVerifyLeft--;
    pk.logs.unshift('你选择查验对手！');
  } else {
    pk.logs.unshift('你选择相信对手');
  }
  resolveAiRound();
}

// ---------- AI 对战：判定 ----------
function resolveAiRound() {
  if (!pk) return;
  const r = pk.round;
  const attr = r.attr;
  const iAmDealer = pk.iAmDealer;
  const dealerReport = iAmDealer ? r.myReport : r.oppReport;
  const followerReport = iAmDealer ? r.oppReport : r.myReport;
  const dealerReal = iAmDealer ? pk.me.attrs[attr] : pk.opp.attrs[attr];
  const followerReal = iAmDealer ? pk.opp.attrs[attr] : pk.me.attrs[attr];
  const dealerBluff = dealerReport !== dealerReal;
  const followerBluff = followerReport !== followerReal;
  const followerVerifyDealer = iAmDealer ? r.oppVerify : r.myVerify;
  const dealerVerifyFollower = iAmDealer ? r.myVerify : r.oppVerify;

  let gameWinner = null;
  let pointWinner = null;
  let msg = '';

  if (followerVerifyDealer) {
    if (dealerBluff) { gameWinner = iAmDealer ? 'opp' : 'me'; msg = '查验成功！庄家虚报被抓，后家直接获胜！'; }
    else {
      pointWinner = dealerReal > followerReal ? (iAmDealer ? 'me' : 'opp') : (followerReal > dealerReal ? (iAmDealer ? 'opp' : 'me') : 'none');
      msg = '查验属实，按真实点数比较（庄家 ' + dealerReal + ' vs 后家 ' + followerReal + '）';
    }
  } else if (dealerVerifyFollower) {
    if (followerBluff) { gameWinner = iAmDealer ? 'me' : 'opp'; msg = '查验成功！后家虚报被抓，庄家直接获胜！'; }
    else {
      pointWinner = dealerReal > followerReal ? (iAmDealer ? 'me' : 'opp') : (followerReal > dealerReal ? (iAmDealer ? 'opp' : 'me') : 'none');
      msg = '查验属实，按真实点数比较（庄家 ' + dealerReal + ' vs 后家 ' + followerReal + '）';
    }
  } else {
    pointWinner = dealerReport > followerReport ? (iAmDealer ? 'me' : 'opp') : (followerReport > dealerReport ? (iAmDealer ? 'opp' : 'me') : 'none');
    msg = '无人查验，按报点比较（庄家报 ' + dealerReport + ' vs 后家报 ' + followerReport + '）';
  }

  pk.logs.unshift(msg);
  applyAiResult(gameWinner, pointWinner);
}

function applyAiResult(gameWinner, pointWinner) {
  if (gameWinner) {
    pk.winner = gameWinner;
    pk.phase = 'over';
    renderPk();
    settlePkResult(pk.winner === 'me' ? 'win' : 'lose');
    return;
  }
  if (pointWinner === 'me') pk.myScore++;
  else if (pointWinner === 'opp') pk.oppScore++;
  pk.roundNum = (pk.roundNum || 0) + 1;
  if (pk.myScore >= PK_WIN_SCORE || pk.oppScore >= PK_WIN_SCORE) {
    pk.winner = pk.myScore >= PK_WIN_SCORE ? 'me' : 'opp';
    pk.phase = 'over';
    renderPk();
    settlePkResult(pk.winner === 'me' ? 'win' : 'lose');
    return;
  }
  if (pk.roundNum >= 3) {
    pk.stage = 2;
    pk.phase = 'steal';
    aiStealPhase();
    return;
  }
  nextRound();
}

// AI 对战抽牌（本地模拟）：后家先抽，谁先比对方多 2 张牌赢
function aiStealPhase() {
  let myHand = PK_ATTRS.map(a => a.key);
  let oppHand = PK_ATTRS.map(a => a.key);
  const myAttrs = pk.me.attrs;
  const oppAttrs = pk.opp.attrs;
  let myTurn = !pk.iAmDealer;  // 后家先抽
  let guard = 0;
  let result = null;
  pk.logs.unshift('🎴 进入抽牌阶段：后家先抽，谁先比对方多 2 张牌谁赢');
  while (guard++ < 30 && !result) {
    const fromHand = myTurn ? oppHand : myHand;
    const toHand = myTurn ? myHand : oppHand;
    const fromAttrs = myTurn ? oppAttrs : myAttrs;
    const toAttrs = myTurn ? myAttrs : oppAttrs;
    const fromName = myTurn ? '对手' : '你';
    const toName = myTurn ? '你' : '对手';
    if (!fromHand.length) { result = myTurn ? 'me' : 'opp'; break; }
    const idx = Math.floor(Math.random() * fromHand.length);
    const attr = fromHand[idx];
    const fromVal = fromAttrs[attr];
    const toVal = toAttrs[attr];
    if (fromVal < toVal) {
      fromHand.splice(idx, 1);
      toHand.push(attr);
      pk.logs.unshift(toName + ' 翻到 ' + fromName + ' 的 ' + pkAttrEmoji(attr) + pkAttrName(attr) + '(' + fromVal + ')，比自己(' + toVal + ')小，吃掉！');
    } else {
      pk.logs.unshift(toName + ' 翻到 ' + fromName + ' 的 ' + pkAttrEmoji(attr) + pkAttrName(attr) + '(' + fromVal + ')，不比自己(' + toVal + ')小，还给对方');
    }
    if (myHand.length - oppHand.length >= 2) { result = 'me'; break; }
    if (oppHand.length - myHand.length >= 2) { result = 'opp'; break; }
    myTurn = !myTurn;
  }
  pk.winner = result || 'draw';
  pk.phase = 'over';
  renderPk();
  settlePkResult(pk.winner === 'me' ? 'win' : (pk.winner === 'opp' ? 'lose' : 'draw'));
}

// ---------- PVP 对战 ----------
function startPvp(match) {
  const iAmDealer = match.dealer === myId;
  pk = {
    mode: 'pvp',
    matchId: match.id,
    me: { id: myId, name: pkMe.name, attrs: iAmDealer ? match.dealerAttrs : match.followerAttrs },
    opp: { id: iAmDealer ? match.follower : match.dealer, name: iAmDealer ? match.followerName : match.dealerName, attrs: iAmDealer ? match.followerAttrs : match.dealerAttrs, isAI: false },
    iAmDealer,
    myScore: iAmDealer ? match.dealerScore : match.followerScore,
    oppScore: iAmDealer ? match.followerScore : match.dealerScore,
    myVerifyLeft: iAmDealer ? match.dealerVerifyLeft : match.followerVerifyLeft,
    oppVerifyLeft: iAmDealer ? match.followerVerifyLeft : match.dealerVerifyLeft,
    round: null,
    phase: 'dealer_turn',
    winner: null,
    stage: match.stage || 1,
    roundNum: match.roundNum || 0,
    hand: iAmDealer ? (match.dealerHand || PK_ATTRS.map(a => a.key)) : (match.followerHand || PK_ATTRS.map(a => a.key)),
    stolen: iAmDealer ? (match.dealerStolen || []) : (match.followerStolen || []),
    stealTurn: match.stealTurn || 'follower',
    stealLog: '',
    logs: [],
    _uiPhase: '',
    _lastRoundMsg: '',
  };
  pkPayEntry();
  showPkModal();
  renderPk();
  pkTimers.push(setInterval(pkPollPvp, PK_POLL));
  pkPollPvp();
}

async function pkPollPvp() {
  if (!pk || pk.mode !== 'pvp' || pk.phase === 'over') return;
  try {
    const world = await loadWorld();
    const m = (world.pkMatches || {})[pk.matchId];
    if (!m) {
      pk._missCount = (pk._missCount || 0) + 1;
      if (pk._missCount >= 3) { toast('对手已离开，PK 结束'); quitPk(true); }
      return;
    }
    pk._missCount = 0;
    // 当前行动方超时检测：超过 30 秒未动，判其离线落败
    const turnId = m.phase === 'steal'
      ? (m.stealTurn === 'dealer' ? m.dealer : m.follower)
      : ((m.phase === 'dealer_turn' || m.phase === 'dealer_verify') ? m.dealer : m.follower);
    if (m.phase !== 'over' && turnId && Date.now() - (m.updatedAt || m.createdAt) > PK_TURN_TIMEOUT) {
      const winnerId = turnId === m.dealer ? m.follower : m.dealer;
      await withLock(async () => {
        const w2 = await loadWorld();
        const m2 = (w2.pkMatches || {})[pk.matchId];
        if (m2 && m2.phase !== 'over') {
          m2.phase = 'over';
          m2.winner = winnerId;
          m2.roundResult = { msg: '对方超时未操作，判定离线' };
          m2.updatedAt = Date.now();
          await saveWorld(w2);
        }
      });
      pk.phase = 'over';
      pk.winner = winnerId === myId ? 'me' : 'opp';
      clearPkTimers();
      renderPk();
      settlePkResult(winnerId === myId ? 'win' : 'lose');
      return;
    }
    if (m.phase === 'over') {
      pk.phase = 'over';
      pk.winner = m.winner == null ? 'draw' : (m.winner === myId ? 'me' : 'opp');
      clearPkTimers();
      renderPk();
      settlePkResult(pk.winner === 'me' ? 'win' : (pk.winner === 'opp' ? 'lose' : 'draw'));
      return;
    }
    const iAmDealer = m.dealer === myId;
    pk.iAmDealer = iAmDealer;
    pk.myScore = iAmDealer ? m.dealerScore : m.followerScore;
    pk.oppScore = iAmDealer ? m.followerScore : m.dealerScore;
    pk.myVerifyLeft = iAmDealer ? m.dealerVerifyLeft : m.followerVerifyLeft;
    pk.oppVerifyLeft = iAmDealer ? m.followerVerifyLeft : m.dealerVerifyLeft;
    pk.stage = m.stage || 1;
    pk.roundNum = m.roundNum || 0;
    pk.hand = iAmDealer ? (m.dealerHand || PK_ATTRS.map(a => a.key)) : (m.followerHand || PK_ATTRS.map(a => a.key));
    pk.stolen = iAmDealer ? (m.dealerStolen || []) : (m.followerStolen || []);
    pk.stealTurn = m.stealTurn || 'follower';
    pk.stealLog = m.stealLog || '';
    pk.myHandLen = iAmDealer ? (m.dealerHand || []).length : (m.followerHand || []).length;
    pk.oppHandLen = iAmDealer ? (m.followerHand || []).length : (m.dealerHand || []).length;
    pk.round = m.round ? {
      attr: m.round.attr,
      followerAttr: m.round.followerAttr,
      myReport: iAmDealer ? m.round.dealerReport : m.round.followerReport,
      oppReport: iAmDealer ? m.round.followerReport : m.round.dealerReport,
      myVerify: iAmDealer ? m.round.dealerVerify : m.round.followerVerify,
      oppVerify: iAmDealer ? m.round.followerVerify : m.round.dealerVerify,
    } : (pk.round || { attr: null, followerAttr: null, myReport: null, oppReport: null, myVerify: false, oppVerify: false });
    if (m.stage === 2 && m.phase === 'steal') {
      const myRole = iAmDealer ? 'dealer' : 'follower';
      if (m.stealTurn === myRole) { pkStealStep(); return; }
    }
    if (m.roundResult && m.roundResult.msg && pk._lastRoundMsg !== m.roundResult.msg + m.updatedAt) {
      pk._lastRoundMsg = m.roundResult.msg + m.updatedAt;
      pk.logs.unshift(m.roundResult.msg);
    }
    renderPk();
    const uiKey = m.phase + (iAmDealer ? '_d' : '_f');
    if (pk._uiPhase !== uiKey) {
      pk._uiPhase = uiKey;
      if (m.phase === 'dealer_turn' && iAmDealer) renderDealerUI();
      else if (m.phase === 'follower_turn' && !iAmDealer) renderFollowerUI();
      else if (m.phase === 'dealer_verify' && iAmDealer) renderDealerVerifyUI();
      else if (m.phase === 'steal') renderStealUI();
      else renderWaitingUI(m.phase);
    }
  } catch (e) {}
}

// ---------- 第二阶段：抽牌（后家先抽，谁先比对方多 2 张牌赢） ----------
async function pkStealStep() {
  if (!pk || pk.mode !== 'pvp') return;
  await withLock(async () => {
    const world = await loadWorld();
    const m = (world.pkMatches || {})[pk.matchId];
    if (!m || m.phase !== 'steal' || m.stage !== 2) return;
    const iAmDealer = m.dealer === myId;
    const myRole = iAmDealer ? 'dealer' : 'follower';
    if (m.stealTurn !== myRole) return;
    const isFollowerTurn = m.stealTurn === 'follower';
    const fromHand = isFollowerTurn ? m.dealerHand : m.followerHand;
    const toHand = isFollowerTurn ? m.followerHand : m.dealerHand;
    const fromAttrs = isFollowerTurn ? m.dealerAttrs : m.followerAttrs;
    const toAttrs = isFollowerTurn ? m.followerAttrs : m.dealerAttrs;
    const fromName = isFollowerTurn ? m.dealerName : m.followerName;
    const toName = isFollowerTurn ? m.followerName : m.dealerName;
    if (!fromHand || !fromHand.length) {
      m.winner = isFollowerTurn ? m.follower : m.dealer;
      m.phase = 'over';
      m.roundResult = { msg: fromName + ' 已无牌可抽，' + toName + ' 获胜！' };
      m.updatedAt = Date.now();
      await saveWorld(world);
      return;
    }
    const idx = Math.floor(Math.random() * fromHand.length);
    const attr = fromHand[idx];
    const fromVal = fromAttrs[attr];
    const toVal = toAttrs[attr];
    if (fromVal < toVal) {
      fromHand.splice(idx, 1);
      toHand.push(attr);
      m.stealLog = toName + ' 翻到 ' + fromName + ' 的 ' + pkAttrEmoji(attr) + pkAttrName(attr) + '(' + fromVal + ')，比自己(' + toVal + ')小，吃掉！';
    } else {
      m.stealLog = toName + ' 翻到 ' + fromName + ' 的 ' + pkAttrEmoji(attr) + pkAttrName(attr) + '(' + fromVal + ')，不比自己(' + toVal + ')小，还给对方';
    }
    const dLen = (m.dealerHand || []).length;
    const fLen = (m.followerHand || []).length;
    if (fLen - dLen >= 2) {
      m.winner = m.follower;
      m.phase = 'over';
      m.roundResult = { msg: m.followerName + ' 比 ' + m.dealerName + ' 多 2 张牌，获胜！' };
    } else if (dLen - fLen >= 2) {
      m.winner = m.dealer;
      m.phase = 'over';
      m.roundResult = { msg: m.dealerName + ' 比 ' + m.followerName + ' 多 2 张牌，获胜！' };
    } else {
      m.stealTurn = isFollowerTurn ? 'dealer' : 'follower';
    }
    m.updatedAt = Date.now();
    await saveWorld(world);
  });
  pkPollPvp();
}

function resolvePvp(m) {
  const r = m.round;
  const dealerAttr = r.attr;
  const followerAttr = r.followerAttr != null ? r.followerAttr : r.attr;
  const dealerReal = m.dealerAttrs[dealerAttr];
  const followerReal = m.followerAttrs[followerAttr];
  const dealerBluff = r.dealerReport !== dealerReal;
  const followerBluff = r.followerReport !== followerReal;
  let pointTo = null, gameTo = null, msg = '';
  if (r.followerVerify) {
    if (dealerBluff) { gameTo = 'follower'; msg = '查验成功！庄家虚报被抓，后家直接获胜！'; }
    else { pointTo = dealerReal > followerReal ? 'dealer' : (followerReal > dealerReal ? 'follower' : null); msg = '查验属实，按真实点数比较（庄家 ' + dealerReal + ' vs 后家 ' + followerReal + '）'; }
  } else if (r.dealerVerify) {
    if (followerBluff) { gameTo = 'dealer'; msg = '查验成功！后家虚报被抓，庄家直接获胜！'; }
    else { pointTo = dealerReal > followerReal ? 'dealer' : (followerReal > dealerReal ? 'follower' : null); msg = '查验属实，按真实点数比较（庄家 ' + dealerReal + ' vs 后家 ' + followerReal + '）'; }
  } else {
    pointTo = r.dealerReport > r.followerReport ? 'dealer' : (r.followerReport > r.dealerReport ? 'follower' : null);
    msg = '无人查验，按报点比较（庄家报 ' + r.dealerReport + ' vs 后家报 ' + r.followerReport + '）';
  }
  if (gameTo) {
    m.winner = gameTo === 'dealer' ? m.dealer : m.follower;
    m.phase = 'over';
  } else {
    if (pointTo === 'dealer') m.dealerScore++;
    else if (pointTo === 'follower') m.followerScore++;
    m.roundNum = (m.roundNum || 0) + 1;
    if (m.dealerScore >= PK_WIN_SCORE || m.followerScore >= PK_WIN_SCORE) {
      m.winner = m.dealerScore >= PK_WIN_SCORE ? m.dealer : m.follower;
      m.phase = 'over';
    } else if (m.roundNum >= 3) {
      // 3 局未分胜负，进入抽牌阶段：后家先抽，谁先比对方多 2 张牌谁赢
      m.stage = 2;
      m.phase = 'steal';
      m.stealTurn = 'follower';
      m.stealLog = '';
      m.round = null;
    } else {
      m.round = null;
      m.phase = 'dealer_turn';
    }
  }
  m.roundResult = { msg };
  m.updatedAt = Date.now();
  return m;
}

// ---------- PVP：玩家操作 ----------
async function dealerSubmitPvp(attr, report) {
  if (!pk || pk.mode !== 'pvp') return;
  try {
    await withLock(async () => {
      const world = await loadWorld();
      const m = (world.pkMatches || {})[pk.matchId];
      if (!m || m.phase !== 'dealer_turn' || m.dealer !== myId) return;
      m.round = { attr, dealerReport: report, followerReport: null, followerVerify: false, dealerVerify: false };
      m.phase = 'follower_turn';
      m.updatedAt = Date.now();
      await saveWorld(world);
    });
    pkPollPvp();
  } catch (e) { toast('网络错误'); }
}
async function followerSubmitPvp(verify, report) {
  if (!pk || pk.mode !== 'pvp') return;
  try {
    await withLock(async () => {
      const world = await loadWorld();
      const m = (world.pkMatches || {})[pk.matchId];
      if (!m || m.phase !== 'follower_turn' || m.follower !== myId) return;
      m.round.followerReport = report;
      m.round.followerVerify = verify;
      m.round.followerAttr = (pk.round && pk.round.followerAttr) ? pk.round.followerAttr : m.round.attr;
      if (verify) {
        if (m.followerVerifyLeft <= 0) return;
        m.followerVerifyLeft--;
        resolvePvp(m);
      } else {
        m.phase = 'dealer_verify';
      }
      m.updatedAt = Date.now();
      await saveWorld(world);
    });
    pkPollPvp();
  } catch (e) { toast('网络错误'); }
}
async function dealerVerifySubmitPvp(verify) {
  if (!pk || pk.mode !== 'pvp') return;
  try {
    await withLock(async () => {
      const world = await loadWorld();
      const m = (world.pkMatches || {})[pk.matchId];
      if (!m || m.phase !== 'dealer_verify' || m.dealer !== myId) return;
      if (verify) {
        if (m.dealerVerifyLeft <= 0) return;
        m.dealerVerifyLeft--;
      }
      m.round.dealerVerify = verify;
      resolvePvp(m);
      m.updatedAt = Date.now();
      await saveWorld(world);
    });
    pkPollPvp();
  } catch (e) { toast('网络错误'); }
}

// ---------- 结算 ----------
async function settlePkResult(outcome) {
  const delta = outcome === 'win' ? 10 : (outcome === 'lose' ? -10 : 0);
  const logMsg = outcome === 'win' ? '🏆 娱乐 PK 获胜，魅力+10' : (outcome === 'lose' ? '😞 娱乐 PK 落败，魅力-10' : '🤝 娱乐 PK 平局，魅力不变');
  try {
    await withLock(async () => {
      const world = await loadWorld();
      const p = getPlayer(world, myId);
      if (p) {
        p.stats.charm = clamp((p.stats.charm || 0) + delta, 0, 100);
        p.actionCount = (p.actionCount || 0) + 1;
        p.age = clamp(Math.floor(p.actionCount / ACTIONS_PER_YEAR), 0, MAX_AGE);
        p.lastActive = Date.now();
        addLog(p, logMsg);
        await saveWorld(world);
      }
    });
  } catch (e) { console.error(e); }
  if (typeof refreshMe === 'function') refreshMe();
  if (typeof refreshWorld === 'function') refreshWorld();
}

// ---------- UI 渲染 ----------
function showPkLoading() {
  $('pkModal').classList.remove('hidden');
  $('pkMyName').textContent = pkMe ? pkMe.name : '我';
  $('pkOppName').textContent = '?';
  $('pkMyScore').textContent = '0';
  $('pkOppScore').textContent = '0';
  $('pkMyTag').textContent = '?';
  $('pkOppTag').textContent = '?';
  $('pkAttrRow').textContent = '正在匹配对手…';
  $('pkOppReport').textContent = '—';
  $('pkMyReport').textContent = '—';
  $('pkLog').innerHTML = '';
  $('pkActions').innerHTML = '<div class="pk-hint">⏳ 正在寻找真人对手，60 秒后转 AI 对手…</div>' +
    '<div class="pk-btn-row"><button class="pk-btn danger" onclick="cancelPkMatch()">取消</button></div>';
}
function showPkModal() {
  $('pkModal').classList.remove('hidden');
}

function renderPk() {
  if (!pk) return;
  $('pkMyName').textContent = pk.me.name;
  $('pkOppName').textContent = pk.opp.name;
  $('pkMyScore').textContent = pk.myScore;
  $('pkOppScore').textContent = pk.oppScore;
  $('pkMyTag').textContent = pk.iAmDealer ? '庄家' : '后家';
  $('pkOppTag').textContent = pk.iAmDealer ? '后家' : '庄家';
  $('pkMyTag').className = 'pk-score-tag ' + (pk.iAmDealer ? 'dealer' : 'follower');
  $('pkOppTag').className = 'pk-score-tag ' + (pk.iAmDealer ? 'follower' : 'dealer');
  if (pk.phase === 'steal') {
    const turnName = pk.stealTurn === 'follower' ? '后家' : '庄家';
    $('pkAttrRow').textContent = '抽牌阶段 · 你 ' + (pk.myHandLen || 0) + ' 张 vs 对手 ' + (pk.oppHandLen || 0) + ' 张 · 当前' + turnName + '抽';
  } else if (pk.round && pk.round.attr) {
    $('pkAttrRow').textContent = '第' + (pk.roundNum + 1) + '局 · 属性：' + pkAttrEmoji(pk.round.attr) + ' ' + pkAttrName(pk.round.attr);
  } else {
    $('pkAttrRow').textContent = '第' + (pk.roundNum + 1) + '局 · ' + (pk.iAmDealer ? '轮到你选属性…' : '等待庄家选属性…') + ' · 第一阶段（先得2分胜）';
  }
  $('pkOppReport').textContent = (pk.round && pk.round.oppReport != null) ? pk.round.oppReport : '—';
  $('pkMyReport').textContent = (pk.round && pk.round.myReport != null) ? pk.round.myReport : '—';
  let lh = '';
  for (const l of (pk.logs || []).slice(0, 8)) lh += '<div class="pk-log-item">' + esc(l) + '</div>';
  $('pkLog').innerHTML = lh || '<div class="pk-log-item">PK 开始，先得 2 分者胜！赢 +10 魅力，输 -10 魅力</div>';
  if (pk.phase === 'over') {
    const won = pk.winner === 'me';
    const draw = pk.winner === 'draw';
    const cls = draw ? '' : (won ? 'win' : 'lose');
    const txt = draw ? '🤝 平局，魅力不变' : (won ? '🏆 你赢了！魅力 +10' : '😞 你输了，魅力 -10');
    $('pkActions').innerHTML =
      '<div class="pk-result ' + cls + '">' + txt + '</div>' +
      '<button class="pk-btn" onclick="closePk()">确定</button>';
  }
}

function renderDealerUI() {
  if (pk.stage === 2) {
    let btns = '';
    for (const key of (pk.hand || [])) {
      const v = pk.me.attrs[key];
      const stolen = (pk.stolen || []).includes(key);
      btns += '<button class="pk-attr-btn" onclick="pkPickAttr(\'' + key + '\')">' + pkAttrEmoji(key) + ' ' + pkAttrName(key) + '<span class="pk-attr-val">' + v + (stolen ? ' 🎴' : '') + '</span></button>';
    }
    $('pkAttrRow').textContent = '第' + (pk.roundNum + 1) + '局 · 第二阶段：你是庄家，从手牌选一张出（🎴为抽来的牌，不能虚报）';
    $('pkActions').innerHTML =
      '<div class="pk-hint">选择要出的牌</div>' +
      '<div class="pk-attr-grid">' + btns + '</div>';
    return;
  }
  let btns = '';
  for (const a of PK_ATTRS) {
    const v = pk.me.attrs[a.key];
    btns += '<button class="pk-attr-btn" onclick="pkPickAttr(\'' + a.key + '\')">' + a.emoji + ' ' + a.name + '<span class="pk-attr-val">' + v + '</span></button>';
  }
  $('pkAttrRow').textContent = '第' + (pk.roundNum + 1) + '局 · 你是庄家：选一个属性出牌';
  $('pkActions').innerHTML =
    '<div class="pk-hint">选择要出的属性（数值是你的真实点数，之后可虚报）</div>' +
    '<div class="pk-attr-grid">' + btns + '</div>';
}

function pkPickAttr(key) {
  if (!pk) return;
  if (!pk.round) pk.round = { attr: null, followerAttr: null, myReport: null, oppReport: null, myVerify: false, oppVerify: false };
  const myReal = pk.me.attrs[key];
  pk.round.attr = key;
  const isStolen = (pk.stolen || []).includes(key);
  if (isStolen) {
    $('pkAttrRow').textContent = '第' + (pk.roundNum + 1) + '局 · 出 ' + pkAttrName(key) + '（抽来的牌，真实值 ' + myReal + '，不能虚报）';
    $('pkActions').innerHTML =
      '<div class="pk-input-row"><input type="number" id="pkReportInput" min="0" max="100" value="' + myReal + '" class="pk-input" disabled></div>' +
      '<div class="pk-btn-row"><button class="pk-btn" onclick="pkDealerConfirm()">出牌</button></div>';
  } else {
    $('pkAttrRow').textContent = '第' + (pk.roundNum + 1) + '局 · 你是庄家：报出你的' + pkAttrName(key) + '（真实值 ' + myReal + '，可虚报）';
    $('pkActions').innerHTML =
      '<div class="pk-input-row"><input type="number" id="pkReportInput" min="0" max="100" value="' + myReal + '" class="pk-input"></div>' +
      '<div class="pk-btn-row"><button class="pk-btn" onclick="pkDealerConfirm()">出牌</button></div>';
  }
}

function pkDealerConfirm() {
  if (!pk) return;
  const key = pk.round.attr;
  const isStolen = (pk.stolen || []).includes(key);
  const inputEl = $('pkReportInput');
  const rawVal = (inputEl && !inputEl.disabled) ? inputEl.value : pk.me.attrs[key];
  const reportVal = isStolen ? pk.me.attrs[key] : clamp(parseInt(rawVal) || 0, 0, 100);
  if (pk.mode === 'ai') {
    pk.round.myReport = reportVal;
    pk.logs.unshift('你（庄家）出 ' + pkAttrName(key) + '，报点 ' + reportVal);
    pk.phase = 'follower_turn';
    const dec = aiFollowerDecide(reportVal, key);
    pk.round.oppReport = dec.report;
    pk.round.oppVerify = dec.verify;
    if (dec.verify) { pk.oppVerifyLeft--; pk.logs.unshift('对手（后家）选择查验你！'); }
    else pk.logs.unshift('对手（后家）报点 ' + dec.report);
    renderPk();
    setTimeout(resolveAiRound, 700);
  } else {
    dealerSubmitPvp(key, reportVal);
  }
}

function renderFollowerUI() {
  if (pk.stage === 2) {
    const oppReport = pk.round.oppReport;
    let btns = '';
    for (const key of (pk.hand || [])) {
      const v = pk.me.attrs[key];
      const stolen = (pk.stolen || []).includes(key);
      btns += '<button class="pk-attr-btn" onclick="pkFollowerPick(\'' + key + '\')">' + pkAttrEmoji(key) + ' ' + pkAttrName(key) + '<span class="pk-attr-val">' + v + (stolen ? ' 🎴' : '') + '</span></button>';
    }
    $('pkAttrRow').textContent = '第' + (pk.roundNum + 1) + '局 · 第二阶段：对手报点 ' + oppReport + '，从手牌选一张出';
    $('pkActions').innerHTML =
      '<div class="pk-hint">你的手牌（🎴为抽来的牌，不能虚报）</div>' +
      '<div class="pk-attr-grid">' + btns + '</div>';
    return;
  }
  const attr = pk.round.attr;
  const myReal = pk.me.attrs[attr];
  const oppReport = pk.round.oppReport;
  $('pkAttrRow').textContent = '第' + (pk.roundNum + 1) + '局 · 属性：' + pkAttrEmoji(attr) + ' ' + pkAttrName(attr) + '，对手报点 ' + oppReport;
  const canVerify = pk.myVerifyLeft > 0;
  $('pkActions').innerHTML =
    '<div class="pk-hint">你是后家，你的真实' + pkAttrName(attr) + '：<b>' + myReal + '</b>（可虚报）</div>' +
    '<div class="pk-input-row"><input type="number" id="pkReportInput" min="0" max="100" value="' + myReal + '" class="pk-input"></div>' +
    '<div class="pk-btn-row">' +
    '<button class="pk-btn" onclick="pkFollowerConfirm(false)">出牌</button>' +
    '<button class="pk-btn danger" ' + (canVerify ? '' : 'disabled') + ' onclick="pkFollowerConfirm(true)">查验对手' + (canVerify ? '' : '（已用）') + '</button>' +
    '</div>';
}

function pkFollowerPick(key) {
  if (!pk) return;
  pk.round.followerAttr = key;
  const myReal = pk.me.attrs[key];
  const isStolen = (pk.stolen || []).includes(key);
  const canVerify = pk.myVerifyLeft > 0;
  const inputHtml = isStolen
    ? '<div class="pk-input-row"><input type="number" id="pkReportInput" min="0" max="100" value="' + myReal + '" class="pk-input" disabled></div>'
    : '<div class="pk-input-row"><input type="number" id="pkReportInput" min="0" max="100" value="' + myReal + '" class="pk-input"></div>';
  $('pkAttrRow').textContent = isStolen
    ? '第' + (pk.roundNum + 1) + '局 · 出 ' + pkAttrName(key) + '（抽来的牌，真实值 ' + myReal + '，不能虚报）'
    : '第' + (pk.roundNum + 1) + '局 · 报出你的' + pkAttrName(key) + '（真实值 ' + myReal + '，可虚报）';
  $('pkActions').innerHTML =
    inputHtml +
    '<div class="pk-btn-row">' +
    '<button class="pk-btn" onclick="pkFollowerConfirm(false)">出牌</button>' +
    '<button class="pk-btn danger" ' + (canVerify ? '' : 'disabled') + ' onclick="pkFollowerConfirm(true)">查验对手' + (canVerify ? '' : '（已用）') + '</button>' +
    '</div>';
}

function pkFollowerConfirm(verify) {
  if (!pk) return;
  const key = pk.round.followerAttr != null ? pk.round.followerAttr : pk.round.attr;
  const isStolen = (pk.stolen || []).includes(key);
  const inputEl = $('pkReportInput');
  const rawVal = (inputEl && !inputEl.disabled) ? inputEl.value : pk.me.attrs[key];
  const reportVal = isStolen ? pk.me.attrs[key] : clamp(parseInt(rawVal) || 0, 0, 100);
  if (pk.mode === 'ai') aiFollowerSubmit(verify, reportVal);
  else followerSubmitPvp(verify, reportVal);
}

function renderDealerVerifyUI() {
  const oppReport = pk.round.oppReport;
  const canVerify = pk.myVerifyLeft > 0;
  if (pk.stage === 2) {
    $('pkActions').innerHTML =
      '<div class="pk-hint">对方（后家）出牌报点 <b>' + oppReport + '</b></div>' +
      '<div class="pk-btn-row">' +
      '<button class="pk-btn" onclick="pkDealerVerifyConfirm(false)">相信对方</button>' +
      '<button class="pk-btn danger" ' + (canVerify ? '' : 'disabled') + ' onclick="pkDealerVerifyConfirm(true)">查验' + (canVerify ? '' : '（已用）') + '</button>' +
      '</div>';
    return;
  }
  const attr = pk.round.attr;
  $('pkActions').innerHTML =
    '<div class="pk-hint">对方（后家）报点 <b>' + oppReport + '</b>，你的真实' + pkAttrName(attr) + '：<b>' + pk.me.attrs[attr] + '</b></div>' +
    '<div class="pk-btn-row">' +
    '<button class="pk-btn" onclick="pkDealerVerifyConfirm(false)">相信对方</button>' +
    '<button class="pk-btn danger" ' + (canVerify ? '' : 'disabled') + ' onclick="pkDealerVerifyConfirm(true)">查验' + (canVerify ? '' : '（已用）') + '</button>' +
    '</div>';
}

function pkDealerVerifyConfirm(verify) {
  if (!pk) return;
  if (pk.mode === 'ai') aiDealerVerifySubmit(verify);
  else dealerVerifySubmitPvp(verify);
}

function renderWaitingUI(phase) {
  let txt = '等待中…';
  if (phase === 'follower_turn') txt = '等待后家出牌…';
  else if (phase === 'dealer_verify') txt = '等待庄家决定…';
  else if (phase === 'dealer_turn') txt = '等待庄家出牌…';
  $('pkActions').innerHTML = '<div class="pk-hint">⏳ ' + txt + '</div>';
}

function renderStealUI() {
  const turnName = pk.stealTurn === 'follower' ? '后家' : '庄家';
  const myRole = pk.iAmDealer ? '庄家' : '后家';
  $('pkActions').innerHTML =
    '<div class="pk-hint">🃏 ' + (pk.stealLog || ('当前' + turnName + '抽牌中…')) + '</div>' +
    '<div class="pk-hint">你是' + myRole + '，手牌 ' + (pk.myHandLen || 0) + ' 张 vs 对手 ' + (pk.oppHandLen || 0) + ' 张（谁先多 2 张谁赢）</div>';
}

// ---------- 关闭 / 退出 ----------
function closePk() {
  clearPkTimers();
  pk = null;
  $('pkModal').classList.add('hidden');
  if (typeof refreshMe === 'function') refreshMe();
  if (typeof refreshWorld === 'function') refreshWorld();
}

function quitPk(force) {
  if (!pk) { $('pkModal').classList.add('hidden'); return; }
  if (pk.phase !== 'over') {
    if (pk.mode === 'pvp') {
      (async () => {
        try {
          await withLock(async () => {
            const world = await loadWorld();
            const m = (world.pkMatches || {})[pk.matchId];
            if (m && m.phase !== 'over') {
              m.phase = 'over';
              m.winner = m.dealer === myId ? m.follower : m.dealer;
              m.roundResult = { msg: '对方中途退出' };
              m.updatedAt = Date.now();
              await saveWorld(world);
            }
          });
        } catch (e) {}
      })();
    }
    settlePkResult('lose');
  }
  clearPkTimers();
  pk = null;
  $('pkModal').classList.add('hidden');
  if (typeof refreshMe === 'function') refreshMe();
  if (typeof refreshWorld === 'function') refreshWorld();
}
