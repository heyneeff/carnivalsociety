var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var SESSION_DAYS = 30;
// Assigning members to a specific event's crew is switched off for now (see
// CREW_ASSIGNMENT_ENABLED in members/app.js). While it's off, crew-hub
// content (schedule, meetups, materials, activities, projects) is open to
// every signed-in member for every upcoming event, since there's no way to
// be excluded from a roster that nobody is being added to anyway. Flip this
// back on, alongside the frontend flag, once assignment is back in use.
var CREW_ASSIGNMENT_ENABLED = false;
function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(bytesToHex, "bytesToHex");
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
__name(hexToBytes, "hexToBytes");
async function hashPassword(password, saltHex) {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 1e5, hash: "SHA-256" }, keyMaterial, 256);
  return { hash: bytesToHex(new Uint8Array(bits)), salt: bytesToHex(salt) };
}
__name(hashPassword, "hashPassword");
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
__name(timingSafeEqual, "timingSafeEqual");
async function verifyPassword(password, hashHex, saltHex) {
  const { hash } = await hashPassword(password, saltHex);
  return timingSafeEqual(hash, hashHex);
}
__name(verifyPassword, "verifyPassword");
function parseCookie(header, name) {
  if (!header) return null;
  const found = header.split(";").map((s) => s.trim()).find((c) => c.startsWith(name + "="));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : null;
}
__name(parseCookie, "parseCookie");
function sessionCookie(token, maxAgeSeconds) {
  return `session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}
__name(sessionCookie, "sessionCookie");
async function createSession(env, userId) {
  const token = crypto.randomUUID() + crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400 * 1e3).toISOString();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").bind(token, userId, expiresAt).run();
  return token;
}
__name(createSession, "createSession");
async function getSessionUser(request, env) {
  const token = parseCookie(request.headers.get("Cookie"), "session");
  if (!token) return null;
  return env.DB.prepare(
    `SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.id = ?1 AND sessions.expires_at > datetime('now')`
  ).bind(token).first();
}
__name(getSessionUser, "getSessionUser");
function isModerator(user) {
  return !!user && (user.rank === "master" || !!user.is_ringleader);
}
__name(isModerator, "isModerator");
async function isCrew(env, user, eventId) {
  if (!user) return false;
  if (!CREW_ASSIGNMENT_ENABLED) return true;
  if (isModerator(user)) return true;
  const row = await env.DB.prepare("SELECT 1 FROM event_crew WHERE event_id = ? AND user_id = ?").bind(eventId, user.id).first();
  return !!row;
}
__name(isCrew, "isCrew");
function json(data, init = {}) {
  return new Response(JSON.stringify(data), { ...init, headers: { "Content-Type": "application/json", ...init.headers || {} } });
}
__name(json, "json");
function err(status, message) {
  return json({ error: message }, { status });
}
__name(err, "err");
function publicUser(u) {
  if (!u) return null;
  const { password_hash, salt, ...rest } = u;
  return { ...rest, is_ringleader: !!rest.is_ringleader, dues_paid: !!rest.dues_paid, onboarded: !!rest.onboarded };
}
__name(publicUser, "publicUser");
async function body(request) {
  try {
    return await request.json();
  } catch (e) {
    return {};
  }
}
__name(body, "body");
var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await api(request, env, url);
      } catch (e) {
        console.error(e);
        return err(500, "Server error");
      }
    }
    return env.ASSETS.fetch(request);
  }
};
async function api(request, env, url) {
  const { pathname } = url;
  const method = request.method;
  if (pathname === "/api/auth/signup" && method === "POST") {
    const { email, password, display_name, home_chapter_id } = await body(request);
    if (!email || !password || password.length < 6 || !display_name) return err(400, "Missing or invalid fields.");
    const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
    if (existing) return err(400, "That email is already registered.");
    const { hash, salt } = await hashPassword(password);
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO users (id, email, password_hash, salt, display_name, home_chapter_id) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(id, email, hash, salt, display_name, home_chapter_id || null).run();
    const token = await createSession(env, id);
    const user2 = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
    return json({ user: publicUser(user2) }, { headers: { "Set-Cookie": sessionCookie(token, SESSION_DAYS * 86400) } });
  }
  if (pathname === "/api/auth/signin" && method === "POST") {
    const { email, password } = await body(request);
    const user2 = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email || "").first();
    if (!user2 || !await verifyPassword(password || "", user2.password_hash, user2.salt)) return err(401, "Invalid email or password.");
    const token = await createSession(env, user2.id);
    return json({ user: publicUser(user2) }, { headers: { "Set-Cookie": sessionCookie(token, SESSION_DAYS * 86400) } });
  }
  if (pathname === "/api/auth/signout" && method === "POST") {
    const token = parseCookie(request.headers.get("Cookie"), "session");
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(token).run();
    return json({ ok: true }, { headers: { "Set-Cookie": sessionCookie("", 0) } });
  }
  if (pathname === "/api/me" && method === "GET") {
    const user2 = await getSessionUser(request, env);
    return json({ user: publicUser(user2) });
  }
  if (pathname === "/api/me" && method === "PATCH") {
    const user2 = await getSessionUser(request, env);
    if (!user2) return err(401, "Not signed in.");
    const { display_name, home_chapter_id, avatar_url, birthday, skills, onboarded } = await body(request);
    const updates = [];
    const binds = [];
    if (display_name !== void 0) {
      updates.push("display_name = ?");
      binds.push(display_name);
    }
    if (home_chapter_id !== void 0) {
      updates.push("home_chapter_id = ?");
      binds.push(home_chapter_id);
    }
    if (avatar_url !== void 0) {
      updates.push("avatar_url = ?");
      binds.push(avatar_url);
    }
    if (birthday !== void 0) {
      updates.push("birthday = ?");
      binds.push(birthday);
    }
    if (skills !== void 0) {
      updates.push("skills = ?");
      binds.push(skills);
    }
    if (onboarded !== void 0) {
      updates.push("onboarded = ?");
      binds.push(onboarded ? 1 : 0);
    }
    if (updates.length) {
      binds.push(user2.id);
      await env.DB.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).bind(...binds).run();
    }
    const updated = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user2.id).first();
    return json({ user: publicUser(updated) });
  }
  const user = await getSessionUser(request, env);
  const requireAuth = /* @__PURE__ */ __name(() => user ? null : err(401, "Sign in required."), "requireAuth");
  if (pathname === "/api/chapters" && method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM chapters ORDER BY name").all();
    return json({ chapters: results });
  }
  if (pathname === "/api/boards" && method === "GET") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const { results } = await env.DB.prepare("SELECT * FROM boards").all();
    return json({ boards: results });
  }
  if (pathname === "/api/posts" && method === "GET") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const boardId = url.searchParams.get("board_id");
    if (!boardId) return err(400, "board_id required.");
    const { results } = await env.DB.prepare(
      `SELECT posts.*, users.display_name AS a_name, users.rank AS a_rank, users.is_ringleader AS a_ring
       FROM posts JOIN users ON users.id = posts.author_id
       WHERE posts.board_id = ? AND posts.parent_id IS NULL
       ORDER BY posts.pinned DESC, posts.created_at DESC`
    ).bind(boardId).all();
    return json({ posts: results.map(shapePost) });
  }
  if (pathname === "/api/posts" && method === "POST") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const { board_id, parent_id, title, body: text } = await body(request);
    if (!board_id || !text) return err(400, "board_id and body required.");
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO posts (id, board_id, author_id, parent_id, title, body) VALUES (?, ?, ?, ?, ?, ?)").bind(id, board_id, user.id, parent_id || null, title || null, text).run();
    return json({ id });
  }
  const postMatch = pathname.match(/^\/api\/posts\/([^/]+)$/);
  if (postMatch && method === "GET") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const postId = postMatch[1];
    const post = await env.DB.prepare(
      `SELECT posts.*, users.display_name AS a_name, users.rank AS a_rank, users.is_ringleader AS a_ring
       FROM posts JOIN users ON users.id = posts.author_id WHERE posts.id = ?`
    ).bind(postId).first();
    if (!post) return err(404, "Not found.");
    const { results: replyRows } = await env.DB.prepare(
      `SELECT posts.*, users.display_name AS a_name, users.rank AS a_rank, users.is_ringleader AS a_ring
       FROM posts JOIN users ON users.id = posts.author_id
       WHERE posts.parent_id = ? ORDER BY posts.created_at ASC`
    ).bind(postId).all();
    return json({ post: shapePost(post), replies: replyRows.map(shapePost) });
  }
  if (postMatch && method === "PATCH") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const postId = postMatch[1];
    const existing = await env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(postId).first();
    if (!existing) return err(404, "Not found.");
    if (!isModerator(user)) return err(403, "Moderators only.");
    const { pinned } = await body(request);
    await env.DB.prepare("UPDATE posts SET pinned = ? WHERE id = ?").bind(pinned ? 1 : 0, postId).run();
    return json({ ok: true });
  }
  if (postMatch && method === "DELETE") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const postId = postMatch[1];
    const existing = await env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(postId).first();
    if (!existing) return err(404, "Not found.");
    if (existing.author_id !== user.id && !isModerator(user)) return err(403, "Not allowed.");
    await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(postId).run();
    return json({ ok: true });
  }
  if (pathname === "/api/events" && method === "GET") {
    const archived = url.searchParams.get("scope") === "archived";
    const { results } = await env.DB.prepare(
      archived
        ? `SELECT events.*, chapters.name AS c_name, chapters.slug AS c_slug FROM events
           LEFT JOIN chapters ON chapters.id = events.chapter_id
           WHERE events.starts_at < datetime('now') ORDER BY events.starts_at DESC`
        : `SELECT events.*, chapters.name AS c_name, chapters.slug AS c_slug FROM events
           LEFT JOIN chapters ON chapters.id = events.chapter_id
           WHERE events.starts_at >= datetime('now') ORDER BY events.starts_at ASC`
    ).all();
    return json({ events: results.map(shapeEvent) }, { headers: { "Access-Control-Allow-Origin": "*" } });
  }
  // Public, unauthenticated one-click entry: lists every non-Ringleader
  // member guild-wide so the pre-auth "pick your name" screen can render
  // buttons, and a matching sign-in with no password. Ringleaders always
  // need a real password -- this trades per-click friction for the ability
  // to impersonate any non-Ringleader member, guild-wide, indefinitely, so
  // it's only appropriate because the roster is a small known guild and
  // Ringleader/steward accounts (the ones with real permissions) are exempt.
  if (pathname === "/api/quick-signin-roster" && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT id, display_name FROM users WHERE is_ringleader = 0 ORDER BY display_name`
    ).all();
    return json({ members: results });
  }
  if (pathname === "/api/quick-signin" && method === "POST") {
    const { user_id } = await body(request);
    if (!user_id) return err(400, "user_id required.");
    const candidate = await env.DB.prepare(
      `SELECT * FROM users WHERE id = ? AND is_ringleader = 0`
    ).bind(user_id).first();
    if (!candidate) return err(403, "Not a valid quick sign-in member.");
    const token = await createSession(env, candidate.id);
    return json({ user: publicUser(candidate) }, { headers: { "Set-Cookie": sessionCookie(token, SESSION_DAYS * 86400) } });
  }
  if (pathname === "/api/events" && method === "POST") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!isModerator(user)) return err(403, "Moderators only.");
    const { title, chapter_id, starts_at, location, description } = await body(request);
    if (!title || !starts_at) return err(400, "title and starts_at required.");
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO events (id, chapter_id, title, description, location, starts_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, chapter_id || null, title, description || null, location || null, starts_at, user.id).run();
    return json({ id });
  }
  const eventMatch = pathname.match(/^\/api\/events\/([^/]+)$/);
  if (eventMatch && method === "GET") {
    const eventRow = await env.DB.prepare(
      `SELECT events.*, chapters.name AS c_name, chapters.slug AS c_slug FROM events
       LEFT JOIN chapters ON chapters.id = events.chapter_id WHERE events.id = ?`
    ).bind(eventMatch[1]).first();
    if (!eventRow) return err(404, "Not found.");
    return json({ event: shapeEvent(eventRow) });
  }
  if (eventMatch && method === "PATCH") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!user.is_ringleader) return err(403, "Ringleaders only.");
    const { title, chapter_id, starts_at, location, description } = await body(request);
    const updates = [];
    const binds = [];
    if (title !== void 0) {
      if (!title) return err(400, "title required.");
      updates.push("title = ?");
      binds.push(title);
    }
    if (chapter_id !== void 0) {
      updates.push("chapter_id = ?");
      binds.push(chapter_id || null);
    }
    if (starts_at !== void 0) {
      if (!starts_at) return err(400, "starts_at required.");
      updates.push("starts_at = ?");
      binds.push(starts_at);
    }
    if (location !== void 0) {
      updates.push("location = ?");
      binds.push(location || null);
    }
    if (description !== void 0) {
      updates.push("description = ?");
      binds.push(description || null);
    }
    if (!updates.length) return err(400, "Nothing to update.");
    binds.push(eventMatch[1]);
    await env.DB.prepare(`UPDATE events SET ${updates.join(", ")} WHERE id = ?`).bind(...binds).run();
    return json({ ok: true });
  }
  if (eventMatch && method === "DELETE") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!isModerator(user)) return err(403, "Moderators only.");
    await env.DB.prepare("DELETE FROM events WHERE id = ?").bind(eventMatch[1]).run();
    return json({ ok: true });
  }
  if (pathname === "/api/me/crew" && method === "GET") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const stmt = (!CREW_ASSIGNMENT_ENABLED || isModerator(user)) ? env.DB.prepare(
      `SELECT events.*, chapters.name AS c_name, chapters.slug AS c_slug FROM events
       LEFT JOIN chapters ON chapters.id = events.chapter_id
       WHERE events.starts_at >= datetime('now') ORDER BY events.starts_at ASC`
    ) : env.DB.prepare(
      `SELECT events.*, chapters.name AS c_name, chapters.slug AS c_slug FROM event_crew
       JOIN events ON events.id = event_crew.event_id
       LEFT JOIN chapters ON chapters.id = events.chapter_id
       WHERE event_crew.user_id = ? AND events.starts_at >= datetime('now')
       ORDER BY events.starts_at ASC`
    ).bind(user.id);
    const { results } = await stmt.all();
    return json({ events: results.map(shapeEvent) });
  }
  const crewMatch = pathname.match(/^\/api\/events\/([^/]+)\/crew$/);
  if (crewMatch && method === "GET") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!await isCrew(env, user, crewMatch[1])) return err(403, "Crew only.");
    const { results } = await env.DB.prepare(
      `SELECT event_crew.event_id, users.id, users.display_name, users.rank, users.is_ringleader
       FROM event_crew JOIN users ON users.id = event_crew.user_id
       WHERE event_crew.event_id = ? ORDER BY users.display_name`
    ).bind(crewMatch[1]).all();
    return json({ crew: results.map((m) => ({ ...m, is_ringleader: !!m.is_ringleader })) });
  }
  if (crewMatch && method === "POST") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!isModerator(user)) return err(403, "Moderators only.");
    const { user_id } = await body(request);
    if (!user_id) return err(400, "user_id required.");
    await env.DB.prepare("INSERT OR IGNORE INTO event_crew (event_id, user_id) VALUES (?, ?)").bind(crewMatch[1], user_id).run();
    return json({ ok: true });
  }
  const crewMemberMatch = pathname.match(/^\/api\/events\/([^/]+)\/crew\/([^/]+)$/);
  if (crewMemberMatch && method === "DELETE") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!isModerator(user)) return err(403, "Moderators only.");
    await env.DB.prepare("DELETE FROM event_crew WHERE event_id = ? AND user_id = ?").bind(crewMemberMatch[1], crewMemberMatch[2]).run();
    return json({ ok: true });
  }
  const meetupsMatch = pathname.match(/^\/api\/events\/([^/]+)\/meetups$/);
  if (meetupsMatch && method === "GET") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const eventId = meetupsMatch[1];
    if (!await isCrew(env, user, eventId)) return err(403, "Crew only.");
    const { results: meetups } = await env.DB.prepare("SELECT * FROM event_meetups WHERE event_id = ? ORDER BY proposed_at ASC").bind(eventId).all();
    const { results: rsvps } = await env.DB.prepare(
      `SELECT event_meetup_rsvps.*, users.display_name FROM event_meetup_rsvps
       JOIN users ON users.id = event_meetup_rsvps.user_id
       JOIN event_meetups ON event_meetups.id = event_meetup_rsvps.meetup_id
       WHERE event_meetups.event_id = ?`
    ).bind(eventId).all();
    const rsvpsByMeetup = {};
    for (const r of rsvps) (rsvpsByMeetup[r.meetup_id] || (rsvpsByMeetup[r.meetup_id] = [])).push({ user_id: r.user_id, display_name: r.display_name, response: r.response });
    return json({ meetups: meetups.map((m) => ({ ...m, rsvps: rsvpsByMeetup[m.id] || [] })) });
  }
  if (meetupsMatch && method === "POST") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const eventId = meetupsMatch[1];
    if (!await isCrew(env, user, eventId)) return err(403, "Crew only.");
    const { proposed_at, location, notes, category } = await body(request);
    if (!proposed_at) return err(400, "proposed_at required.");
    if (category !== void 0 && !["meeting", "field_trip"].includes(category)) return err(400, "category must be meeting/field_trip.");
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO event_meetups (id, event_id, proposed_at, location, notes, category, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, eventId, proposed_at, location || null, notes || null, category || "meeting", user.id).run();
    return json({ id });
  }
  const meetupMatch = pathname.match(/^\/api\/events\/([^/]+)\/meetups\/([^/]+)$/);
  if (meetupMatch && method === "DELETE") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const [, eventId, meetupId] = meetupMatch;
    if (!await isCrew(env, user, eventId)) return err(403, "Crew only.");
    await env.DB.prepare("DELETE FROM event_meetups WHERE id = ?").bind(meetupId).run();
    return json({ ok: true });
  }
  const rsvpMatch = pathname.match(/^\/api\/meetups\/([^/]+)\/rsvp$/);
  if (rsvpMatch && method === "PUT") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const meetupId = rsvpMatch[1];
    const meetup = await env.DB.prepare("SELECT event_id FROM event_meetups WHERE id = ?").bind(meetupId).first();
    if (!meetup) return err(404, "Not found.");
    if (!await isCrew(env, user, meetup.event_id)) return err(403, "Crew only.");
    const { response } = await body(request);
    if (!["yes", "no", "maybe"].includes(response)) return err(400, "response must be yes/no/maybe.");
    await env.DB.prepare(
      `INSERT INTO event_meetup_rsvps (meetup_id, user_id, response, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(meetup_id, user_id) DO UPDATE SET response = excluded.response, updated_at = datetime('now')`
    ).bind(meetupId, user.id, response).run();
    return json({ ok: true });
  }
  const projectsMatch = pathname.match(/^\/api\/events\/([^/]+)\/projects$/);
  if (projectsMatch && method === "GET") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const eventId = projectsMatch[1];
    if (!await isCrew(env, user, eventId)) return err(403, "Crew only.");
    const { results: projects } = await env.DB.prepare("SELECT * FROM event_projects WHERE event_id = ? ORDER BY position ASC, created_at ASC").bind(eventId).all();
    const projectIds = projects.map((p) => p.id);
    let items = [];
    if (projectIds.length) {
      const placeholders = projectIds.map(() => "?").join(",");
      const { results } = await env.DB.prepare(`SELECT * FROM event_project_items WHERE project_id IN (${placeholders}) ORDER BY position ASC`).bind(...projectIds).all();
      items = results;
    }
    const itemsByProject = {};
    for (const it of items) (itemsByProject[it.project_id] || (itemsByProject[it.project_id] = [])).push({ id: it.id, text: it.text, done: !!it.done, position: it.position });
    return json({ projects: projects.map((p) => ({ ...p, items: itemsByProject[p.id] || [] })) });
  }
  if (projectsMatch && method === "POST") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const eventId = projectsMatch[1];
    if (!await isCrew(env, user, eventId)) return err(403, "Crew only.");
    const { name, description, deadline, parent_id, position } = await body(request);
    if (!name) return err(400, "name required.");
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO event_projects (id, event_id, parent_id, name, description, deadline, position, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, eventId, parent_id || null, name, description || null, deadline || null, position || 0, user.id).run();
    return json({ id });
  }
  const projectMatch = pathname.match(/^\/api\/events\/([^/]+)\/projects\/([^/]+)$/);
  if (projectMatch && method === "PATCH") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const [, eventId, projectId] = projectMatch;
    if (!await isCrew(env, user, eventId)) return err(403, "Crew only.");
    const { name, description, deadline, status, parent_id, position } = await body(request);
    const updates = [];
    const binds = [];
    if (name !== void 0) { updates.push("name = ?"); binds.push(name); }
    if (description !== void 0) { updates.push("description = ?"); binds.push(description); }
    if (deadline !== void 0) { updates.push("deadline = ?"); binds.push(deadline); }
    if (status !== void 0) { updates.push("status = ?"); binds.push(status); }
    if (parent_id !== void 0) { updates.push("parent_id = ?"); binds.push(parent_id); }
    if (position !== void 0) { updates.push("position = ?"); binds.push(position); }
    if (!updates.length) return err(400, "Nothing to update.");
    updates.push(`updated_at = datetime('now')`);
    binds.push(projectId);
    await env.DB.prepare(`UPDATE event_projects SET ${updates.join(", ")} WHERE id = ?`).bind(...binds).run();
    return json({ ok: true });
  }
  if (projectMatch && method === "DELETE") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const [, eventId, projectId] = projectMatch;
    if (!await isCrew(env, user, eventId)) return err(403, "Crew only.");
    await env.DB.prepare("DELETE FROM event_projects WHERE id = ?").bind(projectId).run();
    return json({ ok: true });
  }
  const projectItemsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/items$/);
  if (projectItemsMatch && method === "POST") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const projectId = projectItemsMatch[1];
    const project = await env.DB.prepare("SELECT event_id FROM event_projects WHERE id = ?").bind(projectId).first();
    if (!project) return err(404, "Not found.");
    if (!await isCrew(env, user, project.event_id)) return err(403, "Crew only.");
    const { text, position } = await body(request);
    if (!text) return err(400, "text required.");
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO event_project_items (id, project_id, text, position) VALUES (?, ?, ?, ?)").bind(id, projectId, text, position || 0).run();
    return json({ id });
  }
  const projectItemMatch = pathname.match(/^\/api\/projects\/([^/]+)\/items\/([^/]+)$/);
  if (projectItemMatch && method === "PATCH") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const [, projectId, itemId] = projectItemMatch;
    const project = await env.DB.prepare("SELECT event_id FROM event_projects WHERE id = ?").bind(projectId).first();
    if (!project) return err(404, "Not found.");
    if (!await isCrew(env, user, project.event_id)) return err(403, "Crew only.");
    const { text, done, position } = await body(request);
    const updates = [];
    const binds = [];
    if (text !== void 0) { updates.push("text = ?"); binds.push(text); }
    if (done !== void 0) { updates.push("done = ?"); binds.push(done ? 1 : 0); }
    if (position !== void 0) { updates.push("position = ?"); binds.push(position); }
    if (!updates.length) return err(400, "Nothing to update.");
    binds.push(itemId);
    await env.DB.prepare(`UPDATE event_project_items SET ${updates.join(", ")} WHERE id = ?`).bind(...binds).run();
    return json({ ok: true });
  }
  if (projectItemMatch && method === "DELETE") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const [, projectId, itemId] = projectItemMatch;
    const project = await env.DB.prepare("SELECT event_id FROM event_projects WHERE id = ?").bind(projectId).first();
    if (!project) return err(404, "Not found.");
    if (!await isCrew(env, user, project.event_id)) return err(403, "Crew only.");
    await env.DB.prepare("DELETE FROM event_project_items WHERE id = ?").bind(itemId).run();
    return json({ ok: true });
  }
  const activitiesMatch = pathname.match(/^\/api\/events\/([^/]+)\/activities$/);
  if (activitiesMatch && method === "GET") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const eventId = activitiesMatch[1];
    if (!await isCrew(env, user, eventId)) return err(403, "Crew only.");
    const { results } = await env.DB.prepare(
      "SELECT * FROM event_activities WHERE event_id = ? ORDER BY (starts_at IS NULL), starts_at ASC, position ASC, created_at ASC"
    ).bind(eventId).all();
    return json({ activities: results });
  }
  if (activitiesMatch && method === "POST") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const eventId = activitiesMatch[1];
    if (!await isCrew(env, user, eventId)) return err(403, "Crew only.");
    const { kind, name, description, starts_at, ends_at, location, position } = await body(request);
    if (!name) return err(400, "name required.");
    if (!["game", "event"].includes(kind)) return err(400, "kind must be game/event.");
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO event_activities (id, event_id, kind, name, description, starts_at, ends_at, location, position, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, eventId, kind, name, description || null, starts_at || null, ends_at || null, location || null, position || 0, user.id).run();
    return json({ id });
  }
  const activityMatch = pathname.match(/^\/api\/events\/([^/]+)\/activities\/([^/]+)$/);
  if (activityMatch && method === "PATCH") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const [, eventId, activityId] = activityMatch;
    if (!await isCrew(env, user, eventId)) return err(403, "Crew only.");
    const { name, description, starts_at, ends_at, location, status, position } = await body(request);
    if (status !== void 0 && !["proposed", "locked_in"].includes(status)) return err(400, "status must be proposed/locked_in.");
    const updates = [];
    const binds = [];
    if (name !== void 0) { updates.push("name = ?"); binds.push(name); }
    if (description !== void 0) { updates.push("description = ?"); binds.push(description); }
    if (starts_at !== void 0) { updates.push("starts_at = ?"); binds.push(starts_at); }
    if (ends_at !== void 0) { updates.push("ends_at = ?"); binds.push(ends_at); }
    if (location !== void 0) { updates.push("location = ?"); binds.push(location); }
    if (status !== void 0) { updates.push("status = ?"); binds.push(status); }
    if (position !== void 0) { updates.push("position = ?"); binds.push(position); }
    if (!updates.length) return err(400, "Nothing to update.");
    binds.push(activityId);
    await env.DB.prepare(`UPDATE event_activities SET ${updates.join(", ")} WHERE id = ?`).bind(...binds).run();
    if (status !== void 0) {
      // Materials tied to this game/event follow its status: locked in ->
      // need, still proposed -> want. Keeps the shared Materials tab in
      // sync automatically instead of requiring a second manual edit.
      await env.DB.prepare("UPDATE event_materials SET category = ? WHERE activity_id = ?")
        .bind(status === "locked_in" ? "need" : "want", activityId).run();
    }
    return json({ ok: true });
  }
  if (activityMatch && method === "DELETE") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const [, eventId, activityId] = activityMatch;
    if (!await isCrew(env, user, eventId)) return err(403, "Crew only.");
    await env.DB.prepare("DELETE FROM event_activities WHERE id = ?").bind(activityId).run();
    return json({ ok: true });
  }
  const materialsMatch = pathname.match(/^\/api\/events\/([^/]+)\/materials$/);
  if (materialsMatch && method === "GET") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const eventId = materialsMatch[1];
    if (!await isCrew(env, user, eventId)) return err(403, "Crew only.");
    const { results } = await env.DB.prepare("SELECT * FROM event_materials WHERE event_id = ? ORDER BY position ASC, created_at ASC").bind(eventId).all();
    return json({ materials: results });
  }
  if (materialsMatch && method === "POST") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const eventId = materialsMatch[1];
    if (!await isCrew(env, user, eventId)) return err(403, "Crew only.");
    const { item, category, activity_id, position } = await body(request);
    if (!item) return err(400, "item required.");
    if (category !== void 0 && !["need", "want"].includes(category)) return err(400, "category must be need/want.");
    // No explicit category: derive it from the linked game/event's status
    // (locked in -> need, still proposed -> want) so items added under an
    // activity don't need a second manual choice. Materials added directly
    // in the Materials tab (no activity_id) default to need, as before.
    let finalCategory = category;
    if (finalCategory === void 0) {
      if (activity_id) {
        const act = await env.DB.prepare("SELECT status FROM event_activities WHERE id = ?").bind(activity_id).first();
        finalCategory = act && act.status === "locked_in" ? "need" : "want";
      } else {
        finalCategory = "need";
      }
    }
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO event_materials (id, event_id, item, category, activity_id, position, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, eventId, item, finalCategory, activity_id || null, position || 0, user.id).run();
    return json({ id });
  }
  const materialMatch = pathname.match(/^\/api\/events\/([^/]+)\/materials\/([^/]+)$/);
  if (materialMatch && method === "PATCH") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const [, eventId, materialId] = materialMatch;
    if (!await isCrew(env, user, eventId)) return err(403, "Crew only.");
    const { item, category, activity_id, position } = await body(request);
    if (category !== void 0 && !["need", "want"].includes(category)) return err(400, "category must be need/want.");
    const updates = [];
    const binds = [];
    if (item !== void 0) { updates.push("item = ?"); binds.push(item); }
    if (category !== void 0) { updates.push("category = ?"); binds.push(category); }
    if (activity_id !== void 0) { updates.push("activity_id = ?"); binds.push(activity_id); }
    if (position !== void 0) { updates.push("position = ?"); binds.push(position); }
    if (!updates.length) return err(400, "Nothing to update.");
    binds.push(materialId);
    await env.DB.prepare(`UPDATE event_materials SET ${updates.join(", ")} WHERE id = ?`).bind(...binds).run();
    return json({ ok: true });
  }
  if (materialMatch && method === "DELETE") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const [, eventId, materialId] = materialMatch;
    if (!await isCrew(env, user, eventId)) return err(403, "Crew only.");
    await env.DB.prepare("DELETE FROM event_materials WHERE id = ?").bind(materialId).run();
    return json({ ok: true });
  }
  if (pathname === "/api/members" && method === "GET") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!user.is_ringleader) return err(403, "Ringleaders only.");
    const { results } = await env.DB.prepare(
      `SELECT users.*, chapters.name AS c_name FROM users LEFT JOIN chapters ON chapters.id = users.home_chapter_id
       ORDER BY users.display_name`
    ).all();
    return json({ members: results.map(shapeMember) });
  }
  if (pathname === "/api/members" && method === "POST") {
    // Ringleader-created member: no email/password from the admin, no
    // session swap (unlike /api/auth/signup, which would otherwise log the
    // Ringleader out and into the new account). Meant for people who'll
    // never sign in with a password at all -- they get in via quick-pick.
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!user.is_ringleader) return err(403, "Ringleaders only.");
    const { display_name, home_chapter_id } = await body(request);
    if (!display_name) return err(400, "display_name required.");
    const slug = display_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "member";
    const email = `${slug}-${bytesToHex(crypto.getRandomValues(new Uint8Array(3)))}@crew.local`;
    const { hash, salt } = await hashPassword(crypto.randomUUID());
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO users (id, email, password_hash, salt, display_name, home_chapter_id, onboarded) VALUES (?, ?, ?, ?, ?, ?, 1)`
    ).bind(id, email, hash, salt, display_name, home_chapter_id || null).run();
    const created = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
    return json({ user: publicUser(created) });
  }
  const memberMatch = pathname.match(/^\/api\/members\/([^/]+)$/);
  if (memberMatch && method === "PATCH") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!user.is_ringleader) return err(403, "Ringleaders only.");
    const { display_name, home_chapter_id, birthday, skills, rank, is_ringleader, dues_paid, dues_amount, dues_date, steward_role } = await body(request);
    const updates = [];
    const binds = [];
    if (display_name !== void 0) {
      if (!display_name) return err(400, "display_name required.");
      updates.push("display_name = ?");
      binds.push(display_name);
    }
    if (home_chapter_id !== void 0) {
      updates.push("home_chapter_id = ?");
      binds.push(home_chapter_id || null);
    }
    if (birthday !== void 0) {
      updates.push("birthday = ?");
      binds.push(birthday || null);
    }
    if (skills !== void 0) {
      updates.push("skills = ?");
      binds.push(skills || null);
    }
    if (rank !== void 0) {
      updates.push("rank = ?");
      binds.push(rank);
    }
    if (is_ringleader !== void 0) {
      updates.push("is_ringleader = ?");
      binds.push(is_ringleader ? 1 : 0);
    }
    if (dues_paid !== void 0) {
      updates.push("dues_paid = ?");
      binds.push(dues_paid ? 1 : 0);
    }
    if (dues_amount !== void 0) {
      updates.push("dues_amount = ?");
      binds.push(dues_amount);
    }
    if (dues_date !== void 0) {
      updates.push("dues_date = ?");
      binds.push(dues_date);
    }
    if (steward_role !== void 0) {
      updates.push("steward_role = ?");
      binds.push(steward_role || null);
    }
    if (!updates.length) return err(400, "Nothing to update.");
    binds.push(memberMatch[1]);
    await env.DB.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).bind(...binds).run();
    return json({ ok: true });
  }
  if (pathname === "/api/members/search" && method === "GET") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const chapterId = url.searchParams.get("chapter_id") || "";
    const rank = url.searchParams.get("rank") || "";
    let sql = `SELECT users.*, chapters.name AS c_name FROM users LEFT JOIN chapters ON chapters.id = users.home_chapter_id WHERE users.id != ?`;
    const binds = [user.id];
    if (q) {
      sql += " AND lower(users.display_name) LIKE ?";
      binds.push(`%${q}%`);
    }
    if (chapterId) {
      sql += " AND users.home_chapter_id = ?";
      binds.push(chapterId);
    }
    if (rank) {
      sql += " AND users.rank = ?";
      binds.push(rank);
    }
    sql += " ORDER BY users.display_name";
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    return json({ members: results.map(shapeMember) });
  }
  if (pathname === "/api/connections" && method === "POST") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const { connected_user_id } = await body(request);
    if (!connected_user_id || connected_user_id === user.id) return err(400, "Invalid connected_user_id.");
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT OR IGNORE INTO member_connections (id, user_id, connected_user_id) VALUES (?, ?, ?)").bind(id, user.id, connected_user_id).run();
    return json({ ok: true });
  }
  if (pathname === "/api/network" && method === "GET") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!user.is_ringleader) return err(403, "Ringleaders only.");
    const { results: members } = await env.DB.prepare(
      `SELECT users.id, users.display_name, users.rank, users.is_ringleader, users.skills, users.birthday,
              users.home_chapter_id, chapters.name AS c_name
       FROM users LEFT JOIN chapters ON chapters.id = users.home_chapter_id
       ORDER BY users.display_name`
    ).all();
    const { results: connRows } = await env.DB.prepare("SELECT user_id, connected_user_id FROM member_connections").all();
    const seen = /* @__PURE__ */ new Set();
    const connections = [];
    for (const row of connRows) {
      const pair = [row.user_id, row.connected_user_id].sort().join("|");
      if (seen.has(pair)) continue;
      seen.add(pair);
      connections.push({ from: row.user_id, to: row.connected_user_id });
    }
    return json({
      members: members.map((m) => ({
        id: m.id,
        display_name: m.display_name,
        rank: m.rank,
        is_ringleader: !!m.is_ringleader,
        skills: m.skills ? m.skills.split(",").map((s) => s.trim()).filter(Boolean) : [],
        birthday: m.birthday,
        home_chapter_id: m.home_chapter_id,
        home_chapter: m.home_chapter_id ? { name: m.c_name } : null
      })),
      connections
    });
  }
  if (pathname === "/api/field" && method === "GET") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!user.is_ringleader) return err(403, "Ringleaders only.");
    const row = await env.DB.prepare("SELECT * FROM field_data WHERE user_id = ?").bind(user.id).first();
    if (!row) {
      return json({ center_name: user.display_name, communities: [], reltypes: [], people: [], connections: [], layouts: {} });
    }
    return json({
      center_name: row.center_name || user.display_name,
      communities: JSON.parse(row.communities),
      reltypes: JSON.parse(row.reltypes),
      people: JSON.parse(row.people),
      connections: JSON.parse(row.connections),
      layouts: JSON.parse(row.layouts)
    });
  }
  if (pathname === "/api/field" && method === "PUT") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!user.is_ringleader) return err(403, "Ringleaders only.");
    const { center_name, communities, reltypes, people, connections, layouts } = await body(request);
    const existing = await env.DB.prepare("SELECT user_id FROM field_data WHERE user_id = ?").bind(user.id).first();
    const cols = { center_name, communities, reltypes, people, connections, layouts };
    if (!existing) {
      await env.DB.prepare(
        `INSERT INTO field_data (user_id, center_name, communities, reltypes, people, connections, layouts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        user.id,
        center_name ?? user.display_name,
        JSON.stringify(communities ?? []),
        JSON.stringify(reltypes ?? []),
        JSON.stringify(people ?? []),
        JSON.stringify(connections ?? []),
        JSON.stringify(layouts ?? {})
      ).run();
      return json({ ok: true });
    }
    const updates = [];
    const binds = [];
    if (center_name !== void 0) {
      updates.push("center_name = ?");
      binds.push(center_name);
    }
    if (communities !== void 0) {
      updates.push("communities = ?");
      binds.push(JSON.stringify(communities));
    }
    if (reltypes !== void 0) {
      updates.push("reltypes = ?");
      binds.push(JSON.stringify(reltypes));
    }
    if (people !== void 0) {
      updates.push("people = ?");
      binds.push(JSON.stringify(people));
    }
    if (connections !== void 0) {
      updates.push("connections = ?");
      binds.push(JSON.stringify(connections));
    }
    if (layouts !== void 0) {
      updates.push("layouts = ?");
      binds.push(JSON.stringify(layouts));
    }
    if (!updates.length) return err(400, "Nothing to update.");
    updates.push(`updated_at = datetime('now')`);
    binds.push(user.id);
    await env.DB.prepare(`UPDATE field_data SET ${updates.join(", ")} WHERE user_id = ?`).bind(...binds).run();
    return json({ ok: true });
  }
  if (pathname === "/api/projects" && method === "GET") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!user.is_ringleader) return err(403, "Ringleaders only.");
    const row = await env.DB.prepare("SELECT * FROM projects_data WHERE user_id = ?").bind(user.id).first();
    if (!row) return json({ projects: [], todos: [], leadership_docs: [] });
    return json({ projects: JSON.parse(row.projects), todos: JSON.parse(row.todos), leadership_docs: JSON.parse(row.leadership_docs) });
  }
  if (pathname === "/api/projects" && method === "PUT") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!user.is_ringleader) return err(403, "Ringleaders only.");
    const { projects, todos, leadership_docs } = await body(request);
    const existing = await env.DB.prepare("SELECT user_id FROM projects_data WHERE user_id = ?").bind(user.id).first();
    if (!existing) {
      await env.DB.prepare("INSERT INTO projects_data (user_id, projects, todos, leadership_docs) VALUES (?, ?, ?, ?)").bind(user.id, JSON.stringify(projects ?? []), JSON.stringify(todos ?? []), JSON.stringify(leadership_docs ?? [])).run();
      return json({ ok: true });
    }
    const updates = [];
    const binds = [];
    if (projects !== void 0) {
      updates.push("projects = ?");
      binds.push(JSON.stringify(projects));
    }
    if (todos !== void 0) {
      updates.push("todos = ?");
      binds.push(JSON.stringify(todos));
    }
    if (leadership_docs !== void 0) {
      updates.push("leadership_docs = ?");
      binds.push(JSON.stringify(leadership_docs));
    }
    if (!updates.length) return err(400, "Nothing to update.");
    updates.push(`updated_at = datetime('now')`);
    binds.push(user.id);
    await env.DB.prepare(`UPDATE projects_data SET ${updates.join(", ")} WHERE user_id = ?`).bind(...binds).run();
    return json({ ok: true });
  }
  if (pathname === "/api/dm/conversations" && method === "GET") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const { results: mine } = await env.DB.prepare("SELECT conversation_id FROM conversation_participants WHERE user_id = ?").bind(user.id).all();
    const convIds = mine.map((r) => r.conversation_id);
    if (!convIds.length) return json({ conversations: [] });
    const placeholders = convIds.map(() => "?").join(",");
    const { results: others } = await env.DB.prepare(
      `SELECT conversation_participants.conversation_id, users.id, users.display_name, users.rank, users.is_ringleader
       FROM conversation_participants JOIN users ON users.id = conversation_participants.user_id
       WHERE conversation_participants.conversation_id IN (${placeholders}) AND conversation_participants.user_id != ?`
    ).bind(...convIds, user.id).all();
    const { results: lastMessages } = await env.DB.prepare(
      `SELECT * FROM direct_messages WHERE conversation_id IN (${placeholders}) ORDER BY created_at DESC`
    ).bind(...convIds).all();
    const lastByConv = {};
    for (const m of lastMessages) if (!lastByConv[m.conversation_id]) lastByConv[m.conversation_id] = m;
    const conversations = others.map((o) => ({
      conversation_id: o.conversation_id,
      other: { id: o.id, display_name: o.display_name, rank: o.rank, is_ringleader: !!o.is_ringleader },
      last: lastByConv[o.conversation_id] || null
    })).sort((a, b) => (b.last ? new Date(b.last.created_at) : 0) - (a.last ? new Date(a.last.created_at) : 0));
    return json({ conversations });
  }
  if (pathname === "/api/dm/conversations" && method === "POST") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const { other_user_id } = await body(request);
    if (!other_user_id) return err(400, "other_user_id required.");
    const { results: shared } = await env.DB.prepare(
      `SELECT cp1.conversation_id FROM conversation_participants cp1
       JOIN conversation_participants cp2 ON cp1.conversation_id = cp2.conversation_id
       WHERE cp1.user_id = ? AND cp2.user_id = ?`
    ).bind(user.id, other_user_id).all();
    if (shared.length) return json({ conversation_id: shared[0].conversation_id });
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO conversations (id) VALUES (?)").bind(id).run();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)").bind(id, user.id),
      env.DB.prepare("INSERT INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)").bind(id, other_user_id)
    ]);
    return json({ conversation_id: id });
  }
  const dmMessagesMatch = pathname.match(/^\/api\/dm\/([^/]+)\/messages$/);
  if (dmMessagesMatch && method === "GET") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const convId = dmMessagesMatch[1];
    const participant = await env.DB.prepare("SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?").bind(convId, user.id).first();
    if (!participant) return err(403, "Not a participant.");
    const { results: other } = await env.DB.prepare(
      `SELECT users.id, users.display_name FROM conversation_participants
       JOIN users ON users.id = conversation_participants.user_id
       WHERE conversation_participants.conversation_id = ? AND conversation_participants.user_id != ?`
    ).bind(convId, user.id).all();
    const { results: messages } = await env.DB.prepare("SELECT * FROM direct_messages WHERE conversation_id = ? ORDER BY created_at ASC").bind(convId).all();
    return json({ other: other[0] || null, messages });
  }
  if (dmMessagesMatch && method === "POST") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const convId = dmMessagesMatch[1];
    const participant = await env.DB.prepare("SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?").bind(convId, user.id).first();
    if (!participant) return err(403, "Not a participant.");
    const { body: text } = await body(request);
    if (!text) return err(400, "body required.");
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO direct_messages (id, conversation_id, sender_id, body) VALUES (?, ?, ?, ?)").bind(id, convId, user.id, text).run();
    return json({ id });
  }
  return err(404, "Not found.");
}
__name(api, "api");
function shapePost(row) {
  return {
    id: row.id,
    board_id: row.board_id,
    author_id: row.author_id,
    parent_id: row.parent_id,
    title: row.title,
    body: row.body,
    pinned: !!row.pinned,
    created_at: row.created_at,
    author: { display_name: row.a_name, rank: row.a_rank, is_ringleader: !!row.a_ring }
  };
}
__name(shapePost, "shapePost");
function shapeEvent(row) {
  return {
    id: row.id,
    chapter_id: row.chapter_id,
    title: row.title,
    description: row.description,
    location: row.location,
    starts_at: row.starts_at,
    created_by: row.created_by,
    created_at: row.created_at,
    chapter: row.chapter_id ? { name: row.c_name, slug: row.c_slug } : null
  };
}
__name(shapeEvent, "shapeEvent");
function shapeMember(row) {
  return {
    id: row.id,
    display_name: row.display_name,
    rank: row.rank,
    is_ringleader: !!row.is_ringleader,
    home_chapter_id: row.home_chapter_id,
    home_chapter: row.home_chapter_id ? { name: row.c_name } : null,
    dues_paid: !!row.dues_paid,
    dues_amount: row.dues_amount,
    dues_date: row.dues_date,
    steward_role: row.steward_role || null,
    birthday: row.birthday || null,
    skills: row.skills || ""
  };
}
__name(shapeMember, "shapeMember");
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map