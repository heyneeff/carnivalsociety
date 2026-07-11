// ── Supabase connection ──────────────────────────────────────────────
// Fill these in from Project Settings → API once the carnivalsociety-members
// Supabase project exists. The anon public key is meant to be public — access
// control is enforced by the RLS policies in schema.sql, not by hiding this key.
const SUPABASE_URL = 'https://fybutdykshkfpccihxqp.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ5YnV0ZHlrc2hrZnBjY2loeHFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM3ODExMzUsImV4cCI6MjA5OTM1NzEzNX0.cHJ47xag73Om9mtPuj-YE9SOva5MPYWJD1aGKxTPvik';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const app = document.getElementById('app');
let session = null;
let profile = null;
let chapters = [];
let boards = [];

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
  const { data } = await sb.auth.getSession();
  session = data.session;
  if (session) await loadAppData();
  render();
  sb.auth.onAuthStateChange(async (_event, newSession) => {
    session = newSession;
    if (session) await loadAppData();
    else { profile = null; chapters = []; boards = []; }
    render();
  });
}

async function loadAppData() {
  const [{ data: profileData }, { data: chapterData }, { data: boardData }] = await Promise.all([
    sb.from('profiles').select('*').eq('id', session.user.id).single(),
    sb.from('chapters').select('*').order('name'),
    sb.from('boards').select('*'),
  ]);
  profile = profileData;
  chapters = chapterData || [];
  boards = boardData || [];
}

window.addEventListener('hashchange', render);

// ── Render root ───────────────────────────────────────────────────────
function render() {
  if (!session) { renderAuthScreen(); return; }
  renderShell();
}

// ── Auth screen ──────────────────────────────────────────────────────
function renderAuthScreen(mode = 'signin', errorMsg = '') {
  const chapterOptions = chapters.length
    ? chapters.map(c => `<option value="${c.id}">${c.name}</option>`).join('')
    : '<option value="">Loading chapters…</option>';

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
    </div>
  `;

  document.getElementById('tabSignin').onclick = () => renderAuthScreen('signin');
  document.getElementById('tabSignup').onclick = async () => {
    if (!chapters.length) { const { data } = await sb.from('chapters').select('*').order('name'); chapters = data || []; }
    renderAuthScreen('signup');
  };

  document.getElementById('authForm').addEventListener('submit', async e => {
    e.preventDefault();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    if (mode === 'signup') {
      const displayName = document.getElementById('displayName').value.trim();
      const homeChapterId = document.getElementById('homeChapter').value;
      const { data, error } = await sb.auth.signUp({
        email, password, options: { data: { display_name: displayName } },
      });
      if (error) { renderAuthScreen('signup', error.message); return; }
      if (data.session) {
        session = data.session;
        await loadAppData();
        if (profile) await sb.from('profiles').update({ home_chapter_id: homeChapterId }).eq('id', session.user.id);
        await loadAppData();
        render();
      } else {
        renderAuthScreen('signin', 'Check your email to confirm your account, then sign in.');
      }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) { renderAuthScreen('signin', error.message); return; }
    }
  });
}

// ── App shell ────────────────────────────────────────────────────────
function currentRoute() {
  return window.location.hash.replace(/^#\/?/, '') || 'guild-hall';
}

function renderShell() {
  const route = currentRoute();
  const initials = (profile?.display_name || '?').trim().slice(0, 1).toUpperCase();
  const rankLabel = profile ? profile.rank.charAt(0).toUpperCase() + profile.rank.slice(1) : '';
  const ringleaderTag = profile?.is_ringleader ? ' · Ringleader' : '';

  const chapterLinks = chapters.map(c => `
    <li><a class="nav-link ${route === c.slug ? 'active' : ''}" href="#/${c.slug}">${c.name}</a></li>
  `).join('');

  app.innerHTML = `
    <div class="shell">
      <div class="sidebar">
        <div class="sidebar-mark">
          <span class="crest">Carnival Society</span>
          <span class="crest-sub">Guild Hall</span>
        </div>
        <div>
          <div class="nav-group-label">Boards</div>
          <ul class="nav-list">
            <li><a class="nav-link ${route === 'guild-hall' ? 'active' : ''}" href="#/guild-hall">Guild Hall</a></li>
            ${chapterLinks}
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

  document.getElementById('signoutBtn').onclick = async () => { await sb.auth.signOut(); };

  renderMainView(route);
}

