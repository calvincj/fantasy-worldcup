// ── Local state ─────────────────────────────────────────────────────────────
const local = {
  playerId: localStorage.getItem('fwc_playerId') || null,
  activeView: 'setup',
  server: null,
  allTeams: [],
  draftGroupFilter: 'ALL',
  allTeamsGroupFilter: 'ALL',
  draftSearch: '',
  allTeamsSearch: '',
  pollTimer: null,
};

// ── Bootstrap ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  local.allTeams = await api('/api/teams');
  await poll();
  bindStaticEvents();
  startPolling();
});

function startPolling() {
  clearInterval(local.pollTimer);
  const interval = local.server?.phase === 'draft' ? 2000 : 10000;
  local.pollTimer = setInterval(poll, interval);
}

async function poll() {
  const s = await api('/api/state');
  if (!s) return;
  local.server = s;
  render(s);
  startPolling(); // re-schedule with appropriate interval
}

// ── Render dispatcher ────────────────────────────────────────────────────────
function render(s) {
  updateHeader(s);

  if (s.phase === 'setup') {
    showView('setup');
    return;
  }

  // Show nav after setup
  document.getElementById('main-nav').classList.remove('hidden');

  // Check if we need identity
  if (!local.playerId) {
    showIdentityModal(s);
    return;
  }

  if (s.phase === 'draft') {
    if (local.activeView === 'setup') showView('draft');
    renderDraft(s);
  } else {
    if (local.activeView === 'setup' || local.activeView === 'draft') {
      // Draft just completed — switch to my teams
      showView('my-teams');
    }
  }

  renderDraft(s);
  renderMyTeams(s);
  renderAllTeams(s);
  renderStandings(s);
  renderTrades(s);

  // Trade badge
  const pending = s.trades.filter(t => t.toId === local.playerId && t.status === 'pending');
  const badge = document.getElementById('trade-badge');
  if (pending.length > 0) {
    badge.textContent = pending.length;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

// ── Header ───────────────────────────────────────────────────────────────────
function updateHeader(s) {
  const chip = document.getElementById('identity-display');
  const switchBtn = document.getElementById('change-identity-btn');
  const player = s.players.find(p => p.id === local.playerId);
  if (player) {
    chip.textContent = '👤 ' + player.name;
    chip.classList.remove('hidden');
    switchBtn.classList.remove('hidden');
  } else {
    chip.classList.add('hidden');
    switchBtn.classList.add('hidden');
  }

  const syncBtn = document.getElementById('sync-scores-btn');
  if (s.apiEnabled) syncBtn.classList.remove('hidden');
}

// ── Draft view ───────────────────────────────────────────────────────────────
function renderDraft(s) {
  if (local.activeView !== 'draft' && s.phase !== 'draft') return;

  const picker = s.players.find(p => p.id === s.currentPickerId);
  const isMyTurn = s.currentPickerId === local.playerId;
  const banner = document.getElementById('pick-banner');
  const fill = document.getElementById('draft-progress-fill');
  const pct = s.totalPicks > 0 ? Math.round((s.pickIndex / s.totalPicks) * 100) : 0;

  if (s.phase === 'draft') {
    banner.textContent = isMyTurn
      ? `🎉 Your pick! (Pick ${s.pickIndex + 1} of ${s.totalPicks})`
      : `⏳ Waiting for ${s.currentPickerName || '?'} to pick… (${s.pickIndex + 1}/${s.totalPicks})`;
    banner.className = isMyTurn ? 'your-turn' : '';
  } else {
    banner.textContent = '✅ Draft complete! Game is live.';
    banner.className = '';
  }
  fill.style.width = pct + '%';

  // Draft board sidebar
  renderDraftBoard(s);

  // Available teams grid
  renderAvailableTeams(s);
}

function renderDraftBoard(s) {
  const list = document.getElementById('draft-board-list');
  const rows = [];

  for (let i = 0; i < s.totalPicks; i++) {
    const pick = s.players.length > 0 ? s.players[s.players.indexOf(
      s.players.find((_, idx) => {
        // We need to reconstruct the draft order slot
        return false; // handled below via the picks array
      })
    )] : null;
    rows.push({ slot: i, isCurrent: i === s.pickIndex, filled: i < s.pickIndex });
  }

  // Build a slot→{player,team} map from the picks log
  // Since server doesn't return picks log, reconstruct from player.teams
  // We know: draftOrder[i] = playerIndex (snake), and teams were added in draft order
  const slotMap = [];
  // Use players' teams arrays — teams[0] = 1st pick, teams[1] = 2nd pick, etc.
  // Reconstruct by iterating over the draftOrder slots
  const teamCounters = s.players.map(() => 0);

  let html = '';
  for (let i = 0; i < s.totalPicks; i++) {
    const isCurrent = i === s.pickIndex && s.phase === 'draft';
    const isFilled = i < s.pickIndex;
    // Find player for this slot — we don't have draftOrder on client; derive from snake pattern
    const numPlayers = s.players.length;
    const round = Math.floor(i / numPlayers);
    const posInRound = i % numPlayers;
    const playerIdx = round % 2 === 0 ? posInRound : (numPlayers - 1 - posInRound);
    const player = s.players[playerIdx];

    let teamPart = '';
    if (isFilled && player) {
      const teamIdx = teamCounters[playerIdx] || 0;
      teamCounters[playerIdx] = teamIdx + 1;
      const teamId = player.teams[teamIdx];
      const team = local.allTeams.find(t => t.id === teamId);
      teamPart = team ? `<span class="pick-team">${team.flag} ${team.name}</span>` : '';
    }

    html += `<div class="draft-pick-item ${isCurrent ? 'current-slot' : ''}">
      <span class="pick-num">${i + 1}.</span>
      <div>
        <div class="pick-player" style="color:${player ? playerColor(playerIdx) : 'var(--sub)'}">${player?.name || '?'}</div>
        ${teamPart}
        ${isCurrent ? '<span style="font-size:11px;color:var(--green)">← picking now</span>' : ''}
      </div>
    </div>`;
  }
  list.innerHTML = html || '<p class="text-sub">No picks yet.</p>';
}

const PLAYER_COLORS = ['#22c55e','#3b82f6','#f59e0b','#ec4899','#a78bfa','#f97316','#06b6d4','#84cc16'];
function playerColor(idx) { return PLAYER_COLORS[idx % PLAYER_COLORS.length]; }

function renderAvailableTeams(s) {
  const grid = document.getElementById('available-teams-grid');
  const isMyTurn = s.phase === 'draft' && s.currentPickerId === local.playerId;

  let teams = local.allTeams.filter(t => s.availableTeamIds.includes(t.id));

  // Filter by group
  if (local.draftGroupFilter !== 'ALL') teams = teams.filter(t => t.group === local.draftGroupFilter);
  if (local.draftSearch) {
    const q = local.draftSearch.toLowerCase();
    teams = teams.filter(t => t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q));
  }

  if (teams.length === 0) {
    grid.innerHTML = '<p class="text-sub" style="padding:24px">No teams match.</p>';
    return;
  }

  grid.innerHTML = teams.map(t => teamCardHTML(t, {
    showPickBtn: isMyTurn,
    available: true,
    owner: null,
    isMine: false,
    draftMode: true,
  })).join('');
}

// ── My Teams view ────────────────────────────────────────────────────────────
function renderMyTeams(s) {
  const me = s.players.find(p => p.id === local.playerId);
  const grid = document.getElementById('my-teams-grid');
  const sub = document.getElementById('my-teams-subtext');

  if (!me) { grid.innerHTML = '<p class="text-sub">Select your identity first.</p>'; return; }

  const goals = me.teams.reduce((sum, id) => sum + (s.scores[id]?.goals || 0), 0);
  sub.textContent = `${me.teams.length} / ${s.teamsPerPlayer} teams picked · ${goals} total goals`;

  if (me.teams.length === 0) {
    grid.innerHTML = '<p class="text-sub" style="padding:24px">You haven\'t picked any teams yet.</p>';
    return;
  }

  grid.innerHTML = me.teams.map(id => {
    const team = local.allTeams.find(t => t.id === id);
    if (!team) return '';
    const score = s.scores[id] || {};
    return `<div class="team-card mine my-team-card" onclick="openTeamModal('${id}')">
      <div class="team-card-flag">${team.flag}</div>
      <div class="team-card-name">${team.name}</div>
      <div class="team-card-conf">${team.confederation}</div>
      <div class="team-card-stars">
        ${team.stars.map(star => `<div class="star-row">${star}</div>`).join('')}
      </div>
      <div style="margin-top:12px;display:flex;gap:12px;font-size:14px;">
        <span>⚽ <strong>${score.goals || 0}</strong> goals</span>
        ${score.placement ? `<span>🏆 <strong>${ordinal(score.placement)}</strong> place</span>` : ''}
      </div>
    </div>`;
  }).join('');
}

// ── All Teams view ────────────────────────────────────────────────────────────
function renderAllTeams(s) {
  const grid = document.getElementById('all-teams-grid');
  let teams = [...local.allTeams];

  if (local.allTeamsGroupFilter !== 'ALL') teams = teams.filter(t => t.group === local.allTeamsGroupFilter);
  if (local.allTeamsSearch) {
    const q = local.allTeamsSearch.toLowerCase();
    teams = teams.filter(t => t.name.toLowerCase().includes(q));
  }

  grid.innerHTML = teams.map(t => {
    const ownerPlayer = s.players.find(p => p.teams.includes(t.id));
    const isMine = ownerPlayer?.id === local.playerId;
    const available = s.availableTeamIds.includes(t.id) && s.phase === 'draft';
    return teamCardHTML(t, { showPickBtn: false, available, owner: ownerPlayer?.name || null, isMine });
  }).join('');
}

// ── Standings view ────────────────────────────────────────────────────────────
const GROUPS = ['A','B','C','D','E','F','G','H','I','J','K','L'];
const STAGE_LABELS = {
  GROUP_STAGE: 'Group Stage',
  ROUND_OF_32: 'Round of 32',
  ROUND_OF_16: 'Round of 16',
  QUARTER_FINALS: 'Quarter-Finals',
  SEMI_FINALS: 'Semi-Finals',
  FINAL: 'Final',
};

function renderStandings(s) {
  const medals = ['🥇','🥈','🥉'];

  // ── Fantasy podiums ──────────────────────────────────────────────────────
  const pp = document.getElementById('placement-podium');
  if (!s.standings.placementPodium.length) {
    pp.innerHTML = '<div class="podium-empty">Set after knockout stage completes.</div>';
  } else {
    pp.innerHTML = s.standings.placementPodium.map(row => {
      const team = local.allTeams.find(t => t.id === row.teamId);
      return `<div class="podium-row">
        <div class="podium-medal">${medals[row.rank - 1] || row.rank}</div>
        <div class="podium-info">
          <div class="podium-owner">${row.owner}</div>
          <div class="podium-team">${team?.flag || ''} ${team?.name || row.teamId}</div>
        </div>
      </div>`;
    }).join('');
  }

  const gp = document.getElementById('goals-podium');
  const hasGoals = s.standings.goalsPodium.some(r => r.goals > 0);
  if (!hasGoals) {
    gp.innerHTML = '<div class="podium-empty">Goals appear once matches begin.</div>';
  } else {
    gp.innerHTML = s.standings.goalsPodium.map((row, i) => {
      const team = local.allTeams.find(t => t.id === row.teamId);
      return `<div class="podium-row">
        <div class="podium-medal">${medals[i]}</div>
        <div class="podium-info">
          <div class="podium-owner">${row.owner}</div>
          <div class="podium-team">${team?.flag || ''} ${team?.name || row.teamId} · ${row.goals}g</div>
        </div>
      </div>`;
    }).join('');
  }

  // ── Group stage tables ───────────────────────────────────────────────────
  const gc = document.getElementById('group-stage-container');
  const hasApiStandings = Object.keys(s.groupStandings || {}).length > 0;

  if (hasApiStandings) {
    gc.innerHTML = GROUPS.map(g => {
      const rows = s.groupStandings[g] || [];
      if (!rows.length) return '';
      return `<div class="group-block">
        <div class="group-block-title">Group ${g}</div>
        <table class="group-table">
          <thead><tr>
            <th class="gt-pos">#</th>
            <th class="gt-team">Team</th>
            <th>P</th><th>W</th><th>D</th><th>L</th>
            <th>GF</th><th>GA</th><th>GD</th><th>Pts</th>
          </tr></thead>
          <tbody>${rows.map((r, i) => {
            const team = local.allTeams.find(t => t.id === r.teamId);
            const owner = s.players.find(p => p.teams.includes(r.teamId));
            const isMine = owner?.id === local.playerId;
            const advance = i < 2 ? 'gt-advance' : '';
            return `<tr class="${advance}${isMine ? ' gt-mine' : ''}">
              <td class="gt-pos">${i + 1}</td>
              <td class="gt-team">${team?.flag || ''} ${team?.name || r.name}${isMine ? ' <span class="gt-owned">✓</span>' : ''}</td>
              <td>${r.played}</td><td>${r.won}</td><td>${r.draw}</td><td>${r.lost}</td>
              <td>${r.gf}</td><td>${r.ga}</td>
              <td>${r.gd > 0 ? '+' : ''}${r.gd}</td>
              <td class="gt-pts">${r.points}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>`;
    }).filter(Boolean).join('');
  } else {
    // Fallback: build groups from teams data
    gc.innerHTML = GROUPS.map(g => {
      const teams = local.allTeams.filter(t => t.group === g);
      if (!teams.length) return '';
      return `<div class="group-block">
        <div class="group-block-title">Group ${g}</div>
        <table class="group-table">
          <thead><tr>
            <th class="gt-pos">#</th>
            <th class="gt-team">Team</th>
            <th>P</th><th>Pts</th><th>GF</th>
          </tr></thead>
          <tbody>${teams.map((t, i) => {
            const sc = s.scores[t.id] || {};
            const owner = s.players.find(p => p.teams.includes(t.id));
            const isMine = owner?.id === local.playerId;
            return `<tr class="${isMine ? 'gt-mine' : ''}">
              <td class="gt-pos">${i + 1}</td>
              <td class="gt-team">${t.flag} ${t.name}${owner ? ` <span class="gt-owned">${isMine ? '✓' : owner.name}</span>` : ''}</td>
              <td>–</td><td>–</td><td>${sc.goals || 0}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>`;
    }).filter(Boolean).join('');
  }

  // ── Knockout bracket ─────────────────────────────────────────────────────
  const bc = document.getElementById('bracket-container');
  const bracket = s.bracket || {};
  const knockoutStages = ['ROUND_OF_32','ROUND_OF_16','QUARTER_FINALS','SEMI_FINALS','FINAL'];
  const hasKnockout = knockoutStages.some(st => (bracket[st] || []).length > 0);

  if (!hasKnockout) {
    bc.innerHTML = '<div class="bracket-empty">Knockout bracket appears after group stage completes.</div>';
    return;
  }

  bc.innerHTML = knockoutStages.map(stage => {
    const matches = bracket[stage] || [];
    if (!matches.length) return '';
    return `<div class="bracket-stage">
      <div class="bracket-stage-title">${STAGE_LABELS[stage] || stage}</div>
      <div class="bracket-matches">
        ${matches.map(m => {
          const ht = local.allTeams.find(t => t.id === m.home);
          const at = local.allTeams.find(t => t.id === m.away);
          const hName = ht?.name || m.homeName || m.home;
          const aName = at?.name || m.awayName || m.away;
          const hFlag = ht?.flag || '';
          const aFlag = at?.flag || '';
          const finished = m.status === 'FINISHED';
          const live = m.status === 'IN_PLAY' || m.status === 'PAUSED';
          const hOwner = s.players.find(p => p.teams.includes(m.home));
          const aOwner = s.players.find(p => p.teams.includes(m.away));
          return `<div class="bracket-match ${live ? 'bm-live' : ''}">
            <div class="bm-team ${hOwner?.id === local.playerId ? 'bm-mine' : ''} ${finished && m.homeGoals > m.awayGoals ? 'bm-winner' : ''}">
              <span>${hFlag} ${hName}</span>
              ${finished || live ? `<span class="bm-score">${m.homeGoals ?? '–'}</span>` : ''}
            </div>
            <div class="bm-team ${aOwner?.id === local.playerId ? 'bm-mine' : ''} ${finished && m.awayGoals > m.homeGoals ? 'bm-winner' : ''}">
              <span>${aFlag} ${aName}</span>
              ${finished || live ? `<span class="bm-score">${m.awayGoals ?? '–'}</span>` : ''}
            </div>
            ${live ? '<div class="bm-live-badge">LIVE</div>' : ''}
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }).filter(Boolean).join('');
}

// ── Admin score modal ─────────────────────────────────────────────────────────
function renderAdminModal(s) {
  const list = document.getElementById('admin-team-list');
  const scored = Object.entries(s.scores)
    .map(([id, sc]) => ({ id, ...sc }))
    .sort((a, b) => b.goals - a.goals || a.id.localeCompare(b.id));

  list.innerHTML = scored.map(row => {
    const team = local.allTeams.find(t => t.id === row.id);
    if (!team) return '';
    return `<div class="admin-row">
      <span>${team.flag}</span>
      <span style="font-size:13px">${team.name}</span>
      <input type="number" min="0" placeholder="Goals" value="${row.goals}" id="admin-goals-${row.id}">
      <input type="number" min="1" max="4" placeholder="Place" value="${row.placement || ''}" id="admin-place-${row.id}">
      <button class="admin-save-btn" onclick="saveScore('${row.id}')">Save</button>
    </div>`;
  }).join('');
}

async function saveScore(teamId) {
  const key = document.getElementById('admin-key-input').value;
  const goals = document.getElementById(`admin-goals-${teamId}`).value;
  const placement = document.getElementById(`admin-place-${teamId}`).value;
  await api('/api/scores', {
    method: 'POST',
    body: { adminKey: key, teamId, goals: parseInt(goals) || 0, placement: placement ? parseInt(placement) : null }
  });
  await poll();
}
window.saveScore = saveScore;

// ── Trades view ───────────────────────────────────────────────────────────────
function renderTrades(s) {
  const list = document.getElementById('trades-list');
  const active = s.trades.filter(t => t.status !== 'cancelled');

  if (active.length === 0) {
    list.innerHTML = '<div class="trades-empty">No trades yet.<br>Propose one after the draft!</div>';
    return;
  }

  list.innerHTML = active.map(trade => {
    const from = s.players.find(p => p.id === trade.fromId);
    const to = s.players.find(p => p.id === trade.toId);
    const offerTeam = local.allTeams.find(t => t.id === trade.offerTeamId);
    const reqTeam = local.allTeams.find(t => t.id === trade.requestTeamId);
    const isIncoming = trade.toId === local.playerId && trade.status === 'pending';
    const isMine = trade.fromId === local.playerId && trade.status === 'pending';

    let actions = '';
    if (isIncoming) {
      actions = `<div class="trade-actions">
        <button class="btn-primary" onclick="respondTrade('${trade.id}', true)">✓ Accept</button>
        <button class="btn-danger" onclick="respondTrade('${trade.id}', false)">✗ Reject</button>
      </div>`;
    } else if (isMine) {
      actions = `<div class="trade-actions">
        <button class="btn-ghost" onclick="cancelTrade('${trade.id}')">Cancel</button>
      </div>`;
    }

    return `<div class="trade-item ${isIncoming ? 'incoming' : ''}">
      <div>
        <div class="trade-summary">
          <strong>${from?.name || '?'}</strong> offers ${offerTeam?.flag || ''} <strong>${offerTeam?.name || '?'}</strong>
          ⇄ <strong>${to?.name || '?'}</strong>'s ${reqTeam?.flag || ''} <strong>${reqTeam?.name || '?'}</strong>
          ${isIncoming ? '<span style="color:var(--gold);margin-left:8px">← incoming!</span>' : ''}
        </div>
        <div class="trade-meta">${isIncoming ? 'They want your team' : isMine ? 'Awaiting response' : ''}</div>
        ${actions}
      </div>
      <span class="trade-status-badge ${trade.status}">${trade.status}</span>
    </div>`;
  }).join('');
}

// ── Formation helpers ─────────────────────────────────────────────────────────
const JERSEY_NUMS = {
  GK: [1, 12, 23],
  DF: [2, 3, 4, 5, 13, 15, 16, 24],
  MF: [6, 8, 10, 14, 17, 18, 19, 20],
  FW: [7, 9, 11, 21, 22, 25],
};
const POS_COLORS = { GK: '#b45309', DF: '#1d4ed8', MF: '#15803d', FW: '#b91c1c' };

function assignJerseyNumbers(roster) {
  const counters = { GK: 0, DF: 0, MF: 0, FW: 0 };
  return roster.map(p => {
    const pos = p.pos || 'FW';
    const nums = JERSEY_NUMS[pos] || JERSEY_NUMS.FW;
    const num = nums[counters[pos]] ?? (counters[pos] + 26);
    counters[pos] = (counters[pos] || 0) + 1;
    return { ...p, number: num };
  });
}

function nameHash(name) {
  return name.split('').reduce((h, c) => ((h * 31) + c.charCodeAt(0)) & 0xFFFF, 0);
}

function playerValue(player) {
  const h = nameHash(player.name);
  if (player.star) return 50 + (h % 76);
  const base = { FW: 18, MF: 14, DF: 10, GK: 8 }[player.pos] || 10;
  const range = { FW: 22, MF: 16, DF: 12, GK: 12 }[player.pos] || 12;
  return base + (h % range);
}

function playerInitials(name) {
  const parts = name.replace(/[^\w\s\-]/g, '').split(/[\s\-]+/).filter(Boolean);
  return parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase();
}

function formationPlayerHTML(p) {
  const val = playerValue(p);
  const init = playerInitials(p.name);
  const color = POS_COLORS[p.pos] || '#374151';
  const lastName = p.name.split(' ').pop();
  return `<div class="fp${p.star ? ' fp-star' : ''}">
    <div class="fp-avatar" style="background:${color}">
      <span class="fp-init">${init}</span>
      <span class="fp-num">#${p.number}</span>
    </div>
    <div class="fp-name" title="${p.name}">${lastName}</div>
    <div class="fp-val">$${val}M</div>
  </div>`;
}

// ── Team detail modal ─────────────────────────────────────────────────────────
function openTeamModal(teamId) {
  const team = local.allTeams.find(t => t.id === teamId);
  if (!team) return;
  const s = local.server;
  const score = s?.scores[teamId] || {};
  const owner = s?.players.find(p => p.teams.includes(teamId));

  const numbered = assignJerseyNumbers(team.roster);
  const byPos = { GK: [], DF: [], MF: [], FW: [] };
  numbered.forEach(p => { (byPos[p.pos] || byPos.FW).push(p); });
  const stars = numbered.filter(p => p.star);

  const pitchRows = [
    { label: 'ATT', players: byPos.FW },
    { label: 'MID', players: byPos.MF },
    { label: 'DEF', players: byPos.DF },
    { label: 'GK',  players: byPos.GK },
  ].filter(r => r.players.length > 0);

  document.getElementById('team-modal-content').innerHTML = `
    <div class="team-detail-header">
      <div class="team-detail-flag">${team.flag}</div>
      <div class="team-detail-meta">
        <div class="team-detail-name">${team.name}</div>
        <div class="team-detail-conf">${team.confederation} · ${owner ? `Owned by <strong>${owner.name}</strong>` : 'Available'}</div>
        ${score.goals > 0 || score.placement ? `
          <div class="team-detail-scores">
            <span>⚽ <strong>${score.goals || 0}</strong> goals</span>
            ${score.placement ? `<span>🏆 <strong>${ordinal(score.placement)}</strong> place</span>` : ''}
          </div>` : ''}
      </div>
    </div>

    <div class="stars-section">
      <div class="section-label">⭐ Star Players</div>
      <div class="stars-cards">
        ${stars.map(p => `
          <div class="star-card">
            <div class="star-avatar" style="background:${POS_COLORS[p.pos] || '#374151'}">
              <span class="star-init">${playerInitials(p.name)}</span>
              <span class="star-num">#${p.number}</span>
            </div>
            <div class="star-name">${p.name}</div>
            <div class="star-meta">
              <span class="pos-badge ${p.pos}">${p.pos}</span>
              <span class="star-val">$${playerValue(p)}M</span>
            </div>
          </div>`).join('')}
      </div>
    </div>

    <div class="formation-section">
      <div class="section-label">Formation</div>
      <div class="formation-pitch">
        ${pitchRows.map(row => `
          <div class="formation-row">
            <span class="formation-row-label">${row.label}</span>
            <div class="formation-row-players">
              ${row.players.map(p => formationPlayerHTML(p)).join('')}
            </div>
          </div>`).join('')}
      </div>
    </div>
  `;
  document.getElementById('team-modal').classList.remove('hidden');
}
window.openTeamModal = openTeamModal;

// ── Trade modal ───────────────────────────────────────────────────────────────
function openTradeModal() {
  const s = local.server;
  const me = s?.players.find(p => p.id === local.playerId);
  if (!me) return alert('Select your identity first.');
  if (me.teams.length === 0) return alert('You have no teams to trade yet.');

  const offerSel = document.getElementById('trade-offer-select');
  const targetSel = document.getElementById('trade-target-select');
  const requestSel = document.getElementById('trade-request-select');

  offerSel.innerHTML = me.teams.map(id => {
    const t = local.allTeams.find(x => x.id === id);
    return `<option value="${id}">${t?.flag || ''} ${t?.name || id}</option>`;
  }).join('');

  const others = s.players.filter(p => p.id !== local.playerId && p.teams.length > 0);
  targetSel.innerHTML = others.map(p => `<option value="${p.id}">${p.name}</option>`).join('');

  function updateRequestOptions() {
    const targetId = targetSel.value;
    const target = s.players.find(p => p.id === targetId);
    requestSel.innerHTML = (target?.teams || []).map(id => {
      const t = local.allTeams.find(x => x.id === id);
      return `<option value="${id}">${t?.flag || ''} ${t?.name || id}</option>`;
    }).join('');
  }
  targetSel.onchange = updateRequestOptions;
  updateRequestOptions();

  document.getElementById('trade-modal').classList.remove('hidden');
}

// ── Event binding ─────────────────────────────────────────────────────────────
function bindStaticEvents() {
  // Tab navigation
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      showView(btn.dataset.view);
    });
  });

  // Setup — add player
  document.getElementById('add-player-btn').addEventListener('click', () => {
    const inputs = document.getElementById('player-inputs');
    const count = inputs.querySelectorAll('.player-input-row').length + 1;
    if (count > 8) return;
    const row = document.createElement('div');
    row.className = 'player-input-row';
    row.innerHTML = `<input class="text-input" type="text" placeholder="Player ${count} name">
      <button class="remove-player-btn" title="Remove">✕</button>`;
    row.querySelector('.remove-player-btn').addEventListener('click', () => row.remove());
    inputs.appendChild(row);
  });

  // Setup — start draft
  document.getElementById('start-draft-btn').addEventListener('click', async () => {
    const names = [...document.querySelectorAll('#player-inputs .text-input')]
      .map(i => i.value.trim()).filter(Boolean);
    if (names.length < 2) return alert('Need at least 2 players!');
    const tpp = parseInt(document.getElementById('teams-per-player').value);
    const res = await api('/api/setup', { method: 'POST', body: { players: names, teamsPerPlayer: tpp } });
    if (res?.success) await poll();
    else alert(res?.error || 'Setup failed');
  });

  // Draft group filter chips
  document.querySelectorAll('#draft-view .chip[data-group]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#draft-view .chip[data-group]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      local.draftGroupFilter = btn.dataset.group;
      renderAvailableTeams(local.server);
    });
  });

  // Draft search
  document.getElementById('draft-search').addEventListener('input', e => {
    local.draftSearch = e.target.value;
    renderAvailableTeams(local.server);
  });

  // All teams group filter
  document.querySelectorAll('.chip[data-group2]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chip[data-group2]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      local.allTeamsGroupFilter = btn.dataset.group2;
      renderAllTeams(local.server);
    });
  });

  // All teams search
  document.getElementById('all-teams-search').addEventListener('input', e => {
    local.allTeamsSearch = e.target.value;
    renderAllTeams(local.server);
  });

  // Change identity
  document.getElementById('change-identity-btn').addEventListener('click', () => {
    local.playerId = null;
    localStorage.removeItem('fwc_playerId');
    showIdentityModal(local.server);
  });

  // Propose trade button
  document.getElementById('propose-trade-btn').addEventListener('click', openTradeModal);

  // Trade submit
  document.getElementById('trade-submit-btn').addEventListener('click', async () => {
    const offerTeamId = document.getElementById('trade-offer-select').value;
    const toId = document.getElementById('trade-target-select').value;
    const requestTeamId = document.getElementById('trade-request-select').value;
    if (!offerTeamId || !toId || !requestTeamId) return alert('Fill in all trade fields.');
    const res = await api('/api/trade/propose', {
      method: 'POST',
      body: { fromId: local.playerId, toId, offerTeamId, requestTeamId }
    });
    if (res?.success) {
      document.getElementById('trade-modal').classList.add('hidden');
      showView('trades');
      await poll();
    } else {
      alert(res?.error || 'Trade failed');
    }
  });

  // Trade cancel button (modal)
  document.getElementById('trade-cancel-btn').addEventListener('click', () => {
    document.getElementById('trade-modal').classList.add('hidden');
  });

  // Team modal close
  document.getElementById('team-modal-close').addEventListener('click', () => {
    document.getElementById('team-modal').classList.add('hidden');
  });
  document.getElementById('team-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
  });

  // Admin modal
  document.getElementById('open-admin-btn').addEventListener('click', () => {
    renderAdminModal(local.server);
    document.getElementById('admin-modal').classList.remove('hidden');
  });
  document.getElementById('admin-modal-close').addEventListener('click', () => {
    document.getElementById('admin-modal').classList.add('hidden');
  });

  // Reset game
  document.getElementById('reset-game-btn').addEventListener('click', async () => {
    if (!confirm('Reset the entire game? This clears all picks, scores, and trades.')) return;
    const key = document.getElementById('admin-key-input').value;
    const res = await api('/api/reset', { method: 'POST', body: { adminKey: key } });
    if (res?.success) {
      document.getElementById('admin-modal').classList.add('hidden');
      local.playerId = null;
      localStorage.removeItem('fwc_playerId');
      await poll();
    } else {
      alert(res?.error || 'Reset failed — check admin key');
    }
  });

  // Sync live scores
  document.getElementById('sync-scores-btn').addEventListener('click', async () => {
    const btn = document.getElementById('sync-scores-btn');
    btn.textContent = '⏳ Syncing…';
    btn.disabled = true;
    const res = await api('/api/sync-scores', { method: 'POST' });
    btn.textContent = '🔄 Sync Live Scores';
    btn.disabled = false;
    if (res?.success) {
      await poll();
      alert(`Synced ${res.matchesSynced} matches.`);
    } else {
      alert(res?.error || res?.message || 'Sync failed');
    }
  });
}

