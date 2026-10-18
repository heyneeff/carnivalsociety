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
  if (profile?.waitlisted_at && !profile.is_ringleader) return; // the waiting room needs nothing else
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
  const claimMatch = window.location.hash.match(/^#\/claim\/([0-9a-f]+)$/);
  if (claimMatch) { renderClaimScreen(claimMatch[1]); return; }
  // Anyone, signed in or not: a carnival's "Get in" page, and a ticket.
  const joinMatch = window.location.hash.match(/^#\/p\/([a-z0-9-]+)$/);
  if (joinMatch) { dropForumWing(); renderJoinPage(joinMatch[1]); return; }
  const getMatch = window.location.hash.match(/^#\/get\/([a-z0-9-]+)$/);
  if (getMatch) { dropForumWing(); renderGetIn(getMatch[1]); return; }
  const ticketMatch = window.location.hash.match(/^#\/ticket\/([0-9a-f]{20})(?:\/([0-9a-f]+))?$/);
  if (ticketMatch) { dropForumWing(); renderTicketPage(ticketMatch[1], ticketMatch[2]); return; }
  if (!session || !profile) { session = false; profile = null; dropForumWing(); renderAuthScreen(defaultAuthMode()); return; }
  if (!profile.introduced_at && !profile.is_ringleader) { dropForumWing(); renderIntroScreen(); return; }
  if (profile.waitlisted_at && !profile.is_ringleader) { dropForumWing(); renderWaitlistScreen(); return; }
  if (!profile.onboarded) { dropForumWing(); renderOnboarding(); return; }
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
        <h1>Members’ Entrance</h1>
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
          </label>
          <label class="auth-org-toggle">
            <input type="checkbox" id="wantsToVolunteer">
            I want to volunteer
          </label>` : ''}
          ${mode === 'signup' && appConfig.turnstile_site_key ? '<div id="turnstileWidget" class="turnstile-slot"></div>' : ''}
          <p class="auth-error">${escapeHtml(errorMsg)}</p>
          <button type="submit" class="auth-submit">${mode === 'signup' ? 'Join — it’s free' : mode === 'forgot' ? 'Send reset link' : 'Enter'}</button>
          ${mode === 'signup' ? '<p class="auth-sub auth-next">Next, you’ll introduce yourself. The Ringleader lets new carnies in by hand, a few at a time.</p>' : ''}
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
                    wants_to_volunteer: document.getElementById('wantsToVolunteer').checked,
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

// ── Backstage (2026-10-14) ── Neeff's painted backstage: four curtained
// doorways, each opening onto a row of name plates. Tap a name plate and you
// step into that person's Dressing Room. The mirror takes you home.
const BACKSTAGE_DOORS = [
  { key: 'friends', label: 'Friends', glyph: '☀', l: 28.3, t: 23, w: 9.6, h: 22, sy: 34, blurb: 'People you’ve shaken hands with at a carnival.' },
  { key: 'new', label: 'New arrivals', glyph: '☾', l: 42.3, t: 24, w: 8.4, h: 22, sy: 34, blurb: 'Just arrived. Go say hello and leave a note on their mirror!' },
  { key: 'all', label: 'Everyone', glyph: '★', l: 68.2, t: 20, w: 10.4, h: 36, sy: 30, blurb: 'Every dressing room backstage.' },
  { key: 'here', label: 'Here now', glyph: '🔥', l: 83.2, t: 11, w: 16.8, h: 53, sy: 46, blurb: 'Around right now. Pop in!' },
];
async function renderBackstage(mainView) {
  mainView.innerHTML = `
    <div class="room-viewport bs-viewport">
      <div class="room-scene bs-scene" id="bsScene">
        <img class="room-bg" src="${ROOM}rooms/backstage.jpg" alt="The backstage hallway: curtained doorways, a costume rack, a mirror with bulbs" draggable="false">
        <a class="bs-door bs-home" href="#/dressing-room" style="left:0;top:24%;width:8%;height:24%" aria-label="Back to your Dressing Room"><span class="carnie-arrow left">Your room</span></a>
        ${BACKSTAGE_DOORS.map(d => `<button class="bs-door" data-door="${d.key}" style="left:${d.l}%;top:${d.t}%;width:${d.w}%;height:${d.h}%;--sy:${d.sy}%" aria-label="${d.label}"><span class="bs-card"><b>${d.glyph}</b>${d.label}<em class="bs-count" data-count="${d.key}"></em></span></button>`).join('')}
        <div class="bs-hint">Tap a doorway to see who’s back there</div>
      </div>
    </div>`;
  let people = [];
  try { ({ people } = await apiFetch('/api/backstage')); } catch (e) { /* the doors still open, just empty */ }
  const week = Date.now() - 14 * 864e5;
  const groups = {
    friends: people.filter(p => p.friend),
    new: people.filter(p => sqlTime(p.created_at) > week),
    all: [...people].sort((a, b) => (b.friend - a.friend) || a.display_name.localeCompare(b.display_name)),
    here: people.filter(p => p.here),
  };
  BACKSTAGE_DOORS.forEach(d => { const c = mainView.querySelector(`[data-count="${d.key}"]`); if (c) { c.textContent = groups[d.key].length || ''; c.hidden = !groups[d.key].length; } });
  mainView.querySelectorAll('[data-door]').forEach(b => b.addEventListener('click', () => openDoor(BACKSTAGE_DOORS.find(d => d.key === b.dataset.door), groups[b.dataset.door])));
  function openDoor(door, list) {
    const o = document.createElement('div');
    o.className = 'bs-curtain';
    o.setAttribute('role', 'dialog');
    o.setAttribute('aria-label', door.label);
    const plate = p => `
      <a class="bs-name" href="#/room/${p.id}">
        ${avatarFor(p.id, p.display_name, 52, p.photo)}
        <span class="bs-who"><b>${escapeHtml(p.display_name)}</b><small>${escapeHtml(p.city || '')}</small></span>
        <span class="bs-tags">${p.here ? '<i class="bs-lamp" title="Here now"></i>' : ''}${p.friend ? '<i title="Friend">★</i>' : ''}${sqlTime(p.created_at) > week ? '<i class="bs-new">NEW</i>' : ''}${p.ringleader ? '<i class="bs-rl">Ringleader</i>' : ''}</span>
      </a>`;
    o.innerHTML = `
      <div class="bs-panel">
        <button class="oracle-close bs-close" aria-label="Close the curtain">×</button>
        <h2><span>${door.glyph}</span> ${door.label}</h2>
        <p class="bs-blurb">${door.blurb}</p>
        ${door.key === 'all' ? '<input class="bs-search" type="search" placeholder="Find someone by name or city…" aria-label="Find someone">' : ''}
        <div class="bs-list">${list.length ? list.map(plate).join('') : `<p class="bs-empty">${door.key === 'friends' ? 'No handshakes yet. Shake hands with your crew at the next carnival!' : door.key === 'here' ? 'Quiet back here right now. Check the Green Room!' : 'Nobody here yet.'}</p>`}</div>
      </div>`;
    const close = () => { o.classList.add('leaving'); setTimeout(() => o.remove(), 280); };
    o.querySelector('.bs-close').onclick = close;
    o.addEventListener('click', e => { if (e.target === o) close(); if (e.target.closest('.bs-name')) o.remove(); });
    const search = o.querySelector('.bs-search');
    if (search) search.oninput = () => {
      const q = search.value.trim().toLowerCase();
      o.querySelector('.bs-list').innerHTML = list.filter(p => !q || `${p.display_name} ${p.city || ''}`.toLowerCase().includes(q)).map(plate).join('') || '<p class="bs-empty">Nobody by that name backstage.</p>';
    };
    document.body.appendChild(o);
    requestAnimationFrame(() => o.classList.add('open'));
    (search || o.querySelector('.bs-close')).focus();
  }
}

// ── Introduce yourself (2026-10-14) ── every newcomer's first screen: a
// photo, where you're from, what brings you, your acts. The Ringleader reads
// it on the waitlist; once you're in it goes up in the pinned Courtyard thread.
// A picture from the camera roll, cropped square and shrunk to ~320px.
function pickPhoto() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        const side = Math.min(img.naturalWidth, img.naturalHeight), out = 320;
        const c = document.createElement('canvas'); c.width = c.height = out;
        c.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, out, out);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That picture wouldn’t open. Try another.')); };
      img.src = url;
    };
    input.click();
  });
}
// A poster from your files, kept its shape, shrunk to ~1000px on its long side.
function pickPoster() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        const k = Math.min(1, 1000 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That poster wouldn’t open. Try a PNG or JPG.')); };
      img.src = url;
    };
    input.click();
  });
}
async function savePhoto(data) {
  const { avatar_url } = await apiFetch('/api/me/photo', { method: 'POST', body: { data } });
  profile.avatar_url = avatar_url;
  return avatar_url;
}

function renderIntroScreen() {
  const first = (profile.display_name || '').split(' ')[0];
  const acts = new Set((profile.skills || '').split(',').map(x => x.trim()).filter(Boolean));
  app.innerHTML = `
    <div class="getin">
      <div class="getin-card hello-card">
        ${getinMarquee('Step right up!')}
        <div class="gi-body">
          <h1>Welcome to the troupe, ${escapeHtml(first)}!</h1>
          <p class="gi-desc gi-center"><b>Carnival Society is a real carnival we’re building together:</b> real nights, real fire, real sawdust, real people. This app is the backstage.</p>
          <p class="gi-desc gi-center">Before you step in, say hello so the troupe knows who’s coming.</p>
          <form class="gi-form intro-form" id="introForm">
            <div class="intro-photo">
              <button type="button" class="intro-face" id="introFace" aria-label="Add a photo of you">${profile.avatar_url ? `<img src="${escapeHtml(profile.avatar_url)}" alt="">` : '<span>📷</span>'}</button>
              <div><b>Your face</b><small>So people know you at the carnival. (Optional, but it helps!)</small>
                <button type="button" class="gi-link" id="introPhotoBtn">${profile.avatar_url ? 'Change photo' : 'Add a photo'}</button></div>
            </div>
            <label class="gi-field"><span>Where are you from?</span>
              <input id="introFrom" maxlength="80" required value="${escapeHtml(profile.city || '')}" placeholder="Boulder, CO"></label>
            <label class="gi-field"><span>What brings you to the carnival?</span>
              <textarea id="introAbout" maxlength="800" rows="4" required placeholder="I spin fire, I build things, I’ve never been to a carnival and want in…"></textarea></label>
            <div class="gi-field"><span>Pick your act <small>(tap all that sound like you)</small></span>
              <div class="act-chips">${ACTS.map(a => `<button type="button" class="act-chip ${acts.has(a) ? 'on' : ''}" data-act="${escapeHtml(a)}">${escapeHtml(a)}</button>`).join('')}</div></div>
            <button class="gi-btn" type="submit">Say hello →</button>
            <p class="gi-fine" id="introNote">This goes up in the pinned <b>Introduce yourself!</b> thread in the Courtyard${profile.waitlisted_at ? ' once the Ringleader lets you in' : ''}.</p>
          </form>
        </div>
      </div>
    </div>`;
  const note = document.getElementById('introNote');
  const addPhoto = async () => {
    try {
      const data = await pickPhoto();
      if (!data) return;
      note.textContent = 'Saving your photo…';
      const url = await savePhoto(data);
      document.getElementById('introFace').innerHTML = `<img src="${escapeHtml(url)}" alt="">`;
      document.getElementById('introPhotoBtn').textContent = 'Change photo';
      note.textContent = 'Looking good!';
    } catch (e) { note.textContent = e.message; }
  };
  document.getElementById('introFace').onclick = addPhoto;
  document.getElementById('introPhotoBtn').onclick = addPhoto;
  document.querySelectorAll('#introForm .act-chip').forEach(chip => chip.addEventListener('click', () => {
    const a = chip.dataset.act;
    if (acts.has(a)) acts.delete(a); else acts.add(a);
    chip.classList.toggle('on', acts.has(a));
  }));
  document.getElementById('introForm').onsubmit = async e => {
    e.preventDefault();
    const btn = e.target.querySelector('.gi-btn'); btn.disabled = true;
    try {
      const { user } = await apiFetch('/api/me/intro', { method: 'POST', body: { from: document.getElementById('introFrom').value, about: document.getElementById('introAbout').value, acts: [...acts] } });
      profile = user;
      if (!profile.waitlisted_at) await loadAppData();
      if (!location.hash || /^#\/(join)?$/.test(location.hash)) location.hash = '#/dressing-room';
      render();
    } catch (err) { note.textContent = err.message; btn.disabled = false; }
  };
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
    // Land in the Dressing Room (a shared event link keeps its event).
    if (!location.hash || /^#\/(join)?$/.test(location.hash)) location.hash = '#/dressing-room';
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

// The Courtyard has no sticker yet: a little striped tent in the same hand.
const TENT_SVG = `<svg viewBox="0 0 40 40"><path d="M20 7V1.5l6 2-6 2" fill="#C8A05A" stroke="#2a130c" stroke-width="1.6" stroke-linejoin="round"/><path d="M3.5 35 20 7l16.5 28z" fill="#F4E8D0"/><path d="M20 7 9 35h5zM20 7l6 28h5z" fill="#9B3036"/><path d="M16 35q4-9 8 0z" fill="#2a130c"/><path d="M3.5 35 20 7l16.5 28z" fill="none" stroke="#2a130c" stroke-width="2" stroke-linejoin="round"/></svg>`;
const LETTER_SVG = `<svg viewBox="0 0 40 40"><g transform="rotate(-8 20 20)"><rect x="4" y="10" width="32" height="22" rx="2" fill="#F4E8D0" stroke="#2a130c" stroke-width="2"/><path d="M4.5 11 20 23l15.5-12" fill="none" stroke="#2a130c" stroke-width="2" stroke-linejoin="round"/><circle cx="20" cy="23" r="4.6" fill="#9B3036" stroke="#2a130c" stroke-width="1.4"/><path d="M18 23h4M20 21v4" stroke="#F4E8D0" stroke-width="1.2"/></g></svg>`;

// Top bar everywhere (no sidebar): bobbing wordmark, primary nav on wide
// screens, a "More" sheet for everything else, bottom tabs on phones.
function renderShell() {
  const route = currentRoute();
  markSeenFor(route);
  const initials = (profile?.display_name || '?').trim().slice(0, 1).toUpperCase();
  const inner = isInnerMember();
  const onGuildHallBoard = route === 'guild-hall' || chapters.some(c => c.slug === route);
  const is = (...names) => names.some(n => n.endsWith('/') ? route.startsWith(n) : route === n);
  // Desktop tabs wear the painted sticker of the room object they open.
  const sticker = name => `<img src="${ROOM}${name}.png" alt="" draggable="false">`;
  const link = (href, label, active, icon, extra = '') => `<a class="topnav-link ${active ? 'active' : ''}" href="${href}" ${active ? 'aria-current="page"' : ''}><span class="tn-icon" aria-hidden="true">${icon}</span><span class="tn-label">${label}${extra}</span></a>`;

  const primary = [
    link('#/dressing-room', 'Dressing Room', is('dressing-room', 'badges', 'passport'), sticker('vanity')),
    link('#/backstage', 'Backstage', is('backstage'), sticker('costume_ringmaster')),
    link('#/courtyard', 'Courtyard', is('courtyard'), TENT_SVG, newsDot('courtyard')),
    link('#/events', 'Events', is('events', 'event/'), sticker('flyer_circus'), newsDot('events')),
    inner ? link('#/guild-hall', 'Guild Hall', onGuildHallBoard, sticker('book_lectern'), newsDot('guild')) : '',
    inner ? link('#/dm', 'Letters', is('dm', 'dm/'), LETTER_SVG, lettersBadge()) : '',
  ].join('');

  // The ☰ sheet holds what the top bar doesn't: each item says where in the
  // tent it lives. Places already in the top bar / phone tabs aren't repeated.
  const sheetLink = (href, label, active, extra = '', hint = '') => `<a class="sheet-link ${active ? 'active' : ''}" href="${href}"><span>${label}${extra}</span>${hint ? `<small class="sheet-hint">${hint}</small>` : ''}</a>`;
  const crew = inner && myCrewEvent();
  const sheet = `
    <div class="sheet-group">
      <div class="sheet-label">You</div>
      ${sheetLink('#/profile', 'My profile', is('profile'), '', 'the mirror')}
      ${sheetLink('#/badges', 'Badges', is('badges', 'passport'), '', 'the steamer trunk')}
      ${sheetLink('#/album', 'Troupe album', is('album'), '', 'the people you’ve met')}
      ${profile?.is_partner ? sheetLink('#/partner', '🤝 Partner desk', is('partner'), '', 'your friends, hollers, join page') : ''}
      ${lastHoller() ? '<button class="sheet-link sheet-raven" id="sheetHoller"><span>📣 Hear the last holler</span><small class="sheet-hint">it rolls back in</small></button>' : ''}
      <button class="sheet-link sheet-raven" id="sheetTour"><span>🐦‍⬛ Take the tour</span><small class="sheet-hint">the raven shows you around</small></button>
      ${sheetLink('#/tickets', 'My tickets', is('tickets'))}
      ${(ravenEnv().ios && !ravenEnv().standalone) || ('Notification' in window && Notification.permission !== 'granted') ? '<button class="sheet-link sheet-raven" id="sheetRaven"><span>📲 Get live updates</span><small class="sheet-hint">job reminders, letters, hollers</small></button>' : ''}
    </div>
    ${inner ? `
    <div class="sheet-group sheet-phone">
      <div class="sheet-label">Around the tent</div>
      ${sheetLink('#/guild-hall', 'Guild Hall', onGuildHallBoard, newsDot('guild'), 'the big book · inner members')}
    </div>` : ''}
    ${crew ? `
    <div class="sheet-group">
      <div class="sheet-label">Your crew</div>
      ${sheetLink('#/hub', escapeHtml(crew.title), is('hub', 'crew/'), '', 'schedule, meetups, projects')}
    </div>` : ''}
    ${profile?.is_ringleader ? `
    <div class="sheet-group">
      <div class="sheet-label">The Ringleader’s office</div>
      <a class="sheet-link" href="#/events" data-office="event"><span>＋ Post an event</span><small class="sheet-hint">a new carnival flyer</small></a>
      <a class="sheet-link" href="#/directory" data-office="waitlist"><span>👋 Let people in</span><small class="sheet-hint">read hellos on the waitlist</small></a>
      <a class="sheet-link" href="#/backstage"><span>🎁 Leave a surprise</span><small class="sheet-hint">backstage: pick a room, tap Leave a surprise</small></a>
      ${sheetLink('#/blast', '📣 Holler at everyone', is('blast'))}
      ${sheetLink('#/directory', 'Directory', is('directory'), newSignupsCount ? ` <span class="nav-badge">${newSignupsCount}</span>` : '', 'members, tiers, new sign-ups')}
      ${sheetLink('#/checkin', 'The Door', is('checkin', 'checkin/'))}
      ${sheetLink('#/impact', 'Impact log', is('impact'))}
      ${sheetLink('#/field', 'Guild map', is('field'))}
      ${sheetLink('#/network', 'Member network', is('network'))}
      ${sheetLink('#/projects', 'Projects', is('projects'))}
      ${sheetLink('#/meetings', 'Meetings', is('meetings'))}
    </div>` : ''}
    <button class="sheet-signout" id="signoutBtn">Sign out</button>`;

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
            <button class="topbar-more" id="moreBtn" aria-label="Menu" aria-expanded="${mobileNavOpen}">
              ${svg('M4 7h16M4 12h16M4 17h16')}<span class="tb-more-label">Menu</span>
              ${profile?.is_ringleader && newSignupsCount ? '<span class="topbar-dot" aria-hidden="true"></span>' : ''}
            </button>
            <a class="topbar-avatar" href="#/profile" aria-label="${escapeHtml(profile?.display_name || 'You')}: your profile" title="Your profile">${profile?.avatar_url ? `<img src="${escapeHtml(profile.avatar_url)}" alt="">` : escapeHtml(initials)}</a>
          </div>
        </div>
      </header>
      <div class="sheet-scrim ${mobileNavOpen ? 'open' : ''}" id="navScrim"></div>
      <aside class="more-sheet ${mobileNavOpen ? 'open' : ''}" aria-label="More">${sheet}</aside>
      <main class="main" id="mainView"></main>
      ${chatShellHtml()}
      <nav class="bottomtabs" aria-label="Main">
        ${tab('#/dressing-room', 'Dressing Room', is('dressing-room', 'badges', 'passport'), svg('M6 21V10a6 6 0 0 1 12 0v11z M4 21h16'))}
        ${tab('#/courtyard', `Courtyard${newsDot('courtyard')}`, is('courtyard'), svg('M3 20h18 M5 20V10l7-6 7 6v10 M10 20v-5h4v5'))}
        ${tab('#/events', `Events${newsDot('events')}`, is('events', 'event/'), svg('M3 21h18 M4 21 12 4l8 17 M12 4v17 M12 4l3-2'))}
        ${inner ? tab('#/dm', `Letters${lettersBadge()}`, is('dm', 'dm/'), svg('M4 5h16v11H9l-5 4z')) : tab('#/profile', 'Me', is('profile'), svg('M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21a8 8 0 0 1 16 0'))}
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
  document.getElementById('sheetRaven')?.addEventListener('click', () => { mobileNavOpen = false; renderShell(); inviteRaven('menu'); });
  document.getElementById('sheetHoller')?.addEventListener('click', () => {
    mobileNavOpen = false;
    const go = () => { const last = lastHoller(); if (last && !blastShowing) showBlast(last, { replay: true }); };
    if (currentRoute() === 'dressing-room') { renderShell(); setTimeout(go, 400); }
    else { location.hash = '#/dressing-room'; setTimeout(go, 1500); }
  });
  document.getElementById('sheetTour')?.addEventListener('click', () => {
    mobileNavOpen = false;
    if (currentRoute() === 'dressing-room') { renderShell(); setTimeout(() => roomHooks.startIntro?.(), 400); }
    else { try { localStorage.removeItem('cs-intro-' + profile.id); } catch (e) { /* ignore */ } location.hash = '#/dressing-room'; }
  });
  document.getElementById('navScrim').onclick = () => { mobileNavOpen = false; renderShell(); };

  renderMainView(route);
  mountChat();
  mountForumWing();
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

// ── Pages unfold out of the room (2026-10-12) ──
// The room stays mounted behind every cozy page. A page grows out of the
// object it belongs to (forum from the book, events from the corkboard…)
// and folds back into it on close. Ringleader tools stay full pages.
const UNFOLD_FROM = { forum: ['book'], courtyard: ['exit', 'book'], events: ['flyer', 'events'], letters: ['drawer', 'raven'], profile: ['mirror', 'costume'], passport: ['trunk'], album: ['trunk'], tickets: ['tickets'], blast: ['hatbox'] };
let roomStage = null, roomStageAt = 0, roomStageOwner = null, unfoldKind = null, unfoldFrom = null;
// Routes that are the room itself; #/badges (old #/passport) opens the trunk.
const ROOM_ROUTES = ['dressing-room', 'badges', 'passport'];
let wantTrunk = false;
function unfoldKindOf(route) {
  if (route === 'tickets') return 'tickets';
  if (route === 'album') return 'album';
  if (route === 'blast') return 'blast';
  if (route === 'courtyard') return 'courtyard';
  const k = pageKind(route);
  return ['forum', 'events', 'letters', 'profile'].includes(k) ? k : null;
}
// Where the current page is drawn: the unfolded card, or the main column.
const pageView = () => document.querySelector('.unfold-body') || document.getElementById('mainView');

function renderMainView(route) {
  const mainView = document.getElementById('mainView');
  stopDMPolling();
  // Arranging only owns the right wing while you're looking at the room itself.
  document.body.classList.toggle('arranging', roomEditing && route === 'dressing-room');
  if (route === 'backstage') { mainView.dataset.page = 'room'; mainView.classList.add('main-room'); const st = document.createElement('div'); st.className = 'room-stage'; mainView.appendChild(st); renderBackstage(st); return; }
  if (isRoomRoute(route) || unfoldKindOf(route)) { mountRoomStage(mainView, route); return; }
  roomStage = null; unfoldKind = null; roomHooks = {};
  mainView.dataset.page = pageKind(route);
  if (route.startsWith('event/')) mainView.dataset.single = '1';
  renderPage(mainView, route);
}

function mountRoomStage(mainView, route) {
  mainView.dataset.page = 'room';
  mainView.classList.add('main-room');
  const kind = isRoomRoute(route) ? null : unfoldKindOf(route);
  // Whose room: yours, or the one you're visiting (#/room/<id>).
  let owner = route.startsWith('room/') ? route.slice(5) : null;
  if (owner === profile.id) owner = null;
  if (kind) owner = roomStageOwner; // pages unfold over whichever room you're in
  // Reuse the live room while you come and go; rebuild it after two minutes,
  // or when you walk into a different room.
  if (!roomStage || Date.now() - roomStageAt > 120e3 || owner !== roomStageOwner) {
    roomStageOwner = owner;
    roomHooks = {};
    roomStage = document.createElement('div');
    roomStage.className = 'room-stage';
    roomStageAt = Date.now();
    mainView.appendChild(roomStage);
    renderRoom(roomStage, owner);
  } else mainView.appendChild(roomStage);
  roomStage.inert = !!kind;
  mainView.classList.toggle('unfolded', !!kind);
  const again = kind && kind === unfoldKind;
  unfoldKind = kind;
  if (!kind) {
    unfoldFrom = null;
    roomHooks.onNews?.(); // back in the room: clear whatever you just went and saw
    // Badges live in the trunk: open it (now, or once the room has drawn).
    if (route === 'badges' || route === 'passport') { wantTrunk = true; roomHooks.openTrunk?.(); }
    return;
  }

  const u = document.createElement('div');
  u.className = 'unfold';
  u.innerHTML = `
    <div class="unfold-card">
      <button class="unfold-close" aria-label="Back to your Dressing Room">✕</button>
      <div class="main unfold-body" data-page="${pageKind(route)}" ${route.startsWith('event/') ? 'data-single="1"' : ''}></div>
    </div>`;
  mainView.appendChild(u);
  renderPage(u.querySelector('.unfold-body'), route);
  const card = u.querySelector('.unfold-card');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // The object this page lives in: the one you tapped, else its usual home.
  const origin = () => {
    if (unfoldFrom) return unfoldFrom;
    const el = (UNFOLD_FROM[kind] || []).map(r => roomStage.querySelector(`[data-role="${r}"]`)).find(Boolean);
    return el && el.getBoundingClientRect();
  };
  const toward = r => {
    const c = card.getBoundingClientRect();
    const s = Math.max(0.06, Math.min(0.5, r.width / c.width));
    return `translate(${(r.left + r.width / 2 - (c.left + c.width / 2)).toFixed(0)}px, ${(r.top + r.height / 2 - c.top - (c.height * s) / 2).toFixed(0)}px) scale(${s.toFixed(3)})`;
  };
  if (again || reduce) u.classList.add('in');
  else {
    requestAnimationFrame(() => u.classList.add('in'));
    const r = origin();
    if (r) card.animate([{ transform: toward(r), opacity: 0.3 }, { transform: 'none', opacity: 1 }], { duration: 480, easing: 'cubic-bezier(.2,1.25,.4,1)' });
    else card.animate([{ transform: 'scale(0.6)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 360, easing: 'cubic-bezier(.2,1.25,.4,1)' });
  }
  unfoldFrom = null;
  let folding = false;
  const fold = () => {
    if (folding) return;
    folding = true;
    const r = !reduce && origin();
    u.classList.remove('in');
    if (!r) { location.hash = '#/dressing-room'; return; }
    u.scrollTop = 0;
    card.animate([{ transform: 'none', opacity: 1 }, { transform: toward(r), opacity: 0 }], { duration: 300, easing: 'cubic-bezier(.5,0,.8,.4)', fill: 'forwards' });
    setTimeout(() => { location.hash = '#/dressing-room'; }, 290);
  };
  u.querySelector('.unfold-close').onclick = fold;
  u.addEventListener('click', e => { if (e.target === u) fold(); });
}

function renderPage(mainView, route) {
  if (route === 'membership-success') { renderMembershipSuccess(mainView); return; }
  if (route === 'ticket-success') { renderTicketSuccess(mainView); return; }
  if (route === 'cancelled') { location.hash = '#/events'; return; }
  if (route === 'tickets') { renderMyTicketsView(mainView); return; }
  if (route.startsWith('checkin')) { renderCheckinView(mainView, route.split('/')[1] || null); return; }
  if (route.startsWith('door-report/')) { renderDoorReport(mainView, route.split('/')[1]); return; }
  if (route === 'partner' || route.startsWith('partner/')) { renderPartnerDesk(mainView, route.split('/')[1] || null); return; }
  if (route === 'courtyard') { renderCourtyardView(mainView); return; }
  if (route === 'album') { renderAlbum(mainView); return; }
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
const LOCKED_BOARD_SLUGS = []; // every chapter board is open (Denver + LA unlocked 2026-10-14)

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
function avatarFor(id, name, size = 44, photo = null) {
  if (photo) return `<img class="forum-avatar photo" src="${escapeHtml(photo)}" alt="" style="--sz:${size}px" loading="lazy">`;
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
      ${avatarFor(p.author_id, p.author?.display_name, 44, p.author?.photo)}
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
      ${canStartThread ? `<button class="forum-btn" data-start-thread>✒ Start a thread</button>` : ''}
    </div>
    ${!isInnerMember() && board.slug === 'courtyard' ? `<div class="forum-note-pinned"><strong>Welcome to the courtyard, ${escapeHtml(profile.display_name)}!</strong> This is where the guild posts news and calls for help. The quickest way in is to <a href="#/events">volunteer for an upcoming event</a>.</div>` : ''}
    <div class="thread-list">${cards || `<div class="forum-empty"><img src="${ROOM}raven_perched.png" alt="" class="forum-empty-bird">${board.slug === 'courtyard' ? 'Nothing posted yet. News and volunteer calls will land here.' : 'Quiet in here. Be the first to start a thread!'}</div>`}</div>`;
  host.querySelector('[data-start-thread]')?.addEventListener('click', () => openForumNote({
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
      <header class="op-head">${avatarFor(post.author_id, post.author?.display_name, 52, post.author?.photo)}
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
        ${avatarFor(r.author_id, r.author?.display_name, 38, r.author?.photo)}
        <div class="reply-bubble">
          <div class="thread-meta"><b>${escapeHtml(r.author?.display_name || 'someone')}</b> ${authorChip(r.author)} · ${timeAgo(sqlIso(r.created_at))}
            ${mine(r.author_id) || canModerate ? `<button class="reply-del" data-delete-reply="${r.id}" aria-label="Delete reply">×</button>` : ''}</div>
          <div class="reply-text">${escapeHtml(r.body)}</div>
        </div>
      </div>`).join('')}</div>
    ${isInnerMember() || post.open_to_all
      ? `<button class="forum-btn reply-open" id="replyOpen">${post.open_to_all ? '👋 Say hello' : '✒ Write a reply'}</button>`
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
  mainView.innerHTML = `<h2>Letters</h2><div class="placeholder-note">Opening the drawer…</div>`;

  const { conversations } = await apiFetch('/api/dm/conversations');

  const listHtml = (conversations || []).length ? conversations.map(c => `
    <a class="post-card letter-card" href="#/dm/${c.conversation_id}">
      <div class="post-title">${escapeHtml(c.other?.display_name || 'Unknown')}</div>
      <div class="post-snippet">${c.last ? escapeHtml(c.last.body.slice(0, 120)) : 'Nothing written yet.'}</div>
    </a>
  `).join('') : '<div class="placeholder-note">No letters yet. Write the first one.</div>';

  mainView.innerHTML = `
    <h2>Letters</h2>
    <button class="composer-submit" id="newDmBtn" style="margin-bottom:1.5rem;">✒ Write a letter</button>
    <div id="memberPicker"></div>
    <div class="post-list">${listHtml}</div>
  `;

  mainView.querySelector('#newDmBtn').addEventListener('click', () => renderMemberPicker());
}

async function renderMemberPicker() {
  const picker = document.getElementById('memberPicker');
  if (!picker) return;

  const { members } = await apiFetch('/api/members/search');
  const allMembers = members || [];

  picker.innerHTML = `
    <h3 style="font-family:'Playfair Display',serif;font-style:italic;color:var(--gold-bright);margin-bottom:0.75rem;">Write to someone</h3>
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
    <a class="thread-back" href="#/dm">&larr; All your letters</a>
    <h2>${escapeHtml(other?.display_name || 'A letter')}</h2>
    <div class="dm-thread" id="dmThread">${(messages || []).map(dmBubbleHtml).join('')}</div>
    <form class="composer" id="dmComposer">
      <textarea id="dmBody" placeholder="Write your letter…" required aria-label="Your letter"></textarea>
      ${profile.is_ringleader ? '<label class="dm-holler"><input type="checkbox" id="dmHoller" checked> 📣 Holler it: rings through their cone, just for them</label>' : ''}
      <div class="post-actions">
        <button type="submit" class="composer-submit">Send the letter</button>
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
    const holler = !!document.getElementById('dmHoller')?.checked;
    const { id, hollered } = await apiFetch(`/api/dm/${convId}/messages`, { method: 'POST', body: { body: text, holler } });
    dmSeenIds.add(id);
    if (hollered) flashToast(`📣 Hollered to ${other?.display_name || 'them'}. It rings when they open the app.`);
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

// The night's photos: paste the album link and everyone who came hears about it.
function photosForm(e) {
  return `<form class="photos-add" data-event="${e.id}">
    <div class="job-add-h">📸 ${e.photos_url ? 'The photo set' : 'Photos are up?'}</div>
    <div class="job-add-row"><input name="url" type="url" inputmode="url" placeholder="Link to the album (Google Photos, Dropbox…)" value="${escapeHtml(e.photos_url || '')}" aria-label="Photo album link" autocomplete="off">
    <button class="composer-submit">${e.photos_url ? 'Update' : 'Tell everyone who came'}</button></div>
  </form>`;
}
function wirePhotos(root, after) {
  root.querySelectorAll('.photos-add').forEach(f => f.addEventListener('submit', async ev => {
    ev.preventDefault();
    const btn = f.querySelector('button'); btn.disabled = true;
    try {
      const r = await apiFetch(`/api/events/${f.dataset.event}/photos`, { method: 'POST', body: { url: f.url.value.trim() } });
      flashToast(r.told ? `📸 Hollered to ${r.told} ${r.told === 1 ? 'person' : 'people'} who came. Huzzah!` : 'Saved.');
      if (after) after(); else btn.disabled = false;
    } catch (err) { flashToast(err.message); btn.disabled = false; }
  }));
}

// onlyEventId: the shareable single-event page (#/event/<id>).
async function renderEventsView(mainView, onlyEventId = null) {
  mainView.innerHTML = `<h2>Events</h2><div class="placeholder-note">Loading…</div>`;

  let { events } = await apiFetch('/api/events');
  // Which carnivals you're already coming to (a ticket, paid or a saved spot).
  const myTix = new Map(((await apiFetch('/api/me/tickets').catch(() => ({ tickets: [] }))).tickets || []).map(t => [t.event_id, t]));
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
  const canEdit = !!profile?.is_ringleader; // on the list and on an event's own page
  // Ringleader controls fold away on each card so members see one clear ask.
  // A partner gets the same tools on the events they co-host or posted.
  const partnerHosts = e => !!profile?.is_partner && (e.partner_id === profile.id || e.created_by === profile.id);
  const hosts = e => isModerator() || !!profile?.is_ringleader || partnerHosts(e);
  const canPost = canManage || (!!profile?.is_partner && !onlyEventId);

  const composerHtml = canPost ? `
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
      <button type="submit" class="composer-submit">Post the event</button>
    </form>
  ` : '';

  const listHtml = (events || []).length ? events.map(e => `
    <div class="post-card" style="cursor:default;">
      ${e.flyer_url ? `<a class="event-poster" href="${escapeHtml(e.flyer_url)}" target="_blank" rel="noopener" aria-label="See the poster full size"><img src="${escapeHtml(e.flyer_url)}" alt="${escapeHtml(e.title)} poster"></a>` : ''}
      <div class="post-title">${escapeHtml(e.title)}</div>
      <div class="post-meta">${formatEventDate(e.starts_at)}${e.ends_at ? ` – ${formatEventDate(e.ends_at)}` : ''} · ${escapeHtml(e.chapter ? e.chapter.name : 'Guild-wide')}${e.location ? ' · ' + escapeHtml(e.location) : ''}</div>
      ${e.partner_name ? `<div class="presented-with">Presented with ${e.partner_logo ? `<img src="${escapeHtml(e.partner_logo)}" alt="${escapeHtml(e.partner_name)}">` : `<b>${escapeHtml(e.partner_name)}</b>`}</div>` : ''}
      ${e.tagline || e.lineup ? lineupHtml(e) : ''}
      ${e.description ? `<div class="post-snippet">${escapeHtml(e.description)}</div>` : ''}
      ${e.photos_url ? `<a class="action-btn photos-btn" href="${escapeHtml(e.photos_url)}" target="_blank" rel="noopener">📸 See the photos</a>` : ''}
      ${joinBox(e, myTix.get(e.id))}
      <div class="ticket-panel" id="ticketPanel-${e.id}"></div>
      <div class="volunteer-row" id="volunteerRow-${e.id}"></div>
      <div class="run-board" data-run-for="${e.id}" data-starts="${e.starts_at}" data-ends="${e.ends_at || ''}"></div>
      <div class="job-board" data-jobs-for="${e.id}"></div>
      <div class="need-board" data-needs-for="${e.id}"></div>
      ${onlyEventId ? `<div class="crew-table" data-crew-for="${e.id}"></div>` : myVolunteering.has(e.id) ? `<a class="crew-link" href="#/event/${e.id}">🎪 Your crew table →</a>` : ''}
      <div class="post-actions"><button class="action-btn" data-share-event="${e.id}" data-title="${escapeHtml(e.title)}">🔗 Share</button></div>
      ${hosts(e) ? `<details class="rl-tools"><summary>✎ ${partnerHosts(e) && !isModerator() ? 'Host tools' : 'Ringleader tools'}</summary><div class="rl-tools-body">
        <div class="post-actions">
          ${canEdit || partnerHosts(e) ? `<button class="action-btn" data-edit-event="${e.id}">✎ Edit details</button>` : ''}
          ${profile?.is_ringleader ? `<a class="action-btn" href="#/checkin/${e.id}">🚪 The Door</a>` : ''}
          <button class="action-btn" data-poster="${e.id}">🖼️ ${e.flyer_url ? 'Change the poster' : 'Hang the poster'}</button>
          ${e.flyer_url ? `<button class="action-btn" data-poster-off="${e.id}">Take the poster down</button>` : ''}
          ${canManage && CREW_ASSIGNMENT_ENABLED ? `<button class="action-btn" data-manage-crew="${e.id}">Manage crew</button>` : ''}
          ${canManage || (partnerHosts(e) && !onlyEventId) ? `<button class="action-btn danger" data-delete-event="${e.id}">Delete</button>` : ''}
        </div>
        ${photosForm(e)}
        <form class="job-add" data-event="${e.id}">
          <div class="job-add-h">Pin a job to this flyer</div>
          <input name="title" maxlength="80" placeholder="The job, e.g. Bring a truck…" aria-label="Job" required autocomplete="off">
          <div class="job-add-row">
            <input name="shift" maxlength="40" placeholder="When, e.g. 7–9pm…" aria-label="When" autocomplete="off">
            <label class="job-add-n">People <input name="slots" type="number" min="1" max="20" value="1" inputmode="numeric"></label>
          </div>
          <input name="details" maxlength="300" placeholder="Anything they should know (optional)…" aria-label="Details" autocomplete="off">
          <button class="composer-submit">📌 Pin the job</button>
        </form>
        <form class="job-add run-add" data-event="${e.id}">
          <div class="job-add-h">Add to the run of show</div>
          <div class="job-add-row">
            <input name="at" type="datetime-local" value="${toDatetimeLocalValue(e.starts_at)}" aria-label="When" required>
            <input name="title" maxlength="80" placeholder="What happens, e.g. Doors open…" aria-label="What" required autocomplete="off">
          </div>
          <div class="job-add-row">
            <input name="who" maxlength="60" placeholder="Who leads it (optional)…" aria-label="Who" autocomplete="off">
            <input name="place" maxlength="60" placeholder="Where (optional)…" aria-label="Where" autocomplete="off">
          </div>
          <button class="composer-submit">🕰 Add to the run</button>
        </form>
        <form class="job-add need-add" data-event="${e.id}">
          <div class="job-add-h">Add to the needs list</div>
          <input name="item" maxlength="80" placeholder="What's needed, e.g. Extension cords…" aria-label="Item" required autocomplete="off">
          <div class="job-add-row">
            <select name="category" aria-label="Needed or wanted"><option value="need">Needed</option><option value="want">Wanted (nice to have)</option></select>
            <label class="job-add-n"><input type="checkbox" name="priority" value="1"> ★ Top priority</label>
          </div>
          <button class="composer-submit">🧰 Add it</button>
        </form>
        <div id="rlTickets-${e.id}"></div>
      </div></details>` : ''}
      ${canManage && CREW_ASSIGNMENT_ENABLED ? `<div class="crew-editor" id="crewEditor-${e.id}"></div>` : ''}
    </div>
  `).join('') : '<div class="placeholder-note">Nothing scheduled yet.</div>';

  mainView.innerHTML = onlyEventId ? `
    <a class="thread-back" href="#/events">&larr; All events</a>
    <div class="post-list">${listHtml}</div>` : `
    <h2>Events</h2><div class="my-jobs" id="myJobs" hidden></div><div class="post-list">${listHtml}</div>
    ${composerHtml ? `<details class="event-new"><summary>+ Post a new event</summary>${composerHtml}</details>` : ''}
    <div class="archive-toggle-row"><button class="gm-btn" id="toggleArchivedBtn" style="background:var(--surface);color:var(--cream);">Show past events</button></div>
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
  renderRun(mainView);
  renderJobs(mainView);
  renderNeeds(mainView);
  mainView.querySelectorAll('[data-crew-for]').forEach(h => renderCrewTable(h, h.dataset.crewFor));

  wirePhotos(mainView);
  if (canPost) {
    if (wantEventComposer) {
      wantEventComposer = false;
      const f = document.getElementById('eventComposer');
      const fold = f.closest('details'); if (fold) fold.open = true;
      f.scrollIntoView({ block: 'center' }); f.classList.add('composer-glow'); setTimeout(() => f.classList.remove('composer-glow'), 2200);
      document.getElementById('eventTitle')?.focus();
    }
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

  // Posters: pick an image, shrink it (max ~1000px tall), hang it.
  mainView.querySelectorAll('[data-poster]').forEach(btn => btn.addEventListener('click', async () => {
    try {
      const data = await pickPoster();
      if (!data) return;
      btn.disabled = true; btn.textContent = 'Hanging it…';
      await apiFetch(`/api/events/${btn.dataset.poster}/flyer`, { method: 'POST', body: { data } });
      flashToast('🖼️ The poster is up on everyone’s wall!');
      renderEventsView(mainView, onlyEventId);
    } catch (err) { flashToast(err.message); btn.disabled = false; }
  }));
  mainView.querySelectorAll('[data-poster-off]').forEach(btn => btn.addEventListener('click', async () => {
    await apiFetch(`/api/events/${btn.dataset.posterOff}/flyer`, { method: 'DELETE' });
    renderEventsView(mainView, onlyEventId);
  }));
  mainView.querySelectorAll('[data-edit-event]').forEach(btn => {
    btn.addEventListener('click', () => {
      const evt = (events || []).find(e => e.id === btn.dataset.editEvent);
      if (evt) openEventEditModal(mainView, evt, onlyEventId ? () => renderEventsView(mainView, onlyEventId) : undefined);
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
        ${e.partner_name ? `<div class="presented-with">Presented with <b>${escapeHtml(e.partner_name)}</b></div>` : ''}
        ${e.description ? `<div class="post-snippet">${escapeHtml(e.description)}</div>` : ''}
        ${e.photos_url ? `<a class="action-btn photos-btn" href="${escapeHtml(e.photos_url)}" target="_blank" rel="noopener">📸 See the photos</a>` : ''}
        ${hosts(e) ? photosForm(e) : ''}
        ${canManage || canEdit ? `<div class="post-actions">
          ${canEdit ? `<button class="action-btn" data-edit-archived="${e.id}">Edit</button>` : ''}
          ${canManage ? `<button class="action-btn danger" data-delete-archived="${e.id}">Delete</button>` : ''}
        </div>` : ''}
      </div>
    `).join('')}</div>` : '<div class="placeholder-note">No past events yet.</div>';
    wirePhotos(el, loadArchivedEvents);
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
    if (el.classList.contains('open')) { el.classList.remove('open'); el.innerHTML = ''; btn.textContent = 'Show past events'; return; }
    el.classList.add('open');
    btn.textContent = 'Hide past events';
    await loadArchivedEvents();
  });
}

// ── Crew tables + handshakes (2026-10-12) ──
// Everyone volunteering at an event shares a little table: faces, jobs and
// a chat. From just before the event to a week after, crewmates can shake
// hands; when both say yes, each lands in the other's Troupe Album.
async function renderCrewTable(host, eventId) {
  let t;
  try { t = await apiFetch(`/api/events/${eventId}/table`); } catch (e) { return; }
  if (!host.isConnected) return;
  if (!t.crew) { host.innerHTML = ''; return; }
  const face = c => `<span class="ct-face ${c.is_ringleader ? 'rl' : ''}">${escapeHtml((c.display_name || '?').trim().slice(0, 1).toUpperCase())}</span>`;
  const shake = c => {
    if (!t.am_crew || c.shake === 'me') return c.shake === 'me' ? '<span class="ct-you">you</span>' : '';
    if (c.shake === 'met') return '<span class="ct-met">🤝 Met!</span>';
    if (!t.shake_open) return '';
    if (c.shake === 'asked') return '<span class="ct-wait">Hand out…</span>';
    if (c.shake === 'asks_you') return `<button class="composer-submit ct-shake" data-shake="${c.id}" data-name="${escapeHtml(c.display_name)}">🤝 Shake back!</button>`;
    return `<button class="action-btn ct-shake" data-shake="${c.id}" data-name="${escapeHtml(c.display_name)}">🤝 Shake hands</button>`;
  };
  const wasNear = (() => { const l = host.querySelector('.ct-chat'); return !l || l.scrollHeight - l.scrollTop - l.clientHeight < 40; })();
  host.innerHTML = `
    <div class="ct-head">🎪 Your crew table</div>
    ${t.am_crew && !t.shake_open ? '<div class="ct-note">On the day, shake hands with your crew here. Both say yes and you\u2019re in each other\u2019s Troupe Album.</div>' : ''}
    <ul class="ct-crew">${t.crew.map(c => `<li class="ct-mate ${c.shake === 'asks_you' ? 'asks' : ''}">${face(c)}<span class="ct-who"><b>${c.shake === 'me' ? escapeHtml(c.display_name) : `<a href="#/room/${c.id}" title="Visit their Dressing Room">${escapeHtml(c.display_name)}</a>`}</b>${c.jobs ? `<small>${escapeHtml(c.jobs)}</small>` : ''}</span>${shake(c)}</li>`).join('')}</ul>
    <div class="ct-chat" aria-live="polite">${t.messages.length ? t.messages.map(m => `<div class="ct-msg ${m.user_id === profile.id ? 'mine' : ''}"><b>${escapeHtml(m.display_name)}</b> ${escapeHtml(m.body)} <small>${timeAgo(sqlIso(m.created_at))}</small></div>`).join('') : '<div class="ct-empty">Nobody\u2019s said anything yet. Say hi to your crew!</div>'}</div>
    ${t.am_crew ? '<form class="ct-say"><input name="body" maxlength="600" placeholder="Say something to your crew…" aria-label="Message your crew" autocomplete="off" required><button class="composer-submit" aria-label="Send">→</button></form>' : ''}`;
  const chat = host.querySelector('.ct-chat');
  if (wasNear) chat.scrollTop = chat.scrollHeight;
  host.querySelectorAll('[data-shake]').forEach(b => b.onclick = async () => {
    b.disabled = true;
    try {
      const { status } = await apiFetch('/api/handshakes', { method: 'POST', body: { user_id: b.dataset.shake, event_id: eventId } });
      flashToast(status === 'met' ? `🤝 You met ${b.dataset.name}! They’re in your Troupe Album.` : `🤝 Hand out! When ${b.dataset.name} shakes back, you’re in each other’s album.`, 5000);
    } catch (err) { flashToast(err.message); }
    renderCrewTable(host, eventId);
  });
  const form = host.querySelector('.ct-say');
  if (form) form.onsubmit = async e => {
    e.preventDefault();
    try { await apiFetch(`/api/events/${eventId}/table/messages`, { method: 'POST', body: { body: form.body.value } }); form.reset(); }
    catch (err) { flashToast(err.message); }
    await renderCrewTable(host, eventId);
    host.querySelector('.ct-say input')?.focus();
  };
  // Keep the table fresh while it's open (but don't clobber a half-typed message).
  clearTimeout(host._poll);
  host._poll = setTimeout(() => { if (host.isConnected && !host.querySelector('.ct-say input')?.value) renderCrewTable(host, eventId); }, 20000);
}

// The Troupe Album: everyone you've shaken hands with, as little polaroids.
async function renderAlbum(mainView) {
  mainView.innerHTML = '<h2>The Troupe Album</h2><div class="placeholder-note">Opening the album…</div>';
  const { album } = await apiFetch('/api/me/album');
  mainView.innerHTML = `
    <h2>The Troupe Album</h2>
    <p class="album-sub">${album.length ? `${album.length} ${album.length === 1 ? 'carnie' : 'carnies'} you\u2019ve met in real life.` : 'Nobody here yet.'} Shake hands with your crew at an event and they land here.</p>
    <div class="album-grid">${album.length ? album.map((m, i) => `
      <figure class="polaroid" style="--tilt:${((i * 37) % 7) - 3}deg"><a class="polaroid-link" href="#/room/${m.id}" aria-label="Visit ${escapeHtml(m.display_name)}’s Dressing Room">
        <div class="polaroid-face ${m.is_ringleader ? 'rl' : ''}">${escapeHtml((m.display_name || '?').trim().slice(0, 1).toUpperCase())}</div>
        <figcaption><b>${escapeHtml(m.display_name)}</b><small>${escapeHtml(m.is_ringleader ? 'Ringleader' : rankLabel(m.rank))}${m.city ? ` · ${escapeHtml(m.city)}` : ''}</small><small>Met at ${escapeHtml(m.event_title || 'the carnival')} · ${new Date(sqlTime(m.met_at)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small><small class="polaroid-visit">Visit their room →</small></figcaption>
      </a></figure>`).join('') : `<div class="album-empty"><img src="${ROOM}raven_perched.png" alt=""><span>Volunteer for an event, take a job, and on the day tap <b>🤝 Shake hands</b> at your crew table.</span><a class="composer-submit" href="#/events">See what’s coming up</a></div>`}</div>`;
}

// ── Run of show (2026-10-12): the event's timeline on its flyer. While the
// event is on, the current item glows NOW and the next says UP NEXT.
async function renderRun(mainView) {
  let run;
  try { ({ run } = await apiFetch('/api/run')); } catch (e) { return; }
  const mod = isModerator();
  const now = Date.now();
  mainView.querySelectorAll('[data-run-for]').forEach(board => {
    const rows = run.filter(r => r.event_id === board.dataset.runFor);
    if (!rows.length) { board.innerHTML = ''; return; }
    const start = Date.parse(board.dataset.starts), end = board.dataset.ends ? Date.parse(board.dataset.ends) : Date.parse(rows[rows.length - 1].at) + 3 * 3600e3;
    const live = now >= start - 3 * 3600e3 && now <= end;
    const nowIdx = live ? rows.reduce((k, r, i) => (Date.parse(r.at) <= now ? i : k), -1) : -1;
    const days = new Set(rows.map(r => new Date(r.at).toDateString())).size > 1;
    const time = r => new Date(r.at).toLocaleString(undefined, days ? { weekday: 'short', hour: 'numeric', minute: '2-digit' } : { hour: 'numeric', minute: '2-digit' });
    board.innerHTML = `
      <div class="job-board-h">🕰 Run of show</div>
      <ol class="run-list">${rows.map((r, i) => `
        <li class="run-item ${i === nowIdx ? 'now' : ''} ${live && i === nowIdx + 1 ? 'next' : ''} ${live && i < nowIdx ? 'past' : ''}">
          <span class="run-time">${escapeHtml(time(r))}</span>
          <span class="run-what"><b>${escapeHtml(r.title)}</b>${r.who || r.place ? `<small>${[r.who, r.place].filter(Boolean).map(escapeHtml).join(' · ')}</small>` : ''}</span>
          ${i === nowIdx ? '<span class="run-tag">NOW</span>' : live && i === nowIdx + 1 ? '<span class="run-tag next">UP NEXT</span>' : ''}
          ${mod ? `<button class="run-del" data-del-run="${r.id}" aria-label="Remove ${escapeHtml(r.title)}">✕</button>` : ''}
        </li>`).join('')}</ol>`;
  });
  const act = async (fn, msg) => { try { await fn(); if (msg) flashToast(msg); } catch (err) { flashToast(err.message); } renderRun(mainView); };
  mainView.querySelectorAll('[data-del-run]').forEach(b => b.onclick = () => act(() => apiFetch(`/api/run/${b.dataset.delRun}`, { method: 'DELETE' })));
  mainView.querySelectorAll('.run-add').forEach(f => f.onsubmit = e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    act(async () => {
      await apiFetch(`/api/events/${f.dataset.event}/run`, { method: 'POST', body: { ...d, at: new Date(d.at).toISOString() } });
      f.title.value = ''; f.who.value = ''; f.place.value = '';
    }, '🕰 Added to the run of show.');
  });
}

// ── Needs on flyers (2026-10-12): materials wanted and needed ──
// Anyone can say "I can bring it!"; the Ringleader marks it received at the
// event, which wins them the Junk Saint stamp.
async function renderNeeds(mainView) {
  let materials;
  try { ({ materials } = await apiFetch('/api/materials')); } catch (e) { return; }
  const mod = isModerator();
  const initials = n => escapeHtml((n || '?').trim().slice(0, 1).toUpperCase());
  mainView.querySelectorAll('[data-needs-for]').forEach(board => {
    const mine = materials.filter(m => m.event_id === board.dataset.needsFor);
    if (!mine.length) { board.innerHTML = ''; return; }
    const row = m => {
      const me = m.pledges.find(p => p.user_id === profile.id);
      const faces = m.pledges.map(p => `<span class="jt-face ${p.received ? 'done' : ''} ${p.user_id === profile.id ? 'me' : ''}" title="${escapeHtml(p.display_name)}${p.received ? ' (received!)' : ' is bringing it'}">${initials(p.display_name)}</span>`).join('');
      const action = me ? (me.received ? '<span class="jt-done">✓ Received. Huzzah!</span>' : `<button class="nd-btn nd-mine" data-unpledge="${m.id}">I’m bringing it ✓</button>`)
        : `<button class="nd-btn" data-pledge="${m.id}">${m.pledges.length ? 'I can bring one too' : 'I can bring it!'}</button>`;
      return `<li class="nd-item ${m.pledges.length ? 'covered' : ''}">
        <span class="nd-name">${m.priority ? '<b class="nd-star" title="Top priority">★</b>' : ''}${escapeHtml(m.item)}</span>
        <span class="jt-crew">${faces}</span>${action}
        ${mod ? `<span class="nd-tools">${m.pledges.map(p => p.received ? '' : `<button data-recv="${m.id}" data-user="${p.user_id}" title="Got it from ${escapeHtml(p.display_name)}">✓ ${escapeHtml(p.display_name.split(' ')[0])}</button>`).join('')}<button class="jt-delete" data-del-need="${m.id}" aria-label="Remove ${escapeHtml(m.item)}">✕</button></span>` : ''}
      </li>`;
    };
    const needs = mine.filter(m => m.category !== 'want'), wants = mine.filter(m => m.category === 'want');
    const open = needs.filter(m => !m.pledges.length).length;
    board.innerHTML = `
      <div class="job-board-h">🧰 ${open ? `${open} ${open === 1 ? 'thing' : 'things'} still needed` : 'Everything needed is coming!'}</div>
      ${needs.length ? `<div class="nd-h">Needed</div><ul class="nd-list">${needs.map(row).join('')}</ul>` : ''}
      ${wants.length ? `<div class="nd-h">Wanted <small>(nice to have)</small></div><ul class="nd-list">${wants.map(row).join('')}</ul>` : ''}`;
  });
  const redraw = () => renderNeeds(mainView);
  const act = async (fn, msg) => { try { await fn(); if (msg) flashToast(msg); } catch (err) { flashToast(err.message); } redraw(); };
  mainView.querySelectorAll('[data-pledge]').forEach(b => b.onclick = () => act(() => apiFetch(`/api/materials/${b.dataset.pledge}/pledge`, { method: 'POST' }), '🧰 Thank you! Your name is on it. Bring it to the event.'));
  mainView.querySelectorAll('[data-unpledge]').forEach(b => b.onclick = () => act(() => apiFetch(`/api/materials/${b.dataset.unpledge}/pledge`, { method: 'DELETE' }), 'No worries, someone else can bring it.'));
  mainView.querySelectorAll('[data-recv]').forEach(b => b.onclick = () => act(() => apiFetch(`/api/materials/${b.dataset.recv}/pledges/${b.dataset.user}/received`, { method: 'POST' }), 'Received! They won the Junk Saint stamp.'));
  mainView.querySelectorAll('[data-del-need]').forEach(b => b.onclick = () => { if (confirm('Take this off the needs list?')) act(() => apiFetch(`/api/needs/${b.dataset.delNeed}`, { method: 'DELETE' })); });
  mainView.querySelectorAll('.need-add').forEach(f => f.onsubmit = e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    act(async () => { await apiFetch(`/api/events/${f.dataset.event}/needs`, { method: 'POST', body: { item: d.item, category: d.category, priority: !!d.priority } }); f.reset(); }, '🧰 Added to the needs list.');
  });
}

// ── Jobs on flyers (2026-10-12) ──
// Tickets pinned to each event: claim one (first come, first served) and
// your name goes on it; it also signs you up to volunteer. Moderators pin
// jobs from the card's Ringleader fold and mark them done (= a stamp).
async function renderJobs(mainView) {
  let jobs;
  try { ({ jobs } = await apiFetch('/api/jobs')); } catch (e) { return; }
  const mod = isModerator();
  const initials = n => escapeHtml((n || '?').trim().slice(0, 1).toUpperCase());
  mainView.querySelectorAll('[data-jobs-for]').forEach(board => {
    const mine = jobs.filter(j => j.event_id === board.dataset.jobsFor);
    if (!mine.length) { board.innerHTML = ''; return; }
    const open = mine.reduce((n, j) => n + Math.max(j.slots - j.claims.length, 0), 0);
    board.innerHTML = `
      <div class="job-board-h">${open ? `🎟 ${open} ${open === 1 ? 'spot' : 'spots'} open` : '🎟 Every job is covered!'}</div>
      ${mine.map(j => {
        const me = j.claims.find(c => c.user_id === profile.id);
        const full = j.claims.length >= j.slots;
        const seats = [...j.claims.map(c => `<span class="jt-face ${c.done ? 'done' : ''} ${c.user_id === profile.id ? 'me' : ''}" title="${escapeHtml(c.display_name)}${c.done ? ' (done!)' : ''}">${initials(c.display_name)}</span>`),
          ...Array.from({ length: Math.max(j.slots - j.claims.length, 0) }, () => '<span class="jt-face empty" title="Open spot"></span>')].join('');
        const action = me
          ? (me.done ? '<span class="jt-done">✓ Done. Huzzah!</span>' : `<button class="action-btn" data-unclaim="${j.id}">Let it go</button>`)
          : full ? '<span class="jt-covered">Covered!</span>' : `<button class="composer-submit" data-claim="${j.id}">Take this job</button>`;
        return `
        <div class="job-ticket ${full ? 'covered' : ''} ${me ? 'mine' : ''}">
          <div class="jt-head"><span class="jt-title">${escapeHtml(j.title)}</span>${j.shift ? `<span class="jt-shift">${escapeHtml(j.shift)}</span>` : ''}</div>
          ${j.details ? `<div class="jt-details">${escapeHtml(j.details)}</div>` : ''}
          <div class="jt-foot"><span class="jt-crew">${seats}</span>${me && !me.done ? '<span class="jt-yours">It’s yours!</span>' : ''}${action}</div>
          ${me && /door/i.test(j.title) ? `<a class="action-btn jt-door" href="#/checkin/${j.event_id}">🚪 Run the door</a>` : ''}
          ${mod ? `<div class="jt-tools">${j.claims.map(c => `<span class="jt-tool-row">${escapeHtml(c.display_name)} ${c.done ? '✓' : `<button data-done-job="${j.id}" data-user="${c.user_id}">Mark done</button>`}<button data-drop-job="${j.id}" data-user="${c.user_id}" aria-label="Take ${escapeHtml(c.display_name)} off this job">✕</button></span>`).join('')}<button class="jt-delete" data-delete-job="${j.id}">Remove this job</button></div>` : ''}
        </div>`;
      }).join('')}`;
  });
  // You, at a glance: the jobs you've taken.
  const mineAll = jobs.filter(j => j.claims.some(c => c.user_id === profile.id && !c.done));
  const strip = mainView.querySelector('#myJobs');
  if (strip) {
    strip.hidden = !mineAll.length;
    strip.innerHTML = `<b>You’re on:</b> ${mineAll.map(j => `<a href="#/event/${j.event_id}">${escapeHtml(j.title)}${j.shift ? ` (${escapeHtml(j.shift)})` : ''} · ${escapeHtml(j.event_title)}</a>`).join('')}`;
  }
  const redraw = () => renderJobs(mainView);
  const act = async (fn, okMsg) => { try { await fn(); if (okMsg) flashToast(okMsg); } catch (err) { flashToast(err.message); } redraw(); };
  mainView.querySelectorAll('[data-claim]').forEach(b => b.onclick = () => act(async () => {
    b.disabled = true;
    await apiFetch(`/api/jobs/${b.dataset.claim}/claim`, { method: 'POST' });
    const j = jobs.find(x => x.id === b.dataset.claim);
    if (j && !myVolunteering.has(j.event_id)) { myVolunteering.add(j.event_id); renderVolunteerRow(j.event_id); }
    setTimeout(() => inviteRaven('job', j ? `${j.title}` : 'your job'), 1200);
  }, '🎟 It’s yours! Your name is on the flyer.'));
  mainView.querySelectorAll('[data-unclaim]').forEach(b => b.onclick = () => act(() => apiFetch(`/api/jobs/${b.dataset.unclaim}/claim`, { method: 'DELETE' }), 'Off the job. Someone else can take it.'));
  mainView.querySelectorAll('[data-done-job]').forEach(b => b.onclick = () => act(() => apiFetch(`/api/jobs/${b.dataset.doneJob}/claims/${b.dataset.user}/done`, { method: 'POST' }), 'Done! They got a Roustabout stamp.'));
  mainView.querySelectorAll('[data-drop-job]').forEach(b => b.onclick = () => act(() => apiFetch(`/api/jobs/${b.dataset.dropJob}/claims/${b.dataset.user}`, { method: 'DELETE' })));
  mainView.querySelectorAll('[data-delete-job]').forEach(b => b.onclick = () => { if (confirm('Remove this job from the flyer?')) act(() => apiFetch(`/api/jobs/${b.dataset.deleteJob}`, { method: 'DELETE' })); });
  mainView.querySelectorAll('.job-add:not(.need-add):not(.run-add)').forEach(f => f.onsubmit = e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    act(async () => { await apiFetch(`/api/events/${f.dataset.event}/jobs`, { method: 'POST', body: d }); f.reset(); }, '📌 Pinned to the flyer.');
  });
}

// "Are you coming?" (2026-10-15): the one obvious place to say yes to a
// carnival, at the top of every event: I'M COMING (ticket / saved spot), or
// help on the crew, or bring something it needs.
function joinBox(e, ticket) {
  const price = e.door_cents ? `${doorMoney(e.door_cents)} at the door${e.entry_tickets ? `, with ${e.entry_tickets} free carnival tickets` : ''}` : 'Free';
  const coming = ticket
    ? `<div class="jb-yes">✓ You’re coming!${ticket.status === 'reserved' ? ' <small>Spot saved, pay at the door</small>' : ''} <a class="action-btn" href="#/ticket/${ticket.code}">Show my ticket</a></div>`
    : e.door_cents != null
      ? `<a class="jb-coming" href="#/get/${e.slug || e.id}">🎟️ I’M COMING!</a><div class="jb-price">${escapeHtml(price)}. Tap to save your spot.</div>`
      : `<div class="jb-soon">Tickets open soon. Help on the crew and you’re in!</div>`;
  return `<div class="join-box" data-join="${e.id}">
    <div class="jb-title">🎪 Are you coming?</div>
    ${coming}
    <div class="jb-doors"><button class="jb-door" data-jb-go="job-board" data-for="${e.id}">🛠️ Help on the crew</button><button class="jb-door" data-jb-go="need-board" data-for="${e.id}">🎁 Bring something</button></div>
  </div>`;
}
document.addEventListener('click', ev => {
  const b = ev.target.closest?.('[data-jb-go]');
  if (!b) return;
  const card = b.closest('.post-card'), to = card?.querySelector(`.${b.dataset.jbGo}`) || card?.querySelector('.volunteer-row');
  to?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  to?.classList.add('jb-flash'); setTimeout(() => to?.classList.remove('jb-flash'), 1600);
});

// Volunteer toggle for everyone; moderators also get the sign-up list.
function renderVolunteerRow(eventId) {
  const el = document.getElementById('volunteerRow-' + eventId);
  if (!el) return;
  const signedUp = myVolunteering.has(eventId);
  el.innerHTML = `
    <div class="post-actions">
      ${signedUp
        ? `<span class="volunteer-yes">✓ You're volunteering</span><button class="action-btn" data-unvolunteer>I can’t make it</button>`
        : `<button class="composer-submit" data-volunteer>Volunteer for this</button>`}
      ${isModerator() ? `<button class="action-btn" data-show-volunteers>See who’s in</button>` : ''}
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
      const title = el.closest('.post-card')?.querySelector('.post-title')?.textContent.trim() || 'the event';
      renderVolunteerRow(eventId);
      setTimeout(() => inviteRaven('volunteer', title), 900);
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
    if (!title || !startsAt) { flashToast('Title and start time are required.'); return; }
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
      flashToast(`Couldn't save: ${e.message}`);
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
let wantEventComposer = false; // set by the office menu's "Post an event"
document.addEventListener('click', e => {
  const o = e.target.closest?.('[data-office]');
  if (!o) return;
  if (o.dataset.office === 'event') wantEventComposer = true;
  if (o.dataset.office === 'waitlist') directoryTab = 'waitlist';
});
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
  ['waitlist', 'Waitlist'],
];

function switchDirectoryTab(mainView, tab) {
  directoryTab = tab;
  directorySortKey = 'name';
  directorySearchQuery = '';
  renderDirectoryBody(mainView);
}

function renderDirectoryBody(mainView) {
  if (directoryTab === 'waitlist') { renderWaitlistTab(mainView); return; }
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
      if (!name) { flashToast('Venue name is required.'); return; }
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
        flashToast(`Couldn't add venue: ${e.message}`);
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
      if (!display_name || !email || !password) { flashToast('Name, email, and password are all required.'); return; }
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
        flashToast(`Couldn't add member: ${e.message}`);
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
  const sorted = [...filtered].sort((DIRECTORY_SORTS[directorySortKey] || DIRECTORY_SORTS.name).cmp);

  list.innerHTML = sorted.map(m => {
    const hasRealEmail = m.email && !m.email.endsWith('@crew.local');
    const igHandle = m.instagram_handle ? m.instagram_handle.replace(/^@/, '') : '';
    const metaRows = [
      m.skills ? ['Skills', m.skills] : null,
      m.birthday ? ['Birthday', m.birthday] : null,
      m.knows_who ? ['Knows', m.knows_who] : null,
      m.heard_about_us ? ['Heard about us via', m.heard_about_us] : null,
      m.materials_to_donate ? ['Materials to donate', m.materials_to_donate] : null,
      m.wants_to_volunteer ? ['Volunteer', 'Wants to volunteer'] : null,
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
        ${m.is_organization ? `<label class="admin-ringleader-toggle" title="Partners post their own events, co-host carnivals, and holler at their friends">
          <input type="checkbox" data-field="is_partner" ${m.is_partner ? 'checked' : ''}>
          Partner
        </label>${m.is_partner ? `<a class="action-btn" href="#/partner/${m.id}">Their desk</a>` : ''}` : ''}
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
        <button class="gm-btn admin-passport-btn" data-passport="${m.id}" style="background:var(--surface-2);color:var(--gold-bright);">Badges</button>
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
        flashToast(`Couldn't save: ${e.message}`);
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
      if (field === 'is_organization' || field === 'is_partner') { renderDirectoryRows(); return; }
      const affectsSort = (directorySortKey === 'rank' && (field === 'rank' || field === 'is_ringleader')) || (directorySortKey === 'dues' && field === 'dues_paid');
      if (affectsSort) renderDirectoryRows();
    };

    row.querySelector('[data-field="rank"]')?.addEventListener('change', e => patchField('rank', e.target.value));
    row.querySelector('[data-field="is_organization"]').addEventListener('change', e => patchField('is_organization', e.target.checked));
    row.querySelector('[data-field="is_partner"]')?.addEventListener('change', e => patchField('is_partner', e.target.checked));
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
      flashToast(`Couldn't delete: ${e.message}`);
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
    if (!display_name) { flashToast('Name is required.'); return; }
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
      flashToast(`Couldn't save: ${e.message}`);
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
  const sorted = [...filtered].sort((VENUE_SORTS[directorySortKey] || VENUE_SORTS.name).cmp);

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
        flashToast(`Couldn't remove venue: ${e.message}`);
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
    if (!name) { flashToast('Venue name is required.'); return; }
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
      flashToast(`Couldn't save: ${e.message}`);
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
    if (!event_date || !event_name) { flashToast('Date and event name are required.'); return; }
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
      flashToast(`Couldn't add log: ${e.message}`);
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
  const sorted = [...filtered].sort((IMPACT_SORTS[directorySortKey] || IMPACT_SORTS.date).cmp);

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
        flashToast(`Couldn't remove log: ${e.message}`);
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
    if (!event_date || !event_name) { flashToast('Date and event name are required.'); return; }
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
      flashToast(`Couldn't save: ${e.message}`);
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
    <div class="profile-photo">
      <span class="intro-face">${p.avatar_url ? `<img src="${escapeHtml(p.avatar_url)}" alt="">` : '<span>📷</span>'}</span>
      <div><button type="button" class="action-btn" id="profilePhotoBtn">${p.avatar_url ? 'Change my photo' : 'Add a photo'}</button>
        ${p.avatar_url ? '<button type="button" class="action-btn" id="profilePhotoDel">Remove</button>' : ''}</div>
    </div>
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
  document.getElementById('profilePhotoBtn').onclick = async () => {
    try { const data = await pickPhoto(); if (!data) return; await savePhoto(data); renderShell(); renderProfileView(mainView, 'New photo saved!'); }
    catch (e) { flashToast(e.message); }
  };
  const del = document.getElementById('profilePhotoDel');
  if (del) del.onclick = async () => { await apiFetch('/api/me/photo', { method: 'DELETE' }); profile.avatar_url = null; renderShell(); renderProfileView(mainView, 'Photo removed.'); };
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
      renderProfileView(pageView(), 'Saved.');
    } catch (err) { renderProfileView(mainView, err.message); }
  });
}

async function drawRavenSettings() {
  const status = document.getElementById('ravenStatus'), btns = document.getElementById('ravenBtns');
  if (!status) return;
  const env = ravenEnv();
  const on = await ravenSubscribed();
  status.textContent = on ? 'The raven knows where to find you on this device.'
    : env.ios && !env.standalone ? 'On iPhone, add Carnival Society to your Home Screen first — then the raven can find you.'
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
  // "Kinker": old circus slang for a performer.
  kinker:     { name: 'Kinker',          motto: 'I took the ring.',         glyph: '🎭', color: '#C9A227', how: 'Perform at a Carnival: an act, a set, a show.', icon: 'M5 5c4 2 10 2 14 0v6a7 7 0 0 1-14 0z M9 10h.01 M15 10h.01 M9 14c2 2 4 2 6 0 M12 2v1 M4 2l1 1 M20 2l-1 1' },
};
const BADGE_ORDER = ['fix', 'ticket', 'roustabout', 'sawdust', 'barker', 'junk', 'canvasman', 'kinker'];
const HAND_GRANTED_BADGES = ['sawdust', 'barker', 'junk', 'canvasman', 'roustabout', 'kinker'];

// Neeff's painted badge patches (assets/badges/badge_<kind>.webp): the whole
// round patch, name and motto included, used wherever a badge is shown big.
const badgePatch = (kind, cls = 'badge-art-img') => `<img class="${cls}" src="assets/badges/badge_${kind}.webp" alt="" draggable="false">`;
function badgeIcon(kind, size = 28) {
  return `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${BADGES[kind].icon}"/></svg>`;
}

// SQLite times ("2026-10-12 18:02:36") and ISO times with a zone, both as UTC.
function sqlTime(t) { const v = String(t).replace(' ', 'T'); return Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(v) ? v : v + 'Z'); }

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
    <div class="raven-modal-card" role="dialog" aria-label="Add Carnival Society to your Home Screen">
      <img src="${ROOM}raven_perched.png" alt="" class="raven-modal-bird">
      <h3>Let the raven follow you home</h3>
      <p>On iPhone the raven can only find you from your Home Screen:</p>
      <ol>
        <li>Tap the <strong>Share</strong> button <span aria-hidden="true">⬆︎</span> at the bottom of Safari.</li>
        <li>Choose <strong>Add to Home Screen</strong>.</li>
        <li>Open <strong>Carnival Society</strong> from your Home Screen and tap the raven again.</li>
      </ol>
      <button class="room-plaque-btn" data-close>Got it</button>
    </div>`;
  document.body.appendChild(o);
  o.addEventListener('click', e => { if (e.target === o || e.target.dataset.close !== undefined) o.remove(); });
}
const RAVEN_RESULT = {
  on: 'The raven will find you now. SQUAWK!',
  denied: 'Notifications are blocked for this site. Allow them in your browser settings to let the raven in.',
  unsupported: 'This browser can’t receive the raven. Try Chrome, or add Carnival Society to your Home Screen on iPhone.',
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
async function checkBlast(waited = 0) {
  if (!session || blastShowing) return;
  try {
    const { blast } = await apiFetch('/api/me/blast');
    if (!blast || blastShowing) return;
    // Wait your turn behind a prize, the tour or a rank party; ring right after.
    if (document.querySelector('.prize-pop, .intro-tour, .rank-celebration')) { setTimeout(() => checkBlast(waited), 1500); return; }
    // In the Dressing Room, give the room a moment to draw so the holler
    // comes out of the floor megaphone rather than the stand-in cone.
    if (ROOM_ROUTES.includes(currentRoute()) && !document.querySelector('.room-stage #roomItems [data-item]') && waited < 6) {
      setTimeout(() => checkBlast(waited + 1), 500);
      return;
    }
    showBlast(blast, { live: true });
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

// The last holler you heard, so the floor megaphone can play it again.
function lastHoller() { try { return JSON.parse(localStorage.getItem('cs-last-holler') || 'null'); } catch (e) { return null; } }

function showBlast(blast, { live = false, preview = false, replay = false } = {}) {
  blastShowing = blast.id || 'preview';
  // In the Dressing Room the megaphone rolls in from the right, rattles; you
  // tap it, the Ringleader pops out of the bell and grows over the room, and
  // afterwards it rolls back out. Anywhere else (or behind an unfolded page)
  // the standing cone takes the whole screen.
  const roomItems = document.querySelector('.room-stage #roomItems');
  let floorCone = null;
  if (roomItems && roomItems.getBoundingClientRect().width > 20 && !document.querySelector('.unfold')) {
    floorCone = document.createElement('div');
    floorCone.className = 'room-obj holler-cone';
    floorCone.style.cssText = 'left:38%;top:76%;width:24%';
    floorCone.innerHTML = `<span class="room-turn" style="transform:rotate(-4deg)"><img src="${ROOM}megaphone_floor.png" alt="" draggable="false"></span>`;
    roomItems.appendChild(floorCone);
    floorCone.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }
  const cr = floorCone?.getBoundingClientRect();
  const inRoom = !!cr && cr.width > 20 && cr.right > 0 && cr.left < innerWidth;
  if (floorCone && !inRoom) { floorCone.remove(); floorCone = null; }
  const offRight = cr ? innerWidth - cr.left + 40 : 0;
  const rollIn = !!floorCone && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (rollIn) floorCone.animate([
    { transform: `translateX(${offRight}px) rotate(18deg)` },
    { transform: `translateX(${Math.round(offRight * 0.4)}px) translateY(-6px) rotate(-8deg)`, offset: 0.45 },
    { transform: 'translateX(-14px) rotate(5deg)', offset: 0.8 },
    { transform: 'none' },
  ], { duration: 1150, easing: 'cubic-bezier(.3,.7,.4,1)' });
  const scene = document.getElementById('roomScene')?.getBoundingClientRect();
  const from = `<div class="blast-from">${blast.from_partner ? escapeHtml(blast.sender || 'A partner') : `Ringleader ${escapeHtml(blast.sender || 'Neeff')}`} says:</div>`;
  const o = document.createElement('div');
  o.className = `blast-overlay ringing${inRoom ? ' in-room' : ''}${blast.from_partner ? ' from-partner' : ''}`;
  o.setAttribute('role', 'dialog');
  o.setAttribute('aria-label', `A holler from ${blast.from_partner ? blast.sender : `Ringleader ${blast.sender || 'Neeff'}`}`);
  o.innerHTML = inRoom ? `
    <button class="blast-mute" aria-label="Sound on or off">${soundOff() ? '🔇' : '🔊'}</button>
    <button class="holler-cone-hit" aria-label="Step right up and hear the message" style="left:${cr.left}px;top:${cr.top}px;width:${cr.width}px;height:${cr.height}px"></button>
    <div class="blast-ring-words holler-words" aria-hidden="true" style="left:${cr.left + cr.width / 2}px;top:${cr.top}px"><span>HEAR YE!</span></div>
    <div class="blast-bubble holler-bubble" hidden>
      ${from}
      <div class="blast-title">${escapeHtml(blast.title)}</div>
      <div class="blast-body" aria-live="polite"></div>
      <div class="blast-btns">
        ${blast.url && blast.url !== '#/dressing-room' ? `<button class="forum-btn" data-go>Take me there</button>` : ''}
        <button class="forum-btn ghost" data-done>${preview ? 'Close preview' : 'Got it!'}</button>
      </div>
    </div>
    <img class="holler-head blast-head-art" src="${ROOM}head_closed.png" alt="" hidden>
    <div class="holler-call" style="${scene ? `left:${scene.left + scene.width / 2}px;` : ''}">
      <div class="blast-caller">📣 ${blast.from_partner ? escapeHtml(blast.sender || 'A partner') : `Ringleader ${escapeHtml(blast.sender || 'Neeff')}`} has something to holler!</div>
      <button class="blast-pickup">Step right up!</button>
    </div>` : `
    <div class="blast-stage">
      <button class="blast-mute" aria-label="Sound on or off">${soundOff() ? '🔇' : '🔊'}</button>
      <div class="blast-ring-words" aria-hidden="true"><span>HEAR YE!</span><span>HEAR YE!</span></div>
      <div class="blast-bubble" hidden>
        ${from}
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
      <div class="blast-caller">📣 ${blast.from_partner ? escapeHtml(blast.sender || 'A partner') : `Ringleader ${escapeHtml(blast.sender || 'Neeff')}`} has something to holler!</div>
      <button class="blast-pickup">Step right up!</button>
    </div>`;
  document.body.appendChild(o);
  if (inRoom) setTimeout(() => { if (floorCone && o.classList.contains('ringing')) floorCone.classList.add('cone-ringing'); }, rollIn ? 1150 : 0);
  // Warm up the face frames so the first mouth swap doesn't blink.
  ['head_happy', 'head_open', 'head_closed', 'head_wink', 'head_cosmic'].forEach(f => { new Image().src = `${ROOM}${f}.png`; });
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
  let shrink = null;
  const finish = () => {
    stopBlare(); clearInterval(typing);
    // Every holler ends with a BANG: he explodes into stars and confetti.
    const boomHead = o.classList.contains('answered') && o.querySelector(inRoom ? '.holler-head' : '.blast-head');
    if (boomHead && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      explodeHead(boomHead, rig);
      const r0 = rig; setTimeout(() => r0?.close(), 900);
      floorCone?.classList.remove('cone-ringing');
      o.classList.add('exploding');
      setTimeout(() => { if (!o.isConnected) return; o.remove(); blastShowing = null; if (floorCone) { const c = floorCone; floorCone = null; c.animate([{ transform: 'none' }, { transform: `translateX(${offRight}px) rotate(20deg)` }], { duration: 800, easing: 'cubic-bezier(.5,0,.8,.4)', fill: 'forwards' }); setTimeout(() => c.remove(), 820); } if (blast.gift === 'mercury_deck' && !preview) setTimeout(() => roomHooks.placeDeck?.(), 500); }, 750);
      return;
    }
    rig?.close();
    floorCone?.classList.remove('cone-ringing');
    // …and rolls back out to the right when it's done.
    const rollOut = () => {
      if (!floorCone) return;
      const c = floorCone; floorCone = null;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { c.remove(); return; }
      c.animate([{ transform: 'none' }, { transform: `translateX(${offRight}px) rotate(20deg)` }], { duration: 800, easing: 'cubic-bezier(.5,0,.8,.4)', fill: 'forwards' });
      setTimeout(() => c.remove(), 820);
    };
    const gone = () => { if (!o.isConnected) return; o.remove(); blastShowing = null; rollOut(); if (blast.gift === 'mercury_deck' && !preview) setTimeout(() => roomHooks.placeDeck?.(), 500); };
    if (shrink && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      o.classList.add('leaving');
      shrink().onfinish = gone;
      setTimeout(gone, 700); // the animation may not report back in a hidden tab
    } else gone();
  };
  const answer = () => {
    if (!o.classList.contains('ringing')) return;
    stopBlare();
    if (live && blast.id === 'welcome') apiFetch('/api/me/backer/welcomed', { method: 'POST' }).catch(() => {});
    else if (live && blast.id) apiFetch(`/api/me/blast/${blast.id}/seen`, { method: 'POST' }).catch(() => {});
    if (!preview) try { localStorage.setItem('cs-last-holler', JSON.stringify({ title: blast.title, body: blast.body, url: blast.url || null, sender: blast.sender || null, from_partner: !!blast.from_partner })); } catch (e) { /* no storage */ }
    floorCone?.classList.remove('cone-ringing');
    // A fresh rig born from this tap, so iPhones let the babble play.
    rig?.close(); rig = megaphone();
    playBoing(rig);
    babble = makeBabbler(rig);
    o.classList.remove('ringing'); o.classList.add('answered');
    o.querySelector('.blast-bubble').hidden = false;
    const out = o.querySelector('.blast-body'), headImg = o.querySelector('.blast-head-art'), head = o.querySelector(inRoom ? '.holler-head' : '.blast-head');
    if (inRoom) {
      // Out of the bell (the left end of the megaphone) and up to full size
      // over the room; the speech bubble sits on top of the head.
      // The part of the room you can actually see (phones scroll a wide room).
      const sl = scene && scene.width > 0 ? Math.max(scene.left, 0) : 0, sr = scene && scene.width > 0 ? Math.min(scene.right, innerWidth) : innerWidth;
      const box = { left: sl, width: sr - sl, top: scene?.top ?? 0, height: scene?.height || innerHeight };
      const W = Math.min(box.width * (box.width < 500 ? 0.62 : 0.5), box.height * 0.52, 400), Hh = W * 270 / 250;
      const left = box.left + box.width / 2 - W / 2, top = Math.min(box.top + box.height * 0.94, innerHeight - 16) - Hh;
      Object.assign(head.style, { left: `${left}px`, top: `${top}px`, width: `${W}px` });
      o.style.setProperty('--head-top', `${top}px`);
      o.style.setProperty('--room-mid', `${box.left + box.width / 2}px`);
      o.style.setProperty('--room-w', `${box.width}px`);
      head.hidden = false;
      const bell = `translate(${cr.left + cr.width * 0.08 - (left + W / 2)}px, ${cr.top + cr.height * 0.55 - (top + Hh / 2)}px) scale(${(cr.height * 0.9 / W).toFixed(3)})`;
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        // He spins out of the bell, whirling twice before he lands.
        head.animate([{ transform: `${bell} rotate(-720deg)`, opacity: 0.6 }, { transform: 'rotate(18deg) scale(1.08)', opacity: 1, offset: 0.8 }, { transform: 'none', opacity: 1 }], { duration: 950, easing: 'cubic-bezier(.2,.8,.3,1)' });
      }
      shrink = () => head.animate([{ transform: 'none', opacity: 1 }, { transform: bell, opacity: 0 }], { duration: 420, easing: 'cubic-bezier(.5,0,.8,.5)', fill: 'forwards' });
    } else if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      head?.animate([{ transform: 'rotate(-720deg) scale(0.4)' }, { transform: 'rotate(15deg) scale(1.1)', offset: 0.8 }, { transform: 'none' }], { duration: 950, easing: 'cubic-bezier(.2,.8,.3,1)' });
    }
    const text = blast.body || '';
    // Neeff's own faces: pops up excited, yaks (shut / talking / shouting),
    // signs off with a wink. Say something cosmic and he goes Cosmic Mode.
    const cosmic = /cosm(ic|os)/i.test(`${blast.title} ${text}`);
    const face = f => { if (headImg) headImg.src = `${ROOM}${cosmic ? 'head_cosmic' : f}.png`; };
    if (cosmic) o.classList.add('cosmic');
    face('head_happy');
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { out.textContent = text; face('head_wink'); return; }
    // Easy-going yak: mouth open / shut every few letters, not every one.
    const mouths = ['head_open', 'head_closed'];
    let flap = 0;
    let i = 0, m = 0, said = 0;
    const done = () => { clearInterval(typing); head.classList.remove('yakking'); face('head_wink'); };
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
          if (flap++ % 2 === 0) face(mouths[m++ % mouths.length]);
        }
        if (i >= text.length) done();
      }, 38);
    }, 450);
    o.querySelector('.blast-bubble').onclick = e => { if (!e.target.closest('button')) { i = text.length; out.textContent = text; done(); } };
  };
  o.querySelector('.blast-pickup').onclick = answer;
  (o.querySelector('.blast-cone') || o.querySelector('.holler-cone-hit')).onclick = answer;
  o.addEventListener('click', e => {
    if (e.target.dataset.done !== undefined) finish();
    if (e.target.dataset.go !== undefined) { finish(); if (/^https?:/.test(blast.url)) window.open(blast.url, '_blank', 'noopener'); else location.hash = blast.url; }
  });
}

// ── The Mercury Oracle over the room (2026-10-14): passed through our own
// worker (/oracle/mercury/) with its backdrop made see-through, so the cards
// float over your Dressing Room. Close (or Escape, or a tap outside) returns.
function openMercury() {
  if (document.querySelector('.oracle-overlay')) return;
  const o = document.createElement('div');
  o.className = 'oracle-overlay';
  o.setAttribute('role', 'dialog');
  o.setAttribute('aria-label', 'The Mercury Oracle');
  o.innerHTML = `<iframe class="oracle-frame" src="/oracle/mercury/" title="The Mercury Oracle" allowtransparency="true"></iframe>
    <button class="oracle-close" aria-label="Put the cards away">×</button>`;
  const close = () => { o.classList.add('leaving'); setTimeout(() => o.remove(), 300); };
  o.querySelector('.oracle-close').onclick = close;
  o.addEventListener('click', e => { if (e.target === o) close(); });
  document.body.appendChild(o);
  requestAnimationFrame(() => o.classList.add('open'));
}

// ── Sunny & Daisy (2026-10-14) ── Neeff's cats, alive in the Ringmaster's
// Office: they wander the floor (four-frame walk cycles), stop, stretch,
// sit and squint happily; tap one and it meows. Sprites face right; walking
// left flips them. Positions are % of the square room, feet at (x, y).
const CAT_ART = 'assets/room/cats/';
const CAT_WALK_W = 153; // px width of a walk frame; poses size relative to it
const CAT_FRAMES = { sunny: 8, daisy: 8 }, CAT_FRAME_MS = 105; // frames in each cat's walk cycle
const CAT_POSES = {
  sunny: { stand: 79, stretch: 99, meow: 83, happy: 87 },
  daisy: { stand: 86, stretch: 108, meow: 89, happy: 87 },
};
function mountCats(scene, theme) {
  scene.querySelectorAll('.room-cat').forEach(c => c._stop?.());
  if (theme !== 'office') return;
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  ['sunny', 'daisy'].forEach(name => {
    for (let i = 1; i <= CAT_FRAMES[name]; i++) new Image().src = `${CAT_ART}${name}_walk${i}.webp`;
    const el = document.createElement('button');
    el.className = 'room-cat';
    el.setAttribute('aria-label', `Pet ${name === 'sunny' ? 'Sunny' : 'Daisy'}`);
    el.innerHTML = `<img alt="" draggable="false"><span class="cat-meow" hidden>meow!</span>`;
    scene.appendChild(el);
    const img = el.querySelector('img'), meow = el.querySelector('.cat-meow');
    const FLOOR = { x0: 8, x1: 84, y0: 76, y1: 93 };
    const rnd = (a, b) => a + Math.random() * (b - a);
    const cat = { x: name === 'sunny' ? 30 : 62, y: name === 'sunny' ? 84 : 89, dir: name === 'sunny' ? 1 : -1 };
    let timer = null, frameTimer = null, stopped = false;
    const BASE = 15; // a walking cat is this % of the room wide
    const show = (art, wPx, flip = false) => {
      img.src = `${CAT_ART}${name}_${art}.webp`;
      const depth = 0.82 + (cat.y - FLOOR.y0) / (FLOOR.y1 - FLOOR.y0) * 0.3;
      el.style.width = `${BASE * wPx / CAT_WALK_W * depth}%`;
      el.style.left = `${cat.x}%`; el.style.top = `${cat.y}%`;
      el.style.zIndex = String(Math.round(cat.y * 10));
      img.style.transform = flip ? 'scaleX(-1)' : '';
    };
    const later = (fn, ms) => { clearTimeout(timer); timer = setTimeout(() => { if (!el.isConnected) return stop(); fn(); }, ms); };
    const pose = (p, ms, next) => { clearInterval(frameTimer); show(p, CAT_POSES[name][p]); later(next, ms); };
    const idle = () => {
      const r = Math.random();
      if (still) return pose('happy', 60000, idle);
      if (r < 0.25) pose('stretch', 2600, () => pose('stand', rnd(1200, 2500), idle));
      else if (r < 0.5) pose('happy', rnd(5000, 11000), idle);
      else if (r < 0.65) pose('stand', rnd(2000, 4000), idle);
      else walk();
    };
    const walk = () => {
      const tx = rnd(FLOOR.x0, FLOOR.x1), ty = rnd(FLOOR.y0, FLOOR.y1);
      const dist = Math.hypot(tx - cat.x, ty - cat.y);
      if (dist < 6) return idle();
      cat.dir = tx > cat.x ? 1 : -1;
      const speed = 4.2; // % of the room per second
      const steps = Math.max(1, Math.round(dist / speed * 1000 / CAT_FRAME_MS));
      const dx = (tx - cat.x) / steps, dy = (ty - cat.y) / steps;
      let i = 0, f = 0;
      clearInterval(frameTimer);
      frameTimer = setInterval(() => {
        if (!el.isConnected) return stop();
        cat.x += dx; cat.y += dy;
        show(`walk${(f++ % CAT_FRAMES[name]) + 1}`, CAT_WALK_W, cat.dir < 0);
        if (++i >= steps) { clearInterval(frameTimer); pose('stand', rnd(800, 1800), idle); }
      }, CAT_FRAME_MS);
    };
    const stop = () => { stopped = true; clearTimeout(timer); clearInterval(frameTimer); el.remove(); };
    el._stop = stop;
    el.onclick = e => {
      e.stopPropagation();
      if (stopped) return;
      clearInterval(frameTimer);
      meow.hidden = false; meow.classList.remove('pop'); void meow.offsetWidth; meow.classList.add('pop');
      pose('meow', 1500, () => { meow.hidden = true; pose('happy', rnd(2500, 4500), idle); });
    };
    show('happy', CAT_POSES[name].happy);
    later(idle, rnd(1500, 4000));
  });
}

// ── The Carnie Code (2026-10-14) ── Neeff's code, hung on every room's
// wall (like the barker's cone, it's part of the room, not a decoration you
// can lose). Tap it to read it. His painted sign (assets/room/carnie_code.png)
// swaps in by itself once it exists; until then a little board stands in.
const CARNIE_CODE = [
  ['The show is going on.', 'With or without you! Join in! …Or don’t.'],
  ['Magic is using what you have and what is available to make something special.', ''],
  ['Bring food.', 'You must, I’m afraid. Bring what you like.'],
  ['You will be painting signs!', '(All signs point toward painting signs.)'],
  ['Pick a skill and do it well.', 'Tie ropes, juggle, make games. Pick a skill and do it well.'],
  ['It’s not so serious.', 'And if unseriousness is taken seriously, the result is serious unseriousness. Seriously.'],
  ['If it’s bad and not funny, it’s just bad.', ''],
  ['Generosity is a virtue.', ''],
  ['I am appreciated in my unimportance.', 'I will not be the reason this fails.'],
  ['Ask how you can be of service, not for a role.', 'If you ask for a role, your role is clown, and you need to reevaluate your life.'],
];
// Where it hangs, per room painting (feet-free: left/top/width in % of the room).
const CODE_SPOT = { office: [57.4, 19.5, 9.2], original: [30, 22, 7.5], default: [58.2, 24, 8] };
function mountCode(scene, theme) {
  scene.querySelector('.room-code')?.remove();
  const [l, t, w] = CODE_SPOT[theme] || CODE_SPOT.default;
  const el = document.createElement('button');
  el.className = 'room-code';
  el.style.cssText = `left:${l}%;top:${t}%;width:${w}%`;
  el.setAttribute('aria-label', 'Read the Carnival Society Code');
  el.innerHTML = `<img src="${ROOM}carnie_code.png" alt="" draggable="false" onerror="this.remove()"><span class="rc-board" aria-hidden="true"><b>THE</b><b>CARNIE</b><b>CODE</b></span>`;
  el.onclick = e => { e.stopPropagation(); showCarnieCode(); };
  scene.appendChild(el);
}
function showCarnieCode() {
  if (document.querySelector('.carnie-code')) return;
  const o = document.createElement('div');
  o.className = 'carnie-code';
  o.setAttribute('role', 'dialog');
  o.setAttribute('aria-label', 'The Carnival Society Code');
  o.innerHTML = `
    <div class="cc-sign">
      <button class="oracle-close cc-close" aria-label="Put the sign back">×</button>
      <img class="cc-plaque" src="${ROOM}carnie_code.png" alt="The Carnival Society Code">
      <ol>${CARNIE_CODE.map(([rule, more]) => `<li><b>${rule}</b>${more ? ` <span>${more}</span>` : ''}</li>`).join('')}</ol>
      <div class="cc-sig">— the Ringleader</div>
    </div>`;
  const close = () => { o.classList.add('leaving'); setTimeout(() => o.remove(), 280); };
  o.querySelector('.cc-close').onclick = close;
  o.addEventListener('click', e => { if (e.target === o) close(); });
  document.body.appendChild(o);
  requestAnimationFrame(() => o.classList.add('open'));
}

// ── KABOOM (2026-10-14) ── Neeff's head swells, flashes and bursts into
// stars, sparkles and confetti, with a little bang through the megaphone.
function explodeHead(el, rig) {
  if (!el) return;
  const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height * 0.45;
  el.animate([{ transform: 'none', opacity: 1, filter: 'brightness(1)' }, { transform: 'scale(1.25) rotate(-6deg)', opacity: 1, filter: 'brightness(2.2)', offset: 0.35 }, { transform: 'scale(0.1) rotate(25deg)', opacity: 0, filter: 'brightness(3)' }], { duration: 420, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' });
  const flash = document.createElement('div');
  flash.className = 'boom-flash';
  flash.style.cssText = `left:${cx}px;top:${cy}px`;
  document.body.appendChild(flash);
  setTimeout(() => flash.remove(), 700);
  const bits = ['★', '✦', '✶', '❋', '★', '✦'], colors = ['#FFD86B', '#9B3036', '#4E8C82', '#C77B8A', '#F4E8D0', '#FF9F43', '#7E5BEF'];
  for (let k = 0; k < 42; k++) {
    const p = document.createElement('span');
    const star = k % 3 !== 0;
    p.className = 'boom-bit';
    p.textContent = star ? bits[k % bits.length] : '';
    p.style.cssText = `left:${cx}px;top:${cy}px;color:${colors[k % colors.length]};${star ? `font-size:${14 + (k % 4) * 7}px` : `width:${6 + k % 5}px;height:${9 + k % 4}px;background:${colors[k % colors.length]}`}`;
    document.body.appendChild(p);
    const a = Math.random() * Math.PI * 2, d = 120 + Math.random() * Math.min(innerWidth, innerHeight) * 0.45;
    p.animate([{ transform: 'translate(-50%,-50%) scale(0.2)', opacity: 1 }, { transform: `translate(calc(-50% + ${Math.cos(a) * d}px), calc(-50% + ${Math.sin(a) * d + 60}px)) rotate(${Math.random() * 720 - 360}deg) scale(1)`, opacity: 0 }], { duration: 700 + Math.random() * 600, delay: 120, easing: 'cubic-bezier(.1,.8,.3,1)', fill: 'forwards' });
    setTimeout(() => p.remove(), 1500);
  }
  // the bang: a burst of noise through the megaphone, falling away fast
  try {
    if (!rig || soundOff()) return;
    const { ctx, input } = rig, len = ctx.sampleRate * 0.5, buf = ctx.createBuffer(1, len, ctx.sampleRate), data = buf.getChannelData(0);
    for (let n = 0; n < len; n++) data[n] = (Math.random() * 2 - 1) * Math.pow(1 - n / len, 3);
    const src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = buf; g.gain.value = 0.9; src.connect(g).connect(input); src.start(ctx.currentTime + 0.1);
  } catch (e) { /* no sound, still a boom */ }
}

// ── Neeff's tour, holler-style (2026-10-14) ── his big head over the room,
// a comic speech bubble that types with babble and a flapping mouth, faces
// switching mid-line, and a spotlight on whatever he's talking about.
const NT_FACES = { closed: 'head_closed', open: 'head_open', happy: 'head_happy', wink: 'head_wink', cosmic: 'head_cosmic', sus: 'head_closed', sly: 'head_wink', shout: 'head_open', gasp: 'head_open', proud: 'head_happy' };
// Acted expressions: the face plus how he holds himself (CSS on .nt-head).
const NT_ACTED = ['sus', 'sly', 'cosmic', 'shout', 'gasp', 'proud'];
function runNeeffTour(steps, { el, host, onDone }) {
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const t = document.createElement('div');
  t.className = 'intro-tour neeff-tour';
  t.setAttribute('role', 'dialog');
  t.setAttribute('aria-label', 'Neeff shows you around');
  t.innerHTML = `<div class="intro-spot"></div>
    <div class="nt-head"><img alt="Neeff" draggable="false"></div>
    <div class="nt-bubble">
      <div class="nt-from">Ringleader Neeff says:</div>
      <div class="nt-text" aria-live="polite"></div>
      <div class="nt-extra"></div>
      <div class="nt-btns"><span class="nt-step"></span><button class="raven-offer-no" data-skip>Skip the tour</button><button class="composer-submit" data-next>Next</button></div>
    </div>`;
  document.body.appendChild(t);
  Object.values(NT_FACES).forEach(f => { new Image().src = `${ROOM}${f}.png`; });
  const spot = t.querySelector('.intro-spot'), headBox = t.querySelector('.nt-head'), head = headBox.querySelector('img');
  const out = t.querySelector('.nt-text'), extra = t.querySelector('.nt-extra'), next = t.querySelector('[data-next]');
  let i = 0, timer = null, rig = null, babble = () => {}, finishNow = null;
  const fmt = str => escapeHtml(str).replace(/\*([^*]*)\*?/g, '<b>$1</b>');
  const face = f => { head.src = `${ROOM}${NT_FACES[f] || f}.png`; NT_ACTED.forEach(a => headBox.classList.toggle(a, f === a)); };
  const mouth = f => { head.src = `${ROOM}${NT_FACES[f]}.png`; }; // flap without dropping the pose
  let ended = false;
  const end = () => {
    if (ended) return; ended = true; // one goodbye, one explosion
    clearTimeout(timer); finishNow = null; headBox.classList.remove('talking');
    onDone?.();
    if (!still) { explodeHead(head, rig); t.classList.add('exploding'); setTimeout(() => { rig?.close?.(); t.remove(); }, 800); return; }
    rig?.close?.(); t.remove();
  };
  // One line, typed: a char every 32ms, a babble on every other letter, the
  // mouth flapping; | waits a beat; {face} swaps the face right there.
  const type = st => {
    clearTimeout(timer);
    const tokens = st.say.match(/\{[a-z]+\}|\||[^{|]+/g) || [];
    let shown = '', ti = 0, ci = 0, flap = 0, mood = 'happy';
    out.innerHTML = ''; extra.innerHTML = ''; extra.hidden = true;
    headBox.classList.add('talking');
    const done = () => {
      clearTimeout(timer); finishNow = null;
      headBox.classList.remove('talking');
      if (!st._after) { st._after = true; st.afterType?.(); }
      shown = st.say.replace(/\{[a-z]+\}|\|/g, ''); out.innerHTML = fmt(shown).replace(/ {2,}/g, ' ');
      const faces = st.say.match(/\{([a-z]+)\}/g) || []; face(faces.length ? faces[faces.length - 1].slice(1, -1) : 'happy');
      if (st.html) { extra.innerHTML = st.html; extra.hidden = false; }
    };
    finishNow = done;
    if (still) { done(); return; }
    const tick = () => {
      const tok = tokens[ti];
      if (tok === undefined) { done(); return; }
      if (tok === '|') { ti++; headBox.classList.remove('talking'); face(mood); timer = setTimeout(() => { headBox.classList.add('talking'); tick(); }, 380); return; }
      if (tok[0] === '{') { mood = tok.slice(1, -1); face(mood); ti++; tick(); return; }
      const ch = tok[ci++];
      if (ch === undefined) { ti++; ci = 0; tick(); return; }
      shown += ch; out.innerHTML = fmt(shown);
      if (/[\p{L}\p{N}!?]/u.test(ch) && (ci % 2 === 0 || ch === '!' || ch === '?')) {
        babble(ch);
        if (!['sus', 'sly', 'cosmic', 'wink'].includes(mood)) mouth(flap++ % 2 ? 'closed' : 'open');
      }
      timer = setTimeout(tick, /[.!?]/.test(ch) ? 120 : 32);
    };
    tick();
  };
  const place = target => {
    t.classList.toggle('no-target', !target);
    let side = 'left';
    if (target) {
      target.scrollIntoView?.({ block: 'nearest', inline: 'center', behavior: 'instant' });
      const st = steps[i];
      const rs = (st.role ? [...host.querySelectorAll(`[data-role="${st.role}"]`)] : [target]).map(n => n.getBoundingClientRect());
      const r = { left: Math.min(...rs.map(q => q.left)), top: Math.min(...rs.map(q => q.top)), right: Math.max(...rs.map(q => q.right)), bottom: Math.max(...rs.map(q => q.bottom)) };
      const pad = 10;
      Object.assign(spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.right - r.left + pad * 2}px`, height: `${r.bottom - r.top + pad * 2}px` });
      // Neeff stands on the other side from whatever he's pointing at.
      if ((r.left + r.right) / 2 < innerWidth / 2) side = 'right';
    }
    if (steps[i].side) side = steps[i].side; // e.g. out of the way of the trunk
    t.classList.toggle('nt-right', side === 'right');
  };
  let waitOff = null, later = false;
  const advance = () => {
    waitOff?.(); waitOff = null;
    do { i++; } while (steps[i]?.skipIfLater && later);
    later = false;
    if (i >= steps.length) { end(); return; }
    show();
  };
  const show = () => {
    const st = steps[i];
    t.querySelector('.nt-step').textContent = `${i + 1} of ${steps.length}`;
    next.textContent = st.last ? (st.cta || 'Yes, buzz me!') : st.wait ? 'I’ll do it later' : st.cta || 'Next';
    next.style.display = st.wait && st.required ? 'none' : ''; // some things you just have to do
    const skip = t.querySelector('[data-skip]');
    skip.textContent = st.last ? 'Later' : 'Skip the tour';
    skip.hidden = !!st.office || !!st.required; // the office intro and saying hello can't be skipped
    st.onShow2?.();
    t.classList.toggle('in-office', !!st.office);
    st.onShow?.();
    const target = st.role ? el(st.role) : st.sel ? st.sel() : null;
    place(target);
    // A real task: the tour steps aside and waits until they've done it.
    t.classList.toggle('waiting', !!st.wait);
    spot.style.opacity = '';
    if (st.wait) {
      const did = () => advance();
      window.addEventListener(st.wait, did, { once: true });
      const hideSpot = () => { spot.style.opacity = '0'; };
      target?.addEventListener('click', hideSpot, { once: true });
      waitOff = () => { window.removeEventListener(st.wait, did); target?.removeEventListener('click', hideSpot); };
    }
    headBox.className = `nt-head mv-${st.move || 'boing'}`; void headBox.offsetWidth; headBox.classList.add('go');
    type(st);
    next.focus();
  };
  t.querySelector('[data-skip]').onclick = () => { waitOff?.(); end(); };
  t.querySelector('.nt-bubble').addEventListener('click', e => { if (!e.target.closest('button') && finishNow) finishNow(); });
  next.onclick = () => {
    if (finishNow) { finishNow(); return; } // first tap finishes the line
    // Sound needs a tap first: the babble starts with the first Next.
    if (!rig && !soundOff()) { rig = megaphone(); babble = makeBabbler(rig); }
    if (ended) return;
    if (steps[i].last) { const f = steps[i].finish; end(); if (f) f(); else inviteRaven('menu'); return; }
    if (steps[i].wait) later = true;
    steps[i].leave?.();
    advance();
  };
  show();
}