function renderMainView(route) {
  const mainView = document.getElementById('mainView');
  unsubscribeDM();
  if (route === 'dm') { renderDMListView(mainView); return; }
  if (route.startsWith('dm/')) { renderDMThreadView(mainView, route.slice(3)); return; }
  if (route === 'events') { renderEventsView(mainView); return; }
  if (route === 'admin') { renderAdminView(mainView); return; }
  if (route.startsWith('post/')) { renderThreadView(mainView, route.slice(5)); return; }
  renderBoardView(mainView, route);
}

function authorBadge(authorProfile) {
  if (!authorProfile) return '';
  const rank = authorProfile.rank.charAt(0).toUpperCase() + authorProfile.rank.slice(1);
  const ring = authorProfile.is_ringleader ? ' · Ringleader' : '';
  return `<span class="rank-tag">${escapeHtml(rank)}${escapeHtml(ring)}</span>`;
}

function isModerator() {
  return !!profile && (profile.rank === 'master' || profile.is_ringleader);
}

// ── Board view: composer + top-level post list ─────────────────────────
async function renderBoardView(mainView, slug) {
  const board = boards.find(b => b.slug === slug);
  if (!board) {
    mainView.innerHTML = `<h2>Not found</h2><div class="placeholder-note">That board doesn't exist.</div>`;
    return;
  }
  mainView.innerHTML = `<h2>${escapeHtml(board.name)}</h2><div class="placeholder-note">Loading…</div>`;

  const { data: posts } = await sb
    .from('posts')
    .select('*, author:profiles(display_name, rank, is_ringleader)')
    .eq('board_id', board.id)
    .is('parent_id', null)
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false });

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
    <h2>${escapeHtml(board.name)}</h2>
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
    await sb.from('posts').insert({ board_id: board.id, author_id: session.user.id, title, body });
    renderBoardView(mainView, slug);
  });

  mainView.querySelectorAll('.post-card').forEach(card => {
    card.addEventListener('click', () => { window.location.hash = `#/post/${card.dataset.postId}`; });
  });
}

// ── Thread view: single post + replies ─────────────────────────────────
async function renderThreadView(mainView, postId) {
  mainView.innerHTML = `<div class="placeholder-note">Loading…</div>`;

  const { data: post } = await sb
    .from('posts')
    .select('*, author:profiles(display_name, rank, is_ringleader)')
    .eq('id', postId)
    .single();

  if (!post) {
    mainView.innerHTML = `<h2>Not found</h2><div class="placeholder-note">That post doesn't exist.</div>`;
    return;
  }

  const board = boards.find(b => b.id === post.board_id);
  const { data: replies } = await sb
    .from('posts')
    .select('*, author:profiles(display_name, rank, is_ringleader)')
    .eq('parent_id', postId)
    .order('created_at', { ascending: true });

  const canModerate = isModerator();
  const isAuthor = post.author_id === session.user.id;

  const postActions = (isAuthor || canModerate) ? `
    <div class="post-actions">
      ${canModerate ? `<button class="action-btn" id="pinBtn">${post.pinned ? 'Unpin' : 'Pin'}</button>` : ''}
      <button class="action-btn danger" id="deletePostBtn">Delete</button>
    </div>` : '';

  const replyListHtml = (replies || []).map(r => `
    <div class="reply-card" data-reply-id="${r.id}">
      <div class="post-meta">${escapeHtml(r.author?.display_name || 'unknown')} ${authorBadge(r.author)} · ${timeAgo(r.created_at)}</div>
      <div class="reply-body">${escapeHtml(r.body)}</div>
      ${(r.author_id === session.user.id || canModerate) ? `<div class="post-actions"><button class="action-btn danger" data-delete-reply="${r.id}">Delete</button></div>` : ''}
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
    await sb.from('posts').insert({ board_id: post.board_id, author_id: session.user.id, parent_id: postId, body });
    renderThreadView(mainView, postId);
  });

  const pinBtn = document.getElementById('pinBtn');
  if (pinBtn) pinBtn.addEventListener('click', async () => {
    await sb.from('posts').update({ pinned: !post.pinned }).eq('id', postId);
    renderThreadView(mainView, postId);
  });

  const deletePostBtn = document.getElementById('deletePostBtn');
  if (deletePostBtn) deletePostBtn.addEventListener('click', async () => {
    if (!confirm('Delete this post and all its replies?')) return;
    await sb.from('posts').delete().eq('id', postId);
    window.location.hash = `#/${board ? board.slug : 'guild-hall'}`;
  });

  mainView.querySelectorAll('[data-delete-reply]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this reply?')) return;
      await sb.from('posts').delete().eq('id', btn.dataset.deleteReply);
      renderThreadView(mainView, postId);
    });
  });
}