// ── Identity modal ────────────────────────────────────────────────────────────
function showIdentityModal(s) {
  const modal = document.getElementById('identity-modal');
  const listEl = document.getElementById('identity-player-list');
  listEl.innerHTML = s.players.map(p =>
    `<button class="identity-option" data-pid="${p.id}">${p.name}</button>`
  ).join('');
  listEl.querySelectorAll('.identity-option').forEach(btn => {
    btn.addEventListener('click', () => {
      local.playerId = btn.dataset.pid;
      localStorage.setItem('fwc_playerId', local.playerId);
      modal.classList.add('hidden');
      render(s);
    });
  });
  modal.classList.remove('hidden');
}

// ── Draft pick handler ────────────────────────────────────────────────────────
async function makePick(teamId) {
  if (!local.playerId) return alert('Select your identity first.');
  const res = await api('/api/draft/pick', {
    method: 'POST',
    body: { playerId: local.playerId, teamId }
  });
  if (res?.success) await poll();
  else alert(res?.error || 'Pick failed');
}
window.makePick = makePick;

// ── Trade actions ─────────────────────────────────────────────────────────────
async function respondTrade(tradeId, accept) {
  const res = await api('/api/trade/respond', {
    method: 'POST',
    body: { tradeId, playerId: local.playerId, accept }
  });
  if (res?.success) await poll();
  else alert(res?.error || 'Response failed');
}
window.respondTrade = respondTrade;

