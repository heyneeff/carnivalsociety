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
let newSignupsCount = 0; // unseen new-member signups, Ringleaders only
let appConfig = { turnstile_site_key: null, payments_enabled: false, password_reset_enabled: false }; // from /api/config
let myVolunteering = new Set(); // event ids the signed-in user has volunteered for

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
// Opening the installed app from the Home Screen always lands in the
// Dressing Room (iOS sometimes saves whatever page you were on when you
// added it). Tapping a squawk opens /?n=1#/<where>, which is honored.
function landInRoomOnLaunch() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const params = new URLSearchParams(location.search);
  let launched = false;
  try { launched = !!sessionStorage.getItem('cs-launched'); sessionStorage.setItem('cs-launched', '1'); } catch (e) { /* ignore */ }
  if (params.has('n')) { history.replaceState(null, '', '/' + location.hash); return; }
  if (standalone && !launched && !/^#\/(reset|event)\//.test(location.hash)) history.replaceState(null, '', '/#/dressing-room');
}

async function boot() {
  landInRoomOnLaunch();
  try { appConfig = { ...appConfig, ...await apiFetch('/api/config') }; } catch (e) { /* defaults: optional features off */ }
  try {
    const { user } = await apiFetch('/api/me');
    if (user) { session = true; profile = user; await loadAppData(); }
  } catch (e) { /* not signed in */ }
  render();
}

async function loadAppData() {
  if (!isInnerMember()) {
    // Server returns just the Courtyard board to courtyard accounts.
    const [{ chapters: chapterData }, { boards: boardData }, { event_ids }] = await Promise.all([
      apiFetch('/api/chapters'),
      apiFetch('/api/boards'),
      apiFetch('/api/me/volunteering'),
    ]);
    chapters = chapterData || [];
    boards = boardData || [];
    myVolunteering = new Set(event_ids || []);
    crewEvents = []; activeCrewEventId = null;
    return;
  }
  const [{ chapters: chapterData }, { boards: boardData }, { events: crewData }, { event_ids }] = await Promise.all([
    apiFetch('/api/chapters'),
    apiFetch('/api/boards'),
    apiFetch('/api/me/crew'),
    apiFetch('/api/me/volunteering'),
  ]);
  chapters = chapterData || [];
  boards = boardData || [];
  crewEvents = crewData || [];
  myVolunteering = new Set(event_ids || []);
  activeCrewEventId = crewEvents[0]?.id || null;
  if (profile?.is_ringleader) await refreshNewSignupsCount();
}

async function refreshNewSignupsCount() {
  try {
    const { count } = await apiFetch('/api/admin/new-signups');
    newSignupsCount = count || 0;
  } catch (e) { /* not fatal — badge just stays at its last known value */ }
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
  mobileNavOpen = false; // any navigation closes the mobile drawer
  const resetMatch = window.location.hash.match(/^#\/reset\/([0-9a-f]+)$/);
  if (resetMatch) { renderResetScreen(resetMatch[1]); return; }
  if (!session || !profile) { session = false; profile = null; renderAuthScreen(defaultAuthMode()); return; }
  if (!profile.onboarded) { renderOnboarding(); return; }
  renderShell();
  if (needsRankCelebration() && !document.querySelector('.rank-celebration')) renderRankCelebration();
}

// ── Auth screen ──────────────────────────────────────────────────────
async function ensureChaptersLoaded() {
  if (!chapters.length) { const { chapters: c } = await apiFetch('/api/chapters'); chapters = c || []; }
}

// People arriving from a shared link (#/join, ?join, or an event link) came
// to join, not sign in — open on Join for them.
function sharedEventId() {
  const m = window.location.hash.match(/^#\/event\/([^/]+)$/);
  return m ? m[1] : null;
}
function defaultAuthMode() {
  const h = window.location.hash;
  return h === '#/join' || sharedEventId() || new URLSearchParams(location.search).has('join') ? 'signup' : 'signin';
}

function renderAuthScreen(mode = 'signin', errorMsg = '') {
  const subtitle = mode === 'signup' ? 'Step right up. Joining is free.'
    : mode === 'forgot' ? "Happens to the best of us."
    : 'Welcome back, carnie.';
  app.innerHTML = `
    <div class="auth-screen">
      <div class="auth-edge-trumpet left" aria-hidden="true">
        <img src="https://pub-2dbb7654dec74c5694402d3930de7a9a.r2.dev/Left%20trumpet.png" alt="">
        <div class="trumpet-notes trumpet-notes-left">
          <span class="tnote" style="--dx:18px; --rot:20deg; animation-delay:0s;">&#9834;</span>
          <span class="tnote" style="--dx:-6px; --rot:-15deg; animation-delay:0.7s;">&#9835;</span>
          <span class="tnote" style="--dx:12px; --rot:30deg; animation-delay:1.4s;">&#9834;</span>
        </div>
      </div>
      <div class="auth-edge-trumpet right" aria-hidden="true">
        <img src="https://pub-2dbb7654dec74c5694402d3930de7a9a.r2.dev/Right%20trumpet.png" alt="">
        <div class="trumpet-notes trumpet-notes-right">
          <span class="tnote" style="--dx:-18px; --rot:-20deg; animation-delay:0.35s;">&#9834;</span>
          <span class="tnote" style="--dx:6px; --rot:15deg; animation-delay:1.05s;">&#9835;</span>
          <span class="tnote" style="--dx:-12px; --rot:-30deg; animation-delay:1.75s;">&#9834;</span>
        </div>
      </div>
      <div class="auth-panel">
        <img class="auth-logo" src="assets/logo-wordmark.png" alt="Carnival Society International">
        <h1>Guild Hall</h1>
        <p class="auth-sub">${subtitle}</p>
        <div class="auth-invite" id="authInvite" hidden></div>
        <div class="auth-tabs">
          <button class="auth-tab ${mode === 'signup' ? 'active' : ''}" id="tabSignup">Join the Guild</button>
          <button class="auth-tab ${mode !== 'signup' ? 'active' : ''}" id="tabSignin">Sign In</button>
        </div>
        <form class="auth-form" id="authForm">
          ${mode === 'signup' ? `
          <div class="auth-field">
            <label for="displayName" id="displayNameLabel">Your name</label>
            <input type="text" id="displayName" autocomplete="name" required>
          </div>` : ''}
          <div class="auth-field">
            <label for="email">Email</label>
            <input type="email" id="email" autocomplete="email" required>
          </div>
          ${mode === 'forgot' ? `<p class="auth-sub">We'll email you a link to set a new password.</p>` : `
          <div class="auth-field">
            <label for="password">Password${mode === 'signup' ? ' (6+ characters)' : ''}</label>
            <input type="password" id="password" minlength="6" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}" required>
          </div>`}
          ${mode === 'signup' ? `
          <div class="auth-field">
            <label for="city">City</label>
            <input type="text" id="city" autocomplete="address-level2" placeholder="e.g. Boulder" required>
          </div>
          <label class="auth-org-toggle">
            <input type="checkbox" id="isOrganization">
            I'm signing up an organization
          </label>` : ''}
          ${mode === 'signup' && appConfig.turnstile_site_key ? '<div id="turnstileWidget" class="turnstile-slot"></div>' : ''}
          <p class="auth-error">${escapeHtml(errorMsg)}</p>
          <button type="submit" class="auth-submit">${mode === 'signup' ? 'Join — it’s free' : mode === 'forgot' ? 'Send reset link' : 'Enter'}</button>
          ${mode === 'signin' && appConfig.password_reset_enabled ? '<button type="button" class="auth-link" id="forgotLink">Forgot password?</button>' : ''}
          ${mode === 'forgot' ? '<button type="button" class="auth-link" id="backToSignin">Back to sign in</button>' : ''}
        </form>
      </div>
    </div>
  `;

  document.getElementById('tabSignin').onclick = () => renderAuthScreen('signin');
  document.getElementById('tabSignup').onclick = () => renderAuthScreen('signup');
  document.getElementById('forgotLink')?.addEventListener('click', () => renderAuthScreen('forgot'));
  document.getElementById('backToSignin')?.addEventListener('click', () => renderAuthScreen('signin'));

  // Shared event link: say what they were invited to.
  const invitedTo = sharedEventId();
  if (invitedTo) {
    apiFetch(`/api/events/${invitedTo}`).then(({ event }) => {
      const el = document.getElementById('authInvite');
      if (!el || !event) return;
      el.hidden = false;
      el.innerHTML = `🎪 You're invited to <strong>${escapeHtml(event.title)}</strong>${event.starts_at ? ` · ${escapeHtml(formatEventDate(event.starts_at))}` : ''}. ${mode === 'signup' ? 'Join to volunteer.' : 'Sign in to volunteer.'}`;
    }).catch(() => {});
  }

  let turnstileWidgetId = null;
  if (mode === 'signup') {
    document.getElementById('isOrganization').addEventListener('change', e => {
      document.getElementById('displayNameLabel').textContent = e.target.checked ? 'Organization name' : 'Your name';
    });
    if (appConfig.turnstile_site_key) {
      loadTurnstile().then(ts => {
        if (document.getElementById('turnstileWidget')) turnstileWidgetId = ts.render('#turnstileWidget', { sitekey: appConfig.turnstile_site_key, theme: 'dark' });
      });
    }
  }

  document.getElementById('authForm').addEventListener('submit', async e => {
    e.preventDefault();
    const email = document.getElementById('email').value.trim();
    if (mode === 'forgot') {
      try {
        await apiFetch('/api/auth/forgot', { method: 'POST', body: { email } });
        renderAuthScreen('signin', 'If that email has an account, a reset link is on its way. Check your inbox (and spam).');
      } catch (err) {
        renderAuthScreen('forgot', err.message);
      }
      return;
    }
    const password = document.getElementById('password').value;
    try {
      const { user } = mode === 'signup'
        ? await apiFetch('/api/auth/signup', {
            method: 'POST',
            body: { email, password, display_name: document.getElementById('displayName').value.trim(), city: document.getElementById('city').value.trim(),
                    is_organization: document.getElementById('isOrganization').checked,
                    turnstile_token: turnstileWidgetId !== null ? window.turnstile.getResponse(turnstileWidgetId) : undefined },
          })
        : await apiFetch('/api/auth/signin', { method: 'POST', body: { email, password } });
      session = true;
      profile = user;
      await loadAppData();
      render();
    } catch (err) {
      renderAuthScreen(mode, err.message);
    }
  });
}

let turnstilePromise = null;
function loadTurnstile() {
  if (!turnstilePromise) turnstilePromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.onload = () => resolve(window.turnstile);
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return turnstilePromise;
}

// Landing page for the emailed reset link (#/reset/<token>).
function renderResetScreen(token, errorMsg = '') {
  app.innerHTML = `
    <div class="auth-screen">
      <div class="auth-panel">
        <img class="auth-logo" src="assets/logo-wordmark.png" alt="Carnival Society International">
        <h1>New password</h1>
        <form class="auth-form" id="resetForm">
          <div class="auth-field">
            <label for="newPassword">New password (6+ characters)</label>
            <input type="password" id="newPassword" minlength="6" required autocomplete="new-password">
          </div>
          <p class="auth-error">${escapeHtml(errorMsg)}</p>
          <button type="submit" class="auth-submit">Set password</button>
        </form>
      </div>
    </div>
  `;
  document.getElementById('resetForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const { user } = await apiFetch('/api/auth/reset', { method: 'POST', body: { token, password: document.getElementById('newPassword').value } });
      session = true;
      profile = user;
      await loadAppData();
      history.replaceState(null, '', '#/');
      render();
    } catch (err) {
      renderResetScreen(token, err.message);
    }
  });
}

// ── Onboarding — shown once after signup (or on next sign-in if skipped) ──
// "Pick your act": tappable roles instead of free-text skills — an identity
// on day one, and a way to call on "all the sound people" later. Everything
// else (birthday, materials, contact) lives on My Profile.
const ACTS = ['Builder', 'Performer', 'Sound & Light', 'Art & Signs', 'Costume', 'Fire & Flow', 'Kitchen', 'Hospitality', 'Crew & Setup', 'Photo & Video', 'Organizer', 'Just here for the fun'];

async function renderOnboarding() {
  const chosen = new Set((profile.skills || '').split(',').map(s => s.trim()).filter(Boolean));
  app.innerHTML = `
    <div class="auth-screen">
      <div class="auth-panel" style="max-width:600px;">
        <img class="auth-logo" src="assets/logo-wordmark.png" alt="Carnival Society International">
        <h1>Welcome, ${escapeHtml(profile.display_name)}!</h1>
        <p class="auth-sub">Pick your act. Tap everything that sounds like you.</p>
        <div class="act-chips" id="actChips">
          ${ACTS.map(a => `<button type="button" class="act-chip ${chosen.has(a) ? 'on' : ''}" data-act="${escapeHtml(a)}">${escapeHtml(a)}</button>`).join('')}
        </div>
        <div class="auth-form">
          <div class="auth-field">
            <label for="obHeardAbout">How'd you hear about us? (optional)</label>
            <input id="obHeardAbout" type="text" placeholder="A friend, an event, Instagram…">
          </div>
          <button class="auth-submit" id="obFinishBtn">Let’s go →</button>
          <button class="auth-link" id="obSkipBtn">Skip for now</button>
        </div>
      </div>
    </div>
  `;
  document.querySelectorAll('.act-chip').forEach(chip => chip.addEventListener('click', () => {
    const a = chip.dataset.act;
    if (chosen.has(a)) chosen.delete(a); else chosen.add(a);
    chip.classList.toggle('on', chosen.has(a));
  }));
  const finish = async body => {
    const { user } = await apiFetch('/api/me', { method: 'PATCH', body: { ...body, onboarded: true } });
    profile = user;
    await loadAppData();
    render();
  };
  document.getElementById('obFinishBtn').addEventListener('click', () => finish({
    skills: [...chosen].join(', '),
    heard_about_us: document.getElementById('obHeardAbout').value.trim(),
  }));
  document.getElementById('obSkipBtn').addEventListener('click', () => finish({}));
}

// ── App shell ────────────────────────────────────────────────────────
// Assigning members to an event's crew ("Manage Crew" on Events) is switched
// off for now -- won't be needed for a while. The crew Hub itself (nav link,
// tabs, routes) stays fully in place; only the assignment UI is hidden. Flip
// this back on whenever crew assignment starts being used again.
const CREW_ASSIGNMENT_ENABLED = false;