// ── Card of the day (2026-10-14) ── Omen keeps one Mercury Oracle card a
// day for every member (the server picks it, so no re-rolling). Face down
// until you turn it over; after that Omen quiets down until tomorrow.
let dailyCard = null;
const cardDay = () => new Date().toLocaleDateString('en-CA');
const cardKey = () => `cs-card-${profile?.id}`;
async function loadDailyCard() {
  try { dailyCard = await apiFetch(`/api/me/card?day=${cardDay()}`); } catch (e) { dailyCard = null; }
}
function cardWaiting() {
  if (!dailyCard) return false;
  try { return localStorage.getItem(cardKey()) !== dailyCard.day; } catch (e) { return false; }
}
function showDailyCard() {
  if (!dailyCard || document.querySelector('.daily-card')) return;
  const c = dailyCard.card, seen = !cardWaiting();
  const o = document.createElement('div');
  o.className = 'daily-card';
  o.setAttribute('role', 'dialog');
  o.setAttribute('aria-label', 'Your card for today');
  o.innerHTML = `
    <div class="dc-stage">
      <div class="dc-kicker">Omen’s card for ${new Date(dailyCard.day + 'T12:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</div>
      <button class="dc-card${seen ? ' turned' : ''}" aria-label="${seen ? escapeHtml(c.title) : 'Turn the card over'}">
        <span class="dc-face dc-back"><img src="${dailyCard.back}" alt=""></span>
        <span class="dc-face dc-front">${c.image ? `<img src="${c.image}" alt="">` : ''}</span>
      </button>
      <div class="dc-words"${seen ? '' : ' hidden'}>
        <h2>${escapeHtml(c.title)}</h2>
        ${c.phrase && c.phrase.toLowerCase() !== c.title.toLowerCase() ? `<p class="dc-phrase">“${escapeHtml(c.phrase)}”</p>` : ''}
        ${c.meaning ? `<p class="dc-meaning">${escapeHtml(c.meaning)}</p>` : ''}
        <p class="dc-fine">${dailyCard.full_deck ? 'Want more? The whole deck is on your dresser.' : 'A new card waits with Omen tomorrow.'}</p>
      </div>
      <div class="dc-hint"${seen ? ' hidden' : ''}>Tap to turn it over</div>
      <button class="oracle-close dc-close" aria-label="Put the card away">×</button>
    </div>`;
  const close = () => { o.classList.add('leaving'); setTimeout(() => o.remove(), 300); };
  o.querySelector('.dc-close').onclick = close;
  o.addEventListener('click', e => { if (e.target === o || e.target.classList.contains('dc-stage')) close(); });
  o.querySelector('.dc-card').onclick = e => {
    const card = e.currentTarget;
    if (card.classList.contains('turned')) return;
    card.classList.add('turned');
    card.setAttribute('aria-label', c.title);
    try { localStorage.setItem(cardKey(), dailyCard.day); } catch (err) { /* no storage */ }
    o.querySelector('.dc-hint').hidden = true;
    setTimeout(() => { o.querySelector('.dc-words').hidden = false; }, 650);
    roomHooks.onCard?.();
  };
  document.body.appendChild(o);
  requestAnimationFrame(() => o.classList.add('open'));
}

