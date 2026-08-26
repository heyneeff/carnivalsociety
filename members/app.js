// ── API client ────────────────────────────────────────────────────────
// Same-origin Worker at /api/*. Auth is a session cookie set by the Worker,
// not a client-held token — no Supabase, no client-side key.
async function apiFetch(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    credentials: 'same-origin',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// Most render*View functions are async and get called by their router
// without an await/catch (fire-and-forget, so navigation itself stays
// synchronous). If one throws, it used to vanish as a silent unhandled
// rejection — the screen would just sit on "Loading…" forever with zero
// feedback. This surfaces it instead, with a tap-to-retry banner.
window.addEventListener('unhandledrejection', event => {
  console.error('Unhandled error:', event.reason);
  let banner = document.getElementById('globalErrorBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'globalErrorBanner';
    banner.className = 'global-error-banner';
    document.body.appendChild(banner);
  }
  const msg = (event.reason && event.reason.message) || 'Something went wrong loading this page.';
  banner.textContent = `${msg} — tap to retry`;
  banner.onclick = () => { banner.remove(); render(); };
});

const app = document.getElementById('app');
let session = false; // true once signed in
let profile = null;
let chapters = [];
let boards = [];
let crewEvents = []; // upcoming events the signed-in user is crew on (or, for moderators, all upcoming events)
let activeCrewEventId = null; // which of crewEvents the Schedule/Meetups/Projects/Materials nav is currently pointed at

// Escape user-supplied text before it goes into innerHTML — display names,
// post titles/bodies, and replies are all attacker-controllable strings.
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// ── Boot ──────────────────────────────────────────────────────────────
async function boot() {
  try {
    const { user } = await apiFetch('/api/me');
    if (user) { session = true; profile = user; await loadAppData(); }
  } catch (e) { /* not signed in */ }
  render();
}

async function loadAppData() {
  const [{ chapters: chapterData }, { boards: boardData }, { events: crewData }] = await Promise.all([
    apiFetch('/api/chapters'),
    apiFetch('/api/boards'),
    apiFetch('/api/me/crew'),
  ]);
  chapters = chapterData || [];
  boards = boardData || [];
  crewEvents = crewData || [];
  activeCrewEventId = crewEvents[0]?.id || null;
}

// The event whose crew hub (schedule/meetups/projects/materials) the signed-in
// user is currently working in — defaults to the nearest upcoming one they're
// rostered on, switchable via the sidebar's event picker when they're on more
// than one crew (kept out of the nav itself so multiple events don't turn into
// multiple copies of the Schedule/Meetups/Projects/Materials links).
function myCrewEvent() {
  return crewEvents.find(e => e.id === activeCrewEventId) || crewEvents[0] || null;
}

async function refreshProfile() {
  const { user } = await apiFetch('/api/me');
  profile = user;
}

window.addEventListener('hashchange', render);

// ── Render root ───────────────────────────────────────────────────────
function render() {
  if (!session || !profile) { session = false; profile = null; renderPreAuth(); return; }
  if (!profile.onboarded) { renderOnboarding(); return; }
  renderShell();
}

// ── Pre-auth ─────────────────────────────────────────────────────────
async function renderPreAuth() {
  renderAuthScreen();
}

// ── Auth screen: the real sign-in/join form, plus a "tap your name" quick
// sign-in panel alongside it for every non-Ringleader member guild-wide.
// Ringleaders (and anyone with a real account they want to use) still sign
// in with email + password on the left. ─────────────────────────────────
async function ensureChaptersLoaded() {
  if (!chapters.length) { const { chapters: c } = await apiFetch('/api/chapters'); chapters = c || []; }
}

async function renderAuthScreen(mode = 'signin', errorMsg = '') {
  const chapterOptions = chapters.length
    ? chapters.map(c => `<option value="${c.id}">${c.name}</option>`).join('')
    : '<option value="">Loading chapters…</option>';

  let roster = [];
  let rosterFailed = false;
  try {
    const { members } = await apiFetch('/api/quick-signin-roster');
    roster = members || [];
  } catch (e) { rosterFailed = true; }

  app.innerHTML = `
    <div class="auth-screen">
      <div class="auth-panel">
        <h1>Guild Hall</h1>
        <p class="auth-sub">Carnival Society International — members only.</p>
        <div class="auth-tabs">
          <button class="auth-tab ${mode === 'signin' ? 'active' : ''}" id="tabSignin">Sign In</button>
          <button class="auth-tab ${mode === 'signup' ? 'active' : ''}" id="tabSignup">Join the Guild</button>
        </div>
        <form class="auth-form" id="authForm">
          ${mode === 'signup' ? `
          <div class="auth-field">
            <label for="displayName">Name</label>
            <input type="text" id="displayName" required>
          </div>
          <div class="auth-field">
            <label for="homeChapter">Home Chapter</label>
            <select id="homeChapter" required>${chapterOptions}</select>
          </div>` : ''}
          <div class="auth-field">
            <label for="email">Email</label>
            <input type="email" id="email" required>
          </div>
          <div class="auth-field">
            <label for="password">Password</label>
            <input type="password" id="password" minlength="6" required>
          </div>
          <p class="auth-error">${escapeHtml(errorMsg)}</p>
          <button type="submit" class="auth-submit">${mode === 'signup' ? 'Join' : 'Enter'}</button>
        </form>
      </div>
      ${roster.length || rosterFailed ? `
      <div class="auth-panel quickpick-panel">
        <h1>Or Tap Your Name</h1>
        ${rosterFailed ? `
        <p class="auth-sub">Couldn't load the member list.</p>
        <button type="button" class="gm-btn" id="quickpickRetryBtn">Retry</button>
        ` : `
        <p class="auth-sub">No password needed.</p>
        <div class="quickpick-grid">
          ${roster.map(m => `<button type="button" class="quickpick-btn" data-user="${m.id}">${escapeHtml(m.display_name)}</button>`).join('')}
        </div>
        <p class="auth-error" id="quickpickError"></p>
        `}
      </div>` : ''}
    </div>
  `;

  if (rosterFailed) {
    document.getElementById('quickpickRetryBtn').addEventListener('click', () => renderAuthScreen(mode, errorMsg));
  }

  document.getElementById('tabSignin').onclick = () => renderAuthScreen('signin');
  document.getElementById('tabSignup').onclick = async () => { await ensureChaptersLoaded(); renderAuthScreen('signup'); };

  document.querySelectorAll('.quickpick-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.quickpick-btn').forEach(b => { b.disabled = true; });
      const original = btn.textContent;
      btn.textContent = 'Signing in…';
      const errorEl = document.getElementById('quickpickError');
      if (errorEl) errorEl.textContent = '';
      try {
        const { user } = await apiFetch('/api/quick-signin', { method: 'POST', body: { user_id: btn.dataset.user } });
        session = true;
        profile = user;
        await loadAppData();
        render();
      } catch (err) {
        document.querySelectorAll('.quickpick-btn').forEach(b => { b.disabled = false; });
        btn.textContent = original;
        if (errorEl) errorEl.textContent = err.message || 'Sign-in failed. Try again.';
      }
    });
  });

  document.getElementById('authForm').addEventListener('submit', async e => {
    e.preventDefault();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    if (mode === 'signup') {
      const displayName = document.getElementById('displayName').value.trim();
      const homeChapterId = document.getElementById('homeChapter').value;
      try {
        const { user } = await apiFetch('/api/auth/signup', {
          method: 'POST',
          body: { email, password, display_name: displayName, home_chapter_id: homeChapterId },
        });
        session = true;
        profile = user;
        await loadAppData();
        render();
      } catch (err) {
        renderAuthScreen('signup', err.message);
      }
    } else {
      try {
        const { user } = await apiFetch('/api/auth/signin', { method: 'POST', body: { email, password } });
        session = true;
        profile = user;
        await loadAppData();
        render();
      } catch (err) {
        renderAuthScreen('signin', err.message);
      }
    }
  });
}

// ── Onboarding — shown once after signup (or on next sign-in if skipped) ──
async function renderOnboarding() {
  const { members } = await apiFetch('/api/members/search');
  app.innerHTML = `
    <div class="auth-screen">
      <div class="auth-panel" style="max-width:600px;">
        <h1>Welcome, ${escapeHtml(profile.display_name)}</h1>
        <p class="auth-sub">A little about you — helps the guild know who's who.</p>
        <div class="auth-form">
          <div class="auth-field">
            <label for="obSkills">Skills (comma separated)</label>
            <input id="obSkills" type="text" placeholder="e.g. rigging, sound, hospitality, fire safety…">
          </div>
          <div class="auth-field">
            <label for="obBirthday">Birthday</label>
            <input id="obBirthday" type="date">
          </div>
          <div class="auth-field">
            <label>Who do you know here?</label>
            <div id="obConnections" style="max-height:220px;overflow-y:auto;border:1px solid var(--border);border-radius:3px;padding:0.5rem 0.75rem;">
              ${members.length ? members.map(m => `
                <label style="display:flex;align-items:center;gap:8px;padding:5px 0;font-style:normal;font-size:0.95rem;letter-spacing:normal;text-transform:none;color:var(--cream);cursor:pointer;">
                  <input type="checkbox" class="obConnCheck" value="${m.id}" style="width:15px;height:15px;">
                  ${escapeHtml(m.display_name)}${m.home_chapter ? ` <span style="color:var(--cream-soft);font-size:0.82rem;">· ${escapeHtml(m.home_chapter.name)}</span>` : ''}
                </label>
              `).join('') : '<div class="placeholder-note" style="border:none;padding:0.5rem 0;">No other members yet — you\'re early.</div>'}
            </div>
          </div>
          <button class="auth-submit" id="obFinishBtn">Finish</button>
          <button class="gm-btn" id="obSkipBtn" style="background:none;border:1px solid var(--border);">Skip for now</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById('obFinishBtn').addEventListener('click', async () => {
    const skills = document.getElementById('obSkills').value.trim();
    const birthday = document.getElementById('obBirthday').value || null;
    const connectedIds = [...document.querySelectorAll('.obConnCheck:checked')].map(el => el.value);
    const { user } = await apiFetch('/api/me', { method: 'PATCH', body: { skills, birthday, onboarded: true } });
    await Promise.all(connectedIds.map(id => apiFetch('/api/connections', { method: 'POST', body: { connected_user_id: id } })));
    profile = user;
    await loadAppData();
    render();
  });
  document.getElementById('obSkipBtn').addEventListener('click', async () => {
    const { user } = await apiFetch('/api/me', { method: 'PATCH', body: { onboarded: true } });
    profile = user;
    await loadAppData();
    render();
  });
}

// ── App shell ────────────────────────────────────────────────────────
// Assigning members to an event's crew ("Manage Crew" on Events) is switched
// off for now -- won't be needed for a while. The crew Hub itself (nav link,
// tabs, routes) stays fully in place; only the assignment UI is hidden. Flip
// this back on whenever crew assignment starts being used again.
const CREW_ASSIGNMENT_ENABLED = false;

function currentRoute() {
  return window.location.hash.replace(/^#\/?/, '') || 'hub';
}

function renderShell() {
  const route = currentRoute();
  const initials = (profile?.display_name || '?').trim().slice(0, 1).toUpperCase();
  const rankLabel = profile && !profile.is_ringleader ? profile.rank.charAt(0).toUpperCase() + profile.rank.slice(1) : '';
  const ringleaderTag = profile?.is_ringleader ? 'Ringleader' : '';

  const onGuildHallBoard = route === 'guild-hall' || chapters.some(c => c.slug === route);

  app.innerHTML = `
    <div class="shell">
      <div class="sidebar">
        <div class="sidebar-mark">
          <span class="crest">Carnival Society</span>
          <span class="crest-sub">Guild Hall</span>
        </div>
        <div>
          <ul class="nav-list nav-list-hub">
            <li><a class="nav-link ${route === 'hub' || route.startsWith('crew/') ? 'active' : ''}" href="#/hub">Hub</a></li>
          </ul>
        </div>
        <div>
          <div class="nav-group-label">Boards</div>
          <ul class="nav-list">
            <li><a class="nav-link ${onGuildHallBoard ? 'active' : ''}" href="#/guild-hall">Guild Hall</a></li>
          </ul>
        </div>
        <div>
          <div class="nav-group-label">Calendar</div>
          <ul class="nav-list">
            <li><a class="nav-link ${route === 'events' ? 'active' : ''}" href="#/events">Events</a></li>
          </ul>
        </div>
        <div>
          <div class="nav-group-label">Direct</div>
          <ul class="nav-list">
            <li><a class="nav-link ${route === 'dm' || route.startsWith('dm/') ? 'active' : ''}" href="#/dm">Messages</a></li>
          </ul>
        </div>
        ${profile?.is_ringleader ? `
        <div>
          <div class="nav-group-label">Ringleader</div>
          <ul class="nav-list">
            <li><a class="nav-link ${route === 'admin' ? 'active' : ''}" href="#/admin">Members Hub</a></li>
            <li><a class="nav-link ${route === 'field' ? 'active' : ''}" href="#/field">Guild Map</a></li>
            <li><a class="nav-link ${route === 'projects' ? 'active' : ''}" href="#/projects">Projects</a></li>
            <li><a class="nav-link ${route === 'network' ? 'active' : ''}" href="#/network">Member Network</a></li>
            <li><a class="nav-link ${route === 'meetings' ? 'active' : ''}" href="#/meetings">Meetings</a></li>
          </ul>
        </div>` : ''}
        <div class="sidebar-footer">
          <div class="profile-card">
            <div class="profile-avatar">${escapeHtml(initials)}</div>
            <div>
              <div class="profile-name">${escapeHtml(profile?.display_name || '')}</div>
              <div class="rank-badge">${escapeHtml(rankLabel)}${escapeHtml(ringleaderTag)}</div>
            </div>
          </div>
          <button class="signout-btn" id="signoutBtn">Sign Out</button>
        </div>
      </div>
      <div class="main" id="mainView"></div>
    </div>
  `;

  document.getElementById('signoutBtn').onclick = async () => {
    await apiFetch('/api/auth/signout', { method: 'POST' });
    session = false; profile = null; chapters = []; boards = []; crewEvents = []; activeCrewEventId = null;
    render();
  };

  renderMainView(route);
}

function renderMainView(route) {
  const mainView = document.getElementById('mainView');
  stopDMPolling();
  if (route === 'hub') { renderCrewTabs(mainView, 'overview'); return; }
  if (route.startsWith('crew/')) { renderCrewTabs(mainView, route.slice(5)); return; }
  if (route === 'dm') { renderDMListView(mainView); return; }
  if (route.startsWith('dm/')) { renderDMThreadView(mainView, route.slice(3)); return; }
  if (route === 'events') { renderEventsView(mainView); return; }
  if (route === 'admin') { renderAdminView(mainView); return; }
  if (route === 'field') { renderFieldView(mainView); return; }
  if (route === 'projects') { renderProjectsView(mainView); return; }
  if (route === 'network') { renderNetworkView(mainView); return; }
  if (route === 'meetings') { renderMeetingsView(mainView); return; }
  if (route.startsWith('post/')) { renderThreadView(mainView, route.slice(5)); return; }
  renderGuildHallTabs(mainView, route === 'guild-hall' ? 'guild-hall' : route);
}

// Chapters not open yet — locked in the tab bar instead of removed, so the
// nav still shows the guild's full shape.
const LOCKED_BOARD_SLUGS = ['denver', 'los-angeles'];

function renderGuildHallTabs(mainView, activeSlug) {
  const boardTabs = [{ slug: 'guild-hall', name: 'Guild Hall' }, ...chapters.map(c => ({ slug: c.slug, name: c.name }))];
  const active = boardTabs.some(t => t.slug === activeSlug) ? activeSlug : 'guild-hall';

  mainView.innerHTML = `
    <h2>Guild Hall</h2>
    <div class="crew-tabs">
      ${boardTabs.map(t => LOCKED_BOARD_SLUGS.includes(t.slug)
        ? `<span class="crew-tab locked" title="Not open yet">${escapeHtml(t.name)} 🔒</span>`
        : `<a class="crew-tab ${active === t.slug ? 'active' : ''}" href="#/${t.slug}">${escapeHtml(t.name)}</a>`
      ).join('')}
    </div>
    <div id="guildHallTabBody"><div class="placeholder-note">Loading…</div></div>
  `;

  const body = document.getElementById('guildHallTabBody');
  if (LOCKED_BOARD_SLUGS.includes(active)) {
    body.innerHTML = `<div class="placeholder-note">This chapter board isn't open yet.</div>`;
    return;
  }
  renderBoardView(body, active);
}

function authorBadge(authorProfile) {
  if (!authorProfile) return '';
  const label = authorProfile.is_ringleader
    ? 'Ringleader'
    : authorProfile.rank.charAt(0).toUpperCase() + authorProfile.rank.slice(1);
  return `<span class="rank-tag">${escapeHtml(label)}</span>`;
}

function isModerator() {
  return !!profile && (profile.rank === 'master' || profile.is_ringleader);
}

// ── Rank metadata: shared order + color coding for badges, selects, sorting ──
const RANKS = ['apprentice', 'journeyman', 'master', 'clown'];
const RANK_COLORS = {
  apprentice: 'var(--cream-soft)',
  journeyman: 'var(--accent-2)',
  master: 'var(--gold-bright)',
  clown: 'var(--accent-4)',
};
function rankLabel(rank) {
  return rank.charAt(0).toUpperCase() + rank.slice(1);
}
function rankColor(rank) {
  return RANK_COLORS[rank] || 'var(--cream)';
}

// ── Board view: composer + top-level post list ─────────────────────────
async function renderBoardView(mainView, slug) {
  const board = boards.find(b => b.slug === slug);
  if (!board) {
    mainView.innerHTML = `<div class="placeholder-note">That board doesn't exist.</div>`;
    return;
  }
  mainView.innerHTML = `<div class="placeholder-note">Loading…</div>`;

  const { posts } = await apiFetch(`/api/posts?board_id=${board.id}`);

  const postListHtml = (posts || []).map(p => `
    <div class="post-card ${p.pinned ? 'pinned' : ''}" data-post-id="${p.id}">
      <div class="post-title-row">
        ${p.pinned ? '<span class="pin-flag">📌</span>' : ''}
        <span class="post-title">${escapeHtml(p.title || '(untitled)')}</span>
      </div>
      <div class="post-meta">${escapeHtml(p.author?.display_name || 'unknown')} ${authorBadge(p.author)} · ${timeAgo(p.created_at)}</div>
      <div class="post-snippet">${escapeHtml((p.body || '').slice(0, 160))}${(p.body || '').length > 160 ? '…' : ''}</div>
    </div>
  `).join('') || '<div class="placeholder-note">No posts yet. Be the first to say something.</div>';

  mainView.innerHTML = `
    <form class="composer" id="postComposer">
      <input type="text" id="postTitle" placeholder="Title" required>
      <textarea id="postBody" placeholder="What's on your mind?" required></textarea>
      <button type="submit" class="composer-submit">Post</button>
    </form>
    <div class="post-list">${postListHtml}</div>
  `;

  document.getElementById('postComposer').addEventListener('submit', async e => {
    e.preventDefault();
    const title = document.getElementById('postTitle').value.trim();
    const body = document.getElementById('postBody').value.trim();
    if (!title || !body) return;
    await apiFetch('/api/posts', { method: 'POST', body: { board_id: board.id, title, body } });
    renderBoardView(mainView, slug);
  });

  mainView.querySelectorAll('.post-card').forEach(card => {
    card.addEventListener('click', () => { window.location.hash = `#/post/${card.dataset.postId}`; });
  });
}

// ── Thread view: single post + replies ─────────────────────────────────
async function renderThreadView(mainView, postId) {
  mainView.innerHTML = `<div class="placeholder-note">Loading…</div>`;

  let post, replies;
  try {
    ({ post, replies } = await apiFetch(`/api/posts/${postId}`));
  } catch (e) {
    mainView.innerHTML = `<h2>Not found</h2><div class="placeholder-note">That post doesn't exist.</div>`;
    return;
  }

  const board = boards.find(b => b.id === post.board_id);
  const canModerate = isModerator();
  const isAuthor = post.author_id === profile.id;

  const postActions = (isAuthor || canModerate) ? `
    <div class="post-actions">
      ${canModerate ? `<button class="action-btn" id="pinBtn">${post.pinned ? 'Unpin' : 'Pin'}</button>` : ''}
      <button class="action-btn danger" id="deletePostBtn">Delete</button>
    </div>` : '';

  const replyListHtml = (replies || []).map(r => `
    <div class="reply-card" data-reply-id="${r.id}">
      <div class="post-meta">${escapeHtml(r.author?.display_name || 'unknown')} ${authorBadge(r.author)} · ${timeAgo(r.created_at)}</div>
      <div class="reply-body">${escapeHtml(r.body)}</div>
      ${(r.author_id === profile.id || canModerate) ? `<div class="post-actions"><button class="action-btn danger" data-delete-reply="${r.id}">Delete</button></div>` : ''}
    </div>
  `).join('');

  mainView.innerHTML = `
    <a class="thread-back" href="#/${board ? board.slug : 'guild-hall'}">&larr; Back to ${escapeHtml(board ? board.name : 'Guild Hall')}</a>
    <div class="thread-post">
      <div class="post-title-row">
        ${post.pinned ? '<span class="pin-flag">📌</span>' : ''}
        <span class="post-title">${escapeHtml(post.title || '(untitled)')}</span>
      </div>
      <div class="post-meta">${escapeHtml(post.author?.display_name || 'unknown')} ${authorBadge(post.author)} · ${timeAgo(post.created_at)}</div>
      <div class="thread-post-body">${escapeHtml(post.body)}</div>
      ${postActions}
    </div>
    <div class="reply-list">${replyListHtml}</div>
    <form class="composer" id="replyComposer">
      <textarea id="replyBody" placeholder="Write a reply…" required></textarea>
      <button type="submit" class="composer-submit">Reply</button>
    </form>
  `;

  document.getElementById('replyComposer').addEventListener('submit', async e => {
    e.preventDefault();
    const body = document.getElementById('replyBody').value.trim();
    if (!body) return;
    await apiFetch('/api/posts', { method: 'POST', body: { board_id: post.board_id, parent_id: postId, body } });
    renderThreadView(mainView, postId);
  });

  const pinBtn = document.getElementById('pinBtn');
  if (pinBtn) pinBtn.addEventListener('click', async () => {
    await apiFetch(`/api/posts/${postId}`, { method: 'PATCH', body: { pinned: !post.pinned } });
    renderThreadView(mainView, postId);
  });

  const deletePostBtn = document.getElementById('deletePostBtn');
  if (deletePostBtn) deletePostBtn.addEventListener('click', async () => {
    if (!confirm('Delete this post and all its replies?')) return;
    await apiFetch(`/api/posts/${postId}`, { method: 'DELETE' });
    window.location.hash = `#/${board ? board.slug : 'guild-hall'}`;
  });

  mainView.querySelectorAll('[data-delete-reply]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this reply?')) return;
      await apiFetch(`/api/posts/${btn.dataset.deleteReply}`, { method: 'DELETE' });
      renderThreadView(mainView, postId);
    });
  });
}

