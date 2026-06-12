// ── Local state ─────────────────────────────────────────────────────────────
const local = {
  playerId: localStorage.getItem('fwc_playerId') || null,
  activeView: 'setup',
  server: null,
  allTeams: [],
  draftGroupFilter: 'ALL',
  draftSearch: '',
  waiverPickup: null,
  pollTimer: null,
};

// ── Bootstrap ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  local.allTeams = await api('/api/teams');
  await poll();
  bindStaticEvents();
  startPolling();
  // Sync live scores on every page load (fire-and-forget, next poll picks up results)
  if (local.server?.phase === 'active' && local.server?.apiEnabled) {
    api('/api/sync-scores', { method: 'POST' });
  }
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
    if (local.activeView === 'setup') showView('draft');
  }

  renderDraft(s);
  renderMyTeams(s);
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
  } else if (s.availableTeamIds.length > 0) {
    banner.textContent = '🔄 Waiver Wire — pick up any undrafted team by dropping one of yours.';
    banner.className = 'waiver-banner';
  } else {
    banner.textContent = '✅ Draft complete — all teams are owned.';
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

  if (s.phase !== 'draft') {
    // ── Post-draft: roster summary + activity log ────────────────────────
    const rosterHtml = s.players.map((p, idx) => {
      const teams = p.teams.map(id => {
        const t = local.allTeams.find(t => t.id === id);
        return t ? `<span class="roster-team">${t.flag} ${t.name}</span>` : '';
      }).join('');
      return `<div class="roster-row">
        <span class="roster-num" style="color:${playerColor(idx)}">${idx + 1}.</span>
        <div class="roster-info">
          <div class="roster-name" style="color:${playerColor(idx)}">${p.name}</div>
          <div class="roster-teams">${teams || '<span class="text-sub">No teams</span>'}</div>
        </div>
      </div>`;
    }).join('');

    const ACT_ICONS = { draft: '🎯', waiver: '🔄', trade: '🤝', system: '⚡' };
    const actHtml = (s.activityLog || []).map(e => {
      const ago = timeAgo(e.ts);
      return `<div class="act-row act-${e.type}">
        <span class="act-icon">${ACT_ICONS[e.type] || '•'}</span>
        <div class="act-body">
          <div class="act-text">${e.text}</div>
          <div class="act-time">${ago}</div>
        </div>
      </div>`;
    }).join('') || '<div class="act-empty">No activity yet.</div>';

    list.innerHTML = `
      <div class="sidebar-section-label">Rosters</div>
      ${rosterHtml}
      <div class="sidebar-section-label" style="margin-top:16px">Activity</div>
      <div id="activity-feed">${actHtml}</div>`;
    return;
  }

  // ── During draft: pick slots ─────────────────────────────────────────────
  const teamCounters = s.players.map(() => 0);
  let html = '';
  for (let i = 0; i < s.totalPicks; i++) {
    const isCurrent = i === s.pickIndex;
    const isFilled = i < s.pickIndex;
    const numPlayers = s.players.length;
    const round = Math.floor(i / numPlayers);
    const posInRound = i % numPlayers;
    const playerIdx = round % 2 === 0 ? posInRound : (numPlayers - 1 - posInRound);
    const player = s.players[playerIdx];

    let teamPart = '';
    if (isFilled && player) {
      const teamIdx = teamCounters[playerIdx] || 0;
      teamCounters[playerIdx] = teamIdx + 1;
      const team = local.allTeams.find(t => t.id === player.teams[teamIdx]);
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
  const waiverMode = s.phase === 'active' && s.availableTeamIds.length > 0;
  const me = s.players.find(p => p.id === local.playerId);
  const query = (local.draftSearch || '').toLowerCase();
  const groups = ['A','B','C','D','E','F','G','H','I','J','K','L'];

  // Waiver drop panel — shown when user has selected a team to pick up
  let waiverPanel = '';
  if (waiverMode && local.waiverPickup && me) {
    const pickup = local.allTeams.find(t => t.id === local.waiverPickup);
    const dropOptions = me.teams.map(id => {
      const t = local.allTeams.find(t => t.id === id);
      return t ? `<button class="waiver-drop-btn" onclick="confirmWaiverDrop('${id}')">${t.flag} ${t.name}</button>` : '';
    }).join('');
    waiverPanel = `<div class="waiver-panel">
      <div class="waiver-panel-title">Pick up ${pickup?.flag || ''} <strong>${pickup?.name || local.waiverPickup}</strong> — drop which team?</div>
      <div class="waiver-drop-options">${dropOptions}</div>
      <button class="waiver-cancel-btn" onclick="cancelWaiver()">Cancel</button>
    </div>`;
  }

  let sectionsHtml = '';
  for (const g of groups) {
    let teams = local.allTeams.filter(t => t.group === g);
    if (query) teams = teams.filter(t => t.name.toLowerCase().includes(query) || t.id.toLowerCase().includes(query));
    if (!teams.length) continue;

    sectionsHtml += `<div class="draft-group-section"><div class="draft-group-title">Group ${g}</div>`;
    for (const t of teams) {
      const available = s.availableTeamIds.includes(t.id);
      const owner = s.players.find(p => p.teams.includes(t.id));
      const isMine = owner?.id === local.playerId;
      const pickable = isMyTurn && available;
      const waiverPickable = waiverMode && available && me && !local.waiverPickup;
      const isSelectedPickup = local.waiverPickup === t.id;
      const clickAttr = pickable ? ` onclick="makePick('${t.id}')"` :
                        waiverPickable ? ` onclick="selectWaiverPickup('${t.id}')"` : '';
      sectionsHtml += `<div class="draft-team-row${!available ? ' taken' : ''}${pickable || waiverPickable ? ' pickable' : ''}${isSelectedPickup ? ' waiver-selected' : ''}"${clickAttr}>
        <span class="draft-row-flag">${t.flag}</span>
        <span class="draft-row-name">${t.name}</span>
        ${!available ? `<span class="draft-row-owner">${isMine ? '✓ Mine' : (owner?.name || 'Taken')}</span>` : ''}
        ${pickable ? '<span class="draft-row-hint">← pick</span>' : ''}
        ${waiverPickable ? '<span class="draft-row-hint">+ pick up</span>' : ''}
        ${isSelectedPickup ? '<span class="draft-row-hint selected">← selected</span>' : ''}
      </div>`;
    }
    sectionsHtml += '</div>';
  }

  grid.innerHTML = (waiverPanel || '') + (sectionsHtml
    ? `<div class="draft-groups-grid">${sectionsHtml}</div>`
    : '<p class="text-sub" style="padding:24px">No teams match.</p>');
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

    // W/D/L/Pts — from API standings if available, else compute from matches
    const standing = Object.values(s.groupStandings).flat().find(r => r.teamId === id);
    let stats = { won: 0, draw: 0, lost: 0, points: 0 };
    if (standing) {
      stats = { won: standing.won, draw: standing.draw, lost: standing.lost, points: standing.points };
    } else {
      for (const m of (s.bracket.GROUP_STAGE || [])) {
        if (m.status !== 'FINISHED') continue;
        if (m.home !== id && m.away !== id) continue;
        const isHome = m.home === id;
        const gf = isHome ? m.homeGoals : m.awayGoals;
        const ga = isHome ? m.awayGoals : m.homeGoals;
        if (gf == null || ga == null) continue;
        if (gf > ga) stats.won++;
        else if (gf === ga) stats.draw++;
        else stats.lost++;
      }
      stats.points = stats.won * 3 + stats.draw;
    }

    // Match history
    const matches = (s.bracket.GROUP_STAGE || []).filter(m => m.home === id || m.away === id);
    const matchRows = matches.map(m => {
      const isHome = m.home === id;
      const oppId = isHome ? m.away : m.home;
      const oppName = isHome ? m.awayName : m.homeName;
      const gf = isHome ? m.homeGoals : m.awayGoals;
      const ga = isHome ? m.awayGoals : m.homeGoals;
      const opp = local.allTeams.find(t => t.id === oppId);
      const dateStr = m.utcDate ? new Date(m.utcDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
      let cls = '', scoreStr = 'upcoming';
      if (m.status === 'FINISHED' && gf != null && ga != null) {
        scoreStr = `${gf} – ${ga}`;
        cls = gf > ga ? 'mh-win' : gf === ga ? 'mh-draw' : 'mh-loss';
      } else if (m.status === 'IN_PLAY' || m.status === 'PAUSED') {
        scoreStr = `${gf ?? 0} – ${ga ?? 0}`;
        cls = 'mh-live';
      }
      return `<div class="mh-row ${cls}">
        <span class="mh-opp">${opp?.flag || ''} ${oppName}</span>
        <span class="mh-score">${scoreStr}</span>
        ${dateStr ? `<span class="mh-date">${dateStr}</span>` : ''}
      </div>`;
    }).join('');

    return `<div class="mtc" onclick="openTeamModal('${id}')">
      <div class="mtc-header">
        <span class="mtc-flag">${team.flag}</span>
        <div class="mtc-meta">
          <div class="mtc-name">${team.name}</div>
          <div class="mtc-conf">${team.confederation}</div>
        </div>
        ${score.placement ? `<span class="mtc-place">🏆 ${ordinal(score.placement)}</span>` : ''}
      </div>

      <div class="mtc-stats">
        <div class="mtc-stat"><div class="mtc-sv">${stats.won}</div><div class="mtc-sl">W</div></div>
        <div class="mtc-stat"><div class="mtc-sv">${stats.draw}</div><div class="mtc-sl">D</div></div>
        <div class="mtc-stat"><div class="mtc-sv">${stats.lost}</div><div class="mtc-sl">L</div></div>
        <div class="mtc-stat mtc-pts"><div class="mtc-sv">${stats.points}</div><div class="mtc-sl">Pts</div></div>
        ${(() => { const gd = (score.goals||0)-(score.conceded||0); const gdStr = gd>0?`+${gd}`:`${gd}`; return `<div class="mtc-stat mtc-gd"><div class="mtc-sv ${gd>0?'mtc-pos':gd<0?'mtc-neg':''}">${gdStr}</div><div class="mtc-sl">GD</div></div>`; })()}
      </div>

      ${matchRows ? `<div class="mtc-matches">${matchRows}</div>` : ''}

    </div>`;
  }).join('');
}

function toggleStars(teamId, btn) {
  const el = document.getElementById(`mtstars-${teamId}`);
  const open = el.classList.toggle('open');
  btn.textContent = open ? '⭐ Star players ▴' : '⭐ Star players ▾';
}
window.toggleStars = toggleStars;

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

  // ── Podium 2: Goal Difference ────────────────────────────────────────────
  const gp = document.getElementById('goals-podium');
  if (!s.standings.goalsPodium?.length) {
    gp.innerHTML = '<div class="podium-empty">Start a draft to see standings.</div>';
  } else {
    gp.innerHTML = s.standings.goalsPodium.map((row, i) => {
      const netStr = row.totalNet > 0 ? `+${row.totalNet}` : `${row.totalNet}`;
      const breakdown = row.teams.map(t => {
        const team = local.allTeams.find(tm => tm.id === t.id);
        const tNet = t.net > 0 ? `+${t.net}` : `${t.net}`;
        return `<div class="gd-team-row">
          <span>${team?.flag || ''} ${team?.name || t.id}</span>
          <span class="gd-team-net ${t.net > 0 ? 'pos' : t.net < 0 ? 'neg' : ''}">${tNet}</span>
          <span class="gd-team-detail">(${t.goals}–${t.conceded})</span>
        </div>`;
      }).join('');
      return `<div class="podium-row">
        <div class="podium-medal">${medals[i] || `${i + 1}.`}</div>
        <div class="podium-info">
          <div class="podium-owner-row">
            <span class="podium-owner">${row.owner}</span>
            <span class="podium-net ${row.totalNet > 0 ? 'pos' : row.totalNet < 0 ? 'neg' : ''}">${netStr} GD</span>
            <span class="podium-gd-detail">(${row.totalGoals} scored – ${row.totalConceded} conceded)</span>
          </div>
          <div class="gd-breakdown">${breakdown}</div>
        </div>
      </div>`;
    }).join('');
  }

  // ── Group stage ──────────────────────────────────────────────────────────
  const gc = document.getElementById('group-stage-container');
  const hasApiStandings = Object.keys(s.groupStandings || {}).length > 0;

  let groupsHtml = '';
  for (const g of GROUPS) {
    let rows;
    if (hasApiStandings && s.groupStandings[g]?.length) {
      rows = [...s.groupStandings[g]].sort((a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf);
    } else {
      rows = local.allTeams.filter(t => t.group === g).map(t => ({
        teamId: t.id, name: t.name, won: 0, draw: 0, lost: 0, points: 0, gd: 0, gf: 0,
      }));
    }
    groupsHtml += `<div class="draft-group-section">
      <div class="draft-group-title">Group ${g}</div>
      <div class="sg-row sg-header">
        <span class="sg-rank">#</span><span class="sg-name">Team</span>
        <div class="sg-stats"><span class="sg-stat">W</span><span class="sg-stat">D</span><span class="sg-stat">L</span>
        <span class="sg-pts">Pts</span></div>
      </div>`;
    rows.forEach((r, i) => {
      const team = local.allTeams.find(t => t.id === r.teamId);
      const owner = s.players.find(p => p.teams.includes(r.teamId));
      const isMine = owner?.id === local.playerId;
      groupsHtml += `<div class="sg-row${isMine ? ' sg-mine' : ''}${i < 2 ? ' sg-advance' : ''}">
        <span class="sg-rank">${i + 1}</span>
        <span class="sg-name">${team?.flag || ''} ${team?.name || r.name}</span>
        <div class="sg-stats"><span class="sg-stat">${r.won || 0}</span><span class="sg-stat">${r.draw || 0}</span><span class="sg-stat">${r.lost || 0}</span>
        <span class="sg-pts">${r.points || 0}</span></div>
      </div>`;
    });
    groupsHtml += '</div>';
  }
  gc.innerHTML = `<div class="draft-groups-grid">${groupsHtml}</div>`;

  // ── Knockout bracket (left → Final ← right) ───────────────────────────────
  const bc = document.getElementById('bracket-container');
  const bracket = s.bracket || {};
  const STAGE_COUNTS = { ROUND_OF_32: 16, ROUND_OF_16: 8, QUARTER_FINALS: 4, SEMI_FINALS: 2 };
  const LEFT_STAGES = ['ROUND_OF_32', 'ROUND_OF_16', 'QUARTER_FINALS', 'SEMI_FINALS'];

  function getSlots(stage) {
    const matches = bracket[stage] || [];
    const total = STAGE_COUNTS[stage];
    return Array.from({ length: total }, (_, i) => matches[i] || null);
  }

  function matchCard(m) {
    if (!m || (m.home === 'TBD' && m.away === 'TBD')) return `<div class="bt-match bt-tbd">
      <div class="bt-team"><span>TBD</span></div><div class="bt-team"><span>TBD</span></div>
    </div>`;
    const ht = m.home !== 'TBD' ? local.allTeams.find(t => t.id === m.home) : null;
    const at = m.away !== 'TBD' ? local.allTeams.find(t => t.id === m.away) : null;
    const finished = m.status === 'FINISHED';
    const live = m.status === 'IN_PLAY' || m.status === 'PAUSED';
    const hWin = finished && m.homeGoals > m.awayGoals;
    const aWin = finished && m.awayGoals > m.homeGoals;
    const hOwner = s.players.find(p => p.teams.includes(m.home));
    const aOwner = s.players.find(p => p.teams.includes(m.away));
    return `<div class="bt-match${live ? ' bt-live' : ''}">
      <div class="bt-team${hOwner?.id === local.playerId ? ' bt-mine' : ''}${hWin ? ' bt-winner' : ''}">
        <span>${ht?.flag || ''} ${ht?.name || m.homeName || 'TBD'}</span>
        ${finished || live ? `<span class="bt-score">${m.homeGoals ?? '–'}</span>` : ''}
      </div>
      <div class="bt-team${aOwner?.id === local.playerId ? ' bt-mine' : ''}${aWin ? ' bt-winner' : ''}">
        <span>${at?.flag || ''} ${at?.name || m.awayName || 'TBD'}</span>
        ${finished || live ? `<span class="bt-score">${m.awayGoals ?? '–'}</span>` : ''}
      </div>
      ${live ? '<div class="bt-live-badge">LIVE</div>' : ''}
    </div>`;
  }

  function stageCol(label, slots) {
    return `<div class="bt-col">
      <div class="bt-col-label">${label}</div>
      <div class="bt-col-matches">${slots.map(m => matchCard(m)).join('')}</div>
    </div>`;
  }

  let bracketHtml = '<div class="bracket-tree">';
  for (const stage of LEFT_STAGES) {
    const slots = getSlots(stage);
    bracketHtml += stageCol(STAGE_LABELS[stage], slots.slice(0, slots.length / 2));
  }
  const finalMatch = (bracket['FINAL'] || [])[0] || null;
  bracketHtml += `<div class="bt-col bt-final-col">
    <div class="bt-col-label">Final</div>
    <div class="bt-col-matches bt-final-matches">${matchCard(finalMatch)}</div>
  </div>`;
  for (let i = LEFT_STAGES.length - 1; i >= 0; i--) {
    const slots = getSlots(LEFT_STAGES[i]);
    bracketHtml += stageCol(STAGE_LABELS[LEFT_STAGES[i]], slots.slice(slots.length / 2));
  }
  bracketHtml += '</div>';
  bc.innerHTML = bracketHtml;
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
      <input type="number" min="0" placeholder="Scored" value="${row.goals}" id="admin-goals-${row.id}">
      <input type="number" min="0" placeholder="Conceded" value="${row.conceded || 0}" id="admin-conceded-${row.id}">
      <input type="number" min="1" max="4" placeholder="Place" value="${row.placement || ''}" id="admin-place-${row.id}">
      <button class="admin-save-btn" onclick="saveScore('${row.id}')">Save</button>
    </div>`;
  }).join('');
}

async function saveScore(teamId) {
  const key = document.getElementById('admin-key-input').value;
  const goals = document.getElementById(`admin-goals-${teamId}`).value;
  const conceded = document.getElementById(`admin-conceded-${teamId}`).value;
  const placement = document.getElementById(`admin-place-${teamId}`).value;
  await api('/api/scores', {
    method: 'POST',
    body: { adminKey: key, teamId, goals: parseInt(goals) || 0, conceded: parseInt(conceded) || 0, placement: placement ? parseInt(placement) : null }
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

// Real jersey numbers (national team where known, else primary club number)
const KNOWN_NUMBERS = {
  // Czech Republic
  'Tomáš Souček': 6, 'Lukáš Provod': 17, 'Patrik Schick': 14,
  // Mexico
  'Edson Álvarez': 4, 'Hirving Lozano': 22, 'Santiago Giménez': 9,
  // South Africa
  'Themba Zwane': 10, 'Percy Tau': 11, 'Evidence Makgopa': 9,
  // South Korea
  'Son Heung-min': 7, 'Lee Kang-in': 17, 'Hwang Hee-chan': 11,
  // Bosnia-Herzegovina
  'Anel Ahmedhodžić': 6, 'Amir Hadziahmetovic': 8, 'Ermedin Demirović': 9,
  // Canada
  'Alphonso Davies': 12, 'Jonathan David': 9, 'Tajon Buchanan': 14,
  // Qatar
  'Hassan Al-Haydos': 10, 'Akram Afif': 11, 'Almoez Ali': 19,
  // Switzerland
  'Granit Xhaka': 10, 'Xherdan Shaqiri': 23, 'Ruben Vargas': 15,
  // Brazil
  'Vinicius Jr.': 7, 'Rodrygo': 11, 'Endrick': 9,
  // Haiti
  'Duckens Nazon': 7, 'Frantzdy Pierrot': 11, 'Steeven Saba': 9,
  // Morocco
  'Achraf Hakimi': 2, 'Hakim Ziyech': 7, 'Youssef En-Nesyri': 9,
  // Scotland
  'Andrew Robertson': 3, 'Scott McTominay': 6, 'Che Adams': 9, 'Cameron Devlin': 14,
  // Australia
  'Mathew Leckie': 7, 'Martin Boyle': 11,
  // Paraguay
  'Miguel Almirón': 10, 'Julio Enciso': 17, 'Antonio Sanabria': 9,
  // Turkey
  'Hakan Çalhanoğlu': 10, 'Arda Güler': 20, 'Kerem Aktürkoğlu': 11,
  // USA
  'Christian Pulisic': 10, 'Gio Reyna': 7, 'Ricardo Pepi': 9,
  // Curaçao
  'Leandro Bacuna': 4, 'Elson Hooi': 9, 'Gevaro Nepomuceno': 7,
  // Ecuador
  'Moisés Caicedo': 6, 'Kendry Páez': 10, 'Gonzalo Plata': 11,
  // Germany
  'Florian Wirtz': 10, 'Jamal Musiala': 14, 'Kai Havertz': 7,
  // Ivory Coast
  'Franck Kessié': 8, 'Sébastien Haller': 9, 'Simon Adingra': 11,
  // Japan
  'Ritsu Doan': 7, 'Kaoru Mitoma': 11, 'Takumi Minamino': 9,
  // Netherlands
  'Xavi Simons': 6, 'Cody Gakpo': 11, 'Memphis Depay': 10,
  // Sweden
  'Dejan Kulusevski': 21, 'Emil Forsberg': 10, 'Alexander Isak': 23,
  // Tunisia
  'Hannibal Mejbri': 8, 'Ellyes Skhiri': 6, 'Wahbi Khazri': 9,
  // Belgium
  'Kevin De Bruyne': 7, 'Romelu Lukaku': 9, 'Jérémy Doku': 11,
  // Egypt
  'Mohamed Salah': 10, 'Omar Marmoush': 7, 'Mostafa Mohamed': 9,
  // Iran
  'Mehdi Taremi': 9, 'Sardar Azmoun': 10, 'Alireza Jahanbakhsh': 11,
  // New Zealand
  'Chris Wood': 9, 'Liberato Cacace': 3, 'Hamish Watson': 14,
  // Cabo Verde
  'Djaniny': 9, 'Garry Rodrigues': 7, 'Ryan Mendes': 10,
  // Saudi Arabia
  'Salem Al-Dawsari': 10, 'Firas Al-Buraikan': 9, 'Saleh Al-Shehri': 11,
  // Spain
  'Pedri': 26, 'Lamine Yamal': 19, 'Álvaro Morata': 7,
  // Uruguay
  'Federico Valverde': 8, 'Darwin Núñez': 19, 'Rodrigo Bentancur': 14,
  // France
  'Kylian Mbappé': 10, 'Antoine Griezmann': 7, 'Ousmane Dembélé': 11,
  // Iraq
  'Ali Adnan': 3, 'Ahmed Yasin': 11, 'Aymen Hussein': 9,
  // Norway
  'Erling Haaland': 9, 'Martin Ødegaard': 8, 'Alexander Sørloth': 10,
  // Senegal
  'Sadio Mané': 10, 'Ismaïla Sarr': 11, 'Idrissa Gana Gueye': 5,
  // Algeria
  'Riyad Mahrez': 7, 'Islam Slimani': 9, 'Youcef Belaïli': 11,
  // Argentina
  'Rodrigo De Paul': 7, 'Lautaro Martínez': 22, 'Julián Álvarez': 9,
  // Austria
  'Marcel Sabitzer': 8, 'Christoph Baumgartner': 10, 'Marko Arnautović': 9,
  // Jordan
  'Musa Al-Taamari': 7, 'Yazan Al-Naimat': 9, 'Baha Faisal': 11,
  // Colombia
  'James Rodríguez': 10, 'Luis Díaz': 7, 'Jhon Durán': 9,
  // DR Congo
  'Dodi Lukébakio': 11, 'Cédric Bakambu': 9, 'Samuel Moutoussamy': 8,
  // Portugal
  'Cristiano Ronaldo': 7, 'Bruno Fernandes': 8, 'Bernardo Silva': 10, 'Rafael Leão': 11,
  // Uzbekistan
  'Eldor Shomurodov': 9, 'Jaloliddin Masharipov': 10, 'Abbosbek Fayzullaev': 7,
  // Croatia
  'Luka Modrić': 10, 'Mateo Kovačić': 8, 'Ivan Perišić': 4,
  // England
  'Harry Kane': 9, 'Jude Bellingham': 10, 'Bukayo Saka': 7,
  // Ghana
  'Mohammed Kudus': 14, 'Iñaki Williams': 9, 'Jordan Ayew': 11,
  // Panama
  'Adalberto Carrasquilla': 8, 'Ismael Díaz': 11, 'Rolando Blackburn': 9,
};
const POS_COLORS = { GK: '#b45309', DF: '#1d4ed8', MF: '#15803d', FW: '#b91c1c' };
const POS_FULL = { GK: 'Goalkeeper', DF: 'Defender', MF: 'Midfielder', FW: 'Forward' };

function assignJerseyNumbers(roster) {
  const assigned = new Set();
  // First pass: use numbers already in the data
  const withKnown = roster.map(p => {
    if (p.number) { assigned.add(p.number); return p; }
    return { ...p, number: null };
  });
  // Second pass: fill remaining sequentially, skipping taken numbers
  const counters = { GK: 0, DF: 0, MF: 0, FW: 0 };
  return withKnown.map(p => {
    if (p.number !== null) return p;
    const pos = p.pos || 'FW';
    const nums = JERSEY_NUMS[pos] || JERSEY_NUMS.FW;
    let num;
    do {
      num = nums[counters[pos]] ?? (counters[pos] + 26);
      counters[pos]++;
    } while (assigned.has(num));
    assigned.add(num);
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
  const SUFFIXES = new Set(['jr.','jr','sr.','sr','ii','iii','iv','v']);
  const parts = p.name.split(' ');
  const meaningful = parts.filter(w => !SUFFIXES.has(w.toLowerCase()));
  const displayName = meaningful.length >= 2
    ? meaningful.slice(-2).join(' ')
    : (meaningful[0] || parts[0]);
  return `<div class="fp${p.star ? ' fp-star' : ''}">
    <div class="fp-avatar" style="background:${color}">
      <span class="fp-init">${init}</span>
      <span class="fp-num">#${p.number}</span>
    </div>
    <div class="fp-name" title="${p.name}">${displayName}</div>
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
        ${stars.map((p, i) => `
          <div class="star-card">
            <div class="star-avatar" id="star-av-${teamId}-${i}" style="background:${POS_COLORS[p.pos] || '#374151'}">
              <span class="star-init" id="star-init-${teamId}-${i}">${playerInitials(p.name)}</span>
            </div>
            <div class="star-name">${p.name}</div>
            <div class="star-meta">
              <span class="pos-badge ${p.pos}" title="${POS_FULL[p.pos] || p.pos}">${p.pos}</span>
              <span class="star-num-badge">#${p.number}</span>
            </div>
            <div class="star-bio" id="star-bio-${teamId}-${i}"></div>
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

  // Fetch star player photos + bios asynchronously
  stars.forEach(async (p, i) => {
    const el = document.getElementById(`star-av-${teamId}-${i}`);
    const bioEl = document.getElementById(`star-bio-${teamId}-${i}`);

    const [photoRes, bioRes] = await Promise.all([
      api(`/api/player-photo?name=${encodeURIComponent(p.name)}`),
      api(`/api/player-bio?name=${encodeURIComponent(p.name)}`),
    ]);

    if (photoRes?.url && el) {
      el.style.background = `url(${photoRes.url}) center top / cover`;
      document.getElementById(`star-init-${teamId}-${i}`)?.remove();
    }
    if (bioRes?.bio && bioEl) {
      bioEl.textContent = bioRes.bio;
    }
  });
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
    if (count > 9) return;
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

  // Draft search
  document.getElementById('draft-search').addEventListener('input', e => {
    local.draftSearch = e.target.value;
    renderAvailableTeams(local.server);
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

// ── Waiver wire actions ───────────────────────────────────────────────────────
function selectWaiverPickup(teamId) {
  local.waiverPickup = teamId;
  renderAvailableTeams(local.server);
}
function cancelWaiver() {
  local.waiverPickup = null;
  renderAvailableTeams(local.server);
}
async function confirmWaiverDrop(dropTeamId) {
  if (!local.playerId || !local.waiverPickup) return;
  const pickup = local.allTeams.find(t => t.id === local.waiverPickup);
  const drop = local.allTeams.find(t => t.id === dropTeamId);
  if (!confirm(`Pick up ${pickup?.flag || ''} ${pickup?.name}?\nYou'll drop ${drop?.flag || ''} ${drop?.name}.`)) return;
  const res = await api('/api/waiver/pickup', {
    method: 'POST',
    body: { playerId: local.playerId, pickupTeamId: local.waiverPickup, dropTeamId }
  });
  local.waiverPickup = null;
  if (res?.success) await poll();
  else alert(res?.error || 'Waiver pickup failed');
}
window.selectWaiverPickup = selectWaiverPickup;
window.cancelWaiver = cancelWaiver;
window.confirmWaiverDrop = confirmWaiverDrop;

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

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function ordinal(n) {
  const s = ['th','st','nd','rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
