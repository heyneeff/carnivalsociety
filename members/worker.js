// Carnival Society International — members app backend.
// Replaces Supabase (Postgres + Auth + Realtime) with Cloudflare D1 + this Worker.
// Serves /api/* itself; everything else falls through to the static assets
// (index.html / styles.css / app.js) via env.ASSETS.


var SESSION_DAYS = 30;
var CREW_ASSIGNMENT_ENABLED = false;
function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
async function hashPassword(password, saltHex) {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 1e5, hash: "SHA-256" }, keyMaterial, 256);
  return { hash: bytesToHex(new Uint8Array(bits)), salt: bytesToHex(salt) };
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function verifyPassword(password, hashHex, saltHex) {
  const { hash } = await hashPassword(password, saltHex);
  return timingSafeEqual(hash, hashHex);
}
function parseCookie(header, name) {
  if (!header) return null;
  const found = header.split(";").map((s) => s.trim()).find((c) => c.startsWith(name + "="));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : null;
}
function sessionCookie(token, maxAgeSeconds) {
  return `session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}
async function createSession(env, userId) {
  const token = crypto.randomUUID() + crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400 * 1e3).toISOString();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").bind(token, userId, expiresAt).run();
  return token;
}
async function getSessionUser(request, env) {
  const token = parseCookie(request.headers.get("Cookie"), "session");
  if (!token) return null;
  return env.DB.prepare(
    `SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.id = ?1 AND sessions.expires_at > datetime('now')`
  ).bind(token).first();
}
function isModerator(user) {
  return !!user && (user.rank === "master" || !!user.is_ringleader);
}
async function isCrew(env, user, eventId) {
  if (!user) return false;
  if (!CREW_ASSIGNMENT_ENABLED) return true;
  if (isModerator(user)) return true;
  const row = await env.DB.prepare("SELECT 1 FROM event_crew WHERE event_id = ? AND user_id = ?").bind(eventId, user.id).first();
  return !!row;
}
function json(data, init = {}) {
  return new Response(JSON.stringify(data), { ...init, headers: { "Content-Type": "application/json", ...init.headers || {} } });
}
function err(status, message) {
  return json({ error: message }, { status });
}
// CORS: the public marketing site (carnivalsociety.org, a separate origin
// from members.carnivalsociety.org) hosts a real intake form that signs
// people up directly against this API. Only the specific routes that form
// needs (chapters list, signup) get cross-origin headers — everything else
// stays same-origin-only, since it's all session-cookie-gated anyway and a
// cookie set for one origin isn't usable from the other regardless.
const PUBLIC_SITE_ORIGIN = "https://carnivalsociety.org";
function withCors(response) {
  response.headers.set("Access-Control-Allow-Origin", PUBLIC_SITE_ORIGIN);
  response.headers.set("Vary", "Origin");
  return response;
}
function publicUser(u) {
  if (!u) return null;
  const { password_hash, salt, ...rest } = u;
  return { ...rest, is_ringleader: !!rest.is_ringleader, dues_paid: !!rest.dues_paid, onboarded: !!rest.onboarded };
}
async function body(request) {
  try {
    return await request.json();
  } catch (e) {
    return {};
  }
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // DEV_ALLOW_HTTP: local `wrangler dev --var DEV_ALLOW_HTTP:1` only, so a
    // browser can test without a self-signed cert. Never set in production.
    if (url.protocol === "http:" && !env.DEV_ALLOW_HTTP) {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS" && (url.pathname === "/api/auth/signup" || url.pathname === "/api/chapters" || url.pathname === "/api/config")) {
        return withCors(new Response(null, { status: 204, headers: { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } }));
      }
      try {
        return await api(request, env, url, ctx);
      } catch (e) {
        console.error(e);
        return err(500, "Server error");
      }
    }
    return env.ASSETS.fetch(request);
  },
  // Daily housekeeping (cron in wrangler.jsonc): expired sessions and reset
  // tokens otherwise accumulate forever — every sign-in adds a session row.
  async scheduled(event, env, ctx) {
    await env.DB.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
    await env.DB.prepare("DELETE FROM password_resets WHERE expires_at < datetime('now', '-1 day')").run();
  }
};
// Per-IP throttle on the unauthenticated auth endpoints (Workers rate-limit
// binding, see wrangler.jsonc). Absent binding (plain local dev) = no limit.
async function rateLimited(env, request, bucket) {
  if (!env.AUTH_LIMITER) return false;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const { success } = await env.AUTH_LIMITER.limit({ key: bucket + ":" + ip });
  return !success;
}
// Cloudflare Turnstile — enforced only once TURNSTILE_SECRET is set, so the
// signup forms keep working until the widget keys exist.
async function turnstileOk(env, request, token) {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  form.append("remoteip", request.headers.get("CF-Connecting-IP") || "");
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  return !!data.success;
}
function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}
function siteUrl(env) {
  return env.SITE_URL || "https://members.carnivalsociety.org";
}
// Resend (https://resend.com). RESEND_API_KEY secret; EMAIL_FROM var must be
// on a domain verified in Resend (carnivalsociety.org).
async function sendEmail(env, { to, subject, html, text }) {
  if (!env.RESEND_API_KEY) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM || "Carnival Society <hello@carnivalsociety.org>", to, subject, html, text })
  });
  if (!res.ok) console.error("Resend", res.status, await res.text());
  return res.ok;
}
function escapeEmailHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
async function sha256Hex(text) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}
async function api(request, env, url, ctx) {
  const { pathname } = url;
  const method = request.method;
  // Public: lets both signup forms (here and carnivalsociety.org) know which
  // optional features are switched on without hardcoding keys.
  if (pathname === "/api/config" && method === "GET") {
    return withCors(json({
      turnstile_site_key: env.TURNSTILE_SITE_KEY || null,
      payments_enabled: !!env.STRIPE_SECRET_KEY,
      password_reset_enabled: !!env.RESEND_API_KEY
    }));
  }
  if (pathname === "/api/auth/signup" && method === "POST") {
    if (await rateLimited(env, request, "signup")) return withCors(err(429, "Too many attempts. Wait a minute and try again."));
    const { email: rawEmail, password, display_name, home_chapter_id, city, phone, instagram_handle, is_organization, materials_to_donate, heard_about_us, turnstile_token } = await body(request);
    const email = normalizeEmail(rawEmail);
    if (!email || !password || password.length < 6 || !display_name || !city) return withCors(err(400, "Missing or invalid fields."));
    if (!await turnstileOk(env, request, turnstile_token)) return withCors(err(400, "Couldn't verify you're human. Refresh and try again."));
    const existing = await env.DB.prepare("SELECT id FROM users WHERE lower(email) = ?").bind(email).first();
    if (existing) return withCors(err(400, "That email is already registered."));
    const { hash, salt } = await hashPassword(password);
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO users (id, email, password_hash, salt, display_name, home_chapter_id, city, phone, instagram_handle, rank, is_organization, materials_to_donate, heard_about_us) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'clown', ?, ?, ?)`
    ).bind(id, email, hash, salt, display_name, home_chapter_id || null, city, phone || null, instagram_handle || null, is_organization ? 1 : 0, materials_to_donate || null, heard_about_us || null).run();
    const token = await createSession(env, id);
    const user2 = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
    ctx.waitUntil(sendWelcomeEmail(env, user2));
    // Signup from the public site (a different origin) can't use this cookie
    // anyway — cookies aren't shared cross-domain — so the CORS header is
    // what matters there; same-origin members-app signup still gets its
    // session normally via the Set-Cookie below.
    return withCors(json({ user: publicUser(user2) }, { headers: { "Set-Cookie": sessionCookie(token, SESSION_DAYS * 86400) } }));
  }
  if (pathname === "/api/auth/signin" && method === "POST") {
    if (await rateLimited(env, request, "signin")) return err(429, "Too many attempts. Wait a minute and try again.");
    const { email, password } = await body(request);
    const user2 = await env.DB.prepare("SELECT * FROM users WHERE lower(email) = ?").bind(normalizeEmail(email)).first();
    if (!user2 || !await verifyPassword(password || "", user2.password_hash, user2.salt)) return err(401, "Invalid email or password.");
    const token = await createSession(env, user2.id);
    return json({ user: publicUser(user2) }, { headers: { "Set-Cookie": sessionCookie(token, SESSION_DAYS * 86400) } });
  }
  if (pathname === "/api/auth/forgot" && method === "POST") {
    if (await rateLimited(env, request, "forgot")) return err(429, "Too many attempts. Wait a minute and try again.");
    if (!env.RESEND_API_KEY) return err(503, "Password reset by email isn't switched on yet. Message a Ringleader to reset it.");
    const { email } = await body(request);
    const target = await env.DB.prepare("SELECT id, email, display_name FROM users WHERE lower(email) = ?").bind(normalizeEmail(email)).first();
    // Same response whether or not the account exists — no account probing.
    if (target) {
      const token = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
      await env.DB.prepare("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 hour'))").bind(await sha256Hex(token), target.id).run();
      const link = siteUrl(env) + "/#/reset/" + token;
      ctx.waitUntil(sendEmail(env, {
        to: target.email,
        subject: "Reset your Carnival Society password",
        text: `Hi ${target.display_name},\n\nReset your password here (link works for 1 hour, once):\n${link}\n\nIf you didn't ask for this, ignore this email.`,
        html: `<p>Hi ${escapeEmailHtml(target.display_name)},</p><p><a href="${link}">Reset your password</a> — the link works once, for 1 hour.</p><p>If you didn't ask for this, ignore this email.</p>`
      }));
    }
    return json({ ok: true });
  }
  if (pathname === "/api/auth/reset" && method === "POST") {
    if (await rateLimited(env, request, "reset")) return err(429, "Too many attempts. Wait a minute and try again.");
    const { token, password } = await body(request);
    if (!token || !password || password.length < 6) return err(400, "Password must be at least 6 characters.");
    const tokenHash = await sha256Hex(token);
    const row = await env.DB.prepare("SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')").bind(tokenHash).first();
    if (!row) return err(400, "That reset link is invalid or expired. Request a new one.");
    const { hash, salt } = await hashPassword(password);
    await env.DB.batch([
      env.DB.prepare("UPDATE password_resets SET used_at = datetime('now') WHERE token_hash = ?").bind(tokenHash),
      env.DB.prepare("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?").bind(hash, salt, row.user_id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(row.user_id)
    ]);
    const sessionToken = await createSession(env, row.user_id);
    const user2 = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(row.user_id).first();
    return json({ user: publicUser(user2) }, { headers: { "Set-Cookie": sessionCookie(sessionToken, SESSION_DAYS * 86400) } });
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
    const { display_name, home_chapter_id, avatar_url, birthday, skills, onboarded, knows_who, heard_about_us, materials_to_donate, celebrated_rank } = await body(request);
    const updates = [];
    const binds = [];
    // Acknowledging the "welcome inside" moment; can only mark the rank you hold.
    if (celebrated_rank !== void 0 && celebrated_rank === user2.rank) {
      updates.push("celebrated_rank = ?");
      binds.push(celebrated_rank);
    }
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
    if (knows_who !== void 0) {
      updates.push("knows_who = ?");
      binds.push(knows_who || null);
    }
    if (heard_about_us !== void 0) {
      updates.push("heard_about_us = ?");
      binds.push(heard_about_us || null);
    }
    if (materials_to_donate !== void 0) {
      updates.push("materials_to_donate = ?");
      binds.push(materials_to_donate || null);
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
  const requireAuth = () => user ? null : err(401, "Sign in required.");
  // Throttled to one write per user per hour — feeds drift/activity views.
  if (user && (!user.last_seen_at || Date.parse(user.last_seen_at.replace(" ", "T") + "Z") < Date.now() - 3600e3)) {
    ctx.waitUntil(env.DB.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?").bind(user.id).run());
  }
  // Courtyard gate: free accounts reach public info, the Courtyard board
  // (read-only), volunteering, and the path to becoming an inner member.
  // Everything else below needs tier = inner.
  if (user && !isInner(user) && !courtyardAllowed(method, pathname)) return err(403, "Inner members only.");
  if (pathname === "/api/chapters" && method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM chapters ORDER BY name").all();
    return withCors(json({ chapters: results }));
  }
  if (pathname === "/api/boards" && method === "GET") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const { results } = isInner(user)
      ? await env.DB.prepare("SELECT * FROM boards").all()
      : await env.DB.prepare("SELECT * FROM boards WHERE slug = ?").bind(COURTYARD_SLUG).all();
    return json({ boards: results });
  }
  if (pathname === "/api/posts" && method === "GET") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const boardId = url.searchParams.get("board_id");
    if (!boardId) return err(400, "board_id required.");
    if (!isInner(user) && !await isCourtyardBoard(env, boardId)) return err(403, "Inner members only.");
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
    if (!parent_id && !isModerator(user) && await isCourtyardBoard(env, board_id)) return err(403, "Only Ringleaders start threads in the Courtyard.");
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
    if (!isInner(user) && !await isCourtyardBoard(env, post.board_id)) return err(403, "Inner members only.");
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
      archived ? `SELECT events.*, chapters.name AS c_name, chapters.slug AS c_slug FROM events
           LEFT JOIN chapters ON chapters.id = events.chapter_id
           WHERE COALESCE(events.ends_at, events.starts_at) < datetime('now') ORDER BY events.starts_at DESC` : `SELECT events.*, chapters.name AS c_name, chapters.slug AS c_slug FROM events
           LEFT JOIN chapters ON chapters.id = events.chapter_id
           WHERE COALESCE(events.ends_at, events.starts_at) >= datetime('now') ORDER BY events.starts_at ASC`
    ).all();
    return json({ events: results.map(shapeEvent) }, { headers: { "Access-Control-Allow-Origin": "*" } });
  }
  if (pathname === "/api/events" && method === "POST") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!isModerator(user)) return err(403, "Moderators only.");
    const { title, chapter_id, starts_at, ends_at, location, description } = await body(request);
    if (!title || !starts_at) return err(400, "title and starts_at required.");
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO events (id, chapter_id, title, description, location, starts_at, ends_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, chapter_id || null, title, description || null, location || null, starts_at, ends_at || null, user.id).run();
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
    const { title, chapter_id, starts_at, ends_at, location, description } = await body(request);
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
    if (ends_at !== void 0) {
      updates.push("ends_at = ?");
      binds.push(ends_at || null);
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
    const stmt = !CREW_ASSIGNMENT_ENABLED || isModerator(user) ? env.DB.prepare(
      `SELECT events.*, chapters.name AS c_name, chapters.slug AS c_slug FROM events
       LEFT JOIN chapters ON chapters.id = events.chapter_id
       WHERE COALESCE(events.ends_at, events.starts_at) >= datetime('now') ORDER BY events.starts_at ASC`
    ) : env.DB.prepare(
      `SELECT events.*, chapters.name AS c_name, chapters.slug AS c_slug FROM event_crew
       JOIN events ON events.id = event_crew.event_id
       LEFT JOIN chapters ON chapters.id = events.chapter_id
       WHERE event_crew.user_id = ? AND COALESCE(events.ends_at, events.starts_at) >= datetime('now')
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
    if (name !== void 0) {
      updates.push("name = ?");
      binds.push(name);
    }
    if (description !== void 0) {
      updates.push("description = ?");
      binds.push(description);
    }
    if (deadline !== void 0) {
      updates.push("deadline = ?");
      binds.push(deadline);
    }
    if (status !== void 0) {
      updates.push("status = ?");
      binds.push(status);
    }
    if (parent_id !== void 0) {
      updates.push("parent_id = ?");
      binds.push(parent_id);
    }
    if (position !== void 0) {
      updates.push("position = ?");
      binds.push(position);
    }
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
    if (text !== void 0) {
      updates.push("text = ?");
      binds.push(text);
    }
    if (done !== void 0) {
      updates.push("done = ?");
      binds.push(done ? 1 : 0);
    }
    if (position !== void 0) {
      updates.push("position = ?");
      binds.push(position);
    }
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
      `SELECT * FROM event_activities
       WHERE event_id = ?
       ORDER BY (starts_at IS NULL), starts_at ASC, position ASC, created_at ASC`
    ).bind(eventId).all();
    if (results.length) {
      const placeholders = results.map(() => "?").join(",");
      const { results: assigneeRows } = await env.DB.prepare(
        `SELECT event_activity_assignees.activity_id AS activity_id, users.id AS id, users.display_name AS display_name
         FROM event_activity_assignees JOIN users ON users.id = event_activity_assignees.user_id
         WHERE event_activity_assignees.activity_id IN (${placeholders})`
      ).bind(...results.map((a) => a.id)).all();
      const byActivity = {};
      for (const row of assigneeRows) (byActivity[row.activity_id] || (byActivity[row.activity_id] = [])).push({ id: row.id, display_name: row.display_name });
      for (const a of results) a.assignees = byActivity[a.id] || [];
    }
    return json({ activities: results });
  }
  if (activitiesMatch && method === "POST") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const eventId = activitiesMatch[1];
    if (!await isCrew(env, user, eventId)) return err(403, "Crew only.");
    const { kind, name, description, starts_at, ends_at, location, status, assignee_ids, position } = await body(request);
    if (!name) return err(400, "name required.");
    if (!["game", "event"].includes(kind)) return err(400, "kind must be game/event.");
    if (status !== void 0 && !["proposed", "locked_in"].includes(status)) return err(400, "status must be proposed/locked_in.");
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO event_activities (id, event_id, kind, name, description, starts_at, ends_at, location, status, position, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, eventId, kind, name, description || null, starts_at || null, ends_at || null, location || null, status || "proposed", position || 0, user.id).run();
    for (const uid of assignee_ids || []) {
      await env.DB.prepare("INSERT INTO event_activity_assignees (activity_id, user_id) VALUES (?, ?)").bind(id, uid).run();
    }
    return json({ id });
  }
  const activityMatch = pathname.match(/^\/api\/events\/([^/]+)\/activities\/([^/]+)$/);
  if (activityMatch && method === "PATCH") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const [, eventId, activityId] = activityMatch;
    if (!await isCrew(env, user, eventId)) return err(403, "Crew only.");
    const { name, description, starts_at, ends_at, location, status, assignee_ids, schedule_day, schedule_slot, schedule_position, position } = await body(request);
    if (status !== void 0 && !["proposed", "locked_in"].includes(status)) return err(400, "status must be proposed/locked_in.");
    const updates = [];
    const binds = [];
    if (name !== void 0) {
      updates.push("name = ?");
      binds.push(name);
    }
    if (description !== void 0) {
      updates.push("description = ?");
      binds.push(description);
    }
    if (starts_at !== void 0) {
      updates.push("starts_at = ?");
      binds.push(starts_at);
    }
    if (ends_at !== void 0) {
      updates.push("ends_at = ?");
      binds.push(ends_at);
    }
    if (location !== void 0) {
      updates.push("location = ?");
      binds.push(location);
    }
    if (status !== void 0) {
      updates.push("status = ?");
      binds.push(status);
    }
    if (schedule_day !== void 0) {
      updates.push("schedule_day = ?");
      binds.push(schedule_day);
    }
    if (schedule_slot !== void 0) {
      updates.push("schedule_slot = ?");
      binds.push(schedule_slot);
    }
    if (schedule_position !== void 0) {
      updates.push("schedule_position = ?");
      binds.push(schedule_position);
    }
    if (position !== void 0) {
      updates.push("position = ?");
      binds.push(position);
    }
    if (!updates.length && assignee_ids === void 0) return err(400, "Nothing to update.");
    if (updates.length) {
      binds.push(activityId);
      await env.DB.prepare(`UPDATE event_activities SET ${updates.join(", ")} WHERE id = ?`).bind(...binds).run();
    }
    if (assignee_ids !== void 0) {
      await env.DB.prepare("DELETE FROM event_activity_assignees WHERE activity_id = ?").bind(activityId).run();
      for (const uid of assignee_ids) {
        await env.DB.prepare("INSERT INTO event_activity_assignees (activity_id, user_id) VALUES (?, ?)").bind(activityId, uid).run();
      }
    }
    if (status !== void 0) {
      await env.DB.prepare("UPDATE event_materials SET category = ? WHERE activity_id = ?").bind(status === "locked_in" ? "need" : "want", activityId).run();
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
    const { item, category, activity_id, priority, position } = await body(request);
    if (category !== void 0 && !["need", "want"].includes(category)) return err(400, "category must be need/want.");
    const updates = [];
    const binds = [];
    if (item !== void 0) {
      updates.push("item = ?");
      binds.push(item);
    }
    if (category !== void 0) {
      updates.push("category = ?");
      binds.push(category);
    }
    if (activity_id !== void 0) {
      updates.push("activity_id = ?");
      binds.push(activity_id);
    }
    if (priority !== void 0) {
      updates.push("priority = ?");
      binds.push(priority ? 1 : 0);
    }
    if (position !== void 0) {
      updates.push("position = ?");
      binds.push(position);
    }
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
  const merchMatch = pathname.match(/^\/api\/events\/([^/]+)\/merch$/);
  if (merchMatch && method === "GET") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const eventId = merchMatch[1];
    if (!await isCrew(env, user, eventId)) return err(403, "Crew only.");
    const { results } = await env.DB.prepare(
      `SELECT event_merch.*, users.display_name AS assignee_name FROM event_merch
       LEFT JOIN users ON users.id = event_merch.assignee_id
       WHERE event_merch.event_id = ? ORDER BY event_merch.position ASC, event_merch.created_at ASC`
    ).bind(eventId).all();
    return json({ merch: results });
  }
  if (merchMatch && method === "POST") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const eventId = merchMatch[1];
    if (!await isCrew(env, user, eventId)) return err(403, "Crew only.");
    const { name, assignee_id, status, position } = await body(request);
    if (!name) return err(400, "name required.");
    if (status !== void 0 && !["proposed", "locked_in"].includes(status)) return err(400, "status must be proposed/locked_in.");
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO event_merch (id, event_id, name, assignee_id, status, position, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, eventId, name, assignee_id || null, status || "proposed", position || 0, user.id).run();
    return json({ id });
  }
  const merchItemMatch = pathname.match(/^\/api\/events\/([^/]+)\/merch\/([^/]+)$/);
  if (merchItemMatch && method === "PATCH") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const [, eventId, merchId] = merchItemMatch;
    if (!await isCrew(env, user, eventId)) return err(403, "Crew only.");
    const { name, assignee_id, status, position } = await body(request);
    if (status !== void 0 && !["proposed", "locked_in"].includes(status)) return err(400, "status must be proposed/locked_in.");
    const updates = [];
    const binds = [];
    if (name !== void 0) {
      if (!name) return err(400, "name required.");
      updates.push("name = ?");
      binds.push(name);
    }
    if (assignee_id !== void 0) {
      updates.push("assignee_id = ?");
      binds.push(assignee_id || null);
    }
    if (status !== void 0) {
      updates.push("status = ?");
      binds.push(status);
    }
    if (position !== void 0) {
      updates.push("position = ?");
      binds.push(position);
    }
    if (!updates.length) return err(400, "Nothing to update.");
    binds.push(merchId);
    await env.DB.prepare(`UPDATE event_merch SET ${updates.join(", ")} WHERE id = ?`).bind(...binds).run();
    return json({ ok: true });
  }
  if (merchItemMatch && method === "DELETE") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const [, eventId, merchId] = merchItemMatch;
    if (!await isCrew(env, user, eventId)) return err(403, "Crew only.");
    await env.DB.prepare("DELETE FROM event_merch WHERE id = ?").bind(merchId).run();
    return json({ ok: true });
  }
  const signsMatch = pathname.match(/^\/api\/events\/([^/]+)\/signs$/);
  if (signsMatch && method === "GET") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const eventId = signsMatch[1];
    if (!await isCrew(env, user, eventId)) return err(403, "Crew only.");
    const { results } = await env.DB.prepare(
      `SELECT event_signs.*, users.display_name AS assignee_name FROM event_signs
       LEFT JOIN users ON users.id = event_signs.assignee_id
       WHERE event_signs.event_id = ? ORDER BY event_signs.position ASC, event_signs.created_at ASC`
    ).bind(eventId).all();
    return json({ signs: results });
  }
  if (signsMatch && method === "POST") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const eventId = signsMatch[1];
    if (!await isCrew(env, user, eventId)) return err(403, "Crew only.");
    const { name, assignee_id, status, position } = await body(request);
    if (!name) return err(400, "name required.");
    if (status !== void 0 && !["proposed", "locked_in"].includes(status)) return err(400, "status must be proposed/locked_in.");
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO event_signs (id, event_id, name, assignee_id, status, position, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, eventId, name, assignee_id || null, status || "proposed", position || 0, user.id).run();
    return json({ id });
  }
  const signItemMatch = pathname.match(/^\/api\/events\/([^/]+)\/signs\/([^/]+)$/);
  if (signItemMatch && method === "PATCH") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const [, eventId, signId] = signItemMatch;
    if (!await isCrew(env, user, eventId)) return err(403, "Crew only.");
    const { name, assignee_id, status, position } = await body(request);
    if (status !== void 0 && !["proposed", "locked_in"].includes(status)) return err(400, "status must be proposed/locked_in.");
    const updates = [];
    const binds = [];
    if (name !== void 0) {
      if (!name) return err(400, "name required.");
      updates.push("name = ?");
      binds.push(name);
    }
    if (assignee_id !== void 0) {
      updates.push("assignee_id = ?");
      binds.push(assignee_id || null);
    }
    if (status !== void 0) {
      updates.push("status = ?");
      binds.push(status);
    }
    if (position !== void 0) {
      updates.push("position = ?");
      binds.push(position);
    }
    if (!updates.length) return err(400, "Nothing to update.");
    binds.push(signId);
    await env.DB.prepare(`UPDATE event_signs SET ${updates.join(", ")} WHERE id = ?`).bind(...binds).run();
    return json({ ok: true });
  }
  if (signItemMatch && method === "DELETE") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const [, eventId, signId] = signItemMatch;
    if (!await isCrew(env, user, eventId)) return err(403, "Crew only.");
    await env.DB.prepare("DELETE FROM event_signs WHERE id = ?").bind(signId).run();
    return json({ ok: true });
  }
  const raffleMatch = pathname.match(/^\/api\/events\/([^/]+)\/raffle$/);
  if (raffleMatch && method === "GET") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const eventId = raffleMatch[1];
    if (!await isCrew(env, user, eventId)) return err(403, "Crew only.");
    const { results } = await env.DB.prepare(
      `SELECT event_raffle.*, users.display_name AS assignee_name FROM event_raffle
       LEFT JOIN users ON users.id = event_raffle.assignee_id
       WHERE event_raffle.event_id = ? ORDER BY event_raffle.position ASC, event_raffle.created_at ASC`
    ).bind(eventId).all();
    return json({ raffle: results });
  }
  if (raffleMatch && method === "POST") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const eventId = raffleMatch[1];
    if (!await isCrew(env, user, eventId)) return err(403, "Crew only.");
    const { name, assignee_id, status, position } = await body(request);
    if (!name) return err(400, "name required.");
    if (status !== void 0 && !["proposed", "locked_in"].includes(status)) return err(400, "status must be proposed/locked_in.");
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO event_raffle (id, event_id, name, assignee_id, status, position, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, eventId, name, assignee_id || null, status || "proposed", position || 0, user.id).run();
    return json({ id });
  }
  const raffleItemMatch = pathname.match(/^\/api\/events\/([^/]+)\/raffle\/([^/]+)$/);
  if (raffleItemMatch && method === "PATCH") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const [, eventId, raffleId] = raffleItemMatch;
    if (!await isCrew(env, user, eventId)) return err(403, "Crew only.");
    const { name, assignee_id, status, position } = await body(request);
    if (status !== void 0 && !["proposed", "locked_in"].includes(status)) return err(400, "status must be proposed/locked_in.");
    const updates = [];
    const binds = [];
    if (name !== void 0) {
      if (!name) return err(400, "name required.");
      updates.push("name = ?");
      binds.push(name);
    }
    if (assignee_id !== void 0) {
      updates.push("assignee_id = ?");
      binds.push(assignee_id || null);
    }
    if (status !== void 0) {
      updates.push("status = ?");
      binds.push(status);
    }
    if (position !== void 0) {
      updates.push("position = ?");
      binds.push(position);
    }
    if (!updates.length) return err(400, "Nothing to update.");
    binds.push(raffleId);
    await env.DB.prepare(`UPDATE event_raffle SET ${updates.join(", ")} WHERE id = ?`).bind(...binds).run();
    return json({ ok: true });
  }
  if (raffleItemMatch && method === "DELETE") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const [, eventId, raffleId] = raffleItemMatch;
    if (!await isCrew(env, user, eventId)) return err(403, "Crew only.");
    await env.DB.prepare("DELETE FROM event_raffle WHERE id = ?").bind(raffleId).run();
    return json({ ok: true });
  }
  if (pathname === "/api/meetings" && method === "GET") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!user.is_ringleader) return err(403, "Ringleaders only.");
    const { results } = await env.DB.prepare(
      "SELECT * FROM guild_meetings ORDER BY position ASC, created_at ASC"
    ).all();
    return json({ meetings: results });
  }
  if (pathname === "/api/meetings" && method === "POST") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!user.is_ringleader) return err(403, "Ringleaders only.");
    const { title, content, position, meeting_date } = await body(request);
    if (!title) return err(400, "title required.");
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO guild_meetings (id, title, content, position, created_by, meeting_date) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(id, title, content || "", position || 0, user.id, meeting_date || null).run();
    return json({ id });
  }
  const meetingMatch = pathname.match(/^\/api\/meetings\/([^/]+)$/);
  if (meetingMatch && method === "PATCH") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!user.is_ringleader) return err(403, "Ringleaders only.");
    const { title, content, position, meeting_date, recap } = await body(request);
    const updates = ["updated_at = datetime('now')"];
    const binds = [];
    if (title !== void 0) {
      if (!title) return err(400, "title required.");
      updates.push("title = ?");
      binds.push(title);
    }
    if (content !== void 0) {
      updates.push("content = ?");
      binds.push(content);
    }
    if (position !== void 0) {
      updates.push("position = ?");
      binds.push(position);
    }
    if (meeting_date !== void 0) {
      updates.push("meeting_date = ?");
      binds.push(meeting_date);
    }
    if (recap !== void 0) {
      updates.push("recap = ?");
      binds.push(recap);
    }
    binds.push(meetingMatch[1]);
    await env.DB.prepare(`UPDATE guild_meetings SET ${updates.join(", ")} WHERE id = ?`).bind(...binds).run();
    return json({ ok: true });
  }
  if (meetingMatch && method === "DELETE") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!user.is_ringleader) return err(403, "Ringleaders only.");
    await env.DB.prepare("DELETE FROM guild_meetings WHERE id = ?").bind(meetingMatch[1]).run();
    return json({ ok: true });
  }
  if (pathname === "/api/lore" && method === "GET") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const row = await env.DB.prepare("SELECT content, updated_at FROM guild_lore WHERE id = 'main'").first();
    return json({ content: row ? row.content : "", updated_at: row ? row.updated_at : null });
  }
  if (pathname === "/api/lore" && method === "PATCH") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!user.is_ringleader) return err(403, "Ringleaders only.");
    const { content } = await body(request);
    if (content === void 0) return err(400, "content required.");
    await env.DB.prepare(
      `INSERT INTO guild_lore (id, content, updated_at, updated_by) VALUES ('main', ?, datetime('now'), ?)
       ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
    ).bind(content, user.id).run();
    return json({ ok: true });
  }
  if (pathname === "/api/roster" && method === "GET") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const { results } = await env.DB.prepare("SELECT id, display_name FROM users ORDER BY display_name").all();
    return json({ roster: results });
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
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!user.is_ringleader) return err(403, "Ringleaders only.");
    const { display_name, email, password, home_chapter_id, city, phone, instagram_handle, is_organization } = await body(request);
    if (!display_name || !email || !password || password.length < 6) return err(400, "Name, email, and a password of at least 6 characters are required.");
    const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
    if (existing) return err(400, "That email is already registered.");
    const { hash, salt } = await hashPassword(password);
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO users (id, email, password_hash, salt, display_name, home_chapter_id, city, phone, instagram_handle, rank, is_organization, onboarded) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'clown', ?, 1)`
    ).bind(id, email, hash, salt, display_name, home_chapter_id || null, city || null, phone || null, instagram_handle || null, is_organization ? 1 : 0).run();
    const created = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
    return json({ user: publicUser(created) });
  }
  if (pathname === "/api/venues" && method === "GET") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!user.is_ringleader) return err(403, "Ringleaders only.");
    const { results } = await env.DB.prepare("SELECT * FROM venues ORDER BY name").all();
    return json({ venues: results });
  }
  if (pathname === "/api/venues" && method === "POST") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!user.is_ringleader) return err(403, "Ringleaders only.");
    const { name, city, address, contact_name, contact_email, contact_phone, website, notes } = await body(request);
    if (!name) return err(400, "Venue name is required.");
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO venues (id, name, city, address, contact_name, contact_email, contact_phone, website, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, name, city || null, address || null, contact_name || null, contact_email || null, contact_phone || null, website || null, notes || null, user.id).run();
    const created = await env.DB.prepare("SELECT * FROM venues WHERE id = ?").bind(id).first();
    return json({ venue: created });
  }
  const venueMatch = pathname.match(/^\/api\/venues\/([^/]+)$/);
  if (venueMatch && method === "PATCH") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!user.is_ringleader) return err(403, "Ringleaders only.");
    const { name, city, address, contact_name, contact_email, contact_phone, website, notes } = await body(request);
    const updates = [];
    const binds = [];
    if (name !== void 0) {
      if (!name) return err(400, "Venue name is required.");
      updates.push("name = ?");
      binds.push(name);
    }
    if (city !== void 0) { updates.push("city = ?"); binds.push(city || null); }
    if (address !== void 0) { updates.push("address = ?"); binds.push(address || null); }
    if (contact_name !== void 0) { updates.push("contact_name = ?"); binds.push(contact_name || null); }
    if (contact_email !== void 0) { updates.push("contact_email = ?"); binds.push(contact_email || null); }
    if (contact_phone !== void 0) { updates.push("contact_phone = ?"); binds.push(contact_phone || null); }
    if (website !== void 0) { updates.push("website = ?"); binds.push(website || null); }
    if (notes !== void 0) { updates.push("notes = ?"); binds.push(notes || null); }
    if (updates.length) {
      binds.push(venueMatch[1]);
      await env.DB.prepare(`UPDATE venues SET ${updates.join(", ")} WHERE id = ?`).bind(...binds).run();
    }
    const updated = await env.DB.prepare("SELECT * FROM venues WHERE id = ?").bind(venueMatch[1]).first();
    if (!updated) return err(404, "Venue not found.");
    return json({ venue: updated });
  }
  if (venueMatch && method === "DELETE") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!user.is_ringleader) return err(403, "Ringleaders only.");
    await env.DB.prepare("DELETE FROM venues WHERE id = ?").bind(venueMatch[1]).run();
    return json({ ok: true });
  }
  // ── Impact Logs — per-event travel/materials/waste data, Ringleader-only,
  // same shape as venues above. Feeds the B Corp Climate Action and
  // Environmental Stewardship & Circularity topics (see CSI B Corp Assessment
  // Prep and CSI Event Impact Log in the vault).
  if (pathname === "/api/impact-logs" && method === "GET") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!user.is_ringleader) return err(403, "Ringleaders only.");
    const { results } = await env.DB.prepare(
      `SELECT impact_logs.*, venues.name AS venue_name FROM impact_logs
       LEFT JOIN venues ON venues.id = impact_logs.venue_id
       ORDER BY event_date DESC`
    ).all();
    return json({ logs: results });
  }
  if (pathname === "/api/impact-logs" && method === "POST") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!user.is_ringleader) return err(403, "Ringleaders only.");
    const { event_date, event_name, venue_id, travel_miles, travel_mode, material_sourcing, waste_generated, waste_diverted, notes } = await body(request);
    if (!event_date || !event_name) return err(400, "Event date and name are required.");
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO impact_logs (id, event_date, event_name, venue_id, travel_miles, travel_mode, material_sourcing, waste_generated, waste_diverted, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, event_date, event_name, venue_id || null, travel_miles ?? null, travel_mode || null, material_sourcing || null, waste_generated || null, waste_diverted || null, notes || null, user.id).run();
    const created = await env.DB.prepare(
      `SELECT impact_logs.*, venues.name AS venue_name FROM impact_logs LEFT JOIN venues ON venues.id = impact_logs.venue_id WHERE impact_logs.id = ?`
    ).bind(id).first();
    return json({ log: created });
  }
  const impactMatch = pathname.match(/^\/api\/impact-logs\/([^/]+)$/);
  if (impactMatch && method === "PATCH") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!user.is_ringleader) return err(403, "Ringleaders only.");
    const { event_date, event_name, venue_id, travel_miles, travel_mode, material_sourcing, waste_generated, waste_diverted, notes } = await body(request);
    const updates = [];
    const binds = [];
    if (event_date !== void 0) {
      if (!event_date) return err(400, "Event date is required.");
      updates.push("event_date = ?");
      binds.push(event_date);
    }
    if (event_name !== void 0) {
      if (!event_name) return err(400, "Event name is required.");
      updates.push("event_name = ?");
      binds.push(event_name);
    }
    if (venue_id !== void 0) { updates.push("venue_id = ?"); binds.push(venue_id || null); }
    if (travel_miles !== void 0) { updates.push("travel_miles = ?"); binds.push(travel_miles ?? null); }
    if (travel_mode !== void 0) { updates.push("travel_mode = ?"); binds.push(travel_mode || null); }
    if (material_sourcing !== void 0) { updates.push("material_sourcing = ?"); binds.push(material_sourcing || null); }
    if (waste_generated !== void 0) { updates.push("waste_generated = ?"); binds.push(waste_generated || null); }
    if (waste_diverted !== void 0) { updates.push("waste_diverted = ?"); binds.push(waste_diverted || null); }
    if (notes !== void 0) { updates.push("notes = ?"); binds.push(notes || null); }
    if (updates.length) {
      binds.push(impactMatch[1]);
      await env.DB.prepare(`UPDATE impact_logs SET ${updates.join(", ")} WHERE id = ?`).bind(...binds).run();
    }
    const updated = await env.DB.prepare(
      `SELECT impact_logs.*, venues.name AS venue_name FROM impact_logs LEFT JOIN venues ON venues.id = impact_logs.venue_id WHERE impact_logs.id = ?`
    ).bind(impactMatch[1]).first();
    if (!updated) return err(404, "Log not found.");
    return json({ log: updated });
  }
  if (impactMatch && method === "DELETE") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!user.is_ringleader) return err(403, "Ringleaders only.");
    await env.DB.prepare("DELETE FROM impact_logs WHERE id = ?").bind(impactMatch[1]).run();
    return json({ ok: true });
  }
  if (pathname === "/api/admin/new-signups" && method === "GET") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!user.is_ringleader) return err(403, "Ringleaders only.");
    const { results } = await env.DB.prepare(
      `SELECT users.id, users.display_name, users.email, users.created_at, chapters.name AS c_name
       FROM users LEFT JOIN chapters ON chapters.id = users.home_chapter_id
       WHERE users.created_at > ?1
       ORDER BY users.created_at DESC`
    ).bind(user.signups_seen_at || "1970-01-01").all();
    return json({
      count: results.length,
      members: results.map((m) => ({ id: m.id, display_name: m.display_name, email: m.email, created_at: m.created_at, home_chapter: m.c_name ? { name: m.c_name } : null }))
    });
  }
  if (pathname === "/api/admin/new-signups/seen" && method === "POST") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!user.is_ringleader) return err(403, "Ringleaders only.");
    await env.DB.prepare("UPDATE users SET signups_seen_at = datetime('now') WHERE id = ?").bind(user.id).run();
    return json({ ok: true });
  }
  const memberMatch = pathname.match(/^\/api\/members\/([^/]+)$/);
  if (memberMatch && method === "PATCH") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!user.is_ringleader) return err(403, "Ringleaders only.");
    const { display_name, home_chapter_id, birthday, skills, rank, is_ringleader, is_organization, dues_paid, dues_amount, dues_date, steward_role, email, password, city, phone, instagram_handle, knows_who, heard_about_us, materials_to_donate, tier } = await body(request);
    const updates = [];
    const binds = [];
    if (tier !== void 0) {
      if (tier !== "courtyard" && tier !== "inner") return err(400, "tier must be courtyard or inner.");
      updates.push("tier = ?");
      binds.push(tier);
    }
    if (email !== void 0) {
      if (!email) return err(400, "Email cannot be blank.");
      const existingEmail = await env.DB.prepare("SELECT id FROM users WHERE email = ? AND id != ?").bind(email, memberMatch[1]).first();
      if (existingEmail) return err(400, "That email is already registered.");
      updates.push("email = ?");
      binds.push(email);
    }
    if (password !== void 0 && password !== "") {
      if (password.length < 6) return err(400, "Password must be at least 6 characters.");
      const { hash, salt } = await hashPassword(password);
      updates.push("password_hash = ?");
      binds.push(hash);
      updates.push("salt = ?");
      binds.push(salt);
    }
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
    if (knows_who !== void 0) {
      updates.push("knows_who = ?");
      binds.push(knows_who || null);
    }
    if (heard_about_us !== void 0) {
      updates.push("heard_about_us = ?");
      binds.push(heard_about_us || null);
    }
    if (materials_to_donate !== void 0) {
      updates.push("materials_to_donate = ?");
      binds.push(materials_to_donate || null);
    }
    if (city !== void 0) {
      updates.push("city = ?");
      binds.push(city || null);
    }
    if (phone !== void 0) {
      updates.push("phone = ?");
      binds.push(phone || null);
    }
    if (instagram_handle !== void 0) {
      updates.push("instagram_handle = ?");
      binds.push(instagram_handle || null);
    }
    if (rank !== void 0) {
      updates.push("rank = ?");
      binds.push(rank);
    }
    if (is_organization !== void 0) {
      updates.push("is_organization = ?");
      binds.push(is_organization ? 1 : 0);
    }
    if (is_ringleader !== void 0) {
      updates.push("is_ringleader = ?");
      binds.push(is_ringleader ? 1 : 0);
      if (is_ringleader) {
        updates.push("signups_seen_at = datetime('now')");
      }
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
  if (memberMatch && method === "DELETE") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!user.is_ringleader) return err(403, "Ringleaders only.");
    if (memberMatch[1] === user.id) return err(400, "You can't delete your own account from here.");
    try {
      await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(memberMatch[1]).run();
    } catch (e) {
      // D1 enforces foreign keys — a member who authored posts, events,
      // venues, or impact logs can't be hard-deleted without orphaning
      // those rows. Surface that plainly rather than a generic 500.
      return err(400, "Couldn't delete — this member has authored content (posts, events, venues, or impact logs) referencing their account. Reassign or remove that first.");
    }
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
  { const r = await volunteerRoutes(request, env, url, user); if (r) return r; }
  { const r = await passportRoutes(request, env, url, user); if (r) return r; }
  { const r = await ticketRoutes(request, env, url); if (r) return r; }
  return err(404, "Not found.");
}
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
function shapeEvent(row) {
  return {
    id: row.id,
    chapter_id: row.chapter_id,
    title: row.title,
    description: row.description,
    location: row.location,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    created_by: row.created_by,
    created_at: row.created_at,
    chapter: row.chapter_id ? { name: row.c_name, slug: row.c_slug } : null
  };
}
function shapeMember(row) {
  return {
    id: row.id,
    display_name: row.display_name,
    email: row.email,
    rank: row.rank,
    is_ringleader: !!row.is_ringleader,
    home_chapter_id: row.home_chapter_id,
    home_chapter: row.home_chapter_id ? { name: row.c_name } : null,
    dues_paid: !!row.dues_paid,
    dues_amount: row.dues_amount,
    dues_date: row.dues_date,
    steward_role: row.steward_role || null,
    birthday: row.birthday || null,
    skills: row.skills || "",
    city: row.city || null,
    phone: row.phone || null,
    instagram_handle: row.instagram_handle || null,
    knows_who: row.knows_who || null,
    heard_about_us: row.heard_about_us || null,
    materials_to_donate: row.materials_to_donate || null,
    is_organization: !!row.is_organization,
    tier: row.tier || "courtyard",
    last_seen_at: row.last_seen_at || null,
    created_at: row.created_at
  };
}

// ---------------------------------------------------------------------
// Courtyard: the one board free accounts can read, plus event volunteering
// (open to every tier — it's how courtyard members get involved).
// ---------------------------------------------------------------------
var COURTYARD_SLUG = "courtyard";
async function isCourtyardBoard(env, boardId) {
  const row = await env.DB.prepare("SELECT slug FROM boards WHERE id = ?").bind(boardId).first();
  return !!row && row.slug === COURTYARD_SLUG;
}
async function sendWelcomeEmail(env, u) {
  const site = siteUrl(env);
  return sendEmail(env, {
    to: u.email,
    subject: "Welcome to the Carnival Society courtyard",
    text: `Hi ${u.display_name},\n\nYou're in the courtyard. Sign in at ${site} to see what's coming up and volunteer for an event; that's the fastest way into the guild.\n\nSee you under the tent.`,
    html: `<p>Hi ${escapeEmailHtml(u.display_name)},</p><p>You're in the courtyard. <a href="${site}">Sign in</a> to see what's coming up and volunteer for an event; that's the fastest way into the guild.</p><p>See you under the tent.</p>`
  });
}
async function volunteerRoutes(request, env, url, user) {
  const { pathname } = url;
  const method = request.method;
  if (pathname === "/api/me/volunteering" && method === "GET") {
    if (!user) return err(401, "Sign in required.");
    const { results } = await env.DB.prepare("SELECT event_id FROM event_volunteers WHERE user_id = ?").bind(user.id).all();
    return json({ event_ids: results.map((r) => r.event_id) });
  }
  const volMatch = pathname.match(/^\/api\/events\/([^/]+)\/volunteer$/);
  if (volMatch && method === "POST") {
    if (!user) return err(401, "Sign in required.");
    const evt = await env.DB.prepare("SELECT id FROM events WHERE id = ? AND COALESCE(ends_at, starts_at) >= datetime('now')").bind(volMatch[1]).first();
    if (!evt) return err(404, "That event isn't open for volunteers.");
    const { note } = await body(request);
    await env.DB.prepare(
      "INSERT INTO event_volunteers (event_id, user_id, note) VALUES (?, ?, ?) ON CONFLICT(event_id, user_id) DO UPDATE SET note = excluded.note"
    ).bind(evt.id, user.id, (note || "").trim().slice(0, 500) || null).run();
    return json({ ok: true });
  }
  if (volMatch && method === "DELETE") {
    if (!user) return err(401, "Sign in required.");
    await env.DB.prepare("DELETE FROM event_volunteers WHERE event_id = ? AND user_id = ?").bind(volMatch[1], user.id).run();
    return json({ ok: true });
  }
  const volListMatch = pathname.match(/^\/api\/events\/([^/]+)\/volunteers$/);
  if (volListMatch && method === "GET") {
    if (!isModerator(user)) return err(403, "Moderators only.");
    const { results } = await env.DB.prepare(
      `SELECT users.id, users.display_name, users.email, users.phone, users.city, users.tier, event_volunteers.note, event_volunteers.created_at,
              EXISTS(SELECT 1 FROM stamps WHERE stamps.user_id = users.id AND stamps.kind = 'roustabout' AND stamps.event_id = event_volunteers.event_id) AS showed_up
       FROM event_volunteers JOIN users ON users.id = event_volunteers.user_id
       WHERE event_volunteers.event_id = ? ORDER BY event_volunteers.created_at`
    ).bind(volListMatch[1]).all();
    return json({ volunteers: results });
  }
  return null;
}