// ── Direct messages ──────────────────────────────────────────────────
let dmPollInterval = null;
let dmPollConvId = null;
let dmSeenIds = new Set();
function stopDMPolling() {
  if (dmPollInterval) { clearInterval(dmPollInterval); dmPollInterval = null; }
  dmPollConvId = null;
  dmSeenIds = new Set();
}

async function renderDMListView(mainView) {
  mainView.innerHTML = `<h2>Messages</h2><div class="placeholder-note">Loading…</div>`;

  const { conversations } = await apiFetch('/api/dm/conversations');

  const listHtml = (conversations || []).length ? conversations.map(c => `
    <div class="post-card" data-conv-id="${c.conversation_id}">
      <div class="post-title">${escapeHtml(c.other?.display_name || 'Unknown')}</div>
      <div class="post-snippet">${c.last ? escapeHtml(c.last.body.slice(0, 120)) : 'No messages yet.'}</div>
    </div>
  `).join('') : '<div class="placeholder-note">No conversations yet. Start one below.</div>';

  mainView.innerHTML = `
    <h2>Messages</h2>
    <button class="composer-submit" id="newDmBtn" style="margin-bottom:1.5rem;">New Message</button>
    <div id="memberPicker"></div>
    <div class="post-list">${listHtml}</div>
  `;

  mainView.querySelectorAll('[data-conv-id]').forEach(card => {
    card.addEventListener('click', () => { window.location.hash = `#/dm/${card.dataset.convId}`; });
  });

  document.getElementById('newDmBtn').addEventListener('click', () => renderMemberPicker());
}

async function renderMemberPicker() {
  const picker = document.getElementById('memberPicker');
  if (!picker) return;

  const { members } = await apiFetch('/api/members/search');
  const allMembers = members || [];

  picker.innerHTML = `
    <h3 style="font-family:'Playfair Display',serif;font-style:italic;color:var(--gold-bright);margin-bottom:0.75rem;">Message someone</h3>
    <div class="member-filters">
      <input type="text" id="memberSearch" placeholder="Search by name…">
      <select id="memberChapterFilter">
        <option value="">All chapters</option>
        ${chapters.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
      </select>
      <select id="memberRankFilter">
        <option value="">All ranks</option>
        ${RANKS.map(r => `<option value="${r}">${rankLabel(r)}</option>`).join('')}
      </select>
    </div>
    <div class="post-list" id="memberResults" style="margin-bottom:1.75rem;"></div>
  `;

  function renderResults() {
    const q = document.getElementById('memberSearch').value.trim().toLowerCase();
    const chapterId = document.getElementById('memberChapterFilter').value;
    const rank = document.getElementById('memberRankFilter').value;
    const filtered = allMembers.filter(m => {
      if (q && !m.display_name.toLowerCase().includes(q)) return false;
      if (chapterId && m.home_chapter_id !== chapterId) return false;
      if (rank && m.rank !== rank) return false;
      return true;
    });
    const resultsEl = document.getElementById('memberResults');
    resultsEl.innerHTML = filtered.length ? filtered.map(m => `
      <div class="post-card" data-user-id="${m.id}">
        <div class="post-title">${escapeHtml(m.display_name)}</div>
        <div class="post-meta">${authorBadge(m)}${m.home_chapter ? ' · ' + escapeHtml(m.home_chapter.name) : ''}</div>
      </div>
    `).join('') : '<div class="placeholder-note">No members match.</div>';
    resultsEl.querySelectorAll('[data-user-id]').forEach(card => {
      card.addEventListener('click', () => startOrOpenConversation(card.dataset.userId));
    });
  }

  document.getElementById('memberSearch').addEventListener('input', renderResults);
  document.getElementById('memberChapterFilter').addEventListener('change', renderResults);
  document.getElementById('memberRankFilter').addEventListener('change', renderResults);
  renderResults();
}

async function startOrOpenConversation(otherUserId) {
  const { conversation_id } = await apiFetch('/api/dm/conversations', { method: 'POST', body: { other_user_id: otherUserId } });
  window.location.hash = `#/dm/${conversation_id}`;
}

function dmBubbleHtml(m) {
  const mine = m.sender_id === profile.id;
  return `<div class="dm-bubble-row ${mine ? 'mine' : ''}"><div class="dm-bubble ${mine ? 'mine' : ''}">${escapeHtml(m.body)}</div></div>`;
}

function appendDMMessage(message) {
  const threadEl = document.getElementById('dmThread');
  if (!threadEl) return;
  threadEl.insertAdjacentHTML('beforeend', dmBubbleHtml(message));
  threadEl.scrollTop = threadEl.scrollHeight;
}

async function renderDMThreadView(mainView, convId) {
  mainView.innerHTML = `<div class="placeholder-note">Loading…</div>`;

  const { other, messages } = await apiFetch(`/api/dm/${convId}/messages`);
  dmSeenIds = new Set((messages || []).map(m => m.id));

  mainView.innerHTML = `
    <a class="thread-back" href="#/dm">&larr; Back to Messages</a>
    <h2>${escapeHtml(other?.display_name || 'Direct Message')}</h2>
    <div class="dm-thread" id="dmThread">${(messages || []).map(dmBubbleHtml).join('')}</div>
    <form class="composer" id="dmComposer">
      <textarea id="dmBody" placeholder="Write a message…" required></textarea>
      <button type="submit" class="composer-submit">Send</button>
    </form>
  `;
  const threadEl = document.getElementById('dmThread');
  threadEl.scrollTop = threadEl.scrollHeight;

  document.getElementById('dmComposer').addEventListener('submit', async e => {
    e.preventDefault();
    const bodyInput = document.getElementById('dmBody');
    const text = bodyInput.value.trim();
    if (!text) return;
    bodyInput.value = '';
    appendDMMessage({ sender_id: profile.id, body: text });
    const { id } = await apiFetch(`/api/dm/${convId}/messages`, { method: 'POST', body: { body: text } });
    dmSeenIds.add(id);
  });

  // Realtime is gone with Supabase — poll for new messages while this thread
  // is open instead. Only render incoming messages we haven't seen (covers
  // both the other participant's messages and our own optimistic-appended one).
  dmPollConvId = convId;
  dmPollInterval = setInterval(async () => {
    if (dmPollConvId !== convId) return;
    try {
      const { messages: fresh } = await apiFetch(`/api/dm/${convId}/messages`);
      (fresh || []).forEach(m => {
        if (dmSeenIds.has(m.id)) return;
        dmSeenIds.add(m.id);
        if (m.sender_id !== profile.id) appendDMMessage(m);
      });
    } catch (e) { /* transient — try again next tick */ }
  }, 4000);
}

// ── Events ───────────────────────────────────────────────────────────
function formatEventDate(iso) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

// datetime-local inputs want "YYYY-MM-DDTHH:mm" in local time, no timezone.
function toDatetimeLocalValue(iso) {
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function renderEventsView(mainView) {
  mainView.innerHTML = `<h2>Events</h2><div class="placeholder-note">Loading…</div>`;

  const { events } = await apiFetch('/api/events');
  const canManage = isModerator();
  const canEdit = !!profile?.is_ringleader;

  const composerHtml = canManage ? `
    <form class="composer" id="eventComposer">
      <input type="text" id="eventTitle" placeholder="Title" required>
      <select id="eventChapter">
        <option value="">Guild-wide</option>
        ${chapters.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
      </select>
      <input type="datetime-local" id="eventStarts" required>
      <input type="text" id="eventLocation" placeholder="Location">
      <textarea id="eventDescription" placeholder="Details"></textarea>
      <button type="submit" class="composer-submit">Add Event</button>
    </form>
  ` : '';

  const listHtml = (events || []).length ? events.map(e => `
    <div class="post-card" style="cursor:default;">
      <div class="post-title">${escapeHtml(e.title)}</div>
      <div class="post-meta">${formatEventDate(e.starts_at)} · ${escapeHtml(e.chapter ? e.chapter.name : 'Guild-wide')}${e.location ? ' · ' + escapeHtml(e.location) : ''}</div>
      ${e.description ? `<div class="post-snippet">${escapeHtml(e.description)}</div>` : ''}
      ${canManage || canEdit ? `<div class="post-actions">
        ${canEdit ? `<button class="action-btn" data-edit-event="${e.id}">Edit</button>` : ''}
        ${canManage && CREW_ASSIGNMENT_ENABLED ? `<button class="action-btn" data-manage-crew="${e.id}">Manage Crew</button>` : ''}
        ${canManage ? `<button class="action-btn danger" data-delete-event="${e.id}">Delete</button>` : ''}
      </div>` : ''}
      ${canManage && CREW_ASSIGNMENT_ENABLED ? `<div class="crew-editor" id="crewEditor-${e.id}"></div>` : ''}
    </div>
  `).join('') : '<div class="placeholder-note">Nothing scheduled yet.</div>';

  mainView.innerHTML = `
    <h2>Events</h2>${composerHtml}<div class="post-list">${listHtml}</div>
    <div class="archive-toggle-row"><button class="gm-btn" id="toggleArchivedBtn" style="background:var(--surface);color:var(--cream);">Show Past Events</button></div>
    <div id="archivedEvents"></div>
  `;

  if (canManage) {
    document.getElementById('eventComposer').addEventListener('submit', async e => {
      e.preventDefault();
      const title = document.getElementById('eventTitle').value.trim();
      const chapterId = document.getElementById('eventChapter').value || null;
      const startsAt = document.getElementById('eventStarts').value;
      const location = document.getElementById('eventLocation').value.trim();
      const description = document.getElementById('eventDescription').value.trim();
      if (!title || !startsAt) return;
      await apiFetch('/api/events', {
        method: 'POST',
        body: { title, chapter_id: chapterId, starts_at: new Date(startsAt).toISOString(), location: location || null, description: description || null },
      });
      renderEventsView(mainView);
    });
  }

  mainView.querySelectorAll('[data-delete-event]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this event?')) return;
      await apiFetch(`/api/events/${btn.dataset.deleteEvent}`, { method: 'DELETE' });
      renderEventsView(mainView);
    });
  });

  mainView.querySelectorAll('[data-edit-event]').forEach(btn => {
    btn.addEventListener('click', () => {
      const evt = (events || []).find(e => e.id === btn.dataset.editEvent);
      if (evt) openEventEditModal(mainView, evt);
    });
  });

  mainView.querySelectorAll('[data-manage-crew]').forEach(btn => {
    btn.addEventListener('click', () => toggleCrewEditor(btn.dataset.manageCrew));
  });

  async function loadArchivedEvents() {
    const el = document.getElementById('archivedEvents');
    el.innerHTML = '<div class="placeholder-note">Loading…</div>';
    const { events: archived } = await apiFetch('/api/events?scope=archived');
    el.innerHTML = (archived || []).length ? `<div class="post-list">${archived.map(e => `
      <div class="post-card archived-event" style="cursor:default;">
        <div class="post-title">${escapeHtml(e.title)}</div>
        <div class="post-meta">${formatEventDate(e.starts_at)} · ${escapeHtml(e.chapter ? e.chapter.name : 'Guild-wide')}${e.location ? ' · ' + escapeHtml(e.location) : ''}</div>
        ${e.description ? `<div class="post-snippet">${escapeHtml(e.description)}</div>` : ''}
        ${canManage || canEdit ? `<div class="post-actions">
          ${canEdit ? `<button class="action-btn" data-edit-archived="${e.id}">Edit</button>` : ''}
          ${canManage ? `<button class="action-btn danger" data-delete-archived="${e.id}">Delete</button>` : ''}
        </div>` : ''}
      </div>
    `).join('')}</div>` : '<div class="placeholder-note">No past events yet.</div>';
    el.querySelectorAll('[data-delete-archived]').forEach(delBtn => {
      delBtn.addEventListener('click', async () => {
        if (!confirm('Delete this event?')) return;
        await apiFetch(`/api/events/${delBtn.dataset.deleteArchived}`, { method: 'DELETE' });
        delBtn.closest('.archived-event').remove();
      });
    });
    el.querySelectorAll('[data-edit-archived]').forEach(editBtn => {
      editBtn.addEventListener('click', () => {
        const evt = (archived || []).find(ev => ev.id === editBtn.dataset.editArchived);
        if (evt) openEventEditModal(mainView, evt, loadArchivedEvents);
      });
    });
  }

  document.getElementById('toggleArchivedBtn').addEventListener('click', async btnEvent => {
    const btn = btnEvent.currentTarget;
    const el = document.getElementById('archivedEvents');
    if (el.classList.contains('open')) { el.classList.remove('open'); el.innerHTML = ''; btn.textContent = 'Show Past Events'; return; }
    el.classList.add('open');
    btn.textContent = 'Hide Past Events';
    await loadArchivedEvents();
  });
}

function openEventEditModal(mainView, evt, onSaved) {
  const overlay = document.createElement('div');
  overlay.className = 'admin-edit-overlay open';
  overlay.innerHTML = `
    <div class="admin-edit-modal">
      <div class="admin-edit-modal-header">
        <h3>Edit Event</h3>
        <button id="eeClose">&times;</button>
      </div>
      <div class="admin-edit-modal-body">
        <div class="field-row"><label>Title</label><input type="text" id="eeTitle" value="${escapeHtml(evt.title)}"></div>
        <div class="field-row"><label>Chapter</label>
          <select id="eeChapter">
            <option value="">Guild-wide</option>
            ${chapters.map(c => `<option value="${c.id}" ${evt.chapter_id === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field-row"><label>Starts</label><input type="datetime-local" id="eeStarts" value="${toDatetimeLocalValue(evt.starts_at)}"></div>
        <div class="field-row"><label>Location</label><input type="text" id="eeLocation" value="${escapeHtml(evt.location || '')}"></div>
        <div class="field-row"><label>Details</label><textarea id="eeDescription">${escapeHtml(evt.description || '')}</textarea></div>
      </div>
      <div class="admin-edit-modal-footer">
        <button class="composer-submit" id="eeSaveBtn">Save</button>
        <button class="gm-btn" id="eeCancelBtn" style="background:var(--surface);color:var(--cream);">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('#eeClose').addEventListener('click', close);
  overlay.querySelector('#eeCancelBtn').addEventListener('click', close);
  overlay.querySelector('#eeSaveBtn').addEventListener('click', async () => {
    const title = overlay.querySelector('#eeTitle').value.trim();
    const startsAt = overlay.querySelector('#eeStarts').value;
    if (!title || !startsAt) { alert('Title and start time are required.'); return; }
    const body = {
      title,
      chapter_id: overlay.querySelector('#eeChapter').value || null,
      starts_at: new Date(startsAt).toISOString(),
      location: overlay.querySelector('#eeLocation').value.trim() || null,
      description: overlay.querySelector('#eeDescription').value.trim() || null,
    };
    try {
      await apiFetch(`/api/events/${evt.id}`, { method: 'PATCH', body });
    } catch (e) {
      alert(`Couldn't save: ${e.message}`);
      return;
    }
    close();
    if (onSaved) onSaved(); else renderEventsView(mainView);
  });
}

async function toggleCrewEditor(eventId) {
  const el = document.getElementById(`crewEditor-${eventId}`);
  if (el.classList.contains('open')) { el.classList.remove('open'); el.innerHTML = ''; return; }
  el.classList.add('open');
  el.innerHTML = '<div class="placeholder-note">Loading crew…</div>';
  await renderCrewEditor(eventId);
}

async function renderCrewEditor(eventId) {
  const el = document.getElementById(`crewEditor-${eventId}`);
  const { crew } = await apiFetch(`/api/events/${eventId}/crew`);
  el.innerHTML = `
    <div class="crew-roster">
      ${(crew || []).length ? crew.map(m => `
        <span class="crew-chip">${escapeHtml(m.display_name)}<button class="crew-chip-remove" data-remove-crew="${m.id}" title="Remove from crew">&times;</button></span>
      `).join('') : '<span class="placeholder-note" style="border:none;padding:0;">No crew yet.</span>'}
    </div>
    <div class="crew-add-row">
      <input type="text" class="crew-add-search" placeholder="Search members to add…">
      <div class="crew-add-results"></div>
    </div>
  `;
  el.querySelectorAll('[data-remove-crew]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await apiFetch(`/api/events/${eventId}/crew/${btn.dataset.removeCrew}`, { method: 'DELETE' });
      renderCrewEditor(eventId);
    });
  });
  const searchInput = el.querySelector('.crew-add-search');
  const resultsEl = el.querySelector('.crew-add-results');
  const crewIds = new Set((crew || []).map(m => m.id));
  searchInput.addEventListener('input', debounce(async () => {
    const q = searchInput.value.trim();
    if (!q) { resultsEl.innerHTML = ''; return; }
    const { members } = await apiFetch(`/api/members/search?q=${encodeURIComponent(q)}`);
    const candidates = (members || []).filter(m => !crewIds.has(m.id));
    resultsEl.innerHTML = candidates.length ? candidates.map(m => `
      <div class="crew-add-result" data-add-crew="${m.id}">${escapeHtml(m.display_name)} <span class="crew-add-result-rank">${escapeHtml(m.is_ringleader ? 'Ringleader' : m.rank)}</span></div>
    `).join('') : '<div class="placeholder-note" style="border:none;padding:0;">No matches.</div>';
    resultsEl.querySelectorAll('[data-add-crew]').forEach(row => {
      row.addEventListener('click', async () => {
        await apiFetch(`/api/events/${eventId}/crew`, { method: 'POST', body: { user_id: row.dataset.addCrew } });
        searchInput.value = '';
        renderCrewEditor(eventId);
      });
    });
  }, 250));
}

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// ── Ringleader hub: manage every member's rank/permissions/dues ────────
// Standing order high-to-low: Ringleader, Master, Journeyman, Apprentice, Clown.
// Ringleader is a separate flag rather than a rank value, so it's weighted in
// ahead of rank when sorting "by rank" -- a Ringleader outranks a non-Ringleader
// Master regardless of their underlying rank.
const RANK_ORDER = { master: 2, journeyman: 1, apprentice: 0, clown: -1 };
function memberWeight(m) {
  return (m.is_ringleader ? 10 : 0) + RANK_ORDER[m.rank];
}
const ADMIN_SORTS = {
  name: { label: 'Name', cmp: (a, b) => a.display_name.localeCompare(b.display_name) },
  rank: { label: 'Rank', cmp: (a, b) => memberWeight(b) - memberWeight(a) || a.display_name.localeCompare(b.display_name) },
  chapter: { label: 'Chapter', cmp: (a, b) => (a.home_chapter?.name || '￿').localeCompare(b.home_chapter?.name || '￿') || a.display_name.localeCompare(b.display_name) },
  dues: { label: 'Dues status', cmp: (a, b) => (b.dues_paid - a.dues_paid) || a.display_name.localeCompare(b.display_name) },
};
const STEWARD_ROLES = [
  ['founder_steward', 'Founder Steward'],
  ['systems_steward', 'Systems Steward'],
  ['participation_steward', 'Participation Steward'],
  ['archive_steward', 'Archive Steward'],
  ['place_living_steward', 'Place/Living Steward'],
  ['temporal_steward', 'Temporal Steward'],
  ['operations_finance_steward', 'Operations & Finance Steward'],
  ['carnival_director', 'Carnival Director'],
];
let adminSortKey = 'name';
let adminSearchQuery = '';
let adminMembersCache = [];