// ── Toasts and Escape (2026-10-12) ──
// A message that floats in and out; screen readers hear it. Replaces alert().
function flashToast(msg, ms = 4000) {
  const t = document.createElement('div');
  t.className = 'room-toast app-toast';
  t.setAttribute('role', 'status');
  document.body.appendChild(t);
  requestAnimationFrame(() => { t.textContent = msg; t.classList.add('show'); });
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms);
}
// Escape closes whatever is on top. Every overlay already closes on a click
// on its own backdrop, so a click on the backdrop is how Escape closes it.
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (mobileNavOpen && !document.querySelector('.blast-overlay, .admin-edit-overlay, .forum-note-overlay, .raven-modal')) { mobileNavOpen = false; renderShell(); return; }
  const tops = document.querySelectorAll('.unfold, .carnie-code, .bs-curtain, .oracle-overlay, .daily-card, .blast-overlay, .admin-edit-overlay, .forum-note-overlay, .raven-modal, .prize-pop, .intro-tour');
  const top = tops[tops.length - 1];
  if (top) {
    e.preventDefault();
    if (top.classList.contains('gift-pop') || top.classList.contains('surprise-pop')) top.remove();
    else if (top.classList.contains('prize-pop')) top.querySelector('[data-later]').click();
    else if (top.classList.contains('intro-tour')) top.querySelector('[data-skip]').click();
    else if (top.classList.contains('unfold')) top.querySelector('.unfold-close').click();
    else if (!top.classList.contains('blast-overlay')) top.click();
    else if (top.classList.contains('answered')) top.querySelector('[data-done]').click();
    else top.querySelector('.blast-pickup').focus(); // you can't hang up on the Ringleader
    return;
  }
});