// ---------------------------------------------------------------------
// Carnival Passport: merit-badge stamps that earn rank. Rule lives in the
// vault ("CSI Rank and Passport Rule"): Clown → Apprentice is automatic at
// 3 stamps incl. 2 Roustabouts, and crosses the Threshold (tier = inner).
// Journeyman needs a human nod; Master is conferred. Never ranked/compared.
// ---------------------------------------------------------------------
var STAMP_KINDS = ["fix", "ticket", "roustabout", "sawdust", "barker", "junk", "canvasman"];
var APPRENTICE_STAMPS = 3;
var APPRENTICE_ROUSTABOUTS = 2;
// Unique indexes make repeats (same kind+event, or a second Fix) no-ops.
async function grantStamp(env, { userId, kind, eventId = null, note = null, grantedBy = null }) {
  const res = await env.DB.prepare(
    "INSERT OR IGNORE INTO stamps (id, user_id, kind, event_id, note, granted_by) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(crypto.randomUUID(), userId, kind, eventId, note, grantedBy).run();
  const granted = !!res.meta.changes;
  return { granted, promoted: granted ? await checkPromotion(env, userId) : false };
}
async function stampCounts(env, userId) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(kind = 'roustabout'), 0) AS roustabouts FROM stamps WHERE user_id = ?").bind(userId).first();
  return { total: row.total, roustabouts: row.roustabouts };
}
// Only ever moves a Clown up to Apprentice; never demotes, never touches
// organizations (their standing is set by a Ringleader).
async function checkPromotion(env, userId) {
  const u = await env.DB.prepare("SELECT rank, is_organization FROM users WHERE id = ?").bind(userId).first();
  if (!u || u.rank !== "clown" || u.is_organization) return false;
  const c = await stampCounts(env, userId);
  if (c.total < APPRENTICE_STAMPS || c.roustabouts < APPRENTICE_ROUSTABOUTS) return false;
  await env.DB.prepare("UPDATE users SET rank = 'apprentice', tier = 'inner' WHERE id = ? AND rank = 'clown'").bind(userId).run();
  return true;
}
async function passportFor(env, userId) {
  const u = await env.DB.prepare("SELECT id, display_name, rank, is_ringleader, is_organization FROM users WHERE id = ?").bind(userId).first();
  if (!u) return null;
  const { results } = await env.DB.prepare(
    `SELECT stamps.id, stamps.kind, stamps.event_id, stamps.note, stamps.created_at, events.title AS event_title
     FROM stamps LEFT JOIN events ON events.id = stamps.event_id
     WHERE stamps.user_id = ? ORDER BY stamps.created_at, stamps.rowid`
  ).bind(userId).all();
  const c = await stampCounts(env, userId);
  const next = u.rank === "clown" && !u.is_organization ? {
    rank: "apprentice",
    stamps_needed: Math.max(0, APPRENTICE_STAMPS - c.total),
    roustabouts_needed: Math.max(0, APPRENTICE_ROUSTABOUTS - c.roustabouts)
  } : null;
  return { user: { id: u.id, display_name: u.display_name, rank: u.rank, is_ringleader: !!u.is_ringleader }, stamps: results, counts: c, next };
}
async function passportRoutes(request, env, url, user) {
  const { pathname } = url;
  const method = request.method;
  if (pathname === "/api/me/passport" && method === "GET") {
    if (!user) return err(401, "Sign in required.");
    return json(await passportFor(env, user.id));
  }
  const memberPassport = pathname.match(/^\/api\/members\/([^/]+)\/passport$/);
  if (memberPassport && method === "GET") {
    if (!isModerator(user)) return err(403, "Moderators only.");
    const p = await passportFor(env, memberPassport[1]);
    return p ? json(p) : err(404, "Not found.");
  }
  if (pathname === "/api/stamps" && method === "POST") {
    if (!isModerator(user)) return err(403, "Moderators only.");
    const { user_id, kind, event_id, note } = await body(request);
    if (!STAMP_KINDS.includes(kind)) return err(400, "Unknown stamp.");
    const target = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(user_id || "").first();
    if (!target) return err(404, "No such member.");
    const result = await grantStamp(env, { userId: target.id, kind, eventId: event_id || null, note: (note || "").trim().slice(0, 300) || null, grantedBy: user.id });
    // Cash at the door: put the $5 on the books alongside Stripe payments.
    if (kind === "fix" && result.granted) {
      await env.DB.prepare("INSERT INTO payments (id, user_id, kind, amount_cents, stripe_session_id) VALUES (?, ?, 'membership', ?, ?)")
        .bind(crypto.randomUUID(), target.id, Number(env.MEMBERSHIP_PRICE_CENTS || 500), "cash:" + crypto.randomUUID()).run();
    }
    return json(result);
  }
  const stampMatch = pathname.match(/^\/api\/stamps\/([^/]+)$/);
  if (stampMatch && method === "DELETE") {
    if (!isModerator(user)) return err(403, "Moderators only.");
    await env.DB.prepare("DELETE FROM stamps WHERE id = ?").bind(stampMatch[1]).run();
    return json({ ok: true });
  }
  const eventStamps = pathname.match(/^\/api\/events\/([^/]+)\/stamps$/);
  if (eventStamps && method === "GET") {
    if (!isModerator(user)) return err(403, "Moderators only.");
    const { results } = await env.DB.prepare("SELECT id, user_id, kind FROM stamps WHERE event_id = ?").bind(eventStamps[1]).all();
    return json({ stamps: results });
  }
  return null;
}