async function renderAdminView(mainView) {
  if (!profile?.is_ringleader) {
    mainView.innerHTML = `<h2>Not authorized</h2><div class="placeholder-note">Ringleaders only.</div>`;
    return;
  }
  mainView.innerHTML = `<h2>Members Hub</h2><div class="placeholder-note">Loading…</div>`;

  const { members } = await apiFetch('/api/members');
  adminMembersCache = members || [];

  mainView.innerHTML = `
    <h2>Members Hub</h2>
    <p class="admin-note">Every member of the guild. Changes save immediately.</p>
    <div class="admin-toolbar">
      <input type="text" id="adminSearchInput" class="admin-search" placeholder="Search members…" value="${escapeHtml(adminSearchQuery)}">
      <label class="admin-sort-control">Sort by
        <select id="adminSortSelect">
          ${Object.entries(ADMIN_SORTS).map(([key, s]) => `<option value="${key}" ${key === adminSortKey ? 'selected' : ''}>${s.label}</option>`).join('')}
        </select>
      </label>
      <button class="gm-btn" id="newMemberToggleBtn" style="background:var(--surface);color:var(--cream);">+ Add Member</button>
    </div>
    <div class="card new-project-form" id="newMemberForm">
      <div class="field-row"><label>Name</label><input type="text" id="nmName" placeholder="e.g. Amelia"></div>
      <div class="field-row"><label>Home Chapter</label>
        <select id="nmChapter">
          <option value="">No chapter</option>
          ${chapters.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
        </select>
      </div>
      <p class="quickpick-fallback">No email or password needed — they sign in with the one-click name picker.</p>
      <div class="form-actions">
        <button class="composer-submit" id="nmCreateBtn">Add</button>
        <button class="gm-btn" id="nmCancelBtn" style="background:var(--surface);color:var(--cream);">Cancel</button>
      </div>
    </div>
    <div class="admin-list" id="adminList"></div>
  `;

  document.getElementById('adminSortSelect').addEventListener('change', e => {
    adminSortKey = e.target.value;
    renderAdminRows(mainView);
  });

  document.getElementById('adminSearchInput').addEventListener('input', e => {
    adminSearchQuery = e.target.value;
    renderAdminRows(mainView);
  });

  document.getElementById('newMemberToggleBtn').addEventListener('click', () => document.getElementById('newMemberForm').classList.toggle('open'));
  document.getElementById('nmCancelBtn').addEventListener('click', () => document.getElementById('newMemberForm').classList.remove('open'));
  document.getElementById('nmCreateBtn').addEventListener('click', async () => {
    const display_name = document.getElementById('nmName').value.trim();
    if (!display_name) return;
    await apiFetch('/api/members', {
      method: 'POST',
      body: { display_name, home_chapter_id: document.getElementById('nmChapter').value || null },
    });
    renderAdminView(mainView);
  });

  renderAdminRows(mainView);
}

function renderAdminRows(mainView) {
  const list = document.getElementById('adminList');
  if (!list) return;

  const q = adminSearchQuery.trim().toLowerCase();
  const filtered = adminMembersCache.filter(m =>
    !q || m.display_name.toLowerCase().includes(q) || (m.home_chapter?.name || '').toLowerCase().includes(q)
  );
  const sorted = [...filtered].sort(ADMIN_SORTS[adminSortKey].cmp);

  list.innerHTML = sorted.map(m => `
    <div class="admin-row" data-user-id="${m.id}" style="border-left-color: ${rankColor(m.rank)};">
      <div class="admin-identity">
        <div class="admin-name">${escapeHtml(m.display_name)}</div>
        <div class="admin-chapter">${m.home_chapter ? escapeHtml(m.home_chapter.name) : 'No chapter'}</div>
      </div>
      <select class="admin-rank" data-field="rank" style="color: ${rankColor(m.rank)};">
        ${RANKS.map(r =>
          `<option value="${r}" ${m.rank === r ? 'selected' : ''}>${rankLabel(r)}</option>`
        ).join('')}
      </select>
      <label class="admin-ringleader-toggle">
        <input type="checkbox" data-field="is_ringleader" ${m.is_ringleader ? 'checked' : ''}>
        Ringleader
      </label>
      <label class="admin-ringleader-toggle">
        <input type="checkbox" data-field="dues_paid" ${m.dues_paid ? 'checked' : ''}>
        Dues Paid
      </label>
      <input type="text" class="admin-dues-amount" data-field="dues_amount" placeholder="Amount" value="${escapeHtml(m.dues_amount || '')}">
      <input type="date" class="admin-dues-date" data-field="dues_date" value="${escapeHtml(m.dues_date || '')}">
      <button class="gm-btn admin-edit-btn" data-edit="${m.id}" style="background:var(--surface-2);color:var(--gold-bright);">Edit</button>
    </div>
  `).join('') || '<div class="placeholder-note">No members match.</div>';

  list.querySelectorAll('.admin-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => openAdminEditModal(mainView, btn.dataset.edit));
  });

  list.querySelectorAll('.admin-row').forEach(row => {
    const userId = row.dataset.userId;
    const member = adminMembersCache.find(m => m.id === userId);

    const patchField = async (field, value) => {
      try {
        await apiFetch(`/api/members/${userId}`, { method: 'PATCH', body: { [field]: value } });
      } catch (e) {
        alert(`Couldn't save: ${e.message}`);
        renderAdminRows(mainView);
        return;
      }
      member[field] = value;
      if (userId === profile.id && (field === 'rank' || field === 'is_ringleader')) { await refreshProfile(); renderShell(); }
      if (field === 'rank') {
        row.style.borderLeftColor = rankColor(value);
        row.querySelector('[data-field="rank"]').style.color = rankColor(value);
      }
      const affectsSort = (adminSortKey === 'rank' && (field === 'rank' || field === 'is_ringleader')) || (adminSortKey === 'dues' && field === 'dues_paid');
      if (affectsSort) renderAdminRows(mainView);
    };

    row.querySelector('[data-field="rank"]').addEventListener('change', e => patchField('rank', e.target.value));
    row.querySelector('[data-field="is_ringleader"]').addEventListener('change', e => patchField('is_ringleader', e.target.checked));
    row.querySelector('[data-field="dues_paid"]').addEventListener('change', e => patchField('dues_paid', e.target.checked));
    row.querySelector('[data-field="dues_amount"]').addEventListener('change', e => patchField('dues_amount', e.target.value));
    row.querySelector('[data-field="dues_date"]').addEventListener('change', e => patchField('dues_date', e.target.value));
  });
}

function openAdminEditModal(mainView, userId) {
  const member = adminMembersCache.find(m => m.id === userId);
  if (!member) return;

  const overlay = document.createElement('div');
  overlay.className = 'admin-edit-overlay open';
  overlay.innerHTML = `
    <div class="admin-edit-modal">
      <div class="admin-edit-modal-header">
        <h3>Edit ${escapeHtml(member.display_name)}</h3>
        <button id="adminEditClose">&times;</button>
      </div>
      <div class="admin-edit-modal-body">
        <div class="field-row"><label>Name</label><input type="text" id="aeName" value="${escapeHtml(member.display_name)}"></div>
        <div class="field-row"><label>Home Chapter</label>
          <select id="aeChapter">
            <option value="">No chapter</option>
            ${chapters.map(c => `<option value="${c.id}" ${member.home_chapter_id === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field-row"><label>Steward Role</label>
          <select id="aeSteward">
            <option value="">None</option>
            ${STEWARD_ROLES.map(([v, label]) => `<option value="${v}" ${member.steward_role === v ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </div>
        <div class="field-row"><label>Birthday</label><input type="date" id="aeBirthday" value="${escapeHtml(member.birthday || '')}"></div>
        <div class="field-row"><label>Skills</label><input type="text" id="aeSkills" placeholder="e.g. rigging, sound, first aid" value="${escapeHtml(member.skills || '')}"></div>
      </div>
      <div class="admin-edit-modal-footer">
        <button class="composer-submit" id="aeSaveBtn">Save</button>
        <button class="gm-btn" id="aeCancelBtn" style="background:var(--surface);color:var(--cream);">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('#adminEditClose').addEventListener('click', close);
  overlay.querySelector('#aeCancelBtn').addEventListener('click', close);
  overlay.querySelector('#aeSaveBtn').addEventListener('click', async () => {
    const display_name = overlay.querySelector('#aeName').value.trim();
    if (!display_name) { alert('Name is required.'); return; }
    const body = {
      display_name,
      home_chapter_id: overlay.querySelector('#aeChapter').value || null,
      steward_role: overlay.querySelector('#aeSteward').value || null,
      birthday: overlay.querySelector('#aeBirthday').value || null,
      skills: overlay.querySelector('#aeSkills').value.trim() || null,
    };
    try {
      await apiFetch(`/api/members/${userId}`, { method: 'PATCH', body });
    } catch (e) {
      alert(`Couldn't save: ${e.message}`);
      return;
    }
    Object.assign(member, body);
    member.home_chapter = body.home_chapter_id ? { name: chapters.find(c => c.id === body.home_chapter_id)?.name } : null;
    if (userId === profile.id) { await refreshProfile(); renderShell(); }
    close();
    renderAdminRows(mainView);
  });
}

// ── Guild Map: private relational field ─────────────────────────────────
// Full port of a friend's standalone relationship-mapping tool, retrofitted:
// no preset people, no preset communities/bond-types (define your own via
// Settings — the original's romantic/kink defaults are gone entirely).
// Backend-persisted (one field_data row per user) instead of localStorage;
// privacy is enforced server-side by session user id, not just Ringleader role.
const FIELD_RING_RADII = { 1: 110, 2: 210, 3: 320, 4: 420 };
const FIELD_STATUS_PRESETS = [
  { label: 'current', statuses: ['current'] },
  { label: '+ recent', statuses: ['current', 'recent'] },
  { label: '+ past', statuses: ['current', 'past'] },
  { label: 'all time', statuses: ['current', 'recent', 'past'] },
];

let fCenterName = '', fCommunities = [], fReltypes = [], fPeople = [], fConnections = [], fLayouts = {};
let fActiveFilters = new Set(), fActiveStatuses = new Set(['current']);
let fSearchQuery = '', fSelectedId = null, fEditingId = null, fActiveSettingsTab = 'communities';
let fLinksG = null, fNodesG = null;

async function saveFieldData() {
  await apiFetch('/api/field', { method: 'PUT', body: { center_name: fCenterName, communities: fCommunities, reltypes: fReltypes, people: fPeople, connections: fConnections } });
}
async function saveFieldLayouts() {
  await apiFetch('/api/field', { method: 'PUT', body: { layouts: fLayouts } });
}
function fCommColor(id) { return (fCommunities.find(c => c.id === id) || { color: '#90A4AE' }).color; }
function fRtColor(id) { return (fReltypes.find(r => r.id === id) || { color: '#74B9FF' }).color; }

function fSeedPositions(pList) {
  const groups = {};
  pList.forEach(p => { if (p.x !== undefined && p.y !== undefined) return; const k = `${p.community}|${p.intimacy}`; (groups[k] = groups[k] || []).push(p); });
  const commIds = fCommunities.map(c => c.id);
  const commAngle = {};
  commIds.forEach((id, i) => { commAngle[id] = (2 * Math.PI * i / Math.max(commIds.length, 1)) - Math.PI / 2; });
  Object.entries(groups).forEach(([key, members]) => {
    const [comm, lvStr] = key.split('|');
    const lv = parseInt(lvStr) || 3;
    const r = FIELD_RING_RADII[lv] || 320;
    const ca = commAngle[comm] ?? (Math.random() * Math.PI * 2);
    const spread = Math.min(Math.PI * 0.3, members.length * 0.2);
    members.forEach((p, i) => {
      const t = members.length === 1 ? 0.5 : i / (members.length - 1);
      const angle = ca - spread / 2 + t * spread;
      p.x = r * Math.cos(angle);
      p.y = r * Math.sin(angle);
    });
  });
}

async function renderFieldView(mainView) {
  if (!profile?.is_ringleader) {
    mainView.innerHTML = `<h2>Not authorized</h2><div class="placeholder-note">Ringleaders only.</div>`;
    return;
  }
  mainView.innerHTML = `
    <div class="gm-shell">
      <div class="gm-topbar">
        <input id="gmSearch" class="gm-search" type="text" placeholder="search…" autocomplete="off">
        <div id="gmFilters" class="gm-filters"></div>
        <div class="gm-sep"></div>
        <div id="gmStatusFilters" class="gm-filters"></div>
        <div class="gm-topbar-right">
          <div style="position:relative;">
            <button class="gm-btn" id="gmSaveLayoutBtn">⊕ Save Layout</button>
            <div id="gmSavePopover" class="gm-popover">
              <input id="gmLayoutNameInput" type="text" placeholder="Name this layout…" maxlength="40">
              <button id="gmLayoutNameConfirm" class="gm-btn">Save</button>
            </div>
          </div>
          <div style="position:relative;">
            <button class="gm-btn" id="gmLoadLayoutBtn">↺ Layouts</button>
            <div id="gmLayoutDropdown" class="gm-dropdown"></div>
          </div>
          <button class="gm-btn" id="gmSettingsBtn">⚙ Settings</button>
          <button class="gm-btn gm-accent" id="gmAddBtn">+ Add Person</button>
        </div>
      </div>
      <div class="gm-body">
        <svg id="gmSvg"></svg>
        <div class="gm-legend" id="gmLegend"></div>
        <div class="gm-stats" id="gmStats"></div>
        <div class="gm-panel" id="gmPanel">
          <div class="gm-panel-header">
            <div class="gm-panel-dot" id="gmPanelDot"></div>
            <div id="gmPanelName" class="gm-panel-name"></div>
            <button class="gm-panel-close" id="gmPanelClose">&times;</button>
          </div>
          <div class="gm-panel-body" id="gmPanelBody"></div>
          <div class="gm-panel-footer">
            <button class="gm-btn" id="gmPanelEditBtn">Edit</button>
            <button class="gm-btn gm-danger" id="gmPanelDeleteBtn">Remove</button>
          </div>
        </div>
        <div class="gm-settings" id="gmSettings">
          <button class="gm-panel-close" id="gmSettingsClose">&times;</button>
          <h2>Settings</h2>
          <div class="gm-settings-tabs" id="gmSettingsTabs"></div>
          <div class="gm-settings-body" id="gmSettingsBody"></div>
        </div>
      </div>
    </div>
    <div class="gm-overlay" id="gmPersonOverlay">
      <div class="gm-modal">
        <div class="gm-modal-header"><h3 id="gmPersonModalTitle">Add Person</h3><button id="gmPersonModalClose">&times;</button></div>
        <div class="gm-modal-body">
          <div class="gm-form-grid">
            <div class="gm-form-group gm-full"><label>Name</label><input id="gmFName" type="text" placeholder="Their name…"></div>
            <div class="gm-form-group"><label>Community</label><select id="gmFCommunity"></select></div>
            <div class="gm-form-group"><label>Closeness</label>
              <select id="gmFIntimacy">
                <option value="1">Core — innermost</option>
                <option value="2">Close</option>
                <option value="3" selected>Meaningful</option>
                <option value="4">Peripheral</option>
              </select>
            </div>
            <div class="gm-form-group"><label>Birthday</label><input id="gmFBirthday" type="date"></div>
            <div class="gm-form-group gm-full"><label>Notes</label><textarea id="gmFNotes" placeholder="Anything you want to remember…"></textarea></div>
            <div class="gm-form-group gm-full"><label>Topics / Tags (comma separated)</label><input id="gmFTopics" type="text" placeholder="e.g. sound, logistics, hospitality…"></div>
          </div>
        </div>
        <div class="gm-modal-footer">
          <button class="gm-btn" id="gmPersonCancel">Cancel</button>
          <button class="gm-btn gm-accent" id="gmPersonSave">Save</button>
        </div>
      </div>
    </div>
  `;

  const data = await apiFetch('/api/field');
  fCenterName = data.center_name || profile.display_name;
  fCommunities = data.communities || [];
  fReltypes = data.reltypes || [];
  fPeople = data.people || [];
  fConnections = data.connections || [];
  fLayouts = data.layouts || {};
  fActiveFilters = new Set();
  fActiveStatuses = new Set(['current']);
  fSearchQuery = '';
  fSelectedId = null;

  fSeedPositions(fPeople);

  const svgEl = document.getElementById('gmSvg');
  const W = svgEl.clientWidth || 900, H = svgEl.clientHeight || 600;
  const svg = d3.select('#gmSvg').attr('viewBox', `0 0 ${W} ${H}`);
  const centerG = svg.append('g').attr('transform', `translate(${W / 2},${H / 2})`);
  const zg = centerG.append('g');
  svg.call(d3.zoom().scaleExtent([0.15, 4]).on('zoom', e => zg.attr('transform', e.transform)));

  const ringsG = zg.append('g');
  fLinksG = zg.append('g');
  fNodesG = zg.append('g');
  Object.values(FIELD_RING_RADII).forEach(r => ringsG.append('circle').attr('class', 'gm-ring').attr('r', r));

  const centerNode = fNodesG.append('g');
  centerNode.append('circle').attr('r', 14).attr('fill', 'var(--gm-panel-bg)').attr('stroke', 'var(--gm-gold)').attr('stroke-width', 1.5);
  centerNode.append('text').attr('class', 'gm-center-label').attr('y', 26).text((fCenterName || 'You').slice(0, 14));

  svg.on('click', () => { closeFieldPanel(); document.getElementById('gmSavePopover').classList.remove('open'); document.getElementById('gmLayoutDropdown').classList.remove('open'); });

  fBuildFilters();
  fBuildStatusFilters();
  fBuildLegend();
  fRenderGraph();
  fWireControls();
}

function fGetFilteredPeople() {
  let list = fPeople.slice();
  if (fActiveFilters.size > 0) list = list.filter(p => fActiveFilters.has(p.community));
  if (fSearchQuery) {
    const q = fSearchQuery.toLowerCase();
    list = list.filter(p => p.name.toLowerCase().includes(q) || (p.notes || '').toLowerCase().includes(q) || (p.topics || []).join(' ').toLowerCase().includes(q));
  }
  return list;
}
function fGetVisibleConns(visibleIds) {
  return fConnections.filter(c => {
    if (!fActiveStatuses.has(c.status)) return false;
    const hf = c.from === '__center__' || visibleIds.has(c.from);
    const ht = c.to === '__center__' || visibleIds.has(c.to);
    return hf && ht;
  });
}

function fRenderGraph() {
  const filtered = fGetFilteredPeople();
  const visibleIds = new Set(filtered.map(p => p.id));
  const visibleConns = fGetVisibleConns(visibleIds);
  document.getElementById('gmStats').innerHTML = `<div>People<span>${fPeople.length}</span></div><div>Connections<span>${fConnections.length}</span></div>`;

  const linkData = visibleConns.map(c => {
    const fromP = c.from === '__center__' ? { x: 0, y: 0 } : (fPeople.find(p => p.id === c.from) || { x: 0, y: 0 });
    const toP = c.to === '__center__' ? { x: 0, y: 0 } : (fPeople.find(p => p.id === c.to) || { x: 0, y: 0 });
    return { ...c, color: fRtColor(c.reltype), x1: fromP.x || 0, y1: fromP.y || 0, x2: toP.x || 0, y2: toP.y || 0 };
  });
  const pairGroups = {};
  linkData.forEach(c => { const k = [c.from, c.to].sort().join('|'); (pairGroups[k] = pairGroups[k] || []).push(c); });
  const offsetLinks = [];
  Object.values(pairGroups).forEach(group => {
    const n = group.length;
    group.forEach((c, i) => {
      const off = n === 1 ? 0 : (i - (n - 1) / 2) * 5;
      const dx = c.x2 - c.x1, dy = c.y2 - c.y1, len = Math.sqrt(dx * dx + dy * dy) || 1;
      const ox = -dy / len * off, oy = dx / len * off;
      offsetLinks.push({ ...c, ax1: c.x1 + ox, ay1: c.y1 + oy, ax2: c.x2 + ox, ay2: c.y2 + oy });
    });
  });
  fLinksG.selectAll('.gm-link').data(offsetLinks, d => d.id).join('line')
    .attr('class', d => `gm-link gm-link-${d.status}`)
    .attr('stroke', d => d.color).attr('stroke-width', 1.5)
    .attr('x1', d => d.ax1).attr('y1', d => d.ay1).attr('x2', d => d.ax2).attr('y2', d => d.ay2);

  const drag = d3.drag()
    .on('start', function () { d3.select(this).raise(); })
    .on('drag', function (e, d) {
      d.x = e.x; d.y = e.y;
      d3.select(this).attr('transform', `translate(${d.x},${d.y})`);
      fLinksG.selectAll('.gm-link').filter(l => l.from === d.id || l.to === d.id).each(function (l) {
        if (l.from === d.id) d3.select(this).attr('x1', d.x).attr('y1', d.y);
        else d3.select(this).attr('x2', d.x).attr('y2', d.y);
      });
    })
    .on('end', () => saveFieldData());

  fNodesG.selectAll('.gm-node-group').data(filtered, d => d.id).join(
    enter => {
      const ng = enter.append('g').attr('class', 'gm-node-group').attr('transform', d => `translate(${d.x || 0},${d.y || 0})`).call(drag).on('click', (e, d) => { e.stopPropagation(); openFieldPanel(d.id); });
      ng.append('circle').attr('class', 'gm-node-circle');
      ng.append('text').attr('class', 'gm-node-label');
      return ng;
    },
    update => update.attr('transform', d => `translate(${d.x || 0},${d.y || 0})`).call(drag)
  );
  fNodesG.selectAll('.gm-node-group').select('.gm-node-circle').attr('r', 6).attr('fill', d => fCommColor(d.community)).attr('fill-opacity', 0.85).attr('stroke', d => fCommColor(d.community)).attr('stroke-width', 1.5).attr('stroke-opacity', 0.5);
  fNodesG.selectAll('.gm-node-group').select('.gm-node-label').text(d => d.name).attr('y', 16);
}