function currentRoute() {
  const route = window.location.hash.replace(/^#\/?/, '');
  return route && route !== 'join' ? route : 'dressing-room';
}

let mobileNavOpen = false; // off-canvas sidebar drawer, ≤800px only (see .sidebar.open in styles.css)

// Top bar everywhere (no sidebar): bobbing wordmark, primary nav on wide
// screens, a "More" sheet for everything else, bottom tabs on phones.
function renderShell() {
  const route = currentRoute();
  const initials = (profile?.display_name || '?').trim().slice(0, 1).toUpperCase();
  const inner = isInnerMember();
  const onGuildHallBoard = route === 'guild-hall' || chapters.some(c => c.slug === route);
  const is = (...names) => names.some(n => n.endsWith('/') ? route.startsWith(n) : route === n);
  const link = (href, label, active, extra = '') => `<a class="topnav-link ${active ? 'active' : ''}" href="${href}" ${active ? 'aria-current="page"' : ''}>${label}${extra}</a>`;

  const primary = [
    link('#/dressing-room', 'Dressing Room', is('dressing-room', 'passport')),
    link('#/courtyard', 'Courtyard', is('courtyard')),
    link('#/events', 'Events', is('events', 'event/')),
    inner ? link('#/guild-hall', 'Guild Hall', onGuildHallBoard) : '',
    inner ? link('#/dm', 'Messages', is('dm', 'dm/'), lettersBadge()) : '',
  ].join('');

  const sheetLink = (href, label, active, extra = '') => `<a class="sheet-link ${active ? 'active' : ''}" href="${href}">${label}${extra}</a>`;
  const sheet = `
    <div class="sheet-group">
      <div class="sheet-label">You</div>
      ${sheetLink('#/dressing-room', 'Dressing Room', is('dressing-room'))}
      ${sheetLink('#/passport', 'Passport &amp; Prizes', is('passport'))}
      ${sheetLink('#/profile', 'My Profile', is('profile'))}
      ${sheetLink('#/tickets', 'My Tickets', is('tickets'))}
    </div>
    <div class="sheet-group">
      <div class="sheet-label">The guild</div>
      ${sheetLink('#/courtyard', 'Courtyard', is('courtyard'))}
      ${sheetLink('#/events', 'Events &amp; Volunteering', is('events', 'event/'))}
      ${inner ? sheetLink('#/guild-hall', 'Guild Hall', onGuildHallBoard) : ''}
      ${inner ? sheetLink('#/dm', 'Messages', is('dm', 'dm/'), lettersBadge()) : ''}
      ${inner ? sheetLink('#/hub', 'Crew Hub', is('hub', 'crew/')) : ''}
    </div>
    ${profile?.is_ringleader ? `
    <div class="sheet-group">
      <div class="sheet-label">Ringleader</div>
      ${sheetLink('#/blast', '📣 Holler at Everyone (Blast)', is('blast'))}
      ${sheetLink('#/directory', 'Directory', is('directory'), newSignupsCount ? ` <span class="nav-badge">${newSignupsCount}</span>` : '')}
      ${sheetLink('#/checkin', 'Door Check-in', is('checkin', 'checkin/'))}
      ${sheetLink('#/impact', 'Impact Log', is('impact'))}
      ${sheetLink('#/field', 'Guild Map', is('field'))}
      ${sheetLink('#/network', 'Member Network', is('network'))}
      ${sheetLink('#/projects', 'Projects', is('projects'))}
      ${sheetLink('#/meetings', 'Meetings', is('meetings'))}
    </div>` : ''}
    <button class="sheet-signout" id="signoutBtn">Sign Out</button>`;

  const tab = (href, label, active, icon) => `<a class="bottomtab ${active ? 'active' : ''}" href="${href}" ${active ? 'aria-current="page"' : ''}>${icon}<span>${label}</span></a>`;
  const svg = d => `<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;

  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="topbar-inner">
          <a class="topbar-mark" href="#/dressing-room" aria-label="Carnival Society — your Dressing Room">
            <img class="topbar-logo cs-bob" src="assets/logo-wordmark.png" alt="Carnival Society International">
          </a>
          <nav class="topnav" aria-label="Main">${primary}</nav>
          <div class="topbar-actions">
            <button class="topbar-more" id="moreBtn" aria-label="More" aria-expanded="${mobileNavOpen}">
              ${svg('M4 7h16M4 12h16M4 17h16')}
              ${profile?.is_ringleader && newSignupsCount ? '<span class="topbar-dot" aria-hidden="true"></span>' : ''}
            </button>
            <a class="topbar-avatar" href="#/dressing-room" title="${escapeHtml(profile?.display_name || '')}">${escapeHtml(initials)}</a>
          </div>
        </div>
      </header>
      <div class="sheet-scrim ${mobileNavOpen ? 'open' : ''}" id="navScrim"></div>
      <aside class="more-sheet ${mobileNavOpen ? 'open' : ''}" aria-label="More">${sheet}</aside>
      <main class="main" id="mainView"></main>
      ${chatShellHtml()}
      <nav class="bottomtabs" aria-label="Main">
        ${tab('#/dressing-room', 'Dressing Room', is('dressing-room', 'passport'), svg('M6 21V10a6 6 0 0 1 12 0v11z M4 21h16'))}
        ${tab('#/courtyard', 'Courtyard', is('courtyard'), svg('M3 20h18 M5 20V10l7-6 7 6v10 M10 20v-5h4v5'))}
        ${tab('#/events', 'Events', is('events', 'event/'), svg('M3 21h18 M4 21 12 4l8 17 M12 4v17 M12 4l3-2'))}
        ${inner ? tab('#/dm', `Messages${lettersBadge()}`, is('dm', 'dm/'), svg('M4 5h16v11H9l-5 4z')) : tab('#/profile', 'Me', is('profile'), svg('M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21a8 8 0 0 1 16 0'))}
      </nav>
    </div>
  `;

  document.getElementById('signoutBtn').onclick = async () => {
    await apiFetch('/api/auth/signout', { method: 'POST' });
    session = false; profile = null; chapters = []; boards = []; crewEvents = []; activeCrewEventId = null;
    mobileNavOpen = false;
    clearTimeout(chat.timer); Object.assign(chat, { messages: [], lastId: 0, here: [], open: null, unread: 0, timer: null });
    letters = { unread: 0, from: [] };
    document.body.classList.remove('chat-docked');
    render();
  };
  document.getElementById('moreBtn').onclick = () => { mobileNavOpen = !mobileNavOpen; renderShell(); };
  document.getElementById('navScrim').onclick = () => { mobileNavOpen = false; renderShell(); };

  renderMainView(route);
  mountChat();
}

// Which kind of place a page is, for its cozy styling (see styles.css):
// the forum is the big book, events are the corkboard, and so on.
function pageKind(route) {
  if (route === 'dressing-room') return 'room';
  if (route === 'courtyard' || route === 'guild-hall' || route.startsWith('post/') || chapters.some(c => c.slug === route)) return 'forum';
  if (route === 'events' || route.startsWith('event/')) return 'events';
  if (route === 'dm' || route.startsWith('dm/')) return 'letters';
  if (route === 'profile') return 'profile';
  if (route === 'passport') return 'passport';
  if (route === 'blast') return 'forum';
  return 'other';
}

function renderMainView(route) {
  const mainView = document.getElementById('mainView');
  roomHooks = {};
  mainView.dataset.page = pageKind(route);
  if (route.startsWith('event/')) mainView.dataset.single = '1';
  stopDMPolling();
  if (route === 'membership-success') { renderMembershipSuccess(mainView); return; }
  if (route === 'ticket-success') { renderTicketSuccess(mainView); return; }
  if (route === 'cancelled') { location.hash = '#/events'; return; }
  if (route === 'tickets') { renderMyTicketsView(mainView); return; }
  if (route.startsWith('checkin')) { renderCheckinView(mainView, route.split('/')[1] || null); return; }
  if (route === 'courtyard') { renderCourtyardView(mainView); return; }
  if (route === 'dressing-room') { renderRoom(mainView); return; }
  if (route === 'passport') { renderDressingRoom(mainView); return; }
  if (route === 'profile') { renderProfileView(mainView); return; }
  if (route === 'blast') { renderBlastView(mainView); return; }
  if (route.startsWith('event/')) { renderEventsView(mainView, route.slice(6)); return; }
  // Courtyard members can open Courtyard threads (server enforces which).
  if (!isInnerMember() && route !== 'events' && !route.startsWith('post/')) { location.hash = '#/courtyard'; return; }
  if (route === 'hub') { renderCrewTabs(mainView, 'overview'); return; }
  if (route.startsWith('crew/')) { renderCrewTabs(mainView, route.slice(5)); return; }
  if (route === 'dm') { renderDMListView(mainView); return; }
  if (route.startsWith('dm/')) { renderDMThreadView(mainView, route.slice(3)); return; }
  if (route === 'events') { renderEventsView(mainView); return; }
  if (route === 'directory') { renderDirectoryView(mainView); return; }
  if (route === 'impact') { renderImpactView(mainView); return; }
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

// The forum: one warm parchment sheet in a wooden frame (Spiritfarer /
// Animal Crossing bulletin-board energy), real forum function inside.
const FORUM_ICONS = {
  tent: 'M3 20 12 4l9 16z M12 4v16 M12 4l3-2',
  pin: 'M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z M12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  lock: 'M6 11h12v9H6z M8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  yard: 'M3 20h18 M5 20V10l7-6 7 6v10 M10 20v-5h4v5',
  bubble: 'M4 5h16v11H9l-5 4z',
};
const forumIcon = (k, size = 18) => `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${FORUM_ICONS[k]}"/></svg>`;
function forumFrame(mainView, { title, icon, tabsHtml = '', backHtml = '' }) {
  mainView.innerHTML = `
    <div class="forum">
      <div class="forum-banner">${forumIcon(icon, 22)}<span>${escapeHtml(title)}</span></div>
      ${tabsHtml ? `<nav class="forum-tabs" aria-label="Boards">${tabsHtml}</nav>` : ''}
      <div class="forum-sheet">${backHtml}<div id="forumBody"><div class="forum-empty">Unrolling the parchment…</div></div></div>
    </div>`;
  return document.getElementById('forumBody');
}

function renderGuildHallTabs(mainView, activeSlug) {
  const boardTabs = [{ slug: 'guild-hall', name: 'Guild Hall', icon: 'tent' }, ...chapters.map(c => ({ slug: c.slug, name: c.name, icon: 'pin' }))];
  const active = boardTabs.some(t => t.slug === activeSlug) ? activeSlug : 'guild-hall';
  const tabsHtml = boardTabs.map(t => LOCKED_BOARD_SLUGS.includes(t.slug)
    ? `<span class="forum-tab locked" title="Not open yet">${forumIcon('lock', 16)}${escapeHtml(t.name)}</span>`
    : `<a class="forum-tab ${active === t.slug ? 'active' : ''}" href="#/${t.slug}" ${active === t.slug ? 'aria-current="page"' : ''}>${forumIcon(t.icon, 16)}${escapeHtml(t.name)}</a>`).join('')
    + `<a class="forum-tab" href="#/courtyard">${forumIcon('yard', 16)}Courtyard</a>`;
  const body = forumFrame(mainView, { title: 'The Guild Hall', icon: 'tent', tabsHtml });
  if (LOCKED_BOARD_SLUGS.includes(active)) {
    body.innerHTML = `<div class="forum-empty"><img src="${ROOM}raven_perched.png" alt="" class="forum-empty-bird">This chapter's board isn't open yet. The raven is keeping its seat warm.</div>`;
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
const ORGANIZATION_COLOR = 'var(--accent-3)';
function rankLabel(rank) {
  return rank.charAt(0).toUpperCase() + rank.slice(1);
}
function rankColor(rank) {
  return RANK_COLORS[rank] || 'var(--cream)';
}

// ── Board view: thread cards + a pop-up note to start a thread ─────────
const AVATAR_COLORS = ['#9B3036', '#2F7F7A', '#8B5FA3', '#C97C3D', '#5F7A3D', '#C77B8A', '#8F6E34'];
function avatarFor(id, name, size = 44) {
  let h = 0;
  for (const ch of String(id || name || '?')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `<span class="forum-avatar" style="--av:${AVATAR_COLORS[h % AVATAR_COLORS.length]};--sz:${size}px" aria-hidden="true">${escapeHtml((name || '?').trim().slice(0, 1).toUpperCase())}</span>`;
}
const sqlIso = t => (String(t).includes('T') ? t : String(t).replace(' ', 'T') + 'Z');
function authorChip(a) {
  const label = a?.is_ringleader ? 'Ringleader' : a?.rank ? rankLabel(a.rank) : '';
  return label ? `<span class="forum-rank ${a?.is_ringleader ? 'ringleader' : ''}">${escapeHtml(label)}</span>` : '';
}

async function renderBoardView(host, slug) {
  const board = boards.find(b => b.slug === slug);
  if (!board) { host.innerHTML = `<div class="forum-empty">That board doesn't exist.</div>`; return; }
  const { posts } = await apiFetch(`/api/posts?board_id=${board.id}`);
  // "New" = activity since you last looked at this board (per device).
  const seenKey = `cs-board-seen-${board.id}`;
  let seen = 0;
  try { seen = +localStorage.getItem(seenKey) || 0; localStorage.setItem(seenKey, String(Date.now())); } catch (e) { /* ignore */ }
  const canStartThread = board.slug !== 'courtyard' || isModerator();
  const cards = (posts || []).map(p => {
    const fresh = seen && Date.parse(sqlIso(p.last_activity)) > seen && p.author_id !== profile.id;
    return `
    <a class="thread-card ${p.pinned ? 'pinned' : ''}" href="#/post/${p.id}">
      ${avatarFor(p.author_id, p.author?.display_name)}
      <span class="thread-main">
        <span class="thread-title">${fresh ? '<span class="forum-new">NEW</span>' : ''}${escapeHtml(p.title || '(untitled)')}</span>
        <span class="thread-snippet">${escapeHtml((p.body || '').slice(0, 180))}</span>
        <span class="thread-meta">${escapeHtml(p.author?.display_name || 'someone')} ${authorChip(p.author)} · ${timeAgo(sqlIso(p.created_at))}</span>
      </span>
      <span class="thread-side">
        <span class="thread-replies" title="${p.reply_count} replies">${forumIcon('bubble', 16)}<b>${p.reply_count}</b><small>${p.reply_count === 1 ? 'reply' : 'replies'}</small></span>
        <span class="thread-last">${p.reply_count ? `${escapeHtml(p.last_replier || '')} · ${timeAgo(sqlIso(p.last_activity))}` : 'no replies yet'}</span>
      </span>
      ${p.pinned ? '<span class="thread-seal" title="Pinned" aria-label="Pinned"></span>' : ''}
    </a>`;
  }).join('');
  host.innerHTML = `
    <div class="forum-toolbar">
      <div class="forum-desc">${escapeHtml(board.description || '')}</div>
      ${canStartThread ? `<button class="forum-btn" id="startThread">✒ Start a thread</button>` : ''}
    </div>
    ${!isInnerMember() && board.slug === 'courtyard' ? `<div class="forum-note-pinned"><strong>Welcome to the courtyard, ${escapeHtml(profile.display_name)}!</strong> This is where the guild posts news and calls for help. The quickest way in is to <a href="#/events">volunteer for an upcoming event</a>.</div>` : ''}
    <div class="thread-list">${cards || `<div class="forum-empty"><img src="${ROOM}raven_perched.png" alt="" class="forum-empty-bird">${board.slug === 'courtyard' ? 'Nothing posted yet. News and volunteer calls will land here.' : 'Quiet in here. Be the first to start a thread!'}</div>`}</div>`;
  document.getElementById('startThread')?.addEventListener('click', () => openForumNote({
    heading: `A new thread in ${board.name}`, withTitle: true, cta: 'Pin it up',
    placeholder: board.slug === 'courtyard' ? 'News for everyone in the courtyard…' : "What's on your mind?",
    onSubmit: async ({ title, body }) => { await apiFetch('/api/posts', { method: 'POST', body: { board_id: board.id, title, body } }); renderBoardView(host, slug); },
  }));
}

// A note card that pops up to write on (threads and replies).
function openForumNote({ heading, withTitle, cta, placeholder, onSubmit }) {
  const o = document.createElement('div');
  o.className = 'forum-note-overlay';
  o.innerHTML = `
    <form class="forum-note" role="dialog" aria-label="${escapeHtml(heading)}">
      <div class="forum-note-head">${escapeHtml(heading)}</div>
      ${withTitle ? '<input name="title" required maxlength="140" placeholder="A title for your thread" aria-label="Title">' : ''}
      <textarea name="body" required placeholder="${escapeHtml(placeholder)}" aria-label="Message"></textarea>
      <div class="forum-note-btns"><button type="button" class="forum-btn ghost" data-cancel>Cancel</button><button class="forum-btn">${escapeHtml(cta)}</button></div>
      <div class="forum-note-err" role="status"></div>
    </form>`;
  document.body.appendChild(o);
  const form = o.querySelector('form');
  (form.title || form.body).focus();
  const close = () => o.remove();
  o.addEventListener('click', e => { if (e.target === o || e.target.dataset.cancel !== undefined) close(); });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const title = form.title ? form.title.value.trim() : '', body = form.body.value.trim();
    if (!body || (withTitle && !title)) return;
    form.querySelector('button:not([data-cancel])').disabled = true;
    try { await onSubmit({ title, body }); close(); }
    catch (err) { form.querySelector('.forum-note-err').textContent = err.message; form.querySelector('button:not([data-cancel])').disabled = false; }
  });
}

// ── Courtyard: the board everyone can read ───────────────────────────────
async function renderCourtyardView(mainView) {
  const tabsHtml = isInnerMember()
    ? `<a class="forum-tab" href="#/guild-hall">${forumIcon('tent', 16)}Guild Hall</a><a class="forum-tab active" href="#/courtyard" aria-current="page">${forumIcon('yard', 16)}Courtyard</a>`
    : '';
  const body = forumFrame(mainView, { title: 'The Courtyard', icon: 'yard', tabsHtml });
  await renderBoardView(body, 'courtyard');
}

// ── Thread view: the original post, then the conversation ───────────────
async function renderThreadView(mainView, postId) {
  let post, replies;
  try { ({ post, replies } = await apiFetch(`/api/posts/${postId}`)); }
  catch (e) { forumFrame(mainView, { title: 'Not found', icon: 'tent' }).innerHTML = '<div class="forum-empty">That thread blew away in the wind.</div>'; return; }
  const board = boards.find(b => b.id === post.board_id);
  const backSlug = board ? board.slug : 'guild-hall';
  const body = forumFrame(mainView, {
    title: board ? (board.slug === 'courtyard' ? 'The Courtyard' : board.name) : 'The Guild Hall', icon: board?.slug === 'courtyard' ? 'yard' : 'tent',
    backHtml: `<a class="forum-back" href="#/${backSlug}">← Back to ${escapeHtml(board ? board.name : 'Guild Hall')}</a>`,
  });
  const canModerate = isModerator();
  const mine = id => id === profile.id;
  body.innerHTML = `
    <article class="op-card ${post.pinned ? 'pinned' : ''}">
      ${post.pinned ? '<span class="thread-seal" title="Pinned"></span>' : ''}
      <header class="op-head">${avatarFor(post.author_id, post.author?.display_name, 52)}
        <div><h1 class="op-title">${escapeHtml(post.title || '(untitled)')}</h1>
        <div class="thread-meta">${escapeHtml(post.author?.display_name || 'someone')} ${authorChip(post.author)} · ${timeAgo(sqlIso(post.created_at))}</div></div>
      </header>
      <div class="op-body">${escapeHtml(post.body)}</div>
      ${mine(post.author_id) || canModerate ? `<div class="op-actions">
        ${canModerate ? `<button class="forum-btn small ghost" id="pinBtn">${post.pinned ? 'Unpin' : '📌 Pin'}</button>` : ''}
        <button class="forum-btn small ghost danger" id="deletePostBtn">Delete</button></div>` : ''}
    </article>
    <div class="reply-count-line">${replies.length ? `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}` : 'No replies yet'}</div>
    <div class="reply-stack">${(replies || []).map(r => `
      <div class="reply-row ${mine(r.author_id) ? 'mine' : ''}">
        ${avatarFor(r.author_id, r.author?.display_name, 38)}
        <div class="reply-bubble">
          <div class="thread-meta"><b>${escapeHtml(r.author?.display_name || 'someone')}</b> ${authorChip(r.author)} · ${timeAgo(sqlIso(r.created_at))}
            ${mine(r.author_id) || canModerate ? `<button class="reply-del" data-delete-reply="${r.id}" aria-label="Delete reply">×</button>` : ''}</div>
          <div class="reply-text">${escapeHtml(r.body)}</div>
        </div>
      </div>`).join('')}</div>
    ${isInnerMember()
      ? `<button class="forum-btn reply-open" id="replyOpen">✒ Write a reply</button>`
      : `<div class="forum-note-pinned">Inner members can reply. Work two shifts to step inside.</div>`}`;
  document.getElementById('replyOpen')?.addEventListener('click', () => openForumNote({
    heading: `Reply to “${post.title || 'this thread'}”`, withTitle: false, cta: 'Send reply', placeholder: 'Write a reply…',
    onSubmit: async ({ body: text }) => { await apiFetch('/api/posts', { method: 'POST', body: { board_id: post.board_id, parent_id: postId, body: text } }); renderThreadView(mainView, postId); },
  }));
  document.getElementById('pinBtn')?.addEventListener('click', async () => {
    await apiFetch(`/api/posts/${postId}`, { method: 'PATCH', body: { pinned: !post.pinned } });
    renderThreadView(mainView, postId);
  });
  document.getElementById('deletePostBtn')?.addEventListener('click', async () => {
    if (!confirm('Delete this thread and all its replies?')) return;
    await apiFetch(`/api/posts/${postId}`, { method: 'DELETE' });
    location.hash = `#/${backSlug}`;
  });
  body.querySelectorAll('[data-delete-reply]').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Delete this reply?')) return;
    await apiFetch(`/api/posts/${btn.dataset.deleteReply}`, { method: 'DELETE' });
    renderThreadView(mainView, postId);
  }));
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
      <div class="post-actions">
        <button type="submit" class="composer-submit">Send</button>
        <button type="button" class="action-btn" id="shareContactBtn">📇 Share my contact</button>
      </div>
      <div id="shareContactPanel" class="share-contact-panel" hidden></div>
    </form>
  `;
  const threadEl = document.getElementById('dmThread');
  threadEl.scrollTop = threadEl.scrollHeight;

  // Case-by-case sharing: pick fields, send them as an ordinary message to
  // just this person. Nothing about their profile visibility changes.
  const sharePanel = document.getElementById('shareContactPanel');
  document.getElementById('shareContactBtn').addEventListener('click', () => {
    const fields = [['email', 'Email', profile.email], ['phone', 'Phone', profile.phone], ['instagram', 'Instagram', profile.instagram_handle]].filter(f => f[2]);
    if (sharePanel.hidden === false) { sharePanel.hidden = true; return; }
    sharePanel.hidden = false;
    sharePanel.innerHTML = fields.length ? `
      ${fields.map(([k, label, v]) => `<label class="admin-ringleader-toggle"><input type="checkbox" data-share="${k}" checked> ${label}: ${escapeHtml(v)}</label>`).join('')}
      <button type="button" class="composer-submit" id="sendContactBtn">Send to ${escapeHtml(other?.display_name || 'them')}</button>`
      : `<div class="post-meta">No contact details on your profile yet. <a href="#/profile">Add some</a>.</div>`;
    document.getElementById('sendContactBtn')?.addEventListener('click', async () => {
      const chosen = fields.filter(([k]) => sharePanel.querySelector(`[data-share="${k}"]`).checked);
      if (!chosen.length) return;
      const text = `📇 My contact\n${chosen.map(([, label, v]) => `${label}: ${v}`).join('\n')}`;
      sharePanel.hidden = true;
      appendDMMessage({ sender_id: profile.id, body: text });
      const { id } = await apiFetch(`/api/dm/${convId}/messages`, { method: 'POST', body: { body: text } });
      dmSeenIds.add(id);
    });
  });

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

// onlyEventId: the shareable single-event page (#/event/<id>).
async function renderEventsView(mainView, onlyEventId = null) {
  mainView.innerHTML = `<h2>Events</h2><div class="placeholder-note">Loading…</div>`;

  let { events } = await apiFetch('/api/events');
  if (onlyEventId) {
    events = (events || []).filter(e => e.id === onlyEventId);
    if (!events.length) {
      const { event } = await apiFetch(`/api/events/${onlyEventId}`).catch(() => ({}));
      mainView.innerHTML = `<a class="thread-back" href="#/events">&larr; All events</a>
        <h2>${escapeHtml(event?.title || 'Event not found')}</h2>
        <div class="placeholder-note">${event ? 'This one has already happened.' : "That event doesn't exist."}</div>`;
      return;
    }
  }
  const canManage = isModerator() && !onlyEventId;
  const canEdit = !!profile?.is_ringleader && !onlyEventId;

  const composerHtml = canManage ? `
    <form class="composer" id="eventComposer">
      <input type="text" id="eventTitle" placeholder="Title" required>
      <select id="eventChapter">
        <option value="">Guild-wide</option>
        ${chapters.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
      </select>
      <input type="datetime-local" id="eventStarts" required>
      <input type="datetime-local" id="eventEnds" placeholder="Ends (optional)">
      <input type="text" id="eventLocation" placeholder="Location">
      <textarea id="eventDescription" placeholder="Details"></textarea>
      <button type="submit" class="composer-submit">Add Event</button>
    </form>
  ` : '';

  const listHtml = (events || []).length ? events.map(e => `
    <div class="post-card" style="cursor:default;">
      <div class="post-title">${escapeHtml(e.title)}</div>
      <div class="post-meta">${formatEventDate(e.starts_at)}${e.ends_at ? ` – ${formatEventDate(e.ends_at)}` : ''} · ${escapeHtml(e.chapter ? e.chapter.name : 'Guild-wide')}${e.location ? ' · ' + escapeHtml(e.location) : ''}</div>
      ${e.description ? `<div class="post-snippet">${escapeHtml(e.description)}</div>` : ''}
      <div class="ticket-panel" id="ticketPanel-${e.id}"></div>
      <div class="volunteer-row" id="volunteerRow-${e.id}"></div>
      <div class="post-actions"><button class="action-btn" data-share-event="${e.id}" data-title="${escapeHtml(e.title)}">🔗 Share</button></div>
      ${canManage || canEdit ? `<div class="post-actions">
        ${canEdit ? `<button class="action-btn" data-edit-event="${e.id}">Edit</button>` : ''}
        ${canManage && CREW_ASSIGNMENT_ENABLED ? `<button class="action-btn" data-manage-crew="${e.id}">Manage Crew</button>` : ''}
        ${canManage ? `<button class="action-btn danger" data-delete-event="${e.id}">Delete</button>` : ''}
      </div>` : ''}
      ${canManage && CREW_ASSIGNMENT_ENABLED ? `<div class="crew-editor" id="crewEditor-${e.id}"></div>` : ''}
    </div>
  `).join('') : '<div class="placeholder-note">Nothing scheduled yet.</div>';

  mainView.innerHTML = onlyEventId ? `
    <a class="thread-back" href="#/events">&larr; All events</a>
    <div class="post-list">${listHtml}</div>` : `
    <h2>Events</h2><div class="post-list">${listHtml}</div>
    ${composerHtml ? `<details class="event-new"><summary>+ Post a new event</summary>${composerHtml}</details>` : ''}
    <div class="archive-toggle-row"><button class="gm-btn" id="toggleArchivedBtn" style="background:var(--surface);color:var(--cream);">Show Past Events</button></div>
    <div id="archivedEvents"></div>
  `;

  // Share: native share sheet on phones, copy-link fallback elsewhere.
  mainView.querySelectorAll('[data-share-event]').forEach(btn => btn.addEventListener('click', async () => {
    const url = `${location.origin}/#/event/${btn.dataset.shareEvent}`;
    try {
      if (navigator.share) await navigator.share({ title: btn.dataset.title, text: `Come volunteer at ${btn.dataset.title} with Carnival Society`, url });
      else { await navigator.clipboard.writeText(url); btn.textContent = '✓ Link copied'; }
    } catch (e) { /* share sheet dismissed */ }
  }));

  (events || []).forEach(e => { renderTicketPanel(e.id); renderVolunteerRow(e.id); });

  if (canManage) {
    document.getElementById('eventComposer').addEventListener('submit', async e => {
      e.preventDefault();
      const title = document.getElementById('eventTitle').value.trim();
      const chapterId = document.getElementById('eventChapter').value || null;
      const startsAt = document.getElementById('eventStarts').value;
      const endsAt = document.getElementById('eventEnds').value;
      const location = document.getElementById('eventLocation').value.trim();
      const description = document.getElementById('eventDescription').value.trim();
      if (!title || !startsAt) return;
      await apiFetch('/api/events', {
        method: 'POST',
        body: { title, chapter_id: chapterId, starts_at: new Date(startsAt).toISOString(), ends_at: endsAt ? new Date(endsAt).toISOString() : null, location: location || null, description: description || null },
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
        <div class="post-meta">${formatEventDate(e.starts_at)}${e.ends_at ? ` – ${formatEventDate(e.ends_at)}` : ''} · ${escapeHtml(e.chapter ? e.chapter.name : 'Guild-wide')}${e.location ? ' · ' + escapeHtml(e.location) : ''}</div>
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

  document.getElementById('toggleArchivedBtn')?.addEventListener('click', async btnEvent => {
    const btn = btnEvent.currentTarget;
    const el = document.getElementById('archivedEvents');
    if (el.classList.contains('open')) { el.classList.remove('open'); el.innerHTML = ''; btn.textContent = 'Show Past Events'; return; }
    el.classList.add('open');
    btn.textContent = 'Hide Past Events';
    await loadArchivedEvents();
  });
}

// Volunteer toggle for everyone; moderators also get the sign-up list.
function renderVolunteerRow(eventId) {
  const el = document.getElementById('volunteerRow-' + eventId);
  if (!el) return;
  const signedUp = myVolunteering.has(eventId);
  el.innerHTML = `
    <div class="post-actions">
      ${signedUp
        ? `<span class="volunteer-yes">✓ You're volunteering</span><button class="action-btn" data-unvolunteer>Withdraw</button>`
        : `<button class="composer-submit" data-volunteer>Volunteer for this</button>`}
      ${isModerator() ? `<button class="action-btn" data-show-volunteers>Volunteers</button>` : ''}
    </div>
    <form class="volunteer-form" hidden>
      <input type="text" name="note" maxlength="500" placeholder="Skills or availability (optional)">
      <button type="submit" class="composer-submit">Count me in</button>
    </form>
    <div class="volunteer-list"></div>`;

  const form = el.querySelector('.volunteer-form');
  el.querySelector('[data-volunteer]')?.addEventListener('click', e => {
    e.currentTarget.hidden = true;
    form.hidden = false;
    form.querySelector('input').focus();
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await apiFetch(`/api/events/${eventId}/volunteer`, { method: 'POST', body: { note: form.note.value } });
      myVolunteering.add(eventId);
      renderVolunteerRow(eventId);
    } catch (err) { form.insertAdjacentHTML('beforeend', `<div class="auth-error">${escapeHtml(err.message)}</div>`); }
  });
  el.querySelector('[data-unvolunteer]')?.addEventListener('click', async () => {
    await apiFetch(`/api/events/${eventId}/volunteer`, { method: 'DELETE' });
    myVolunteering.delete(eventId);
    renderVolunteerRow(eventId);
  });
  const list = el.querySelector('.volunteer-list');
  async function drawVolunteers(flash = '') {
    const { volunteers } = await apiFetch(`/api/events/${eventId}/volunteers`);
    list.innerHTML = (flash ? `<div class="stamp-flash">${flash}</div>` : '') + (volunteers.length ? volunteers.map(v => `
      <div class="volunteer-item">
        <strong>${escapeHtml(v.display_name)}</strong>
        <span class="post-meta">${escapeHtml(v.city || '')}${v.tier === 'inner' ? ' · inner' : ' · courtyard'}</span>
        <div class="post-meta">
          <a href="mailto:${escapeHtml(v.email)}">${escapeHtml(v.email)}</a>${v.phone ? ` · <a href="tel:${escapeHtml(v.phone)}">${escapeHtml(v.phone)}</a>` : ''}
        </div>
        ${v.note ? `<div class="post-snippet">${escapeHtml(v.note)}</div>` : ''}
        <div class="post-actions">
          ${v.showed_up
            ? `<span class="volunteer-yes">${BADGES.roustabout.glyph} Showed up · Roustabout stamped</span>`
            : `<button class="action-btn" data-showed-up="${v.id}" data-name="${escapeHtml(v.display_name)}">${BADGES.roustabout.glyph} Showed up</button>`}
        </div>
      </div>`).join('') : '<div class="placeholder-note">No volunteers yet.</div>');
    list.querySelectorAll('[data-showed-up]').forEach(btn => btn.addEventListener('click', async () => {
      btn.disabled = true;
      const r = await apiFetch('/api/stamps', { method: 'POST', body: { user_id: btn.dataset.showedUp, kind: 'roustabout', event_id: eventId } });
      drawVolunteers(r.promoted ? `🎉 ${escapeHtml(btn.dataset.name)} just became an Apprentice and stepped inside!` : '');
    }));
  }
  el.querySelector('[data-show-volunteers]')?.addEventListener('click', async () => {
    if (list.innerHTML) { list.innerHTML = ''; return; }
    await drawVolunteers();
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
        <div class="field-row"><label>Ends</label><input type="datetime-local" id="eeEnds" value="${evt.ends_at ? toDatetimeLocalValue(evt.ends_at) : ''}"></div>
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
    const endsAt = overlay.querySelector('#eeEnds').value;
    if (!title || !startsAt) { alert('Title and start time are required.'); return; }
    const body = {
      title,
      chapter_id: overlay.querySelector('#eeChapter').value || null,
      starts_at: new Date(startsAt).toISOString(),
      ends_at: endsAt ? new Date(endsAt).toISOString() : null,
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
function memberDisplayTitle(m) { return m.is_organization ? 'Organization' : rankLabel(m.rank); }
function memberDisplayColor(m) { return m.is_organization ? ORGANIZATION_COLOR : rankColor(m.rank); }
function memberWeight(m) {
  return (m.is_ringleader ? 10 : 0) + RANK_ORDER[m.rank];
}
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
const DIRECTORY_SORTS = {
  name: { label: 'Name', cmp: (a, b) => a.display_name.localeCompare(b.display_name) },
  rank: { label: 'Rank', cmp: (a, b) => memberWeight(b) - memberWeight(a) || a.display_name.localeCompare(b.display_name) },
  chapter: { label: 'Chapter', cmp: (a, b) => (a.home_chapter?.name || '￿').localeCompare(b.home_chapter?.name || '￿') || a.display_name.localeCompare(b.display_name) },
  city: { label: 'City', cmp: (a, b) => (a.city || '￿').localeCompare(b.city || '￿') || a.display_name.localeCompare(b.display_name) },
  dues: { label: 'Dues status', cmp: (a, b) => (b.dues_paid - a.dues_paid) || a.display_name.localeCompare(b.display_name) },
};
const VENUE_SORTS = {
  name: { label: 'Name', cmp: (a, b) => a.name.localeCompare(b.name) },
  city: { label: 'City', cmp: (a, b) => (a.city || '￿').localeCompare(b.city || '￿') || a.name.localeCompare(b.name) },
};
const IMPACT_SORTS = {
  date: { label: 'Date', cmp: (a, b) => (b.event_date || '').localeCompare(a.event_date || '') },
  name: { label: 'Event', cmp: (a, b) => a.event_name.localeCompare(b.event_name) },
};
let directoryMembersCache = [];
let directoryVenuesCache = [];
let directoryImpactCache = []; // shared with the standalone Impact Log page (renderImpactView)
let directoryTab = 'individuals'; // 'individuals' | 'organizations' | 'venues'
let directorySortKey = 'name';
let directorySearchQuery = '';
let directoryNewIds = new Set();

// ── Directory — Ringleader-only member/venue directory + management ────
// Folds together what used to be three separate pages: contact info (was
// a read-only "Directory"), rank/dues/edit management (was "Members Hub"),
// and new-signup notifications (was "New Members" — recent signups per
// /api/admin/new-signups get a "New" tag here, and viewing the Directory
// is what clears that notification bell). Individuals/Organizations tabs
// both read from directoryMembersCache, filtered by is_organization;
// Venues is a separate, non-account entity (see /api/venues).
async function renderDirectoryView(mainView) {
  if (!profile?.is_ringleader) {
    mainView.innerHTML = `<h2>Not authorized</h2><div class="placeholder-note">Ringleaders only.</div>`;
    return;
  }
  mainView.innerHTML = `<h2>Directory</h2><div class="placeholder-note">Loading…</div>`;

  const [{ members }, { members: newSignups }, { venues }] = await Promise.all([
    apiFetch('/api/members'),
    apiFetch('/api/admin/new-signups'),
    apiFetch('/api/venues'),
  ]);
  directoryMembersCache = members || [];
  directoryNewIds = new Set((newSignups || []).map(m => m.id));
  directoryVenuesCache = venues || [];

  renderDirectoryBody(mainView);

  // Viewing the Directory is what clears the bell — mark seen now that it's rendered.
  if (directoryNewIds.size) {
    try {
      await apiFetch('/api/admin/new-signups/seen', { method: 'POST' });
      newSignupsCount = 0;
      const badge = document.querySelector('.nav-badge');
      if (badge) badge.remove();
    } catch (e) { /* badge just won't clear until next load */ }
  }
}

const DIRECTORY_TABS = [
  ['individuals', 'Individuals'],
  ['organizations', 'Organizations'],
  ['venues', 'Venues'],
];

function switchDirectoryTab(mainView, tab) {
  directoryTab = tab;
  directorySortKey = 'name';
  directorySearchQuery = '';
  renderDirectoryBody(mainView);
}

function renderDirectoryBody(mainView) {
  const isVenues = directoryTab === 'venues';
  const sorts = isVenues ? VENUE_SORTS : DIRECTORY_SORTS;
  const searchPlaceholder = isVenues ? 'Search name, city…' : 'Search name, city, chapter, skills…';

  mainView.innerHTML = `
    <h2>Directory</h2>
    <div class="crew-tabs">
      ${DIRECTORY_TABS.map(([key, label]) => `<button class="crew-tab tab-btn ${directoryTab === key ? 'active' : ''}" data-tab="${key}">${label}</button>`).join('')}
    </div>
    <p class="admin-note">${isVenues ? 'Event spaces the guild works with.' : 'Every member of the guild — contact info and management, in one place.'} Changes save immediately.${!isVenues && directoryNewIds.size ? ` ${directoryNewIds.size} new since you last checked, tagged below.` : ''}</p>
    <div class="admin-toolbar">
      <input type="text" id="dirSearchInput" class="admin-search" placeholder="${searchPlaceholder}" value="${escapeHtml(directorySearchQuery)}" autocomplete="off" name="dir-search-${Date.now()}" data-1p-ignore data-lpignore="true" data-bwignore="true" data-form-type="other">
      <label class="admin-sort-control">Sort by
        <select id="dirSortSelect">
          ${Object.entries(sorts).map(([key, s]) => `<option value="${key}" ${key === directorySortKey ? 'selected' : ''}>${s.label}</option>`).join('')}
        </select>
      </label>
      <button class="gm-btn" id="dirAddToggleBtn" style="background:var(--surface);color:var(--cream);">${isVenues ? '+ Add Venue' : '+ Add Member'}</button>
    </div>
    ${isVenues ? `
    <div class="card new-project-form" id="dirAddForm">
      <div class="field-row"><label>Name</label><input type="text" id="vName" placeholder="e.g. The Junkyard"></div>
      <div class="field-row"><label>City</label><input type="text" id="vCity" placeholder="Optional"></div>
      <div class="field-row"><label>Address</label><input type="text" id="vAddress" placeholder="Optional"></div>
      <div class="field-row"><label>Contact Name</label><input type="text" id="vContactName" placeholder="Optional"></div>
      <div class="field-row"><label>Contact Email</label><input type="email" id="vContactEmail" placeholder="Optional"></div>
      <div class="field-row"><label>Contact Phone</label><input type="tel" id="vContactPhone" placeholder="Optional"></div>
      <div class="field-row"><label>Website</label><input type="text" id="vWebsite" placeholder="Optional"></div>
      <div class="field-row"><label>Notes</label><input type="text" id="vNotes" placeholder="Optional"></div>
      <div class="form-actions">
        <button class="composer-submit" id="dirAddCreateBtn">Add</button>
        <button class="gm-btn" id="dirAddCancelBtn" style="background:var(--surface);color:var(--cream);">Cancel</button>
      </div>
    </div>` : `
    <div class="card new-project-form" id="dirAddForm">
      <div class="field-row"><label>Name</label><input type="text" id="nmName" placeholder="e.g. Amelia"></div>
      <div class="field-row"><label>Email</label><input type="email" id="nmEmail" placeholder="e.g. amelia@example.com"></div>
      <div class="field-row"><label>Password</label><input type="password" id="nmPassword" minlength="6" placeholder="At least 6 characters"></div>
      <div class="field-row"><label>Home Chapter</label>
        <select id="nmChapter">
          <option value="">No chapter</option>
          ${chapters.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field-row"><label>City</label><input type="text" id="nmCity" placeholder="Optional"></div>
      <div class="field-row"><label>Phone</label><input type="tel" id="nmPhone" placeholder="Optional"></div>
      <div class="field-row"><label>Instagram</label><input type="text" id="nmInstagram" placeholder="@handle — optional"></div>
      <label class="auth-org-toggle" style="margin-bottom:0;">
        <input type="checkbox" id="nmIsOrganization" ${directoryTab === 'organizations' ? 'checked' : ''}>
        This is an organization, not an individual
      </label>
      <p class="admin-note">Give them the email and password directly — that's how they'll sign in.</p>
      <div class="form-actions">
        <button class="composer-submit" id="dirAddCreateBtn">Add</button>
        <button class="gm-btn" id="dirAddCancelBtn" style="background:var(--surface);color:var(--cream);">Cancel</button>
      </div>
    </div>`}
    <div class="admin-list" id="directoryList"></div>
  `;

  mainView.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchDirectoryTab(mainView, btn.dataset.tab));
  });

  document.getElementById('dirSortSelect').addEventListener('change', e => {
    directorySortKey = e.target.value;
    renderDirectoryRows();
  });
  document.getElementById('dirSearchInput').addEventListener('input', e => {
    directorySearchQuery = e.target.value;
    renderDirectoryRows();
  });

  document.getElementById('dirAddToggleBtn').addEventListener('click', () => document.getElementById('dirAddForm').classList.toggle('open'));
  document.getElementById('dirAddCancelBtn').addEventListener('click', () => document.getElementById('dirAddForm').classList.remove('open'));

  if (isVenues) {
    document.getElementById('dirAddCreateBtn').addEventListener('click', async () => {
      const name = document.getElementById('vName').value.trim();
      if (!name) { alert('Venue name is required.'); return; }
      try {
        await apiFetch('/api/venues', {
          method: 'POST',
          body: {
            name,
            city: document.getElementById('vCity').value.trim() || null,
            address: document.getElementById('vAddress').value.trim() || null,
            contact_name: document.getElementById('vContactName').value.trim() || null,
            contact_email: document.getElementById('vContactEmail').value.trim() || null,
            contact_phone: document.getElementById('vContactPhone').value.trim() || null,
            website: document.getElementById('vWebsite').value.trim() || null,
            notes: document.getElementById('vNotes').value.trim() || null,
          },
        });
      } catch (e) {
        alert(`Couldn't add venue: ${e.message}`);
        return;
      }
      const { venues } = await apiFetch('/api/venues');
      directoryVenuesCache = venues || [];
      renderDirectoryBody(mainView);
    });
  } else {
    document.getElementById('dirAddCreateBtn').addEventListener('click', async () => {
      const display_name = document.getElementById('nmName').value.trim();
      const email = document.getElementById('nmEmail').value.trim();
      const password = document.getElementById('nmPassword').value;
      if (!display_name || !email || !password) { alert('Name, email, and password are all required.'); return; }
      try {
        await apiFetch('/api/members', {
          method: 'POST',
          body: {
            display_name, email, password,
            home_chapter_id: document.getElementById('nmChapter').value || null,
            city: document.getElementById('nmCity').value.trim() || null,
            phone: document.getElementById('nmPhone').value.trim() || null,
            instagram_handle: document.getElementById('nmInstagram').value.trim() || null,
            is_organization: document.getElementById('nmIsOrganization').checked,
          },
        });
      } catch (e) {
        alert(`Couldn't add member: ${e.message}`);
        return;
      }
      const { members } = await apiFetch('/api/members');
      directoryMembersCache = members || [];
      renderDirectoryBody(mainView);
    });
  }

  renderDirectoryRows();
}