async function cancelTrade(tradeId) {
  await api('/api/trade/cancel', { method: 'POST', body: { tradeId, playerId: local.playerId } });
  await poll();
}
window.cancelTrade = cancelTrade;

// ── Team card HTML ────────────────────────────────────────────────────────────
function teamCardHTML(team, { showPickBtn, available, owner, isMine, draftMode }) {
  const taken = !available && !isMine && !!owner;
  const clickAction = (showPickBtn && draftMode)
    ? `makePick('${team.id}')`
    : `openTeamModal('${team.id}')`;
  const pickable = showPickBtn && draftMode;
  return `<div class="team-card ${isMine ? 'mine' : ''} ${taken ? 'taken' : ''} ${pickable ? 'pickable' : ''}" onclick="${clickAction}">
    <div class="team-card-flag">${team.flag}</div>
    <div class="team-card-name">${team.name}</div>
    <div class="team-card-conf">${team.confederation}</div>
    ${!draftMode ? `<div class="team-card-stars">
      ${team.stars.map(s => `<div class="star-row">${s}</div>`).join('')}
    </div>` : ''}
    ${owner ? `<div class="team-card-owner ${isMine ? 'mine-label' : ''}">
      ${isMine ? '✓ Mine' : `Owner: ${owner}`}</div>` : ''}
    ${pickable ? `<div class="pick-hint">Tap to draft</div>` : ''}
  </div>`;
}

// ── View switcher ─────────────────────────────────────────────────────────────
function showView(name) {
  local.activeView = name;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const viewEl = document.getElementById(`${name}-view`);
  viewEl.classList.remove('hidden');
  viewEl.classList.add('active');

  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === name);
  });

  // Trigger re-render for the newly shown view
  if (local.server) {
    if (name === 'draft') renderDraft(local.server);
    if (name === 'my-teams') renderMyTeams(local.server);
    if (name === 'all-teams') renderAllTeams(local.server);
    if (name === 'standings') renderStandings(local.server);
    if (name === 'trades') renderTrades(local.server);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────
async function api(url, opts = {}) {
  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    return res.json();
  } catch { return null; }
}

function ordinal(n) {
  const s = ['th','st','nd','rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