function openFieldPanel(id) {
  fSelectedId = id;
  const p = fPeople.find(x => x.id === id);
  if (!p) return;
  const cc = fCommColor(p.community);
  document.getElementById('gmPanelDot').style.background = cc;
  document.getElementById('gmPanelName').textContent = p.name;
  const myConns = fConnections.filter(c => c.from === id || c.to === id);
  const connHtml = myConns.map(c => {
    const otherId = c.from === id ? c.to : c.from;
    const otherName = otherId === '__center__' ? fCenterName : (fPeople.find(x => x.id === otherId) || { name: '?' }).name;
    const rt = fReltypes.find(r => r.id === c.reltype) || { label: c.reltype, color: '#aaa' };
    return `<div class="gm-conn-row"><span class="gm-legend-dot" style="background:${rt.color}"></span><span>${escapeHtml(rt.label)} ↔ ${escapeHtml(otherName)}</span><span class="gm-conn-status">${c.status}</span><button class="gm-conn-del" onclick="deleteFieldConn('${c.id}')">×</button></div>`;
  }).join('');
  const rtOpts = fReltypes.slice().sort((a, b) => a.label.localeCompare(b.label)).map(r => `<option value="${r.id}">${escapeHtml(r.label)}</option>`).join('');
  const pplOpts = [`<option value="__center__">${escapeHtml(fCenterName)} (you)</option>`, ...fPeople.filter(x => x.id !== id).slice().sort((a, b) => a.name.localeCompare(b.name)).map(x => `<option value="${x.id}">${escapeHtml(x.name)}</option>`)].join('');
  document.getElementById('gmPanelBody').innerHTML = `
    <div class="gm-p-section"><label>Community</label><div style="display:flex;align-items:center;gap:7px;"><span class="gm-legend-dot" style="background:${cc}"></span>${escapeHtml((fCommunities.find(c => c.id === p.community) || { label: p.community || 'None' }).label)} · Ring ${p.intimacy}</div></div>
    ${p.birthday ? `<div class="gm-p-section"><label>Birthday</label><p class="gm-p-text">${escapeHtml(new Date(p.birthday + 'T00:00:00').toLocaleDateString(undefined, { month: 'long', day: 'numeric' }))}</p></div>` : ''}
    ${p.notes ? `<div class="gm-p-section"><label>Notes</label><p class="gm-p-text">${escapeHtml(p.notes)}</p></div>` : ''}
    ${(p.topics || []).length ? `<div class="gm-p-section"><label>Topics</label><p class="gm-p-text gm-muted">${escapeHtml(p.topics.join(', '))}</p></div>` : ''}
    <div class="gm-p-section"><label>Connections</label>
      <div class="gm-conn-list">${connHtml || '<div class="gm-empty-note">No connections yet</div>'}</div>
      ${fReltypes.length ? `<div class="gm-add-conn-row">
        <select id="gmConnTo">${pplOpts}</select>
        <select id="gmConnType">${rtOpts}</select>
        <select id="gmConnStatus"><option value="current">Current</option><option value="recent">Recent</option><option value="past">Past</option></select>
        <button class="gm-btn" onclick="addFieldConn('${id}')">+ Add</button>
      </div>` : '<div class="gm-empty-note">Add a Bond Type in Settings to create connections.</div>'}
    </div>`;
  document.getElementById('gmPanel').classList.add('open');
}
function closeFieldPanel() { document.getElementById('gmPanel').classList.remove('open'); fSelectedId = null; }
function deleteFieldConn(id) { fConnections = fConnections.filter(c => c.id !== id); saveFieldData(); if (fSelectedId) openFieldPanel(fSelectedId); fRenderGraph(); }
function addFieldConn(fromId) {
  const toId = document.getElementById('gmConnTo').value;
  const rtId = document.getElementById('gmConnType').value;
  const status = document.getElementById('gmConnStatus').value;
  if (!toId || !rtId) return;
  fConnections.push({ id: 'conn-' + Date.now() + '-' + Math.random().toString(36).slice(2), from: fromId, to: toId, reltype: rtId, status });
  saveFieldData(); openFieldPanel(fromId); fRenderGraph();
}

function openFieldPersonModal(person) {
  fEditingId = person?.id || null;
  document.getElementById('gmPersonModalTitle').textContent = person ? 'Edit Person' : 'Add Person';
  document.getElementById('gmFName').value = person?.name || '';
  document.getElementById('gmFBirthday').value = person?.birthday || '';
  document.getElementById('gmFNotes').value = person?.notes || '';
  document.getElementById('gmFTopics').value = (person?.topics || []).join(', ');
  document.getElementById('gmFIntimacy').value = person?.intimacy || '3';
  const sel = document.getElementById('gmFCommunity');
  sel.innerHTML = fCommunities.length ? fCommunities.map(c => `<option value="${c.id}">${escapeHtml(c.label)}</option>`).join('') : '<option value="">Add a Community in Settings first</option>';
  if (person) sel.value = person.community;
  document.getElementById('gmPersonOverlay').classList.add('open');
}

function fBuildFilters() {
  const c = document.getElementById('gmFilters');
  c.innerHTML = `<button class="gm-filter-btn ${fActiveFilters.size === 0 ? 'active' : ''}" id="gmFilterAll">all</button>` +
    fCommunities.map(comm => `<button class="gm-filter-btn ${fActiveFilters.has(comm.id) ? 'active' : ''}" data-comm="${comm.id}" style="${fActiveFilters.has(comm.id) ? `border-color:${comm.color};color:${comm.color};` : ''}">${escapeHtml(comm.label)}</button>`).join('');
  document.getElementById('gmFilterAll').addEventListener('click', () => { fActiveFilters.clear(); fBuildFilters(); fRenderGraph(); });
  c.querySelectorAll('[data-comm]').forEach(btn => {
    btn.addEventListener('click', () => { const id = btn.dataset.comm; if (fActiveFilters.has(id)) fActiveFilters.delete(id); else fActiveFilters.add(id); fBuildFilters(); fRenderGraph(); });
  });
}
function fBuildStatusFilters() {
  const c = document.getElementById('gmStatusFilters');
  c.innerHTML = '';
  FIELD_STATUS_PRESETS.forEach(preset => {
    const same = preset.statuses.length === fActiveStatuses.size && preset.statuses.every(s => fActiveStatuses.has(s));
    const btn = document.createElement('button');
    btn.className = 'gm-filter-btn' + (same ? ' active' : '');
    btn.textContent = preset.label;
    btn.addEventListener('click', () => { fActiveStatuses = new Set(preset.statuses); fBuildStatusFilters(); fRenderGraph(); });
    c.appendChild(btn);
  });
}
function fBuildLegend() {
  document.getElementById('gmLegend').innerHTML = `
    ${fCommunities.length ? `<h4>Communities</h4>${fCommunities.map(c => `<div class="gm-legend-row"><span class="gm-legend-dot" style="background:${c.color}"></span>${escapeHtml(c.label)}</div>`).join('')}` : ''}
    ${fCommunities.length && fReltypes.length ? '<hr class="gm-legend-divider">' : ''}
    ${fReltypes.length ? `<h4>Bond Types</h4>${fReltypes.map(r => `<div class="gm-legend-row"><span class="gm-legend-dot" style="background:${r.color}"></span>${escapeHtml(r.label)}</div>`).join('')}` : ''}
    ${!fCommunities.length && !fReltypes.length ? '<div class="gm-empty-note">Open Settings to define your own communities and bond types.</div>' : ''}
  `;
}

function renderFieldSettings() {
  const body = document.getElementById('gmSettingsBody');
  if (fActiveSettingsTab === 'communities') {
    body.innerHTML = `<p class="gm-s-note">Communities color the dots on the map.</p>
      ${fCommunities.map(c => `<div class="gm-s-item"><input type="color" value="${c.color}" onchange="updateFieldComm('${c.id}','color',this.value)"><input type="text" value="${escapeHtml(c.label)}" onchange="updateFieldComm('${c.id}','label',this.value)"><button class="gm-s-item-del" onclick="deleteFieldComm('${c.id}')">×</button></div>`).join('')}
      <div class="gm-s-add-row"><input type="color" id="gmNewCommColor" value="#74B9FF"><input type="text" id="gmNewCommName" placeholder="New community name…"><button class="gm-btn" onclick="addFieldComm()">+ Add</button></div>`;
  } else if (fActiveSettingsTab === 'reltypes') {
    body.innerHTML = `<p class="gm-s-note">Bond types color the lines between people.</p>
      ${fReltypes.map(r => `<div class="gm-s-item"><input type="color" value="${r.color}" onchange="updateFieldRt('${r.id}','color',this.value)"><input type="text" value="${escapeHtml(r.label)}" onchange="updateFieldRt('${r.id}','label',this.value)"><button class="gm-s-item-del" onclick="deleteFieldRt('${r.id}')">×</button></div>`).join('')}
      <div class="gm-s-add-row"><input type="color" id="gmNewRtColor" value="#74B9FF"><input type="text" id="gmNewRtName" placeholder="New bond type…"><button class="gm-btn" onclick="addFieldRt()">+ Add</button></div>`;
  } else {
    body.innerHTML = `
      <p class="gm-s-sub-title">Your Name</p>
      <input id="gmCenterNameInput" type="text" value="${escapeHtml(fCenterName)}">
      <button class="gm-btn" style="margin-top:8px;width:100%;" onclick="saveFieldCenterName()">Update Name</button>
      <p class="gm-s-sub-title" style="margin-top:20px;">Export</p>
      <button class="gm-btn" style="width:100%;" onclick="exportFieldJSON()">⬇ Export as JSON backup</button>
      <p class="gm-s-sub-title" style="margin-top:20px;">Danger Zone</p>
      <button class="gm-btn gm-danger" style="width:100%;" onclick="resetFieldAll()">⚠ Reset everything — start over</button>`;
  }
}
function updateFieldComm(id, field, value) { const c = fCommunities.find(x => x.id === id); if (c) c[field] = value; saveFieldData(); fBuildFilters(); fBuildLegend(); fRenderGraph(); }
function deleteFieldComm(id) {
  if (!confirm('Delete this community? People in it will keep it as a dangling reference until reassigned.')) return;
  fCommunities = fCommunities.filter(c => c.id !== id); saveFieldData(); fBuildFilters(); fBuildLegend(); fRenderGraph(); renderFieldSettings();
}
function addFieldComm() {
  const name = document.getElementById('gmNewCommName').value.trim();
  const color = document.getElementById('gmNewCommColor').value;
  if (!name) return;
  fCommunities.push({ id: 'c-' + Date.now(), label: name, color });
  saveFieldData(); fBuildFilters(); fBuildLegend(); renderFieldSettings();
}
function updateFieldRt(id, field, value) { const r = fReltypes.find(x => x.id === id); if (r) r[field] = value; saveFieldData(); fBuildLegend(); fRenderGraph(); }
function deleteFieldRt(id) {
  if (!confirm('Delete this bond type? Connections using it will be removed.')) return;
  fConnections = fConnections.filter(c => c.reltype !== id); fReltypes = fReltypes.filter(r => r.id !== id);
  saveFieldData(); fBuildLegend(); fRenderGraph(); renderFieldSettings();
}
function addFieldRt() {
  const name = document.getElementById('gmNewRtName').value.trim();
  const color = document.getElementById('gmNewRtColor').value;
  if (!name) return;
  fReltypes.push({ id: 'r-' + Date.now(), label: name, color });
  saveFieldData(); fBuildLegend(); renderFieldSettings();
}
function saveFieldCenterName() {
  const v = document.getElementById('gmCenterNameInput').value.trim();
  if (!v) return;
  fCenterName = v; saveFieldData();
  document.querySelector('.gm-center-label').textContent = v.slice(0, 14);
}
function exportFieldJSON() {
  const data = JSON.stringify({ centerName: fCenterName, communities: fCommunities, reltypes: fReltypes, people: fPeople, connections: fConnections }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `guild-map-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
async function resetFieldAll() {
  if (!confirm('This will delete all people, connections, communities, and bond types. Are you sure?')) return;
  if (!confirm('Really? This cannot be undone.')) return;
  fCommunities = []; fReltypes = []; fPeople = []; fConnections = []; fLayouts = {};
  await saveFieldData(); await saveFieldLayouts();
  renderFieldView(document.getElementById('mainView'));
}

async function saveFieldLayout(name) {
  const positions = {};
  fPeople.forEach(p => { if (p.x !== undefined && p.y !== undefined) positions[p.id] = { x: p.x, y: p.y }; });
  fLayouts[name] = { positions, savedAt: new Date().toISOString() };
  await saveFieldLayouts();
  refreshFieldLayoutDropdown();
}
function refreshFieldLayoutDropdown() {
  const dd = document.getElementById('gmLayoutDropdown');
  const names = Object.keys(fLayouts).sort((a, b) => new Date(fLayouts[b].savedAt) - new Date(fLayouts[a].savedAt));
  if (!names.length) { dd.innerHTML = '<div class="gm-empty-note">No saved layouts yet</div>'; return; }
  dd.innerHTML = names.map(name => {
    const d = new Date(fLayouts[name].savedAt);
    return `<div class="gm-layout-item" data-name="${escapeHtml(name)}"><span class="gm-layout-item-name">${escapeHtml(name)}</span><span class="gm-layout-item-date">${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span><button class="gm-layout-item-del" data-del="${escapeHtml(name)}">×</button></div>`;
  }).join('');
  dd.querySelectorAll('.gm-layout-item').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.dataset.del) return;
      const name = row.dataset.name;
      fPeople.forEach(p => { if (fLayouts[name].positions[p.id]) { p.x = fLayouts[name].positions[p.id].x; p.y = fLayouts[name].positions[p.id].y; } });
      dd.classList.remove('open'); saveFieldData(); fRenderGraph();
    });
  });
  dd.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm(`Delete "${btn.dataset.del}"?`)) return;
      delete fLayouts[btn.dataset.del]; await saveFieldLayouts(); refreshFieldLayoutDropdown();
    });
  });
}

function fWireControls() {
  document.getElementById('gmSearch').addEventListener('input', e => { fSearchQuery = e.target.value; fRenderGraph(); });
  document.getElementById('gmAddBtn').addEventListener('click', () => openFieldPersonModal(null));
  document.getElementById('gmPersonModalClose').addEventListener('click', () => document.getElementById('gmPersonOverlay').classList.remove('open'));
  document.getElementById('gmPersonCancel').addEventListener('click', () => document.getElementById('gmPersonOverlay').classList.remove('open'));
  document.getElementById('gmPersonSave').addEventListener('click', () => {
    const name = document.getElementById('gmFName').value.trim();
    if (!name) return;
    const topics = document.getElementById('gmFTopics').value.split(',').map(s => s.trim()).filter(Boolean);
    const commEl = document.getElementById('gmFCommunity');
    const dataObj = { name, community: commEl.value || null, intimacy: parseInt(document.getElementById('gmFIntimacy').value), birthday: document.getElementById('gmFBirthday').value || null, notes: document.getElementById('gmFNotes').value.trim(), topics };
    if (fEditingId) {
      const idx = fPeople.findIndex(p => p.id === fEditingId);
      if (idx !== -1) fPeople[idx] = { ...fPeople[idx], ...dataObj };
    } else {
      dataObj.id = 'p-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      fPeople.push(dataObj);
      fSeedPositions([dataObj]);
    }
    saveFieldData();
    document.getElementById('gmPersonOverlay').classList.remove('open');
    fRenderGraph();
    if (fEditingId) openFieldPanel(fEditingId);
    fEditingId = null;
  });
  document.getElementById('gmPersonOverlay').addEventListener('click', e => { if (e.target.id === 'gmPersonOverlay') document.getElementById('gmPersonOverlay').classList.remove('open'); });

  document.getElementById('gmPanelClose').addEventListener('click', closeFieldPanel);
  document.getElementById('gmPanelEditBtn').addEventListener('click', () => { if (fSelectedId) openFieldPersonModal(fPeople.find(x => x.id === fSelectedId)); });
  document.getElementById('gmPanelDeleteBtn').addEventListener('click', () => {
    if (!fSelectedId || !confirm('Remove this person and all their connections?')) return;
    fPeople = fPeople.filter(p => p.id !== fSelectedId);
    fConnections = fConnections.filter(c => c.from !== fSelectedId && c.to !== fSelectedId);
    saveFieldData(); closeFieldPanel(); fRenderGraph();
  });

  document.getElementById('gmSettingsBtn').addEventListener('click', () => { document.getElementById('gmSettings').classList.add('open'); closeFieldPanel(); buildFieldSettingsTabs(); renderFieldSettings(); });
  document.getElementById('gmSettingsClose').addEventListener('click', () => document.getElementById('gmSettings').classList.remove('open'));

  document.getElementById('gmSaveLayoutBtn').addEventListener('click', () => {
    const pop = document.getElementById('gmSavePopover');
    if (pop.classList.contains('open')) { pop.classList.remove('open'); return; }
    document.getElementById('gmLayoutNameInput').value = `Layout ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    pop.classList.add('open');
  });
  document.getElementById('gmLayoutNameConfirm').addEventListener('click', async () => {
    const name = document.getElementById('gmLayoutNameInput').value.trim();
    document.getElementById('gmSavePopover').classList.remove('open');
    if (name) await saveFieldLayout(name);
  });
  document.getElementById('gmLoadLayoutBtn').addEventListener('click', () => {
    const dd = document.getElementById('gmLayoutDropdown');
    if (dd.classList.contains('open')) { dd.classList.remove('open'); return; }
    refreshFieldLayoutDropdown(); dd.classList.add('open');
  });
}
function buildFieldSettingsTabs() {
  const tabs = document.getElementById('gmSettingsTabs');
  tabs.innerHTML = ['communities', 'reltypes', 'general'].map(t => `<div class="gm-s-tab ${fActiveSettingsTab === t ? 'active' : ''}" data-tab="${t}">${t === 'reltypes' ? 'Bond Types' : t.charAt(0).toUpperCase() + t.slice(1)}</div>`).join('');
  tabs.querySelectorAll('.gm-s-tab').forEach(tab => {
    tab.addEventListener('click', () => { fActiveSettingsTab = tab.dataset.tab; buildFieldSettingsTabs(); renderFieldSettings(); });
  });
}

// ── Projects (with per-project to-dos) — private per-user, same model as Guild Map ──
let pProjects = [];
let pLeadershipDocs = [];
const PROJECTS_COLLAPSE_KEY = 'gm-collapsed-projects';
function getCollapsedProjects() {
  try { return new Set(JSON.parse(localStorage.getItem(PROJECTS_COLLAPSE_KEY) || '[]')); } catch (e) { return new Set(); }
}
function setCollapsedProjects(set) { localStorage.setItem(PROJECTS_COLLAPSE_KEY, JSON.stringify([...set])); }

async function saveProjects() { await apiFetch('/api/projects', { method: 'PUT', body: { projects: pProjects } }); }