function renderDirectoryRows() {
  if (directoryTab === 'venues') { renderVenueRows(); return; }
  renderMemberRows();
}

function renderMemberRows() {
  const list = document.getElementById('directoryList');
  if (!list) return;

  const q = directorySearchQuery.trim().toLowerCase();
  const wantOrg = directoryTab === 'organizations';
  const filtered = directoryMembersCache.filter(m =>
    !!m.is_organization === wantOrg &&
    (!q || m.display_name.toLowerCase().includes(q) || (m.city || '').toLowerCase().includes(q) || (m.home_chapter?.name || '').toLowerCase().includes(q) || (m.skills || '').toLowerCase().includes(q))
  );
  const sorted = [...filtered].sort(DIRECTORY_SORTS[directorySortKey].cmp);

  list.innerHTML = sorted.map(m => {
    const hasRealEmail = m.email && !m.email.endsWith('@crew.local');
    const igHandle = m.instagram_handle ? m.instagram_handle.replace(/^@/, '') : '';
    const metaRows = [
      m.skills ? ['Skills', m.skills] : null,
      m.birthday ? ['Birthday', m.birthday] : null,
      m.knows_who ? ['Knows', m.knows_who] : null,
      m.heard_about_us ? ['Heard about us via', m.heard_about_us] : null,
      m.materials_to_donate ? ['Materials to donate', m.materials_to_donate] : null,
    ].filter(Boolean);
    return `
    <div class="admin-row dir-row" data-user-id="${m.id}" style="border-left-color: ${memberDisplayColor(m)};">
      <div class="admin-identity">
        <div class="admin-name">
          ${escapeHtml(m.display_name)}
          ${m.is_organization ? `<span class="org-badge">Organization</span>` : `<span class="dir-rank-tag" style="color:${rankColor(m.rank)};border-color:${rankColor(m.rank)};">${rankLabel(m.rank)}</span>`}
          ${directoryNewIds.has(m.id) ? `<span class="dir-new-tag">New</span>` : ''}
        </div>
        <div class="admin-chapter">${m.home_chapter ? escapeHtml(m.home_chapter.name) : 'No chapter'}${m.city ? ` · ${escapeHtml(m.city)}` : ''}</div>
        <div class="dir-contacts">
          ${hasRealEmail ? `<a class="dir-contact-link" href="mailto:${escapeHtml(m.email)}">${escapeHtml(m.email)}</a>` : '<span class="dir-contact-empty">No email on file</span>'}
          ${m.phone ? `<a class="dir-contact-link" href="tel:${escapeHtml(m.phone)}">${escapeHtml(m.phone)}</a>` : ''}
          ${igHandle ? `<a class="dir-contact-link" href="https://instagram.com/${encodeURIComponent(igHandle)}" target="_blank" rel="noopener">@${escapeHtml(igHandle)}</a>` : ''}
        </div>
        ${metaRows.length ? `<div class="dir-meta">${metaRows.map(([label, value]) => `<div class="dir-meta-row"><span class="dir-meta-label">${escapeHtml(label)}:</span> ${escapeHtml(value)}</div>`).join('')}</div>` : ''}
      </div>
      <div class="dir-manage">
        ${m.is_organization
          ? `<span class="org-badge">Organization</span>`
          : `<select class="admin-rank" data-field="rank" style="color: ${rankColor(m.rank)};">
               ${RANKS.map(r => `<option value="${r}" ${m.rank === r ? 'selected' : ''}>${rankLabel(r)}</option>`).join('')}
             </select>`}
        <label class="admin-ringleader-toggle">
          <input type="checkbox" data-field="is_organization" ${m.is_organization ? 'checked' : ''}>
          Organization
        </label>
        <label class="admin-ringleader-toggle">
          <input type="checkbox" data-field="is_ringleader" ${m.is_ringleader ? 'checked' : ''}>
          Ringleader
        </label>
        <label class="admin-ringleader-toggle" title="Inner members get boards, DMs, the Hub and tickets; unchecked = courtyard">
          <input type="checkbox" data-field="tier" ${m.tier === 'inner' || m.is_ringleader ? 'checked' : ''} ${m.is_ringleader ? 'disabled' : ''}>
          Inner
        </label>
        <label class="admin-ringleader-toggle">
          <input type="checkbox" data-field="dues_paid" ${m.dues_paid ? 'checked' : ''}>
          Dues Paid
        </label>
        <input type="text" class="admin-dues-amount" data-field="dues_amount" placeholder="Amount" value="${escapeHtml(m.dues_amount || '')}">
        <input type="date" class="admin-dues-date" data-field="dues_date" value="${escapeHtml(m.dues_date || '')}">
        <button class="gm-btn admin-passport-btn" data-passport="${m.id}" style="background:var(--surface-2);color:var(--gold-bright);">Passport</button>
        <button class="gm-btn admin-edit-btn" data-edit="${m.id}" style="background:var(--surface-2);color:var(--gold-bright);">Edit</button>
      </div>
    </div>
  `; }).join('') || '<div class="placeholder-note">No members match.</div>';

  list.querySelectorAll('.admin-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => openMemberEditModal(btn.dataset.edit));
  });
  list.querySelectorAll('.admin-passport-btn').forEach(btn => {
    btn.addEventListener('click', () => openPassportModal(btn.dataset.passport));
  });

  list.querySelectorAll('.dir-row').forEach(row => {
    const userId = row.dataset.userId;
    const member = directoryMembersCache.find(m => m.id === userId);

    const patchField = async (field, value) => {
      try {
        await apiFetch(`/api/members/${userId}`, { method: 'PATCH', body: { [field]: value } });
      } catch (e) {
        alert(`Couldn't save: ${e.message}`);
        renderDirectoryRows();
        return;
      }
      member[field] = value;
      if (userId === profile.id && (field === 'rank' || field === 'is_ringleader')) { await refreshProfile(); renderShell(); }
      if (field === 'rank' && !member.is_organization) {
        row.style.borderLeftColor = rankColor(value);
        const rankSelect = row.querySelector('[data-field="rank"]');
        if (rankSelect) rankSelect.style.color = rankColor(value);
      }
      if (field === 'is_organization') { renderDirectoryRows(); return; }
      const affectsSort = (directorySortKey === 'rank' && (field === 'rank' || field === 'is_ringleader')) || (directorySortKey === 'dues' && field === 'dues_paid');
      if (affectsSort) renderDirectoryRows();
    };

    row.querySelector('[data-field="rank"]')?.addEventListener('change', e => patchField('rank', e.target.value));
    row.querySelector('[data-field="is_organization"]').addEventListener('change', e => patchField('is_organization', e.target.checked));
    row.querySelector('[data-field="is_ringleader"]').addEventListener('change', e => patchField('is_ringleader', e.target.checked));
    row.querySelector('[data-field="tier"]').addEventListener('change', e => patchField('tier', e.target.checked ? 'inner' : 'courtyard'));
    row.querySelector('[data-field="dues_paid"]').addEventListener('change', e => patchField('dues_paid', e.target.checked));
    row.querySelector('[data-field="dues_amount"]').addEventListener('change', e => patchField('dues_amount', e.target.value));
    row.querySelector('[data-field="dues_date"]').addEventListener('change', e => patchField('dues_date', e.target.value));
  });
}


function openMemberEditModal(userId) {
  const member = directoryMembersCache.find(m => m.id === userId);
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
        <div class="field-row"><label>City</label><input type="text" id="aeCity" value="${escapeHtml(member.city || '')}"></div>
        <div class="field-row"><label>Phone</label><input type="tel" id="aePhone" value="${escapeHtml(member.phone || '')}"></div>
        <div class="field-row"><label>Instagram</label><input type="text" id="aeInstagram" placeholder="@handle" value="${escapeHtml(member.instagram_handle || '')}"></div>
        <div class="field-row"><label>Who they know</label><input type="text" id="aeKnowsWho" value="${escapeHtml(member.knows_who || '')}"></div>
        <div class="field-row"><label>Heard about us via</label><input type="text" id="aeHeardAbout" value="${escapeHtml(member.heard_about_us || '')}"></div>
        <div class="field-row"><label>Materials to donate</label><input type="text" id="aeMaterials" value="${escapeHtml(member.materials_to_donate || '')}"></div>
        <div class="field-row"><label>Email</label><input type="email" id="aeEmail" value="${escapeHtml(member.email && !member.email.endsWith('@crew.local') ? member.email : '')}" placeholder="${member.email && member.email.endsWith('@crew.local') ? 'No real email on file yet — add one' : ''}"></div>
        <div class="field-row"><label>Set New Password</label><input type="password" id="aePassword" minlength="6" placeholder="Leave blank to keep current"></div>
      </div>
      <div class="admin-edit-modal-footer">
        <button class="composer-submit" id="aeSaveBtn">Save</button>
        <button class="gm-btn" id="aeCancelBtn" style="background:var(--surface);color:var(--cream);">Cancel</button>
        ${userId !== profile.id ? `<button class="gm-btn" id="aeDeleteBtn" style="background:var(--surface-2);color:#E08A8A;margin-left:auto;">Delete Member</button>` : ''}
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('#aeDeleteBtn')?.addEventListener('click', async () => {
    if (!confirm(`Permanently delete ${member.display_name}? This can't be undone.`)) return;
    try {
      await apiFetch(`/api/members/${userId}`, { method: 'DELETE' });
    } catch (e) {
      alert(`Couldn't delete: ${e.message}`);
      return;
    }
    directoryMembersCache = directoryMembersCache.filter(m => m.id !== userId);
    close();
    renderDirectoryRows();
  });
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
      city: overlay.querySelector('#aeCity').value.trim() || null,
      phone: overlay.querySelector('#aePhone').value.trim() || null,
      instagram_handle: overlay.querySelector('#aeInstagram').value.trim() || null,
      knows_who: overlay.querySelector('#aeKnowsWho').value.trim() || null,
      heard_about_us: overlay.querySelector('#aeHeardAbout').value.trim() || null,
      materials_to_donate: overlay.querySelector('#aeMaterials').value.trim() || null,
    };
    const newEmail = overlay.querySelector('#aeEmail').value.trim();
    if (newEmail) body.email = newEmail;
    const newPassword = overlay.querySelector('#aePassword').value;
    if (newPassword) body.password = newPassword;
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
    renderDirectoryRows();
  });
}

function renderVenueRows() {
  const list = document.getElementById('directoryList');
  if (!list) return;

  const q = directorySearchQuery.trim().toLowerCase();
  const filtered = directoryVenuesCache.filter(v =>
    !q || v.name.toLowerCase().includes(q) || (v.city || '').toLowerCase().includes(q)
  );
  const sorted = [...filtered].sort(VENUE_SORTS[directorySortKey].cmp);

  list.innerHTML = sorted.map(v => {
    const metaRows = [
      v.address ? ['Address', v.address] : null,
      v.notes ? ['Notes', v.notes] : null,
    ].filter(Boolean);
    return `
    <div class="admin-row dir-row" data-venue-id="${v.id}" style="border-left-color: var(--gold);">
      <div class="admin-identity">
        <div class="admin-name">${escapeHtml(v.name)}</div>
        <div class="admin-chapter">${v.city ? escapeHtml(v.city) : 'No city on file'}</div>
        <div class="dir-contacts">
          ${v.contact_name ? `<span class="dir-contact-empty">${escapeHtml(v.contact_name)}</span>` : ''}
          ${v.contact_email ? `<a class="dir-contact-link" href="mailto:${escapeHtml(v.contact_email)}">${escapeHtml(v.contact_email)}</a>` : ''}
          ${v.contact_phone ? `<a class="dir-contact-link" href="tel:${escapeHtml(v.contact_phone)}">${escapeHtml(v.contact_phone)}</a>` : ''}
          ${v.website ? `<a class="dir-contact-link" href="${escapeHtml(/^https?:\/\//.test(v.website) ? v.website : 'https://' + v.website)}" target="_blank" rel="noopener">${escapeHtml(v.website)}</a>` : ''}
        </div>
        ${metaRows.length ? `<div class="dir-meta">${metaRows.map(([label, value]) => `<div class="dir-meta-row"><span class="dir-meta-label">${escapeHtml(label)}:</span> ${escapeHtml(value)}</div>`).join('')}</div>` : ''}
      </div>
      <div class="dir-manage">
        <button class="gm-btn venue-edit-btn" data-edit="${v.id}" style="background:var(--surface-2);color:var(--gold-bright);">Edit</button>
        <button class="gm-btn venue-delete-btn" data-delete="${v.id}" style="background:var(--surface-2);color:#E08A8A;">Delete</button>
      </div>
    </div>
  `; }).join('') || '<div class="placeholder-note">No venues match.</div>';

  list.querySelectorAll('.venue-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => openVenueEditModal(btn.dataset.edit));
  });
  list.querySelectorAll('.venue-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const venue = directoryVenuesCache.find(v => v.id === btn.dataset.delete);
      if (!venue || !confirm(`Remove "${venue.name}" from venues?`)) return;
      try {
        await apiFetch(`/api/venues/${btn.dataset.delete}`, { method: 'DELETE' });
      } catch (e) {
        alert(`Couldn't remove venue: ${e.message}`);
        return;
      }
      directoryVenuesCache = directoryVenuesCache.filter(v => v.id !== btn.dataset.delete);
      renderVenueRows();
    });
  });
}

function openVenueEditModal(venueId) {
  const venue = directoryVenuesCache.find(v => v.id === venueId);
  if (!venue) return;

  const overlay = document.createElement('div');
  overlay.className = 'admin-edit-overlay open';
  overlay.innerHTML = `
    <div class="admin-edit-modal">
      <div class="admin-edit-modal-header">
        <h3>Edit ${escapeHtml(venue.name)}</h3>
        <button id="veEditClose">&times;</button>
      </div>
      <div class="admin-edit-modal-body">
        <div class="field-row"><label>Name</label><input type="text" id="veName" value="${escapeHtml(venue.name)}"></div>
        <div class="field-row"><label>City</label><input type="text" id="veCity" value="${escapeHtml(venue.city || '')}"></div>
        <div class="field-row"><label>Address</label><input type="text" id="veAddress" value="${escapeHtml(venue.address || '')}"></div>
        <div class="field-row"><label>Contact Name</label><input type="text" id="veContactName" value="${escapeHtml(venue.contact_name || '')}"></div>
        <div class="field-row"><label>Contact Email</label><input type="email" id="veContactEmail" value="${escapeHtml(venue.contact_email || '')}"></div>
        <div class="field-row"><label>Contact Phone</label><input type="tel" id="veContactPhone" value="${escapeHtml(venue.contact_phone || '')}"></div>
        <div class="field-row"><label>Website</label><input type="text" id="veWebsite" value="${escapeHtml(venue.website || '')}"></div>
        <div class="field-row"><label>Notes</label><input type="text" id="veNotes" value="${escapeHtml(venue.notes || '')}"></div>
      </div>
      <div class="admin-edit-modal-footer">
        <button class="composer-submit" id="veSaveBtn">Save</button>
        <button class="gm-btn" id="veCancelBtn" style="background:var(--surface);color:var(--cream);">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('#veEditClose').addEventListener('click', close);
  overlay.querySelector('#veCancelBtn').addEventListener('click', close);
  overlay.querySelector('#veSaveBtn').addEventListener('click', async () => {
    const name = overlay.querySelector('#veName').value.trim();
    if (!name) { alert('Venue name is required.'); return; }
    const body = {
      name,
      city: overlay.querySelector('#veCity').value.trim() || null,
      address: overlay.querySelector('#veAddress').value.trim() || null,
      contact_name: overlay.querySelector('#veContactName').value.trim() || null,
      contact_email: overlay.querySelector('#veContactEmail').value.trim() || null,
      contact_phone: overlay.querySelector('#veContactPhone').value.trim() || null,
      website: overlay.querySelector('#veWebsite').value.trim() || null,
      notes: overlay.querySelector('#veNotes').value.trim() || null,
    };
    try {
      await apiFetch(`/api/venues/${venueId}`, { method: 'PATCH', body });
    } catch (e) {
      alert(`Couldn't save: ${e.message}`);
      return;
    }
    Object.assign(venue, body);
    close();
    renderVenueRows();
  });
}

// ── Impact Log — own top-level Ringleader page (not a Directory tab).
// Shares directoryVenuesCache/directoryImpactCache/directorySortKey/
// directorySearchQuery and the directoryList/dirAdd* element ids with
// Directory purely for code reuse — the two views never render at once.
async function renderImpactView(mainView) {
  if (!profile?.is_ringleader) {
    mainView.innerHTML = `<h2>Not authorized</h2><div class="placeholder-note">Ringleaders only.</div>`;
    return;
  }
  mainView.innerHTML = `<h2>Impact Log</h2><div class="placeholder-note">Loading…</div>`;

  const [{ venues }, { logs }] = await Promise.all([
    apiFetch('/api/venues'),
    apiFetch('/api/impact-logs'),
  ]);
  directoryVenuesCache = venues || [];
  directoryImpactCache = logs || [];
  directorySortKey = 'date';
  directorySearchQuery = '';

  renderImpactBody(mainView);
}

function renderImpactBody(mainView) {
  mainView.innerHTML = `
    <h2>Impact Log</h2>
    <p class="admin-note">Travel, materials, and waste data per event — feeds the B Corp Climate Action and Environmental Stewardship topics. Changes save immediately.</p>
    <div class="admin-toolbar">
      <input type="text" id="dirSearchInput" class="admin-search" placeholder="Search event, venue…" value="${escapeHtml(directorySearchQuery)}" autocomplete="off" name="impact-search-${Date.now()}" data-1p-ignore data-lpignore="true" data-bwignore="true" data-form-type="other">
      <label class="admin-sort-control">Sort by
        <select id="dirSortSelect">
          ${Object.entries(IMPACT_SORTS).map(([key, s]) => `<option value="${key}" ${key === directorySortKey ? 'selected' : ''}>${s.label}</option>`).join('')}
        </select>
      </label>
      <button class="gm-btn" id="dirAddToggleBtn" style="background:var(--surface);color:var(--cream);">+ Log an Event</button>
    </div>
    <div class="card new-project-form" id="dirAddForm">
      <div class="field-row"><label>Date</label><input type="date" id="ilDate"></div>
      <div class="field-row"><label>Event Name</label><input type="text" id="ilName" placeholder="e.g. Halloween Carnival"></div>
      <div class="field-row"><label>Venue</label>
        <select id="ilVenue">
          <option value="">No venue on file</option>
          ${directoryVenuesCache.map(v => `<option value="${v.id}">${escapeHtml(v.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field-row"><label>Round-trip Travel (miles)</label><input type="number" step="0.1" id="ilMiles" placeholder="Optional"></div>
      <div class="field-row"><label>Travel Mode</label><input type="text" id="ilMode" placeholder="e.g. van, personal cars — optional"></div>
      <div class="field-row"><label>Material Sourcing</label><input type="text" id="ilMaterials" placeholder="e.g. donated wood + upcycled electronics"></div>
      <div class="field-row"><label>Waste Generated</label><input type="text" id="ilWasteGen" placeholder="e.g. 2 bags — optional"></div>
      <div class="field-row"><label>Waste Diverted</label><input type="text" id="ilWasteDiv" placeholder="e.g. all materials returned to storage for reuse"></div>
      <div class="field-row"><label>Notes</label><input type="text" id="ilNotes" placeholder="Optional"></div>
      <div class="form-actions">
        <button class="composer-submit" id="dirAddCreateBtn">Add</button>
        <button class="gm-btn" id="dirAddCancelBtn" style="background:var(--surface);color:var(--cream);">Cancel</button>
      </div>
    </div>
    <div class="admin-list" id="directoryList"></div>
  `;

  document.getElementById('dirSortSelect').addEventListener('change', e => {
    directorySortKey = e.target.value;
    renderImpactRows();
  });
  document.getElementById('dirSearchInput').addEventListener('input', e => {
    directorySearchQuery = e.target.value;
    renderImpactRows();
  });
  document.getElementById('dirAddToggleBtn').addEventListener('click', () => document.getElementById('dirAddForm').classList.toggle('open'));
  document.getElementById('dirAddCancelBtn').addEventListener('click', () => document.getElementById('dirAddForm').classList.remove('open'));
  document.getElementById('dirAddCreateBtn').addEventListener('click', async () => {
    const event_date = document.getElementById('ilDate').value;
    const event_name = document.getElementById('ilName').value.trim();
    if (!event_date || !event_name) { alert('Date and event name are required.'); return; }
    try {
      await apiFetch('/api/impact-logs', {
        method: 'POST',
        body: {
          event_date,
          event_name,
          venue_id: document.getElementById('ilVenue').value || null,
          travel_miles: document.getElementById('ilMiles').value ? Number(document.getElementById('ilMiles').value) : null,
          travel_mode: document.getElementById('ilMode').value.trim() || null,
          material_sourcing: document.getElementById('ilMaterials').value.trim() || null,
          waste_generated: document.getElementById('ilWasteGen').value.trim() || null,
          waste_diverted: document.getElementById('ilWasteDiv').value.trim() || null,
          notes: document.getElementById('ilNotes').value.trim() || null,
        },
      });
    } catch (e) {
      alert(`Couldn't add log: ${e.message}`);
      return;
    }
    const { logs } = await apiFetch('/api/impact-logs');
    directoryImpactCache = logs || [];
    renderImpactBody(mainView);
  });

  renderImpactRows();
}

function renderImpactRows() {
  const list = document.getElementById('directoryList');
  const q = directorySearchQuery.trim().toLowerCase();
  const filtered = directoryImpactCache.filter(l =>
    !q || l.event_name.toLowerCase().includes(q) || (l.venue_name || '').toLowerCase().includes(q)
  );
  const sorted = [...filtered].sort(IMPACT_SORTS[directorySortKey].cmp);

  list.innerHTML = sorted.map(l => {
    const metaRows = [
      l.travel_miles != null ? ['Travel', `${l.travel_miles} mi${l.travel_mode ? ` (${l.travel_mode})` : ''}`] : null,
      l.material_sourcing ? ['Materials', l.material_sourcing] : null,
      l.waste_generated ? ['Waste generated', l.waste_generated] : null,
      l.waste_diverted ? ['Waste diverted', l.waste_diverted] : null,
      l.notes ? ['Notes', l.notes] : null,
    ].filter(Boolean);
    return `
    <div class="admin-row dir-row" data-log-id="${l.id}" style="border-left-color: var(--gold);">
      <div class="admin-identity">
        <div class="admin-name">${escapeHtml(l.event_name)}</div>
        <div class="admin-chapter">${l.event_date}${l.venue_name ? ` — ${escapeHtml(l.venue_name)}` : ''}</div>
        ${metaRows.length ? `<div class="dir-meta">${metaRows.map(([label, value]) => `<div class="dir-meta-row"><span class="dir-meta-label">${escapeHtml(label)}:</span> ${escapeHtml(value)}</div>`).join('')}</div>` : '<div class="placeholder-note">No data logged yet — edit to fill in.</div>'}
      </div>
      <div class="dir-manage">
        <button class="gm-btn impact-edit-btn" data-edit="${l.id}" style="background:var(--surface-2);color:var(--gold-bright);">Edit</button>
        <button class="gm-btn impact-delete-btn" data-delete="${l.id}" style="background:var(--surface-2);color:#E08A8A;">Delete</button>
      </div>
    </div>
  `; }).join('') || '<div class="placeholder-note">No events logged yet.</div>';

  list.querySelectorAll('.impact-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => openImpactEditModal(btn.dataset.edit));
  });
  list.querySelectorAll('.impact-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const log = directoryImpactCache.find(l => l.id === btn.dataset.delete);
      if (!log || !confirm(`Remove the log for "${log.event_name}"?`)) return;
      try {
        await apiFetch(`/api/impact-logs/${btn.dataset.delete}`, { method: 'DELETE' });
      } catch (e) {
        alert(`Couldn't remove log: ${e.message}`);
        return;
      }
      directoryImpactCache = directoryImpactCache.filter(l => l.id !== btn.dataset.delete);
      renderImpactRows();
    });
  });
}