// ── Direct messages ──────────────────────────────────────────────────
let dmChannel = null;
function unsubscribeDM() {
  if (dmChannel) { sb.removeChannel(dmChannel); dmChannel = null; }
}

async function renderDMListView(mainView) {
  mainView.innerHTML = `<h2>Messages</h2><div class="placeholder-note">Loading…</div>`;

  const { data: myRows } = await sb.from('conversation_participants').select('conversation_id').eq('user_id', session.user.id);
  const convIds = (myRows || []).map(r => r.conversation_id);

  let conversations = [];
  if (convIds.length) {
    const [{ data: participantRows }, { data: messages }] = await Promise.all([
      sb.from('conversation_participants')
        .select('conversation_id, user:profiles(id, display_name, rank, is_ringleader)')
        .in('conversation_id', convIds)
        .neq('user_id', session.user.id),
      sb.from('direct_messages')
        .select('*')
        .in('conversation_id', convIds)
        .order('created_at', { ascending: false }),
    ]);

    const lastByConv = {};
    (messages || []).forEach(m => { if (!lastByConv[m.conversation_id]) lastByConv[m.conversation_id] = m; });

    conversations = (participantRows || []).map(p => ({
      conversationId: p.conversation_id,
      other: p.user,
      last: lastByConv[p.conversation_id],
    })).sort((a, b) => {
      const at = a.last ? new Date(a.last.created_at).getTime() : 0;
      const bt = b.last ? new Date(b.last.created_at).getTime() : 0;
      return bt - at;
    });
  }

  const listHtml = conversations.length ? conversations.map(c => `
    <div class="post-card" data-conv-id="${c.conversationId}">
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

  const { data: members } = await sb
    .from('profiles')
    .select('*, home_chapter:chapters(id, name)')
    .neq('id', session.user.id)
    .order('display_name');
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
        <option value="apprentice">Apprentice</option>
        <option value="journeyman">Journeyman</option>
        <option value="master">Master</option>
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
  // RLS on conversation_participants only returns rows for conversations I'm
  // also in, so this query is already the intersection of "their conversations
  // and mine" — anything it returns is a conversation we already share.
  const { data: shared } = await sb.from('conversation_participants').select('conversation_id').eq('user_id', otherUserId);
  if (shared && shared.length) { window.location.hash = `#/dm/${shared[0].conversation_id}`; return; }

  const { data: conv, error } = await sb.from('conversations').insert({}).select().single();
  if (error || !conv) return;
  await sb.from('conversation_participants').insert([
    { conversation_id: conv.id, user_id: session.user.id },
    { conversation_id: conv.id, user_id: otherUserId },
  ]);
  window.location.hash = `#/dm/${conv.id}`;
}

function dmBubbleHtml(m) {
  const mine = m.sender_id === session.user.id;
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

  const { data: participantRows } = await sb
    .from('conversation_participants')
    .select('user:profiles(id, display_name, rank, is_ringleader)')
    .eq('conversation_id', convId)
    .neq('user_id', session.user.id);
  const other = participantRows && participantRows[0] ? participantRows[0].user : null;

  const { data: messages } = await sb
    .from('direct_messages')
    .select('*')
    .eq('conversation_id', convId)
    .order('created_at', { ascending: true });

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
    const body = bodyInput.value.trim();
    if (!body) return;
    bodyInput.value = '';
    appendDMMessage({ sender_id: session.user.id, body });
    await sb.from('direct_messages').insert({ conversation_id: convId, sender_id: session.user.id, body });
  });

  // Realtime: the sender already sees their own message via the optimistic
  // append above, so only render incoming inserts from the other participant.
  dmChannel = sb.channel(`dm-${convId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'direct_messages', filter: `conversation_id=eq.${convId}` }, payload => {
      if (payload.new.sender_id === session.user.id) return;
      appendDMMessage(payload.new);
    })
    .subscribe();
}

// ── Events ───────────────────────────────────────────────────────────
function formatEventDate(iso) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

async function renderEventsView(mainView) {
  mainView.innerHTML = `<h2>Events</h2><div class="placeholder-note">Loading…</div>`;

  const { data: events } = await sb
    .from('events')
    .select('*, chapter:chapters(name, slug)')
    .gte('starts_at', new Date().toISOString())
    .order('starts_at', { ascending: true });

  const canManage = isModerator();

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
      ${canManage ? `<div class="post-actions"><button class="action-btn danger" data-delete-event="${e.id}">Delete</button></div>` : ''}
    </div>
  `).join('') : '<div class="placeholder-note">Nothing scheduled yet.</div>';

  mainView.innerHTML = `<h2>Events</h2>${composerHtml}<div class="post-list">${listHtml}</div>`;

  if (canManage) {
    document.getElementById('eventComposer').addEventListener('submit', async e => {
      e.preventDefault();
      const title = document.getElementById('eventTitle').value.trim();
      const chapterId = document.getElementById('eventChapter').value || null;
      const startsAt = document.getElementById('eventStarts').value;
      const location = document.getElementById('eventLocation').value.trim();
      const description = document.getElementById('eventDescription').value.trim();
      if (!title || !startsAt) return;
      await sb.from('events').insert({
        title, chapter_id: chapterId, starts_at: new Date(startsAt).toISOString(),
        location: location || null, description: description || null, created_by: session.user.id,
      });
      renderEventsView(mainView);
    });
  }

  mainView.querySelectorAll('[data-delete-event]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this event?')) return;
      await sb.from('events').delete().eq('id', btn.dataset.deleteEvent);
      renderEventsView(mainView);
    });
  });
}