// ── Leadership Docs — snapshot of CSI's governance docs from the Obsidian
// vault (community/guilds/*.md), baked in at build time. Not live-synced —
// if the vault docs change, this needs a redeploy to catch up.
const LEADERSHIP_DOCS = [
  { id: 'charter', title: 'CSI Charter', content: `# Carnival Society International

**Building Together Through Joy**

## What CSI Is

"Carnival Society International is a guild network that unites organizations to build, together, through joy."

Its members are the participatory artists, performers, organizers, land stewards, and community builders inside those organizations. It exists to build durable creative and ecological infrastructure, not just to produce events.

A CSI Carnival does not consume a community's energy — it leaves more behind than it found: new friendships, new artists activated, new projects initiated, a stronger local creative scene, and measurable progress toward land, water, and a permanent site held in common.

## Origin

CSI grew out of eleven years of public participatory work. The founding insight was structural: the carnival itself already worked — what it lacked was a structure that could hold it beyond any single person or event.

## What a Guild Is

A guild is not a club, a collective, or a company. It is a durable social structure organized around shared craft, shared values, and mutual support. Guilds persist across generations, develop their own language and traditions, protect the integrity of the work, and create the conditions for new practitioners to emerge.

## Membership Is Guild Membership

All CSI live events are private, RSVP, member-only gatherings. Membership is required to attend a Carnival; there is no public ticket path.

There are two ways to become a guild member:

- **Direct membership** — an individual applies to the guild and is accepted on their own standing.
- **Membership through an Allied Organization** — an organization formally allied with CSI extends guild membership to its own members as part of that alliance.

## Membership Tiers

Guild membership itself is free. Members who want to learn a trade move into one of three tiers:

- **Single Class** — pay as you go, one class at a time, no commitment.
- **Unlimited Classes (Guild Dues)** — recurring dues, every trade, every chapter.
- **Classes & Builds (Guild Dues+)** — recurring dues, plus a hand on the actual build.

Rank — Apprentice, Journeyman, Master — is separate from all of this. It tracks what a member has learned and built, not what they've paid, and it is earned, never bought.

## Allied Organizations

CSI grows by bringing whole organizations into the network, not by recruiting individuals one at a time. When an organization becomes allied:

- Its members become eligible for CSI guild membership as part of that alliance.
- The organization represents itself at Carnivals — its own name, craft, and presence, inside the shared event.
- Members move through the network: a member of one Allied Organization is welcomed at another's programs, classes, or spaces.
- Guild membership, once granted, belongs to the individual — it does not end automatically if their organization's alliance later ends.

## The Chapter Structure

CSI operates through local chapters. Each chapter is rooted in a specific place, produces at least one Carnival per season, maintains its own membership and stewardship, and connects to the broader CSI network.

Chapters are autonomous in production. They are not autonomous in values or structure — the guild holds the frame, the chapter fills it.

## The Ringkeeper

Each chapter is held by a Ringkeeper — not a promoter, producer, or manager, but the person who holds the vision of the Carnival in their community, recruits and supports local stewards, and ensures the Carnival leaves the community richer than it found it.

## What CSI Provides

- **Operational infrastructure** — documents, templates, money-flow structures, role frameworks.
- **Institutional language** — the shared vocabulary developed over eleven years of practice.
- **Network** — connection to other chapters, Allied Organizations, Ringkeepers, and practitioners.
- **Continuity** — a structure designed to outlast any single event, season, or person.

## What CSI Is Not

CSI is not a booking agency, a talent management company, a festival brand for hire, or a consensus-governed collective.

## Founding Authority

CSI was founded by Lewis Neeff under Guerrilla Concerto. The founding authority holds the guild's language and structural framework, the Ringkeeper certification process, and the long-range direction of the network — not to control local production. Chapters run their own Carnivals; the guild holds the frame that makes that possible.

## The Long Game

CSI is built for decades, and for more than events. The measure of success is not attendance, revenue, or visibility. The measure is whether a community has more creative capacity after the Carnival than before, and whether the guild is measurably closer to the land it is building toward.

## Closing

The circus does not need to be rebuilt every time. CSI exists so that wherever a Ringkeeper stands, or wherever an organization joins, the infrastructure is already there.

Carnival Society International is a Guerrilla Concerto institution.` },

  { id: 'stewardship', title: 'Stewardship Structure', content: `# CSI Stewardship Structure

*(Internal framework — durable, explicit, scalable)*

Carnival Society International operates through clear stewardship, not consensus. Each role exists to protect coherence, continuity, and public trust.

## 1. Founder–Steward (Lewis Neeff)

**Function:** Custodian of CSI's language and direction.

**Authority** — final authority over vision, language, project acceptance, structural changes, and appointment/removal of stewards.

**Limits:** does not micromanage execution, does not run decisions by committee, does not take on other people's conflicts or fallout.

This role is singular.

## 2. Systems Steward

**Function:** Maintains the internal logic, mechanics, and integrity of CSI's systems.

**Authority:** operational decisions within defined systems; veto implementations that violate core principles.

**Reports to:** Founder–Steward

## 3. Participation Steward

**Function:** Protects participant dignity, clarity, and safety within CSI works.

**Authority:** halt or modify participatory processes if harm or confusion emerges.

**Reports to:** Founder–Steward

## 4. Archive Steward

**Function:** Maintains memory, documentation, and returnability.

**Authority:** determine archival standards and access protocols.

**Reports to:** Founder–Steward

## 5. Place & Living Systems Steward (emerging role)

**Function:** Oversees physical sites, landscapes, and living infrastructures.

**Authority:** determine maintenance rhythms and access conditions.

**Reports to:** Founder–Steward

## 6. Temporal Steward (optional / future-facing)

**Function:** Protects pacing, duration, and long-term viability.

**Reports to:** Founder–Steward

## 7. Operations & Finance Steward

**Function:** Keeps the Carnival's money legible — tracks it, protects it, and flags risk early.

**Authority:** full visibility into the Carnival Operating Fund; pause spending that exceeds budget or presents risk.

**Reports to:** Founder–Steward

## 8. Carnival Director

**Function:** Runs the production of the Carnival itself — the operational lead on the ground.

**Authority:** day-of and production-cycle operational decisions; sign off on contributor compensation agreements.

**Reports to:** Founder–Steward` },

  { id: 'compensation', title: 'Compensation & Support', content: `# CSI Compensation & Support

The Carnival is a participatory art event. Not all contributions are compensated financially.

Compensation, when offered, is role-based, situational, and capacity-dependent, and exists to strengthen the continuity, safety, and operational stability of the Carnival.

Compensation may take the form of:
- stipends
- expense or material offsets
- revenue share
- other agreed-upon support

All compensation arrangements must be explicitly agreed to in advance between the contributor and the Carnival Director or designated steward. Participation alone does not guarantee compensation.

## Priority of Compensation

When funds are available, compensation is prioritized in the following order:

1. **Operational and Safety Roles** — logistical responsibility, risk mitigation, structural continuity.
2. **Continuity Labor** — before/after-event work: storage, transport, coordination, documentation, financial administration.
3. **Selective Artist Support** — modest stipends or offsets for materials, travel, or execution — not standard performance fees.

Organizer compensation is disclosed separately and considered part of the event's core infrastructure.

## Transparency & Boundaries

Compensation is offered to support the Carnival's growth and sustainability, not as a measure of artistic value, status, or ownership. No contributor accrues authority, ownership, or decision-making power through compensation.

## Final Line

Contributors who require guaranteed compensation should communicate this before committing to participate.` },

  { id: 'moneyflow', title: 'Money Flow Map', content: `# CSI Money Flow Map

*(Internal — v1.0)*

## Purpose

Describes how money enters, moves through, and exits the CSI Carnival Co-Op. Keeps finances legible, reduces confusion and stress, prevents informal or emotional handling of money.

## Core Principle

Money exists to support production, cover shared costs, compensate labor where agreed, and enable continuity. Money does not exist to accumulate power, replace planning, resolve conflict, or justify unclear decisions.

## 1. Sources of Funds

- **Seasonal Member Dues** — modest, per-season, paid upfront where possible
- **Ticket Sales** — not assumed until realized
- **Donations & Patron Support** — "Friends of the Carnival," one-time or recurring
- **Sponsorships & Institutional Support** — cash sponsorships, program support, grants
- **In-Kind Contributions** — space, materials, equipment, services — tracked separately

## 2. Pooling of Funds

All monetary income is pooled into a Carnival Operating Fund for the season. There are no informal side funds. Visible to the Founder and the Operations & Finance Steward.

## 3. Expense Categories (Order Matters)

1. **Hard Costs (Non-Negotiable)** — venue/land fees, permits, insurance, safety infrastructure. Paid first.
2. **Production Costs** — materials, tools, transport, shared infrastructure.
3. **Labor & Compensation (As Agreed)** — only paid where roles are defined, amounts agreed, funds available. Unpaid labor is never assumed.
4. **Administrative Costs** — accounting, software, banking fees, printing. Kept minimal.
5. **Reserve / Carry-Forward** — rolled into next season. Not discretionary spending.

## 4. Authority & Controls

**Operations & Finance Steward:** full visibility into all funds, tracks income/expenses, flags risk early, may pause risky spending.

**Founder:** approves budgets and major expenditures, sets priorities.

No single person unilaterally redirects pooled funds.

## 5. Transparency

Financial summaries available to Core Stewards; Seasonal Members get high-level overviews; detailed records maintained, not broadcast.

## 6. Cash Flow Timing

Upfront costs identified early; expenses not incurred without a funding plan; shortfalls addressed structurally, not personally.

## 7. End of Season

Expenses closed, outstanding payments resolved, remaining funds allocated to reserves, a brief financial summary prepared. No season ends informally.

## Closing

This structure exists to reduce pressure on individuals, keep production realistic, and allow the Carnival to recur. Clarity around money protects the work.` },

  { id: 'roster', title: 'Roles & Officers', content: `# Carnival Society — Roles & Officers

Local roster for the guild. Full role definitions (function, authority, limits) are in the Stewardship Structure doc.

| Role | Person |
|------|--------|
| Founder–Steward | Lewis Neeff |
| Systems Steward | *(open)* |
| Participation Steward | *(open)* |
| Archive Steward | *(open)* |
| Place & Living Systems Steward | *(open)* |
| Temporal Steward | *(open)* |
| Operations & Finance Steward | *(open)* |
| Carnival Director | *(open)* |

Live member roster and dues status: see **Members Hub**.` },
];

// Small markdown → HTML renderer — headers, bold/italic, lists, simple pipe
// tables, paragraphs. Enough for these docs; not a general-purpose parser.
function renderMarkdown(md) {
  const lines = md.split('\n');
  let html = '';
  let i = 0;
  function inline(text) {
    return escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/\[\[(.+?)\]\]/g, '<span class="ld-wikilink">$1</span>');
  }
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const level = h[1].length + 2;
      html += `<h${level} class="ld-h${level}">${inline(h[2])}</h${level}>`;
      i++; continue;
    }
    if (line.trim().startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(lines[i].trim()); i++; }
      const cells = rows.map(r => r.split('|').map(c => c.trim()).filter((c, idx, arr) => !(idx === 0 && c === '') && !(idx === arr.length - 1 && c === '')));
      const [headerRow, , ...bodyRows] = cells;
      html += '<table class="ld-table"><thead><tr>' + headerRow.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        bodyRows.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>';
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      html += '<ul class="ld-list">';
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) { html += `<li>${inline(lines[i].replace(/^[-*]\s+/, ''))}</li>`; i++; }
      html += '</ul>';
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      html += '<ol class="ld-list">';
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) { html += `<li>${inline(lines[i].replace(/^\d+\.\s+/, ''))}</li>`; i++; }
      html += '</ol>';
      continue;
    }
    let para = line;
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,3})\s/.test(lines[i]) && !/^[-*]\s/.test(lines[i]) && !/^\d+\.\s/.test(lines[i]) && !lines[i].trim().startsWith('|')) {
      para += ' ' + lines[i]; i++;
    }
    html += `<p class="ld-p">${inline(para)}</p>`;
  }
  return html;
}

async function renderProjectsView(mainView) {
  if (!profile?.is_ringleader) {
    mainView.innerHTML = `<h2>Not authorized</h2><div class="placeholder-note">Ringleaders only.</div>`;
    return;
  }
  mainView.innerHTML = `
    <div class="projects-layout">
      <div class="projects-main">
        <h2>Projects</h2>
        <div class="projects-toolbar">
          <button class="gm-btn" id="newProjectToggleBtn" style="background:var(--surface);color:var(--cream);">+ New Project</button>
        </div>
        <div class="card new-project-form" id="newProjectForm">
          <div class="field-row"><label>Name</label><input type="text" id="npName" placeholder="e.g. Boulder Chapter Launch"></div>
          <div class="field-row"><label>Description</label><input type="text" id="npDescription" placeholder="One line — what this project is"></div>
          <div class="field-row"><label>Deadline</label><input type="date" id="npDeadline"></div>
          <div class="field-row"><label>Parent Project</label><select id="npParent"></select></div>
          <div class="form-actions">
            <button class="composer-submit" id="npCreateBtn">Create</button>
            <button class="gm-btn" id="npCancelBtn" style="background:var(--surface);color:var(--cream);">Cancel</button>
          </div>
        </div>
        <div id="projectsList"></div>
      </div>
      <div class="leadership-docs-col">
        <div class="ld-header">
          <span>Leadership Docs</span>
          <button class="ld-add-btn" id="ldAddBtn" title="Add a private doc — only you ever see it">+ Add Doc</button>
        </div>
        <div class="ld-tabs" id="ldTabs"></div>
        <div class="ld-content" id="ldContent"></div>
      </div>
    </div>
    <div class="gm-overlay" id="ldAddOverlay">
      <div class="gm-modal">
        <div class="gm-modal-header"><h3>Add Private Doc</h3><button id="ldAddClose">&times;</button></div>
        <div class="gm-modal-body">
          <p class="ld-s-note">Only you will ever see this — it's stored on your account, not shared with other Ringleaders (unlike the CSI docs above it).</p>
          <div class="field-row"><label>Title</label><input type="text" id="ldNewTitle" placeholder="e.g. Leadership"></div>
          <div class="field-row"><label>Content (markdown)</label><textarea id="ldNewContent" rows="10" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:3px;padding:0.5rem 0.7rem;color:var(--cream);font-family:inherit;"></textarea></div>
        </div>
        <div class="gm-modal-footer">
          <button class="gm-btn" id="ldNewCancel">Cancel</button>
          <button class="composer-submit" id="ldNewSave">Save</button>
        </div>
      </div>
    </div>
  `;

  const data = await apiFetch('/api/projects');
  pProjects = data.projects || [];
  pLeadershipDocs = data.leadership_docs || [];

  renderProjectCards();
  wireProjectsControls();
  renderLeadershipDocs();
}

async function saveLeadershipDocs() { await apiFetch('/api/projects', { method: 'PUT', body: { leadership_docs: pLeadershipDocs } }); }

function renderLeadershipDocs() {
  const tabsEl = document.getElementById('ldTabs');
  const contentEl = document.getElementById('ldContent');
  const allDocs = [
    ...LEADERSHIP_DOCS.map(d => ({ ...d, private: false })),
    ...pLeadershipDocs.map(d => ({ ...d, private: true })),
  ];
  tabsEl.innerHTML = allDocs.map((d, i) => `<button class="ld-tab ${i === 0 ? 'active' : ''} ${d.private ? 'ld-tab-private' : ''}" data-doc="${d.id}" data-private="${d.private}">${d.private ? '🔒 ' : ''}${escapeHtml(d.title)}</button>`).join('');
  function showDoc(id) {
    const doc = allDocs.find(d => d.id === id);
    const delBtn = doc.private ? `<button class="gm-conn-del" id="ldDeleteBtn" style="float:right;">Delete</button>` : '';
    contentEl.innerHTML = delBtn + renderMarkdown(doc.content);
    tabsEl.querySelectorAll('.ld-tab').forEach(t => t.classList.toggle('active', t.dataset.doc === id));
    const del = document.getElementById('ldDeleteBtn');
    if (del) del.addEventListener('click', async () => {
      if (!confirm('Delete this private doc?')) return;
      pLeadershipDocs = pLeadershipDocs.filter(d => d.id !== id);
      await saveLeadershipDocs();
      renderLeadershipDocs();
    });
  }
  tabsEl.querySelectorAll('.ld-tab').forEach(t => t.addEventListener('click', () => showDoc(t.dataset.doc)));
  if (allDocs.length) showDoc(allDocs[0].id);

  document.getElementById('ldAddBtn').addEventListener('click', () => document.getElementById('ldAddOverlay').classList.add('open'));
  document.getElementById('ldAddClose').addEventListener('click', () => document.getElementById('ldAddOverlay').classList.remove('open'));
  document.getElementById('ldNewCancel').addEventListener('click', () => document.getElementById('ldAddOverlay').classList.remove('open'));
  document.getElementById('ldNewSave').addEventListener('click', async () => {
    const title = document.getElementById('ldNewTitle').value.trim();
    const content = document.getElementById('ldNewContent').value.trim();
    if (!title || !content) return;
    pLeadershipDocs.push({ id: 'ld-' + Date.now(), title, content });
    await saveLeadershipDocs();
    document.getElementById('ldNewTitle').value = '';
    document.getElementById('ldNewContent').value = '';
    document.getElementById('ldAddOverlay').classList.remove('open');
    renderLeadershipDocs();
  });
}

function renderProjectCards() {
  const listEl = document.getElementById('projectsList');
  if (!pProjects.length) { listEl.innerHTML = '<div class="placeholder-note">No projects yet. Use "+ New Project" above.</div>'; return; }
  listEl.innerHTML = '';
  pProjects.filter(p => !p.parent_id).forEach(proj => {
    const card = document.createElement('div');
    card.className = 'card gm-project-window';
    card.appendChild(buildProjectBlock(proj, 0));
    listEl.appendChild(card);
  });
}

function collectDescendantIds(id) {
  const direct = pProjects.filter(p => p.parent_id === id).map(p => p.id);
  return direct.concat(...direct.map(collectDescendantIds));
}

// Renders one project (and, indented beneath it in the same window, all its
// descendants) — not a separate boxed card per sub-project, just indentation.
function buildProjectBlock(proj, depth) {
  const collapsed = getCollapsedProjects();
  const block = document.createElement('div');
  block.className = 'gm-project-block' + (depth > 0 ? ' gm-project-sub' : '') + (collapsed.has(proj.id) ? ' gm-project-collapsed' : '');
  const openItems = (proj.items || []).filter(i => !i.done);
  const children = pProjects.filter(p => p.parent_id === proj.id);
  const titleSize = depth === 0 ? '1.5rem' : depth === 1 ? '1.15rem' : '1rem';
  block.innerHTML = `
    <div class="gm-project-titlebar">
      <span class="gm-project-chevron">▾</span>
      <span class="gm-project-title" style="font-size:${titleSize};">${escapeHtml(proj.name)}</span>
      <input type="date" class="pDeadlineInput" value="${escapeHtml(proj.deadline || '')}" title="Deadline">
      <span class="badge">${proj.status === 'done' ? 'Done' : 'Active'}</span>
      <div class="gm-project-actions">
        <button class="gm-conn-del" data-add-sub="${proj.id}">+ Sub</button>
        <button class="gm-conn-del" data-toggle-done="${proj.id}">${proj.status === 'done' ? '↺ Reopen' : '✓ Done'}</button>
        <button class="gm-conn-del" data-del-project="${proj.id}">Delete</button>
      </div>
    </div>
    <div class="gm-project-content">
      ${proj.description ? `<div class="admin-note" style="margin:0.3rem 0 0.6rem;">${escapeHtml(proj.description)}</div>` : ''}
      <div class="project-items"></div>
      <div class="add-row">
        <input type="text" class="newItemInput" placeholder="Add a to-do…">
        <button class="composer-submit addItemBtn">Add</button>
      </div>
      <div class="gm-subprojects"></div>
    </div>
  `;
  const itemsEl = block.querySelector('.project-items');
  if (!openItems.length) {
    itemsEl.innerHTML = '<div class="placeholder-note">No to-dos yet.</div>';
  } else {
    openItems.forEach(item => {
      const row = document.createElement('div');
      row.className = 'todo-row';
      row.innerHTML = `<input type="checkbox"> <span>${escapeHtml(item.text)}</span>`;
      row.querySelector('input').addEventListener('change', async () => { item.done = true; await saveProjects(); renderProjectCards(); });
      itemsEl.appendChild(row);
    });
  }
  block.querySelector('.gm-project-titlebar').addEventListener('click', e => {
    if (e.target.closest('.gm-project-actions') || e.target.classList.contains('pDeadlineInput')) return;
    block.classList.toggle('gm-project-collapsed');
    const c = getCollapsedProjects();
    if (block.classList.contains('gm-project-collapsed')) c.add(proj.id); else c.delete(proj.id);
    setCollapsedProjects(c);
  });
  block.querySelector('.addItemBtn').addEventListener('click', async () => {
    const input = block.querySelector('.newItemInput');
    const text = input.value.trim();
    if (!text) return;
    (proj.items = proj.items || []).push({ id: 'item-' + Date.now(), text, done: false });
    await saveProjects(); renderProjectCards();
  });
  block.querySelector('.newItemInput').addEventListener('keydown', e => { if (e.key === 'Enter') block.querySelector('.addItemBtn').click(); });
  block.querySelector('.pDeadlineInput').addEventListener('click', e => e.stopPropagation());
  block.querySelector('.pDeadlineInput').addEventListener('change', async e => { proj.deadline = e.target.value; await saveProjects(); });
  block.querySelector('[data-toggle-done]').addEventListener('click', async e => {
    e.stopPropagation();
    proj.status = proj.status === 'done' ? 'active' : 'done';
    await saveProjects(); renderProjectCards();
  });
  block.querySelector('[data-del-project]').addEventListener('click', async e => {
    e.stopPropagation();
    const descendants = collectDescendantIds(proj.id);
    const msg = descendants.length ? `Delete this project and its ${descendants.length} sub-project(s)?` : 'Delete this project?';
    if (!confirm(msg)) return;
    const toRemove = new Set([proj.id, ...descendants]);
    pProjects = pProjects.filter(p => !toRemove.has(p.id));
    await saveProjects(); renderProjectCards();
  });
  block.querySelector('[data-add-sub]').addEventListener('click', e => {
    e.stopPropagation();
    openNewProjectForm(proj.id);
  });

  const subContainer = block.querySelector('.gm-subprojects');
  children.forEach(child => subContainer.appendChild(buildProjectBlock(child, depth + 1)));
  return block;
}

function flattenProjectsForParentSelect(excludeId) {
  const result = [];
  function walk(parentId, depth) {
    pProjects.filter(p => (p.parent_id || null) === parentId && p.id !== excludeId).forEach(p => {
      result.push({ id: p.id, label: '　'.repeat(depth) + (depth > 0 ? '↳ ' : '') + p.name });
      walk(p.id, depth + 1);
    });
  }
  walk(null, 0);
  return result;
}

function openNewProjectForm(presetParentId) {
  const sel = document.getElementById('npParent');
  sel.innerHTML = '<option value="">— Top-level project —</option>' +
    flattenProjectsForParentSelect(null).map(p => `<option value="${p.id}">${escapeHtml(p.label)}</option>`).join('');
  sel.value = presetParentId || '';
  document.getElementById('newProjectForm').classList.add('open');
  document.getElementById('npName').focus();
}