function openImpactEditModal(logId) {
  const log = directoryImpactCache.find(l => l.id === logId);
  if (!log) return;

  const overlay = document.createElement('div');
  overlay.className = 'admin-edit-overlay open';
  overlay.innerHTML = `
    <div class="admin-edit-modal">
      <div class="admin-edit-modal-header">
        <h3>Edit ${escapeHtml(log.event_name)}</h3>
        <button id="ieEditClose">&times;</button>
      </div>
      <div class="admin-edit-modal-body">
        <div class="field-row"><label>Date</label><input type="date" id="ieDate" value="${escapeHtml(log.event_date || '')}"></div>
        <div class="field-row"><label>Event Name</label><input type="text" id="ieName" value="${escapeHtml(log.event_name)}"></div>
        <div class="field-row"><label>Venue</label>
          <select id="ieVenue">
            <option value="">No venue on file</option>
            ${directoryVenuesCache.map(v => `<option value="${v.id}" ${log.venue_id === v.id ? 'selected' : ''}>${escapeHtml(v.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field-row"><label>Round-trip Travel (miles)</label><input type="number" step="0.1" id="ieMiles" value="${log.travel_miles ?? ''}"></div>
        <div class="field-row"><label>Travel Mode</label><input type="text" id="ieMode" value="${escapeHtml(log.travel_mode || '')}"></div>
        <div class="field-row"><label>Material Sourcing</label><input type="text" id="ieMaterials" value="${escapeHtml(log.material_sourcing || '')}"></div>
        <div class="field-row"><label>Waste Generated</label><input type="text" id="ieWasteGen" value="${escapeHtml(log.waste_generated || '')}"></div>
        <div class="field-row"><label>Waste Diverted</label><input type="text" id="ieWasteDiv" value="${escapeHtml(log.waste_diverted || '')}"></div>
        <div class="field-row"><label>Notes</label><input type="text" id="ieNotes" value="${escapeHtml(log.notes || '')}"></div>
      </div>
      <div class="admin-edit-modal-footer">
        <button class="composer-submit" id="ieSaveBtn">Save</button>
        <button class="gm-btn" id="ieCancelBtn" style="background:var(--surface);color:var(--cream);">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('#ieEditClose').addEventListener('click', close);
  overlay.querySelector('#ieCancelBtn').addEventListener('click', close);
  overlay.querySelector('#ieSaveBtn').addEventListener('click', async () => {
    const event_date = overlay.querySelector('#ieDate').value;
    const event_name = overlay.querySelector('#ieName').value.trim();
    if (!event_date || !event_name) { alert('Date and event name are required.'); return; }
    const milesVal = overlay.querySelector('#ieMiles').value;
    const body = {
      event_date,
      event_name,
      venue_id: overlay.querySelector('#ieVenue').value || null,
      travel_miles: milesVal ? Number(milesVal) : null,
      travel_mode: overlay.querySelector('#ieMode').value.trim() || null,
      material_sourcing: overlay.querySelector('#ieMaterials').value.trim() || null,
      waste_generated: overlay.querySelector('#ieWasteGen').value.trim() || null,
      waste_diverted: overlay.querySelector('#ieWasteDiv').value.trim() || null,
      notes: overlay.querySelector('#ieNotes').value.trim() || null,
    };
    try {
      const { log: updated } = await apiFetch(`/api/impact-logs/${logId}`, { method: 'PATCH', body });
      Object.assign(log, updated);
    } catch (e) {
      alert(`Couldn't save: ${e.message}`);
      return;
    }
    close();
    renderImpactRows();
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
          <button class="gm-btn gm-legend-toggle-btn" id="gmLegendToggle">☰ Info</button>
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
  const isMobile = window.matchMedia('(max-width: 800px)').matches;
  const fieldZoom = d3.zoom().scaleExtent([isMobile ? 0.4 : 0.15, 4]).on('zoom', e => zg.attr('transform', e.transform));
  svg.call(fieldZoom);
  if (isMobile) svg.call(fieldZoom.scaleTo, 0.7);

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
      ng.append('circle').attr('class', 'gm-node-hit').attr('r', 16);
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
  document.getElementById('gmLegendToggle').addEventListener('click', () => document.getElementById('gmLegend').classList.toggle('open'));
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

Live member roster and dues status: see **Directory**.` },

  { id: 'bcorp-legal', title: 'Legal Structure', content: `# CSI Legal Structure

*(Draft — decision pending, not yet acted on)*

## Why This Exists Now

The Charter closes with "Carnival Society International is a Guerrilla Concerto institution," but that line doesn't tell a venue who signs a contract, who carries insurance, or who gets paid. With Baker House (Oct 31) and Junkyard Social Club (Dec 26) both becoming real bookings, this stops being theoretical.

## The Two Things People Mean by "B Corp"

**Certified B Corporation** — a certification from B Lab, layered on top of *any* existing legal structure (LLC, standard corporation, nonprofit). Requires an online impact assessment and integrating stakeholder commitments into governing documents. Doesn't change what entity CSI is — it's a badge on top of one.

**Benefit Corporation** — an actual legal entity type, available under Colorado law. Requires filing Articles of Incorporation stating a general public benefit, a Colorado registered agent, a board and bylaws, and ongoing operation toward that stated purpose alongside profit.

A corporation can be both — neither requires the other.

## Decision Made (2026-09-29)

Lewis Neeff owns the B Corp outright. See **B Corp Roadmap** for the ordered path this leads to.

## Open Question

Is Guerrilla Concerto already a formal legal entity, or just a name? If incorporated, some roadmap steps shrink to "add a d/b/a." If not, CSI currently has no legal entity behind any booking.` },

  { id: 'bcorp-roadmap', title: 'B Corp Roadmap', content: `# CSI B Corp Roadmap

Decision made 2026-09-29: Lewis Neeff owns the B Corp outright. Ordered path from no legal entity to certified B Corp.

## Phase 1 — Stand up the legal entity
- Confirm Guerrilla Concerto's legal status (entity, sole prop, or name only)
- Choose entity type: LLC or corporation
- Pick and retain a Colorado registered agent (physical CO address, no PO box)
- File formation documents with the Colorado Secretary of State
- Get an EIN from the IRS
- Open a real business bank account — this becomes the actual Carnival Operating Fund
- Draft and adopt bylaws / operating agreement
- Decide now whether to elect Colorado's benefit-corporation status at formation (cheap now, costly to amend later)

## Phase 2 — Get certification-ready
B Lab retired the old 200-point/80-point system. New submissions since March 2026 go on **V2 standards** — mandatory minimum requirements across 7 Impact Topics, sized to the company. Full breakdown: see **B Corp Assessment Prep**.
- Run the B Impact Assessment on V2
- Work through the Assessment Prep doc topic by topic
- Amend governing documents to legally require considering stakeholder impact, not just profit — required at any size

## Phase 3 — Certify
- Submit for B Lab audit/review
- Complete document review + disclosure questionnaire
- Pay the certification fee (tiered by revenue)
- Get certified; publish the badge
- Note the Year 3 / Year 5 improvement milestones now — certification isn't one-and-done

## Phase 4 — Operational cleanup (parallel, not blocking)
- Reissue venue-facing contracts (Baker House, Junkyard) under the entity, not Lewis personally
- Confirm general liability / event insurance under the entity
- Update the Charter's closing line once the entity is real

## Fork — The Long Game Reserve

The Charter's Long Game fund builds toward land, water, and a permanent site "held in common." Once CSI is a company Lewis owns outright, that reserve legally belongs to the company, and the company belongs to him — "held in common" becomes a cultural promise, not a legal fact. Not a blocker now. Revisit once the reserve holds real money: either leave it inside the B Corp (held in trust by intent and reputation), or split it into a separate vehicle — a land trust or an actual chartered cooperative — that owns the land independent of who owns the operating company.` },

  { id: 'bcorp-prep', title: 'B Corp Assessment Prep', content: `# CSI B Corp Assessment Prep

B Lab replaced the old point-scored assessment with **V2 standards**: no point score, mandatory minimum requirements across 7 Impact Topics, sized to the company. CSI certifies on V2.

## How V2 Works
- Requirements tailored to company size and sector — a tiny live-events guild gets far fewer sub-requirements than a manufacturer (range across all companies: 20-124)
- Year 0 to certify, then Year 3 and Year 5 requirements tighten over time — not one-and-done
- One Legal Requirement applies regardless of size: governing documents must legally require considering stakeholder impact, not just shareholder profit

## The 7 Topics, and Where CSI Stands

**1. Purpose & Stakeholder Governance** — already close to a model answer. The Charter's Long Game section measures success by community capacity and land progress, explicitly not revenue. Needs: an explicit annual-review cadence stated in the Charter, and this language carried into real bylaws once the entity exists.

**2. Fair Work** — Compensation & Support already reads like a real policy: explicit pay priority order, nothing owed unless agreed in advance. Needs: a paid-roster log once any money moves; an employee handbook only once anyone resembles an employee.

**3. Justice, Equity, Diversity & Inclusion (JEDI)** — genuinely strong without being labeled as such: free membership, door-registration-as-membership, Allied Orgs bringing in whole communities. Needs: writing this down explicitly as a JEDI policy, and capturing any demographic data on who's actually attending.

**4. Human Rights** — lightest lift. A one-line statement that partnerships won't proceed with orgs engaged in exploitative labor practices, plus citing the Participation Steward's existing halt authority.

**5. Climate Action** — weakest documented area currently. Fix: start logging build/event travel now (see Event Impact Log).

**6. Environmental Stewardship & Circularity** — partial. The Place & Living Systems Steward role exists on paper, unfilled. Fix: log material sourcing/reuse as it happens; fill the steward seat.

**7. Government Affairs & Collective Action** — nearly free. No lobbying; the Allied Organization network itself counts as collective action once named as such.

## Documents to Gather Before Submitting
- Payroll register / roster of anyone paid, once money moves
- Employee handbook (only once there's anyone resembling an employee)
- List of significant suppliers/partners (venues, Allied Orgs)
- The entity's actual bylaws

## The Honest Summary

CSI's existing governance writing already covers Purpose & Stakeholder Governance, Fair Work, and JEDI better than most companies starting from zero — a guild's worth of internal policy got written before certification was ever the goal. The real gaps are Climate Action and Environmental Stewardship, which need a small amount of new tracking, not new philosophy. Human Rights and Government Affairs are nearly free at this size.` },
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
      while (i < lines.length) {
        if (/^\d+\.\s+/.test(lines[i])) {
          let item = inline(lines[i].replace(/^\d+\.\s+/, ''));
          i++;
          // Indented lines right after a numbered line (a root/description
          // note under the tenet) belong to this item, not a new paragraph —
          // otherwise every item resets to "1." since the next numbered line
          // no longer looks consecutive to the parser.
          while (i < lines.length && /^\s+\S/.test(lines[i])) { item += `<br>${inline(lines[i].trim())}`; i++; }
          html += `<li>${item}</li>`;
        } else if (!lines[i].trim()) {
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j++;
          if (j < lines.length && /^\d+\.\s+/.test(lines[j])) { i = j; continue; }
          break;
        } else break;
      }
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
    <div class="gm-shell gm-shell-network">
      <div class="gm-body">
        <svg id="nwSvg"></svg>
        <button class="gm-btn gm-legend-toggle-btn nw-legend-toggle-btn" id="nwLegendToggle">☰ Info</button>
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
  document.getElementById('nwLegendToggle').onclick = () => document.getElementById('nwLegend').classList.toggle('open');

  if (!members.length) {
    document.querySelector('#nwSvg').closest('.gm-body').innerHTML = '<div class="gm-empty-note">No members yet.</div>';
    return;
  }

  const svgEl = document.getElementById('nwSvg');
  const W = svgEl.clientWidth || 900, H = svgEl.clientHeight || 600;
  const svg = d3.select('#nwSvg').attr('viewBox', `0 0 ${W} ${H}`);
  const zg = svg.append('g');
  const isMobile = window.matchMedia('(max-width: 800px)').matches;
  const nwZoom = d3.zoom().scaleExtent([isMobile ? 0.45 : 0.2, 3]).on('zoom', e => zg.attr('transform', e.transform));
  svg.call(nwZoom);
  if (isMobile) svg.call(nwZoom.scaleTo, 0.7);

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
    ng.append('circle').attr('class', 'gm-node-hit').attr('r', 18);
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
  let panel = 'content'; // 'content' | 'recap'

  mainView.innerHTML = `
    <div class="meetings-layout">
      <div class="leadership-docs-col">
        <div class="ld-header">
          <span>Meetings</span>
          <button class="ld-add-btn" id="mtAddBtn" title="Add a meeting doc">+ New</button>
        </div>
        <div class="ld-tabs" id="mtTabs" style="flex-direction:column;"></div>
      </div>
      <div class="meetings-main">
        <div id="mtContent" class="meeting-content-card"></div>
      </div>
    </div>
    <div class="gm-overlay" id="mtAddOverlay">
      <div class="gm-modal">
        <div class="gm-modal-header"><h3>New Meeting Doc</h3><button id="mtAddClose">&times;</button></div>
        <div class="gm-modal-body">
          <div class="field-row"><label>Title</label><input type="text" id="mtNewTitle" placeholder="e.g. Meeting 3 — Sign Painting"></div>
          <div class="field-row"><label>Date</label><input type="date" id="mtNewDate"></div>
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

  function formatMeetingDate(dateStr) {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function renderTabs() {
    tabsEl.innerHTML = list.map(m => `
      <button class="ld-tab ${m.id === activeId ? 'active' : ''}" data-meeting="${m.id}">
        ${escapeHtml(m.title)}${m.meeting_date ? `<span class="meeting-tab-date">${formatMeetingDate(m.meeting_date)}</span>` : ''}
      </button>
    `).join('');
    tabsEl.querySelectorAll('.ld-tab').forEach(t => t.addEventListener('click', () => { activeId = t.dataset.meeting; editing = false; panel = 'content'; renderTabs(); renderContent(); }));
  }

  function renderContent() {
    const doc = list.find(m => m.id === activeId);
    if (!doc) { contentEl.innerHTML = '<div class="placeholder-note">No meeting docs yet. Use "+ New" to add one.</div>'; return; }
    const field = panel === 'recap' ? 'recap' : 'content';
    const label = panel === 'recap' ? 'Meeting Recap' : 'Run of Show';
    if (editing) {
      contentEl.innerHTML = `
        <div class="post-actions" style="margin-bottom:0.6rem;">
          <button class="composer-submit" id="mtSaveBtn">Save</button>
          <button class="gm-btn" id="mtCancelEditBtn">Cancel</button>
        </div>
        <textarea id="mtEditContent" rows="24" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:3px;padding:0.7rem;color:var(--cream);font-family:inherit;">${escapeHtml(doc[field])}</textarea>
      `;
      document.getElementById('mtSaveBtn').addEventListener('click', async () => {
        const value = document.getElementById('mtEditContent').value;
        await apiFetch(`/api/meetings/${doc.id}`, { method: 'PATCH', body: { [field]: value } });
        doc[field] = value;
        editing = false;
        renderContent();
      });
      document.getElementById('mtCancelEditBtn').addEventListener('click', () => { editing = false; renderContent(); });
      return;
    }
    contentEl.innerHTML = `
      <div class="post-actions" style="margin-bottom:0.6rem;align-items:center;">
        ${doc.meeting_date ? `<span class="meeting-doc-date">${formatMeetingDate(doc.meeting_date)}</span>` : ''}
        <button class="action-btn" id="mtRecapBtn">${panel === 'recap' ? 'Run of Show' : 'Meeting Recap'}</button>
        <button class="action-btn" id="mtEditBtn">Edit</button>
        <button class="action-btn danger" id="mtDeleteBtn">Delete</button>
      </div>
      <h3 style="margin-top:0;">${label}</h3>
      ${renderMarkdown(doc[field] || (panel === 'recap' ? '*No recap yet — click Edit to add one.*' : '*Empty — click Edit to add content.*'))}
    `;
    document.getElementById('mtRecapBtn').addEventListener('click', () => { panel = panel === 'recap' ? 'content' : 'recap'; renderContent(); });
    document.getElementById('mtEditBtn').addEventListener('click', () => { editing = true; renderContent(); });
    document.getElementById('mtDeleteBtn').addEventListener('click', async () => {
      if (!confirm(`Delete "${doc.title}"?`)) return;
      await apiFetch(`/api/meetings/${doc.id}`, { method: 'DELETE' });
      const idx = list.findIndex(m => m.id === doc.id);
      list.splice(idx, 1);
      activeId = list[0]?.id || null;
      panel = 'content';
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
    const meeting_date = document.getElementById('mtNewDate').value || null;
    if (!title) return;
    const { id } = await apiFetch('/api/meetings', { method: 'POST', body: { title, content: '', meeting_date } });
    list.push({ id, title, content: '', recap: '', meeting_date });
    activeId = id;
    editing = true;
    panel = 'content';
    document.getElementById('mtNewTitle').value = '';
    document.getElementById('mtNewDate').value = '';
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

  // Games/Events carry an `assignees` array (multiple crew); Merch/Signs/
  // Raffle still carry a single `assignee_id`.
  const isAssignedToMe = x => x.assignees ? x.assignees.some(p => p.id === profile.id) : x.assignee_id === profile.id;

  const myTasks = [
    ...games.map(a => ({ ...a, _type: 'Game' })),
    ...events.map(a => ({ ...a, _type: 'Event' })),
    ...(merch || []).map(m => ({ ...m, _type: 'Merch' })),
    ...(signs || []).map(s => ({ ...s, _type: 'Sign' })),
    ...(raffle || []).map(r => ({ ...r, _type: 'Raffle' })),
  ].filter(isAssignedToMe);

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
            <li>${escapeHtml(a.name)} <span class="activity-status-tag ${a.status}">${a.status === 'locked_in' ? 'Locked In' : 'Proposed'}</span> <span class="hub-todo-deadline">— ${(a.assignees && a.assignees.length) ? escapeHtml(a.assignees.map(p => p.display_name).join(', ')) : 'unassigned'}</span></li>
          `).join('')}</ul>` : '<div class="placeholder-note">No games yet.</div>'}
          <h4 class="overview-materials-heading">Events</h4>
          ${events.length ? `<ul class="hub-todo-list">${events.map(a => `
            <li>${escapeHtml(a.name)}${a.starts_at ? ` <span class="hub-todo-deadline">— ${formatEventDate(a.starts_at)}</span>` : ''} <span class="activity-status-tag ${a.status}">${a.status === 'locked_in' ? 'Locked In' : 'Proposed'}</span> <span class="hub-todo-deadline">— ${(a.assignees && a.assignees.length) ? escapeHtml(a.assignees.map(p => p.display_name).join(', ')) : 'unassigned'}</span></li>
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
  // Multiple crew can be assigned to a game/event, so this is a checkbox
  // list rather than the single-select dropdown used elsewhere (Merch,
  // Signs, Raffle still take one assignee).
  const assigneeCheckboxesHtml = (namePrefix, selectedIds) => (roster || []).length
    ? `<div class="assignee-checkbox-list">${roster.map(m => `
        <label class="assignee-checkbox"><input type="checkbox" name="${namePrefix}" value="${m.id}" ${selectedIds.includes(m.id) ? 'checked' : ''}> ${escapeHtml(m.display_name)}</label>
      `).join('')}</div>`
    : '<div class="placeholder-note" style="border:none;padding:0;">No crew on the roster yet.</div>';

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
        <div class="field-row"><label>Assigned to</label>${assigneeCheckboxesHtml(`${kind}Assignee`, [])}</div>
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
          assignee_ids: [...document.querySelectorAll(`input[name="${kind}Assignee"]:checked`)].map(el => el.value),
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
    const assignees = a.assignees || [];
    // Only show a summary badge when there's something to report — an
    // unassigned game with no materials yet shouldn't clutter every card
    // with "unassigned · no materials yet".
    const badgeParts = [];
    if (assignees.length) badgeParts.push(escapeHtml(assignees.map(p => p.display_name).join(', ')));
    if (mats.length) badgeParts.push(`${mats.length} material${mats.length === 1 ? '' : 's'}`);
    return `
    <details class="activity-card ${a._colorClass || ''}" data-activity="${a.id}" draggable="true">
      <summary>
        ${escapeHtml(a.name)}
        ${badgeParts.length ? `<span class="activity-material-count">${badgeParts.join(' · ')}</span>` : ''}
      </summary>
      <div class="activity-body">
        <select class="activity-status-select" data-activity="${a.id}">
          <option value="proposed" ${a.status === 'proposed' ? 'selected' : ''}>Proposed</option>
          <option value="locked_in" ${a.status === 'locked_in' ? 'selected' : ''}>Locked In</option>
        </select>
        <div class="field-row activity-assignee-field" data-activity="${a.id}"><label>Assigned to</label>${assigneeCheckboxesHtml(`${a.id}-assignee`, assignees.map(p => p.id))}</div>
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
        <div class="post-actions">
          <button class="action-btn" data-duplicate-activity="${a.id}">Duplicate</button>
          <button class="action-btn danger" data-delete-activity="${a.id}">Delete</button>
        </div>
      </div>
    </details>
  `;
  };

  // Once a game/event has been dragged onto the Schedule board, it lives
  // there as a chip; drop it from these top lists so there's exactly one
  // draggable copy of it at a time instead of a stale duplicate up top.
  // schedule_day is null until the first drop, then either '' (Ongoing) or
  // a date string — both mean "on the board", so only null means "not yet".
  const onSchedule = a => a.schedule_day !== null && a.schedule_day !== void 0;

  const games = list.filter(a => a.kind === 'game' && !onSchedule(a));
  games.forEach(a => { a._colorClass = `activity-status-${a.status}`; });

  const events = list.filter(a => a.kind === 'event' && !onSchedule(a))
    .sort((a, b) => (a.starts_at ? new Date(a.starts_at) : Infinity) - (b.starts_at ? new Date(b.starts_at) : Infinity));
  // Color-coded by calendar day — same day, same color, in first-seen (chronological) order.
  const dayColors = new Map();
  events.forEach(a => {
    if (!a.starts_at) return;
    const day = a.starts_at.slice(0, 10);
    if (!dayColors.has(day)) dayColors.set(day, dayColors.size % 6);
    a._colorClass = `activity-color-${dayColors.get(day)}`;
  });

  // Schedule board — drag a game or event card straight from the columns on
  // the left onto Friday, Saturday, or Sunday, or onto Ongoing for things
  // that run all festival long rather than on one day. schedule_day is a
  // plain date string, '' for Ongoing, or null for "not on the board yet".
  // Each day is further split into time slots (schedule_slot): a 'Free Play'
  // catch-all ('') plus three fixed 2-hour blocks. Ordering within a
  // day+slot uses its own `schedule_position` column, kept separate from
  // `position` so reordering the board doesn't also reshuffle the
  // Games/Events lists above it (they sort by `position` too).
  const scheduleYear = evt.starts_at ? new Date(evt.starts_at).getFullYear() : new Date().getFullYear();
  const SCHEDULE_DAYS = [
    { day: 11, label: 'Friday' },
    { day: 12, label: 'Saturday' },
    { day: 13, label: 'Sunday' },
  ].map(({ day, label }) => ({
    key: `${scheduleYear}-09-${String(day).padStart(2, '0')}`,
    label: `${label} (Sept ${day})`,
  }));
  const SCHEDULE_SLOTS = [
    { key: '', label: 'Free Play' },
    { key: '12-13', label: 'Stone Soup Lunch (12:00 – 1:00 PM)' },
    { key: '13-15', label: '1:00 – 3:00 PM' },
    { key: '15-17', label: 'Field Day Games (3:00 – 5:00 PM)' },
    { key: '17-24', label: 'Free Play (5:00 PM – 12:00 AM)' },
    { key: '0-2', label: '12:00 – 2:00 AM' },
  ];
  let draggingId = null; // activity id currently mid-drag
  let tapPickedId = null; // activity id "picked up" via tap — touch fallback for browsers with no drag-and-drop

  // The Schedule board reuses activityCardHtml — a scheduled game/event is
  // the exact same expandable card as in the Games/Events lists below, just
  // sitting in a day+slot column instead. Same markup means the same
  // coloring, the same expand/status/assignee/materials controls, and the
  // same drag handling, for free.
  function scheduleBoardHtml() {
    const inSlot = (day, slot) => list.filter(a => onSchedule(a) && a.schedule_day === day && (a.schedule_slot || '') === slot)
      .sort((a, b) => (a.schedule_position || 0) - (b.schedule_position || 0));
    const dropzoneHtml = (day, slot) => `<div class="schedule-dropzone activity-list" data-day="${day}" data-slot="${slot}">${inSlot(day, slot).map(activityCardHtml).join('')}</div>`;
    // Each time slot is its own <details> so it can collapse independently —
    // separate from the per-card <details> inside activityCardHtml, which
    // "Expand All Slots" below deliberately leaves alone. A slot's <details>
    // holds one row with a dropzone per day, so the same time lines up
    // horizontally across Friday/Saturday/Sunday instead of stacking each
    // day's slots in its own column.
    const slotRowHtml = (slot, label) => `
      <details class="schedule-slot" open>
        <summary><h5>${label}</h5></summary>
        <div class="schedule-row">
          ${SCHEDULE_DAYS.map(d => `
            <div class="schedule-row-cell">
              <div class="schedule-row-cell-label">${d.label}</div>
              ${dropzoneHtml(d.key, slot)}
            </div>
          `).join('')}
        </div>
      </details>
    `;
    return `
      <div class="schedule-board">
        <h3 class="section-heading">Schedule</h3>
        <p class="schedule-callout">
          <span>Wednesday: All Hands on Deck for install.</span>
          <span>Monday: All Hands on Deck for deinstall.</span>
        </p>
        <p class="activity-material-add-hint" style="margin-bottom:0.6rem;">Drag a game or event card here.</p>
        <div class="schedule-board-toolbar"><button class="gm-btn" id="scheduleExpandAllBtn" style="background:var(--surface);color:var(--cream);">Expand All Slots</button></div>
        <details class="schedule-slot" open>
          <summary><h4>Ongoing</h4></summary>
          ${dropzoneHtml('', '')}
        </details>
        <div class="schedule-grid">
          ${SCHEDULE_SLOTS.map(s => slotRowHtml(s.key, s.label)).join('')}
        </div>
      </div>
    `;
  }

  // A card's dragstart/dragend fires whether it lives in the Games/Events
  // lists (a fresh drag onto the board) or already inside a schedule
  // dropzone (a reorder/move). Only the latter needs to persist an order on
  // drop — closest('.schedule-dropzone') tells them apart.
  function wireCardDragSources() {
    mainView.querySelectorAll('.activity-card[draggable="true"]').forEach(card => {
      card.addEventListener('dragstart', e => {
        // Only start a drag when grabbing the summary line — otherwise
        // dragging inside the expanded body (materials inputs, selects)
        // would fight with using those controls normally.
        if (!e.target.closest('summary')) { e.preventDefault(); return; }
        draggingId = card.dataset.activity;
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', async () => {
        card.classList.remove('dragging');
        draggingId = null;
        const zone = card.closest('.schedule-dropzone');
        if (!zone) return; // fresh drag from Games/Events — the dropzone's own 'drop' handler persists it
        const day = zone.dataset.day;
        const slot = zone.dataset.slot;
        const ids = [...zone.querySelectorAll('.activity-card')].map(c => c.dataset.activity);
        await Promise.all(ids.map((id, schedule_position) => {
          const moved = id === card.dataset.activity;
          return apiFetch(`/api/events/${evt.id}/activities/${id}`, { method: 'PATCH', body: { schedule_day: moved ? day : void 0, schedule_slot: moved ? slot : void 0, schedule_position } });
        }));
        renderCrewActivitiesView(mainView);
      });
    });
  }

  function wireScheduleColumn() {
    const scheduleBoard = mainView.querySelector('.schedule-board');

    function getDragAfterElement(container, y) {
      const cards = [...container.querySelectorAll('.activity-card:not(.dragging)')];
      return cards.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) return { offset, element: child };
        return closest;
      }, { offset: -Infinity, element: null }).element;
    }

    scheduleBoard.querySelectorAll('.schedule-dropzone').forEach(zone => {
      zone.addEventListener('dragover', e => {
        e.preventDefault();
        zone.classList.add('drag-hover');
        // Only live-reorder a card that's already on the board (scoped to
        // scheduleBoard so a fresh drag from the Games/Events lists, which
        // never enters this subtree, is left alone until it's dropped).
        const draggingCard = scheduleBoard.querySelector('.activity-card.dragging');
        if (!draggingCard) return;
        const afterEl = getDragAfterElement(zone, e.clientY);
        if (afterEl == null) zone.appendChild(draggingCard); else zone.insertBefore(draggingCard, afterEl);
      });
      zone.addEventListener('dragleave', () => zone.classList.remove('drag-hover'));
      zone.addEventListener('drop', async e => {
        e.preventDefault();
        zone.classList.remove('drag-hover');
        if (!draggingId) return;
        // A card being reordered/moved is already handled by its own dragend
        // (it was live-moved into place during dragover above). This branch
        // only fires for a fresh drag straight from a Games/Events card,
        // which never got moved into this zone's DOM.
        if (zone.querySelector(`.activity-card[data-activity="${draggingId}"]`)) return;
        const day = zone.dataset.day;
        const slot = zone.dataset.slot;
        const schedule_position = zone.querySelectorAll('.activity-card').length;
        const id = draggingId;
        draggingId = null;
        await apiFetch(`/api/events/${evt.id}/activities/${id}`, { method: 'PATCH', body: { schedule_day: day, schedule_slot: slot, schedule_position } });
        renderCrewActivitiesView(mainView);
      });
    });
  }

  // Tap-to-assign — a touch fallback for the drag-and-drop above, since native
  // HTML5 DnD (used everywhere else in this function) never fires on
  // touchscreens. Tap a card to "pick it up" (highlighted), then tap a
  // dropzone (or a card inside one) to send it there; tap the picked card
  // again, or anywhere else, to cancel. Coexists with mouse drag untouched.
  function wireTapAssign() {
    const scheduleBoard = mainView.querySelector('.schedule-board');

    function clearPick() {
      tapPickedId = null;
      mainView.querySelectorAll('.tap-picked').forEach(el => el.classList.remove('tap-picked'));
      scheduleBoard.querySelectorAll('.schedule-dropzone').forEach(z => z.classList.remove('tap-target'));
    }

    function pick(id, el) {
      tapPickedId = id;
      el.classList.add('tap-picked');
      scheduleBoard.querySelectorAll('.schedule-dropzone').forEach(z => z.classList.add('tap-target'));
    }

    async function assignPickedTo(zone) {
      const day = zone.dataset.day;
      const slot = zone.dataset.slot;
      const schedule_position = zone.querySelectorAll('.activity-card').length;
      const id = tapPickedId;
      clearPick();
      await apiFetch(`/api/events/${evt.id}/activities/${id}`, { method: 'PATCH', body: { schedule_day: day, schedule_slot: slot, schedule_position } });
      renderCrewActivitiesView(mainView);
    }

    mainView.querySelectorAll('.activity-card').forEach(card => {
      card.addEventListener('click', async e => {
        if (!e.target.closest('summary')) return;
        const id = card.dataset.activity;
        if (tapPickedId === id) { clearPick(); return; }
        if (tapPickedId) {
          const zone = card.closest('.schedule-dropzone');
          if (zone) { await assignPickedTo(zone); return; }
        }
        clearPick();
        pick(id, card);
      });
    });

    scheduleBoard.querySelectorAll('.schedule-dropzone').forEach(zone => {
      zone.addEventListener('click', e => {
        if (!tapPickedId || e.target.closest('.activity-card')) return;
        assignPickedTo(zone);
      });
    });

    // Assigned (not addEventListener) so each re-render replaces the previous
    // handler instead of stacking another one on this long-lived container.
    mainView.onclick = e => {
      if (!tapPickedId) return;
      if (e.target.closest('.activity-card, .schedule-dropzone')) return;
      clearPick();
    };
  }

  // Toggles every time-slot <details> open/closed together — deliberately
  // untouched: the <details> inside each activity card, which stay however
  // the user left them.
  function wireScheduleExpandAll() {
    const btn = mainView.querySelector('#scheduleExpandAllBtn');
    const slots = mainView.querySelectorAll('.schedule-board .schedule-slot');
    btn.textContent = [...slots].every(s => s.open) ? 'Collapse All Slots' : 'Expand All Slots';
    btn.addEventListener('click', () => {
      const expand = [...slots].every(s => s.open) ? false : true;
      slots.forEach(s => { s.open = expand; });
      btn.textContent = expand ? 'Collapse All Slots' : 'Expand All Slots';
    });
  }

  const listHtml = `
    ${scheduleBoardHtml()}
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
  wireCardDragSources();
  wireScheduleColumn();
  wireTapAssign();
  wireScheduleExpandAll();

  mainView.querySelectorAll('[data-duplicate-activity]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.duplicateActivity;
      const a = list.find(x => x.id === id);
      if (!a) return;
      const { id: newId } = await apiFetch(`/api/events/${evt.id}/activities`, {
        method: 'POST',
        body: {
          kind: a.kind,
          name: `${a.name} (copy)`,
          description: a.description,
          starts_at: a.starts_at,
          ends_at: a.ends_at,
          location: a.location,
          status: a.status,
          assignee_ids: (a.assignees || []).map(p => p.id),
        },
      });
      for (const m of (materialsByActivity[id] || [])) {
        await apiFetch(`/api/events/${evt.id}/materials`, { method: 'POST', body: { item: m.item, category: m.category, activity_id: newId } });
      }
      renderCrewActivitiesView(mainView);
    });
  });

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

  mainView.querySelectorAll('.activity-assignee-field').forEach(field => {
    field.querySelectorAll('input[type="checkbox"]').forEach(box => {
      box.addEventListener('change', async () => {
        const assignee_ids = [...field.querySelectorAll('input[type="checkbox"]:checked')].map(el => el.value);
        await apiFetch(`/api/events/${evt.id}/activities/${field.dataset.activity}`, { method: 'PATCH', body: { assignee_ids } });
        renderCrewActivitiesView(mainView);
      });
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
      <div class="meeting-content-card" style="max-width:760px;">${renderMarkdown(content || '*Nothing here yet.*')}</div>
    `;
    const editBtn = document.getElementById('loreEditBtn');
    if (editBtn) editBtn.addEventListener('click', () => { editing = true; draw(); });
  }

  draw();
}

// ── My Profile: own details + opt-in contact sharing ────────────────
async function renderProfileView(mainView, flash = '') {
  const p = profile;
  // Acts are stored as comma-separated skills; keep any free-text ones too.
  const acts = new Set((p.skills || '').split(',').map(x => x.trim()).filter(Boolean));
  const shareRow = (field, label, value) => `
    <label class="admin-ringleader-toggle share-toggle">
      <input type="checkbox" name="${field}" ${p[field] ? 'checked' : ''} ${value ? '' : 'disabled'}>
      Show my ${label} to inner members${value ? '' : ` <span class="post-meta">(add one first)</span>`}
    </label>`;
  mainView.innerHTML = `
    <h2>My Profile</h2>
    ${flash ? `<div class="stamp-flash">${escapeHtml(flash)}</div>` : ''}
    <form class="composer profile-form" id="profileForm">
      <div class="auth-field"><label>Name</label><input name="display_name" required value="${escapeHtml(p.display_name)}"></div>
      <div class="auth-field"><label>City</label><input name="city" required value="${escapeHtml(p.city || '')}"></div>
      <div class="auth-field"><label>Phone</label><input name="phone" type="tel" value="${escapeHtml(p.phone || '')}"></div>
      <div class="auth-field"><label>Instagram</label><input name="instagram_handle" placeholder="@handle" value="${escapeHtml(p.instagram_handle || '')}"></div>
      <div class="auth-field"><label>Home chapter</label>
        <select name="home_chapter_id"><option value="">None yet</option>${chapters.map(c => `<option value="${c.id}" ${p.home_chapter_id === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}</select></div>
      <div class="auth-field"><label>Your acts</label>
        <div class="act-chips">${ACTS.map(a => `<button type="button" class="act-chip ${acts.has(a) ? 'on' : ''}" data-act="${escapeHtml(a)}">${escapeHtml(a)}</button>`).join('')}</div></div>
      <div class="auth-field"><label>Birthday (optional)</label><input name="birthday" type="date" value="${escapeHtml(p.birthday || '')}"></div>
      <div class="auth-field"><label>Materials you could donate (optional)</label><input name="materials_to_donate" placeholder="Scrap wood, old electronics, hardware…" value="${escapeHtml(p.materials_to_donate || '')}"></div>
      <h3 class="passport-section">Who can reach you</h3>
      <p class="post-meta">Your contact info is private by default. Ringleaders can always see it so they can run events.
        Share it with everyone inside the guild here, or with one person at a time from a message ("Share my contact").</p>
      ${shareRow('share_email', 'email', p.email)}
      ${shareRow('share_phone', 'phone', p.phone)}
      ${shareRow('share_instagram', 'Instagram', p.instagram_handle)}
      <h3 class="passport-section">The raven on your phone</h3>
      <p class="post-meta" id="ravenStatus">Checking…</p>
      <div class="post-actions" id="ravenBtns"></div>
      ${['notify_letters', 'notify_calls', 'notify_prizes'].map((k, i) => `
        <label class="admin-ringleader-toggle share-toggle"><input type="checkbox" name="${k}" ${p[k] === 0 ? '' : 'checked'}>
          Squawk about ${['letters', 'volunteer calls &amp; reminders', 'prizes &amp; rank-ups'][i]}</label>`).join('')}
      <button type="submit" class="composer-submit">Save</button>
    </form>`;
  drawRavenSettings();
  mainView.querySelectorAll('.act-chip').forEach(chip => chip.addEventListener('click', () => {
    const a = chip.dataset.act;
    if (acts.has(a)) acts.delete(a); else acts.add(a);
    chip.classList.toggle('on', acts.has(a));
  }));
  document.getElementById('profileForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const { user } = await apiFetch('/api/me', { method: 'PATCH', body: {
        display_name: f.get('display_name').trim(), city: f.get('city').trim(), phone: f.get('phone'),
        instagram_handle: f.get('instagram_handle'), skills: [...acts].join(', '),
        home_chapter_id: f.get('home_chapter_id') || null, birthday: f.get('birthday') || null, materials_to_donate: f.get('materials_to_donate').trim(),
        share_email: f.has('share_email'), share_phone: f.has('share_phone'), share_instagram: f.has('share_instagram'),
        notify_letters: f.has('notify_letters'), notify_calls: f.has('notify_calls'), notify_prizes: f.has('notify_prizes'),
      } });
      profile = user;
      renderShell();
      renderProfileView(document.getElementById('mainView'), 'Saved.');
    } catch (err) { renderProfileView(mainView, err.message); }
  });
}

async function drawRavenSettings() {
  const status = document.getElementById('ravenStatus'), btns = document.getElementById('ravenBtns');
  if (!status) return;
  const env = ravenEnv();
  const on = await ravenSubscribed();
  status.textContent = on ? 'The raven knows where to find you on this device.'
    : env.ios && !env.standalone ? 'On iPhone, add the Guild Hall to your Home Screen first — then the raven can find you.'
    : !env.supported ? 'This browser can’t receive the raven.' : 'The raven doesn’t know where to find you on this device yet.';
  btns.innerHTML = on
    ? '<button type="button" class="action-btn" data-r="test">Send me a test squawk</button><button type="button" class="action-btn" data-r="off">Stop on this device</button>'
    : env.ios && !env.standalone ? '<button type="button" class="action-btn" data-r="ios">Show me how</button>'
    : env.supported ? '<button type="button" class="composer-submit" data-r="on">Let the raven follow me</button>' : '';
  if (deferredInstall) btns.insertAdjacentHTML('beforeend', '<button type="button" class="action-btn" data-r="install">Install the app</button>');
  btns.onclick = async e => {
    const r = e.target.dataset.r; if (!r) return;
    if (r === 'ios') { showIosInstall(); return; }
    if (r === 'install') { deferredInstall.prompt(); deferredInstall = null; return; }
    if (r === 'test') { await apiFetch('/api/push/test', { method: 'POST' }); status.textContent = 'Squawk sent — check your notifications.'; return; }
    if (r === 'on') { const res = await followRaven(); if (res === 'ios-install') { showIosInstall(); return; } status.textContent = RAVEN_RESULT[res]; }
    if (r === 'off') await unfollowRaven();
    setTimeout(drawRavenSettings, r === 'on' ? 1500 : 0);
  };
}

// ── Carnival Passport ─────────────────────────────────────────────────
// Merit-badge stamps that earn rank (vault: "CSI Rank and Passport Rule").
// A souvenir, not a scoreboard: your own passport only, never compared.
const BADGES = {
  fix:        { name: 'The Fix Is In',   motto: 'I bribed my way in.',      glyph: '💰', color: '#8F6E34', how: 'Pay the one-time $5 door registration.', icon: 'M9 4h6l-1.5 3h-3z M7 10c0-2 2-3 5-3s5 1 5 3l1 7a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3z M12 11v6 M10 13h3.5a1.5 1.5 0 0 1 0 3' },
  ticket:     { name: 'Ticket Punched',  motto: 'I was there.',             glyph: '🎟️', color: '#9B3036', how: 'Get checked in at a Carnival or guild event.', icon: 'M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v8a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2z M10 6v12' },
  roustabout: { name: 'Roustabout',      motto: 'Hauled the canvas.',       glyph: '🔨', color: '#4E8C82', how: 'Work a volunteer shift.', icon: 'M14 4l6 6-3 3-6-6z M11 7 3 15l3 3 8-8' },
  sawdust:    { name: 'Sawdust',         motto: 'Made it with my hands.',   glyph: '🪚', color: '#C97C3D', how: 'Help build something that makes it into a Carnival.', icon: 'M3 17 15 5l4 4L7 21z M15 5l2-2 4 4-2 2' },
  barker:     { name: 'Barker',          motto: 'Step right up!',           glyph: '📣', color: '#C77B8A', how: 'Bring someone who joins and shows up.', icon: 'M3 10v4h3l8 5V5L6 10z M18 9a4 4 0 0 1 0 6' },
  junk:       { name: 'Junk Saint',      motto: "One carnie's trash…",      glyph: '♻️', color: '#5F7A3D', how: 'Donate materials that get used in a build.', icon: 'M4 20h16 M6 20l2-9h8l2 9 M9 11V7h6v4' },
  canvasman:  { name: 'Boss Canvasman',  motto: 'Raised the big top.',      glyph: '🎪', color: '#8B5FA3', how: 'Lead a crew, teach a skill, or host newcomers.', icon: 'M3 20 12 4l9 16z M12 4v16 M12 4l3-2' },
};
const BADGE_ORDER = ['fix', 'ticket', 'roustabout', 'sawdust', 'barker', 'junk', 'canvasman'];
const HAND_GRANTED_BADGES = ['sawdust', 'barker', 'junk', 'canvasman', 'roustabout'];

function badgeIcon(kind, size = 28) {
  return `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${BADGES[kind].icon}"/></svg>`;
}

function passportProgressText(p) {
  if (!p.next) return p.user.is_ringleader ? 'Ringleader.' : `${rankLabel(p.user.rank)} of the guild.`;
  const { stamps_needed, roustabouts_needed } = p.next;
  if (!stamps_needed && !roustabouts_needed) return 'Apprentice is yours — refresh to step inside.';
  const parts = [];
  if (roustabouts_needed) parts.push(`${roustabouts_needed} more shift${roustabouts_needed > 1 ? 's' : ''}`);
  const otherNeeded = Math.max(0, stamps_needed - roustabouts_needed);
  if (otherNeeded) parts.push(`${otherNeeded} more stamp${otherNeeded > 1 ? 's' : ''}`);
  return `${parts.join(' and ')} and you're an Apprentice`;
}
function sqlTime(t) { return Date.parse(String(t).replace(' ', 'T') + 'Z'); }

// ── Dressing Room: everyone's landing page. A vanity mirror (you) over a
// cozy prize booth where your badges live. Badges are never compared.
async function renderDressingRoom(mainView) {
  mainView.innerHTML = `<div class="placeholder-note">Lighting the bulbs…</div>`;
  const [p, { events }, { troupe }] = await Promise.all([
    apiFetch('/api/me/passport'),
    apiFetch('/api/events'),
    apiFetch('/api/me/troupe').catch(() => ({ troupe: [] })),
  ]);
  const counts = {};
  const lastOf = {};
  p.stamps.forEach(s => { counts[s.kind] = (counts[s.kind] || 0) + 1; lastOf[s.kind] = s; });
  const rank = p.user.is_ringleader ? 'Ringleader' : rankLabel(p.user.rank);
  const chapter = chapters.find(c => c.id === profile.home_chapter_id);
  const acts = (profile.skills || '').split(',').map(x => x.trim()).filter(Boolean);
  const nextEvent = (events || [])[0];
  const volunteering = nextEvent && myVolunteering.has(nextEvent.id);

  const nextStep = p.next ? `
    <section class="dr-next" aria-label="Your next step">
      <div class="dr-kicker">Your next step</div>
      <div class="dr-next-title">${escapeHtml(passportProgressText(p))}</div>
      <div class="dr-strip" role="img" aria-label="${p.counts.total} of 3 stamps, ${p.counts.roustabouts} of 2 shifts">
        ${[0, 1, 2].map(i => {
          const st = p.stamps[i];
          return st ? `<span class="dr-cell on">${escapeHtml(BADGES[st.kind].name)}</span>` : `<span class="dr-cell">Stamp ${i + 1}</span>`;
        }).join('')}
      </div>
      <div class="dr-shifts">Shifts worked: <strong>${Math.min(p.counts.roustabouts, 2)} of 2</strong></div>
      ${nextEvent ? `<div class="dr-next-event">Next up: <strong>${escapeHtml(nextEvent.title)}</strong> · ${escapeHtml(formatEventDate(nextEvent.starts_at))}</div>
        <a class="dr-cta" href="#/event/${nextEvent.id}">${volunteering ? "✓ You're volunteering — see details" : 'Volunteer for it'}</a>`
        : `<div class="dr-next-event">No events posted yet. Keep an eye on the Courtyard.</div>`}
    </section>` : (nextEvent ? `
    <section class="dr-next" aria-label="Next up">
      <div class="dr-kicker">Next up</div>
      <div class="dr-next-title">${escapeHtml(nextEvent.title)}</div>
      <div class="dr-next-event">${escapeHtml(formatEventDate(nextEvent.starts_at))}${nextEvent.location ? ' · ' + escapeHtml(nextEvent.location) : ''}</div>
      <a class="dr-cta" href="#/event/${nextEvent.id}">${volunteering ? "✓ You're volunteering" : 'Volunteer for it'}</a>
    </section>` : '');

  const slots = [...BADGE_ORDER, 'mystery'];
  const shelf = slots.map(k => {
    if (k === 'mystery') return `<button class="booth-prize unwon" data-prize="mystery" aria-label="Mystery prize, not yet won"><span class="booth-q">?</span></button>`;
    const won = counts[k] || 0;
    return `<button class="booth-prize ${won ? 'won' : 'unwon'}" data-prize="${k}" style="--badge:${BADGES[k].color}" aria-label="${escapeHtml(BADGES[k].name)}${won ? ', won' : ', not yet won'}">
      ${badgeIcon(k, 30)}${won > 1 ? `<span class="booth-count">×${won}</span>` : ''}</button>`;
  }).join('');
  const firstWon = BADGE_ORDER.find(k => counts[k]) || 'roustabout';

  const troupeHtml = troupe.length
    ? `<div class="dr-troupe">${troupe.map(t => `
        <div class="dr-mate"><span class="dr-mate-avatar">${escapeHtml((t.display_name || '?').slice(0, 1).toUpperCase())}</span>
        <span class="dr-mate-name">${escapeHtml(t.display_name)}</span></div>`).join('')}</div>`
    : `<p class="dr-muted">Work a shift and the folks beside you show up here.</p>`;

  mainView.innerHTML = `
    <div class="dressing-room">
      <div class="dr-title">~ Your Dressing Room ~</div>
      <section class="dr-mirror" id="drMirror" aria-label="You">
        <div class="dr-bulbs" aria-hidden="true"></div>
        <div class="dr-glass">
          <div class="dr-avatar">${escapeHtml((profile.display_name || '?').slice(0, 1).toUpperCase())}</div>
          <h1 class="dr-name">${escapeHtml(profile.display_name)}</h1>
          <div class="dr-meta"><span class="dr-rank">${escapeHtml(rank)}</span>${chapter ? `<span>${escapeHtml(chapter.name)} chapter</span>` : ''}</div>
          ${acts.length ? `<div class="dr-acts">${acts.map(a => `<span class="dr-act">${escapeHtml(a)}</span>`).join('')}</div>`
            : `<a class="dr-link" href="#/profile">Pick your acts</a>`}
        </div>
      </section>

      ${nextStep}

      <section class="booth" aria-label="Your prize booth">
        <div class="booth-awning" aria-hidden="true">${'<span></span>'.repeat(8)}</div>
        <div class="booth-valance" aria-hidden="true">${'<span></span>'.repeat(8)}</div>
        <div class="booth-body">
          <div class="booth-lights" aria-hidden="true">${Array.from({ length: 9 }, (_, i) => `<span class="cs-bulb" style="animation-delay:${(i * 0.25).toFixed(2)}s"></span>`).join('')}</div>
          <div class="booth-title">Prizes won</div>
          <div class="booth-hint">Tap a prize to hear its story</div>
          <div class="booth-shelves">${shelf}</div>
          <div class="booth-story" id="boothStory" aria-live="polite"></div>
        </div>
      </section>

      <section class="dr-section" aria-label="Your troupe">
        <h2 class="dr-h2">Your troupe</h2>
        <p class="dr-muted">The folks you've worked beside. Earned, not picked.</p>
        ${troupeHtml}
      </section>

      <a class="dr-edit" href="#/profile">Edit your dressing room</a>
    </div>`;

  const story = document.getElementById('boothStory');
  const tell = kind => {
    mainView.querySelectorAll('.booth-prize').forEach(b => b.classList.toggle('picked', b.dataset.prize === kind));
    if (kind === 'mystery') {
      story.innerHTML = `<div class="booth-story-name">???</div><div class="booth-story-line">Some prizes are a surprise. Keep showing up.</div>`;
      return;
    }
    const b = BADGES[kind];
    const st = lastOf[kind];
    story.innerHTML = st
      ? `<div class="booth-story-name">${escapeHtml(b.name)}</div><div class="booth-story-line">“${escapeHtml(b.motto)}”</div>
         <div class="booth-story-meta">${st.event_title ? escapeHtml(st.event_title) + ' · ' : ''}${escapeHtml(new Date(sqlTime(st.created_at)).toLocaleDateString())}${counts[kind] > 1 ? ` · won ${counts[kind]} times` : ''}</div>`
      : `<div class="booth-story-name">${escapeHtml(b.name)}</div><div class="booth-story-line">Not won yet. ${escapeHtml(b.how)}</div><div class="booth-story-meta">Still on the top shelf.</div>`;
  };
  mainView.querySelectorAll('.booth-prize').forEach(btn => btn.addEventListener('click', () => tell(btn.dataset.prize)));
  tell(firstWon);

  drawMirrorBulbs(document.getElementById('drMirror'));
  if (!needsRankCelebration()) maybeShowPrize(p);
}

// ── The raven on your phone: installable app + web push. The push carries
// nothing; sw.js fetches what's waiting and squawks it. iPhones only allow
// push for apps added to the Home Screen, so we walk them through that.
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; });
const ravenEnv = () => ({
  supported: 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
  ios: /iphone|ipad|ipod/i.test(navigator.userAgent),
  standalone: window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
});
let swReg = null;
async function registerRaven() {
  if (!('serviceWorker' in navigator)) return null;
  try { swReg = await navigator.serviceWorker.register('/sw.js'); } catch (e) { swReg = null; }
  return swReg;
}
registerRaven();
async function ravenSubscribed() {
  const env = ravenEnv();
  if (!env.supported || Notification.permission !== 'granted') return false;
  const reg = swReg || await navigator.serviceWorker.getRegistration();
  return !!(reg && await reg.pushManager.getSubscription());
}
function b64ToBytes(b64) {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}
// Returns 'on' | 'ios-install' | 'denied' | 'unsupported' | 'error'.
async function followRaven() {
  const env = ravenEnv();
  if (env.ios && !env.standalone) return 'ios-install';
  if (!env.supported || !appConfig.vapid_public_key) return 'unsupported';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return 'denied';
  try {
    const reg = swReg || await registerRaven() || await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(appConfig.vapid_public_key) });
    await apiFetch('/api/push/subscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
    return 'on';
  } catch (e) { console.error(e); return 'error'; }
}
async function unfollowRaven() {
  const reg = swReg || await navigator.serviceWorker.getRegistration();
  const sub = reg && await reg.pushManager.getSubscription();
  if (sub) { await apiFetch('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {}); await sub.unsubscribe(); }
}
function showIosInstall() {
  const o = document.createElement('div');
  o.className = 'raven-modal';
  o.innerHTML = `
    <div class="raven-modal-card" role="dialog" aria-label="Add the Guild Hall to your Home Screen">
      <img src="${ROOM}raven_perched.png" alt="" class="raven-modal-bird">
      <h3>Let the raven follow you home</h3>
      <p>On iPhone the raven can only find you from your Home Screen:</p>
      <ol>
        <li>Tap the <strong>Share</strong> button <span aria-hidden="true">⬆︎</span> at the bottom of Safari.</li>
        <li>Choose <strong>Add to Home Screen</strong>.</li>
        <li>Open <strong>Guild Hall</strong> from your Home Screen and tap the raven again.</li>
      </ol>
      <button class="room-plaque-btn" data-close>Got it</button>
    </div>`;
  document.body.appendChild(o);
  o.addEventListener('click', e => { if (e.target === o || e.target.dataset.close !== undefined) o.remove(); });
}
const RAVEN_RESULT = {
  on: 'The raven will find you now. SQUAWK!',
  denied: 'Notifications are blocked for this site. Allow them in your browser settings to let the raven in.',
  unsupported: 'This browser can’t receive the raven. Try Chrome, or add the Guild Hall to your Home Screen on iPhone.',
  error: 'Something went wrong teaching the raven your address. Try again in a moment.',
};

// ── BLAST: the Ringleader hollers through the barker cone ──────────────
// Unseen blasts arrive in the app: a striped barker's cone blares a fanfare
// with the top hat peeking out. Tap it and the Ringleader's head springs up
// out of the cone (boing!) and hollers the message, babbling as it types.
// Neeff's art drops in when these files exist (else hand-built stand-ins):
// assets/room/cone_back.png + cone_front.png (the cone, mouth up, as two
// layers so the head sits inside it), head_closed.png, head_open.png,
// head_wide.png.
let blastShowing = null;
async function checkBlast() {
  if (!session || blastShowing) return;
  try {
    const { blast } = await apiFetch('/api/me/blast');
    if (blast && !blastShowing) showBlast(blast, { live: true });
  } catch (e) { /* try again next tick */ }
}

const soundOff = () => { try { return localStorage.getItem('cs-sound-off') === '1'; } catch (e) { return false; } };

// One little sound rig per blast: everything runs through a "megaphone"
// (soft clipping + a tinny bandpass), so the fanfare, the boing and the
// babble all sound like they're coming out of the cone. Browsers only allow
// sound after you've touched the page, so the fanfare may stay silent until
// then (the cone still shakes); the babble starts on your tap, so it plays.
function megaphone() {
  if (soundOff()) return null;
  let ctx;
  try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; }
  ctx.resume?.();
  const drive = ctx.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) { const x = (i / 512) - 1; curve[i] = Math.tanh(3.5 * x); }
  drive.curve = curve;
  const horn = ctx.createBiquadFilter(); horn.type = 'bandpass'; horn.frequency.value = 1500; horn.Q.value = 0.7;
  const out = ctx.createGain(); out.gain.value = 0.45;
  drive.connect(horn).connect(out).connect(ctx.destination);
  let closed = false;
  return { ctx, input: drive, close() { if (closed) return; closed = true; ctx.close().catch(() => {}); } };
}