// ── The blast composer (Ringleaders) ──
async function renderBlastView(mainView) {
  if (!profile.is_ringleader) { location.hash = '#/dressing-room'; return; }
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
  // held, not looked up: a re-render can swap the page out mid-fetch
  const reachEl = document.getElementById('blastReach'), historyEl = document.getElementById('blastHistory');
  let reachTimer;
  const updateReach = () => {
    form.querySelectorAll('.blast-sub').forEach(el => { el.hidden = el.dataset.for !== form.aud.value; });
    clearTimeout(reachTimer);
    reachTimer = setTimeout(async () => {
      try {
        const { recipients, phones } = await apiFetch('/api/blasts/preview', { method: 'POST', body: { audience: audience() } });
        reachEl.textContent = `Reaches ${recipients} member${recipients === 1 ? '' : 's'} · ${phones} with the raven on their phone`;
      } catch (e) { reachEl.textContent = e.message; }
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
      flashToast(`📣 Hollering at ${r.recipients} members (${r.phones} phones)!`);
    } catch (err) { document.getElementById('blastErr').textContent = err.message; }
    btn.disabled = false;
  });
  async function drawHistory() {
    const { blasts } = await apiFetch('/api/blasts');
    historyEl.innerHTML = blasts.length ? blasts.map(b => `
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
// ── What's new (2026-10-12): the room lights up where something's waiting.
// The server says when someone last added to each place; this device
// remembers when you last looked there.
let news = { courtyard: null, guild: null, events: null };
const seenKey = k => `cs-seen-${k}-${profile?.id}`;
function seenAt(k) {
  try { const v = localStorage.getItem(seenKey(k)); return v === null ? null : +v; } catch (e) { return Infinity; }
}
function markSeen(k) {
  try { localStorage.setItem(seenKey(k), String(Date.now())); } catch (e) { /* no storage */ }
  document.querySelectorAll(`[data-news="${k}"]`).forEach(d => { d.hidden = true; });
}
// First look on a device starts the clock instead of shouting about old news.
function isNew(k, at = news[k]) {
  const seen = seenAt(k);
  if (seen === null) { markSeen(k); return false; }
  return !!at && sqlTime(at) > seen;
}
const newsDot = k => `<span class="news-dot" data-news="${k}" ${isNew(k) ? '' : 'hidden'}></span>`;
function markSeenFor(route) {
  if (route === 'events' || route.startsWith('event/')) markSeen('events');
  else if (route === 'courtyard') markSeen('courtyard');
  else if (route === 'guild-hall' || chapters.some(c => c.slug === route)) markSeen('guild');
}
async function refreshNews() {
  if (!session) return;
  try { news = await apiFetch('/api/me/news'); } catch (e) { return; }
  document.querySelectorAll('[data-news]').forEach(d => { d.hidden = !isNew(d.dataset.news); });
  roomHooks.onNews?.();
  if (document.body.classList.contains('forum-docked')) mountForumWing();
  maybePrize(news.stamp);
}

// ── The prize moment (2026-10-12): confetti the moment a new stamp lands,
// wherever you are in the app. Once per stamp per device; "Later" leaves
// the trunk glowing in the room until you open it.
function maybePrize(st) {
  if (!st || !profile || !BADGES[st.kind]) return;
  const key = 'cs-prize-seen-' + profile.id;
  let seen;
  try { seen = localStorage.getItem(key); } catch (e) { return; }
  if (seen === st.id) return;
  if (Date.now() - sqlTime(st.created_at) > 7 * 864e5) { try { localStorage.setItem(key, st.id); } catch (e) { /* ignore */ } return; }
  try { if (sessionStorage.getItem('cs-prize-later-' + st.id)) return; } catch (e) { /* ignore */ }
  // Never on top of something else: a holler, the rank party, the intro, another prize.
  if (blastShowing || needsRankCelebration() || document.querySelector('.prize-pop, .rank-celebration, .intro-tour, .raven-modal')) return;
  const b = BADGES[st.kind];
  const confetti = Array.from({ length: 60 }, (_, i) =>
    `<span class="confetti" style="--x:${Math.random() * 100}vw;--d:${(Math.random() * 1.6 + 2.2).toFixed(2)}s;--delay:${(Math.random() * 0.9).toFixed(2)}s;--c:${['#C8A05A', '#9B3036', '#4E8C82', '#C77B8A', '#DFBE7D', '#FFE2A0'][i % 6]}"></span>`).join('');
  const o = document.createElement('div');
  o.className = 'prize-pop';
  o.setAttribute('role', 'dialog');
  o.setAttribute('aria-label', `You won a prize: ${b.name}`);
  o.innerHTML = `${confetti}
    <div class="prize-card">
      <div class="prize-kicker">Huzzah! You won a prize!</div>
      <div class="prize-patch has-art">${badgePatch(st.kind)}</div>
      <h2>${escapeHtml(b.name)}</h2>
      <p class="prize-motto">“${escapeHtml(b.motto)}”</p>
      ${st.event_title ? `<p class="prize-where">for ${escapeHtml(st.event_title)}</p>` : ''}
      <div class="prize-btns"><button class="composer-submit" data-open>Open the trunk</button><button class="raven-offer-no" data-later>Later</button></div>
    </div>`;
  document.body.appendChild(o);
  try { const rig = megaphone(); if (rig) { playBoing(rig); setTimeout(() => rig.close(), 1500); } } catch (e) { /* no sound, no matter */ }
  const close = () => o.remove();
  o.querySelector('[data-later]').onclick = () => { try { sessionStorage.setItem('cs-prize-later-' + st.id, '1'); } catch (e) { /* ignore */ } close(); };
  // A fresh room, so the trunk knows about the stamp that just landed.
  o.querySelector('[data-open]').onclick = () => { close(); roomStage = null; if (location.hash === '#/badges') render(); else location.hash = '#/badges'; };
  o.querySelector('[data-open]').focus();
}

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
  const route = currentRoute();
  const onRoom = isRoomRoute(route) || !!unfoldKindOf(route) || route === 'backstage';
  // Docked wherever the room is the backdrop, when its side is wide enough.
  const sideSpace = (innerWidth - (innerHeight - 69)) / 2;
  const docked = onRoom && innerWidth > 800 && sideSpace >= 300;
  document.body.classList.toggle('chat-docked', docked);
  const isOpen = docked || chat.open === true;
  panel.classList.toggle('open', isOpen);
  document.getElementById('chatLauncher').hidden = docked;
  if (isOpen) chat.unread = 0;
  drawChat();
  document.getElementById('chatLauncher').onclick = () => { chat.open = true; mountChat(); chatToLatest(); document.getElementById('chatInput')?.focus(); };
  const input = document.getElementById('chatInput');
  input.onfocus = () => { fitChatToKeyboard(); setTimeout(() => { fitChatToKeyboard(); chatToLatest(); }, 350); };
  input.onblur = () => setTimeout(fitChatToKeyboard, 150);
  document.getElementById('chatClose').onclick = () => { chat.open = false; document.body.classList.remove('chat-docked'); panel.classList.remove('open'); document.getElementById('chatLauncher').hidden = false; drawUnread(); };
  document.getElementById('chatForm').onsubmit = async e => {
    e.preventDefault();
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text || chat.busy) return;
    chat.busy = true;
    try {
      await apiFetch('/api/chat', { method: 'POST', body: { body: text } });
      window.dispatchEvent(new Event('cs-chat-sent')); // the tour waits for this
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

// Phones (2026-10-14): when the keyboard comes up, the Green Room shrinks to
// the part of the screen you can still see (newest messages + where you
// type, right above the keyboard) instead of the page sliding away under it.
function chatToLatest() {
  const list = document.getElementById('chatList');
  if (list) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
}
function fitChatToKeyboard() {
  const panel = document.getElementById('chatPanel'), vv = window.visualViewport;
  if (!panel) return;
  const typing = !!vv && innerWidth <= 800 && chatIsOpen() && innerHeight - vv.height > 120;
  document.body.classList.toggle('chat-typing', typing);
  if (typing) {
    Object.assign(panel.style, { top: `${vv.offsetTop}px`, bottom: 'auto', height: `${vv.height}px` });
    chatToLatest();
  } else panel.style.removeProperty('top'), panel.style.removeProperty('bottom'), panel.style.removeProperty('height');
}
if (window.visualViewport) {
  visualViewport.addEventListener('resize', () => { if (document.body.classList.contains('chat-typing') || document.activeElement?.id === 'chatInput') fitChatToKeyboard(); });
  visualViewport.addEventListener('scroll', () => { if (document.body.classList.contains('chat-typing')) fitChatToKeyboard(); });
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
      <div class="chat-meta">${m.user_id && m.user_id !== profile.id ? `<a class="chat-name" href="#/room/${m.user_id}" title="Visit their Dressing Room">${escapeHtml(m.display_name)}</a>` : `<span class="chat-name">${escapeHtml(m.display_name)}</span>`}${m.is_ringleader ? '<span class="chat-tag">Ringleader</span>' : ''}<span class="chat-time">${timeAgo(m.created_at.replace(' ', 'T') + 'Z')}</span>
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
      if (!chatIsOpen() || n++ % 3 === 0) { await refreshLetters(); refreshNews(); }
      await checkBlast();
    }
    chat.timer = setTimeout(tick, chatIsOpen() ? 3000 : 10000);
  };
  pollChat(); refreshLetters(); refreshNews(); checkBlast();
  chat.timer = setTimeout(tick, 3000);
}
// Coming back to the tab: catch up right away instead of waiting a tick.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && session && chat.timer) { pollChat(); refreshLetters(); refreshNews(); checkBlast(); }
});
window.addEventListener('resize', () => { if (session && document.getElementById('chatPanel')) { mountChat(); mountForumWing(); } });

// ── The Guild Hall wing (2026-10-12): on wide screens the forum stays open in
// the room's right wing, flush to the painting, mirroring the Green Room.
// It lives outside #app so navigating doesn't reload it.
const wing = { slug: null, at: 0, stamp: '' };
function dropForumWing() {
  document.getElementById('forumWing')?.remove();
  document.body.classList.remove('forum-docked');
  Object.assign(wing, { slug: null, at: 0, stamp: '' });
}
async function mountForumWing() {
  const docked = session && document.body.classList.contains('chat-docked');
  document.body.classList.toggle('forum-docked', !!docked);
  let el = document.getElementById('forumWing');
  if (!docked) { if (el) el.hidden = true; return; }
  const inner = isInnerMember();
  if (!wing.slug || (!inner && wing.slug !== 'courtyard')) wing.slug = inner ? 'guild-hall' : 'courtyard';
  if (!el) {
    el = document.createElement('aside');
    el.id = 'forumWing';
    el.className = 'forum-wing';
    document.body.appendChild(el);
    el.addEventListener('click', e => {
      const t = e.target.closest('[data-wing]');
      if (t && t.dataset.wing !== wing.slug) { wing.slug = t.dataset.wing; mountForumWing(); }
    });
  }
  el.hidden = false;
  // Redraw only when the board, or what's new on it, has changed (or now and then).
  const stamp = `${wing.slug}|${news.guild}|${news.courtyard}`;
  if (stamp === wing.stamp && Date.now() - wing.at < 90e3) return;
  wing.stamp = stamp; wing.at = Date.now();
  const yard = wing.slug === 'courtyard';
  el.setAttribute('aria-label', yard ? 'The Courtyard' : 'The Guild Hall');
  const tab = (slug, label) => `<button class="wing-tab ${wing.slug === slug ? 'active' : ''}" data-wing="${slug}" aria-pressed="${wing.slug === slug}">${label}${newsDot(slug === 'courtyard' ? 'courtyard' : 'guild')}</button>`;
  el.innerHTML = `
    <div class="wing-head">
      <div class="wing-title">${forumIcon(yard ? 'yard' : 'tent', 20)}<span>${yard ? 'The Courtyard' : 'The Guild Hall'}</span></div>
      ${inner ? `<div class="wing-tabs">${tab('guild-hall', 'Guild Hall')}${tab('courtyard', 'Courtyard')}</div>` : ''}
    </div>
    <div class="wing-body"><div class="forum-empty">Unrolling the parchment…</div></div>`;
  const body = el.querySelector('.wing-body');
  try { await renderBoardView(body, wing.slug); } catch (e) { body.innerHTML = '<div class="forum-empty">The pages are stuck. Try again in a moment.</div>'; }
}

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
const ROOM_ASSETS = { megaphone_floor: 347 / 181, trunk_closed: 338 / 329, trunk_open: 322 / 393, costume_ringmaster: 156 / 327, costume_teal: 143 / 382, costume_clown: 138 / 386, costume_purple: 165 / 348, costume_pink: 178 / 418, raven_perched: 151 / 287, raven_squawk: 208 / 297, flyer_circus: 147 / 239, flyer_volunteer: 122 / 212, flyer_carnival: 127 / 219, book_lectern: 188 / 282, book_open: 232 / 228, passport_closed: 145 / 212, passport_open: 191 / 181, perch_empty: 116 / 217, hatbox_closed: 185 / 160, hatbox_open: 222 / 279, popcorn: 132 / 189, potion: 76 / 161, coat_rack: 127 / 347, vanity: 283 / 271, rug: 315 / 205 };
const ROOM_ANIMS = { '': 'Still', sway: 'Sway (hangs from top)', flutter: 'Flutter', float: 'Float', breathe: 'Breathe', hop: 'Hop', shimmer: 'Shimmer', wobble: 'Wobble' };
const ROOM_ROLES = {
  decor: 'Just decoration', mirror: 'Mirror → My Profile', trunk: 'Trunk → Badges', costume: 'Costume → Profile / acts',
  flyer: 'Flyer → an upcoming event', raven: 'Raven → volunteer requests', book: 'Big Book → the forum', drawer: 'Drawer → Letters',
  exit: 'Exit → Courtyard', hatbox: 'Hat box → Ringleader tools (only you see it)', potion: 'Secret → Mercury Oracle', stars: 'Secret → Field Oracle',
  popcorn: 'Popcorn (pops)', events: 'Events list', tickets: 'My Tickets',
};
// ── Personal rooms (2026-10-12): themes, the item drawer, starter layout ──
const ROOM_THEMES = { classic: 'The Classic', fire: 'Flame Breather', aerial: 'The Aerialist', celestial: 'The Fortune-Teller', original: 'The Original', office: 'The Ringmaster’s Office' };
// Only the Ringleader's: the Office (where Sunny & Daisy roam) and the Original.
const RINGLEADER_THEMES = ['office', 'original'];
const themeSrc = t => `${ROOM}${t === 'original' ? 'room_bg' : `rooms/${t}`}.jpg`;
// The decoration drawer: everything cut from Neeff's sheets. Specials (and
// how to earn them) come from the server, which also enforces them.
const ROOM_ITEMS = {
  'Furniture': ['vanity_desk', 'chair_velvet', 'chaise', 'dresser', 'tuffet_red', 'tuffet_harlequin', 'stool_short', 'cushion_round', 'pillow_star', 'screen_moon', 'coat_rack', 'costume_rack', 'dress_stand', 'gramophone'],
  'Trunks & boxes': ['trunk_blue', 'trunk_star', 'trunk_scarf', 'treasure_box', 'crate_star', 'suitcase', 'hatbox_small', 'drum_blue', 'drum_short', 'drum_tall', 'pedestal_red', 'blankets'],
  'Lights & walls': ['mirror_bulbs', 'mirror_oval', 'mirror_floor', 'lamp_fringe', 'sconce', 'lantern_gold', 'lantern_iron', 'lantern_small', 'lantern_violet', 'candle', 'star_garland', 'banner_star', 'painting_bigtop', 'frame_small', 'curtain_drape', 'rug_star', 'moon_charm'],
  // Neeff's Kooky Collector sheet: earned (or given), never bought.
  'Prizes': ['first_ticket', 'pennant_kooks', 'friendship_bracelet', 'quill_ink', 'guestbook', 'paint_pot', 'pie', 'rope_knot', 'juggling_clubs', 'gift_basket', 'clown_nose', 'jack_o_lantern', 'snow_globe', 'welcome_wreath', 'thank_you_card', 'golden_ticket', 'backstage_pass', 'medal', 'plush_sunny', 'plush_daisy', 'photo_frame'],
  // Trophies: the Ringleader hands these out (surprises), for real feats.
  'Trophies': ['trophy_cup', 'trophy_hoops', 'trophy_horse', 'trophy_bigtop', 'trophy_stars', 'trophy_jester', 'trophy_elephant', 'trophy_laurel', 'trophy_cup_bigtop', 'trophy_cannon', 'trophy_crown', 'trophy_star'],
  'Props & treasures': ['tophat', 'jester_hat', 'ringmaster_coat', 'leotard', 'boots', 'plumes', 'feather_vase', 'fan_feather', 'fan_stripe', 'hoop', 'rope_coil', 'toy_horn', 'ticket_admit', 'mercury_deck', 'tarot_fan', 'tarot_pair', 'books', 'perfume', 'plant_vase', 'popcorn_box', 'crystal_ball', 'unicycle', 'rocking_horse', 'juggling_pins', 'rabbit_hat', 'big_top', 'aerial_silks'],
};
// A few drawer items come already doing something (still changeable in Arrange).
const ITEM_ROLES = { 'items/mercury_deck': 'potion', 'items/crystal_ball': 'potion' };
// Surprises (2026-10-13): a wrapped parcel the Ringleader leaves in a room.
// A surprise arrives in the striped hat box; unwrapping lifts the lid.
const GIFT_BOX = `<img src="${ROOM}hatbox_closed.png" alt="" draggable="false">`;
const giftFrom = g => g.from_name ? `Ringleader ${g.from_name.split(' ')[0]}` : 'the Ringleader';
const giftName = g => g.kind === 'pass' ? 'Admit One guest pass' : g.img.replace(/^items\//, '').replace(/_/g, ' ');
// The gift card: the thing, the note, and for a guest pass the code to scan.
function showGift(g, { fresh = false } = {}) {
  const confetti = fresh ? Array.from({ length: 60 }, (_, i) =>
    `<span class="confetti" style="--x:${Math.random() * 100}vw;--d:${(Math.random() * 1.6 + 2.2).toFixed(2)}s;--delay:${(Math.random() * 0.9).toFixed(2)}s;--c:${['#C8A05A', '#9B3036', '#4E8C82', '#C77B8A', '#DFBE7D', '#FFE2A0'][i % 6]}"></span>`).join('') : '';
  const where = g.event_title ? `at ${escapeHtml(g.event_title)}` : 'at any carnival';
  const pass = g.kind === 'pass' ? (g.redeemed_at
    ? `<div class="gift-pass used"><b>PUNCHED</b><span>Your guest came${g.redeemed_title ? ` to ${escapeHtml(g.redeemed_title)}` : ''} on ${new Date(sqlTime(g.redeemed_at)).toLocaleDateString()}. Huzzah!</span></div>`
    : `<div class="gift-pass"><b>ADMIT ONE · GUEST</b><span>Bring a friend ${where}. Show this at the door.</span>${g.code ? `<div class="ticket-qr">${qrSvg(g.code)}</div><code>${escapeHtml(g.code)}</code>` : ''}</div>`) : '';
  const o = document.createElement('div');
  o.className = 'prize-pop gift-pop';
  o.setAttribute('role', 'dialog');
  o.setAttribute('aria-label', `A gift from ${giftFrom(g)}`);
  o.innerHTML = `${confetti}
    <div class="prize-card gift-card">
      <div class="prize-kicker">${fresh ? 'A surprise for you!' : `A gift from ${escapeHtml(giftFrom(g))}`}</div>
      <img class="gift-art" src="${ROOM}${g.img}.png" alt="">
      <h2>${escapeHtml(giftName(g))}</h2>
      ${g.note ? `<p class="gift-note">“${escapeHtml(g.note)}”<span>${escapeHtml(giftFrom(g))}</span></p>` : `<p class="prize-where">from ${escapeHtml(giftFrom(g))}</p>`}
      ${pass}
      <div class="prize-btns"><button class="composer-submit" data-close>${fresh ? 'Put it in my room' : 'Lovely'}</button>${g.kind === 'pass' && !g.redeemed_at ? '<a class="raven-offer-no" href="#/tickets" data-close>With my tickets</a>' : ''}</div>
    </div>`;
  document.body.appendChild(o);
  if (fresh) try { const rig = megaphone(); if (rig) { playBoing(rig); setTimeout(() => rig.close(), 1500); } } catch (e) { /* no sound, no matter */ }
  o.addEventListener('click', e => { if (e.target === o || e.target.closest('[data-close]')) o.remove(); });
  o.querySelector('[data-close]').focus();
}
// The Ringleader's surprise sheet, opened while visiting someone's room.
async function openSurprise(ownerId, ownerName, wrapped, done) {
  const { events } = await apiFetch('/api/events').catch(() => ({ events: [] }));
  const o = document.createElement('div');
  o.className = 'prize-pop surprise-pop';
  o.setAttribute('role', 'dialog');
  o.setAttribute('aria-label', `Leave a surprise for ${ownerName}`);
  // Trophies and prizes first: they're what the Ringleader hands out most.
  const all = [...ROOM_ITEMS.Trophies, ...ROOM_ITEMS.Prizes, ...Object.entries(ROOM_ITEMS).filter(([c]) => c !== 'Trophies' && c !== 'Prizes').flatMap(([, l]) => l)].filter(n => n !== 'ticket_admit');
  o.innerHTML = `
    <form class="prize-card surprise-card">
      <div class="prize-kicker">🎁 A surprise for ${escapeHtml(ownerName)}</div>
      <div class="surprise-pick">
        <button type="button" class="surprise-thing" data-img="pass" title="Admit One guest pass"><img src="${ROOM}items/ticket_admit.png" alt=""><span>Guest pass</span></button>
        ${all.map(n => `<button type="button" class="surprise-thing" data-img="items/${n}" title="${escapeHtml(n.replace(/_/g, ' '))}"><img src="${ROOM}items/${n}.png" alt="" loading="lazy"></button>`).join('')}
      </div>
      <div class="surprise-chosen"></div>
      <label class="surprise-event">Good for <select name="event"><option value="">Any carnival</option>${(events || []).map(e => `<option value="${e.id}">${escapeHtml(e.title)}</option>`).join('')}</select></label>
      <textarea name="note" maxlength="200" rows="3" placeholder="A little note… (for the night you held the ladder)"></textarea>
      <div class="prize-btns"><button class="composer-submit" type="submit">Wrap it up</button><button class="raven-offer-no" type="button" data-close>Never mind</button></div>
      ${wrapped.length ? `<div class="surprise-waiting"><b>Still wrapped in this room</b>${wrapped.map(g => `<div><img src="${ROOM}${g.img}.png" alt=""> ${escapeHtml(giftName(g))}<button type="button" class="raven-offer-no" data-take="${g.id}">Take it back</button></div>`).join('')}</div>` : ''}
    </form>`;
  document.body.appendChild(o);
  const form = o.querySelector('form');
  let pick = 'pass';
  const chosen = () => {
    o.querySelectorAll('.surprise-thing').forEach(b => b.classList.toggle('picked', b.dataset.img === pick));
    o.querySelector('.surprise-event').hidden = pick !== 'pass';
    o.querySelector('.surprise-chosen').textContent = pick === 'pass' ? 'Admit One: they can bring a guest, scanned once at the door.' : pick.replace(/^items\//, '').replace(/_/g, ' ');
  };
  chosen();
  o.addEventListener('click', async e => {
    if (e.target === o || e.target.closest('[data-close]')) { o.remove(); return; }
    const t = e.target.closest('.surprise-thing');
    if (t) { pick = t.dataset.img; chosen(); return; }
    const take = e.target.closest('[data-take]');
    if (take) {
      take.disabled = true;
      try { await apiFetch(`/api/gifts/${take.dataset.take}`, { method: 'DELETE' }); take.parentElement.remove(); flashToast('Taken back. They never knew.'); done(); }
      catch (err) { flashToast(err.message); take.disabled = false; }
    }
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]'); btn.disabled = true;
    try {
      await apiFetch(`/api/rooms/${ownerId}/gifts`, { method: 'POST', body: { pass: pick === 'pass', img: pick === 'pass' ? null : pick, event_id: pick === 'pass' ? form.event.value || null : null, note: form.note.value } });
      o.remove(); flashToast(`🎁 Wrapped and left in ${ownerName}’s room. Omen will tell them.`); done();
    } catch (err) { flashToast(err.message); btn.disabled = false; }
  });
}
const ROOM_CATS = ['sunny_sit', 'sunny_play', 'sunny_sleep', 'daisy_lie', 'daisy_drum', 'daisy_ball'];
// Every themed room shares a shape: window left, vanity right, rug in front.
const DRESSING_DEFAULT = [
  { id: 'mirror', role: 'mirror', img: null, l: 74, t: 24, w: 22, h: 25 },
  { id: 'drawer', role: 'drawer', img: null, l: 70, t: 50, w: 26, h: 7 },
  { id: 'exit', role: 'exit', img: null, l: 9, t: 20, w: 19, h: 30 },
  { id: 'f1', role: 'flyer', n: 0, img: 'flyer_circus', l: 39, t: 29, w: 7, rot: -5, anim: 'flutter' },
  { id: 'f2', role: 'flyer', n: 1, img: 'flyer_volunteer', l: 47.5, t: 31, w: 6.4, rot: 4, anim: 'flutter' },
  { id: 'f3', role: 'flyer', n: 2, img: 'flyer_carnival', l: 55.5, t: 29, w: 6.6, rot: -5, anim: 'flutter' },
  { id: 'trunk', role: 'trunk', img: 'trunk_closed', l: 3, t: 69, w: 19 },
  { id: 'book', role: 'book', img: 'book_lectern', l: 61, t: 53, w: 11, anim: 'float' },
  { id: 'raven', role: 'raven', img: 'raven_perched', l: 49, t: 46, w: 8.5, anim: 'breathe' },
  { id: 'popcorn', role: 'popcorn', img: 'popcorn', l: 81, t: 45, w: 4.5, anim: 'wobble' },
  { id: 'potion', role: 'potion', img: 'potion', l: 88.5, t: 46.5, w: 2.4, anim: 'shimmer' },
];
// The Ringmaster's Office: door on the right, the bookshelf, the desk.
const OFFICE_DEFAULT = [
  { id: 'exit', role: 'exit', img: null, l: 92, t: 18, w: 8, h: 58 },
  { id: 'book', role: 'book', img: null, l: 0, t: 6, w: 10, h: 42 },
  { id: 'drawer', role: 'drawer', img: null, l: 56, t: 53, w: 22, h: 10 },
  { id: 'mirror', role: 'mirror', img: null, l: 72.5, t: 14, w: 11, h: 23 },
  { id: 'f1', role: 'flyer', n: 0, img: 'flyer_circus', l: 47, t: 23, w: 5.4, rot: -4, anim: 'flutter' },
  { id: 'f2', role: 'flyer', n: 1, img: 'flyer_volunteer', l: 47.5, t: 37, w: 5, rot: 3, anim: 'flutter' },
  { id: 'f3', role: 'flyer', n: 2, img: 'flyer_carnival', l: 66.5, t: 34, w: 4.6, rot: -3, anim: 'flutter' },
  { id: 'raven', role: 'raven', img: 'raven_perched', l: 80.5, t: 40.5, w: 7, anim: 'breathe' },
  { id: 'popcorn', role: 'popcorn', img: 'popcorn', l: 21.5, t: 49.5, w: 4, anim: 'wobble' },
  { id: 'trunk', role: 'trunk', img: 'trunk_closed', l: 2, t: 74, w: 17 },
  { id: 'hatbox', role: 'hatbox', img: 'hatbox_closed', l: 30, t: 87, w: 10 },
];
const defaultRoom = theme => JSON.parse(JSON.stringify(theme === 'original' ? ROOM_DEFAULT : theme === 'office' ? OFFICE_DEFAULT : DRESSING_DEFAULT));
const isRoomRoute = route => ROOM_ROUTES.includes(route) || route.startsWith('room/');

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

async function renderRoom(mainView, ownerId = null) {
  mainView.classList.add('main-room');
  roomEditing = false;
  document.body.classList.remove('arranging');
  const visiting = !!ownerId;
  const [p, { events }, room, { jobs }, { crews }] = await Promise.all([
    apiFetch('/api/me/passport'), apiFetch('/api/events'),
    apiFetch(visiting ? `/api/rooms/${ownerId}` : '/api/me/room').catch(() => ({ items: null, theme: 'classic', notes: [], unlocked: [], specials: {} })),
    apiFetch('/api/jobs').catch(() => ({ jobs: [] })), apiFetch('/api/me/crews').catch(() => ({ crews: [] })), refreshLetters(), refreshNews(), loadDailyCard(),
  ]);
  // Crews you're on whose handshakes are open: someone waiting on you, or crewmates not met yet.
  const shakeAsk = crews.find(c => c.asks > 0), shakeOpen = crews.find(c => c.unshaken > 0);
  // Open job spots per event, and the soonest event (within 10 days) still short of hands.
  const openSpots = id => jobs.filter(j => j.event_id === id).reduce((n, j) => n + Math.max(j.slots - j.claims.length, 0), 0);
  const shortHanded = (events || []).find(e => sqlTime(e.starts_at) - Date.now() < 10 * 864e5 && openSpots(e.id) > 0);
  const upcoming = events || [];
  const request = upcoming.find(e => !myVolunteering.has(e.id));
  const latest = p.stamps[p.stamps.length - 1];
  let newStamp = false;
  try { newStamp = !visiting && !!latest && localStorage.getItem('cs-prize-seen-' + profile.id) !== latest.id && Date.now() - sqlTime(latest.created_at) < 7 * 864e5; } catch (e) { /* no storage */ }
  const inner = isInnerMember();
  let theme = room.theme || 'classic';
  let savedTheme = theme;
  const saved = Array.isArray(room.items) ? room.items : defaultRoom(theme);
  let items = JSON.parse(JSON.stringify(saved));
  const notes = room.notes || [];
  const gifts = room.gifts || [];
  const wrapped = () => gifts.filter(g => !g.opened_at);
  const giftOf = it => it.gift && gifts.find(g => g.id === it.gift);
  const ownerName = room.owner?.display_name || 'Someone';
  // The barker's cone isn't a room item: it lives in code and rolls into
  // whatever room is on screen when the Ringleader hollers (showBlast).

  let selectedId = null;

  // What a role means right now: hover verb, destination (null = reacts in place).
  const behave = it => {
    if (visiting) return it.role === 'mirror' ? [`Leave a note on ${ownerName}’s mirror`, null] : [null, null];
    if (it.role === 'decor' && giftOf(it)) return [`${giftOf(it).kind === 'pass' ? 'Your guest pass' : 'A gift'} from ${giftFrom(giftOf(it))}`, null];
    switch (it.role) {
      case 'mirror': return ['Look in the Mirror', '#/profile'];
      case 'trunk': return [newStamp ? 'Open the Trunk (something new!)' : 'Open the Steamer Trunk', '#/badges'];
      case 'costume': return ['Try on a Costume', '#/profile'];
      case 'flyer': { const e = upcoming[it.n || 0]; const n = e ? openSpots(e.id) : 0; return e ? [`${fresh(it) ? 'New flyer' : 'Flyer'}: ${e.title}${n ? ` · ${n} job ${n === 1 ? 'spot' : 'spots'} open` : ''}`, `#/event/${e.id}`] : ['Read the Flyers', '#/events']; }
      case 'raven': {
        if (letters.unread) {
          const f = letters.from[0];
          return [`Hear Omen (a letter from ${f.display_name}!)`, letters.from.length === 1 ? `#/dm/${f.conversation_id}` : '#/dm'];
        }
        if (wrapped().length) return ['Hear Omen (a surprise is waiting!)', null];
        const nf = items.find(f => f.role === 'flyer' && visible(f) && fresh(f));
        if (shakeAsk) return ['Hear Omen (someone wants to shake hands!)', `#/event/${shakeAsk.id}`];
        if (nf) return [`Hear Omen (new flyer: ${flyerEvent(nf).title})`, `#/event/${flyerEvent(nf).id}`];
        if (shortHanded) return [`Hear Omen (jobs open at ${shortHanded.title})`, `#/event/${shortHanded.id}`];
        if (shakeOpen) return [`Hear Omen (shake hands with your ${shakeOpen.title} crew)`, `#/event/${shakeOpen.id}`];
        if (!visiting && cardWaiting()) return ['Hear Omen (your card for today!)', 'card'];
        return request ? [`Hear Omen (${request.title} needs hands)`, `#/event/${request.id}`] : ['Pet Omen', null];
      }
      case 'book': return [fresh(it) ? 'Open the Big Book (new posts!)' : 'Open the Big Book', inner ? '#/guild-hall' : '#/courtyard'];
      case 'drawer': return inner ? ['Open the Drawer (your letters)', '#/dm'] : ['Try the Drawer (locked)', null];
      case 'exit': return visiting ? ['Step back out backstage', '#/backstage'] : [fresh(it) ? 'Step out to the Courtyard (something new!)' : 'Step out to the Courtyard', '#/courtyard'];
      case 'hatbox': return ['Open the Ringleader’s Hat Box', 'more'];
      case 'potion': {
        const full = dailyCard?.full_deck;
        const verb = it.img === 'items/mercury_deck' ? (full ? 'Draw from the Mercury Oracle' : 'Turn over today’s card') : it.img === 'items/crystal_ball' ? 'Gaze into the Crystal Ball' : 'Drink the Strange Little Bottle';
        return [verb, full ? ORACLES.mercury : 'card'];
      }
      case 'stars': return ['Touch the Hanging Stars', ORACLES.field];
      case 'popcorn': return ['Eat the Popcorn', null];
      case 'events': return ['See what’s coming up', '#/events'];
      case 'tickets': return ['Find your Tickets', '#/tickets'];
      case 'megaphone': return [lastHoller() ? 'Pick up the Megaphone (hear the last holler)' : 'Pick up the Megaphone', null];
      default: return [null, null];
    }
  };
  // Live state swaps art: the raven squawks, the trunk spills open.
  const look = it => {
    let img = it.img, w = it.w, t = it.t, anim = it.anim || '';
    // The raven really squawks: two frames (beak shut / beak open) flipped in
    // bursts — frantic for a letter, now-and-then for a volunteer call.
    let frames = null;
    if (!roomEditing && it.role === 'raven' && img === 'raven_perched' && squawk()) { frames = letters.unread || wrapped().length || items.some(f => f.role === 'flyer' && fresh(f)) ? 'frantic' : 'calm'; anim = 'hop'; }
    if (!roomEditing && it.role === 'trunk' && newStamp && img === 'trunk_closed') {
      img = 'trunk_open'; t = it.t + it.w / ROOM_ASSETS.trunk_closed - it.w / ROOM_ASSETS.trunk_open; anim = 'breathe';
    }
    // Something new waiting behind it: the object perks up.
    let cls = !roomEditing && fresh(it) ? 'is-new' : '';
    const poster = it.role === 'flyer' && flyerEvent(it)?.flyer_url;
    if (poster) cls += ' has-poster';
    return { img, w, t, anim, frames, cls, poster };
  };
  // What the raven is squawking about, most urgent first (null = quiet).
  const short = (t, n = 26) => t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
  const squawk = () => {
    if (visiting) return null;
    if (wrapped().length) return `A surprise from ${short(giftFrom(wrapped()[0]), 20)}!`;
    if (letters.unread && letters.from[0]) return letters.unread === 1 ? `A letter from ${short(letters.from[0].display_name, 18)}!` : `${letters.unread} new letters!`;
    if (shakeAsk) return `A crewmate wants to shake hands! (${short(shakeAsk.title, 20)})`;
    const nf = items.find(it => it.role === 'flyer' && visible(it) && fresh(it));
    if (nf) return `New flyer: ${short(flyerEvent(nf).title)}`;
    if (shortHanded) { const n = openSpots(shortHanded.id); return `${n} ${n === 1 ? 'job' : 'jobs'} open: ${short(shortHanded.title)}`; }
    if (shakeOpen) return `Shake hands with your ${short(shakeOpen.title, 20)} crew!`;
    if (inner && isNew('guild')) return 'New in the Guild Hall!';
    if (isNew('courtyard')) return 'New in the Courtyard!';
    if (newStamp) return 'A new badge in the trunk!';
    if (cardWaiting()) return 'Your card for today!';
    if (request) return `Hands needed: ${short(request.title)}`;
    return null;
  };
  // Flyers are the real upcoming events: one per event, none when it's quiet.
  const flyerEvent = it => upcoming[it.n || 0];
  const fresh = it => {
    if (visiting) return false;
    switch (it.role) {
      case 'flyer': { const e = flyerEvent(it); return !!e && e.created_by !== profile.id && isNew('events', e.created_at); }
      case 'book': return inner ? isNew('guild') : isNew('courtyard');
      case 'exit': return isNew('courtyard');
      case 'drawer': return inner && letters.unread > 0;
      default: return false;
    }
  };
  const visible = it => it.role !== 'megaphone' && (roomEditing || ((it.role !== 'hatbox' || profile.is_ringleader) && (it.role !== 'flyer' || !!flyerEvent(it))));

  const bulbs = [[9.2,19.2],[8.4,27.5],[8.8,35.6],[10.3,43.2],[15.6,13.8],[20.2,11.6],[26.5,13.9],[31.9,16.8],[34.7,23.1],[36.3,29.9],[37.1,37.1],[30.6,23.6]];
  const motes = Array.from({ length: 14 }, (_, i) => `<span class="room-mote" style="left:${(8 + (i * 61) % 84)}%;top:${(20 + (i * 37) % 60)}%;animation-delay:${(i * 0.9) % 11}s;animation-duration:${9 + (i % 5) * 2}s"></span>`).join('');

  mainView.innerHTML = `
    <div class="room-viewport" id="roomViewport">
      <div class="room-scene" id="roomScene">
        <img class="room-bg" id="roomBg" src="${themeSrc(theme)}" alt="" draggable="false">
        <div class="room-lamplight" aria-hidden="true"></div>
        ${theme !== 'original' ? '' : bulbs.map(([x, y], i) => `<span class="room-bulb" style="left:${x}%;top:${y}%;animation-delay:${(i * 0.37) % 3}s;animation-duration:${2.6 + (i % 4) * 0.7}s" aria-hidden="true"></span>`).join('')}
        <div class="room-items" id="roomItems"></div>
        <div class="room-motes" aria-hidden="true">${motes}</div>
        <div class="room-labels" id="roomLabels" aria-hidden="true"></div>
      </div>
    </div>
    <div class="room-verb" id="roomVerb" aria-hidden="true"></div>
    <button class="room-reveal" id="roomReveal" aria-label="Show everything you can touch">✦</button>
    ${visiting ? `<div class="room-visit-plaque"><span>🎪 ${escapeHtml(ownerName)}’s Dressing Room</span><button class="room-plaque-btn" id="roomLeaveNote">📝 Leave a note on the mirror</button><a class="raven-offer-no" href="#/backstage">← Back backstage</a></div>` : '<button class="room-arrange-btn" id="roomArrange">✎ Arrange</button>'}
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
        return `<button class="room-hot${sel}${v.cls ? ' ' + v.cls : ''}" data-item="${it.id}" data-role="${it.role}" ${live ? `aria-label="${escapeHtml(label)}"` : 'tabindex="-1" aria-hidden="true"'} style="left:${it.l}%;top:${it.t}%;width:${it.w}%;height:${it.h || 10}%">${roomEditing ? `<span class="room-hot-name">${escapeHtml(ROOM_ROLES[it.role] || it.role)}</span>` : ''}${handle}</button>`;
      }
      const tag = live || roomEditing ? 'button' : 'div';
      return `<${tag} class="room-obj ${v.anim}${live ? '' : ' decor'}${sel}${v.cls ? ' ' + v.cls : ''}" data-item="${it.id}" data-role="${it.role}" ${live ? `aria-label="${escapeHtml(label)}"` : 'aria-hidden="true"'} style="left:${it.l}%;top:${v.t}%;width:${v.w}%">
        <span class="room-turn" style="${tf}">${v.frames
          ? `<span class="raven-frames ${v.frames}"><img class="rf-shut" src="${ROOM}raven_perched.png" alt="" draggable="false"><img class="rf-open" src="${ROOM}raven_squawk.png" alt="" draggable="false"></span>`
          : v.poster ? `<img class="room-poster" src="${escapeHtml(v.poster)}" alt="" draggable="false"><span class="poster-pin" aria-hidden="true"></span>`
          : `<img src="${ROOM}${v.img}.png" alt="" draggable="false">`}</span>${handle}</${tag}>`;
    }).join('') + (roomEditing ? '' : extras());
    if (roomEditing) renderEditor();
    requestAnimationFrame(fitSquawk);
    if (!roomEditing && !visiting) requestAnimationFrame(spinInPosters);
  }
  // A new poster arrives (2026-10-15): it spins in from off the wall and
  // slaps on, pinned, the first time you see it (once per poster, per device).
  function spinInPosters() {
    host.querySelectorAll('.room-obj.has-poster').forEach(node => {
      const it = items.find(i => i.id === node.dataset.item), e = it && flyerEvent(it);
      if (!e?.flyer_url) return;
      const key = `cs-poster-${e.id}-${e.flyer_url.split('v=')[1] || ''}`;
      try { if (localStorage.getItem(key)) return; localStorage.setItem(key, '1'); } catch (err) { return; }
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const turn = node.querySelector('.room-turn'), side = Math.random() < 0.5 ? -1 : 1;
      turn.animate([
        { transform: `translate(${side * 140}vw, -40vh) rotate(${side * 720}deg) scale(1.6)`, opacity: 0.4 },
        { transform: `rotate(${-side * 8}deg) scale(1.12)`, opacity: 1, offset: 0.7 },
        { transform: `rotate(${side * 4}deg) scale(0.96)`, offset: 0.82 },
        { transform: getComputedStyle(turn).transform === 'none' ? 'none' : getComputedStyle(turn).transform },
      ], { duration: 1300, easing: 'cubic-bezier(.2,.8,.3,1)' });
      setTimeout(() => { node.classList.add('poster-thunk'); setTimeout(() => node.classList.remove('poster-thunk'), 500); }, 1050);
    });
  }
  // Omen's speech bubble always stays inside the painting.
  function fitSquawk() {
    const b = host.querySelector('.room-squawk.said');
    if (!b) return;
    b.style.setProperty('--sx', '0px'); b.style.setProperty('--sy', '0px');
    const sr = scene.getBoundingClientRect(), r = b.getBoundingClientRect(), pad = 8;
    let dx = 0, dy = 0;
    if (r.right > sr.right - pad) dx = sr.right - pad - r.right;
    if (r.left + dx < sr.left + pad) dx = sr.left + pad - r.left;
    if (r.top < sr.top + pad) dy = sr.top + pad - r.top;
    b.style.setProperty('--sx', `${Math.round(dx)}px`); b.style.setProperty('--sy', `${Math.round(dy)}px`);
  }
  window.addEventListener('resize', () => { if (scene.isConnected) fitSquawk(); });
  // Squawk bubble, exit sign and trunk glow ride along with their items.
  function extras() {
    let out = '';
    // Huzzah notes visitors stuck on the mirror, newest on top.
    const mirror = items.find(i => i.role === 'mirror');
    if (mirror && notes.length) {
      const mh = mirror.h || mirror.w * 1.2;
      notes.slice(0, 6).forEach((n, k) => {
        const l = mirror.l + 1 + (k % 3) * (mirror.w / 3.1), t = mirror.t + 2 + Math.floor(k / 3) * (mh * 0.42);
        out += `<button class="room-note" data-note="${n.id}" style="left:${l}%;top:${t}%;--tilt:${((k * 47) % 11) - 5}deg" aria-label="Note from ${escapeHtml(n.display_name)}: ${escapeHtml(n.body)}"><b>${escapeHtml(n.display_name.split(' ')[0])}</b>${escapeHtml(n.body.length > 28 ? n.body.slice(0, 27) + '…' : n.body)}</button>`;
      });
    }
    // Wrapped surprises sit on the rug until they're opened.
    wrapped().forEach((g, k) => {
      out += `<button class="room-gift" data-gift="${g.id}" style="left:${26 + (k % 4) * 7.5}%;top:${88 - Math.floor(k / 4) * 7}%" aria-label="${visiting ? 'A wrapped surprise' : `A surprise from ${escapeHtml(giftFrom(g))}: open the hat box`}">${GIFT_BOX}</button>`;
    });
    const raven = items.find(i => i.role === 'raven'), trunk = items.find(i => i.role === 'trunk');
    const said = raven && squawk();
    if (said) out += `<div class="room-squawk said ${letters.unread ? 'letter' : ''}" style="left:${raven.l + raven.w * 0.55}%;top:${raven.t - 1.5}%" aria-hidden="true"><b>SQUAWK!</b> ${escapeHtml(said)}</div>`;
    // NEW! tags pinned to whatever has something waiting.
    items.filter(it => visible(it) && ['flyer', 'book'].includes(it.role) && fresh(it)).forEach(it => {
      out += `<div class="room-new" style="left:${it.role === 'book' ? it.l + it.w * 0.12 : it.l + it.w / 2}%;top:${it.t - 1.5}%" aria-hidden="true">NEW!</div>`;
    });
    if (newStamp && trunk) out += `<div class="room-trunk-glow" style="left:${trunk.l}%;top:${trunk.t - 3}%;width:${trunk.w}%;height:${trunk.w}%" aria-hidden="true"></div>`;
    return out;
  }

  // ── Playing: hover verb, one click opens ──
  const go = (el, it, href) => {
    if (href === 'more') { mobileNavOpen = true; renderShell(); return; }
    if (href === ORACLES.mercury) { openMercury(); return; }
    if (href === 'card') { showDailyCard(); return; }
    if (href.startsWith('http')) { window.open(href, '_blank', 'noopener'); return; }
    // Cozy pages unfold right out of the object you tapped.
    if (unfoldKindOf(href.slice(2))) { unfoldFrom = el.getBoundingClientRect(); location.hash = href; return; }
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
    raven: () => {
      const w = wrapped()[0], parcel = w && host.querySelector(`[data-gift="${w.id}"]`);
      if (parcel) unwrap(w, parcel);
      else if (!visiting && dailyCard) showDailyCard();
      else say('Croak. Nothing to squawk about right now. It’s keeping watch.');
    },
    megaphone: () => {
      const last = lastHoller();
      if (last) showBlast(last, { replay: true });
      else say('Quiet for now. When the Ringleader hollers, it rattles right here.');
    },
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
    const note = e.target.closest('[data-note]');
    if (note) { const n = notes.find(x => String(x.id) === note.dataset.note); if (n) say(`📝 “${n.body}” — ${n.display_name}`); return; }
    const parcel = e.target.closest('[data-gift]');
    if (parcel) { if (visiting) say(`Still wrapped. ${ownerName} hasn’t found it yet.`); else unwrap(gifts.find(g => g.id === parcel.dataset.gift), parcel); return; }
    if (visiting) { if (e.target.closest('[data-role="mirror"]')) leaveNote(); return; }
    const el = e.target.closest('[data-item]');
    if (!el) return;
    const it = items.find(i => i.id === el.dataset.item);
    if (it.role === 'decor' && giftOf(it)) { showGift(giftOf(it)); return; }
    if (it.role === 'trunk') { openTrunk(el, it); return; }
    const [, href] = behave(it);
    if (href) go(el, it, href); else quiet[it.role]?.(el);
  });

  // ── The trunk: badges fly out and display across the room. ──
  let trunkOpen = false;
  function openTrunk(trunkEl, trunkItem) {
    wantTrunk = false;
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
    const slots = [[16, 25], [33, 22], [50, 21], [67, 22], [84, 25], [24.5, 49], [41.5, 47], [58.5, 47], [75.5, 49]];
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
        <span class="td-patch has-art">${badgePatch(b ? k : 'mystery')}${won > 1 ? `<span class="td-count">×${won}</span>` : ''}</span>
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
      <div class="td-actions"><button class="room-plaque-btn" data-td="album">📷 The Troupe Album</button><button class="room-plaque-btn td-close" data-td="close">Put it all back</button></div>`;
    mainView.appendChild(plaque);
    layer.addEventListener('click', e => {
      const b = e.target.closest('.td-badge');
      if (b) tell(b.dataset.kind); else close();
    });
    plaque.addEventListener('click', e => {
      if (e.target.dataset.td === 'close') close();
      if (e.target.dataset.td === 'album') { close(); location.hash = '#/album'; }
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
      // Back to plain room, quietly, so the Badges link works again.
      if (/^#\/(badges|passport)$/.test(location.hash)) history.replaceState(null, '', '#/dressing-room');
    }
  }

  // ── The backer's gift (2026-10-14): after the Ringleader's welcome, the
  // Mercury Oracle deck drops onto the painted dresser (beside where the
  // popcorn starts out in this theme), once; after that it's theirs to move.
  const placeDeck = async () => {
    if (visiting || !room.backer || room.backer.deck || roomEditing) return;
    room.backer.deck = true;
    if (!saved.some(i => i.img === 'items/mercury_deck')) {
      const pop = defaultRoom(theme).find(i => i.role === 'popcorn') || { l: 81, t: 45, w: 4.5 };
      const w = 6.4, popBottom = pop.t + pop.w * 189 / 132, deckH = w * 352 / 520;
      const it = { id: 'mercury', role: 'potion', img: 'items/mercury_deck', l: +(pop.l - w - 1).toFixed(1), t: +(popBottom - deckH).toFixed(1), w, z: 7, anim: 'shimmer' };
      saved.push(JSON.parse(JSON.stringify(it)));
      items.push(it);
      await apiFetch('/api/me/room', { method: 'PUT', body: { theme: savedTheme, items: saved } }).catch(() => {});
      draw();
      const node = host.querySelector('[data-item="mercury"]');
      if (node && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        node.animate([{ transform: 'translateY(-60vh) rotate(-25deg)', opacity: 0 }, { transform: 'translateY(4%) rotate(4deg)', opacity: 1, offset: 0.75 }, { transform: 'none' }], { duration: 1300, easing: 'cubic-bezier(.3,.8,.4,1)' });
        node.classList.add('deck-new');
        setTimeout(() => node.classList.remove('deck-new'), 9000);
      }
      setTimeout(() => say('🔮 The Mercury Oracle is on your dresser. Tap it to draw a card.'), 1100);
    }
    apiFetch('/api/me/backer/deck', { method: 'POST' }).catch(() => {});
  };
  roomHooks.placeDeck = placeDeck;
  mountCats(scene, theme);
  mountCode(scene, theme);
  roomHooks.onCard = () => draw();
  if (room.backer?.welcomed && !room.backer.deck) setTimeout(placeDeck, 900);

  // ── The raven's tour (2026-10-12): first visit on a device, or "Take the
  // tour" in the menu. A spotlight walks the room; the raven explains.
  roomHooks.startIntro = () => {
    if (document.querySelector('.intro-tour') || roomEditing) return;
    // A holler (a backer's welcome, say) goes first; the tour waits its turn.
    if (blastShowing || (room.backer && !room.backer.deck)) { setTimeout(() => { if (scene.isConnected && !document.querySelector('.unfold')) roomHooks.startIntro(); }, 1500); return; }
    const first = (profile.display_name || '').split(' ')[0];
    const el = role => host.querySelector(`[data-role="${role}"]`);
    // Neeff gives the tour himself, holler-style (2026-10-14): his head pops
    // up over the room and yaks, King-of-the-Cosmos style. In `say`:
    // *bold*, | = a beat, {face} switches face mid-line (closed/open/happy/
    // wink/cosmic/sus = suspicious side-eye). `move` = how the head carries on.
    const chatEl = () => document.querySelector('body.chat-docked #chatPanel') || document.getElementById('chatLauncher');
    const forumEl = () => document.querySelector('#forumWing:not([hidden])') || document.querySelector('.topnav-link[href="#/courtyard"], .bottomtabs a[href="#/courtyard"]');
    // Act one happens in Neeff's office (his painting, Sunny & Daisy padding
    // about), laid over the room; then "GET OUT OF MY OFFICE!" and the
    // newcomer is in their own room, doing things for real.
    const office = document.createElement('div');
    office.className = 'tour-office';
    const sr = scene.getBoundingClientRect();
    Object.assign(office.style, { left: `${sr.left}px`, top: `${sr.top}px`, width: `${sr.width}px`, height: `${sr.height}px` });
    office.innerHTML = `<div class="room-scene to-scene"><img class="room-bg" src="${ROOM}rooms/office.jpg" alt="" draggable="false"><img class="to-trunk" src="${ROOM}trunk_closed.png" alt="" draggable="false"></div>`;
    document.body.appendChild(office);
    const oScene = office.querySelector('.to-scene'), trunk = office.querySelector('.to-trunk');
    mountCats(oScene, 'office');
    // The next carnival near them: their chapter, else their city, else the next one anywhere.
    const city = (profile.city || '').split(',')[0].trim().toLowerCase();
    const near = upcoming.find(e => profile.home_chapter_id && e.chapter_id === profile.home_chapter_id)
      || upcoming.find(e => city && `${e.location || ''} ${e.title || ''}`.toLowerCase().includes(city))
      || upcoming[0];
    const nearHere = near && (near.chapter_id === profile.home_chapter_id || (city && `${near.location || ''}`.toLowerCase().includes(city)));
    const nearCard = near ? `<div class="nt-flyer"><small>${new Date(sqlTime(near.starts_at)).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} · ${new Date(sqlTime(near.starts_at)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</small><b>${escapeHtml(near.title)}</b>${near.tagline ? `<em>${escapeHtml(near.tagline)}</em>` : ''}${near.location ? `<span>📍 ${escapeHtml(near.location)}</span>` : ''}<i class="nt-press">Find its flyer on your wall and press 🎟️ I’M COMING!</i></div>` : '';
    let badge = null;
    const popBadge = (img, from) => {
      const b = document.createElement('img');
      b.className = 'to-badge'; b.src = `${ROOM}${img}.png`; b.alt = '';
      oScene.appendChild(b);
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) b.animate([{ transform: from, opacity: 0 }, { transform: 'translate(-50%,-50%) scale(1.15) rotate(8deg)', opacity: 1, offset: 0.7 }, { transform: 'translate(-50%,-50%)', opacity: 1 }], { duration: 750, easing: 'cubic-bezier(.2,1.3,.4,1)' });
      return b;
    };
    const steps = [
      { office: true, move: 'spin', say: `{happy}OH! HELLO, ${first.toUpperCase()}! | Welcome to my *OFFICE.* | I'm *NEEFF.* | Creator of the Carnival Society. | Ringleader. | Cowboy. | Kind of a big deal.`, cta: 'Hi Neeff!' },
      { office: true, move: 'sus', say: `{sus}I've got my eye on you... | | | {wink}JK... | | {sus}*But seriously!*`, cta: 'Uh, okay!' },
      { office: true, move: 'zoom', say: `{shout}We are building *THE WORLD'S LARGEST REAL-LIFE CIRCUS AND CARNIVAL NETWORK!* | Real fire. | Real sawdust. | Real people.`, cta: 'Whoa' },
      { office: true, move: 'shake', say: `{open}I built this to organize our circus and carnival and keep track of EVERYONE. | | {sly}*NO BIG DEAL, JEEZ.*` },
      near ? { office: true, move: 'zoom', say: nearHere ? `{open}AND GUESS WHAT? | There's a *REAL CARNIVAL* coming up near you! | {wink}You should come.` : `{open}AND GUESS WHAT? | Our next *REAL CARNIVAL* is coming up! | {wink}You should come.`, html: nearCard, cta: 'Ooh!' } : null,
      { office: true, sel: forumEl, move: 'lean', say: `{open}And the *FORUM!* | This is how we stay organized. | News! Plans! Calls for helping hands! | {sus}Very official. | Very important.` },
      { office: true, sel: () => document.querySelector('.topnav-link[href="#/events"], .bottomtabs a[href="#/events"]'), move: 'boing', say: `{happy}*UPCOMING EVENTS* live up here! | Every one is a real carnival. | Take a job on the crew and come make it happen!` },
      { office: true, move: 'cosmic', say: `{cosmic}Technically... | this is a *GUILD NETWORK.* | Ancient. | Mysterious. | {happy}Don't worry about that now! | You've joined at the entry level of our little club.` },
      { office: true, move: 'boing', say: `{open}Every time you take part in one of our carnivals, you earn *BADGES* and move up the *CARNIVAL RANKS.* | These have *real-life consequences,* | and eventually get you *a real seat at the table.*`, html: `<ol class="intro-ranks"><li><b>Clown</b>: where everyone starts. Honk!</li><li><b>Apprentice</b>: 3 badges, including 2 volunteer shifts.</li><li><b>Journeyman</b>: 10 badges, crews led, and a nod from a Master.</li><li><b>Master</b>: never counted, only conferred.</li></ol>` },
      { office: true, side: 'right', move: 'lean', say: `{happy}Check out all my *COOL BADGES!*`, cta: 'Ooh, show me',
        afterType: () => { trunk.src = `${ROOM}trunk_open.png`; trunk.classList.add('open'); badge = popBadge('badge_fart', 'translate(-200%, 120%) scale(0.2) rotate(-60deg)'); } },
      { office: true, side: 'right', move: 'shake', say: `{gasp}WHOOPS! | {shout}*NOT THAT ONE!*`, cta: '...',
        onShow: () => { if (!badge) return; const b = badge; b.animate([{ transform: 'translate(-50%,-50%)' }, { transform: 'translate(250%, -180%) rotate(540deg) scale(0.3)', opacity: 0 }], { duration: 650, easing: 'cubic-bezier(.5,0,.8,.4)', fill: 'forwards' }); setTimeout(() => b.remove(), 700); badge = null; },
        afterType: () => { badge = popBadge('badge_handsome', 'translate(-200%, 120%) scale(0.2) rotate(-60deg)'); badge.classList.add('shiny'); } },
      { office: true, side: 'right', move: 'boing', say: `{proud}There we go. | *WORLD'S MOST HANDSOME RINGLEADER.* | {sly}Nailed it.` },
      { office: true, move: 'shake', say: `{open}Now... | | {shout}*GET OUT OF MY OFFICE!* | {happy}You've got your own spot.`, cta: 'Bye!',
        leave: () => { badge?.remove(); office.classList.add('leaving'); setTimeout(() => office.remove(), 750); } },
      // Act two: their own room, for real.
      { move: 'spin', say: `{happy}And *THIS* is *YOUR Dressing Room!* | Anything that glows, you can poke.` },
      { sel: () => document.getElementById('roomArrange'), wait: 'cs-room-saved', move: 'lean', say: `{open}Make it yours! | Tap *Arrange,* move something around, then tap *Done.*` },
      { move: 'boing', say: `{happy}LOOKS FABULOUS. | {wink}Very you.`, skipIfLater: true },
      el('flyer') ? { role: 'flyer', move: 'lean', say: `{open}Every flyer on your wall is a *REAL CARNIVAL.* | Tap one, then hit the big *I'M COMING!* button. | {wink}That's how you save your spot.` } : null,
      { sel: chatEl, wait: 'cs-chat-sent', required: true, move: 'lean', say: `{open}One last thing: the *GREEN ROOM!* | A real live chat room full of real live carnies. | *Introduce yourself!* | Where you're from, what you're into. | {sly}I'll know if you don't.`,
        onShow2: () => { if (!document.body.classList.contains('chat-docked') && typeof chat !== 'undefined') { chat.open = true; mountChat(); } const inp = document.getElementById('chatInput'); if (inp && !inp.value) inp.value = `Hi! I'm ${profile.display_name.split(' ')[0]}${profile.city ? ` from ${profile.city}` : ''}. `; } },
      { move: 'boing', say: `{proud}They're gonna *LOVE* you.` },
      el('raven') ? { role: 'raven', move: 'lean', say: `{open}Oh! And this is *OMEN*, my raven. | Every day he pulls a card just for you from my *ORACLE.* | He also delivers the news. | {shout}If he squawks at ya, *TALK TO HIM, DANGIT.*` } : null,
      (() => {
        // Not a question: put me on your home screen (or desktop), how depends on the device.
        const env = ravenEnv(), ios = env.ios && !env.standalone;
        const why = `<p class="nt-how-why">If you want to join us <b>for real</b>, add me so you don't miss a real-life meeting!</p>`;
        const how = env.standalone ? `<p class="nt-how">If you want to join us <b>for real</b>, let me buzz you so you don't miss a real-life meeting!</p>`
          : ios ? `${why}<ol class="nt-how"><li>Tap <b>Share</b> ⬆︎ at the bottom of Safari</li><li>Choose <b>Add to Home Screen</b></li><li>Open Carnival Society from there</li></ol>`
          : deferredInstall ? `<p class="nt-how">If you want to join us <b>for real</b>, tap the button so you don't miss a real-life meeting!</p>`
          : `${why}<p class="nt-how">On a computer: click the little <b>install</b> icon at the right end of the address bar, or the browser menu → <b>Install</b> / <b>Add to Home screen</b>.</p>`;
        return { move: 'boing', say: `{wink}THAT'S THE TOUR! | {shout}Now put me on your *HOME SCREEN!* | {happy}Your phone, your desktop, wherever. | That way I can buzz you for jobs, letters and hollers.`, html: how, cta: env.standalone ? '🎪 Join us for real!' : ios ? '🎪 Join us for real: show me how' : deferredInstall ? '🎪 Join us for real!' : '🎪 Got it, join for real!', last: true,
          // Straight to the browser's own prompts (install, then notifications):
          // no second raven card after the tour. iPhone: the steps are in the bubble.
          finish: async () => {
            if (ios) return;
            if (deferredInstall && !env.standalone) { try { deferredInstall.prompt(); await deferredInstall.userChoice; } catch (e) { /* dismissed */ } deferredInstall = null; }
            try { if (env.supported) await followRaven(); } catch (e) { /* they said no */ }
          } };
      })(),
    ].filter(st => st && (!st.role || el(st.role)) && (!st.sel || st.sel()));
    runNeeffTour(steps, { el, host, onDone: () => { office.remove(); try { localStorage.setItem('cs-intro-' + profile.id, '1'); } catch (e) { /* ignore */ } } });
  };
  roomHooks.openTrunk = () => {
    const el = host.querySelector('[data-role="trunk"]'), it = items.find(i => i.role === 'trunk');
    if (el && it) openTrunk(el, it);
  };
  // Unwrapping: the parcel bursts, the thing lands in the room for good.
  let unwrapping = false;
  async function unwrap(g, parcel) {
    if (!g || unwrapping || roomEditing) return;
    unwrapping = true;
    // The lid pops: the open hat box spills its feathers, then the gift card.
    const box = parcel.querySelector('img');
    if (box) box.src = `${ROOM}hatbox_open.png`;
    parcel.classList.add('opening');
    try {
      const r = await apiFetch(`/api/gifts/${g.id}/open`, { method: 'POST' });
      // Each new gift lands beside the last one, along the front of the rug.
      const placed = saved.filter(i => i.gift).length;
      Object.assign(g, r.gift);
      room.unlocked = r.unlocked;
      const it = { id: 'g' + g.id.slice(0, 7), role: ITEM_ROLES[g.img] || 'decor', img: g.img, l: 20 + (placed % 6) * 7, t: 80 - Math.floor(placed / 6) * 6, w: 8, z: 6, gift: g.id };
      saved.push(JSON.parse(JSON.stringify(it)));
      items.push(it);
      await apiFetch('/api/me/room', { method: 'PUT', body: { theme: savedTheme, items: saved } }).catch(() => {});
      setTimeout(() => { draw(); showGift(g, { fresh: true }); }, 1100);
    } catch (err) { parcel.classList.remove('opening'); say(err.message); }
    unwrapping = false;
  }
  if (visiting && profile.is_ringleader && ownerId !== profile.id) {
    const plaque = mainView.querySelector('.room-visit-plaque');
    const b = document.createElement('button');
    b.className = 'room-plaque-btn'; b.textContent = '🎁 Leave a surprise';
    b.addEventListener('click', () => openSurprise(ownerId, ownerName, wrapped(), () => { roomStage = null; render(); }));
    plaque.insertBefore(b, plaque.querySelector('a'));
  }
  function leaveNote() {
    openForumNote({
      heading: `A note for ${ownerName}’s mirror`, withTitle: false, cta: 'Stick it on the mirror', placeholder: 'Huzzah! Great working with you…',
      onSubmit: async ({ body }) => {
        await apiFetch(`/api/rooms/${ownerId}/notes`, { method: 'POST', body: { body } });
        flashToast(`📝 Stuck to ${ownerName}’s mirror. The raven will tell them.`);
        roomStage = null; render();
      },
    });
  }
  document.getElementById('roomLeaveNote')?.addEventListener('click', leaveNote);

  // ✦ reveal: one short label per kind of thing, for a few seconds.
  const labels = document.getElementById('roomLabels');
  document.getElementById('roomReveal').addEventListener('click', () => {
    const sr = scene.getBoundingClientRect();
    const SHORT = { mirror: 'Mirror', drawer: 'Drawer', stars: 'Stars', exit: 'Courtyard', costume: 'Costumes', flyer: 'Flyers', potion: 'Bottle', popcorn: 'Popcorn', book: 'Big Book', raven: 'Omen', trunk: 'Trunk', hatbox: 'Hat Box', events: 'Events', tickets: 'Tickets' };
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
    const unlocked = new Set(room.unlocked || []), specials = room.specials || {};
    const thumb = (img, label) => {
      const locked = specials[img] && !unlocked.has(img);
      return `<button class="re-thumb ${locked ? 'locked' : ''}" ${locked ? 'disabled' : `data-add="${img}"`} title="${escapeHtml(locked ? `🔒 ${specials[img].how}` : label)}"><img src="${ROOM}${img}.png" alt="" loading="lazy">${locked ? '<span class="re-lock">🔒</span>' : ''}</button>`;
    };
    const drawer = Object.entries(ROOM_ITEMS).map(([cat, list]) => `<div class="re-cat"><b>${cat}</b><div class="re-grid">${list.map(n => thumb(`items/${n}`, n.replace(/_/g, ' '))).join('')}</div></div>`).join('')
      + (profile.is_ringleader ? `<div class="re-cat"><b>Sunny &amp; Daisy</b><div class="re-grid">${ROOM_CATS.map(n => thumb(`cats/${n}`, n.replace(/_/g, ' '))).join('')}</div></div>` : '')
      + `<div class="re-cat"><b>Room stickers</b><div class="re-grid">${Object.keys(ROOM_ASSETS).filter(n => n !== 'megaphone_floor').map(n => thumb(n, n.replace(/_/g, ' '))).join('')}<button class="re-thumb re-hot" data-add="__hot" title="Invisible hotspot (for painted things)">⬚</button></div></div>`;
    editor.innerHTML = `
      <div class="re-row re-title"><strong>Arrange your room</strong><span class="re-hint">Drag to move · gold corner to resize</span></div>
      <div class="re-row"><label class="re-wide">Your room<select id="reTheme">${Object.entries(ROOM_THEMES).filter(([k]) => profile.is_ringleader || !RINGLEADER_THEMES.includes(k) || k === theme).map(([k, v]) => `<option value="${k}" ${k === theme ? 'selected' : ''}>${v}</option>`).join('')}</select></label></div>
      ${it ? `
        <div class="re-row"><label>It does<select data-f="role">${opt(ROOM_ROLES, it.role)}</select></label></div>
        ${it.role === 'flyer' ? `<div class="re-row"><label>Which event<select data-f="n">${[0, 1, 2, 3, 4, 5].map(n => `<option value="${n}" ${n === (it.n || 0) ? 'selected' : ''}>${['Next', '2nd', '3rd', '4th', '5th', '6th'][n]} upcoming</option>`).join('')}</select></label></div>` : ''}
        ${it.img ? `<div class="re-row"><label>Moves<select data-f="anim">${opt(ROOM_ANIMS, it.anim)}</select></label>
          ${ROOM_ASSETS[it.img] ? `<label>Art<select data-f="img">${Object.keys(ROOM_ASSETS).filter(k => k !== 'megaphone_floor').map(k => `<option ${k === it.img ? 'selected' : ''}>${k}</option>`).join('')}</select></label>` : ''}</div>` : ''}
        <div class="re-row"><label class="re-wide">Rotate <input type="range" min="-45" max="45" step="1" value="${it.rot || 0}" data-f="rot"></label></div>
        <div class="re-row re-btns">
          ${it.img ? '<button data-a="flip">Flip</button>' : ''}
          <button data-a="back">Send back</button><button data-a="front">Bring forward</button>
          <button data-a="dup">Duplicate</button><button data-a="del" class="re-danger">Delete</button>
        </div>` : '<div class="re-row re-hint">Tap something in the room to select it.</div>'}
      <details class="re-drawer" ${it ? '' : 'open'}><summary>+ Add a thing</summary>${drawer}<p class="re-hint">🔒 Specials are won at real carnivals. Hover one to see how.</p></details>
      <div class="re-row re-btns re-save">
        <button data-a="save" class="re-primary">✓ Done</button><button data-a="cancel">Undo my changes</button><button data-a="reset">Start over</button>
      </div>`;
  }
  editor.addEventListener('input', e => {
    const it = sel(); const f = e.target.dataset.f;
    if (!it || !f) return;
    if (f === 'rot') { it.rot = +e.target.value; const n = host.querySelector(`[data-item="${it.id}"] .room-turn`); if (n) n.style.transform = `rotate(${it.rot}deg) scaleX(${it.flip ? -1 : 1})`; }
  });
  editor.addEventListener('change', e => {
    if (e.target.id === 'reTheme') {
      theme = e.target.value;
      document.getElementById('roomBg').src = themeSrc(theme);
      mountCats(scene, theme);
      mountCode(scene, theme);
      say(`${ROOM_THEMES[theme]}. Tap Done to keep it.`);
      return;
    }
    const it = sel(); const f = e.target.dataset.f;
    if (!it || !f || f === 'rot') return;
    it[f] = f === 'n' ? +e.target.value : e.target.value;
    draw();
  });
  editor.addEventListener('click', async e => {
    const add = e.target.closest('[data-add]');
    if (add) {
      const art = add.dataset.add, id = 'x' + Math.random().toString(36).slice(2, 8);
      // Drop it somewhere near the middle of the floor, not on top of the last one.
      const l = 30 + Math.random() * 30, t = 45 + Math.random() * 25;
      items.push(art === '__hot' ? { id, role: 'decor', img: null, l, t, w: 14, h: 14 } : { id, role: ITEM_ROLES[art] || 'decor', img: art, l, t, w: 12, z: 5 });
      selectedId = id; draw(); return;
    }
    const a = e.target.dataset.a; if (!a) return;
    const it = sel();
    if (a === 'flip' && it) { it.flip = !it.flip; draw(); }
    if (a === 'front' && it) { it.z = Math.max(...items.map(i => i.z || 0)) + 1; draw(); }
    if (a === 'back' && it) { it.z = Math.min(...items.map(i => i.z || 0)) - 1; draw(); }
    if (a === 'dup' && it) { const c = { ...it, id: 'x' + Math.random().toString(36).slice(2, 8), l: it.l + 2, t: it.t + 2 }; items.push(c); selectedId = c.id; draw(); }
    if (a === 'del' && it) { items = items.filter(i => i !== it); selectedId = null; draw(); }
    if (a === 'cancel') { exitEditing(); }
    if (a === 'reset') {
      if (!confirm('Start this room over with the starter arrangement?')) return;
      items = defaultRoom(theme);
      selectedId = null; draw(); say('Fresh start. Tap Done to keep it.');
    }
    if (a === 'save') await saveAndExit();
  });
  // Closing Arrange keeps what you did (2026-10-15): no separate Save step.
  async function saveAndExit() {
    const changed = theme !== savedTheme || JSON.stringify(items) !== JSON.stringify(saved);
    if (!changed) { exitEditing(true); window.dispatchEvent(new Event('cs-room-saved')); return; }
    try {
      await apiFetch('/api/me/room', { method: 'PUT', body: { theme, items } });
      window.dispatchEvent(new Event('cs-room-saved')); // the tour waits for this
      saved.splice(0, saved.length, ...JSON.parse(JSON.stringify(items)));
      savedTheme = theme;
      exitEditing(true); say('Saved! Visitors see your room like this now.');
    } catch (err) { say(`Couldn't save: ${err.message}`); }
  }
  function exitEditing(keep) {
    roomEditing = false; selectedId = null;
    document.body.classList.remove('arranging');
    if (!keep) { items = JSON.parse(JSON.stringify(saved)); if (theme !== savedTheme) { theme = savedTheme; document.getElementById('roomBg').src = themeSrc(theme); } }
    editor.hidden = true; document.getElementById('roomArrange').textContent = '✎ Arrange';
    draw();
  }
  document.getElementById('roomArrange')?.addEventListener('click', e => {
    if (roomEditing) { saveAndExit(); return; }
    roomEditing = true; editor.hidden = false; e.currentTarget.textContent = '✓ Done arranging';
    // On wide screens the Guild Hall slides out and the Arrange panel takes its wing.
    document.body.classList.add('arranging');
    say('Arrange mode: drag things around. Tap Done when you’re happy; it saves itself.');
    draw();
  });

  let lettersSeen = letters.unread;
  roomHooks.onNews = () => { if (!roomEditing && !trunkOpen) draw(); };
  roomHooks.onLetters = () => {
    if (roomEditing) return;
    if (letters.unread > lettersSeen && letters.from[0]) say(`SQUAWK! A letter from ${letters.from[0].display_name}!`);
    lettersSeen = letters.unread;
    draw();
  };
  draw();
  const newFlyer = items.find(it => it.role === 'flyer' && fresh(it));
  if (letters.unread && letters.from[0]) say(`SQUAWK! ${letters.unread === 1 ? 'A letter' : `${letters.unread} letters`} waiting — the raven has them.`);
  else if (newFlyer) say(`SQUAWK! A new flyer went up: ${flyerEvent(newFlyer).title}`);
  let introDone = true;
  try { introDone = !!localStorage.getItem('cs-intro-' + profile.id); } catch (e) { /* no storage: skip it */ }
  if (!introDone && !wantTrunk) setTimeout(() => { if (scene.isConnected && !document.querySelector('.unfold')) roomHooks.startIntro(); }, 900);
  else offerRaven();
  // Phones: the square room is wider than the screen. Start centered, or
  // turned toward the raven when it has something to squawk about.
  const vp = document.getElementById('roomViewport');
  requestAnimationFrame(() => {
    const max = vp.scrollWidth - vp.clientWidth;
    if (max <= 0) return;
    vp.scrollLeft = request || letters.unread ? max : max / 2;
    if (!wantTrunk && !letters.unread && !newFlyer && introDone) say('⟷ Swipe to look around · tap ✦ to see what you can touch');
  });
  // Arrived via Badges: let the room settle, then spill the trunk.
  if (wantTrunk) setTimeout(() => roomHooks.openTrunk?.(), 350);
}

// A one-time (per device) invitation in the room for the raven to follow you.
// ── The raven invite (2026-10-12): "Get live updates & notifications".
// Asked at moments where the benefit is obvious (you just took a job or
// volunteered), or in the room from your second visit. Our own card goes
// first; the phone's yes/no only appears after a "yes" here. "Not now"
// waits 5 days, and we stop asking after 3 no's.
const INVITE_KEY = 'cs-raven-invite';
function inviteState() { try { return JSON.parse(localStorage.getItem(INVITE_KEY) || '{}'); } catch (e) { return null; } }
function saveInvite(st) { try { localStorage.setItem(INVITE_KEY, JSON.stringify(st)); } catch (e) { /* no storage */ } }
async function inviteRaven(moment = 'visit', what = '') {
  const st = inviteState();
  if (!st || document.querySelector('.raven-offer')) return;
  const asked = moment === 'menu'; // they asked for it: skip the snooze
  if (!asked && ((st.no || 0) >= 3 || Date.now() < (st.until || 0))) return;
  const env = ravenEnv();
  if (!env.supported && !env.ios) return;
  if (await ravenSubscribed()) return;
  if (moment === 'visit') {
    st.visits = (st.visits || 0) + 1; saveInvite(st);
    if (st.visits < 2) return; // let them look around first
  }
  const iosInstall = env.ios && !env.standalone;
  const name = what.length > 28 ? what.slice(0, 27).trimEnd() + '…' : what;
  const head = moment === 'job' ? `Want a heads-up before ${escapeHtml(name)}?`
    : moment === 'volunteer' ? `Want a reminder before ${escapeHtml(name)}?`
    : 'Get live updates &amp; notifications';
  const line = moment === 'visit'
    ? 'Job reminders, letters and hollers, straight to your phone. No app store needed.'
    : 'Get live updates &amp; notifications: the raven pings you the day before, plus letters and hollers.';
  const card = document.createElement('div');
  card.className = 'raven-offer';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Get live updates and notifications');
  card.innerHTML = `
    <img src="${ROOM}raven_squawk.png" alt="" class="raven-offer-bird">
    <div class="raven-offer-text"><strong>${head}</strong><span>${line}${iosInstall ? ' On iPhone it takes one quick step: add us to your Home Screen.' : ''}</span></div>
    <div class="raven-offer-btns">
      <button class="room-plaque-btn" data-yes>${iosInstall ? 'Yes, show me how' : 'Yes, notify me'}</button>
      <button class="raven-offer-no" data-no>Not now</button>
    </div>`;
  document.body.appendChild(card);
  const close = () => card.remove();
  card.querySelector('[data-no]').onclick = () => {
    const s2 = inviteState() || {};
    s2.no = (s2.no || 0) + 1; s2.until = Date.now() + 5 * 864e5; saveInvite(s2); close();
  };
  card.querySelector('[data-yes]').onclick = async () => {
    // Android/desktop Chrome: offer the real install too, then ask to notify.
    if (deferredInstall && !env.standalone) { try { deferredInstall.prompt(); await deferredInstall.userChoice; } catch (e) { /* dismissed */ } deferredInstall = null; }
    const r = await followRaven();
    if (r === 'ios-install') { close(); showIosInstall(); return; }
    close();
    if (r === 'on') saveInvite({ ...(inviteState() || {}), done: 1 });
    flashToast(RAVEN_RESULT[r] || RAVEN_RESULT.error, 5000);
  };
}
function offerRaven() { setTimeout(() => inviteRaven('visit'), 2500); }

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
        <div class="admin-edit-modal-header"><h3>${escapeHtml(p.user.display_name)}'s Badges</h3><button data-close>&times;</button></div>
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
    flashToast(err.message);
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
        <button type="submit" class="composer-submit">Add tier</button>
      </form>
    </details>` : '';

  // The add-a-tier form lives in the card's Ringleader fold when there is one.
  const rl = document.getElementById('rlTickets-' + eventId);
  if (rl) rl.innerHTML = manage;
  const box = `${tierRows}${joinCta}${rl ? '' : manage}`;
  el.innerHTML = box.trim() ? `<div class="ticket-box">${box}</div>` : '';

  el.querySelectorAll('[data-buy-tier]').forEach(btn => btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const res = await apiFetch(`/api/events/${eventId}/tickets`, { method: 'POST', body: { tier_id: btn.dataset.buyTier } });
      if (res.url) window.location.href = res.url; else location.hash = '#/tickets';
    } catch (err) { btn.disabled = false; flashToast(err.message); }
  }));
  const join = el.querySelector('[data-join]');
  if (join) join.addEventListener('click', () => startMembershipCheckout(join));
  const form = (rl || el).querySelector('.ticket-tier-form');
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
  const { tickets, passes = [] } = await apiFetch('/api/me/tickets');
  const joinCta = !isInnerMember() ? courtyardPathCta("You're in the courtyard. Tickets are for inner members.") : '';
  const list = tickets.length ? tickets.map(t => `
    <div class="post-card" style="cursor:default;">
      <div class="post-title">${escapeHtml(t.title)}</div>
      <div class="post-meta">${formatEventDate(t.starts_at)}${t.location ? ' · ' + escapeHtml(t.location) : ''} · ${escapeHtml(t.tier_name)}</div>
      <div class="ticket-qr">${qrSvg(t.code)}</div>
      <div class="post-meta">${t.checked_in_at ? 'Checked in' : t.status === 'reserved' ? 'Spot saved: pay at the door, then show this code' : 'Show this code at the door'} · <code>${escapeHtml(t.code)}</code></div>
    </div>`).join('') : passes.length ? '' : '<div class="placeholder-note">No tickets yet.</div>';
  const guest = passes.map(g => `
    <div class="post-card" style="cursor:default;">
      <div class="post-title">🎟️ Admit One: a guest pass</div>
      <div class="post-meta">From ${escapeHtml(giftFrom(g))} · good ${g.event_title ? 'at ' + escapeHtml(g.event_title) : 'at any carnival'}${g.note ? ` · “${escapeHtml(g.note)}”` : ''}</div>
      ${g.redeemed_at ? `<div class="post-meta">Punched${g.redeemed_title ? ' at ' + escapeHtml(g.redeemed_title) : ''}. Your guest came!</div>` : `<div class="ticket-qr">${qrSvg(g.code)}</div><div class="post-meta">Show this at the door for your guest · <code>${escapeHtml(g.code)}</code></div>`}
    </div>`).join('');
  mainView.innerHTML = `<h2>My Tickets</h2>${joinCta}<div class="post-list">${guest}${list}</div>`;
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

// ── The door (2026-10-14) ─────────────────────────────────────────────
// One screen for the night: Scan (tickets, guest passes), Find (members by
// name), New face (makes their account; they claim it from a QR). Every
// entry is logged with how they got in and what they paid, cash or card
// (the Square register). Run by Ringleaders, or whoever took the Door job.
const doorMoney = c => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
const DOOR_VIA = { ticket: '🎟️ Ticket', pass: '🎁 Guest pass', door: '💵 Paid at door', comp: '🌟 Comp', crew: '🔨 Crew', performer: '🎭 Performer' };
async function renderCheckinView(mainView, eventId) {
  if (!eventId) {
    if (!profile?.is_ringleader) { mainView.innerHTML = '<h2>The Door</h2><div class="placeholder-note">Take the Door job on an event’s flyer to run its door.</div>'; return; }
    const { events } = await apiFetch('/api/events');
    mainView.innerHTML = `<h2>The Door</h2><div class="post-list">${events.map(e => `<a class="post-card" href="#/checkin/${e.id}"><div class="post-title">${escapeHtml(e.title)}</div><div class="post-meta">${formatEventDate(e.starts_at)}</div></a>`).join('') || '<div class="placeholder-note">No upcoming events.</div>'}</div>`;
    return;
  }
  let d;
  try { d = await apiFetch(`/api/events/${eventId}/door`); }
  catch (err) { mainView.innerHTML = `<h2>The Door</h2><div class="placeholder-note">${escapeHtml(err.message)} The door opens to its crew on the night.</div>`; return; }
  const ev = d.event;
  let lane = 'scan';
  mainView.innerHTML = `
    <div class="door">
      <div class="door-head">
        <div><div class="door-kicker">🚪 The Door</div><h2>${escapeHtml(ev.title)}</h2></div>
        ${d.ringleader ? `<div class="door-head-btns"><button class="action-btn" data-door-settings>⚙ Door settings</button><a class="action-btn" href="#/door-report/${eventId}">The night’s report</a></div>` : ''}
      </div>
      <div class="door-count" id="doorCount" aria-live="polite"></div>
      <form class="door-settings" id="doorSettings" hidden>
        <label>Entry $ <input type="number" name="price" min="0" step="1" inputmode="decimal" value="${ev.door_cents != null ? ev.door_cents / 100 : ''}" placeholder="15"></label>
        <label>Carnival tickets with entry <input type="number" name="give" min="0" max="100" inputmode="numeric" value="${ev.entry_tickets ?? ''}" placeholder="5"></label>
        <label>Extra tickets, $ each <input type="number" name="each" min="0" step="0.25" inputmode="decimal" value="${ev.ticket_cents != null ? ev.ticket_cents / 100 : ''}" placeholder="1"></label>
        <label>How many fit <input type="number" name="capacity" min="0" inputmode="numeric" value="${ev.capacity ?? ''}" placeholder="No limit"></label>
        ${d.partners?.length ? `<label>Presented with <select name="partner"><option value="">Just us</option>${d.partners.map(p => `<option value="${p.id}" ${p.id === ev.partner_id ? 'selected' : ''}>${escapeHtml(p.display_name)}</option>`).join('')}</select></label>` : ''}
        <label class="ds-wide">Headline <input name="tagline" value="${escapeHtml(ev.tagline || '')}" placeholder="Halloween Carnival" maxlength="60" autocomplete="off"></label>
        <label class="ds-wide">What’s inside <input name="lineup" value="${escapeHtml(ev.lineup || '')}" placeholder="Burlesque, FreakShow, Games, Contests" autocomplete="off"></label>
        <label class="ds-wide">Public link: ${location.origin}/t/<input name="slug" value="${escapeHtml(ev.slug || '')}" placeholder="kooks" autocomplete="off" autocapitalize="off"></label>
        <button class="composer-submit" type="submit">Save</button>
        <button class="action-btn" type="button" data-testpay>💳 Test a 50¢ payment</button>
        <div class="ds-link" id="doorLink"></div>
      </form>
      <div class="door-lanes" role="tablist">
        <button role="tab" data-lane="scan" aria-selected="true">📷 Scan</button>
        <button role="tab" data-lane="find" aria-selected="false">🔎 Find a member</button>
        <button role="tab" data-lane="new" aria-selected="false">✨ New face</button>
        <button role="tab" data-lane="sell" aria-selected="false">🎟️ Sell tickets</button>
      </div>
      <div class="door-lane" data-for="scan">
        <div class="door-cam"><video id="scanVideo" playsinline muted hidden></video><canvas id="scanCanvas" hidden></canvas><p class="door-cam-hint" id="camHint">Starting the camera…</p></div>
        <form id="checkinForm" class="door-code"><input type="text" id="checkinCode" placeholder="…or type the ticket code" autocomplete="off" autocapitalize="off"><button type="submit" class="composer-submit">Check</button></form>
      </div>
      <div class="door-lane" data-for="find" hidden>
        <input type="search" id="doorSearch" class="door-input" placeholder="Their name" autocomplete="off">
        <div id="doorResults" class="door-results"></div>
      </div>
      <form class="door-lane door-new" data-for="new" id="doorNew" hidden>
        <input class="door-input" name="name" placeholder="Name (what they go by)" required maxlength="60" autocomplete="off">
        <input class="door-input" name="email" type="email" placeholder="Email (optional)" autocomplete="off" inputmode="email">
        <input class="door-input" name="phone" type="tel" placeholder="Phone (optional)" autocomplete="off">
        <input class="door-input" name="city" placeholder="City (optional)" autocomplete="off">
        <input class="door-input" name="heard" placeholder="How’d they hear about us? (optional)" autocomplete="off">
        <button class="composer-submit" type="submit">Next: how they’re getting in →</button>
      </form>
      <form class="door-lane door-sell" data-for="sell" id="doorSell" hidden>
        <div class="ds-qty"><button type="button" data-q="-1" aria-label="One fewer">−</button><input name="qty" type="number" min="1" max="500" value="5" inputmode="numeric" aria-label="How many tickets"><button type="button" data-q="1" aria-label="One more">+</button></div>
        <div class="ds-quick">${[5, 10, 20].map(n => `<button type="button" data-set="${n}">${n}</button>`).join('')}</div>
        <div class="ds-total" id="sellTotal"></div>
        <div class="da-seg"><button type="submit" data-m="cash">💵 Cash</button><button type="submit" data-m="card">💳 Card (Square)</button></div>
        <div class="door-recent" id="doorSales"></div>
      </form>
      <div class="door-result" id="doorResult" aria-live="assertive"></div>
      <h3 class="door-recent-h">Just came in</h3>
      <div class="door-recent" id="doorRecent"></div>
    </div>`;
  const $ = s => mainView.querySelector(s);
  const result = $('#doorResult');

  function drawCount(t) {
    const cap = ev.capacity;
    const pct = cap ? Math.min(100, Math.round((t.inside / cap) * 100)) : 0;
    $('#doorCount').innerHTML = `
      <div class="dc-big"><b>${t.inside}</b><span>inside${cap ? ` of ${cap}` : ''}</span></div>
      ${cap ? `<div class="dc-bar ${pct >= 90 ? 'full' : ''}"><i style="width:${pct}%"></i></div>` : ''}
      <div class="dc-row"><span>✨ ${t.first_time} first-timer${t.first_time === 1 ? '' : 's'}</span><span>💵 ${doorMoney(t.cash)} cash</span><span>💳 ${doorMoney(t.card)} card</span><span>🎟️ ${t.tickets_given + t.tickets_sold} carnival tickets out</span></div>`;
  }
  function drawRecent(entries) {
    $('#doorRecent').innerHTML = entries.length ? entries.map(e => `
      <div class="door-entry ${e.voided_at ? 'voided' : ''}">
        <div><b>${escapeHtml(e.name)}</b>${e.first_time ? ' <span class="door-first">first time!</span>' : ''}
          <div class="post-meta">${DOOR_VIA[e.via] || e.via}${e.amount_cents ? ` · ${doorMoney(e.amount_cents)} ${e.method || ''}${e.registration_cents ? ' (incl. $5 registration)' : ''}` : ''} · ${new Date(sqlTime(e.created_at)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${e.by_name ? ` · by ${escapeHtml(e.by_name.split(' ')[0])}` : ''}${e.note ? ` · ${escapeHtml(e.note)}` : ''}</div></div>
        ${e.voided_at ? '<span class="post-meta">undone</span>' : `<button class="raven-offer-no" data-undo="${e.id}">Undo</button>`}
      </div>`).join('') : '<div class="placeholder-note">Nobody yet. Doors open soon!</div>';
  }
  async function refresh() {
    try { d = await apiFetch(`/api/events/${eventId}/door`); drawCount(d.totals); drawRecent(d.entries); drawSales(d.sales || []); } catch (e) { /* keep what's on screen */ }
  }
  // The public link, with a QR to print on the flyer.
  function drawLink() {
    const el = $('#doorLink');
    el.innerHTML = d.link ? `<div class="ticket-qr">${qrSvg(d.link)}</div><div><b>Anyone can get in here:</b><br><a href="${d.link}" target="_blank" rel="noopener">${escapeHtml(d.link)}</a><br><span class="post-meta">Print the QR on flyers, or share the link.</span></div>` : '';
  }
  drawLink();
  drawCount(d.totals); drawRecent(d.entries); drawSales(d.sales || []);
  const poll = setInterval(() => { if (!document.body.contains(mainView.querySelector('.door'))) clearInterval(poll); else refresh(); }, 15000);

  const flash = (ok, html) => {
    result.className = `door-result show ${ok === true || ok === 'keep' ? 'ok' : ok === false ? 'warn' : 'bad'}`;
    result.innerHTML = html;
    if (ok !== 'keep') clearTimeout(flash.t), flash.t = setTimeout(() => { if (!result.querySelector('.door-claim')) result.classList.remove('show'); }, 6000);
    try { navigator.vibrate?.(ok === true ? 60 : [80, 60, 80]); } catch (e) { /* no buzz */ }
  };
  const said = r => r.ok
    ? `<b>✓ ${escapeHtml(r.display_name)}</b>${r.guests ? ` <b>+ ${r.guests} guest${r.guests > 1 ? 's' : ''}</b>` : ''}${r.tier_name ? ` · ${escapeHtml(r.tier_name)}` : ''}${r.first_time ? ' · <span class="door-first">first time! Welcome them in</span>' : ''}${r.promoted ? ' · 🎉 just became an Apprentice!' : ''}${r.tickets_given ? `<div class="door-give">🎟️ Hand them <b>${r.tickets_given}</b> carnival tickets</div>` : ''}`
    : `<b>Already in:</b> ${escapeHtml(r.display_name)} (since ${new Date(sqlTime(r.checked_in_at)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})`;

  // Lanes.
  mainView.querySelectorAll('[data-lane]').forEach(b => b.addEventListener('click', () => {
    lane = b.dataset.lane;
    mainView.querySelectorAll('[data-lane]').forEach(x => x.setAttribute('aria-selected', x === b));
    mainView.querySelectorAll('.door-lane').forEach(x => { x.hidden = x.dataset.for !== lane; });
    closeAdmit();
    if (lane === 'find') $('#doorSearch').focus();
    if (lane === 'new') $('#doorNew [name=name]').focus();
  }));
  $('[data-door-settings]')?.addEventListener('click', () => { $('#doorSettings').hidden = !$('#doorSettings').hidden; });
  // Prove Stripe works for 50¢: the same checkout and webhook as a real ticket.
  $('[data-testpay]')?.addEventListener('click', async e => {
    e.target.disabled = true;
    try { const r = await apiFetch(`/api/events/${eventId}/door/testpay`, { method: 'POST' }); window.location.href = r.url; }
    catch (err) { flashToast(err.message); e.target.disabled = false; }
  });
  $('#doorSettings').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const capacity = f.capacity.value === '' ? null : Number(f.capacity.value), door_cents = f.price.value === '' ? null : Math.round(Number(f.price.value) * 100);
    const entry_tickets = f.give.value === '' ? 0 : Number(f.give.value), ticket_cents = f.each.value === '' ? null : Math.round(Number(f.each.value) * 100);
    try {
      const r = await apiFetch(`/api/events/${eventId}/door`, { method: 'PATCH', body: { capacity, door_cents, entry_tickets, ticket_cents, slug: f.slug.value, tagline: f.tagline.value, lineup: f.lineup.value, ...(f.partner ? { partner_id: f.partner.value || null } : {}) } });
      if (f.partner) ev.partner_id = f.partner.value || null;
      Object.assign(ev, { capacity, door_cents, entry_tickets, ticket_cents });
      d.link = r.link; drawLink(); drawCount(d.totals); flashToast('Door settings saved.');
    } catch (err) { flashToast(err.message); }
  });

  // Sell extra carnival tickets.
  const sell = $('#doorSell');
  const each = () => ev.ticket_cents ?? 100;
  const sellTotal = () => { const q = Math.max(0, Math.round(Number(sell.qty.value) || 0)); $('#sellTotal').textContent = `${q} ticket${q === 1 ? '' : 's'} · take ${doorMoney(q * each())}`; };
  sellTotal();
  sell.addEventListener('input', sellTotal);
  // Enter in the box shouldn't guess cash: make them tap a method.
  sell.qty.addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });
  sell.addEventListener('click', e => {
    const q = e.target.closest('[data-q]'), set = e.target.closest('[data-set]');
    if (q) { sell.qty.value = Math.max(1, (Number(sell.qty.value) || 0) + Number(q.dataset.q)); sellTotal(); }
    if (set) { sell.qty.value = set.dataset.set; sellTotal(); }
  });
  sell.addEventListener('submit', async e => {
    e.preventDefault();
    const method = e.submitter?.dataset.m;
    if (!method) return;
    try {
      const r = await apiFetch(`/api/events/${eventId}/door/sell`, { method: 'POST', body: { qty: Number(sell.qty.value), method } });
      flash(true, `<b>✓ Sold ${r.qty} carnival tickets</b> · ${doorMoney(r.amount_cents)} ${method}. Tear them off the roll!`);
      sell.qty.value = 5; sellTotal(); refresh();
    } catch (err) { flash('bad', `✗ ${escapeHtml(err.message)}`); }
  });
  function drawSales(sales) {
    $('#doorSales').innerHTML = sales.length ? '<div class="post-meta">Recent sales</div>' + sales.map(x => `
      <div class="door-entry ${x.voided_at ? 'voided' : ''}"><div><b>${x.qty} tickets</b><div class="post-meta">${doorMoney(x.amount_cents)} ${x.method} · ${new Date(sqlTime(x.created_at)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${x.by_name ? ` · by ${escapeHtml(x.by_name.split(' ')[0])}` : ''}</div></div>
      ${x.voided_at ? '<span class="post-meta">undone</span>' : `<button type="button" class="raven-offer-no" data-unsell="${x.id}">Undo</button>`}</div>`).join('') : '';
  }
  $('#doorSales').addEventListener('click', async e => {
    const b = e.target.closest('[data-unsell]');
    if (!b) return;
    b.disabled = true;
    try { await apiFetch(`/api/events/${eventId}/door/sales/${b.dataset.unsell}`, { method: 'DELETE' }); refresh(); } catch (err) { flashToast(err.message); b.disabled = false; }
  });

  // Scan: tickets and guest passes.
  async function scan(code) {
    try {
      const r = await apiFetch(`/api/events/${eventId}/door/scan`, { method: 'POST', body: { code } });
      if (r.owes) {
        flash(false, `<b>${escapeHtml(r.display_name)}</b> saved ${r.quantity > 1 ? `${r.quantity} spots (them + ${r.quantity - 1})` : 'a spot'}. Take their entry below.`);
        openAdmit({ user_id: r.user_id, name: r.display_name, hasFix: r.has_fix, ticket_id: r.ticket_id, entry: r.entry_cents, party: r.quantity }, result);
        return;
      }
      flash(r.ok, said(r)); refresh();
    }
    catch (err) { flash('bad', `✗ ${escapeHtml(err.message)}`); }
  }
  $('#checkinForm').addEventListener('submit', e => {
    e.preventDefault();
    const input = $('#checkinCode');
    if (input.value.trim()) scan(input.value.trim());
    input.value = '';
  });

  // Find a member.
  let findTimer;
  $('#doorSearch').addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(find, 250); });
  async function find() {
    const q = $('#doorSearch').value.trim();
    if (q.length < 2) { $('#doorResults').innerHTML = ''; return; }
    const { members } = await apiFetch(`/api/events/${eventId}/door/search?q=${encodeURIComponent(q)}`);
    $('#doorResults').innerHTML = members.map(m => `
      <div class="door-member">
        <div><b>${escapeHtml(m.display_name)}</b><div class="post-meta">${escapeHtml(m.city || '')}${m.crew ? ' · 🔨 on the crew' : ''}${m.ticket_code ? ' · 🎟️ has a ticket' : ''}${m.has_fix ? '' : ' · hasn’t paid the $5 yet'}</div></div>
        ${m.admitted_at ? '<span class="volunteer-yes">✓ In</span>'
          : m.ticket_code ? `<button class="composer-submit" data-ticket="${m.ticket_code}">Use their ticket</button>`
          : `<button class="composer-submit" data-admit="${m.id}" data-name="${escapeHtml(m.display_name)}" data-fix="${m.has_fix ? 1 : 0}" data-crew="${m.crew ? 1 : 0}">Let in…</button>`}
      </div>`).join('') || `<div class="placeholder-note">No one by that name. <button class="raven-offer-no" data-to-new>New face?</button></div>`;
  }
  $('#doorResults').addEventListener('click', e => {
    const t = e.target.closest('[data-ticket]');
    if (t) { scan(t.dataset.ticket); setTimeout(find, 600); return; }
    const a = e.target.closest('[data-admit]');
    if (a) { openAdmit({ user_id: a.dataset.admit, name: a.dataset.name, hasFix: a.dataset.fix === '1', crew: a.dataset.crew === '1' }, a.closest('.door-member')); return; }
    if (e.target.closest('[data-to-new]')) { mainView.querySelector('[data-lane="new"]').click(); $('#doorNew [name=name]').value = $('#doorSearch').value; }
  });

  // New face → the same "how are they getting in" sheet.
  $('#doorNew').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target;
    openAdmit({ name: f.name.value.trim(), email: f.email.value.trim(), phone: f.phone.value.trim(), city: f.city.value.trim(), heard: f.heard.value.trim(), hasFix: false, fresh: true }, f);
  });

  // How they're getting in, and what they paid.
  let sheet = null;
  function closeAdmit() { sheet?.remove(); sheet = null; }
  function openAdmit(who, after) {
    closeAdmit();
    const reg = d.registration_cents;
    const price = who.entry ?? ev.door_cents;
    sheet = document.createElement('form');
    sheet.className = 'door-admit';
    sheet.innerHTML = `
      <div class="da-who">Letting in <b>${escapeHtml(who.name)}</b>${who.party > 1 ? ` + ${who.party - 1} guest${who.party > 2 ? 's' : ''}` : ''}${who.fresh ? ' <span class="door-first">new face</span>' : ''}</div>
      <div class="da-seg" data-seg="via">
        <button type="button" data-v="door" aria-pressed="${!who.crew}">💵 Paying</button>
        <button type="button" data-v="comp" aria-pressed="false">🌟 Comp</button>
        <button type="button" data-v="crew" aria-pressed="${!!who.crew}">🔨 Crew</button>
        <button type="button" data-v="performer" aria-pressed="false">🎭 Performer</button>
      </div>
      <div class="da-pay">
        <label class="da-amount">$ <input name="amount" type="number" min="0" step="1" inputmode="decimal" value="${price != null ? price / 100 : ''}" placeholder="Amount"></label>
        <div class="da-seg" data-seg="method">
          <button type="button" data-v="cash" aria-pressed="false">💵 Cash</button>
          <button type="button" data-v="card" aria-pressed="false">💳 Card (Square)</button>
        </div>
        ${who.hasFix ? '' : `<label class="da-reg"><input type="checkbox" name="registration" checked> + ${doorMoney(reg)} one-time membership (their first carnival). They win <b>The Fix Is In</b>.</label>`}
        <div class="da-total" data-total></div>
      </div>
      <input class="door-input" name="note" placeholder="Note (optional): performer, plus-one of…" maxlength="140" autocomplete="off">
      <div class="da-btns"><button class="composer-submit" type="submit">Let them in</button><button class="raven-offer-no" type="button" data-cancel>Cancel</button></div>`;
    after.after(sheet);
    const state = { via: who.crew ? 'crew' : 'door', method: null };
    const sync = () => {
      sheet.querySelectorAll('[data-seg="via"] [data-v]').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === state.via));
      sheet.querySelectorAll('[data-seg="method"] [data-v]').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === state.method));
      sheet.querySelector('.da-pay').hidden = state.via !== 'door';
      const amt = Math.round(Number(sheet.amount.value || 0) * 100) + (sheet.registration?.checked ? reg : 0);
      sheet.querySelector('[data-total]').innerHTML = `Take <b>${doorMoney(amt)}</b>${ev.entry_tickets ? ` · hand them ${ev.entry_tickets * (who.party || 1)} carnival tickets` : ''}`;
    };
    sheet.addEventListener('input', sync);
    sync();
    sheet.addEventListener('click', e => {
      const b = e.target.closest('[data-v]');
      if (b) { state[b.closest('[data-seg]').dataset.seg] = b.dataset.v; sync(); }
      if (e.target.closest('[data-cancel]')) closeAdmit();
    });
    sheet.querySelector('[name=amount]')?.focus();
    sheet.addEventListener('submit', async e => {
      e.preventDefault();
      const amount = Math.round(Number(sheet.amount.value || 0) * 100);
      const registration = !!sheet.registration?.checked;
      if (state.via === 'door' && (amount > 0 || registration) && !state.method) { flash('bad', 'Cash or card?'); return; }
      const btn = sheet.querySelector('[type=submit]'); btn.disabled = true;
      try {
        const r = await apiFetch(`/api/events/${eventId}/door/admit`, { method: 'POST', body: {
          user_id: who.user_id, ticket_id: who.ticket_id, name: who.name, email: who.email, phone: who.phone, city: who.city, heard: who.heard,
          via: state.via, amount_cents: state.via === 'door' ? amount : 0, method: state.method, registration, note: sheet.note.value,
        } });
        closeAdmit();
        if (who.fresh) $('#doorNew').reset();
        if (lane === 'find') { $('#doorSearch').value = ''; $('#doorResults').innerHTML = ''; }
        flash(r.ok ? 'keep' : false, said(r) + (r.claim ? `
          <div class="door-claim"><div class="ticket-qr">${qrSvg(r.claim)}</div>
            <p><b>Have them scan this with their phone</b> to claim their Dressing Room and set a password. Works for 30 days.</p>
            <button class="raven-offer-no" data-claim-done>Done</button></div>` : ''));
        if (r.ok && !r.claim) setTimeout(() => result.classList.remove('show'), 6000);
        refresh();
      } catch (err) { flash('bad', `✗ ${escapeHtml(err.message)}`); btn.disabled = false; }
    });
  }
  result.addEventListener('click', e => { if (e.target.closest('[data-claim-done]')) result.classList.remove('show'); });

  // Undo a mistake.
  $('#doorRecent').addEventListener('click', async e => {
    const b = e.target.closest('[data-undo]');
    if (!b) return;
    b.disabled = true;
    try { await apiFetch(`/api/events/${eventId}/door/entries/${b.dataset.undo}`, { method: 'DELETE' }); refresh(); }
    catch (err) { flashToast(err.message); b.disabled = false; }
  });

  // The camera: the browser's own QR reader where there is one, jsQR on iPhones.
  const video = $('#scanVideo'), hint = $('#camHint');
  if (!navigator.mediaDevices?.getUserMedia) { hint.textContent = 'No camera here. Type the code below.'; return; }
  let detect;
  if ('BarcodeDetector' in window) {
    const det = new BarcodeDetector({ formats: ['qr_code'] });
    detect = async () => (await det.detect(video))[0]?.rawValue;
  } else {
    try {
      if (!window.jsQR) await new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js'; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
    } catch (e) { hint.textContent = 'Couldn’t load the scanner. Type the code below.'; return; }
    const canvas = $('#scanCanvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
    detect = async () => {
      const w = video.videoWidth, h = video.videoHeight;
      if (!w) return null;
      const s = Math.min(1, 640 / w);
      canvas.width = w * s; canvas.height = h * s;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      return window.jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' })?.data;
    };
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = stream; video.hidden = false; hint.textContent = 'Point it at a ticket or guest pass.';
    await video.play();
    let last = '', lastAt = 0, busy = false;
    const tick = async () => {
      if (!document.body.contains(video)) { stream.getTracks().forEach(t => t.stop()); return; }
      if (!busy && lane === 'scan') {
        busy = true;
        try {
          const code = await detect();
          if (code && (code !== last || Date.now() - lastAt > 4000)) { last = code; lastAt = Date.now(); await scan(code.trim()); }
        } catch (e) { /* frame not ready */ }
        busy = false;
      }
      setTimeout(tick, 150);
    };
    tick();
  } catch (e) { hint.textContent = 'Camera’s off. Allow it in the browser, or type the code below.'; }
}

// The night's report: who came, how they got in, what came in at the door.
async function renderDoorReport(mainView, eventId) {
  mainView.innerHTML = '<h2>The night’s report</h2><div class="placeholder-note">Counting heads…</div>';
  let r;
  try { r = await apiFetch(`/api/events/${eventId}/door/report`); } catch (err) { mainView.innerHTML = `<h2>The night’s report</h2><div class="placeholder-note">${escapeHtml(err.message)}</div>`; return; }
  const t = r.totals, live = r.entries.filter(e => !e.voided_at);
  const door = t.cash + t.card;
  const hour = h => new Date(h).toLocaleTimeString([], { hour: 'numeric' });
  const peak = Math.max(1, ...r.hours.map(h => h.n));
  mainView.innerHTML = `
    <div class="door-report">
      <div class="door-kicker">🚪 The night’s report</div>
      <h2>${escapeHtml(r.event.title)}</h2>
      <div class="post-meta">${formatEventDate(r.event.starts_at)}${r.event.location ? ' · ' + escapeHtml(r.event.location) : ''}</div>
      <div class="dr-tiles">
        <div><b>${t.inside}</b><span>came through the door${r.event.capacity ? ` (of ${r.event.capacity})` : ''}</span></div>
        <div><b>${t.first_time}</b><span>first-timers</span></div>
        <div><b>${doorMoney(door)}</b><span>taken at the door (${doorMoney(t.cash)} cash · ${doorMoney(t.card)} card), entry and tickets</span></div>
        <div><b>${r.advance.n}</b><span>paid ahead online (${doorMoney(r.advance.cents)})</span></div>
        <div><b>${r.saved.came}/${r.saved.n}</b><span>saved a spot and came</span></div>
        <div><b>${t.tickets_given + t.tickets_sold}</b><span>carnival tickets out (${t.tickets_given} with entry, ${t.tickets_sold} sold for ${doorMoney(t.ticket_sales)})</span></div>
      </div>
      <h3>Tickets so far (${(r.tickets || []).length})</h3>
      <div class="door-recent">${(r.tickets || []).map(x => `
        <div class="door-entry"><div><b>${escapeHtml(x.name)}</b>${x.quantity > 1 ? ` <b>× ${x.quantity}</b>` : ''} ${x.status === 'paid' && x.paid_cents ? `<span class="door-first">paid ${doorMoney(x.paid_cents)} online</span>` : x.status === 'paid' ? '<span class="door-first">paid</span>' : ''}
          <div class="post-meta">${x.status === 'reserved' ? `Saved ${x.quantity > 1 ? x.quantity + ' spots' : 'a spot'} · owes ${doorMoney(x.price_cents * x.quantity)}${x.quantity > 1 ? ' entry' : ''} at the door` : 'Paid ahead'}${x.checked_in_at ? ' · came in ✓' : ''} · ${escapeHtml(x.email || '')} · ${new Date(sqlTime(x.created_at)).toLocaleDateString([], { month: 'short', day: 'numeric' })}</div></div></div>`).join('') || '<div class="placeholder-note">No tickets yet.</div>'}</div>
      <h3>How they got in</h3>
      <div class="dr-vias">${Object.entries(DOOR_VIA).map(([k, v]) => `<span>${v} <b>${t.by_via[k] || 0}</b></span>`).join('')}</div>
      ${t.registrations ? `<p class="post-meta">${t.registrations} paid the one-time membership (${doorMoney(t.registration)}), included in the door total.</p>` : ''}
      ${r.hours.length ? `<h3>When they came</h3><div class="dr-hours">${r.hours.map(h => `<div><i style="height:${Math.round((h.n / peak) * 100)}%"></i><span>${hour(h.hour)}</span><b>${h.n}</b></div>`).join('')}</div>` : ''}
      <div class="post-actions"><button class="composer-submit" data-csv>⬇ Download the list (CSV)</button><button class="action-btn" data-impact>Start an Impact Log entry</button><a class="action-btn" href="#/checkin/${eventId}">← Back to the door</a></div>
      <h3>Everyone (${live.length})</h3>
      <div class="door-recent">${r.entries.map(e => `
        <div class="door-entry ${e.voided_at ? 'voided' : ''}"><div><b>${escapeHtml(e.name)}</b>${e.first_time ? ' <span class="door-first">first time</span>' : ''}
          <div class="post-meta">${DOOR_VIA[e.via] || e.via}${e.amount_cents ? ` · ${doorMoney(e.amount_cents)} ${e.method || ''}` : ''}${e.city ? ` · ${escapeHtml(e.city)}` : ''} · ${new Date(sqlTime(e.created_at)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${e.by_name ? ` · by ${escapeHtml(e.by_name)}` : ''}${e.note ? ` · ${escapeHtml(e.note)}` : ''}${e.voided_at ? ' · undone' : ''}</div></div></div>`).join('') || '<div class="placeholder-note">Nobody came through the door.</div>'}</div>
    </div>`;
  mainView.querySelector('[data-csv]').addEventListener('click', () => {
    const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['time', 'name', 'how', 'paid', 'method', 'registration', 'first_time', 'city', 'email', 'note', 'door_crew', 'undone']]
      .concat(r.entries.map(e => [e.created_at, e.name, e.via, (e.amount_cents / 100).toFixed(2), e.method, (e.registration_cents / 100).toFixed(2), e.first_time ? 'yes' : '', e.city, e.user_email, e.note, e.by_name, e.voided_at ? 'yes' : '']));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([rows.map(x => x.map(cell).join(',')).join('\n')], { type: 'text/csv' }));
    a.download = `${r.event.title.replace(/[^\w]+/g, '-').toLowerCase()}-door.csv`;
    a.click();
  });
  mainView.querySelector('[data-impact]').addEventListener('click', async () => {
    await apiFetch('/api/impact-logs', { method: 'POST', body: {
      event_date: r.event.starts_at.slice(0, 10), event_name: r.event.title,
      notes: `Door: ${t.inside} came in${r.event.capacity ? ` (capacity ${r.event.capacity})` : ''}, ${t.first_time} first-timers. In by: ${Object.entries(t.by_via).map(([k, n]) => `${k} ${n}`).join(', ')}. Door take ${doorMoney(door)} (${doorMoney(t.cash)} cash, ${doorMoney(t.card)} card), incl. ${t.tickets_sold} extra carnival tickets (${doorMoney(t.ticket_sales)}). ${r.advance.n} paid ahead online; ${r.saved.came} of ${r.saved.n} saved spots came. ${t.tickets_given + t.tickets_sold} carnival tickets out.`,
    } });
    flashToast('Impact Log entry started. Add travel, materials and waste there.');
  });
}

// Claiming an account made at the door (#/claim/<token>, from the door QR).
async function renderClaimScreen(token, errorMsg = '') {
  let info = null;
  try { info = await apiFetch(`/api/auth/claim?peek=1`, { method: 'POST', body: { token } }); } catch (err) { errorMsg = errorMsg || err.message; }
  app.innerHTML = `
    <div class="auth-screen"><div class="auth-panel">
      <img class="auth-logo" src="assets/logo-wordmark.png" alt="Carnival Society International">
      <h1>${info ? `Welcome, ${escapeHtml(info.display_name.split(' ')[0])}!` : 'Claim your Dressing Room'}</h1>
      ${info ? `<p class="auth-sub">You came through the door, so you’re in the Carnival Society. Set a password to claim your own Dressing Room.</p>
      <form class="auth-form" id="claimForm">
        ${info.needs_email ? '<div class="auth-field"><label for="claimEmail">Your email</label><input type="email" id="claimEmail" required autocomplete="email"></div>' : ''}
        <div class="auth-field"><label for="claimPassword">Pick a password (6+ characters)</label><input type="password" id="claimPassword" minlength="6" required autocomplete="new-password"></div>
        <p class="auth-error">${escapeHtml(errorMsg)}</p>
        <button type="submit" class="auth-submit">Claim my room</button>
      </form>` : `<p class="auth-error">${escapeHtml(errorMsg)}</p><a class="auth-submit" href="#/">Sign in</a>`}
    </div></div>`;
  document.getElementById('claimForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const { user } = await apiFetch('/api/auth/claim', { method: 'POST', body: { token, password: document.getElementById('claimPassword').value, email: document.getElementById('claimEmail')?.value } });
      session = true; profile = user;
      await loadAppData();
      history.replaceState(null, '', '#/');
      render();
    } catch (err) { renderClaimScreen(token, err.message); }
  });
}

// ── Getting in (2026-10-14): a carnival's public page, no sign-up first.
// Name + email → "Save my spot" (pay at the door), or pay now once Stripe
// is switched on. The email puts you in the system.
// The crest, as on carnivalsociety.org: the gold wordmark over the burgundy
// spiral (the front page's own six curved blades), a ring of dots and stars
// turning the other way, and the wordmark swaying gently.
let spiralSvgCache = '';
function frontSpiral() {
  if (spiralSvgCache) return spiralSvgCache;
  const N = 6, maxR = 188, twist = 2.1, armW = (2 * Math.PI / N) * 0.55, steps = 60;
  const f2 = n => n.toFixed(1);
  let blades = '';
  for (let k = 0; k < N; k++) {
    const phi = k * (2 * Math.PI / N); let d = '';
    for (let i = 0; i <= steps; i++) { const f = i / steps, r = f * maxR, t = phi + twist * f; d += (i ? 'L' : 'M') + f2(r * Math.cos(t)) + ' ' + f2(r * Math.sin(t)); }
    for (let i = steps; i >= 0; i--) { const f = i / steps, r = f * maxR, t = phi + armW * f + twist * f; d += 'L' + f2(r * Math.cos(t)) + ' ' + f2(r * Math.sin(t)); }
    blades += `<path d="${d}Z"/>`;
  }
  let halo = '';
  for (let k = 0; k < 24; k++) {
    const phi = k * (2 * Math.PI / 24), x = f2(218 * Math.cos(phi)), y = f2(218 * Math.sin(phi));
    halo += k % 2 ? `<g transform="translate(${x} ${y})"><path d="M0 -6V6M-5.2 -3 5.2 3M-5.2 3 5.2 -3"/></g>` : `<circle cx="${x}" cy="${y}" r="2.8"/>`;
  }
  return (spiralSvgCache = `<svg viewBox="-240 -240 480 480" aria-hidden="true"><g class="gs-halo" fill="#9B3036" stroke="#9B3036" stroke-width="1.1">${halo}</g><g class="gs-rotor" fill="#9B3036">${blades}<circle r="3.5"/></g></svg>`);
}
// Who's presenting a night alongside us, shown under the wordmark (by slug).
const GETIN_SPONSORS = { kooks: { name: 'Wiggelruhm', logo: 'assets/partners/wiggelruhm-word.png' } };
function getinMarquee(kicker, slug) {
  const sp = GETIN_SPONSORS[slug];
  return `
    <header class="gi-marquee">
      <div class="gi-spiral" aria-hidden="true">${frontSpiral()}</div>
      <div class="gi-sign"><img src="assets/logo-wordmark.png" alt="Carnival Society International"></div>
      ${sp ? `<div class="gi-sponsor-wrap"><div class="gi-sponsor" role="img" aria-label="${escapeHtml(sp.name)}" style="--logo:url('${sp.logo}')"></div></div>` : ''}
      <div class="gi-kicker">${kicker}</div>
    </header>`;
}
// SAT · OCT 31 · 7 PM, as three stamped stubs.
// Who's co-hosting: their logo if they have one, else their name.
function partnerBadge(p) {
  if (!p) return '';
  return `<div class="gi-with">Presented with ${p.logo ? `<img class="gi-plogo" src="${escapeHtml(p.logo)}" alt="${escapeHtml(p.name)}">` : `<b>${escapeHtml(p.name)}</b>`}</div>`;
}
// What you're paying for: "Halloween Carnival" over Burlesque · FreakShow · …
function lineupHtml(ev) {
  const acts = (ev.lineup || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!ev.tagline && !acts.length) return '';
  return `<div class="gi-lineup">${ev.tagline ? `<div class="gl-head">${escapeHtml(ev.tagline)}</div>` : ''}${acts.length ? `<div class="gl-acts">${acts.map(a => `<span>${escapeHtml(a)}</span>`).join('')}</div>` : ''}</div>`;
}
function getinDate(iso) {
  const d = new Date(sqlTime(iso));
  return `<div class="gi-date" aria-label="${escapeHtml(d.toLocaleString([], { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}">
    <span>${d.toLocaleDateString([], { weekday: 'short' })}</span>
    <span class="gi-day"><small>${d.toLocaleDateString([], { month: 'short' })}</small>${d.getDate()}</span>
    <span>${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(':00', '')}</span>
  </div>`;
}
async function renderGetIn(idOrSlug, errorMsg = '') {
  app.innerHTML = `<div class="getin"><div class="getin-card">${getinMarquee('Step right up!', idOrSlug)}<div class="gi-body"><p class="gi-fine">Unrolling the poster…</p></div></div></div>`;
  let d;
  try { d = await apiFetch(`/api/public/events/${encodeURIComponent(idOrSlug)}`); }
  catch (err) { app.innerHTML = `<div class="getin"><div class="getin-card">${getinMarquee('Hmm.')}<div class="gi-body"><p>${escapeHtml(err.message)}</p><a class="gi-btn" href="#/">Carnival Society</a></div></div></div>`; return; }
  const ev = d.event, reg = d.registration_cents;
  const priced = ev.door_cents != null;
  const free = priced && ev.door_cents === 0;
  const payNow = d.payments_enabled && !free;
  app.innerHTML = `
    <div class="getin">
      <div class="getin-card">
        ${getinMarquee('Step right up!', ev.slug || idOrSlug)}
        <div class="gi-body">
          <h1>${escapeHtml(ev.title)}</h1>
          ${getinDate(ev.starts_at)}
          ${ev.location ? `<p class="gi-where">📍 ${escapeHtml(ev.location)}</p>` : ''}
          ${partnerBadge(d.partner)}
          ${lineupHtml(ev)}
          ${ev.description ? `<p class="gi-desc">${escapeHtml(ev.description)}</p>` : ''}
          ${!d.open ? '<div class="gi-note"><b>This one’s over.</b> Thanks to everyone who came!</div>'
          : !priced ? '<div class="gi-note"><b>Tickets open soon.</b> Check back, or ask a Ringleader.</div>'
          : `<div class="gi-ticket">
              <div class="gi-stub"><span>ADMIT ONE</span></div>
              <div class="gi-face">
                <b class="gi-price">${free ? 'Free' : doorMoney(ev.door_cents)}</b>
                <span>entry${ev.entry_tickets ? `, with <strong>${ev.entry_tickets} free carnival tickets</strong> for games and experiences` : ''}</span>
                ${d.spots_left != null ? `<em>${d.spots_left ? `${d.spots_left} spots left` : 'Full! Come by the door and we’ll see.'}</em>` : ''}
              </div>
            </div>
            ${free ? '' : `<div class="gi-receipt" aria-label="What you pay">
              <div class="gr-row gr-qty"><span>How many people?<small>you plus your friends, one QR for all of you</small></span>
                <span class="gi-stepper"><button type="button" data-qty="-1" aria-label="One fewer">−</button><output data-qty-n>1</output><button type="button" data-qty="1" aria-label="One more">+</button></span></div>
              <div class="gr-row"><span>Entry<small data-qty-each hidden></small></span><b data-qty-entry>${doorMoney(ev.door_cents)}</b></div>
              ${profile && !profile.waitlisted ? `<div class="gr-row gr-total"><span>You’re in the troupe, so no membership fee</span><b data-qty-total="0">${doorMoney(ev.door_cents)}</b></div>` : `
              <div class="gr-row gr-mem"><span><strong>One-time membership</strong><small>your first carnival only · you win <i>The Fix Is In</i> 💰</small></span><b>+${doorMoney(reg)}</b></div>
              <div class="gr-row gr-total"><span>Your first night</span><b data-qty-total="${reg}">${doorMoney(ev.door_cents + reg)}</b></div>
              <p>After that, it’s ${doorMoney(ev.door_cents)} every time. Already a member? Use your member email and the $5 drops off. Your guests just pay entry.</p>`}
            </div>`}
            <form class="gi-form" id="getinForm">
              <label>Your name<input name="name" required maxlength="60" autocomplete="name" value="${escapeHtml(profile?.display_name || '')}"></label>
              <label>Email<input name="email" type="email" required autocomplete="email" inputmode="email" value="${escapeHtml(profile?.email || '')}"></label>
              ${d.partner ? `<label class="gi-join"><input type="checkbox" name="join" checked> Also join <b>${escapeHtml(d.partner.name)}</b> and hear about their nights</label>` : ''}
              ${errorMsg ? `<p class="gi-error" role="alert">${escapeHtml(errorMsg)}</p>` : ''}
              ${payNow ? '<button class="gi-btn" type="submit" data-pay="1">Pay now · Apple Pay or card</button>' : ''}
              <button class="${payNow ? 'gi-btn gi-btn-2' : 'gi-btn'}" type="submit" data-pay="0">${free ? 'Get my ticket' : 'Save my spot · pay at the door'}</button>
              <p class="gi-fine">No password, no sign-up. Your ticket is a QR code you show at the door, waiting on the next screen.</p>
            </form>`}
        </div>
      </div>
    </div>`;
  // Bring friends: one ticket, one QR, the whole group gets in.
  let qty = 1;
  const spotsCap = d.spots_left != null ? Math.max(1, d.spots_left) : 10;
  app.querySelector('.gi-receipt')?.addEventListener('click', e => {
    const b = e.target.closest('[data-qty]');
    if (!b) return;
    qty = Math.min(10, spotsCap, Math.max(1, qty + Number(b.dataset.qty)));
    app.querySelector('[data-qty-n]').textContent = qty;
    const each = app.querySelector('[data-qty-each]');
    each.hidden = qty < 2; each.textContent = `${qty} × ${doorMoney(ev.door_cents)}`;
    app.querySelector('[data-qty-entry]').textContent = doorMoney(ev.door_cents * qty);
    const tot = app.querySelector('[data-qty-total]');
    if (tot) tot.textContent = doorMoney(ev.door_cents * qty + Number(tot.dataset.qtyTotal));
  });
  document.getElementById('getinForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, pay = e.submitter?.dataset.pay === '1';
    f.querySelectorAll('button').forEach(b => { b.disabled = true; });
    if (e.submitter) e.submitter.textContent = pay ? 'Off to pay…' : 'Punching your ticket…';
    try {
      const r = await apiFetch(`/api/public/events/${ev.id}/get`, { method: 'POST', body: { name: f.name.value, email: f.email.value, pay, quantity: qty, join_partner: !!f.join?.checked } });
      if (r.url) { window.location.href = r.url; return; }
      // An existing account's ticket goes to its inbox, never the screen.
      if (!r.code) { renderTicketSent(f.email.value, r.already, ev.slug || idOrSlug); return; }
      try { if (r.emailed) sessionStorage.setItem('cs-ticket-emailed', r.code); } catch (e) { /* fine */ }
      location.hash = `#/ticket/${r.code}${r.claim ? '/' + r.claim : ''}`;
    } catch (err) { renderGetIn(idOrSlug, err.message); }
  });
}
// "Check your email": the ticket went to the inbox for that address.
function renderTicketSent(email, already, slug) {
  app.innerHTML = `<div class="getin"><div class="getin-card">${getinMarquee(already ? 'You’re already in!' : 'Spot saved!', slug)}<div class="gi-body">
    <h1>Check your email</h1>
    <p class="gi-desc gi-center">${already ? 'You already have a ticket for this one.' : 'Your ticket is on its way.'} We sent it to <b>${escapeHtml(email)}</b>. It has your QR code for the door.</p>
    <p class="gi-fine">Nothing there? Check spam, or just give your name at the door. We’ll find you.</p>
  </div></div></div>`;
}
// The ticket, as the buyer's phone shows it at the door.
async function renderTicketPage(code, claim, tries = 0) {
  let t;
  try { ({ ticket: t } = await apiFetch(`/api/public/tickets/${code}`)); }
  catch (err) { app.innerHTML = `<div class="getin"><div class="getin-card">${getinMarquee('Hmm.')}<div class="gi-body"><p>${escapeHtml(err.message)}</p></div></div></div>`; return; }
  // Back from Stripe a moment before its webhook lands: wait for it.
  if (t.status === 'pending' && tries < 8) {
    app.innerHTML = `<div class="getin"><div class="getin-card">${getinMarquee('One moment!')}<div class="gi-body"><p class="gi-fine">Punching your ticket…</p></div></div></div>`;
    setTimeout(() => renderTicketPage(code, claim, tries + 1), 1500);
    return;
  }
  const status = t.checked_in ? '<div class="gi-status in">✓ You’re in. Have fun!</div>'
    : t.status === 'paid' ? `<div class="gi-status paid">✓ Paid. Show this at the door.${t.quantity > 1 ? `<small>Lets in ${t.quantity}: you and ${t.quantity - 1} guest${t.quantity > 2 ? 's' : ''}. Come in together!</small>` : ''}</div>`
    : t.status === 'reserved' ? `<div class="gi-status owe">Spot${t.quantity > 1 ? 's' : ''} saved! Pay <b>${doorMoney(t.owe_cents)}</b> at the door, cash or card${t.owe_cents > t.entry_cents ? `<small>${doorMoney(t.entry_cents)} entry + ${doorMoney(t.owe_cents - t.entry_cents)} one-time membership (your first carnival only)</small>` : ''}</div>`
    : '<div class="gi-status owe">Payment didn’t go through. Try again, or pay at the door.</div>';
  app.innerHTML = `
    <div class="getin">
      <div class="getin-card">
        ${getinMarquee(`Admit one · ${escapeHtml(t.name)}`, t.event)}
        <div class="gi-body">
          <h1>${escapeHtml(t.title)}</h1>
          ${getinDate(t.starts_at)}
          ${t.location ? `<p class="gi-where">📍 ${escapeHtml(t.location)}</p>` : ''}
        </div>
        <div class="gi-tear" aria-hidden="true"></div>
        <div class="gi-body gi-stubside">
          <div class="gi-qr">${qrSvg(t.code)}</div>
          <code class="gi-code">${escapeHtml(t.code)}</code>
          ${status}
          ${t.entry_tickets ? `<p class="gi-fine">Comes with <b>${t.entry_tickets} free carnival tickets</b> 🎟️ for games and experiences, handed to you at the door.</p>` : ''}
          <p class="gi-fine">${(() => { try { return sessionStorage.getItem('cs-ticket-emailed') === t.code; } catch (e) { return false; } })() ? '📧 We emailed this ticket to you too. ' : ''}Screenshot this, or keep the page.${navigator.share ? ' <button class="gi-link" data-share>Send it to myself</button>' : ''}</p>
          ${claim ? `<a class="gi-btn" href="#/claim/${claim}">Claim your Dressing Room →</a><p class="gi-fine">You’re in the Carnival Society now. Set a password to see your room, the crew and what’s coming up.</p>`
            : session ? '<a class="gi-btn gi-btn-2" href="#/dressing-room">Back to my Dressing Room</a>' : ''}
        </div>
      </div>
    </div>`;
  app.querySelector('[data-share]')?.addEventListener('click', () => navigator.share({ title: `My ticket: ${t.title}`, url: location.href }).catch(() => {}));
}

// ── Partners (2026-10-15) ─────────────────────────────────────────────
// The partner's desk (#/partner): their friends, their carnivals, a holler
// to their friends, and their join page. Ringleaders can open any partner's
// desk from the Directory (#/partner/<id>).
async function renderPartnerDesk(mainView, partnerId) {
  mainView.innerHTML = '<h2>Partner desk</h2><div class="placeholder-note">Loading…</div>';
  let d;
  try { d = await apiFetch(`/api/partner${partnerId ? `?id=${partnerId}` : ''}`); }
  catch (err) { mainView.innerHTML = `<h2>Partner desk</h2><div class="placeholder-note">${escapeHtml(err.message)}</div>`; return; }
  const p = d.partner, mine = p.id === profile.id;
  const past = d.events.filter(e => sqlTime(e.ends_at || e.starts_at) < Date.now());
  mainView.innerHTML = `
    <div class="partner-desk">
      <div class="door-kicker">🤝 Partner desk</div>
      <h2>${escapeHtml(p.name)}</h2>
      <div class="dr-tiles">
        <div><b>${d.friends}</b><span>friends made through Carnival Society</span></div>
        <div><b>${d.events.reduce((n, e) => n + e.came, 0)}</b><span>came through the door at ${d.events.length} ${d.events.length === 1 ? 'carnival' : 'carnivals'} you hosted</span></div>
      </div>

      <section class="pd-card">
        <h3>Your join page</h3>
        <p class="post-meta">Anyone who joins here becomes your friend and hears your hollers. Everyone let in at a carnival you co-host joins too.</p>
        ${d.join_url ? `<div class="ds-link"><div class="ticket-qr">${qrSvg(d.join_url)}</div><div><a href="${escapeHtml(d.join_url)}" target="_blank" rel="noopener">${escapeHtml(d.join_url)}</a><br><span class="post-meta">Put the QR on your flyers, your merch table, your socials.</span></div></div>` : ''}
        <form class="pd-form" id="pdPage">
          <label>Link name <span class="pd-slug">${location.origin}/p/<input name="slug" value="${escapeHtml(p.slug || '')}" placeholder="${escapeHtml(p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'))}" autocomplete="off" autocapitalize="off"></span></label>
          <label>A line about you<textarea name="blurb" maxlength="400" rows="3" placeholder="Who you are and why people should join…">${escapeHtml(p.blurb || '')}</textarea></label>
          <label>Your website or Instagram<input name="link" type="url" inputmode="url" value="${escapeHtml(p.link || '')}" placeholder="https://…"></label>
          <button class="composer-submit">Save my join page</button>
        </form>
      </section>

      <section class="pd-card">
        <h3>📣 Holler at your friends</h3>
        <form class="pd-form" id="pdHoller">
          <label>Who hears it<select name="who"><option value="friends">All ${d.friends} of your friends</option>${past.map(e => `<option value="${e.id}">Everyone who came to ${escapeHtml(e.title)}</option>`).join('')}</select></label>
          <label>Headline<input name="title" maxlength="120" required placeholder="We’re back on the 31st!"></label>
          <label>Message<textarea name="body" maxlength="1500" rows="4" required placeholder="What’s happening, and why they should come…"></textarea></label>
          <label>Link (optional)<input name="url" type="url" inputmode="url" placeholder="https://…"></label>
          <div class="post-meta" id="pdReach"></div>
          <button class="composer-submit">📣 Send the holler</button>
        </form>
      </section>

      <section class="pd-card">
        <h3>Your carnivals</h3>
        ${d.events.length ? d.events.map(e => `
          <div class="door-entry"><div><b>${escapeHtml(e.title)}</b><div class="post-meta">${formatEventDate(e.starts_at)} · ${e.came} came${e.first_time ? `, ${e.first_time} for the first time` : ''}${e.photos_url ? ' · 📸 photos up' : ''}</div></div>
          <a class="raven-offer-no" href="#/event/${e.id}">Open</a></div>`).join('') : '<div class="placeholder-note">No carnivals yet. Post one from Events, or ask the Ringleader to put you on theirs.</div>'}
        <a class="action-btn" href="#/events">+ Post an event</a>
      </section>

      <section class="pd-card">
        <h3>Newest friends</h3>
        ${d.recent.length ? d.recent.map(f => `<div class="door-entry"><div><b>${escapeHtml(f.display_name)}</b><div class="post-meta">${escapeHtml(f.city || '')}${f.event_title ? `${f.city ? ' · ' : ''}met at ${escapeHtml(f.event_title)}` : `${f.city ? ' · ' : ''}joined your page`} · ${new Date(sqlTime(f.met_at)).toLocaleDateString()}</div></div></div>`).join('') : '<div class="placeholder-note">No friends yet. Share your join page!</div>'}
      </section>
    </div>`;
  const page = document.getElementById('pdPage');
  page.addEventListener('submit', async e => {
    e.preventDefault();
    try { await apiFetch(`/api/partner${partnerId ? `?id=${partnerId}` : ''}`, { method: 'PATCH', body: { slug: page.slug.value, blurb: page.blurb.value, link: page.link.value } }); flashToast('Join page saved.'); renderPartnerDesk(mainView, partnerId); }
    catch (err) { flashToast(err.message); }
  });
  const h = document.getElementById('pdHoller');
  const audience = () => h.who.value === 'friends' ? { type: 'friends', value: p.id, label: `${p.name}’s friends` } : { type: 'attended', value: h.who.value, label: h.who.selectedOptions[0].textContent };
  const reach = async () => {
    try { const r = await apiFetch('/api/blasts/preview', { method: 'POST', body: { audience: audience() } }); document.getElementById('pdReach').textContent = `Reaches ${r.recipients} ${r.recipients === 1 ? 'person' : 'people'} (${r.phones} with notifications on).`; }
    catch (e) { document.getElementById('pdReach').textContent = ''; }
  };
  if (mine) reach(); else h.querySelector('button').disabled = true;
  h.who.addEventListener('change', reach);
  h.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = h.querySelector('button'); btn.disabled = true;
    try {
      const r = await apiFetch('/api/blasts', { method: 'POST', body: { title: h.title.value, body: h.body.value, url: h.url.value.trim() || null, audience: audience() } });
      flashToast(`📣 Hollered to ${r.recipients} ${r.recipients === 1 ? 'person' : 'people'}.`); h.reset(); reach();
    } catch (err) { flashToast(err.message); }
    btn.disabled = false;
  });
}