function wireProjectsControls() {
  document.getElementById('newProjectToggleBtn').addEventListener('click', () => {
    const form = document.getElementById('newProjectForm');
    if (form.classList.contains('open')) { form.classList.remove('open'); return; }
    openNewProjectForm(null);
  });
  document.getElementById('npCancelBtn').addEventListener('click', () => document.getElementById('newProjectForm').classList.remove('open'));
  document.getElementById('npCreateBtn').addEventListener('click', createProject);
}
async function createProject() {
  const name = document.getElementById('npName').value.trim();
  if (!name) return;
  pProjects.push({
    id: 'proj-' + Date.now(), name,
    description: document.getElementById('npDescription').value.trim(),
    deadline: document.getElementById('npDeadline').value || null,
    parent_id: document.getElementById('npParent').value || null,
    status: 'active', items: [], created_at: new Date().toISOString(),
  });
  await saveProjects();
  document.getElementById('npName').value = '';
  document.getElementById('npDescription').value = '';
  document.getElementById('npDeadline').value = '';
  document.getElementById('newProjectForm').classList.remove('open');
  renderProjectCards();
}

// ── Member Network — guild-wide, real signups + onboarding data ──────────
// Distinct from the Guild Map: this is shared data (any Ringleader sees the
// same graph), not a private per-user canvas.
const NETWORK_CHAPTER_PALETTE = ['#9B3036', '#C8A05A', '#74B9FF', '#40E0D0', '#B388FF', '#FFA94D', '#90A4AE', '#DFBE7D'];
let nwChaptersCache = [];
function nwChapterColor(chapterId) {
  const idx = nwChaptersCache.findIndex(c => c.id === chapterId);
  return NETWORK_CHAPTER_PALETTE[idx >= 0 ? idx % NETWORK_CHAPTER_PALETTE.length : NETWORK_CHAPTER_PALETTE.length - 1];
}
function daysUntilNextBirthday(birthday) {
  if (!birthday) return Infinity;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [, m, d] = birthday.split('-').map(Number);
  let next = new Date(today.getFullYear(), m - 1, d);
  if (next < today) next = new Date(today.getFullYear() + 1, m - 1, d);
  return Math.round((next - today) / 86400000);
}

async function renderNetworkView(mainView) {
  if (!profile?.is_ringleader) {
    mainView.innerHTML = `<h2>Not authorized</h2><div class="placeholder-note">Ringleaders only.</div>`;
    return;
  }
  mainView.innerHTML = `
    <h2>Member Network</h2>
    <p class="admin-note">Who knows who across the guild — pulled from real signups and onboarding. Not private like the Guild Map; any Ringleader sees this same graph.</p>
    <div id="nwBirthdays"></div>
    <div class="gm-shell" style="height:70vh;">
      <div class="gm-body">
        <svg id="nwSvg"></svg>
        <div class="gm-legend" id="nwLegend"></div>
        <div class="gm-panel" id="nwPanel">
          <div class="gm-panel-header">
            <div class="gm-panel-dot" id="nwPanelDot"></div>
            <div id="nwPanelName" class="gm-panel-name"></div>
            <button class="gm-panel-close" id="nwPanelClose">&times;</button>
          </div>
          <div class="gm-panel-body" id="nwPanelBody"></div>
        </div>
      </div>
    </div>
  `;

  const [{ members, connections }, { chapters: chapterData }] = await Promise.all([
    apiFetch('/api/network'),
    apiFetch('/api/chapters'),
  ]);
  nwChaptersCache = chapterData || [];

  const soonBirthdays = members.filter(m => m.birthday && daysUntilNextBirthday(m.birthday) <= 7).sort((a, b) => daysUntilNextBirthday(a.birthday) - daysUntilNextBirthday(b.birthday));
  document.getElementById('nwBirthdays').innerHTML = soonBirthdays.length ? `
    <div class="card" style="border-color:var(--gold);">
      <div style="font-family:'Playfair Display',serif;font-style:italic;color:var(--gold-bright);margin-bottom:0.5rem;">🎂 Birthdays This Week</div>
      ${soonBirthdays.map(m => {
        const days = daysUntilNextBirthday(m.birthday);
        const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
        return `<div style="font-size:0.9rem;color:var(--cream-soft);">${escapeHtml(m.display_name)} — ${when}</div>`;
      }).join('')}
    </div>
  ` : '';

  document.getElementById('nwLegend').innerHTML = `
    <h4>Chapter</h4>
    ${nwChaptersCache.map(c => `<div class="gm-legend-row"><span class="gm-legend-dot" style="background:${nwChapterColor(c.id)}"></span>${escapeHtml(c.name)}</div>`).join('')}
  `;

  if (!members.length) {
    document.querySelector('#nwSvg').closest('.gm-body').innerHTML = '<div class="gm-empty-note">No members yet.</div>';
    return;
  }

  const svgEl = document.getElementById('nwSvg');
  const W = svgEl.clientWidth || 900, H = svgEl.clientHeight || 600;
  const svg = d3.select('#nwSvg').attr('viewBox', `0 0 ${W} ${H}`);
  const zg = svg.append('g');
  svg.call(d3.zoom().scaleExtent([0.2, 3]).on('zoom', e => zg.attr('transform', e.transform)));

  const nodes = members.map(m => ({ ...m }));
  const nodeById = Object.fromEntries(nodes.map(n => [n.id, n]));
  const links = connections.filter(c => nodeById[c.from] && nodeById[c.to]).map(c => ({ source: c.from, target: c.to }));

  const linksG = zg.append('g'), nodesG = zg.append('g');
  const linkSel = linksG.selectAll('line').data(links).join('line').attr('stroke', 'rgba(200,160,90,0.35)').attr('stroke-width', 1.3);

  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(90).strength(0.6))
    .force('charge', d3.forceManyBody().strength(-180))
    .force('center', d3.forceCenter(W / 2, H / 2))
    .force('collide', d3.forceCollide(28));

  const drag = d3.drag()
    .on('start', (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
    .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
    .on('end', (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; });

  const nodeSel = nodesG.selectAll('.gm-node-group').data(nodes).join(enter => {
    const ng = enter.append('g').attr('class', 'gm-node-group').call(drag).on('click', (e, d) => { e.stopPropagation(); openNetworkPanel(d); });
    ng.append('circle').attr('class', 'gm-node-circle').attr('r', 8);
    ng.append('text').attr('class', 'gm-node-label').attr('y', 20);
    return ng;
  });
  nodeSel.select('.gm-node-circle').attr('fill', d => nwChapterColor(d.home_chapter_id)).attr('fill-opacity', 0.85).attr('stroke', d => nwChapterColor(d.home_chapter_id));
  nodeSel.select('.gm-node-label').text(d => d.display_name);

  sim.on('tick', () => {
    linkSel.attr('x1', d => d.source.x).attr('y1', d => d.source.y).attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    nodeSel.attr('transform', d => `translate(${d.x},${d.y})`);
  });

  svg.on('click', () => document.getElementById('nwPanel').classList.remove('open'));
  document.getElementById('nwPanelClose').addEventListener('click', () => document.getElementById('nwPanel').classList.remove('open'));

  function openNetworkPanel(m) {
    document.getElementById('nwPanelDot').style.background = nwChapterColor(m.home_chapter_id);
    document.getElementById('nwPanelName').textContent = m.display_name;
    document.getElementById('nwPanelBody').innerHTML = `
      <label>Chapter</label><div>${escapeHtml(m.home_chapter?.name || 'None')}</div>
      <label>Rank</label><div>${escapeHtml((m.is_ringleader ? 'Ringleader' : m.rank.charAt(0).toUpperCase() + m.rank.slice(1)))}</div>
      ${m.birthday ? `<label>Birthday</label><div>${escapeHtml(new Date(m.birthday + 'T00:00:00').toLocaleDateString(undefined, { month: 'long', day: 'numeric' }))}</div>` : ''}
      ${(m.skills || []).length ? `<label>Skills</label><div>${escapeHtml(m.skills.join(', '))}</div>` : ''}
    `;
    document.getElementById('nwPanel').classList.add('open');
  }
}

// ── Meetings — guild-wide run-of-show docs, Ringleaders only ────────────
async function renderMeetingsView(mainView) {
  if (!profile?.is_ringleader) {
    mainView.innerHTML = `<h2>Not authorized</h2><div class="placeholder-note">Ringleaders only.</div>`;
    return;
  }
  mainView.innerHTML = `<h2>Meetings</h2><div class="placeholder-note">Loading…</div>`;

  const { meetings } = await apiFetch('/api/meetings');
  const list = meetings || [];
  let activeId = list[0]?.id || null;
  let editing = false;

  mainView.innerHTML = `
    <div class="projects-layout">
      <div class="leadership-docs-col" style="min-width:200px;">
        <div class="ld-header">
          <span>Meetings</span>
          <button class="ld-add-btn" id="mtAddBtn" title="Add a meeting doc">+ New</button>
        </div>
        <div class="ld-tabs" id="mtTabs" style="flex-direction:column;"></div>
      </div>
      <div class="projects-main">
        <div id="mtContent" class="meeting-content-card"></div>
      </div>
    </div>
    <div class="gm-overlay" id="mtAddOverlay">
      <div class="gm-modal">
        <div class="gm-modal-header"><h3>New Meeting Doc</h3><button id="mtAddClose">&times;</button></div>
        <div class="gm-modal-body">
          <div class="field-row"><label>Title</label><input type="text" id="mtNewTitle" placeholder="e.g. Meeting 3 — Sign Painting"></div>
        </div>
        <div class="gm-modal-footer">
          <button class="gm-btn" id="mtNewCancel">Cancel</button>
          <button class="composer-submit" id="mtNewSave">Create</button>
        </div>
      </div>
    </div>
  `;

  const tabsEl = document.getElementById('mtTabs');
  const contentEl = document.getElementById('mtContent');

  function renderTabs() {
    tabsEl.innerHTML = list.map(m => `<button class="ld-tab ${m.id === activeId ? 'active' : ''}" data-meeting="${m.id}">${escapeHtml(m.title)}</button>`).join('');
    tabsEl.querySelectorAll('.ld-tab').forEach(t => t.addEventListener('click', () => { activeId = t.dataset.meeting; editing = false; renderTabs(); renderContent(); }));
  }

  function renderContent() {
    const doc = list.find(m => m.id === activeId);
    if (!doc) { contentEl.innerHTML = '<div class="placeholder-note">No meeting docs yet. Use "+ New" to add one.</div>'; return; }
    if (editing) {
      contentEl.innerHTML = `
        <div class="post-actions" style="margin-bottom:0.6rem;">
          <button class="composer-submit" id="mtSaveBtn">Save</button>
          <button class="gm-btn" id="mtCancelEditBtn">Cancel</button>
        </div>
        <textarea id="mtEditContent" rows="24" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:3px;padding:0.7rem;color:var(--cream);font-family:inherit;">${escapeHtml(doc.content)}</textarea>
      `;
      document.getElementById('mtSaveBtn').addEventListener('click', async () => {
        const content = document.getElementById('mtEditContent').value;
        await apiFetch(`/api/meetings/${doc.id}`, { method: 'PATCH', body: { content } });
        doc.content = content;
        editing = false;
        renderContent();
      });
      document.getElementById('mtCancelEditBtn').addEventListener('click', () => { editing = false; renderContent(); });
      return;
    }
    contentEl.innerHTML = `
      <div class="post-actions" style="margin-bottom:0.6rem;">
        <button class="action-btn" id="mtEditBtn">Edit</button>
        <button class="action-btn danger" id="mtDeleteBtn">Delete</button>
      </div>
      ${renderMarkdown(doc.content || '*Empty — click Edit to add content.*')}
    `;
    document.getElementById('mtEditBtn').addEventListener('click', () => { editing = true; renderContent(); });
    document.getElementById('mtDeleteBtn').addEventListener('click', async () => {
      if (!confirm(`Delete "${doc.title}"?`)) return;
      await apiFetch(`/api/meetings/${doc.id}`, { method: 'DELETE' });
      const idx = list.findIndex(m => m.id === doc.id);
      list.splice(idx, 1);
      activeId = list[0]?.id || null;
      renderTabs();
      renderContent();
    });
  }

  renderTabs();
  renderContent();

  document.getElementById('mtAddBtn').addEventListener('click', () => document.getElementById('mtAddOverlay').classList.add('open'));
  document.getElementById('mtAddClose').addEventListener('click', () => document.getElementById('mtAddOverlay').classList.remove('open'));
  document.getElementById('mtNewCancel').addEventListener('click', () => document.getElementById('mtAddOverlay').classList.remove('open'));
  document.getElementById('mtNewSave').addEventListener('click', async () => {
    const title = document.getElementById('mtNewTitle').value.trim();
    if (!title) return;
    const { id } = await apiFetch('/api/meetings', { method: 'POST', body: { title, content: '' } });
    list.push({ id, title, content: '' });
    activeId = id;
    editing = true;
    document.getElementById('mtNewTitle').value = '';
    document.getElementById('mtAddOverlay').classList.remove('open');
    renderTabs();
    renderContent();
  });
}

// ── Hub == Crew Hub ──────────────────────────────────────────────────────
// The Hub *is* the crew hub — one page, event picker and countdown always
// visible at the top, tabs underneath for Schedule/Meetups/Games/Events/
// Projects/Materials. No separate overview page: a general "what's
// upcoming guild-wide" view already exists at the Events nav link, so this
// page stays focused on whichever event you're currently working.
const RSVP_RESPONSES = [['yes', 'Yes'], ['maybe', 'Maybe'], ['no', "Can't make it"]];

const CREW_TABS = [
  ['overview', 'Overview'],
  ['meetups', 'Meetups'],
  ['activities', 'Games & Events'],
  ['merch', 'Merch'],
  ['signs', 'Signs'],
  ['raffle', 'Raffle'],
  ['projects', 'Required Builds'],
  ['materials', 'Materials'],
  ['lore', 'Carny Code'],
];

let crewHubCountdownTimer = null;

async function renderCrewTabs(mainView, activeTab) {
  if (crewHubCountdownTimer) { clearInterval(crewHubCountdownTimer); crewHubCountdownTimer = null; }

  if (!crewEvents.length) {
    mainView.innerHTML = `<h2>Hub</h2><div class="placeholder-note">You're not on a crew for an upcoming event. Check <a href="#/events">Events</a> for what's coming up guild-wide.</div>`;
    return;
  }
  const evt = myCrewEvent();

  mainView.innerHTML = `
    <div class="crew-hub-header">
      ${crewEvents.length > 1 ? `
      <select class="crew-event-switch" id="crewEventSwitch">
        ${crewEvents.map(e => `<option value="${e.id}" ${e.id === evt.id ? 'selected' : ''}>${escapeHtml(e.title)}</option>`).join('')}
      </select>` : `<h2>${escapeHtml(evt.title)}</h2>`}
      <div class="hub-countdown-big" id="crewHubCountdownValue">—</div>
    </div>
    <div class="crew-tabs">
      ${CREW_TABS.map(([key, label]) => `<a class="crew-tab ${activeTab === key ? 'active' : ''}" href="#/crew/${key}">${label}</a>`).join('')}
    </div>
    <div id="crewTabBody"><div class="placeholder-note">Loading…</div></div>
  `;

  const crewSwitch = document.getElementById('crewEventSwitch');
  if (crewSwitch) {
    crewSwitch.addEventListener('change', () => {
      activeCrewEventId = crewSwitch.value;
      renderMainView(currentRoute());
    });
  }

  const target = new Date(evt.starts_at).getTime();
  const countdownEl = document.getElementById('crewHubCountdownValue');
  const tick = () => {
    const diff = target - Date.now();
    if (diff <= 0) { countdownEl.textContent = "It's here!"; return; }
    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    countdownEl.innerHTML = `<span class="cd-num">${days}</span>d <span class="cd-num">${hours}</span>h <span class="cd-num">${mins}</span>m`;
  };
  tick();
  crewHubCountdownTimer = setInterval(tick, 60000);

  const body = document.getElementById('crewTabBody');
  if (activeTab === 'overview') return renderCrewOverviewView(body);
  if (activeTab === 'meetups') return renderCrewMeetupsView(body);
  if (activeTab === 'activities') return renderCrewActivitiesView(body);
  if (activeTab === 'merch') return renderCrewMerchView(body);
  if (activeTab === 'signs') return renderCrewSignsView(body);
  if (activeTab === 'raffle') return renderCrewRaffleView(body);
  if (activeTab === 'projects') return renderCrewProjectsView(body);
  if (activeTab === 'materials') return renderCrewMaterialsView(body);
  if (activeTab === 'lore') return renderCrewLoreView(body);
}

// ── Crew: Overview (summary of every other tab, with links out) ─────────
async function renderCrewOverviewView(mainView) {
  const evt = myCrewEvent();
  mainView.innerHTML = `<div class="placeholder-note">Loading…</div>`;

  const [{ meetups }, { activities }, { projects }, { materials }, { merch }, { signs }, { raffle }] = await Promise.all([
    apiFetch(`/api/events/${evt.id}/meetups`),
    apiFetch(`/api/events/${evt.id}/activities`),
    apiFetch(`/api/events/${evt.id}/projects`),
    apiFetch(`/api/events/${evt.id}/materials`),
    apiFetch(`/api/events/${evt.id}/merch`),
    apiFetch(`/api/events/${evt.id}/signs`),
    apiFetch(`/api/events/${evt.id}/raffle`),
  ]);

  const games = (activities || []).filter(a => a.kind === 'game');
  const events = (activities || []).filter(a => a.kind === 'event');
  const nextUp = (activities || [])
    .filter(a => a.starts_at && new Date(a.starts_at).getTime() >= Date.now())
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))[0];

  const openProjects = (projects || []).filter(p => p.status !== 'done');
  const needs = (materials || []).filter(m => m.category !== 'want');
  const wants = (materials || []).filter(m => m.category === 'want');
  const activityNames = {};
  (activities || []).forEach(a => { activityNames[a.id] = a.name; });

  const myTasks = [
    ...games.map(a => ({ ...a, _type: 'Game' })),
    ...events.map(a => ({ ...a, _type: 'Event' })),
    ...(merch || []).map(m => ({ ...m, _type: 'Merch' })),
    ...(signs || []).map(s => ({ ...s, _type: 'Sign' })),
    ...(raffle || []).map(r => ({ ...r, _type: 'Raffle' })),
  ].filter(x => x.assignee_id === profile.id);

  const overviewAssignedList = (items, emptyText) => items.length
    ? `<ul class="hub-todo-list">${items.map(m => `
        <li>${escapeHtml(m.name)} <span class="activity-status-tag ${m.status}">${m.status === 'locked_in' ? 'Locked In' : 'Proposed'}</span> <span class="hub-todo-deadline">— ${m.assignee_name ? escapeHtml(m.assignee_name) : 'unassigned'}</span></li>
      `).join('')}</ul>`
    : `<div class="placeholder-note">${emptyText}</div>`;

  const overviewMaterialsList = items => items.length
    ? `<ul class="overview-materials-list">${items.map(m => `
        <li>${escapeHtml(m.item)}${m.activity_id && activityNames[m.activity_id] ? ` <span class="materials-source-tag">${escapeHtml(activityNames[m.activity_id])}</span>` : ''}</li>
      `).join('')}</ul>`
    : '<div class="placeholder-note">Nothing listed yet.</div>';

  const meetupsHtml = (meetups || []).length ? meetups.map(m => {
    const mine = (m.rsvps || []).find(r => r.user_id === profile.id);
    return `
      <div class="overview-meetup">
        <div class="post-title">${formatEventDate(m.proposed_at)} <span class="meetup-category-tag ${m.category}">${m.category === 'field_trip' ? 'Field Trip' : 'Meeting'}</span></div>
        <div class="post-meta">${m.location ? escapeHtml(m.location) : 'No place set yet'}</div>
        ${mine ? `<div class="post-meta">Your RSVP: <strong>${escapeHtml(mine.response)}</strong></div>` : `
        <div class="rsvp-row">
          ${RSVP_RESPONSES.map(([val, label]) => `<button class="rsvp-btn" data-rsvp="${m.id}" data-response="${val}">${label}</button>`).join('')}
        </div>`}
      </div>
    `;
  }).join('') : '<div class="placeholder-note">No meetups proposed yet.</div>';

  mainView.innerHTML = `
    <div class="overview-layout">
      <div class="overview-main">
        <div class="card overview-card activity-color-4">
          <h3 class="section-heading">My Tasks</h3>
          ${myTasks.length ? `<ul class="hub-todo-list">${myTasks.map(x => `
            <li>${escapeHtml(x.name)} <span class="activity-status-tag ${x.status}">${x.status === 'locked_in' ? 'Locked In' : 'Proposed'}</span> <span class="hub-todo-deadline">— ${x._type}</span></li>
          `).join('')}</ul>` : '<div class="placeholder-note">Nothing assigned to you yet.</div>'}
        </div>
        <div class="card overview-card activity-color-0">
          <h3 class="section-heading">Next Up</h3>
          ${nextUp ? `
            <div class="post-title">${escapeHtml(nextUp.name)}</div>
            <div class="post-meta">${formatEventDate(nextUp.starts_at)}${nextUp.location ? ' · ' + escapeHtml(nextUp.location) : ''}</div>
          ` : '<div class="placeholder-note">Nothing time-slotted yet.</div>'}
          <div class="post-actions"><a class="action-btn" href="#/crew/activities">View all</a></div>
        </div>
        <div class="card overview-card activity-color-3">
          <h3 class="section-heading">Meetups</h3>
          ${meetupsHtml}
          <div class="post-actions"><a class="action-btn" href="#/crew/meetups">View all</a></div>
        </div>
        <div class="card overview-card activity-color-2">
          <h3 class="section-heading">Things We're Doing</h3>
          ${openProjects.length ? `<ul class="hub-todo-list">${openProjects.slice(0, 6).map(p => `
            <li>${escapeHtml(p.name)}${p.deadline ? ` <span class="hub-todo-deadline">— due ${escapeHtml(p.deadline)}</span>` : ''}</li>
          `).join('')}</ul>` : '<div class="placeholder-note">No open projects.</div>'}
          <div class="post-actions"><a class="action-btn" href="#/crew/projects">View all</a></div>
        </div>
        <div class="card overview-card activity-color-5">
          <h3 class="section-heading">Games &amp; Events</h3>
          <h4 class="overview-materials-heading">Games</h4>
          ${games.length ? `<ul class="hub-todo-list">${games.map(a => `
            <li>${escapeHtml(a.name)} <span class="activity-status-tag ${a.status}">${a.status === 'locked_in' ? 'Locked In' : 'Proposed'}</span> <span class="hub-todo-deadline">— ${a.assignee_name ? escapeHtml(a.assignee_name) : 'unassigned'}</span></li>
          `).join('')}</ul>` : '<div class="placeholder-note">No games yet.</div>'}
          <h4 class="overview-materials-heading">Events</h4>
          ${events.length ? `<ul class="hub-todo-list">${events.map(a => `
            <li>${escapeHtml(a.name)}${a.starts_at ? ` <span class="hub-todo-deadline">— ${formatEventDate(a.starts_at)}</span>` : ''} <span class="activity-status-tag ${a.status}">${a.status === 'locked_in' ? 'Locked In' : 'Proposed'}</span> <span class="hub-todo-deadline">— ${a.assignee_name ? escapeHtml(a.assignee_name) : 'unassigned'}</span></li>
          `).join('')}</ul>` : '<div class="placeholder-note">No events yet.</div>'}
          <div class="post-actions"><a class="action-btn" href="#/crew/activities">View all</a></div>
        </div>
        <div class="card overview-card activity-color-1">
          <h3 class="section-heading">Merch &amp; Signs</h3>
          <h4 class="overview-materials-heading">Merch</h4>
          ${overviewAssignedList(merch || [], 'Nothing listed yet.')}
          <div class="post-actions"><a class="action-btn" href="#/crew/merch">View all</a></div>
          <h4 class="overview-materials-heading">Signs</h4>
          ${overviewAssignedList(signs || [], 'Nothing listed yet.')}
          <div class="post-actions"><a class="action-btn" href="#/crew/signs">View all</a></div>
        </div>
        <div class="card overview-card activity-color-3">
          <h3 class="section-heading">Raffle</h3>
          ${overviewAssignedList(raffle || [], 'Nothing listed yet.')}
          <div class="post-actions"><a class="action-btn" href="#/crew/raffle">View all</a></div>
        </div>
      </div>
      <div class="card overview-materials-col activity-color-4">
        <h3 class="section-heading">Materials</h3>
        <h4 class="overview-materials-heading">Needs</h4>
        ${overviewMaterialsList(needs)}
        <h4 class="overview-materials-heading">Wants</h4>
        ${overviewMaterialsList(wants)}
        <div class="post-actions"><a class="action-btn" href="#/crew/materials">View all</a></div>
      </div>
    </div>
  `;

  mainView.querySelectorAll('[data-rsvp]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await apiFetch(`/api/meetups/${btn.dataset.rsvp}/rsvp`, { method: 'PUT', body: { response: btn.dataset.response } });
      renderCrewOverviewView(mainView);
    });
  });
}