// The blare: a circus "ta-ta-ta-TAAA" on a brassy sawtooth, in bursts,
// until you tap. Returns a stopper (safe to call twice).
function startBlare(rig) {
  if (!rig) return () => {};
  const { ctx, input } = rig;
  let on = true;
  const note = (f, t, d) => {
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(f, t);
    o.frequency.linearRampToValueAtTime(f * 1.01, t + d);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.5, t + 0.015);
    g.gain.setValueAtTime(0.5, t + d * 0.8); g.gain.exponentialRampToValueAtTime(0.001, t + d);
    o.connect(g).connect(input); o.start(t); o.stop(t + d + 0.02);
  };
  const burst = () => {
    const t = ctx.currentTime + 0.02;
    [[392, 0, 0.11], [523, 0.14, 0.11], [659, 0.28, 0.11], [784, 0.42, 0.45]].forEach(([f, at, d]) => note(f, t + at, d));
    if (navigator.vibrate) navigator.vibrate([90, 50, 90, 50, 90, 50, 300]);
  };
  burst();
  const timer = setInterval(() => { if (on) burst(); }, 2400);
  return () => { on = false; clearInterval(timer); };
}

// Boing: the spring that launches the head out of the cone.
function playBoing(rig) {
  if (!rig) return;
  const { ctx, input } = rig, t = ctx.currentTime;
  const o = ctx.createOscillator(); o.type = 'triangle';
  o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(520, t + 0.18);
  const wob = ctx.createOscillator(); wob.frequency.value = 26;
  const wobDepth = ctx.createGain(); wobDepth.gain.value = 40;
  wob.connect(wobDepth).connect(o.frequency);
  const g = ctx.createGain(); g.gain.setValueAtTime(0.6, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
  o.connect(g).connect(input); o.start(t); wob.start(t); o.stop(t + 0.5); wob.stop(t + 0.5);
}

// Barker babble, adapted from Boomy's babble in BYOB (listener.html,
// playBabble): one sound per typed character. Boomy beatboxes; the barker
// talks — a buzzy voice shaped into random vowels (two formant filters),
// pitch wandering like speech, up on "!" and "?", with Boomy's radio-static
// crackle now and then for megaphone grit.
function makeBabbler(rig) {
  if (!rig) return () => {};
  const { ctx, input } = rig;
  const VOWELS = [[730, 1090], [570, 840], [300, 2290], [440, 1020], [660, 1700], [400, 1900]];
  let pitch = 200, n = 0;
  const crackle = t => {
    const dur = 0.04 + Math.random() * 0.04;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const d = buf.getChannelData(0); let burst = false;
    for (let i = 0; i < d.length; i++) { if (Math.random() < 0.08) burst = !burst; d[i] = burst ? Math.random() * 2 - 1 : 0; }
    const src = ctx.createBufferSource(); src.buffer = buf;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.35, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(g).connect(input); src.start(t);
  };
  return ch => {
    const t = ctx.currentTime; n++;
    if (n % 11 === 0) crackle(t);
    const dur = 0.065 + Math.random() * 0.05;
    pitch = Math.min(290, Math.max(150, pitch + (Math.random() - 0.5) * 70));
    const lift = ch === '!' ? 1.35 : ch === '?' ? 1.25 : 1;
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(pitch * lift, t);
    o.frequency.linearRampToValueAtTime(pitch * lift * (ch === '?' ? 1.15 : Math.random() < 0.5 ? 1.06 : 0.92), t + dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(0.9, t + 0.008);
    env.gain.setValueAtTime(0.9, t + dur * 0.6); env.gain.exponentialRampToValueAtTime(0.001, t + dur);
    const [f1, f2] = VOWELS[Math.floor(Math.random() * VOWELS.length)];
    [[f1, 7, 1], [f2, 9, 0.6]].forEach(([f, q, v]) => {
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
      const lvl = ctx.createGain(); lvl.gain.value = v * 3;
      o.connect(bp).connect(lvl).connect(env);
    });
    env.connect(input); o.start(t); o.stop(t + dur + 0.02);
  };
}

// Stand-in barker's cone, mouth up: the dark inside is drawn behind the head,
// the striped body and gold lip in front of it, so the head rises out of it.
const CONE_STRIPES = (() => {
  let s = '';
  for (let i = 0; i < 8; i++) {
    const tx = x => 15 + (170 * x) / 8, bx = x => 84 + (32 * x) / 8;
    s += `<path d="M${tx(i)} 40 L${tx(i + 1)} 40 L${bx(i + 1)} 168 L${bx(i)} 168 Z" fill="${i % 2 ? '#F4E8D0' : '#9B3036'}"/>`;
  }
  return s;
})();
const CONE_BACK_SVG = `<svg class="cone-back" viewBox="0 0 200 200" aria-hidden="true">
  <ellipse cx="100" cy="40" rx="85" ry="24" fill="#2a1410" stroke="#231712" stroke-width="5"/>
  <ellipse cx="100" cy="44" rx="70" ry="16" fill="#140806"/>
</svg>`;
const CONE_FRONT_SVG = `<svg class="cone-front" viewBox="0 0 200 200" aria-hidden="true">
  <clipPath id="coneBody"><path d="M15 40 A85 24 0 0 0 185 40 L116 168 L84 168 Z"/></clipPath>
  <g clip-path="url(#coneBody)"><rect x="0" y="0" width="200" height="200" fill="#9B3036"/>${CONE_STRIPES}</g>
  <path d="M15 40 A85 24 0 0 0 185 40 L116 168 L84 168 Z" fill="none" stroke="#231712" stroke-width="5" stroke-linejoin="round"/>
  <path d="M15 40 A85 24 0 0 0 185 40" fill="none" stroke="#C8A05A" stroke-width="9" stroke-linecap="round"/>
  <path d="M15 40 A85 24 0 0 0 185 40" fill="none" stroke="#231712" stroke-width="2.5"/>
  <rect x="80" y="164" width="40" height="22" rx="7" fill="#C8A05A" stroke="#231712" stroke-width="5"/>
</svg>`;
// Stand-in Ringleader head (top hat, curled moustache, a jaw that flaps).
const HEAD_SVG = `<svg class="blast-head-svg" viewBox="0 0 160 190" aria-hidden="true">
  <rect x="38" y="6" width="84" height="56" rx="6" fill="#231712"/><rect x="38" y="44" width="84" height="12" fill="#9B3036"/>
  <ellipse cx="80" cy="62" rx="66" ry="10" fill="#231712"/>
  <ellipse cx="80" cy="110" rx="52" ry="50" fill="#e9b98f" stroke="#231712" stroke-width="5"/>
  <circle cx="61" cy="100" r="7" fill="#231712"/><circle cx="99" cy="100" r="7" fill="#231712"/>
  <circle cx="63" cy="98" r="2.5" fill="#fff"/><circle cx="101" cy="98" r="2.5" fill="#fff"/>
  <path d="M50 122 Q65 112 80 122 Q95 112 110 122 Q118 116 120 108 M50 122 Q42 116 40 108" fill="none" stroke="#231712" stroke-width="6" stroke-linecap="round"/>
  <g class="blast-jaw"><path d="M58 132 Q80 146 102 132 Q100 150 80 152 Q60 150 58 132 Z" fill="#7A2E34" stroke="#231712" stroke-width="4"/></g>
</svg>`;
const artOr = (file, fallback, cls) => `<img class="${cls} blast-art" src="${ROOM}${file}" alt="" onerror="this.remove()">${fallback}`;

function showBlast(blast, { live = false, preview = false } = {}) {
  blastShowing = blast.id || 'preview';
  const o = document.createElement('div');
  o.className = 'blast-overlay ringing';
  o.setAttribute('role', 'dialog');
  o.setAttribute('aria-label', `A holler from ${blast.sender || 'the Ringleader'}`);
  o.innerHTML = `
    <div class="blast-stage">
      <button class="blast-mute" aria-label="Sound on or off">${soundOff() ? '🔇' : '🔊'}</button>
      <div class="blast-ring-words" aria-hidden="true"><span>HEAR YE!</span><span>HEAR YE!</span></div>
      <div class="blast-bubble" hidden>
        <div class="blast-title">${escapeHtml(blast.title)}</div>
        <div class="blast-body" aria-live="polite"></div>
        <div class="blast-btns">
          ${blast.url && blast.url !== '#/dressing-room' ? `<button class="forum-btn" data-go>Take me there</button>` : ''}
          <button class="forum-btn ghost" data-done>${preview ? 'Close preview' : 'Got it!'}</button>
        </div>
      </div>
      <button class="blast-cone" aria-label="Step right up and hear the message">
        <span class="cone-layer cone-l-back">${artOr('cone_back.png', CONE_BACK_SVG, 'cone-art')}</span>
        <span class="cone-slot"><span class="blast-head">${artOr('head_closed.png', HEAD_SVG, 'blast-head-art')}</span></span>
        <span class="cone-layer cone-l-front">${artOr('cone_front.png', CONE_FRONT_SVG, 'cone-art')}</span>
      </button>
      <div class="blast-caller">📣 ${escapeHtml(blast.sender || 'The Ringleader')} has something to holler!</div>
      <button class="blast-pickup">Step right up!</button>
    </div>`;
  document.body.appendChild(o);
  let rig = megaphone();
  let stopBlare = startBlare(rig);
  let babble = () => {};
  const mute = o.querySelector('.blast-mute');
  mute.onclick = () => {
    const off = !soundOff();
    try { localStorage.setItem('cs-sound-off', off ? '1' : '0'); } catch (e) { /* ignore */ }
    mute.textContent = off ? '🔇' : '🔊';
    stopBlare(); rig?.close(); rig = megaphone();
    if (o.classList.contains('ringing')) stopBlare = startBlare(rig);
    else { stopBlare = () => {}; babble = makeBabbler(rig); }
  };
  let typing = null;
  const finish = () => { stopBlare(); clearInterval(typing); rig?.close(); o.remove(); blastShowing = null; };
  const answer = () => {
    if (!o.classList.contains('ringing')) return;
    stopBlare();
    if (live && blast.id) apiFetch(`/api/me/blast/${blast.id}/seen`, { method: 'POST' }).catch(() => {});
    // A fresh rig born from this tap, so iPhones let the babble play.
    rig?.close(); rig = megaphone();
    playBoing(rig);
    babble = makeBabbler(rig);
    o.classList.remove('ringing'); o.classList.add('answered');
    o.querySelector('.blast-bubble').hidden = false;
    const out = o.querySelector('.blast-body'), headImg = o.querySelector('.blast-head-art'), head = o.querySelector('.blast-head');
    const text = blast.body || '';
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { out.textContent = text; return; }
    const mouths = ['head_open.png', 'head_wide.png', 'head_open.png', 'head_closed.png'];
    let i = 0, m = 0, said = 0;
    const done = () => { clearInterval(typing); head.classList.remove('yakking'); if (headImg) headImg.src = `${ROOM}head_closed.png`; };
    // Let the boing land, then holler: a character every 38ms, a babble
    // syllable on every other letter, mouth frames swapping as it goes.
    setTimeout(() => {
      if (!o.isConnected) return;
      head.classList.add('yakking');
      typing = setInterval(() => {
        const ch = text[i++];
        out.textContent = text.slice(0, i);
        if (ch && /[\p{L}\p{N}!?]/u.test(ch) && (said++ % 2 === 0 || ch === '!' || ch === '?')) {
          babble(ch);
          if (headImg) headImg.src = `${ROOM}${mouths[m++ % mouths.length]}`;
        }
        if (i >= text.length) done();
      }, 38);
    }, 450);
    o.querySelector('.blast-bubble').onclick = e => { if (!e.target.closest('button')) { i = text.length; out.textContent = text; done(); } };
  };
  o.querySelector('.blast-pickup').onclick = answer;
  o.querySelector('.blast-cone').onclick = answer;
  o.addEventListener('click', e => {
    if (e.target.dataset.done !== undefined) finish();
    if (e.target.dataset.go !== undefined) { finish(); location.hash = blast.url; }
  });
}

// ── The blast composer (Ringleaders) ──
async function renderBlastView(mainView) {
  if (!profile.is_ringleader) { mainView.innerHTML = '<h2>Ringleaders only</h2>'; return; }
  const { events } = await apiFetch('/api/events');
  const chapterOpts = chapters.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  const eventOpts = (events || []).map(e => `<option value="${e.id}">${escapeHtml(e.title)} · ${escapeHtml(formatEventDate(e.starts_at))}</option>`).join('');
  mainView.innerHTML = `
    <div class="forum">
      <div class="forum-banner">📣<span>Holler at Everyone</span></div>
      <div class="forum-sheet blast-sheet">
        <form id="blastForm" class="blast-form">
          <label class="blast-field">Headline<input name="title" maxlength="120" required placeholder="Tent raising Saturday — all hands!"></label>
          <label class="blast-field">Your message<textarea name="body" maxlength="1500" required placeholder="Say it in your voice. It types out while your head hollers it from the cone."></textarea><small id="blastCount">0 / 1500</small></label>
          <fieldset class="blast-field"><legend>Who hears it</legend>
            <div class="blast-aud">
              ${[['all', 'Everyone'], ['inner', 'Inner members'], ['courtyard', 'Courtyard members'], ['chapter', 'A chapter'], ['city', 'A city'], ['event', 'An event’s crew']].map(([v, l], i) =>
                `<label class="blast-pill"><input type="radio" name="aud" value="${v}" ${i === 0 ? 'checked' : ''}><span>${l}</span></label>`).join('')}
            </div>
            <select name="chapter" class="blast-sub" data-for="chapter" hidden>${chapterOpts}</select>
            <input name="city" class="blast-sub" data-for="city" hidden placeholder="e.g. Boulder">
            <select name="event" class="blast-sub" data-for="event" hidden>${eventOpts || '<option value="">No upcoming events</option>'}</select>
            <div class="blast-reach" id="blastReach">Counting…</div>
          </fieldset>
          <label class="blast-field">“Take me there” button<select name="link"><option value="">No button</option><option value="#/events">The corkboard (events)</option><option value="#/courtyard">The Courtyard</option>${(events || []).map(e => `<option value="#/event/${e.id}">${escapeHtml(e.title)}</option>`).join('')}</select></label>
          <label class="blast-check"><input type="checkbox" name="post" checked> Also pin it up in the Courtyard</label>
          <div class="blast-actions"><button type="button" class="forum-btn ghost" id="blastPreview">Preview the holler</button><button class="forum-btn blast-send">📣 HOLLER IT</button></div>
          <div class="forum-note-err" id="blastErr" role="status"></div>
        </form>
        <h3 class="blast-hist-h">Past blasts</h3>
        <div id="blastHistory" class="blast-history"><div class="forum-empty">Loading…</div></div>
      </div>
    </div>`;
  const form = document.getElementById('blastForm');
  const audience = () => {
    const type = form.aud.value;
    const value = type === 'chapter' ? form.chapter.value : type === 'city' ? form.city.value.trim() : type === 'event' ? form.event.value : null;
    const label = { all: 'Everyone', inner: 'Inner members', courtyard: 'Courtyard members',
      chapter: `Chapter: ${form.chapter.selectedOptions[0]?.text || ''}`, city: `City: ${value || ''}`, event: `Crew of ${form.event.selectedOptions[0]?.text.split(' · ')[0] || ''}` }[type];
    return { type, value, label };
  };
  let reachTimer;
  const updateReach = () => {
    form.querySelectorAll('.blast-sub').forEach(el => { el.hidden = el.dataset.for !== form.aud.value; });
    clearTimeout(reachTimer);
    reachTimer = setTimeout(async () => {
      try {
        const { recipients, phones } = await apiFetch('/api/blasts/preview', { method: 'POST', body: { audience: audience() } });
        document.getElementById('blastReach').textContent = `Reaches ${recipients} member${recipients === 1 ? '' : 's'} · ${phones} with the raven on their phone`;
      } catch (e) { document.getElementById('blastReach').textContent = e.message; }
    }, 250);
  };
  form.addEventListener('input', e => {
    if (e.target.name === 'body') document.getElementById('blastCount').textContent = `${e.target.value.length} / 1500`;
    if (['aud', 'chapter', 'city', 'event'].includes(e.target.name)) updateReach();
  });
  form.addEventListener('change', e => { if (['aud', 'chapter', 'event'].includes(e.target.name)) updateReach(); });
  updateReach();
  document.getElementById('blastPreview').onclick = () => {
    if (!form.title.value.trim() || !form.body.value.trim()) { document.getElementById('blastErr').textContent = 'Write a headline and a message to preview.'; return; }
    showBlast({ title: form.title.value.trim(), body: form.body.value.trim(), url: form.link.value || null, sender: profile.display_name }, { preview: true });
  };
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const reach = document.getElementById('blastReach').textContent;
    if (!confirm(`${reach}. Holler at them now?`)) return;
    const btn = form.querySelector('.blast-send'); btn.disabled = true;
    try {
      const r = await apiFetch('/api/blasts', { method: 'POST', body: { title: form.title.value, body: form.body.value, audience: audience(), url: form.link.value || null, post_to_courtyard: form.post.checked } });
      form.reset(); updateReach();
      document.getElementById('blastErr').textContent = '';
      drawHistory();
      const t = document.createElement('div'); t.className = 'room-toast show'; t.textContent = `📣 Hollering at ${r.recipients} members (${r.phones} phones)!`;
      document.body.appendChild(t); setTimeout(() => t.remove(), 4000);
    } catch (err) { document.getElementById('blastErr').textContent = err.message; }
    btn.disabled = false;
  });
  async function drawHistory() {
    const { blasts } = await apiFetch('/api/blasts');
    document.getElementById('blastHistory').innerHTML = blasts.length ? blasts.map(b => `
      <div class="blast-past">
        <div class="thread-title">${escapeHtml(b.title)}</div>
        <div class="thread-meta">${escapeHtml(b.audience?.label || b.audience?.type || '')} · ${timeAgo(sqlIso(b.created_at))}</div>
        <div class="blast-picked"><b>${b.seen}</b> of ${b.recipients} heard it<span class="blast-bar"><i style="width:${b.recipients ? Math.round((b.seen / b.recipients) * 100) : 0}%"></i></span></div>
      </div>`).join('') : '<div class="forum-empty">No hollers yet. The cone is waiting.</div>';
  }
  drawHistory();
}