// ── Ringleader hub: manage every member's rank/permissions ─────────────
async function renderAdminView(mainView) {
  if (!profile?.is_ringleader) {
    mainView.innerHTML = `<h2>Not authorized</h2><div class="placeholder-note">Ringleaders only.</div>`;
    return;
  }
  mainView.innerHTML = `<h2>Members Hub</h2><div class="placeholder-note">Loading…</div>`;

  const { data: members } = await sb
    .from('profiles')
    .select('*, home_chapter:chapters(name)')
    .order('display_name');

  const rowsHtml = (members || []).map(m => `
    <div class="admin-row" data-user-id="${m.id}">
      <div class="admin-identity">
        <div class="admin-name">${escapeHtml(m.display_name)}</div>
        <div class="admin-chapter">${m.home_chapter ? escapeHtml(m.home_chapter.name) : 'No chapter'}</div>
      </div>
      <select class="admin-rank" data-field="rank">
        ${['apprentice', 'journeyman', 'master'].map(r =>
          `<option value="${r}" ${m.rank === r ? 'selected' : ''}>${r.charAt(0).toUpperCase() + r.slice(1)}</option>`
        ).join('')}
      </select>
      <label class="admin-ringleader-toggle">
        <input type="checkbox" data-field="is_ringleader" ${m.is_ringleader ? 'checked' : ''}>
        Ringleader
      </label>
    </div>
  `).join('') || '<div class="placeholder-note">No members yet.</div>';

  mainView.innerHTML = `
    <h2>Members Hub</h2>
    <p class="admin-note">Every member of the guild. Changes save immediately.</p>
    <div class="admin-list">${rowsHtml}</div>
  `;

  mainView.querySelectorAll('.admin-row').forEach(row => {
    const userId = row.dataset.userId;
    const rankSelect = row.querySelector('[data-field="rank"]');
    const ringleaderCheckbox = row.querySelector('[data-field="is_ringleader"]');
    rankSelect.addEventListener('change', async () => {
      await sb.from('profiles').update({ rank: rankSelect.value }).eq('id', userId);
      if (userId === session.user.id) await loadAppData();
    });
    ringleaderCheckbox.addEventListener('change', async () => {
      await sb.from('profiles').update({ is_ringleader: ringleaderCheckbox.checked }).eq('id', userId);
      if (userId === session.user.id) { await loadAppData(); renderShell(); }
    });
  });
}

boot();