// ── Crew: Meetups (planning sessions, RSVP + place) ─────────────────────
async function renderCrewMeetupsView(mainView) {
  const evt = myCrewEvent();
  mainView.innerHTML = `<div class="placeholder-note">Loading…</div>`;

  const { meetups } = await apiFetch(`/api/events/${evt.id}/meetups`);

  const listHtml = (meetups || []).length ? `<div class="post-list">${meetups.map(m => {
    const mine = (m.rsvps || []).find(r => r.user_id === profile.id);
    return `
    <div class="post-card meetup-card meetup-category-${m.category}" style="cursor:default;">
      <div class="post-title">${formatEventDate(m.proposed_at)} <span class="meetup-category-tag ${m.category}">${m.category === 'field_trip' ? 'Field Trip' : 'Meeting'}</span></div>
      <div class="post-meta">${m.location ? escapeHtml(m.location) : 'No place set yet'}</div>
      ${m.notes ? `<div class="post-snippet">${escapeHtml(m.notes)}</div>` : ''}
      <div class="rsvp-row">
        ${RSVP_RESPONSES.map(([val, label]) => `<button class="rsvp-btn ${mine?.response === val ? 'active' : ''}" data-rsvp="${m.id}" data-response="${val}">${label}</button>`).join('')}
      </div>
      <div class="crew-roster">
        ${(m.rsvps || []).map(r => `<span class="crew-chip rsvp-chip rsvp-${r.response}">${escapeHtml(r.display_name)}</span>`).join('') || '<span class="placeholder-note" style="border:none;padding:0;">No responses yet.</span>'}
      </div>
      <div class="post-actions"><button class="action-btn danger" data-delete-meetup="${m.id}">Remove</button></div>
    </div>
  `; }).join('')}</div>` : '<div class="placeholder-note">No meetups proposed yet.</div>';

  mainView.innerHTML = `
    <div class="meetups-columns">
      <div class="meetups-column">
        <h3 class="section-heading">Proposed</h3>
        ${listHtml}
      </div>
      <div class="meetups-column">
        <h3 class="section-heading">Propose a Meetup</h3>
        <div class="card">
          <form class="composer" id="meetupComposer">
            <input type="datetime-local" id="mtProposed" required>
            <select id="mtCategory">
              <option value="meeting">Meeting</option>
              <option value="field_trip">Field Trip</option>
            </select>
            <input type="text" id="mtLocation" placeholder="Place">
            <textarea id="mtNotes" placeholder="Notes"></textarea>
            <button type="submit" class="composer-submit">Propose Meetup</button>
          </form>
        </div>
      </div>
    </div>
  `;

  document.getElementById('meetupComposer').addEventListener('submit', async e => {
    e.preventDefault();
    const proposed = document.getElementById('mtProposed').value;
    if (!proposed) return;
    await apiFetch(`/api/events/${evt.id}/meetups`, {
      method: 'POST',
      body: {
        proposed_at: new Date(proposed).toISOString(),
        category: document.getElementById('mtCategory').value,
        location: document.getElementById('mtLocation').value.trim() || null,
        notes: document.getElementById('mtNotes').value.trim() || null,
      },
    });
    renderCrewMeetupsView(mainView);
  });

  mainView.querySelectorAll('[data-rsvp]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await apiFetch(`/api/meetups/${btn.dataset.rsvp}/rsvp`, { method: 'PUT', body: { response: btn.dataset.response } });
      renderCrewMeetupsView(mainView);
    });
  });

  mainView.querySelectorAll('[data-delete-meetup]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await apiFetch(`/api/events/${evt.id}/meetups/${btn.dataset.deleteMeetup}`, { method: 'DELETE' });
      renderCrewMeetupsView(mainView);
    });
  });
}

// ── Crew: Projects (shared, nested — modeled on the Ringleader private
// Projects UI, but multi-editor: every field auto-saves via row-level PATCH
// instead of one whole-blob PUT, so 8 people editing at once don't clobber
// each other) ────────────────────────────────────────────────────────────
let cpEventId = null;
let cpProjects = [];

async function renderCrewProjectsView(mainView) {
  const evt = myCrewEvent();
  cpEventId = evt.id;
  mainView.innerHTML = `<div class="placeholder-note">Loading…</div>`;

  const { projects } = await apiFetch(`/api/events/${evt.id}/projects`);
  cpProjects = projects || [];

  mainView.innerHTML = `
    <div class="projects-toolbar"><button class="gm-btn" id="newCpToggleBtn" style="background:var(--surface);color:var(--cream);">+ New Required Build</button></div>
    <div class="card new-project-form" id="newCpForm">
      <div class="field-row"><label>Name</label><input type="text" id="cpName" placeholder="e.g. Sound Setup"></div>
      <div class="field-row"><label>Description</label><input type="text" id="cpDescription" placeholder="One line"></div>
      <div class="field-row"><label>Deadline</label><input type="date" id="cpDeadline"></div>
      <div class="form-actions">
        <button class="composer-submit" id="cpCreateBtn">Create</button>
        <button class="gm-btn" id="cpCancelBtn" style="background:var(--surface);color:var(--cream);">Cancel</button>
      </div>
    </div>
    <div id="cpList"></div>
  `;

  renderCpCards();

  document.getElementById('newCpToggleBtn').addEventListener('click', () => document.getElementById('newCpForm').classList.toggle('open'));
  document.getElementById('cpCancelBtn').addEventListener('click', () => document.getElementById('newCpForm').classList.remove('open'));
  document.getElementById('cpCreateBtn').addEventListener('click', async () => {
    const name = document.getElementById('cpName').value.trim();
    if (!name) return;
    await apiFetch(`/api/events/${cpEventId}/projects`, {
      method: 'POST',
      body: {
        name,
        description: document.getElementById('cpDescription').value.trim() || null,
        deadline: document.getElementById('cpDeadline').value || null,
      },
    });
    await reloadCpProjects();
  });
}

async function reloadCpProjects() {
  const { projects } = await apiFetch(`/api/events/${cpEventId}/projects`);
  cpProjects = projects || [];
  renderCpCards();
}

function renderCpCards() {
  const listEl = document.getElementById('cpList');
  const top = cpProjects.filter(p => !p.parent_id);
  if (!top.length) { listEl.innerHTML = '<div class="placeholder-note">No required builds yet. Use "+ New Required Build" above.</div>'; return; }
  listEl.innerHTML = '';
  top.forEach(proj => {
    const card = document.createElement('div');
    card.className = 'card gm-project-window';
    card.appendChild(buildCpBlock(proj, 0));
    listEl.appendChild(card);
  });
}

function buildCpBlock(proj, depth) {
  const block = document.createElement('div');
  block.className = 'gm-project-block' + (depth > 0 ? ' gm-project-sub' : '');
  const children = cpProjects.filter(p => p.parent_id === proj.id);
  const titleSize = depth === 0 ? '1.5rem' : depth === 1 ? '1.15rem' : '1rem';
  block.innerHTML = `
    <div class="gm-project-titlebar">
      <span class="gm-project-title" style="font-size:${titleSize};">${escapeHtml(proj.name)}</span>
      <select class="cp-status-select" data-project="${proj.id}">
        <option value="not_started" ${proj.status === 'not_started' ? 'selected' : ''}>Not started</option>
        <option value="in_progress" ${proj.status === 'in_progress' ? 'selected' : ''}>In progress</option>
        <option value="done" ${proj.status === 'done' ? 'selected' : ''}>Done</option>
      </select>
      <input type="date" class="cp-deadline-input" data-project="${proj.id}" value="${escapeHtml(proj.deadline || '')}" title="Deadline">
      <div class="gm-project-actions">
        <button class="gm-btn" data-cp-subproject="${proj.id}">+ Sub-build</button>
        <button class="gm-btn gm-danger" data-cp-delete="${proj.id}">Delete</button>
      </div>
    </div>
    <div class="gm-project-content">
      ${proj.description ? `<div class="post-snippet">${escapeHtml(proj.description)}</div>` : ''}
      <ul class="cp-item-list" data-project-items="${proj.id}">
        ${(proj.items || []).map(it => `
          <li class="cp-item ${it.done ? 'cp-item-done' : ''}">
            <label><input type="checkbox" data-cp-item-toggle="${it.id}" data-project="${proj.id}" ${it.done ? 'checked' : ''}> ${escapeHtml(it.text)}</label>
            <button class="crew-chip-remove" data-cp-item-delete="${it.id}" data-project="${proj.id}" title="Remove">&times;</button>
          </li>
        `).join('')}
      </ul>
      <form class="cp-item-add" data-project="${proj.id}">
        <input type="text" placeholder="Add checklist item…" required>
        <button type="submit" class="gm-btn">Add</button>
      </form>
      <div class="cp-children"></div>
    </div>
  `;

  block.querySelector('.cp-status-select').addEventListener('change', async e => {
    await apiFetch(`/api/events/${cpEventId}/projects/${proj.id}`, { method: 'PATCH', body: { status: e.target.value } });
    await reloadCpProjects();
  });
  block.querySelector('.cp-deadline-input').addEventListener('change', async e => {
    await apiFetch(`/api/events/${cpEventId}/projects/${proj.id}`, { method: 'PATCH', body: { deadline: e.target.value || null } });
  });
  block.querySelector('[data-cp-subproject]').addEventListener('click', async () => {
    const name = prompt('Sub-build name?');
    if (!name) return;
    await apiFetch(`/api/events/${cpEventId}/projects`, { method: 'POST', body: { name, parent_id: proj.id } });
    await reloadCpProjects();
  });
  block.querySelector('[data-cp-delete]').addEventListener('click', async () => {
    if (!confirm(`Delete "${proj.name}"? This also deletes any sub-builds.`)) return;
    await apiFetch(`/api/events/${cpEventId}/projects/${proj.id}`, { method: 'DELETE' });
    await reloadCpProjects();
  });
  block.querySelectorAll('[data-cp-item-toggle]').forEach(cb => {
    cb.addEventListener('change', async () => {
      await apiFetch(`/api/projects/${proj.id}/items/${cb.dataset.cpItemToggle}`, { method: 'PATCH', body: { done: cb.checked } });
      await reloadCpProjects();
    });
  });
  block.querySelectorAll('[data-cp-item-delete]').forEach(x => {
    x.addEventListener('click', async () => {
      await apiFetch(`/api/projects/${proj.id}/items/${x.dataset.cpItemDelete}`, { method: 'DELETE' });
      await reloadCpProjects();
    });
  });
  block.querySelector('.cp-item-add').addEventListener('submit', async e => {
    e.preventDefault();
    const input = e.target.querySelector('input');
    const text = input.value.trim();
    if (!text) return;
    await apiFetch(`/api/projects/${proj.id}/items`, { method: 'POST', body: { text } });
    await reloadCpProjects();
  });

  const childrenEl = block.querySelector('.cp-children');
  children.forEach(child => childrenEl.appendChild(buildCpBlock(child, depth + 1)));

  return block;
}

// ── Crew: Games & Events (carnival-day attractions, one page) ───────────
// A game or event is "a thing happening," optionally at a specific
// time/place — this replaced the separate Schedule tab. Each one can carry
// its own materials list; items added here are just event_materials rows
// tagged with activity_id, so they show up in the shared Materials tab
// automatically — no separate sync step.
async function renderCrewActivitiesView(mainView) {
  const evt = myCrewEvent();
  mainView.innerHTML = `<div class="placeholder-note">Loading…</div>`;

  const [{ activities }, { materials }, { roster }] = await Promise.all([
    apiFetch(`/api/events/${evt.id}/activities`),
    apiFetch(`/api/events/${evt.id}/materials`),
    apiFetch('/api/roster'),
  ]);
  const list = activities || [];
  const materialsByActivity = {};
  (materials || []).forEach(m => {
    if (!m.activity_id) return;
    (materialsByActivity[m.activity_id] || (materialsByActivity[m.activity_id] = [])).push(m);
  });
  const assigneeOptions = unassignedLabel =>
    `<option value="">${unassignedLabel}</option>${(roster || []).map(m => `<option value="${m.id}">${escapeHtml(m.display_name)}</option>`).join('')}`;

  const addFormHtml = kind => {
    const label = kind === 'game' ? 'Game' : 'Event';
    return `
      <div class="activities-toolbar"><button class="gm-btn" id="new${label}ToggleBtn" style="background:var(--surface);color:var(--cream);">+ Add ${label}</button></div>
      <div class="card new-project-form" id="new${label}Form">
        <div class="field-row"><label>Name</label><input type="text" id="${kind}Name"></div>
        ${kind === 'game' ? `
        <div class="field-row"><label>Status</label>
          <select id="${kind}Status">
            <option value="proposed">Proposed</option>
            <option value="locked_in">Locked In</option>
          </select>
        </div>` : ''}
        ${kind === 'event' ? `
        <div class="field-row"><label>Starts</label><input type="datetime-local" id="${kind}Starts"></div>
        <div class="field-row"><label>Ends</label><input type="datetime-local" id="${kind}Ends"></div>
        <div class="field-row"><label>Location</label><input type="text" id="${kind}Location"></div>` : ''}
        <div class="field-row"><label>Details</label><input type="text" id="${kind}Description"></div>
        <div class="field-row"><label>Materials</label><input type="text" id="${kind}Materials" placeholder="Comma-separated, e.g. rope, folding table"></div>
        <div class="field-row"><label>Assigned to</label><select id="${kind}Assignee">${assigneeOptions('Unassigned')}</select></div>
        <div class="form-actions">
          <button class="composer-submit" id="${kind}CreateBtn">Add</button>
          <button class="gm-btn" id="${kind}CancelBtn" style="background:var(--surface);color:var(--cream);">Cancel</button>
        </div>
      </div>
    `;
  };

  const wireAddForm = kind => {
    const label = kind === 'game' ? 'Game' : 'Event';
    document.getElementById(`new${label}ToggleBtn`).addEventListener('click', () => document.getElementById(`new${label}Form`).classList.toggle('open'));
    document.getElementById(`${kind}CancelBtn`).addEventListener('click', () => document.getElementById(`new${label}Form`).classList.remove('open'));
    document.getElementById(`${kind}CreateBtn`).addEventListener('click', async () => {
      const name = document.getElementById(`${kind}Name`).value.trim();
      if (!name) return;
      const starts = kind === 'event' ? document.getElementById(`${kind}Starts`).value : '';
      const ends = kind === 'event' ? document.getElementById(`${kind}Ends`).value : '';
      const materials = document.getElementById(`${kind}Materials`).value.split(',').map(s => s.trim()).filter(Boolean);
      const { id: activityId } = await apiFetch(`/api/events/${evt.id}/activities`, {
        method: 'POST',
        body: {
          kind,
          name,
          description: document.getElementById(`${kind}Description`).value.trim() || null,
          starts_at: starts ? new Date(starts).toISOString() : null,
          ends_at: ends ? new Date(ends).toISOString() : null,
          location: kind === 'event' ? (document.getElementById(`${kind}Location`).value.trim() || null) : null,
          status: kind === 'game' ? document.getElementById(`${kind}Status`).value : void 0,
          assignee_id: document.getElementById(`${kind}Assignee`).value || null,
        },
      });
      for (const item of materials) {
        await apiFetch(`/api/events/${evt.id}/materials`, { method: 'POST', body: { item, activity_id: activityId } });
      }
      renderCrewActivitiesView(mainView);
    });
  };

  const activityCardHtml = a => {
    const mats = materialsByActivity[a.id] || [];
    return `
    <details class="activity-card ${a._colorClass || ''}" data-activity="${a.id}">
      <summary>
        ${escapeHtml(a.name)}
        <span class="activity-material-count">${a.assignee_name ? escapeHtml(a.assignee_name) : 'unassigned'} · ${mats.length ? `${mats.length} material${mats.length === 1 ? '' : 's'}` : 'no materials yet'}</span>
      </summary>
      <div class="activity-body">
        <select class="activity-status-select" data-activity="${a.id}">
          <option value="proposed" ${a.status === 'proposed' ? 'selected' : ''}>Proposed</option>
          <option value="locked_in" ${a.status === 'locked_in' ? 'selected' : ''}>Locked In</option>
        </select>
        <select class="activity-assignee-select" data-activity="${a.id}">${assigneeOptions('Unassigned')}</select>
        ${a.kind === 'event' && (a.starts_at || a.location) ? `<div class="post-meta">${a.starts_at ? formatEventDate(a.starts_at) : 'No time set'}${a.ends_at ? ` – ${formatEventDate(a.ends_at)}` : ''}${a.location ? ` · ${escapeHtml(a.location)}` : ''}</div>` : ''}
        ${a.description ? `<div class="post-snippet">${escapeHtml(a.description)}</div>` : ''}
        <ul class="materials-list">
          ${mats.length ? mats.map(m => `
            <li class="materials-item" data-material="${m.id}">
              <span class="activity-material-tag ${m.category}">${m.category === 'want' ? 'Want' : 'Need'}</span>
              <input type="text" class="materials-item-input" value="${escapeHtml(m.item)}">
              <button class="crew-chip-remove" data-delete-material="${m.id}" title="Remove">&times;</button>
            </li>
          `).join('') : '<li class="placeholder-note" style="border:none;padding:0;">Nothing listed yet.</li>'}
        </ul>
        <form class="activity-material-add" data-activity="${a.id}">
          <input type="text" placeholder="Add a material…" required>
          <span class="activity-material-add-hint">Adds as ${a.status === 'locked_in' ? 'Need' : 'Want'}</span>
          <button type="submit" class="gm-btn">Add</button>
        </form>
        <div class="post-actions"><button class="action-btn danger" data-delete-activity="${a.id}">Delete</button></div>
      </div>
    </details>
  `;
  };

  const games = list.filter(a => a.kind === 'game');
  games.forEach(a => { a._colorClass = `activity-status-${a.status}`; });

  const events = list.filter(a => a.kind === 'event')
    .sort((a, b) => (a.starts_at ? new Date(a.starts_at) : Infinity) - (b.starts_at ? new Date(b.starts_at) : Infinity));
  // Color-coded by calendar day — same day, same color, in first-seen (chronological) order.
  const dayColors = new Map();
  events.forEach(a => {
    if (!a.starts_at) return;
    const day = a.starts_at.slice(0, 10);
    if (!dayColors.has(day)) dayColors.set(day, dayColors.size % 6);
    a._colorClass = `activity-color-${dayColors.get(day)}`;
  });

  const listHtml = `
    <div class="activities-columns">
      <div class="activities-column">
        <h3 class="section-heading">Games</h3>
        ${games.length ? `<div class="activity-list">${games.map(activityCardHtml).join('')}</div>` : '<div class="placeholder-note">No games yet.</div>'}
        ${addFormHtml('game')}
      </div>
      <div class="activities-column">
        <h3 class="section-heading">Events</h3>
        ${events.length ? `<div class="activity-list">${events.map(activityCardHtml).join('')}</div>` : '<div class="placeholder-note">No events yet.</div>'}
        ${addFormHtml('event')}
      </div>
    </div>
  `;

  mainView.innerHTML = listHtml;

  wireAddForm('game');
  wireAddForm('event');

  mainView.querySelectorAll('[data-delete-activity]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this? Its materials list is removed too.')) return;
      await apiFetch(`/api/events/${evt.id}/activities/${btn.dataset.deleteActivity}`, { method: 'DELETE' });
      renderCrewActivitiesView(mainView);
    });
  });

  mainView.querySelectorAll('.activity-status-select').forEach(select => {
    select.addEventListener('change', async () => {
      await apiFetch(`/api/events/${evt.id}/activities/${select.dataset.activity}`, { method: 'PATCH', body: { status: select.value } });
      renderCrewActivitiesView(mainView);
    });
  });

  mainView.querySelectorAll('.activity-assignee-select').forEach(select => {
    const item = list.find(a => a.id === select.dataset.activity);
    select.value = item?.assignee_id || '';
    select.addEventListener('change', async () => {
      await apiFetch(`/api/events/${evt.id}/activities/${select.dataset.activity}`, { method: 'PATCH', body: { assignee_id: select.value || null } });
      renderCrewActivitiesView(mainView);
    });
  });

  mainView.querySelectorAll('.materials-item-input').forEach(input => {
    input.addEventListener('change', async () => {
      const id = input.closest('[data-material]').dataset.material;
      await apiFetch(`/api/events/${evt.id}/materials/${id}`, { method: 'PATCH', body: { item: input.value.trim() } });
    });
  });

  mainView.querySelectorAll('[data-delete-material]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await apiFetch(`/api/events/${evt.id}/materials/${btn.dataset.deleteMaterial}`, { method: 'DELETE' });
      renderCrewActivitiesView(mainView);
    });
  });

  mainView.querySelectorAll('.activity-material-add').forEach(form => {
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const input = form.querySelector('input');
      const item = input.value.trim();
      if (!item) return;
      await apiFetch(`/api/events/${evt.id}/materials`, {
        method: 'POST',
        body: { item, activity_id: form.dataset.activity },
      });
      renderCrewActivitiesView(mainView);
    });
  });
}