// ── Letters (DMs): unread count for the raven + Messages badges. Checked
// alongside the chat poll; the room listens through roomHooks.
let letters = { unread: 0, from: [] };
let roomHooks = {};
async function refreshLetters() {
  if (!session || !isInnerMember()) return;
  try { letters = await apiFetch('/api/me/letters'); } catch (e) { return; }
  document.querySelectorAll('[data-letters-badge]').forEach(b => { b.hidden = !letters.unread; b.textContent = letters.unread > 9 ? '9+' : letters.unread; });
  roomHooks.onLetters?.();
}
function lettersBadge() { return `<span class="nav-badge" data-letters-badge ${letters.unread ? '' : 'hidden'}>${letters.unread > 9 ? '9+' : letters.unread}</span>`; }

// ── The Green Room: live chat (polled; D1 has no push). Lives in the shell
// so it follows you around: docked in the Dressing Room's left glow when
// there's space, otherwise a launcher that slides it in from the left.
const chat = { messages: [], lastId: 0, here: [], open: null, unread: 0, timer: null, busy: false };

function chatShellHtml() {
  return `
    <button class="chat-launcher" id="chatLauncher" aria-label="Open the Green Room chat">
      <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4z"/></svg>
      <span class="chat-launcher-label">Green Room</span>
      <span class="chat-unread" id="chatUnread" hidden></span>
    </button>
    <aside class="chat-panel" id="chatPanel" aria-label="The Green Room chat">
      <div class="chat-head">
        <div><div class="chat-title">The Green Room</div><div class="chat-here" id="chatHere"></div></div>
        <button class="chat-close" id="chatClose" aria-label="Close chat">×</button>
      </div>
      <div class="chat-list" id="chatList" aria-live="polite"></div>
      <form class="chat-form" id="chatForm">
        <input id="chatInput" maxlength="500" autocomplete="off" placeholder="Say something to the troupe…" aria-label="Chat message">
        <button class="chat-send" aria-label="Send">→</button>
      </form>
      <div class="chat-error" id="chatError" role="status"></div>
    </aside>`;
}

function mountChat() {
  const panel = document.getElementById('chatPanel');
  if (!panel) return;
  const onRoom = currentRoute() === 'dressing-room';
  // Docked only on the room page, and only when the side glow is wide enough.
  const sideSpace = (innerWidth - (innerHeight - 69)) / 2;
  const docked = onRoom && innerWidth > 800 && sideSpace >= 300;
  document.body.classList.toggle('chat-docked', docked);
  const isOpen = docked || chat.open === true;
  panel.classList.toggle('open', isOpen);
  document.getElementById('chatLauncher').hidden = docked;
  if (isOpen) chat.unread = 0;
  drawChat();
  document.getElementById('chatLauncher').onclick = () => { chat.open = true; mountChat(); document.getElementById('chatInput')?.focus(); };
  document.getElementById('chatClose').onclick = () => { chat.open = false; document.body.classList.remove('chat-docked'); panel.classList.remove('open'); document.getElementById('chatLauncher').hidden = false; drawUnread(); };
  document.getElementById('chatForm').onsubmit = async e => {
    e.preventDefault();
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text || chat.busy) return;
    chat.busy = true;
    try {
      await apiFetch('/api/chat', { method: 'POST', body: { body: text } });
      input.value = '';
      document.getElementById('chatError').textContent = '';
      await pollChat();
    } catch (err) { document.getElementById('chatError').textContent = err.message; }
    chat.busy = false;
  };
  document.getElementById('chatList').onclick = async e => {
    const id = e.target.dataset?.delChat;
    if (!id) return;
    await apiFetch(`/api/chat/${id}`, { method: 'DELETE' });
    chat.messages = chat.messages.filter(m => String(m.id) !== id);
    drawChat();
  };
  if (!chat.timer) startChat();
}

function chatIsOpen() { return document.getElementById('chatPanel')?.classList.contains('open'); }

function drawUnread() {
  const b = document.getElementById('chatUnread');
  if (!b) return;
  b.hidden = !chat.unread || chatIsOpen();
  b.textContent = chat.unread > 9 ? '9+' : chat.unread;
}

function drawChat() {
  const list = document.getElementById('chatList');
  if (!list) return;
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  const canMod = isModerator();
  list.innerHTML = chat.messages.length ? chat.messages.map(m => `
    <div class="chat-msg ${m.user_id === profile.id ? 'mine' : ''} ${m.is_ringleader ? 'ringleader' : ''}">
      <div class="chat-meta"><span class="chat-name">${escapeHtml(m.display_name)}</span>${m.is_ringleader ? '<span class="chat-tag">Ringleader</span>' : ''}<span class="chat-time">${timeAgo(m.created_at.replace(' ', 'T') + 'Z')}</span>
        ${m.user_id === profile.id || canMod ? `<button class="chat-del" data-del-chat="${m.id}" aria-label="Delete message">×</button>` : ''}</div>
      <div class="chat-body">${escapeHtml(m.body)}</div>
    </div>`).join('') : '<div class="chat-empty">It’s quiet back here. Say hello to the troupe.</div>';
  if (nearBottom || chat.justLoaded) { list.scrollTop = list.scrollHeight; chat.justLoaded = false; }
  const here = document.getElementById('chatHere');
  if (here) here.textContent = chat.here.length ? `${chat.here.length} here now · ${chat.here.slice(0, 4).join(', ')}${chat.here.length > 4 ? '…' : ''}` : '';
  drawUnread();
}

async function pollChat() {
  try {
    const { messages, here } = await apiFetch(`/api/chat${chat.lastId ? `?after=${chat.lastId}` : ''}`);
    if (!chat.lastId) chat.justLoaded = true;
    if (messages.length) {
      const fresh = messages.filter(m => m.user_id !== profile?.id);
      if (chat.lastId && !chatIsOpen()) chat.unread += fresh.length;
      chat.messages = [...chat.messages, ...messages].slice(-150);
      chat.lastId = messages[messages.length - 1].id;
    }
    chat.here = here || [];
    drawChat();
  } catch (e) { /* signed out or offline: try again next tick */ }
}

function startChat() {
  let n = 0;
  const tick = async () => {
    if (!session) { chat.timer = null; return; }
    if (document.visibilityState === 'visible') {
      await pollChat();
      if (!chatIsOpen() || n++ % 3 === 0) await refreshLetters();
      await checkBlast();
    }
    chat.timer = setTimeout(tick, chatIsOpen() ? 3000 : 10000);
  };
  pollChat(); refreshLetters(); checkBlast();
  chat.timer = setTimeout(tick, 3000);
}
// Coming back to the tab: catch up right away instead of waiting a tick.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && session && chat.timer) { pollChat(); refreshLetters(); checkBlast(); }
});
window.addEventListener('resize', () => { if (session && document.getElementById('chatPanel')) mountChat(); });

