require('dotenv').config();
const express = require('express');
const path = require('path');
const os = require('os');
const { TEAMS } = require('./data/teams');

function getLanIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_KEY = process.env.ADMIN_KEY || 'worldcup2026';
const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

// ── Player photo cache + lookup ───────────────────────────────────────────────
const fs = require('fs');
const PHOTO_CACHE_FILE = path.join(__dirname, 'data', 'photo-cache.json');

// Load persisted cache
let photoCacheData = {};
try { photoCacheData = JSON.parse(fs.readFileSync(PHOTO_CACHE_FILE, 'utf8')); } catch {}
const photoCache = new Map(Object.entries(photoCacheData));

function savePhotoCache() {
  fs.writeFileSync(PHOTO_CACHE_FILE, JSON.stringify(Object.fromEntries(photoCache)));
}

// ── Player bio cache ──────────────────────────────────────────────────────────
const BIO_CACHE_FILE = path.join(__dirname, 'data', 'bio-cache.json');
let bioCacheData = {};
try { bioCacheData = JSON.parse(fs.readFileSync(BIO_CACHE_FILE, 'utf8')); } catch {}
const bioCache = new Map(Object.entries(bioCacheData));
function saveBioCache() {
  fs.writeFileSync(BIO_CACHE_FILE, JSON.stringify(Object.fromEntries(bioCache)));
}

// Groq throttle: max 5 calls/min from this app (leaves room for other projects)
let groqCallsThisMinute = 0;
setInterval(() => { groqCallsThisMinute = 0; }, 60_000);