// ── Crew: Merch (what we're making, who's making it) ────────────────────
async function renderCrewMerchView(mainView) {
  const evt = myCrewEvent();
  mainView.innerHTML = `<div class="placeholder-note">Loading…</div>`;

  const [{ merch }, { roster }] = await Promise.all([
    apiFetch(`/api/events/${evt.id}/merch`),
    apiFetch('/api/roster'),
  ]);
  const list = merch || [];
  const assigneeOptions = unassignedLabel =>
    `<option value="">${unassignedLabel}</option>${(roster || []).map(m => `<option value="${m.id}">${escapeHtml(m.display_name)}</option>`).join('')}`;

  mainView.innerHTML = `
    <form class="composer" id="merchComposer">
      <input type="text" id="merchName" placeholder="What are we making?" required>
      <select id="merchStatus">
        <option value="proposed">Proposed</option>
        <option value="locked_in">Locked In</option>
      </select>
      <select id="merchAssignee">${assigneeOptions('Who’s making it?')}</select>
      <button type="submit" class="composer-submit">Add</button>
    </form>
    <ul class="materials-list">
      ${list.length ? list.map(m => `
        <li class="materials-item activity-status-${m.status}" data-merch="${m.id}">
          <input type="text" class="materials-item-input" value="${escapeHtml(m.name)}">
          <select class="activity-status-select merch-status-select" data-merch="${m.id}">
            <option value="proposed" ${m.status === 'proposed' ? 'selected' : ''}>Proposed</option>
            <option value="locked_in" ${m.status === 'locked_in' ? 'selected' : ''}>Locked In</option>
          </select>
          <select class="merch-assignee-select">${assigneeOptions('Unassigned')}</select>
          <button class="crew-chip-remove" data-delete-merch="${m.id}" title="Remove">&times;</button>
        </li>
      `).join('') : '<div class="placeholder-note">Nothing listed yet.</div>'}
    </ul>
  `;

  mainView.querySelectorAll('.merch-assignee-select').forEach(select => {
    const merchId = select.closest('[data-merch]').dataset.merch;
    const item = list.find(m => m.id === merchId);
    select.value = item?.assignee_id || '';
  });

  document.getElementById('merchComposer').addEventListener('submit', async e => {
    e.preventDefault();
    const name = document.getElementById('merchName').value.trim();
    if (!name) return;
    const status = document.getElementById('merchStatus').value;
    const assignee_id = document.getElementById('merchAssignee').value || null;
    await apiFetch(`/api/events/${evt.id}/merch`, { method: 'POST', body: { name, status, assignee_id } });
    renderCrewMerchView(mainView);
  });

  mainView.querySelectorAll('.materials-item-input').forEach(input => {
    input.addEventListener('change', async () => {
      const id = input.closest('[data-merch]').dataset.merch;
      await apiFetch(`/api/events/${evt.id}/merch/${id}`, { method: 'PATCH', body: { name: input.value.trim() } });
    });
  });

  mainView.querySelectorAll('.merch-status-select').forEach(select => {
    select.addEventListener('change', async () => {
      await apiFetch(`/api/events/${evt.id}/merch/${select.dataset.merch}`, { method: 'PATCH', body: { status: select.value } });
      renderCrewMerchView(mainView);
    });
  });

  mainView.querySelectorAll('.merch-assignee-select').forEach(select => {
    select.addEventListener('change', async () => {
      const id = select.closest('[data-merch]').dataset.merch;
      await apiFetch(`/api/events/${evt.id}/merch/${id}`, { method: 'PATCH', body: { assignee_id: select.value || null } });
    });
  });

  mainView.querySelectorAll('[data-delete-merch]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await apiFetch(`/api/events/${evt.id}/merch/${btn.dataset.deleteMerch}`, { method: 'DELETE' });
      renderCrewMerchView(mainView);
    });
  });
}

// ── Crew: Signs (what signs we're making, who's making them) ────────────
async function renderCrewSignsView(mainView) {
  const evt = myCrewEvent();
  mainView.innerHTML = `<div class="placeholder-note">Loading…</div>`;

  const [{ signs }, { roster }] = await Promise.all([
    apiFetch(`/api/events/${evt.id}/signs`),
    apiFetch('/api/roster'),
  ]);
  const list = signs || [];
  const assigneeOptions = unassignedLabel =>
    `<option value="">${unassignedLabel}</option>${(roster || []).map(m => `<option value="${m.id}">${escapeHtml(m.display_name)}</option>`).join('')}`;

  mainView.innerHTML = `
    <form class="composer" id="signComposer">
      <input type="text" id="signName" placeholder="What sign do we need?" required>
      <select id="signStatus">
        <option value="proposed">Proposed</option>
        <option value="locked_in">Locked In</option>
      </select>
      <select id="signAssignee">${assigneeOptions('Who’s making it?')}</select>
      <button type="submit" class="composer-submit">Add</button>
    </form>
    <ul class="materials-list">
      ${list.length ? list.map(s => `
        <li class="materials-item activity-status-${s.status}" data-sign="${s.id}">
          <input type="text" class="materials-item-input" value="${escapeHtml(s.name)}">
          <select class="activity-status-select sign-status-select" data-sign="${s.id}">
            <option value="proposed" ${s.status === 'proposed' ? 'selected' : ''}>Proposed</option>
            <option value="locked_in" ${s.status === 'locked_in' ? 'selected' : ''}>Locked In</option>
          </select>
          <select class="merch-assignee-select">${assigneeOptions('Unassigned')}</select>
          <button class="crew-chip-remove" data-delete-sign="${s.id}" title="Remove">&times;</button>
        </li>
      `).join('') : '<div class="placeholder-note">Nothing listed yet.</div>'}
    </ul>
  `;

  mainView.querySelectorAll('.merch-assignee-select').forEach(select => {
    const signId = select.closest('[data-sign]').dataset.sign;
    const item = list.find(s => s.id === signId);
    select.value = item?.assignee_id || '';
  });

  document.getElementById('signComposer').addEventListener('submit', async e => {
    e.preventDefault();
    const name = document.getElementById('signName').value.trim();
    if (!name) return;
    const status = document.getElementById('signStatus').value;
    const assignee_id = document.getElementById('signAssignee').value || null;
    await apiFetch(`/api/events/${evt.id}/signs`, { method: 'POST', body: { name, status, assignee_id } });
    renderCrewSignsView(mainView);
  });

  mainView.querySelectorAll('.materials-item-input').forEach(input => {
    input.addEventListener('change', async () => {
      const id = input.closest('[data-sign]').dataset.sign;
      await apiFetch(`/api/events/${evt.id}/signs/${id}`, { method: 'PATCH', body: { name: input.value.trim() } });
    });
  });

  mainView.querySelectorAll('.sign-status-select').forEach(select => {
    select.addEventListener('change', async () => {
      await apiFetch(`/api/events/${evt.id}/signs/${select.dataset.sign}`, { method: 'PATCH', body: { status: select.value } });
      renderCrewSignsView(mainView);
    });
  });

  mainView.querySelectorAll('.merch-assignee-select').forEach(select => {
    select.addEventListener('change', async () => {
      const id = select.closest('[data-sign]').dataset.sign;
      await apiFetch(`/api/events/${evt.id}/signs/${id}`, { method: 'PATCH', body: { assignee_id: select.value || null } });
    });
  });

  mainView.querySelectorAll('[data-delete-sign]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await apiFetch(`/api/events/${evt.id}/signs/${btn.dataset.deleteSign}`, { method: 'DELETE' });
      renderCrewSignsView(mainView);
    });
  });
}

// ── Crew: Raffle (what's up for raffle, who's bringing it) ──────────────
async function renderCrewRaffleView(mainView) {
  const evt = myCrewEvent();
  mainView.innerHTML = `<div class="placeholder-note">Loading…</div>`;

  const [{ raffle }, { roster }] = await Promise.all([
    apiFetch(`/api/events/${evt.id}/raffle`),
    apiFetch('/api/roster'),
  ]);
  const list = raffle || [];
  const assigneeOptions = unassignedLabel =>
    `<option value="">${unassignedLabel}</option>${(roster || []).map(m => `<option value="${m.id}">${escapeHtml(m.display_name)}</option>`).join('')}`;

  mainView.innerHTML = `
    <form class="composer" id="raffleComposer">
      <input type="text" id="raffleName" placeholder="What are we raffling?" required>
      <select id="raffleStatus">
        <option value="proposed">Proposed</option>
        <option value="locked_in">Locked In</option>
      </select>
      <select id="raffleAssignee">${assigneeOptions('Who’s bringing it?')}</select>
      <button type="submit" class="composer-submit">Add</button>
    </form>
    <ul class="materials-list">
      ${list.length ? list.map(r => `
        <li class="materials-item activity-status-${r.status}" data-raffle="${r.id}">
          <input type="text" class="materials-item-input" value="${escapeHtml(r.name)}">
          <select class="activity-status-select raffle-status-select" data-raffle="${r.id}">
            <option value="proposed" ${r.status === 'proposed' ? 'selected' : ''}>Proposed</option>
            <option value="locked_in" ${r.status === 'locked_in' ? 'selected' : ''}>Locked In</option>
          </select>
          <select class="merch-assignee-select">${assigneeOptions('Unassigned')}</select>
          <button class="crew-chip-remove" data-delete-raffle="${r.id}" title="Remove">&times;</button>
        </li>
      `).join('') : '<div class="placeholder-note">Nothing listed yet.</div>'}
    </ul>
  `;

  mainView.querySelectorAll('.merch-assignee-select').forEach(select => {
    const raffleId = select.closest('[data-raffle]').dataset.raffle;
    const item = list.find(r => r.id === raffleId);
    select.value = item?.assignee_id || '';
  });

  document.getElementById('raffleComposer').addEventListener('submit', async e => {
    e.preventDefault();
    const name = document.getElementById('raffleName').value.trim();
    if (!name) return;
    const status = document.getElementById('raffleStatus').value;
    const assignee_id = document.getElementById('raffleAssignee').value || null;
    await apiFetch(`/api/events/${evt.id}/raffle`, { method: 'POST', body: { name, status, assignee_id } });
    renderCrewRaffleView(mainView);
  });

  mainView.querySelectorAll('.materials-item-input').forEach(input => {
    input.addEventListener('change', async () => {
      const id = input.closest('[data-raffle]').dataset.raffle;
      await apiFetch(`/api/events/${evt.id}/raffle/${id}`, { method: 'PATCH', body: { name: input.value.trim() } });
    });
  });

  mainView.querySelectorAll('.raffle-status-select').forEach(select => {
    select.addEventListener('change', async () => {
      await apiFetch(`/api/events/${evt.id}/raffle/${select.dataset.raffle}`, { method: 'PATCH', body: { status: select.value } });
      renderCrewRaffleView(mainView);
    });
  });

  mainView.querySelectorAll('.merch-assignee-select').forEach(select => {
    select.addEventListener('change', async () => {
      const id = select.closest('[data-raffle]').dataset.raffle;
      await apiFetch(`/api/events/${evt.id}/raffle/${id}`, { method: 'PATCH', body: { assignee_id: select.value || null } });
    });
  });

  mainView.querySelectorAll('[data-delete-raffle]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await apiFetch(`/api/events/${evt.id}/raffle/${btn.dataset.deleteRaffle}`, { method: 'DELETE' });
      renderCrewRaffleView(mainView);
    });
  });
}

// ── Crew: Materials (Needs / Wants, two columns) ────────────────────────
// Dedupe materials by item text (case/whitespace-insensitive) within a
// category — same item added under two different games/events collapses
// into one row, with every activity it's needed for listed under the (i)
// info button instead of showing as separate duplicate rows.
function groupMaterials(items, activityNames) {
  const groups = new Map();
  items.forEach(m => {
    const key = m.item.trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, { key, item: m.item, category: m.category, ids: [], priority: false, sources: [] });
    const g = groups.get(key);
    g.ids.push(m.id);
    if (m.priority) g.priority = true;
    const source = m.activity_id && activityNames[m.activity_id];
    if (source && !g.sources.includes(source)) g.sources.push(source);
  });
  return [...groups.values()];
}

function materialsColumnHtml(groups, showPriority) {
  return groups.length ? `<ul class="materials-list">${groups.map(g => {
    const idsAttr = g.ids.join(',');
    return `
    <li class="materials-item ${g.priority ? 'materials-priority' : ''}" data-material-ids="${idsAttr}">
      ${showPriority ? `<label class="materials-priority-toggle" title="Priority"><input type="checkbox" class="materials-priority-checkbox" ${g.priority ? 'checked' : ''}> ★</label>` : ''}
      <input type="text" class="materials-item-input" value="${escapeHtml(g.item)}">
      ${g.ids.length > 1 ? `<span class="materials-source-tag">×${g.ids.length}</span>` : ''}
      ${g.sources.length ? `<button class="materials-source-toggle" data-source-toggle="${escapeHtml(g.key)}" title="What's this for?">ⓘ</button>` : ''}
      <button class="crew-chip-remove" data-move-material data-to="${g.category === 'need' ? 'want' : 'need'}" title="Move to ${g.category === 'need' ? 'Wants' : 'Needs'}">⇄</button>
      <button class="crew-chip-remove" data-delete-material title="Remove">&times;</button>
      ${g.sources.length ? `<div class="materials-source-detail" id="materialsSource-${escapeHtml(g.key)}" hidden>For: ${g.sources.map(escapeHtml).join(', ')}</div>` : ''}
    </li>
  `; }).join('')}</ul>` : '<div class="placeholder-note">Nothing listed yet.</div>';
}

async function renderCrewMaterialsView(mainView) {
  const evt = myCrewEvent();
  mainView.innerHTML = `<div class="placeholder-note">Loading…</div>`;

  const [{ materials }, { activities }] = await Promise.all([
    apiFetch(`/api/events/${evt.id}/materials`),
    apiFetch(`/api/events/${evt.id}/activities`),
  ]);
  const activityNames = {};
  (activities || []).forEach(a => { activityNames[a.id] = a.name; });
  const needGroups = groupMaterials((materials || []).filter(m => m.category !== 'want'), activityNames)
    .sort((a, b) => (b.priority ? 1 : 0) - (a.priority ? 1 : 0));
  const wantGroups = groupMaterials((materials || []).filter(m => m.category === 'want'), activityNames);

  mainView.innerHTML = `
    <form class="composer" id="materialComposer">
      <input type="text" id="materialItem" placeholder="What do we need or want?" required>
      <select id="materialCategory">
        <option value="need">Need</option>
        <option value="want">Want</option>
      </select>
      <button type="submit" class="composer-submit">Add</button>
    </form>
    <div class="materials-columns">
      <div class="materials-column">
        <h3 class="section-heading">Needs</h3>
        ${materialsColumnHtml(needGroups, true)}
      </div>
      <div class="materials-column">
        <h3 class="section-heading">Wants</h3>
        ${materialsColumnHtml(wantGroups, false)}
      </div>
    </div>
  `;

  document.getElementById('materialComposer').addEventListener('submit', async e => {
    e.preventDefault();
    const input = document.getElementById('materialItem');
    const item = input.value.trim();
    if (!item) return;
    const category = document.getElementById('materialCategory').value;
    await apiFetch(`/api/events/${evt.id}/materials`, { method: 'POST', body: { item, category } });
    renderCrewMaterialsView(mainView);
  });

  const groupIds = el => el.closest('[data-material-ids]').dataset.materialIds.split(',');

  mainView.querySelectorAll('.materials-item-input').forEach(input => {
    input.addEventListener('change', async () => {
      const value = input.value.trim();
      await Promise.all(groupIds(input).map(id =>
        apiFetch(`/api/events/${evt.id}/materials/${id}`, { method: 'PATCH', body: { item: value } })
      ));
    });
  });

  mainView.querySelectorAll('.materials-priority-checkbox').forEach(cb => {
    cb.addEventListener('change', async () => {
      await Promise.all(groupIds(cb).map(id =>
        apiFetch(`/api/events/${evt.id}/materials/${id}`, { method: 'PATCH', body: { priority: cb.checked } })
      ));
      renderCrewMaterialsView(mainView);
    });
  });

  mainView.querySelectorAll('[data-move-material]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await Promise.all(groupIds(btn).map(id =>
        apiFetch(`/api/events/${evt.id}/materials/${id}`, { method: 'PATCH', body: { category: btn.dataset.to } })
      ));
      renderCrewMaterialsView(mainView);
    });
  });

  mainView.querySelectorAll('[data-delete-material]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await Promise.all(groupIds(btn).map(id =>
        apiFetch(`/api/events/${evt.id}/materials/${id}`, { method: 'DELETE' })
      ));
      renderCrewMaterialsView(mainView);
    });
  });

  mainView.querySelectorAll('[data-source-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const detail = document.getElementById(`materialsSource-${btn.dataset.sourceToggle}`);
      detail.hidden = !detail.hidden;
    });
  });
}

// ── Crew: Carny Code — guild lore recited at meetings, open to everyone,
// editable only by Ringleaders ───────────────────────────────────────────
async function renderCrewLoreView(mainView) {
  mainView.innerHTML = `<div class="placeholder-note">Loading…</div>`;
  let content = (await apiFetch('/api/lore')).content;
  let editing = false;

  function draw() {
    if (editing) {
      mainView.innerHTML = `
        <div class="post-actions" style="margin-bottom:0.6rem;">
          <button class="composer-submit" id="loreSaveBtn">Save</button>
          <button class="gm-btn" id="loreCancelBtn">Cancel</button>
        </div>
        <textarea id="loreEditContent" rows="24" style="width:100%;max-width:760px;background:var(--bg);border:1px solid var(--border);border-radius:3px;padding:0.7rem;color:var(--cream);font-family:inherit;">${escapeHtml(content)}</textarea>
      `;
      document.getElementById('loreSaveBtn').addEventListener('click', async () => {
        const value = document.getElementById('loreEditContent').value;
        await apiFetch('/api/lore', { method: 'PATCH', body: { content: value } });
        content = value;
        editing = false;
        draw();
      });
      document.getElementById('loreCancelBtn').addEventListener('click', () => { editing = false; draw(); });
      return;
    }
    mainView.innerHTML = `
      ${profile?.is_ringleader ? `<div class="post-actions" style="margin-bottom:0.6rem;"><button class="action-btn" id="loreEditBtn">Edit</button></div>` : ''}
      <div style="max-width:760px;">${renderMarkdown(content || '*Nothing here yet.*')}</div>
    `;
    const editBtn = document.getElementById('loreEditBtn');
    if (editBtn) editBtn.addEventListener('click', () => { editing = true; draw(); });
  }

  draw();
}

boot();