// A partner's public join page (/p/<slug>): name + email, no password.
async function renderJoinPage(slug, errorMsg = '', joined = null) {
  app.innerHTML = `<div class="getin"><div class="getin-card">${getinMarquee('Join the troupe')}<div class="gi-body"><p class="gi-fine">One moment…</p></div></div></div>`;
  let d;
  try { d = await apiFetch(`/api/public/partners/${encodeURIComponent(slug)}`); }
  catch (err) { app.innerHTML = `<div class="getin"><div class="getin-card">${getinMarquee('Hmm.')}<div class="gi-body"><p>${escapeHtml(err.message)}</p></div></div></div>`; return; }
  const pt = d.partner;
  const events = d.events.map(e => `<a class="gi-event" href="#/get/${e.slug || e.id}"><span>${new Date(sqlTime(e.starts_at)).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span><b>${escapeHtml(e.title)}</b>${e.door_cents != null ? '<em>Get in →</em>' : ''}</a>`).join('');
  app.innerHTML = `
    <div class="getin">
      <div class="getin-card">
        ${getinMarquee('Join the troupe')}
        <div class="gi-body">
          <div class="gi-x">Carnival Society <span>×</span></div>
          ${pt.logo ? `<img class="gi-plogo gi-plogo-big" src="${escapeHtml(pt.logo)}" alt="${escapeHtml(pt.name)}">` : `<h1>${escapeHtml(pt.name)}</h1>`}
          ${pt.blurb ? `<p class="gi-desc gi-center">${escapeHtml(pt.blurb)}</p>` : ''}
          ${pt.link ? `<p><a class="gi-link" href="${escapeHtml(pt.link)}" target="_blank" rel="noopener">${escapeHtml(pt.link.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a></p>` : ''}
          ${d.friends >= 5 ? `<p class="gi-count"><b>${d.friends}</b> friends and counting</p>` : ''}
          ${joined ? `<div class="gi-status paid">🤝 ${joined.already ? 'You’re already friends!' : `You joined ${escapeHtml(pt.name)}!`} You’ll hear when they holler.</div>
            ${joined.claim ? `<a class="gi-btn" href="#/claim/${joined.claim}">Claim your Dressing Room →</a><p class="gi-fine">You’re in the Carnival Society now too. Set a password to see your room and what’s coming up.</p>` : ''}`
          : `<form class="gi-form" id="joinForm">
              <label>Your name<input name="name" required maxlength="60" autocomplete="name" value="${escapeHtml(profile?.display_name || '')}"></label>
              <label>Email<input name="email" type="email" required autocomplete="email" inputmode="email" value="${escapeHtml(profile?.email || '')}"></label>
              ${errorMsg ? `<p class="gi-error" role="alert">${escapeHtml(errorMsg)}</p>` : ''}
              <button class="gi-btn" type="submit">🤝 Join ${escapeHtml(pt.name)}</button>
              <p class="gi-fine">No password, no spam. You’ll hear about their nights through Carnival Society, and your email stays private.</p>
            </form>`}
          ${events ? `<h3 class="gi-h3">Coming up</h3><div class="gi-events">${events}</div>` : ''}
        </div>
      </div>
    </div>`;
  document.getElementById('joinForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target; f.querySelector('button').disabled = true;
    try { const r = await apiFetch(`/api/public/partners/${encodeURIComponent(slug)}/join`, { method: 'POST', body: { name: f.name.value, email: f.email.value } }); renderJoinPage(slug, '', r); }
    catch (err) { renderJoinPage(slug, err.message); }
  });
}

// ── The waitlist (2026-10-16) ─────────────────────────────────────────
// New sign-ups wait here until the Ringleader lets them in by hand. They
// can still get tickets; the room and everything behind it stay closed.
async function renderWaitlistScreen() {
  app.innerHTML = `<div class="getin"><div class="getin-card">${getinMarquee('You’re on the list!')}<div class="gi-body"><p class="gi-fine">Finding your place in line…</p></div></div></div>`;
  let d;
  try { d = await apiFetch('/api/me/waitlist'); } catch (e) { d = { waiting: true, position: null, events: [], tickets: [] }; }
  // Let in while they were looking: straight into the app.
  if (!d.waiting) { profile.waitlisted_at = null; await loadAppData(); render(); return; }
  const first = (profile.display_name || '').split(' ')[0];
  const ticketFor = new Set(d.tickets.map(t => t.title));
  app.innerHTML = `
    <div class="getin">
      <div class="getin-card">
        ${getinMarquee('You’re on the list!')}
        <div class="gi-body">
          <h1>Hold tight, ${escapeHtml(first)}!</h1>
          ${d.position ? `<div class="wl-number"><small>You’re</small><b>#${d.position}</b><small>in line</small></div>` : ''}
          <p class="gi-desc gi-center">Carnival Society is opening its doors a few carnies at a time. <b>The Ringleader reads every hello by hand</b>, and you’ll get a nudge (and an email) when it’s your turn.</p>
          ${(() => { let i = null; try { i = JSON.parse(profile.intro || 'null'); } catch (e) { /* none */ } return i ? `<div class="wl-mine"><div class="wl-mine-head">${avatarFor(profile.id, profile.display_name, 44, profile.avatar_url)}<div><b>Your hello</b><small>📍 ${escapeHtml(i.from)}</small></div></div><p>${escapeHtml(i.about)}</p><small>It goes up in the <b>Introduce yourself!</b> thread the moment you’re in.</small></div>` : ''; })()}
          <p class="gi-desc gi-center"><b>You don’t have to wait to come to a carnival.</b> Grab a ticket below and we’ll see you there.</p>
          ${d.tickets.length ? `<h3 class="gi-h3">Your tickets</h3><div class="gi-events">${d.tickets.map(t => `<a class="gi-event" href="#/ticket/${t.code}"><span>${new Date(sqlTime(t.starts_at)).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span><b>${escapeHtml(t.title)}</b><em>${t.status === 'paid' ? 'Show it →' : 'Spot saved →'}</em></a>`).join('')}</div>` : ''}
          ${d.events.filter(e => !ticketFor.has(e.title)).length ? `<h3 class="gi-h3">Coming up</h3><div class="gi-events">${d.events.filter(e => !ticketFor.has(e.title)).map(e => `<a class="gi-event" href="#/get/${e.slug || e.id}"><span>${new Date(sqlTime(e.starts_at)).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span><b>${escapeHtml(e.title)}</b><em>Get in →</em></a>`).join('')}</div>` : ''}
          <button class="gi-btn" id="wlNudge" type="button">🔔 Nudge me when I’m in</button>
          <p class="gi-fine" id="wlNudgeNote"></p>
          <p class="gi-fine"><button class="gi-link" id="wlSignOut" type="button">Sign out</button></p>
        </div>
      </div>
    </div>`;
  const note = document.getElementById('wlNudgeNote');
  try { if (await ravenSubscribed()) { document.getElementById('wlNudge').hidden = true; note.textContent = 'Omen will nudge this phone when you’re in.'; } } catch (e) { /* not supported */ }
  document.getElementById('wlNudge').addEventListener('click', async () => {
    const r = await followRaven();
    if (r === 'on') { document.getElementById('wlNudge').hidden = true; note.textContent = 'Done! Omen will nudge this phone when you’re in.'; }
    else if (r === 'ios-install') showIosInstall();
    else note.textContent = r === 'denied' ? 'Notifications are blocked in your browser settings. Check back here anytime.' : 'This browser can’t do notifications. Check back here anytime.';
  });
  document.getElementById('wlSignOut').addEventListener('click', async () => {
    await apiFetch('/api/auth/signout', { method: 'POST' }).catch(() => {});
    session = false; profile = null; history.replaceState(null, '', '#/'); render();
  });
}

// The Ringleader's Waitlist tab in the Directory: let people in.
async function renderWaitlistTab(mainView) {
  mainView.innerHTML = `
    <h2>Directory</h2>
    <div class="crew-tabs">${DIRECTORY_TABS.map(([key, label]) => `<button class="crew-tab tab-btn ${directoryTab === key ? 'active' : ''}" data-tab="${key}">${label}</button>`).join('')}</div>
    <div class="placeholder-note">Loading the line…</div>`;
  mainView.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => switchDirectoryTab(mainView, b.dataset.tab)));
  const { waiting } = await apiFetch('/api/waitlist');
  mainView.querySelector('.placeholder-note').outerHTML = `<div id="wlBox">
    <p class="admin-note">New sign-ups introduce themselves, then wait here until you let them in. They can still buy tickets. When you let someone in, their hello goes up in the <b>Introduce yourself!</b> thread, and they get a "You’re in!" email and nudge.</p>
    <p class="post-actions"><button class="action-btn" id="testEmails" type="button">✉️ Send me the test emails</button> <span class="post-meta" id="testEmailsNote"></span></p>
    ${waiting.length ? `<div class="post-actions wl-actions"><button class="composer-submit" data-next="10">Let in the next ${Math.min(10, waiting.length)}</button>${waiting.length > 10 ? `<button class="action-btn" data-next="${waiting.length}">Let everyone in (${waiting.length})</button>` : ''}</div>` : ''}
    <div class="door-recent">${waiting.map((w, i) => `
      <div class="door-entry wl-entry">${avatarFor(w.id, w.display_name, 48, w.avatar_url)}<div class="wl-who"><b>#${i + 1} ${escapeHtml(w.display_name)}</b>${w.wants_to_volunteer ? ' <span class="door-first">🙋 wants to volunteer</span>' : ''}${w.came ? ' <span class="door-first">came to a carnival</span>' : w.tickets ? ' <span class="door-first">has a ticket</span>' : ''}
        <div class="post-meta">${escapeHtml(w.city || '')}${w.email ? `${w.city ? ' · ' : ''}${escapeHtml(w.email)}` : ''} · waiting since ${new Date(sqlTime(w.waitlisted_at)).toLocaleDateString()}${w.heard_about_us ? ` · heard: ${escapeHtml(w.heard_about_us)}` : ''}</div>
        ${w.intro ? `<div class="wl-intro"><small>📍 ${escapeHtml(w.intro.from)}${w.skills ? ` · 🎪 ${escapeHtml(w.skills)}` : ''}</small>${escapeHtml(w.intro.about)}</div>` : '<div class="wl-intro none">Hasn’t introduced themself yet.</div>'}</div>
        <button class="composer-submit" data-let="${w.id}">Let in</button></div>`).join('') || '<div class="placeholder-note">Nobody waiting. The line is clear!</div>'}</div></div>`;
  document.getElementById('testEmails').onclick = async ev => {
    const note = document.getElementById('testEmailsNote'); ev.target.disabled = true; note.textContent = 'Sending…';
    try { const r = await apiFetch('/api/admin/test-emails', { method: 'POST' }); note.textContent = `Sent to ${r.to}: ${Object.entries(r.sent).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v ? '✓' : '✗'}`).join(', ')}`; }
    catch (err) { note.textContent = err.message; }
    ev.target.disabled = false;
  };
  mainView.querySelector('#wlBox').addEventListener('click', async e => {
    const one = e.target.closest('[data-let]'), next = e.target.closest('[data-next]');
    if (!one && !next) return;
    e.target.disabled = true;
    try {
      const r = await apiFetch('/api/waitlist/admit', { method: 'POST', body: one ? { ids: [one.dataset.let] } : { next: Number(next.dataset.next) } });
      flashToast(`🎪 Let ${r.admitted} ${r.admitted === 1 ? 'person' : 'people'} in. Huzzah!`);
      renderWaitlistTab(mainView);
    } catch (err) { flashToast(err.message); e.target.disabled = false; }
  });
}

boot();