async function fetchPlayerPhoto(name) {
  if (photoCache.has(name)) return photoCache.get(name);

  async function tryWikipedia(title) {
    try {
      const slug = encodeURIComponent(title.replace(/ /g, '_'));
      const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`);
      if (!r.ok) return null;
      const d = await r.json();
      return d.thumbnail?.source || null;
    } catch { return null; }
  }

  // 1. Try Wikipedia directly
  let url = await tryWikipedia(name);

  // 2. Fallback to Groq for name disambiguation (max 5 calls/min)
  if (!url && GROQ_API_KEY && groqCallsThisMinute < 5) {
    groqCallsThisMinute++;
    try {
      const gr = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          messages: [{ role: 'user', content: `Reply with ONLY the exact Wikipedia article title for the footballer named "${name}". Nothing else.` }],
          max_tokens: 20, temperature: 0,
        }),
      });
      if (gr.ok) {
        const gd = await gr.json();
        const title = gd.choices?.[0]?.message?.content?.trim().replace(/^["']|["']$/g, '');
        if (title && title !== name) url = await tryWikipedia(title);
      }
    } catch {}
  }

  photoCache.set(name, url);
  savePhotoCache();
  return url;
}

// ── In-memory game state ─────────────────────────────────────────────────────

let state = {
  phase: 'setup',
  players: [],
  teamsPerPlayer: 3,
  draftOrder: [],
  pickIndex: 0,
  availableTeamIds: TEAMS.map(t => t.id),
  trades: [],
  activityLog: [],       // [{ type, text, ts }]
  scores: {},            // { teamId: { goals, placement } }
  groupStandings: {},    // { 'A': [{teamId,name,played,won,draw,lost,gf,ga,gd,points}] }
  bracket: {},           // { GROUP_STAGE, ROUND_OF_32, ROUND_OF_16, QUARTER_FINALS, SEMI_FINALS, FINAL }
  lastApiSync: 0,
  apiEnabled: !!FOOTBALL_API_KEY,
};

TEAMS.forEach(t => { state.scores[t.id] = { goals: 0, conceded: 0, placement: null }; });

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildSnakeDraft(numPlayers, rounds) {
  const order = [];
  for (let r = 0; r < rounds; r++) {
    const row = Array.from({ length: numPlayers }, (_, i) => i);
    order.push(...(r % 2 === 0 ? row : [...row].reverse()));
  }
  return order;
}

function currentPicker() {
  if (state.phase !== 'draft' || state.pickIndex >= state.draftOrder.length) return null;
  return state.players[state.draftOrder[state.pickIndex]];
}

function findTeam(apiTeam) {
  if (!apiTeam) return null;
  const tla = (apiTeam.tla || '').toUpperCase();
  const name = (apiTeam.name || '').toLowerCase();
  return TEAMS.find(t => t.id === tla) ||
    TEAMS.find(t => t.name.toLowerCase() === name) ||
    TEAMS.find(t => name && t.name.toLowerCase().includes(name) || (name && name.includes(t.name.toLowerCase()))) ||
    null;
}

// ── Standings / podiums (fantasy) ────────────────────────────────────────────

function computeStandings() {
  // Goal difference podium — aggregate across all teams each player owns
  const goalsPodium = state.players.map(player => {
    const teams = player.teams.map(id => {
      const sc = state.scores[id] || {};
      return { id, goals: sc.goals || 0, conceded: sc.conceded || 0, net: (sc.goals || 0) - (sc.conceded || 0) };
    });
    const totalNet = teams.reduce((s, t) => s + t.net, 0);
    const totalGoals = teams.reduce((s, t) => s + t.goals, 0);
    const totalConceded = teams.reduce((s, t) => s + t.conceded, 0);
    return { owner: player.name, totalNet, totalGoals, totalConceded, teams };
  }).sort((a, b) => b.totalNet - a.totalNet || b.totalGoals - a.totalGoals);

  const placedTeams = Object.entries(state.scores)
    .filter(([, s]) => s.placement)
    .map(([id, s]) => ({ id, placement: s.placement }))
    .sort((a, b) => a.placement - b.placement);

  const placementPodium = placedTeams.slice(0, 3).map(t => {
    const owner = state.players.find(p => p.teams.includes(t.id));
    return { rank: t.placement, teamId: t.id, owner: owner?.name || '(undrafted)' };
  });

  return { goalsPodium, placementPodium };
}

// ── Live data sync ───────────────────────────────────────────────────────────

async function doSync() {
  if (!FOOTBALL_API_KEY) return;
  const now = Date.now();
  if (now - state.lastApiSync < 60_000) return;
  state.lastApiSync = now;

  try {
    // 1. All matches → goals + bracket
    const mr = await fetch('https://api.football-data.org/v4/competitions/WC/matches', {
      headers: { 'X-Auth-Token': FOOTBALL_API_KEY }
    });
    if (mr.ok) {
      const md = await mr.json();
      // Reset goals
      TEAMS.forEach(t => { state.scores[t.id].goals = 0; state.scores[t.id].conceded = 0; });

      const STAGE_NORM = { LAST_32: 'ROUND_OF_32', LAST_16: 'ROUND_OF_16' };
      const byStage = {};
      for (const m of md.matches || []) {
        const stage = STAGE_NORM[m.stage] || m.stage || 'UNKNOWN';
        if (!byStage[stage]) byStage[stage] = [];

        // Don't resolve TBD placeholder teams (API uses a real team's tla as placeholder)
        const homeTBD = !m.homeTeam?.name || m.homeTeam.name === 'TBD';
        const awayTBD = !m.awayTeam?.name || m.awayTeam.name === 'TBD';
        const home = homeTBD ? null : findTeam(m.homeTeam);
        const away = awayTBD ? null : findTeam(m.awayTeam);
        const hg = m.score?.fullTime?.home ?? m.score?.halfTime?.home ?? null;
        const ag = m.score?.fullTime?.away ?? m.score?.halfTime?.away ?? null;

        // Accumulate goals from finished / in-play matches
        if (['FINISHED', 'IN_PLAY', 'PAUSED'].includes(m.status)) {
          if (home && hg !== null) state.scores[home.id].goals += hg;
          if (away && ag !== null) state.scores[away.id].goals += ag;
          if (home && ag !== null) state.scores[home.id].conceded += ag;
          if (away && hg !== null) state.scores[away.id].conceded += hg;
        }

        byStage[stage].push({
          home: home?.id || 'TBD',
          homeName: homeTBD ? 'TBD' : (m.homeTeam?.name || 'TBD'),
          away: away?.id || 'TBD',
          awayName: awayTBD ? 'TBD' : (m.awayTeam?.name || 'TBD'),
          homeGoals: hg,
          awayGoals: ag,
          status: m.status,
          utcDate: m.utcDate,
          matchday: m.matchday,
        });
      }
      state.bracket = byStage;
    }

    // 2. Group standings
    const sr = await fetch('https://api.football-data.org/v4/competitions/WC/standings', {
      headers: { 'X-Auth-Token': FOOTBALL_API_KEY }
    });
    if (sr.ok) {
      const sd = await sr.json();
      state.groupStandings = {};
      for (const grp of sd.standings || []) {
        if (grp.type !== 'TOTAL') continue;
        const letter = (grp.group || '').replace('GROUP_', '').replace('Group ', '').trim();
        if (!letter) continue;
        state.groupStandings[letter] = (grp.table || []).map(row => ({
          teamId: findTeam(row.team)?.id || row.team?.tla || '?',
          name: row.team?.name || '?',
          played: row.playedGames || 0,
          won: row.won || 0,
          draw: row.draw || 0,
          lost: row.lost || 0,
          gf: row.goalsFor || 0,
          ga: row.goalsAgainst || 0,
          gd: row.goalDifference || 0,
          points: row.points || 0,
        }));
      }
    }

    console.log(`[sync] goals + standings updated`);
  } catch (e) {
    console.error('[sync] error:', e.message);
  }
}

// ── API routes ───────────────────────────────────────────────────────────────

app.get('/api/teams', (_, res) => res.json(TEAMS));

app.get('/api/state', (_, res) => {
  const picker = currentPicker();
  res.json({
    phase: state.phase,
    players: state.players,
    teamsPerPlayer: state.teamsPerPlayer,
    pickIndex: state.pickIndex,
    totalPicks: state.draftOrder.length,
    currentPickerId: picker?.id || null,
    currentPickerName: picker?.name || null,
    availableTeamIds: state.availableTeamIds,
    trades: state.trades,
    activityLog: state.activityLog.slice(0, 50),
    scores: state.scores,
    standings: computeStandings(),
    groupStandings: state.groupStandings,
    bracket: state.bracket,
    apiEnabled: state.apiEnabled,
    lastSync: state.lastApiSync,
  });
});

app.post('/api/setup', (req, res) => {
  const { players, teamsPerPlayer } = req.body;
  if (state.phase !== 'setup') return res.status(400).json({ error: 'Game already started' });
  if (!Array.isArray(players) || players.length < 2) return res.status(400).json({ error: 'Need at least 2 players' });

  state.players = players.map((name, i) => ({ id: `p${i}`, name: name.trim(), teams: [] }));
  state.teamsPerPlayer = teamsPerPlayer || 3;
  state.draftOrder = buildSnakeDraft(state.players.length, state.teamsPerPlayer);
  state.pickIndex = 0;
  state.availableTeamIds = TEAMS.map(t => t.id);
  state.trades = [];
  state.activityLog = [];
  TEAMS.forEach(t => { state.scores[t.id] = { goals: 0, conceded: 0, placement: null }; });
  state.phase = 'draft';

  console.log(`Game started: ${state.players.length} players, ${state.teamsPerPlayer} picks each`);
  res.json({ success: true });
});

app.post('/api/draft/pick', (req, res) => {
  const { playerId, teamId } = req.body;
  if (state.phase !== 'draft') return res.status(400).json({ error: 'Not in draft phase' });

  const picker = currentPicker();
  if (!picker || picker.id !== playerId) return res.status(403).json({ error: 'Not your turn' });
  if (!state.availableTeamIds.includes(teamId)) return res.status(400).json({ error: 'Team not available' });

  const team = TEAMS.find(t => t.id === teamId);
  picker.teams.push(teamId);
  state.availableTeamIds = state.availableTeamIds.filter(id => id !== teamId);
  state.pickIndex++;

  if (state.pickIndex >= state.draftOrder.length) {
    state.phase = 'active';
    state.activityLog.unshift({ type: 'system', text: 'Draft complete — game is live!', ts: Date.now() });
    console.log('Draft complete — game is now active');
    if (FOOTBALL_API_KEY) doSync();
  }

  res.json({ success: true, phase: state.phase });
});

app.post('/api/waiver/pickup', (req, res) => {
  const { playerId, pickupTeamId, dropTeamId } = req.body;
  if (state.phase !== 'active') return res.status(400).json({ error: 'Waiver pickups only available after draft' });

  const player = state.players.find(p => p.id === playerId);
  if (!player) return res.status(403).json({ error: 'Unknown player' });
  if (!state.availableTeamIds.includes(pickupTeamId)) return res.status(400).json({ error: 'Team not available' });
  if (!player.teams.includes(dropTeamId)) return res.status(400).json({ error: "You don't own that team" });

  const pickup = TEAMS.find(t => t.id === pickupTeamId);
  const drop = TEAMS.find(t => t.id === dropTeamId);
  player.teams = player.teams.filter(id => id !== dropTeamId);
  state.availableTeamIds = state.availableTeamIds.filter(id => id !== pickupTeamId);
  player.teams.push(pickupTeamId);
  state.availableTeamIds.push(dropTeamId);

  state.activityLog.unshift({ type: 'waiver', text: `${player.name} picked up ${pickup?.flag || ''} ${pickup?.name || pickupTeamId}, dropped ${drop?.flag || ''} ${drop?.name || dropTeamId}`, ts: Date.now() });
  console.log(`Waiver: ${player.name} dropped ${dropTeamId}, picked up ${pickupTeamId}`);
  res.json({ success: true });
});

app.post('/api/trade/propose', (req, res) => {
  const { fromId, toId, offerTeamId, requestTeamId } = req.body;
  const from = state.players.find(p => p.id === fromId);
  const to = state.players.find(p => p.id === toId);
  if (!from || !to) return res.status(400).json({ error: 'Unknown player' });
  if (!from.teams.includes(offerTeamId)) return res.status(400).json({ error: "You don't own that team" });
  if (!to.teams.includes(requestTeamId)) return res.status(400).json({ error: "They don't own that team" });

  state.trades = state.trades.filter(t =>
    !(t.fromId === fromId && t.toId === toId && t.status === 'pending')
  );

  const trade = { id: `t${Date.now()}`, fromId, toId, offerTeamId, requestTeamId, status: 'pending', ts: Date.now() };
  state.trades.push(trade);
  res.json({ success: true, tradeId: trade.id });
});

app.post('/api/trade/respond', (req, res) => {
  const { tradeId, playerId, accept } = req.body;
  const trade = state.trades.find(t => t.id === tradeId && t.status === 'pending');
  if (!trade) return res.status(404).json({ error: 'Trade not found' });
  if (trade.toId !== playerId) return res.status(403).json({ error: 'Not your trade to respond to' });

  if (accept) {
    const from = state.players.find(p => p.id === trade.fromId);
    const to = state.players.find(p => p.id === trade.toId);
    if (!from.teams.includes(trade.offerTeamId) || !to.teams.includes(trade.requestTeamId)) {
      trade.status = 'cancelled';
      return res.status(400).json({ error: 'Teams no longer owned — trade cancelled' });
    }
    from.teams = from.teams.filter(t => t !== trade.offerTeamId);
    from.teams.push(trade.requestTeamId);
    to.teams = to.teams.filter(t => t !== trade.requestTeamId);
    to.teams.push(trade.offerTeamId);
    trade.status = 'accepted';
    const offerTeam = TEAMS.find(t => t.id === trade.offerTeamId);
    const reqTeam = TEAMS.find(t => t.id === trade.requestTeamId);
    state.activityLog.unshift({ type: 'trade', text: `${from.name} traded ${offerTeam?.flag || ''} ${offerTeam?.name || trade.offerTeamId} to ${to.name} for ${reqTeam?.flag || ''} ${reqTeam?.name || trade.requestTeamId}`, ts: Date.now() });
  } else {
    trade.status = 'rejected';
  }

  res.json({ success: true });
});

app.post('/api/trade/cancel', (req, res) => {
  const { tradeId, playerId } = req.body;
  const trade = state.trades.find(t => t.id === tradeId && t.status === 'pending');
  if (!trade) return res.status(404).json({ error: 'Trade not found' });
  if (trade.fromId !== playerId) return res.status(403).json({ error: 'Not your trade' });
  trade.status = 'cancelled';
  res.json({ success: true });
});

app.post('/api/scores', (req, res) => {
  const { adminKey, teamId, goals, conceded, placement } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: 'Bad admin key' });
  if (!state.scores[teamId]) return res.status(404).json({ error: 'Unknown team' });
  if (goals !== undefined) state.scores[teamId].goals = parseInt(goals, 10) || 0;
  if (conceded !== undefined) state.scores[teamId].conceded = parseInt(conceded, 10) || 0;
  if (placement !== undefined) state.scores[teamId].placement = placement ? parseInt(placement, 10) : null;
  res.json({ success: true });
});

app.post('/api/sync-scores', async (req, res) => {
  if (!FOOTBALL_API_KEY) return res.status(400).json({ error: 'No API key configured' });
  state.lastApiSync = 0; // force bypass rate limit
  try {
    await doSync();
    const matchesSynced = Object.values(state.bracket).flat().length;
    res.json({ success: true, matchesSynced });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/player-photo', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });
  const url = await fetchPlayerPhoto(name);
  res.json({ url: url || null });
});

app.get('/api/player-bio', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });

  if (bioCache.has(name)) return res.json({ bio: bioCache.get(name) });
  if (!GROQ_API_KEY || groqCallsThisMinute >= 5) return res.json({ bio: null });

  groqCallsThisMinute++;
  try {
    const gr = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: `In 12 words or fewer, describe what ${name} is best known for as a footballer. No filler, no name repetition.` }],
        max_tokens: 25, temperature: 0.3,
      }),
    });
    if (gr.ok) {
      const gd = await gr.json();
      const bio = gd.choices?.[0]?.message?.content?.trim().replace(/^["']|["']$/g, '') || null;
      bioCache.set(name, bio);
      saveBioCache();
      return res.json({ bio });
    }
  } catch {}
  bioCache.set(name, null);
  saveBioCache();
  res.json({ bio: null });
});

app.post('/api/reset', (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: 'Bad admin key' });
  state.phase = 'setup';
  state.players = [];
  state.draftOrder = [];
  state.pickIndex = 0;
  state.availableTeamIds = TEAMS.map(t => t.id);
  state.trades = [];
  state.activityLog = [];
  state.groupStandings = {};
  state.bracket = {};
  TEAMS.forEach(t => { state.scores[t.id] = { goals: 0, conceded: 0, placement: null }; });
  console.log('Game reset');
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  const lanIP = getLanIP();
  console.log(`\n⚽  Fantasy World Cup 2026`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Network: http://${lanIP}:${PORT}  ← share this with players`);
  console.log(`   Admin key: ${ADMIN_KEY}`);
  if (FOOTBALL_API_KEY) {
    console.log(`   Live scores: enabled — auto-sync every 5 min`);
    // Initial sync + auto-sync every 5 minutes
    doSync();
    setInterval(doSync, 5 * 60 * 1000);
  } else {
    console.log(`   Live scores: disabled (set FOOTBALL_API_KEY to enable)`);
  }
  console.log('');
});