// ── The Room: the illustrated Dressing Room, everyone's landing page.
// One square painting (assets/room/room_bg.jpg) with tappable objects laid
// on top in % of the square, so it scales to any screen; on phones the
// square is wider than the screen and you swipe to look around.
const ROOM = 'assets/room/';
const ORACLES = { mercury: 'https://mercury-oracle.vercel.app/', field: 'https://heyneeff.github.io/field-oracle/' };

// Every placed thing in the room is an item: { id, role, img (asset name,
// or null for an invisible painted hotspot), l, t, w, h (hotspots only),
// rot, flip, z, n (which upcoming event, for flyers), anim }. The layout
// lives in the database (Arrange mode, Ringleaders); this is the default.
const ROOM_ASSETS = { trunk_closed: 338 / 329, trunk_open: 322 / 393, costume_ringmaster: 156 / 327, costume_teal: 143 / 382, costume_clown: 138 / 386, costume_purple: 165 / 348, costume_pink: 178 / 418, raven_perched: 151 / 287, raven_squawk: 208 / 297, flyer_circus: 147 / 239, flyer_volunteer: 122 / 212, flyer_carnival: 127 / 219, book_lectern: 188 / 282, book_open: 232 / 228, passport_closed: 145 / 212, passport_open: 191 / 181, perch_empty: 116 / 217, hatbox_closed: 185 / 160, hatbox_open: 222 / 279, popcorn: 132 / 189, potion: 76 / 161, coat_rack: 127 / 347, vanity: 283 / 271, rug: 315 / 205 };
const ROOM_ANIMS = { '': 'Still', sway: 'Sway (hangs from top)', flutter: 'Flutter', float: 'Float', breathe: 'Breathe', hop: 'Hop', shimmer: 'Shimmer', wobble: 'Wobble' };
const ROOM_ROLES = {
  decor: 'Just decoration', mirror: 'Mirror → My Profile', trunk: 'Trunk → Passport & Prizes', costume: 'Costume → Profile / acts',
  flyer: 'Flyer → an upcoming event', raven: 'Raven → volunteer requests', book: 'Big Book → the forum', drawer: 'Drawer → Messages',
  exit: 'Exit → Courtyard', hatbox: 'Hat box → Ringleader tools (only you see it)', potion: 'Secret → Mercury Oracle', stars: 'Secret → Field Oracle',
  popcorn: 'Popcorn (pops)', events: 'Events list', tickets: 'My Tickets',
};
const ROOM_DEFAULT = [
  { id: 'mirror', role: 'mirror', img: null, l: 6.5, t: 7, w: 33, h: 36 },
  { id: 'drawer', role: 'drawer', img: null, l: 18.5, t: 48.5, w: 17, h: 7 },
  { id: 'stars', role: 'stars', img: null, l: 0, t: 19, w: 5.5, h: 18 },
  { id: 'exit', role: 'exit', img: null, l: 91, t: 9, w: 9, h: 40 },
  { id: 'c1', role: 'costume', img: 'costume_ringmaster', l: 66.2, t: 7.4, w: 8.4, anim: 'sway' },
  { id: 'c2', role: 'costume', img: 'costume_clown', l: 74.4, t: 7.2, w: 7.8, anim: 'sway' },
  { id: 'c3', role: 'costume', img: 'costume_teal', l: 82, t: 7.2, w: 7.8, anim: 'sway' },
  { id: 'f1', role: 'flyer', n: 0, img: 'flyer_circus', l: 67.4, t: 33.5, w: 7.4, rot: -5, anim: 'flutter' },
  { id: 'f2', role: 'flyer', n: 1, img: 'flyer_volunteer', l: 75.4, t: 35.5, w: 6.8, rot: 4, anim: 'flutter' },
  { id: 'f3', role: 'flyer', n: 2, img: 'flyer_carnival', l: 82.6, t: 33.8, w: 7.0, rot: -5, anim: 'flutter' },
  { id: 'potion', role: 'potion', img: 'potion', l: 40.2, t: 37.4, w: 3.6, anim: 'shimmer' },
  { id: 'popcorn', role: 'popcorn', img: 'popcorn', l: 45.3, t: 36.8, w: 5.6, anim: 'wobble' },
  { id: 'book', role: 'book', img: 'book_lectern', l: 63.5, t: 54.5, w: 14, anim: 'float' },
  { id: 'raven', role: 'raven', img: 'raven_perched', l: 82, t: 55.5, w: 11, anim: 'breathe' },
  { id: 'trunk', role: 'trunk', img: 'trunk_closed', l: 3, t: 74, w: 22 },
  { id: 'hatbox', role: 'hatbox', img: 'hatbox_closed', l: 27.5, t: 85.5, w: 12 },
];
let roomEditing = false;

async function renderRoom(mainView) {
  mainView.classList.add('main-room');
  roomEditing = false;
  const [p, { events }, layout] = await Promise.all([
    apiFetch('/api/me/passport'), apiFetch('/api/events'), apiFetch('/api/room-layout').catch(() => ({ items: null })), refreshLetters(),
  ]);
  const upcoming = events || [];
  const request = upcoming.find(e => !myVolunteering.has(e.id));
  const latest = p.stamps[p.stamps.length - 1];
  let newStamp = false;
  try { newStamp = !!latest && localStorage.getItem('cs-prize-seen-' + profile.id) !== latest.id && Date.now() - sqlTime(latest.created_at) < 7 * 864e5; } catch (e) { /* no storage */ }
  const inner = isInnerMember();
  const saved = Array.isArray(layout.items) ? layout.items : ROOM_DEFAULT;
  let items = JSON.parse(JSON.stringify(saved));
  let selectedId = null;

  // What a role means right now: hover verb, destination (null = reacts in place).
  const behave = it => {
    switch (it.role) {
      case 'mirror': return ['Look in the Mirror', '#/profile'];
      case 'trunk': return [newStamp ? 'Open the Trunk (something new!)' : 'Open the Steamer Trunk', '#/passport'];
      case 'costume': return ['Try on a Costume', '#/profile'];
      case 'flyer': { const e = upcoming[it.n || 0]; return e ? [`Flyer: ${e.title}`, `#/event/${e.id}`] : ['Read the Flyers', '#/events']; }
      case 'raven': {
        if (letters.unread) {
          const f = letters.from[0];
          return [`Hear the Raven (a letter from ${f.display_name}!)`, letters.from.length === 1 ? `#/dm/${f.conversation_id}` : '#/dm'];
        }
        return request ? [`Hear the Raven (${request.title} needs hands)`, `#/event/${request.id}`] : ['Pet the Raven', null];
      }
      case 'book': return ['Open the Big Book', inner ? '#/guild-hall' : '#/courtyard'];
      case 'drawer': return inner ? ['Open the Drawer (your letters)', '#/dm'] : ['Try the Drawer (locked)', null];
      case 'exit': return ['Step out to the Courtyard', '#/courtyard'];
      case 'hatbox': return ['Open the Ringleader’s Hat Box', 'more'];
      case 'potion': return ['Drink the Strange Little Bottle', ORACLES.mercury];
      case 'stars': return ['Touch the Hanging Stars', ORACLES.field];
      case 'popcorn': return ['Eat the Popcorn', null];
      case 'events': return ['See what’s coming up', '#/events'];
      case 'tickets': return ['Find your Tickets', '#/tickets'];
      default: return [null, null];
    }
  };
  // Live state swaps art: the raven squawks, the trunk spills open.
  const look = it => {
    let img = it.img, w = it.w, t = it.t, anim = it.anim || '';
    // The raven really squawks: two frames (beak shut / beak open) flipped in
    // bursts — frantic for a letter, now-and-then for a volunteer call.
    let frames = null;
    if (!roomEditing && it.role === 'raven' && (request || letters.unread) && img === 'raven_perched') { frames = letters.unread ? 'frantic' : 'calm'; anim = 'hop'; }
    if (!roomEditing && it.role === 'trunk' && newStamp && img === 'trunk_closed') {
      img = 'trunk_open'; t = it.t + it.w / ROOM_ASSETS.trunk_closed - it.w / ROOM_ASSETS.trunk_open; anim = 'breathe';
    }
    return { img, w, t, anim, frames };
  };
  const visible = it => roomEditing || it.role !== 'hatbox' || profile.is_ringleader;

  const bulbs = [[9.2,19.2],[8.4,27.5],[8.8,35.6],[10.3,43.2],[15.6,13.8],[20.2,11.6],[26.5,13.9],[31.9,16.8],[34.7,23.1],[36.3,29.9],[37.1,37.1],[30.6,23.6]];
  const motes = Array.from({ length: 14 }, (_, i) => `<span class="room-mote" style="left:${(8 + (i * 61) % 84)}%;top:${(20 + (i * 37) % 60)}%;animation-delay:${(i * 0.9) % 11}s;animation-duration:${9 + (i % 5) * 2}s"></span>`).join('');

  mainView.innerHTML = `
    <div class="room-viewport" id="roomViewport">
      <div class="room-scene" id="roomScene">
        <img class="room-bg" src="${ROOM}room_bg.jpg" alt="" draggable="false">
        <div class="room-lamplight" aria-hidden="true"></div>
        ${bulbs.map(([x, y], i) => `<span class="room-bulb" style="left:${x}%;top:${y}%;animation-delay:${(i * 0.37) % 3}s;animation-duration:${2.6 + (i % 4) * 0.7}s" aria-hidden="true"></span>`).join('')}
        <div class="room-items" id="roomItems"></div>
        <div class="room-motes" aria-hidden="true">${motes}</div>
        <div class="room-labels" id="roomLabels" aria-hidden="true"></div>
      </div>
    </div>
    <div class="room-verb" id="roomVerb" aria-hidden="true"></div>
    <button class="room-reveal" id="roomReveal" aria-label="Show everything you can touch">✦</button>
    ${profile.is_ringleader ? '<button class="room-arrange-btn" id="roomArrange">✎ Arrange</button>' : ''}
    <div class="room-editor" id="roomEditor" hidden></div>
    <div class="room-toast" id="roomToast" role="status" aria-live="polite"></div>`;

  const scene = document.getElementById('roomScene');
  const host = document.getElementById('roomItems');
  const verb = document.getElementById('roomVerb');
  const toast = document.getElementById('roomToast');
  const editor = document.getElementById('roomEditor');
  let toastTimer;
  const say = line => {
    toast.textContent = line; toast.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
  };

  function draw() {
    scene.classList.toggle('editing', roomEditing);
    const order = items.map((it, i) => [it, i]).sort((a, b) => (a[0].z || 0) - (b[0].z || 0) || a[1] - b[1]).map(x => x[0]);
    host.innerHTML = order.filter(visible).map(it => {
      const v = look(it);
      const [label, href] = behave(it);
      const live = label !== null;
      const tf = `transform: rotate(${it.rot || 0}deg) scaleX(${it.flip ? -1 : 1});`;
      const sel = it.id === selectedId ? ' selected' : '';
      const handle = roomEditing ? '<span class="room-handle" data-handle></span>' : '';
      if (!v.img) {
        return `<button class="room-hot${sel}" data-item="${it.id}" ${live ? `aria-label="${escapeHtml(label)}"` : 'tabindex="-1" aria-hidden="true"'} style="left:${it.l}%;top:${it.t}%;width:${it.w}%;height:${it.h || 10}%">${roomEditing ? `<span class="room-hot-name">${escapeHtml(ROOM_ROLES[it.role] || it.role)}</span>` : ''}${handle}</button>`;
      }
      const tag = live || roomEditing ? 'button' : 'div';
      return `<${tag} class="room-obj ${v.anim}${live ? '' : ' decor'}${sel}" data-item="${it.id}" ${live ? `aria-label="${escapeHtml(label)}"` : 'aria-hidden="true"'} style="left:${it.l}%;top:${v.t}%;width:${v.w}%">
        <span class="room-turn" style="${tf}">${v.frames
          ? `<span class="raven-frames ${v.frames}"><img class="rf-shut" src="${ROOM}raven_perched.png" alt="" draggable="false"><img class="rf-open" src="${ROOM}raven_squawk.png" alt="" draggable="false"></span>`
          : `<img src="${ROOM}${v.img}.png" alt="" draggable="false">`}</span>${handle}</${tag}>`;
    }).join('') + (roomEditing ? '' : extras());
    if (roomEditing) renderEditor();
  }
  // Squawk bubble, exit sign and trunk glow ride along with their items.
  function extras() {
    let out = '';
    const raven = items.find(i => i.role === 'raven'), exit = items.find(i => i.role === 'exit'), trunk = items.find(i => i.role === 'trunk');
    if ((request || letters.unread) && raven) out += `<div class="room-squawk ${letters.unread ? 'letter' : ''}" style="left:${raven.l - 6}%;top:${raven.t - 4.5}%" aria-hidden="true">${letters.unread ? 'SQUAWK! A LETTER!' : 'SQUAWK!'}</div>`;
    if (exit) out += `<div class="room-exit-sign" style="left:${exit.l - 4}%;top:${exit.t + (exit.h || 10) - 5}%" aria-hidden="true">Courtyard →</div>`;
    if (newStamp && trunk) out += `<div class="room-trunk-glow" style="left:${trunk.l}%;top:${trunk.t - 3}%;width:${trunk.w}%;height:${trunk.w}%" aria-hidden="true"></div>`;
    return out;
  }

  // ── Playing: hover verb, one click opens ──
  const go = (el, it, href) => {
    if (href === 'more') { mobileNavOpen = true; renderShell(); return; }
    if (href.startsWith('http')) { window.open(href, '_blank', 'noopener'); return; }
    if (it.role === 'book') { openBookToward(el, href); return; }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { location.hash = href; return; }
    const sr = scene.getBoundingClientRect(), r = el.getBoundingClientRect();
    scene.style.transformOrigin = `${((r.left + r.width / 2 - sr.left) / sr.width) * 100}% ${((r.top + r.height / 2 - sr.top) / sr.height) * 100}%`;
    scene.classList.add('zooming');
    setTimeout(() => { location.hash = href; }, 380);
  };
  const quiet = {
    popcorn: el => {
      say('Still warm. Nobody knows who keeps refilling it.');
      const it = items.find(i => i.id === el.dataset.item);
      for (let i = 0; i < 7; i++) {
        const k = document.createElement('span');
        k.className = 'room-kernel';
        k.style.left = `${it.l + it.w / 2}%`; k.style.top = `${it.t + 0.5}%`;
        k.style.setProperty('--dx', `${(i - 3) * 14}px`); k.style.setProperty('--dy', `${-30 - (i % 3) * 18}px`);
        scene.appendChild(k); setTimeout(() => k.remove(), 900);
      }
      el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
    },
    raven: () => say('Croak. Nothing to squawk about right now. It’s keeping watch.'),
    drawer: () => say('Locked. The letters are for inner members — work two shifts to step inside.'),
  };
  host.addEventListener('mouseover', e => {
    const el = e.target.closest('[data-item]');
    if (!el || roomEditing) { verb.classList.remove('show'); return; }
    const [label] = behave(items.find(i => i.id === el.dataset.item));
    if (label) { verb.textContent = label; verb.classList.add('show'); } else verb.classList.remove('show');
  });
  host.addEventListener('mouseleave', () => verb.classList.remove('show'));
  host.addEventListener('click', e => {
    if (roomEditing) return;
    const el = e.target.closest('[data-item]');
    if (!el) return;
    const it = items.find(i => i.id === el.dataset.item);
    if (it.role === 'trunk') { openTrunk(el, it); return; }
    const [, href] = behave(it);
    if (href) go(el, it, href); else quiet[it.role]?.(el);
  });

  // ── The trunk: badges fly out and display across the room. ──
  let trunkOpen = false;
  function openTrunk(trunkEl, trunkItem) {
    if (trunkOpen) return;
    trunkOpen = true;
    verb.classList.remove('show');
    const counts = {}, lastOf = {};
    p.stamps.forEach(st => { counts[st.kind] = (counts[st.kind] || 0) + 1; lastOf[st.kind] = st; });
    const newest = latest && newStamp ? latest.kind : null;
    try { if (latest) localStorage.setItem('cs-prize-seen-' + profile.id, latest.id); } catch (e) { /* ignore */ }
    // Lid opens.
    const img = trunkEl.querySelector('img');
    if (img && trunkItem.img === 'trunk_closed') {
      img.src = `${ROOM}trunk_open.png`;
      trunkEl.style.top = `${trunkItem.t + trunkItem.w / ROOM_ASSETS.trunk_closed - trunkItem.w / ROOM_ASSETS.trunk_open}%`;
    }
    // Two gentle rows across the middle of the room; newest flies last.
    const slots = [[20, 26], [38.5, 22], [57, 22], [75.5, 26], [20, 50], [38.5, 46], [57, 46], [75.5, 50]];
    const kinds = [...BADGE_ORDER, 'mystery'];
    if (newest) { kinds.splice(kinds.indexOf(newest), 1); kinds.push(newest); }
    const sr = scene.getBoundingClientRect(), tr = trunkEl.getBoundingClientRect();
    const tx = tr.left + tr.width / 2 - sr.left, ty = tr.top + tr.height * 0.3 - sr.top;
    const layer = document.createElement('div');
    layer.className = 'trunk-display';
    const progress = p.next ? `
      <div class="td-progress" role="img" aria-label="${p.counts.total} of 3 stamps, ${p.counts.roustabouts} of 2 shifts toward Apprentice">
        <span class="td-rank">${escapeHtml(rankLabel(p.user.rank))}</span><span class="td-arrow">→ Apprentice</span>
        <span class="td-pips">${[0, 1, 2].map(i => `<i class="${i < p.counts.total ? 'on' : ''}"></i>`).join('')}<em>stamps</em></span>
        <span class="td-pips">${[0, 1].map(i => `<i class="${i < p.counts.roustabouts ? 'on' : ''}"></i>`).join('')}<em>shifts</em></span>
      </div>` : `<div class="td-progress"><span class="td-rank">${escapeHtml(p.user.is_ringleader ? 'Ringleader' : rankLabel(p.user.rank))}</span><span class="td-arrow">${p.counts.total} stamps won</span></div>`;
    layer.innerHTML = `<div class="td-dim"></div>${progress}` + kinds.map((k, i) => {
      const [x, y] = slots[BADGE_ORDER.concat('mystery').indexOf(k)];
      const won = k !== 'mystery' && counts[k];
      const b = BADGES[k];
      const dx = tx - (x / 100) * sr.width, dy = ty - (y / 100) * sr.height;
      return `<button class="td-badge ${won ? 'won' : 'ghost'} ${k === newest ? 'newest' : ''}" data-kind="${k}" style="left:${x}%;top:${y}%;--dx:${dx.toFixed(0)}px;--dy:${dy.toFixed(0)}px;--delay:${(i * 0.12).toFixed(2)}s;${b ? `--badge:${b.color}` : ''}" aria-label="${escapeHtml(b ? b.name : 'Mystery prize')}${won ? ', won' : ', not yet won'}">
        <span class="td-patch">${b ? badgeIcon(k, 34) : '<span class="td-q">?</span>'}${won > 1 ? `<span class="td-count">×${won}</span>` : ''}</span>
        <span class="td-name">${escapeHtml(b ? b.name : '???')}</span>
        ${k === newest ? '<span class="td-new">NEW!</span>' : ''}
      </button>`;
    }).join('');
    scene.appendChild(layer);
    void layer.offsetWidth; // commit the start positions, then let them fly
    setTimeout(() => layer.classList.add('out'), 30);

    // Story plaque + ways out.
    const plaque = document.createElement('div');
    plaque.className = 'room-plaque trunk-plaque';
    plaque.setAttribute('role', 'status');
    const tell = k => {
      layer.querySelectorAll('.td-badge').forEach(n => n.classList.toggle('picked', n.dataset.kind === k));
      const b = BADGES[k], st = lastOf[k];
      const title = b ? b.name : '???';
      const line = !b ? 'Some prizes are a surprise. Keep showing up.'
        : st ? `“${b.motto}” — ${st.event_title ? escapeHtml(st.event_title) + ', ' : ''}${new Date(sqlTime(st.created_at)).toLocaleDateString()}${counts[k] > 1 ? ` · won ${counts[k]} times` : ''}`
        : `Not won yet. ${b.how}`;
      plaque.querySelector('.room-plaque-title').textContent = title;
      plaque.querySelector('.room-plaque-line').innerHTML = line;
    };
    plaque.innerHTML = `
      <div class="room-plaque-title">The Steamer Trunk</div>
      <div class="room-plaque-line">${p.stamps.length ? 'Every prize you’ve won, out on display. Tap one to hear its story.' : 'Empty so far — every carnie starts somewhere. Work a shift to win your first.'}</div>
      <div class="td-actions"><button class="room-plaque-btn" data-td="passport">Open the passport book →</button><button class="room-plaque-btn td-close" data-td="close">Put it all back</button></div>`;
    mainView.appendChild(plaque);
    layer.addEventListener('click', e => {
      const b = e.target.closest('.td-badge');
      if (b) tell(b.dataset.kind); else close();
    });
    plaque.addEventListener('click', e => {
      if (e.target.dataset.td === 'passport') { location.hash = '#/passport'; }
      if (e.target.dataset.td === 'close') close();
    });
    if (newest) setTimeout(() => tell(newest), 900 + kinds.length * 120);
    const vp = document.getElementById('roomViewport');
    vp.scrollTo({ left: (vp.scrollWidth - vp.clientWidth) / 2, behavior: 'smooth' });

    function close() {
      if (!trunkOpen) return;
      layer.classList.remove('out');
      layer.classList.add('closing');
      plaque.remove();
      setTimeout(() => { layer.remove(); trunkOpen = false; newStamp = false; draw(); }, 650);
    }
  }

  // ✦ reveal: one short label per kind of thing, for a few seconds.
  const labels = document.getElementById('roomLabels');
  document.getElementById('roomReveal').addEventListener('click', () => {
    const sr = scene.getBoundingClientRect();
    const SHORT = { mirror: 'Mirror', drawer: 'Drawer', stars: 'Stars', exit: 'Courtyard', costume: 'Costumes', flyer: 'Flyers', potion: 'Bottle', popcorn: 'Popcorn', book: 'Big Book', raven: 'Raven', trunk: 'Trunk', hatbox: 'Hat Box', events: 'Events', tickets: 'Tickets' };
    const groups = {};
    host.querySelectorAll('[data-item]').forEach(el => {
      const it = items.find(i => i.id === el.dataset.item);
      if (!SHORT[it.role]) return;
      const r = el.getBoundingClientRect();
      const b = groups[it.role] || (groups[it.role] = { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity });
      b.l = Math.min(b.l, r.left); b.t = Math.min(b.t, r.top); b.r = Math.max(b.r, r.right); b.b = Math.max(b.b, r.bottom);
      el.classList.add('revealed');
    });
    labels.innerHTML = Object.entries(groups).map(([g, b]) =>
      `<span class="room-label" style="left:${(((b.l + b.r) / 2 - sr.left) / sr.width) * 100}%;top:${(((b.t + b.b) / 2 - sr.top) / sr.height) * 100}%">${escapeHtml(SHORT[g])}</span>`).join('');
    labels.classList.add('show');
    setTimeout(() => { labels.classList.remove('show'); host.querySelectorAll('.revealed').forEach(el => el.classList.remove('revealed')); }, 3200);
  });

  // ── Arrange mode (Ringleaders): drag, resize, rotate, flip, layer, add,
  // delete, choose what things do; Save publishes for everyone.
  // Drag/resize ported from the unison-map editor.
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const sel = () => items.find(i => i.id === selectedId);
  host.addEventListener('pointerdown', e => {
    if (!roomEditing) return;
    const el = e.target.closest('[data-item]');
    if (!el) { selectedId = null; draw(); return; }
    e.preventDefault();
    const it = items.find(i => i.id === el.dataset.item);
    if (selectedId !== it.id) { selectedId = it.id; draw(); }
    const rect = scene.getBoundingClientRect();
    const node = host.querySelector(`[data-item="${it.id}"]`);
    if (e.target.closest('[data-handle]')) {
      const ax = rect.left + (it.l / 100) * rect.width, ay = rect.top + (it.t / 100) * rect.height;
      const d0 = Math.max(1, Math.hypot(e.clientX - ax, e.clientY - ay));
      const w0 = it.w, h0 = it.h;
      const onMove = ev => {
        const f = Math.hypot(ev.clientX - ax, ev.clientY - ay) / d0;
        it.w = +clamp(w0 * f, 1.5, 90).toFixed(2);
        if (!it.img) it.h = +clamp((h0 || 10) * f, 1.5, 90).toFixed(2);
        node.style.width = it.w + '%';
        if (!it.img) node.style.height = it.h + '%';
      };
      const onUp = () => { document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); draw(); };
      document.addEventListener('pointermove', onMove); document.addEventListener('pointerup', onUp);
      return;
    }
    const sx = e.clientX, sy = e.clientY, l0 = it.l, t0 = it.t;
    const onMove = ev => {
      it.l = +clamp(l0 + ((ev.clientX - sx) / rect.width) * 100, -10, 100).toFixed(2);
      it.t = +clamp(t0 + ((ev.clientY - sy) / rect.height) * 100, -10, 100).toFixed(2);
      node.style.left = it.l + '%'; node.style.top = it.t + '%';
    };
    const onUp = () => { document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); draw(); };
    document.addEventListener('pointermove', onMove); document.addEventListener('pointerup', onUp);
  });

  function renderEditor() {
    const it = sel();
    const opt = (map, val) => Object.entries(map).map(([k, v]) => `<option value="${k}" ${k === (val || '') ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('');
    editor.innerHTML = `
      <div class="re-row re-title"><strong>Arrange the room</strong><span class="re-hint">Drag to move · gold corner to resize</span></div>
      ${it ? `
        <div class="re-row"><label>It does<select data-f="role">${opt(ROOM_ROLES, it.role)}</select></label></div>
        ${it.role === 'flyer' ? `<div class="re-row"><label>Which event<select data-f="n">${[0, 1, 2, 3, 4, 5].map(n => `<option value="${n}" ${n === (it.n || 0) ? 'selected' : ''}>${['Next', '2nd', '3rd', '4th', '5th', '6th'][n]} upcoming</option>`).join('')}</select></label></div>` : ''}
        ${it.img ? `<div class="re-row"><label>Moves<select data-f="anim">${opt(ROOM_ANIMS, it.anim)}</select></label>
          <label>Art<select data-f="img">${Object.keys(ROOM_ASSETS).map(k => `<option ${k === it.img ? 'selected' : ''}>${k}</option>`).join('')}</select></label></div>` : ''}
        <div class="re-row"><label class="re-wide">Rotate <input type="range" min="-45" max="45" step="1" value="${it.rot || 0}" data-f="rot"></label></div>
        <div class="re-row re-btns">
          ${it.img ? '<button data-a="flip">Flip</button>' : ''}
          <button data-a="back">Send back</button><button data-a="front">Bring forward</button>
          <button data-a="dup">Duplicate</button><button data-a="del" class="re-danger">Delete</button>
        </div>` : '<div class="re-row re-hint">Tap something in the room to select it.</div>'}
      <div class="re-row re-add"><select id="reAddArt"><option value="">+ Add a thing…</option>${Object.keys(ROOM_ASSETS).map(k => `<option>${k}</option>`).join('')}<option value="__hot">Invisible hotspot (for painted things)</option></select></div>
      <div class="re-row re-btns re-save">
        <button data-a="save" class="re-primary">Save for everyone</button><button data-a="cancel">Cancel</button><button data-a="reset">Reset to default</button>
      </div>`;
  }
  editor.addEventListener('input', e => {
    const it = sel(); const f = e.target.dataset.f;
    if (!it || !f) return;
    if (f === 'rot') { it.rot = +e.target.value; const n = host.querySelector(`[data-item="${it.id}"] .room-turn`); if (n) n.style.transform = `rotate(${it.rot}deg) scaleX(${it.flip ? -1 : 1})`; }
  });
  editor.addEventListener('change', e => {
    if (e.target.id === 'reAddArt') {
      const art = e.target.value; if (!art) return;
      const id = 'x' + Math.random().toString(36).slice(2, 8);
      items.push(art === '__hot' ? { id, role: 'decor', img: null, l: 42, t: 42, w: 14, h: 14 } : { id, role: 'decor', img: art, l: 42, t: 40, w: 12, z: 5 });
      selectedId = id; draw(); return;
    }
    const it = sel(); const f = e.target.dataset.f;
    if (!it || !f || f === 'rot') return;
    it[f] = f === 'n' ? +e.target.value : e.target.value;
    draw();
  });
  editor.addEventListener('click', async e => {
    const a = e.target.dataset.a; if (!a) return;
    const it = sel();
    if (a === 'flip' && it) { it.flip = !it.flip; draw(); }
    if (a === 'front' && it) { it.z = Math.max(...items.map(i => i.z || 0)) + 1; draw(); }
    if (a === 'back' && it) { it.z = Math.min(...items.map(i => i.z || 0)) - 1; draw(); }
    if (a === 'dup' && it) { const c = { ...it, id: 'x' + Math.random().toString(36).slice(2, 8), l: it.l + 2, t: it.t + 2 }; items.push(c); selectedId = c.id; draw(); }
    if (a === 'del' && it) { items = items.filter(i => i !== it); selectedId = null; draw(); }
    if (a === 'cancel') { exitEditing(); }
    if (a === 'reset') { if (!confirm('Put the room back to the default arrangement for everyone?')) return; await apiFetch('/api/room-layout', { method: 'PUT', body: { items: null } }); items = JSON.parse(JSON.stringify(ROOM_DEFAULT)); exitEditing(true); say('Back to the default room.'); }
    if (a === 'save') {
      try {
        await apiFetch('/api/room-layout', { method: 'PUT', body: { items } });
        exitEditing(true); say('Saved. Everyone sees your room now.');
      } catch (err) { say(`Couldn't save: ${err.message}`); }
    }
  });
  function exitEditing(keep) {
    roomEditing = false; selectedId = null;
    if (!keep) items = JSON.parse(JSON.stringify(saved));
    editor.hidden = true; document.getElementById('roomArrange').textContent = '✎ Arrange';
    draw();
  }
  document.getElementById('roomArrange')?.addEventListener('click', e => {
    if (roomEditing) { exitEditing(); return; }
    roomEditing = true; editor.hidden = false; e.currentTarget.textContent = '✕ Stop arranging';
    say('Arrange mode: drag things around. Nothing opens until you stop.');
    draw();
  });

  let lettersSeen = letters.unread;
  roomHooks.onLetters = () => {
    if (roomEditing) return;
    if (letters.unread > lettersSeen && letters.from[0]) say(`SQUAWK! A letter from ${letters.from[0].display_name}!`);
    lettersSeen = letters.unread;
    draw();
  };
  draw();
  if (letters.unread && letters.from[0]) say(`SQUAWK! ${letters.unread === 1 ? 'A letter' : `${letters.unread} letters`} waiting — the raven has them.`);
  offerRaven(mainView);
  // Phones: the square room is wider than the screen. Start centered, or
  // turned toward the raven when it has something to squawk about.
  const vp = document.getElementById('roomViewport');
  requestAnimationFrame(() => {
    const max = vp.scrollWidth - vp.clientWidth;
    if (max <= 0) return;
    vp.scrollLeft = request || letters.unread ? max : max / 2;
    say('⟷ Swipe to look around · tap ✦ to see what you can touch');
  });
}