// ---------------------------------------------------------------------
// Tiers + ticketing. Courtyard = free account (info only). Inner member =
// paid the one-time membership fee (or already in the network). Tickets
// require inner. Payments go to the nonprofit's Stripe account.
// Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET. Optional var:
// MEMBERSHIP_PRICE_CENTS (default 500), SITE_URL.
// ---------------------------------------------------------------------
function isInner(user) {
  return !!user && (user.tier === "inner" || !!user.is_ringleader);
}
async function stripeCheckout(env, params) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) form.append(k, String(v));
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.STRIPE_SECRET_KEY, "Content-Type": "application/x-www-form-urlencoded" },
    body: form
  });
  const data = await res.json();
  if (!res.ok) throw new Error("Stripe: " + (data.error && data.error.message));
  return data;
}
function checkoutParams(env, { user, name, amountCents, metadata, successPath }) {
  const site = env.SITE_URL || "https://members.carnivalsociety.org";
  const p = {
    mode: "payment",
    "line_items[0][quantity]": 1,
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": amountCents,
    "line_items[0][price_data][product_data][name]": name,
    customer_email: user.email,
    client_reference_id: user.id,
    success_url: site + successPath,
    cancel_url: site + "/#cancelled"
  };
  for (const [k, v] of Object.entries(metadata)) p["metadata[" + k + "]"] = v;
  return p;
}
async function verifyStripeSignature(env, raw, header) {
  if (!header || !env.STRIPE_WEBHOOK_SECRET) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=")));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1e3 - Number(parts.t)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(parts.t + "." + raw));
  return timingSafeEqual(bytesToHex(new Uint8Array(sig)), parts.v1);
}
function ticketCode() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(10)));
}
async function ticketsSold(env, tierId) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets WHERE tier_id = ? AND (status = 'paid' OR (status = 'pending' AND created_at > datetime('now', '-30 minutes')))").bind(tierId).first();
  return row.n;
}
async function ticketRoutes(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/stripe/webhook" && method === "POST") {
    const raw = await request.text();
    if (!await verifyStripeSignature(env, raw, request.headers.get("Stripe-Signature"))) return err(400, "Bad signature.");
    const event = JSON.parse(raw);
    if (event.type !== "checkout.session.completed") return json({ ok: true });
    const s = event.data.object;
    if (s.payment_status !== "paid") return json({ ok: true });
    const md = s.metadata || {};
    const userId = md.user_id;
    const ins = await env.DB.prepare(
      "INSERT OR IGNORE INTO payments (id, user_id, kind, amount_cents, stripe_session_id, stripe_payment_intent) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(crypto.randomUUID(), userId, md.kind, s.amount_total, s.id, s.payment_intent || null).run();
    if (!ins.meta.changes) return json({ ok: true }); // already processed
    if (md.kind === "membership") {
      // The $5 buys a stamp ("The Fix Is In"), not a rank or inner access —
      // see CSI Rank and Passport Rule.
      await grantStamp(env, { userId, kind: "fix" });
    } else if (md.kind === "ticket") {
      await env.DB.prepare("UPDATE tickets SET status = 'paid' WHERE id = ?").bind(md.ticket_id).run();
    }
    return json({ ok: true });
  }

  if (pathname === "/api/membership/checkout" && method === "POST") {
    const user = await getSessionUser(request, env);
    if (!user) return err(401, "Not signed in.");
    if (!env.STRIPE_SECRET_KEY) return err(503, "Online payment isn't open yet.");
    if (await env.DB.prepare("SELECT 1 FROM stamps WHERE user_id = ? AND kind = 'fix'").bind(user.id).first()) return err(400, "The fix is already in.");
    const cents = Number(env.MEMBERSHIP_PRICE_CENTS || 500);
    const session = await stripeCheckout(env, checkoutParams(env, {
      user, name: "Carnival Society door registration (one time)", amountCents: cents,
      metadata: { kind: "membership", user_id: user.id }, successPath: "/#membership-success"
    }));
    return json({ url: session.url });
  }

  const tiersMatch = pathname.match(/^\/api\/events\/([^/]+)\/ticket-tiers$/);
  if (tiersMatch && method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM ticket_tiers WHERE event_id = ? AND active = 1 ORDER BY position, price_cents").bind(tiersMatch[1]).all();
    const tiers = [];
    for (const t of results) {
      const sold = await ticketsSold(env, t.id);
      tiers.push({ id: t.id, name: t.name, description: t.description, price_cents: t.price_cents, capacity: t.capacity, remaining: t.capacity == null ? null : Math.max(0, t.capacity - sold) });
    }
    return json({ tiers });
  }
  if (tiersMatch && method === "POST") {
    const user = await getSessionUser(request, env);
    if (!isModerator(user)) return err(403, "Moderators only.");
    const { name, description, price_cents, capacity, position } = await body(request);
    if (!name || !Number.isInteger(price_cents) || price_cents < 0) return err(400, "name and integer price_cents required.");
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO ticket_tiers (id, event_id, name, description, price_cents, capacity, position) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, tiersMatch[1], name, description || null, price_cents, capacity ?? null, position || 0).run();
    return json({ id });
  }

  const buyMatch = pathname.match(/^\/api\/events\/([^/]+)\/tickets$/);
  if (buyMatch && method === "POST") {
    const user = await getSessionUser(request, env);
    if (!user) return err(401, "Not signed in.");
    if (!isInner(user)) return err(403, "Tickets are for inner members. Join from the courtyard first.");
    const { tier_id } = await body(request);
    const tier = await env.DB.prepare("SELECT * FROM ticket_tiers WHERE id = ? AND event_id = ? AND active = 1").bind(tier_id || "", buyMatch[1]).first();
    if (!tier) return err(404, "Unknown ticket tier.");
    const have = await env.DB.prepare("SELECT 1 FROM tickets WHERE event_id = ? AND user_id = ? AND tier_id = ? AND status = 'paid'").bind(tier.event_id, user.id, tier.id).first();
    if (have) return err(400, "You already have this ticket.");
    const free = tier.price_cents === 0;
    if (!free && !env.STRIPE_SECRET_KEY) return err(503, "Online ticket sales aren't open yet.");
    if (tier.capacity != null && await ticketsSold(env, tier.id) >= tier.capacity) return err(409, "Sold out.");
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO tickets (id, event_id, tier_id, user_id, status, price_cents, code) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, tier.event_id, tier.id, user.id, free ? "paid" : "pending", tier.price_cents, ticketCode()).run();
    if (free) return json({ ticket_id: id });
    let session;
    try {
      session = await stripeCheckout(env, checkoutParams(env, {
        user, name: "Ticket: " + tier.name, amountCents: tier.price_cents,
        metadata: { kind: "ticket", user_id: user.id, ticket_id: id }, successPath: "/#ticket-success"
      }));
    } catch (e) {
      // Don't let a failed Stripe call hold a capacity slot for 30 minutes.
      await env.DB.prepare("DELETE FROM tickets WHERE id = ?").bind(id).run();
      throw e;
    }
    await env.DB.prepare("UPDATE tickets SET stripe_session_id = ? WHERE id = ?").bind(session.id, id).run();
    return json({ url: session.url });
  }

  if (pathname === "/api/me/tickets" && method === "GET") {
    const user = await getSessionUser(request, env);
    if (!user) return err(401, "Not signed in.");
    const { results } = await env.DB.prepare(
      `SELECT tickets.id, tickets.code, tickets.status, tickets.checked_in_at, ticket_tiers.name AS tier_name, events.title, events.starts_at, events.location
       FROM tickets JOIN ticket_tiers ON ticket_tiers.id = tickets.tier_id JOIN events ON events.id = tickets.event_id
       WHERE tickets.user_id = ? AND tickets.status = 'paid' ORDER BY events.starts_at`
    ).bind(user.id).all();
    return json({ tickets: results });
  }

  const checkinMatch = pathname.match(/^\/api\/events\/([^/]+)\/checkin$/);
  if (checkinMatch && method === "POST") {
    const user = await getSessionUser(request, env);
    if (!isModerator(user)) return err(403, "Moderators only.");
    const { code } = await body(request);
    const t = await env.DB.prepare(
      `SELECT tickets.*, users.display_name, ticket_tiers.name AS tier_name FROM tickets
       JOIN users ON users.id = tickets.user_id JOIN ticket_tiers ON ticket_tiers.id = tickets.tier_id
       WHERE tickets.code = ? AND tickets.event_id = ?`
    ).bind(code || "", checkinMatch[1]).first();
    if (!t || t.status !== "paid") return err(404, "No valid ticket for that code.");
    if (t.checked_in_at) return json({ ok: false, already: true, display_name: t.display_name, checked_in_at: t.checked_in_at });
    await env.DB.prepare("UPDATE tickets SET checked_in_at = datetime('now') WHERE id = ?").bind(t.id).run();
    const { promoted } = await grantStamp(env, { userId: t.user_id, kind: "ticket", eventId: t.event_id, grantedBy: user.id });
    return json({ ok: true, display_name: t.display_name, tier_name: t.tier_name, promoted });
  }
  return null;
}

function courtyardAllowed(method, pathname) {
  if (method === "GET" && (pathname === "/api/chapters" || pathname === "/api/events" || pathname === "/api/me/tickets" || pathname === "/api/me/volunteering" || pathname === "/api/me/passport")) return true;
  // Boards/posts handlers themselves restrict courtyard members to the
  // Courtyard board, read-only (POST /api/posts stays blocked here).
  if (method === "GET" && (pathname === "/api/boards" || pathname === "/api/posts" || /^\/api\/posts\/[^/]+$/.test(pathname))) return true;
  if ((method === "POST" || method === "DELETE") && /^\/api\/events\/[^/]+\/volunteer$/.test(pathname)) return true;
  if (method === "GET" && /^\/api\/events\/[^/]+$/.test(pathname)) return true;
  if (method === "GET" && /^\/api\/events\/[^/]+\/ticket-tiers$/.test(pathname)) return true;
  if (method === "POST" && /^\/api\/events\/[^/]+\/tickets$/.test(pathname)) return true; // answers with its own 403
  if (method === "POST" && pathname === "/api/membership/checkout") return true;
  return false;
}