// A one-time (per device) invitation in the room for the raven to follow you.
async function offerRaven(mainView) {
  let dismissed = false;
  try { dismissed = !!localStorage.getItem('cs-raven-offer'); } catch (e) { return; }
  const env = ravenEnv();
  if (dismissed || (!env.supported && !env.ios)) return;
  if (await ravenSubscribed()) return;
  setTimeout(() => {
    if (!document.body.contains(mainView)) return;
    const card = document.createElement('div');
    card.className = 'raven-offer';
    card.innerHTML = `
      <img src="${ROOM}raven_squawk.png" alt="" class="raven-offer-bird">
      <div class="raven-offer-text"><strong>Let the raven follow you home?</strong><span>It’ll squawk on your phone for letters, volunteer calls and prizes.</span></div>
      <div class="raven-offer-btns">
        <button class="room-plaque-btn" data-yes>Yes, follow me</button>
        ${deferredInstall ? '<button class="room-plaque-btn td-close" data-install>Install the app</button>' : ''}
        <button class="raven-offer-no" data-no>Not now</button>
      </div>`;
    mainView.appendChild(card);
    const done = () => { try { localStorage.setItem('cs-raven-offer', '1'); } catch (e) { /* ignore */ } card.remove(); };
    card.querySelector('[data-no]').onclick = done;
    card.querySelector('[data-install]')?.addEventListener('click', () => { deferredInstall.prompt(); deferredInstall = null; });
    card.querySelector('[data-yes]').onclick = async () => {
      const r = await followRaven();
      if (r === 'ios-install') { showIosInstall(); return; }
      done();
      const t = document.getElementById('roomToast');
      if (t) { t.textContent = RAVEN_RESULT[r]; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 4500); }
    };
  }, 2500);
}

// The big fat book swings toward you and fills the screen, then the forum.
function openBookToward(bookEl, href) {
  const r = bookEl.getBoundingClientRect();
  const fx = document.createElement('div');
  fx.className = 'book-open-fx';
  fx.innerHTML = `<img src="${ROOM}book_open.png" alt="">`;
  document.body.appendChild(fx);
  const img = fx.querySelector('img');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { fx.remove(); location.hash = href; return; }
  const cx = r.left + r.width / 2 - innerWidth / 2, cy = r.top + r.height / 2 - innerHeight / 2;
  img.animate([
    { transform: `translate(${cx}px, ${cy}px) scale(0.15) rotateX(55deg)`, opacity: 0.4 },
    { transform: 'translate(0, 0) scale(1) rotateX(0deg)', opacity: 1 },
  ], { duration: 650, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'forwards' });
  setTimeout(() => {
    location.hash = href;
    fx.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: 'forwards' }).onfinish = () => fx.remove();
  }, 700);
}

// One continuous ring of vanity bulbs traced around the real mirror size:
// up the arch, down both sides, across the bottom; the chase runs the ring.
function drawMirrorBulbs(mirror) {
  if (!mirror) return;
  const host = mirror.querySelector('.dr-bulbs');
  const draw = () => {
    if (!document.body.contains(mirror)) { window.removeEventListener('resize', draw); return; }
    const W = mirror.clientWidth, H = mirror.clientHeight, inset = 13;
    const archR = Math.min(W / 2, 170);
    const cx = W / 2, rx = cx - inset, cy = archR, ry = archR - inset;
    const pts = [];
    const nArch = Math.max(9, Math.round((Math.PI * (rx + ry) / 2) / 34));
    for (let i = 0; i <= nArch; i++) { const a = Math.PI - (Math.PI * i) / nArch; pts.push([cx + rx * Math.cos(a), cy - ry * Math.sin(a)]); }
    const sideTop = cy + 28, sideBottom = H - inset - 26;
    const nSide = Math.max(1, Math.round((sideBottom - sideTop) / 38));
    const side = Array.from({ length: nSide + 1 }, (_, i) => sideTop + ((sideBottom - sideTop) * i) / nSide);
    side.forEach(y => pts.push([W - inset, y]));
    const nBottom = Math.max(3, Math.round((W - 2 * inset) / 38));
    for (let i = 1; i < nBottom; i++) pts.push([W - inset - ((W - 2 * inset) * i) / nBottom, H - inset]);
    side.slice().reverse().forEach(y => pts.push([inset, y]));
    const period = 2.4;
    host.innerHTML = pts.map(([x, y], i) => `<span class="cs-bulb" style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;animation-delay:${((i * period) / pts.length).toFixed(2)}s"></span>`).join('');
  };
  draw();
  window.addEventListener('resize', draw);
}

// "Winner!" moment for a stamp you haven't seen yet. Remembered per device
// (localStorage) — a missed one just shows on the next visit; no storage, no show.
function maybeShowPrize(p) {
  const latest = p.stamps[p.stamps.length - 1];
  if (!latest) return;
  const key = 'cs-prize-seen-' + profile.id;
  let seen;
  try { seen = localStorage.getItem(key); } catch (e) { return; }
  const markSeen = () => { try { localStorage.setItem(key, latest.id); } catch (e) { /* ignore */ } };
  if (seen === latest.id) return;
  if (Date.now() - sqlTime(latest.created_at) > 7 * 864e5) { markSeen(); return; }
  renderPrizeMoment(latest, p, markSeen);
}

function renderPrizeMoment(stamp, p, done) {
  const b = BADGES[stamp.kind];
  const overlay = document.createElement('div');
  overlay.className = 'prize-moment';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', `You won ${b.name}`);
  const balloons = ['#C77B8A', '#DFBE7D', '#4E8C82', '#8B5FA3', '#C97C3D'].map((c, i) =>
    `<span class="pm-balloon" style="--c:${c};--x:${8 + i * 19}%;--d:${(i * 0.35).toFixed(2)}s"></span>`).join('');
  overlay.innerHTML = `
    <div class="pm-card">
      <div class="pm-lights" aria-hidden="true">${Array.from({ length: 8 }, (_, i) => `<span class="cs-bulb" style="animation-delay:${(i * 0.2).toFixed(1)}s"></span>`).join('')}</div>
      <div class="pm-balloons" aria-hidden="true">${balloons}</div>
      <div class="pm-winner">Winner!</div>
      <div class="pm-sub">A prize for your Dressing Room</div>
      <div class="pm-patch" style="--badge:${b.color}">${badgeIcon(stamp.kind, 46)}<span>${escapeHtml(b.name)}</span></div>
      <div class="pm-motto">“${escapeHtml(b.motto)}”</div>
      <div class="pm-ticket">
        <span class="pm-ticket-top">Admit one</span>
        <span class="pm-ticket-main">${escapeHtml(p.next ? passportProgressText(p) : (stamp.event_title || 'Added to your shelf'))}</span>
      </div>
      <button class="pm-btn" id="pmDone">Put it on my shelf</button>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => { done(); overlay.remove(); };
  overlay.querySelector('#pmDone').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('#pmDone').focus();
}

// Moderator view of someone's passport + hand-granted stamps (Directory).
async function openPassportModal(userId) {
  const overlay = document.createElement('div');
  overlay.className = 'admin-edit-overlay open';
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  async function draw(flash = '') {
    const p = await apiFetch(`/api/members/${userId}/passport`);
    overlay.innerHTML = `
      <div class="admin-edit-modal">
        <div class="admin-edit-modal-header"><h3>${escapeHtml(p.user.display_name)}'s Passport</h3><button data-close>&times;</button></div>
        <div class="admin-edit-modal-body">
          <div class="passport-progress">${escapeHtml(p.user.is_ringleader ? 'Ringleader' : rankLabel(p.user.rank))} · ${p.counts.total} stamps, ${p.counts.roustabouts} Roustabout</div>
          ${flash ? `<div class="stamp-flash">${flash}</div>` : ''}
          <div class="passport-pages">${p.stamps.map(s => `
            <div class="passport-page">
              <span class="passport-page-glyph">${BADGES[s.kind].glyph}</span>
              <strong>${escapeHtml(BADGES[s.kind].name)}</strong>
              <span class="post-meta">${s.event_title ? escapeHtml(s.event_title) + ' · ' : ''}${escapeHtml(s.created_at.slice(0, 10))}${s.note ? ' · ' + escapeHtml(s.note) : ''}</span>
              <button class="action-btn danger" data-remove-stamp="${s.id}">Remove</button>
            </div>`).join('') || '<div class="placeholder-note">No stamps yet.</div>'}</div>
          <form class="ticket-tier-form" id="grantStampForm">
            <select name="kind">${HAND_GRANTED_BADGES.map(k => `<option value="${k}">${BADGES[k].glyph} ${escapeHtml(BADGES[k].name)}</option>`).join('')}</select>
            <input type="text" name="note" maxlength="300" placeholder="What for? (e.g. built the ticket booth)">
            <button type="submit" class="composer-submit">Grant stamp</button>
          </form>
        </div>
      </div>`;
    overlay.querySelector('[data-close]').onclick = close;
    overlay.querySelectorAll('[data-remove-stamp]').forEach(btn => btn.addEventListener('click', async () => {
      await apiFetch(`/api/stamps/${btn.dataset.removeStamp}`, { method: 'DELETE' });
      draw();
    }));
    overlay.querySelector('#grantStampForm').addEventListener('submit', async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const r = await apiFetch('/api/stamps', { method: 'POST', body: { user_id: userId, kind: f.get('kind'), note: f.get('note') } });
      draw(r.promoted ? `🎉 ${escapeHtml(p.user.display_name)} just became an Apprentice and stepped inside!` : '');
    });
  }
  draw();
}

// "Welcome inside" moment — shown once per new rank (users.celebrated_rank).
function needsRankCelebration() {
  return !!profile && !profile.is_ringleader && profile.rank !== 'clown' && profile.celebrated_rank !== profile.rank;
}
function renderRankCelebration() {
  const rank = profile.rank;
  const lines = {
    apprentice: "You've worked the shifts and earned your stamps. The Threshold is crossed. Welcome inside the guild.",
    journeyman: 'Your craft has been seen by those who practice it. Welcome, Journeyman.',
    master: 'The guild names you Master. Raise the big top.',
  };
  const confetti = Array.from({ length: 40 }, (_, i) =>
    `<span class="confetti" style="--x:${Math.random() * 100}vw;--d:${(Math.random() * 1.5 + 2).toFixed(2)}s;--delay:${(Math.random() * 0.8).toFixed(2)}s;--c:${['#C8A05A', '#9B3036', '#4E8C82', '#C77B8A', '#DFBE7D'][i % 5]}"></span>`).join('');
  const overlay = document.createElement('div');
  overlay.className = 'rank-celebration';
  overlay.innerHTML = `${confetti}
    <div class="rank-celebration-card">
      <div class="rank-celebration-kicker">Huzzah!</div>
      <h1>${escapeHtml(rankLabel(rank))}</h1>
      <p>${escapeHtml(lines[rank] || 'Your rank in the guild has risen.')}</p>
      <button class="auth-submit" id="celebrateBtn">Step inside</button>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#celebrateBtn').addEventListener('click', async () => {
    const { user } = await apiFetch('/api/me', { method: 'PATCH', body: { celebrated_rank: rank } });
    profile = user;
    overlay.remove();
    await loadAppData();
    location.hash = '#/dressing-room';
    render();
  });
}

// ── Tiers + tickets ───────────────────────────────────────────────────
// Courtyard = free account (info only). Inner = paid the one-time $5 (or was
// already in the network). Server enforces this; the UI just mirrors it.
function isInnerMember() {
  return !!profile && (profile.tier === 'inner' || !!profile.is_ringleader);
}
function money(cents) {
  return cents === 0 ? 'Free' : '$' + (cents / 100).toFixed(cents % 100 ? 2 : 0);
}
function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
}

// Rank is earned, not bought: the $5 only buys The Fix Is In stamp.
function courtyardPathCta(lead) {
  return `
    <div class="ticket-join">
      <div>${escapeHtml(lead)} Earn your way inside: <strong>3 passport stamps, including 2 volunteer shifts</strong>.</div>
      <div class="post-actions">
        <a class="action-btn" href="#/dressing-room">See my prizes</a>
        <a class="action-btn" href="#/events">Volunteer</a>
        ${appConfig.payments_enabled ? `<button class="action-btn" data-join>${BADGES.fix.glyph} The Fix Is In — $5</button>` : ''}
      </div>
    </div>`;
}

async function startMembershipCheckout(btn) {
  btn.disabled = true;
  try {
    const { url } = await apiFetch('/api/membership/checkout', { method: 'POST' });
    window.location.href = url;
  } catch (err) {
    btn.disabled = false;
    alert(err.message);
  }
}

async function renderTicketPanel(eventId) {
  const el = document.getElementById('ticketPanel-' + eventId);
  if (!el) return;
  const canManage = !!profile?.is_ringleader;
  const { tiers } = await apiFetch(`/api/events/${eventId}/ticket-tiers`);
  if (!tiers.length && !canManage) { el.innerHTML = ''; return; }

  const inner = isInnerMember();
  const tierRows = tiers.map(t => {
    const soldOut = t.remaining === 0;
    return `<div class="ticket-tier">
      <div>
        <strong>${escapeHtml(t.name)}</strong> · ${money(t.price_cents)}
        ${t.remaining != null ? `<span class="ticket-remaining">${soldOut ? 'sold out' : t.remaining + ' left'}</span>` : ''}
        ${t.description ? `<div class="post-meta">${escapeHtml(t.description)}</div>` : ''}
      </div>
      ${inner && (t.price_cents === 0 || appConfig.payments_enabled) ? `<button class="action-btn" data-buy-tier="${t.id}" ${soldOut ? 'disabled' : ''}>${t.price_cents === 0 ? 'Claim' : 'Buy'}</button>` : ''}
    </div>`;
  }).join('');

  const joinCta = !inner && tiers.length ? courtyardPathCta('Tickets are for inner members.') : '';

  const manage = canManage ? `
    <details class="ticket-manage"><summary>Add ticket tier</summary>
      <form class="ticket-tier-form">
        <input type="text" name="name" placeholder="Tier name (e.g. General, VIP)" required>
        <input type="number" name="price" min="0" step="0.01" placeholder="Price in dollars (0 = free)" required>
        <input type="number" name="capacity" min="1" placeholder="Capacity (blank = unlimited)">
        <input type="text" name="description" placeholder="Description (optional)">
        <button type="submit" class="composer-submit">Add Tier</button>
      </form>
    </details>
    <a class="action-btn" href="#/checkin/${eventId}">Door check-in</a>` : '';

  el.innerHTML = `<div class="ticket-box">${tierRows}${joinCta}${manage}</div>`;

  el.querySelectorAll('[data-buy-tier]').forEach(btn => btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const res = await apiFetch(`/api/events/${eventId}/tickets`, { method: 'POST', body: { tier_id: btn.dataset.buyTier } });
      if (res.url) window.location.href = res.url; else location.hash = '#/tickets';
    } catch (err) { btn.disabled = false; alert(err.message); }
  }));
  const join = el.querySelector('[data-join]');
  if (join) join.addEventListener('click', () => startMembershipCheckout(join));
  const form = el.querySelector('.ticket-tier-form');
  if (form) form.addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(form);
    await apiFetch(`/api/events/${eventId}/ticket-tiers`, { method: 'POST', body: {
      name: f.get('name').trim(),
      price_cents: Math.round(Number(f.get('price')) * 100),
      capacity: f.get('capacity') ? Number(f.get('capacity')) : null,
      description: f.get('description').trim() || null,
    } });
    renderTicketPanel(eventId);
  });
}

async function renderMyTicketsView(mainView) {
  mainView.innerHTML = `<h2>My Tickets</h2><div class="placeholder-note">Loading…</div>`;
  const { tickets } = await apiFetch('/api/me/tickets');
  const joinCta = !isInnerMember() ? courtyardPathCta("You're in the courtyard. Tickets are for inner members.") : '';
  const list = tickets.length ? tickets.map(t => `
    <div class="post-card" style="cursor:default;">
      <div class="post-title">${escapeHtml(t.title)}</div>
      <div class="post-meta">${formatEventDate(t.starts_at)}${t.location ? ' · ' + escapeHtml(t.location) : ''} · ${escapeHtml(t.tier_name)}</div>
      <div class="ticket-qr">${qrSvg(t.code)}</div>
      <div class="post-meta">${t.checked_in_at ? 'Checked in' : 'Show this code at the door'} · <code>${escapeHtml(t.code)}</code></div>
    </div>`).join('') : '<div class="placeholder-note">No tickets yet.</div>';
  mainView.innerHTML = `<h2>My Tickets</h2>${joinCta}<div class="post-list">${list}</div>`;
  const join = mainView.querySelector('[data-join]');
  if (join) join.addEventListener('click', () => startMembershipCheckout(join));
}

// Stripe sends people back here; the webhook may land a moment after the
// redirect, so poll /api/me briefly for the tier flip before moving on.
async function renderMembershipSuccess(mainView) {
  mainView.innerHTML = `<h2>${BADGES.fix.glyph} The Fix Is In</h2><div class="placeholder-note">Greasing the palm…</div>`;
  let fixed = false;
  for (let i = 0; i < 10; i++) {
    const { stamps } = await apiFetch('/api/me/passport');
    if ((fixed = stamps.some(s => s.kind === 'fix'))) break;
    await new Promise(r => setTimeout(r, 1500));
  }
  if (fixed) {
    location.hash = '#/dressing-room';
  } else {
    mainView.innerHTML = `<h2>Almost there</h2><div class="placeholder-note">Your payment is still processing. Refresh in a minute — if you were charged and nothing changes, contact a Ringleader.</div>`;
  }
}
async function renderTicketSuccess(mainView) {
  mainView.innerHTML = `<h2>Your ticket</h2><div class="placeholder-note">Confirming your payment…</div>`;
  for (let i = 0; i < 10; i++) {
    const { tickets } = await apiFetch('/api/me/tickets');
    if (tickets.length) break;
    await new Promise(r => setTimeout(r, 1500));
  }
  location.hash = '#/tickets';
}

// Ringleader door scanner. Typed code always works; camera scan is used when
// the browser has BarcodeDetector (Chrome/Android; recent Safari).
async function renderCheckinView(mainView, eventId) {
  if (!profile?.is_ringleader) { mainView.innerHTML = '<h2>Door Check-in</h2><div class="placeholder-note">Ringleaders only.</div>'; return; }
  if (!eventId) {
    const { events } = await apiFetch('/api/events');
    mainView.innerHTML = `<h2>Door Check-in</h2><div class="post-list">${events.map(e => `<a class="post-card" href="#/checkin/${e.id}"><div class="post-title">${escapeHtml(e.title)}</div><div class="post-meta">${formatEventDate(e.starts_at)}</div></a>`).join('') || '<div class="placeholder-note">No upcoming events.</div>'}</div>`;
    return;
  }
  mainView.innerHTML = `
    <h2>Door Check-in</h2>
    <div class="ticket-box">
      <video id="scanVideo" playsinline muted style="display:none;width:100%;max-width:360px;border-radius:6px;"></video>
      <form id="checkinForm" class="ticket-tier-form">
        <input type="text" id="checkinCode" placeholder="Ticket code" autocomplete="off" autocapitalize="off" autofocus>
        <button type="submit" class="composer-submit">Check in</button>
      </form>
      <div id="checkinResult" class="post-meta"></div>
    </div>
    <div class="ticket-box">
      <h3 class="passport-section">Walk-ins &amp; crew</h3>
      <input type="text" id="doorSearch" placeholder="Find a member by name" autocomplete="off">
      <div id="doorResults" class="volunteer-list"></div>
    </div>`;
  const result = document.getElementById('checkinResult');

  // Stamp people who don't have a QR ticket: punch them in, take cash for
  // The Fix, or mark crew shifts.
  const doorResults = document.getElementById('doorResults');
  let doorTimer = null;
  async function drawDoor(flash = '') {
    const q = document.getElementById('doorSearch').value.trim();
    if (!q) { doorResults.innerHTML = flash ? `<div class="stamp-flash">${flash}</div>` : ''; return; }
    const [{ members }, { stamps }] = await Promise.all([
      apiFetch(`/api/members/search?q=${encodeURIComponent(q)}`),
      apiFetch(`/api/events/${eventId}/stamps`),
    ]);
    const has = (uid, kind) => stamps.some(s => s.user_id === uid && s.kind === kind);
    const btn = (m, kind, label) => has(m.id, kind)
      ? `<span class="volunteer-yes">${BADGES[kind].glyph} ${label} ✓</span>`
      : `<button class="action-btn" data-door-stamp="${kind}" data-uid="${m.id}" data-name="${escapeHtml(m.display_name)}">${BADGES[kind].glyph} ${label}</button>`;
    doorResults.innerHTML = (flash ? `<div class="stamp-flash">${flash}</div>` : '') + (members.slice(0, 8).map(m => `
      <div class="volunteer-item">
        <strong>${escapeHtml(m.display_name)}</strong>
        <span class="post-meta">${escapeHtml(m.city || '')} · ${escapeHtml(rankLabel(m.rank))}</span>
        <div class="post-actions">
          ${btn(m, 'ticket', 'Punch ticket')}
          <button class="action-btn" data-door-stamp="fix" data-uid="${m.id}" data-name="${escapeHtml(m.display_name)}">${BADGES.fix.glyph} Took their $5</button>
          ${btn(m, 'roustabout', 'Worked a shift')}
        </div>
      </div>`).join('') || '<div class="placeholder-note">No one by that name.</div>');
    doorResults.querySelectorAll('[data-door-stamp]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      const kind = b.dataset.doorStamp;
      const r = await apiFetch('/api/stamps', { method: 'POST', body: { user_id: b.dataset.uid, kind, event_id: kind === 'fix' ? null : eventId } });
      const name = escapeHtml(b.dataset.name);
      drawDoor(r.promoted ? `🎉 ${name} just became an Apprentice and stepped inside!`
        : !r.granted && kind === 'fix' ? `${name} already greased the palm. No double charge recorded.`
        : `${BADGES[kind].glyph} ${name}: ${escapeHtml(BADGES[kind].name)} stamped.`);
    }));
  }
  document.getElementById('doorSearch').addEventListener('input', () => {
    clearTimeout(doorTimer);
    doorTimer = setTimeout(() => drawDoor(), 250);
  });
  async function submit(code) {
    try {
      const r = await apiFetch(`/api/events/${eventId}/checkin`, { method: 'POST', body: { code } });
      result.style.color = r.ok ? '#8FD19E' : '#E0B060';
      result.textContent = r.ok ? `✓ ${r.display_name} — ${r.tier_name}${r.promoted ? ' · 🎉 just became an Apprentice!' : ''}` : `Already checked in: ${r.display_name} (${r.checked_in_at} UTC)`;
    } catch (err) {
      result.style.color = '#E08A8A';
      result.textContent = '✗ ' + err.message;
    }
  }
  document.getElementById('checkinForm').addEventListener('submit', e => {
    e.preventDefault();
    const input = document.getElementById('checkinCode');
    if (input.value.trim()) submit(input.value.trim());
    input.value = '';
  });
  if ('BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const video = document.getElementById('scanVideo');
      video.srcObject = stream; video.style.display = 'block'; await video.play();
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      let last = '', lastAt = 0;
      const tick = async () => {
        if (!document.body.contains(video)) { stream.getTracks().forEach(t => t.stop()); return; }
        try {
          const codes = await detector.detect(video);
          if (codes.length && (codes[0].rawValue !== last || Date.now() - lastAt > 4000)) {
            last = codes[0].rawValue; lastAt = Date.now();
            await submit(last);
          }
        } catch (e) { /* frame not ready */ }
        requestAnimationFrame(tick);
      };
      tick();
    } catch (e) { /* camera denied — typed entry still works */ }
  }
}

boot();
