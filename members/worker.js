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
// Card payments paused 2026-10-17: checkouts on the sponsor's Stripe were
// failing, so ticket pages offer "save my spot, pay at the door" only. The
// Ringleader's 50¢ test payment on The Door still works for checking Stripe.
// Flip to false once a test payment goes through.
const CARD_PAYMENTS_PAUSED = false;
function cardPayments(env) { return !CARD_PAYMENTS_PAUSED && !!env.STRIPE_SECRET_KEY; }
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
    // Short public links for flyers: /t/kooks → that carnival's page.
    const short = url.pathname.match(/^\/t\/([a-z0-9-]{2,40})\/?$/);
    if (short) return Response.redirect(`${url.origin}/#/get/${short[1]}`, 302);
    const join = url.pathname.match(/^\/p\/([a-z0-9-]{2,40})\/?$/);
    if (join) return Response.redirect(`${url.origin}/#/p/${join[1]}`, 302);
    // The Mercury Oracle, inside the house: /oracle/mercury/* is passed
    // through from its own site so it can open over a Dressing Room in a
    // frame, with its dark backdrop made see-through (the room shows behind
    // the cards). Members only.
    if (url.pathname === "/oracle/mercury" || url.pathname.startsWith("/oracle/mercury/")) {
      const viewer = await getSessionUser(request, env);
      if (!viewer) return new Response("Sign in to draw a card.", { status: 401 });
      const rest = url.pathname.slice("/oracle/mercury".length).replace(/^\/?/, "/");
      if (!rest.startsWith("/images/") && !await hasFullDeck(env, viewer)) return new Response("The full deck is a gift for the Mercury Oracle's backers. Your card of the day is with Omen.", { status: 403 });
      const res = await fetch(`${MERCURY_ORACLE}${rest}`, { cf: { cacheTtl: 3600 } });
      const type = res.headers.get("Content-Type") || "";
      if (!type.includes("text/html")) return new Response(res.body, { status: res.status, headers: { "Content-Type": type, "Cache-Control": "public, max-age=3600" } });
      const html = (await res.text()).replace("</head>", `<style>html,body,#root,#root>div{background:transparent!important}.top-bar{background:none!important}</style></head>`);
      return new Response(html, { status: res.status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store", "X-Frame-Options": "SAMEORIGIN" } });
    }
    return env.ASSETS.fetch(request);
  },
  // Daily housekeeping (cron in wrangler.jsonc): expired sessions and reset
  // tokens otherwise accumulate forever — every sign-in adds a session row.
  async scheduled(event, env, ctx) {
    await sendReminders(env);
    await catchUpPayments(env);
    if (new Date(event.scheduledTime).getUTCHours() !== 9) return;
    await env.DB.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
    await env.DB.prepare("DELETE FROM notifications WHERE created_at < datetime('now', '-30 days')").run();
    await env.DB.prepare("DELETE FROM password_resets WHERE expires_at < datetime('now', '-1 day')").run();
    await env.DB.prepare("DELETE FROM chat_messages WHERE created_at < datetime('now', '-30 days')").run();
    await env.DB.prepare("DELETE FROM chat_presence WHERE seen_at < datetime('now', '-1 day')").run();
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
// One look for every email we send: cream paper, burgundy, gold, serif, like
// the front page. body = inner HTML; button = [label, url] (optional).
function emailFrame(env, { heading, body, button, footer }) {
  const logo = siteUrl(env) + "/assets/logo-wordmark.png";
  return `<!doctype html><html><body style="margin:0;padding:0;background:#F4E8D0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4E8D0;padding:28px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#FBF3DC;border:1px solid #DCC08A;border-radius:4px;">
<tr><td align="center" style="padding:28px 24px 6px;"><img src="${logo}" width="190" alt="Carnival Society" style="display:block;width:190px;height:auto;border:0;"></td></tr>
<tr><td align="center" style="padding:6px 28px 4px;font-family:Georgia,'Times New Roman',serif;font-size:28px;line-height:1.15;font-weight:bold;color:#9B3036;">${heading}</td></tr>
<tr><td style="padding:10px 28px 6px;font-family:Georgia,'Times New Roman',serif;font-size:17px;line-height:1.5;color:#3b2a22;">${body}</td></tr>
${button ? `<tr><td align="center" style="padding:14px 28px 8px;"><a href="${button[1]}" style="display:inline-block;background:#9B3036;color:#F4E8D0;text-decoration:none;font-family:Georgia,serif;font-style:italic;font-size:17px;letter-spacing:2px;text-transform:uppercase;padding:15px 28px;border-radius:2px;">${button[0]}</a></td></tr>` : ""}
<tr><td align="center" style="padding:14px 28px 26px;font-family:Georgia,serif;font-style:italic;font-size:14px;line-height:1.5;color:#8F6E34;">${footer || "Carnival Society · we build real carnivals together"}</td></tr>
</table></td></tr></table></body></html>`;
}
// The ticket, by email: right after saving a spot (or a free ticket), and
// again once Stripe confirms a payment. Always to the account's own email.
async function sendTicketEmail(env, ticketId, { claim = null } = {}) {
  if (!env.RESEND_API_KEY) return false;
  const t = await env.DB.prepare(
    `SELECT t.code, t.status, t.price_cents, t.quantity, t.user_id, u.email, u.display_name, e.title, e.starts_at, e.location, e.entry_tickets, e.tagline
     FROM tickets t JOIN users u ON u.id = t.user_id JOIN events e ON e.id = t.event_id WHERE t.id = ?`
  ).bind(ticketId).first();
  if (!t || !t.email || t.email.endsWith("@door.carnivalsociety.org")) return false;
  const esc = escapeEmailHtml, first = esc(t.display_name.split(" ")[0]);
  const fix = await hasFix(env, t.user_id);
  const reg = Number(env.MEMBERSHIP_PRICE_CENTS || 500);
  const n = t.quantity || 1, entry = t.price_cents * n;
  const owe = t.status === "reserved" ? entry + (fix ? 0 : reg) : 0;
  const $ = (c) => "$" + (c / 100).toFixed(c % 100 ? 2 : 0);
  const link = `${siteUrl(env)}/#/ticket/${t.code}${claim ? "/" + claim : ""}`;
  const when = eventWhen(t.starts_at);
  const paid = t.status === "paid";
  const body = `<p style="margin:0 0 12px;">Hi ${first}! ${paid ? "You're in." : "Your spot is saved."} Here's your ticket for <b>${esc(t.title)}</b>${t.tagline ? `, our ${esc(t.tagline)}` : ""}.${n > 1 ? ` It lets in <b>${n} people</b>: you and ${n - 1} guest${n > 2 ? "s" : ""}. Come in together.` : ""}</p>
<p style="margin:0 0 12px;"><b>${esc(when)}</b>${t.location ? `<br>${esc(t.location)}` : ""}</p>
${paid ? `<p style="margin:0 0 12px;">Show your QR code at the door. It's waiting behind the button below.</p>`
  : `<p style="margin:0 0 12px;padding:12px 14px;background:#fff8e6;border:1px dashed #C8A05A;">Pay <b>${$(owe)}</b> at the door, cash or card${owe > entry ? `<br><span style="font-size:15px;color:#5A4238;">${$(entry)} entry${n > 1 ? ` (${n} × ${$(t.price_cents)})` : ""} + ${$(owe - entry)} one-time membership (your first carnival only)</span>` : ""}.</p>`}
${t.entry_tickets ? `<p style="margin:0 0 12px;">Comes with <b>${t.entry_tickets} free carnival tickets</b>${n > 1 ? " each" : ""} for games and experiences, handed to you at the door.</p>` : ""}
<p style="margin:0;font-size:15px;color:#5A4238;">Your ticket code: <b style="letter-spacing:1px;">${t.code}</b>. Lost your phone? Just give your name at the door.</p>
${claim ? `<p style="margin:14px 0 0;font-size:15px;color:#5A4238;">You're in the Carnival Society now too: the button also lets you claim your own Dressing Room.</p>` : ""}`;
  return sendEmail(env, {
    to: t.email,
    subject: `🎟️ ${paid ? "Your ticket" : "Spot saved"}: ${t.title}`,
    html: emailFrame(env, { heading: paid ? "You're in!" : "Your spot is saved!", body, button: ["Show my ticket", link] }),
    text: `Hi ${t.display_name.split(" ")[0]}! ${paid ? "You're in" : "Your spot is saved"}${n > 1 ? ` (${n} people)` : ""} for ${t.title}, ${when}${t.location ? ", " + t.location : ""}.\n${paid ? "" : `Pay ${$(owe)} at the door (cash or card).\n`}Your ticket (show the QR at the door): ${link}\nCode: ${t.code}. Lost your phone? Just give your name at the door.`,
  });
}
// A fresh claim link for someone who has never signed in (60 days).
async function claimLinkFor(env, userId) {
  if (await env.DB.prepare("SELECT 1 FROM sessions WHERE user_id = ? LIMIT 1").bind(userId).first()) return null;
  const token = bytesToHex(crypto.getRandomValues(new Uint8Array(24)));
  await env.DB.prepare("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+60 days'))").bind(await sha256Hex(token), userId).run();
  return token;
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
  if (pathname.startsWith("/api/public/")) { const r = await publicRoutes(request, env, url); if (r) return r; }
  if (pathname === "/api/config" && method === "GET") {
    return withCors(json({
      turnstile_site_key: env.TURNSTILE_SITE_KEY || null,
      payments_enabled: cardPayments(env),
      password_reset_enabled: !!env.RESEND_API_KEY,
      vapid_public_key: env.VAPID_PUBLIC_KEY || null
    }));
  }
  if (pathname === "/api/auth/signup" && method === "POST") {
    if (await rateLimited(env, request, "signup")) return withCors(err(429, "Too many attempts. Wait a minute and try again."));
    const { email: rawEmail, password, display_name, home_chapter_id, city, phone, instagram_handle, is_organization, materials_to_donate, heard_about_us, wants_to_volunteer, turnstile_token } = await body(request);
    const email = normalizeEmail(rawEmail);
    if (!email || !password || password.length < 6 || !display_name || !city) return withCors(err(400, "Missing or invalid fields."));
    if (!await turnstileOk(env, request, turnstile_token)) return withCors(err(400, "Couldn't verify you're human. Refresh and try again."));
    const existing = await env.DB.prepare("SELECT id FROM users WHERE lower(email) = ?").bind(email).first();
    if (existing) return withCors(err(400, "That email is already registered."));
    const { hash, salt } = await hashPassword(password);
    const id = crypto.randomUUID();
    // The short join form doesn't ask for a chapter; match it from the city
    // ("Boulder, CO" → Boulder). Changeable later on My Profile.
    const chapterId = home_chapter_id || (await env.DB.prepare("SELECT id FROM chapters WHERE instr(lower(?), lower(name)) > 0 LIMIT 1").bind(city).first())?.id || null;
    await env.DB.prepare(
      `INSERT INTO users (id, email, password_hash, salt, display_name, home_chapter_id, city, phone, instagram_handle, rank, is_organization, materials_to_donate, heard_about_us, wants_to_volunteer, waitlisted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'clown', ?, ?, ?, ?, datetime('now'))`
    ).bind(id, email, hash, salt, display_name, chapterId, city, phone || null, instagram_handle || null, is_organization ? 1 : 0, materials_to_donate || null, heard_about_us || null, wants_to_volunteer ? 1 : 0).run();
    await letBackerIn(env, id, email);
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
  // Claiming an account made at the door: set a real email (if we only had
  // a placeholder) and a password, from the QR the door crew showed them.
  if (pathname === "/api/auth/claim" && method === "POST") {
    if (await rateLimited(env, request, "reset")) return err(429, "Too many attempts. Wait a minute and try again.");
    const { token, password, email: rawEmail } = await body(request);
    const tokenHash = await sha256Hex(token || "");
    const row = await env.DB.prepare("SELECT r.user_id, u.email, u.display_name FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > datetime('now')").bind(tokenHash).first();
    if (!row) return err(400, "That link has already been used or has expired. Ask a Ringleader for a new one.");
    if (url.searchParams.get("peek")) return json({ display_name: row.display_name, needs_email: row.email.endsWith("@door.carnivalsociety.org") });
    if (!password || password.length < 6) return err(400, "Password must be at least 6 characters.");
    let email = row.email;
    if (email.endsWith("@door.carnivalsociety.org")) {
      email = normalizeEmail(rawEmail || "");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err(400, "Add your email so you can sign in.");
      if (await env.DB.prepare("SELECT 1 FROM users WHERE lower(email) = ? AND id != ?").bind(email, row.user_id).first()) return err(400, "That email already has an account. Sign in with it instead.");
    }
    const { hash, salt } = await hashPassword(password);
    await env.DB.batch([
      env.DB.prepare("UPDATE password_resets SET used_at = datetime('now') WHERE token_hash = ?").bind(tokenHash),
      env.DB.prepare("UPDATE users SET email = ?, password_hash = ?, salt = ? WHERE id = ?").bind(email, hash, salt, row.user_id),
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
    const patchBody = await body(request);
    const { display_name, home_chapter_id, avatar_url, birthday, skills, onboarded, knows_who, heard_about_us, materials_to_donate, celebrated_rank, city, phone, instagram_handle, share_email, share_phone, share_instagram } = patchBody;
    const updates = [];
    const binds = [];
    if (display_name !== void 0 && !String(display_name).trim()) return err(400, "Name can't be blank.");
    if (city !== void 0 && !String(city).trim()) return err(400, "City can't be blank.");
    for (const [col, val] of [["city", city], ["phone", phone], ["instagram_handle", instagram_handle]]) {
      if (val !== void 0) {
        updates.push(`${col} = ?`);
        binds.push(String(val).trim() || null);
      }
    }
    const { notify_letters, notify_calls, notify_prizes } = patchBody;
    for (const [col, val] of [["share_email", share_email], ["share_phone", share_phone], ["share_instagram", share_instagram], ["notify_letters", notify_letters], ["notify_calls", notify_calls], ["notify_prizes", notify_prizes]]) {
      if (val !== void 0) {
        updates.push(`${col} = ?`);
        binds.push(val ? 1 : 0);
      }
    }
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
  // The waitlist: until the Ringleader lets you in, you can buy tickets, see
  // your place in line and turn on notifications; nothing else.
  if (user && user.waitlisted_at && !user.is_ringleader && !waitlistAllowed(method, pathname)) return err(403, "You're on the waitlist. The Ringleader lets new carnies in by hand, a few at a time.");
  if (pathname === "/api/admin/test-emails" && method === "POST") {
    if (!user?.is_ringleader) return err(403, "Ringleaders only.");
    if (!env.RESEND_API_KEY) return err(400, "Email isn't switched on.");
    const me = { ...user };
    const sent = {
      on_the_list: await sendWelcomeEmail(env, { ...me, waitlisted_at: "now" }),
      backer_welcome: await sendWelcomeEmail(env, { ...me, waitlisted_at: null }),
      youre_in: await sendYoureInEmail(env, user.id),
    };
    return json({ to: user.email, sent });
  }
  if (pathname === "/api/me/intro" && method === "POST") {
    if (!user) return err(401, "Sign in required.");
    const b = await body(request);
    const from = String(b.from || "").trim().slice(0, 80);
    const about = String(b.about || "").trim().slice(0, 800);
    if (!from) return err(400, "Where are you from?");
    if (about.length < 10) return err(400, "Tell the troupe a little more about what brings you here.");
    const acts = Array.isArray(b.acts) ? b.acts.map((a) => String(a).slice(0, 40)).slice(0, 12).join(", ") : null;
    await env.DB.prepare("UPDATE users SET intro = ?, introduced_at = COALESCE(introduced_at, datetime('now')), onboarded = 1, city = COALESCE(NULLIF(city, ''), ?), skills = COALESCE(?, skills) WHERE id = ?")
      .bind(JSON.stringify({ from, about }), from, acts, user.id).run();
    if (!user.waitlisted_at) await publishIntro(env, user.id);
    else if (!user.introduced_at) {
      const { results: rls } = await env.DB.prepare("SELECT id FROM users WHERE is_ringleader = 1").all();
      for (const r of rls) await notifyUser(env, r.id, { kind: "rank", title: `👋 ${user.display_name} introduced themself`, body: `From ${from}. They're in line, ready when you are.`, url: "#/directory" });
    }
    return json({ user: publicUser(await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first()) });
  }
  if (pathname === "/api/me/photo" && (method === "POST" || method === "DELETE")) {
    if (!user) return err(401, "Sign in required.");
    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM user_photos WHERE user_id = ?").bind(user.id).run();
      await env.DB.prepare("UPDATE users SET avatar_url = NULL WHERE id = ?").bind(user.id).run();
      return json({ avatar_url: null });
    }
    const data = String((await body(request)).data || "");
    if (!/^data:image\/(jpeg|webp|png);base64,[A-Za-z0-9+/=]+$/.test(data)) return err(400, "That doesn't look like a picture.");
    if (data.length > 300000) return err(400, "That picture is too big. Try a smaller one.");
    await env.DB.prepare("INSERT INTO user_photos (user_id, data, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at").bind(user.id, data).run();
    const avatar = `/api/photos/${user.id}?v=${Date.now().toString(36)}`;
    await env.DB.prepare("UPDATE users SET avatar_url = ? WHERE id = ?").bind(avatar, user.id).run();
    return json({ avatar_url: avatar });
  }
  const photoMatch = pathname.match(/^\/api\/photos\/([^/]+)$/);
  if (photoMatch && method === "GET") {
    if (!user) return err(401, "Sign in required.");
    // Waitlisted folk see only their own; the Ringleader sees everyone's.
    if (user.waitlisted_at && !user.is_ringleader && photoMatch[1] !== user.id) return err(403, "Not yet.");
    const row = await env.DB.prepare("SELECT data FROM user_photos WHERE user_id = ?").bind(photoMatch[1]).first();
    if (!row) return err(404, "No photo.");
    const [, type, b64] = row.data.match(/^data:([^;]+);base64,(.*)$/);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new Response(bytes, { headers: { "Content-Type": type, "Cache-Control": "private, max-age=604800, immutable" } });
  }
  if (pathname === "/api/me/waitlist" && method === "GET") {
    if (!user) return err(401, "Sign in required.");
    const pos = user.waitlisted_at ? (await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE waitlisted_at IS NOT NULL AND (waitlisted_at < ? OR (waitlisted_at = ? AND id <= ?))").bind(user.waitlisted_at, user.waitlisted_at, user.id).first()).n : 0;
    const { results: events } = await env.DB.prepare(
      `SELECT id, title, starts_at, location, door_cents, entry_tickets, slug FROM events WHERE COALESCE(ends_at, starts_at) >= datetime('now') AND door_cents IS NOT NULL ORDER BY starts_at LIMIT 4`
    ).all();
    const { results: tickets } = await env.DB.prepare(
      "SELECT t.code, t.status, e.title, e.starts_at FROM tickets t JOIN events e ON e.id = t.event_id WHERE t.user_id = ? AND t.status IN ('paid', 'reserved') ORDER BY e.starts_at"
    ).bind(user.id).all();
    return json({ waiting: !!user.waitlisted_at, position: pos, events, tickets });
  }
  // Courtyard gate: free accounts reach public info, the Courtyard board
  // (read-only), volunteering, and the path to becoming an inner member.
  // Everything else below needs tier = inner.
  if (user && !isInner(user) && !courtyardAllowed(method, pathname) && !(user.is_partner && partnerAllowed(method, pathname))) return err(403, "Inner members only.");
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
    // Forum list: reply count, last activity (bumps busy threads up) and who
    // replied last, alongside the usual post + author fields.
    const { results } = await env.DB.prepare(
      `SELECT posts.*, users.display_name AS a_name, users.rank AS a_rank, users.is_ringleader AS a_ring, users.avatar_url AS a_photo,
              (SELECT COUNT(*) FROM posts r WHERE r.parent_id = posts.id) AS reply_count,
              COALESCE((SELECT MAX(r.created_at) FROM posts r WHERE r.parent_id = posts.id), posts.created_at) AS last_activity,
              (SELECT u2.display_name FROM posts r JOIN users u2 ON u2.id = r.author_id WHERE r.parent_id = posts.id ORDER BY r.created_at DESC LIMIT 1) AS last_replier
       FROM posts JOIN users ON users.id = posts.author_id
       WHERE posts.board_id = ? AND posts.parent_id IS NULL
       ORDER BY posts.pinned DESC, last_activity DESC
       LIMIT 200`
    ).bind(boardId).all();
    return json({ posts: results.map((r) => ({ ...shapePost(r), reply_count: r.reply_count, last_activity: r.last_activity, last_replier: r.last_replier || null })) });
  }
  if (pathname === "/api/posts" && method === "POST") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const { board_id, parent_id, title, body: text } = await body(request);
    if (!board_id || !text) return err(400, "board_id and body required.");
    if (!parent_id && !isModerator(user) && await isCourtyardBoard(env, board_id)) return err(403, "Only Ringleaders start threads in the Courtyard.");
    if (!isInner(user) && (!parent_id || parent_id !== await introThreadId(env, { create: false }))) return err(403, "Inner members only.");
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO posts (id, board_id, author_id, parent_id, title, body) VALUES (?, ?, ?, ?, ?, ?)").bind(id, board_id, user.id, parent_id || null, title || null, text).run();
    if (parent_id && parent_id === await introThreadId(env, { create: false })) ctx.waitUntil(nudgeHellos(env, user, parent_id, text));
    return json({ id });
  }
  const postMatch = pathname.match(/^\/api\/posts\/([^/]+)$/);
  if (postMatch && method === "GET") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const postId = postMatch[1];
    const post = await env.DB.prepare(
      `SELECT posts.*, users.display_name AS a_name, users.rank AS a_rank, users.is_ringleader AS a_ring, users.avatar_url AS a_photo
       FROM posts JOIN users ON users.id = posts.author_id WHERE posts.id = ?`
    ).bind(postId).first();
    if (!post) return err(404, "Not found.");
    if (!isInner(user) && !await isCourtyardBoard(env, post.board_id)) return err(403, "Inner members only.");
    const { results: replyRows } = await env.DB.prepare(
      `SELECT posts.*, users.display_name AS a_name, users.rank AS a_rank, users.is_ringleader AS a_ring, users.avatar_url AS a_photo
       FROM posts JOIN users ON users.id = posts.author_id
       WHERE posts.parent_id = ? ORDER BY posts.created_at ASC`
    ).bind(postId).all();
    return json({ post: { ...shapePost(post), open_to_all: post.id === await introThreadId(env, { create: false }) }, replies: replyRows.map(shapePost) });
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
      archived ? `SELECT events.*, chapters.name AS c_name, chapters.slug AS c_slug, pu.display_name AS partner_name, pu.avatar_url AS partner_logo FROM events
           LEFT JOIN chapters ON chapters.id = events.chapter_id LEFT JOIN users pu ON pu.id = events.partner_id
           WHERE COALESCE(events.ends_at, events.starts_at) < datetime('now') ORDER BY events.starts_at DESC` : `SELECT events.*, chapters.name AS c_name, chapters.slug AS c_slug, pu.display_name AS partner_name, pu.avatar_url AS partner_logo FROM events
           LEFT JOIN chapters ON chapters.id = events.chapter_id LEFT JOIN users pu ON pu.id = events.partner_id
           WHERE COALESCE(events.ends_at, events.starts_at) >= datetime('now') ORDER BY events.starts_at ASC`
    ).all();
    return json({ events: results.map(shapeEvent) }, { headers: { "Access-Control-Allow-Origin": "*" } });
  }
  if (pathname === "/api/events" && method === "POST") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!isModerator(user) && !user.is_partner) return err(403, "Moderators only.");
    const { title, chapter_id, starts_at, ends_at, location, description } = await body(request);
    if (!title || !starts_at) return err(400, "title and starts_at required.");
    const id = crypto.randomUUID();
    // A partner's own event is co-hosted by them.
    const partnerId = !isModerator(user) && user.is_partner ? user.id : null;
    await env.DB.prepare("INSERT INTO events (id, chapter_id, title, description, location, starts_at, ends_at, created_by, partner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, chapter_id || null, title, description || null, location || null, starts_at, ends_at || null, user.id, partnerId).run();
    // A Ringleader's new event squawks to everyone; a partner's, to their friends.
    if (partnerId) {
      const { results: fr } = await env.DB.prepare("SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END AS id FROM handshakes WHERE (user_a = ? OR user_b = ?) AND met_at IS NOT NULL").bind(user.id, user.id, user.id).all();
      ctx.waitUntil(Promise.all(fr.map((f) => notifyUser(env, f.id, { kind: "call", title: `${user.display_name}: ${title}`, body: `${eventWhen(starts_at)}${location ? " · " + location : ""}`, url: `#/event/${id}`, ref: `call:${id}` }, "notify_calls"))));
    } else ctx.waitUntil(notifyEveryone(env, { kind: "call", title: `SQUAWK! ${title} needs hands`, body: `${eventWhen(starts_at)}${location ? " · " + location : ""}. Volunteer and win a Roustabout badge.`, url: `#/event/${id}`, ref: `call:${id}` }, "notify_calls", user.id));
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
    if (!user.is_ringleader && !await ownsEvent(env, user, eventMatch[1])) return err(403, "Ringleaders only.");
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
    if (!isModerator(user) && !await ownsEvent(env, user, eventMatch[1])) return err(403, "Moderators only.");
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
  if (pathname === "/api/waitlist" && method === "GET") {
    if (!user?.is_ringleader) return err(403, "Ringleaders only.");
    const { results } = await env.DB.prepare(
      `SELECT u.id, u.display_name, u.email, u.city, u.heard_about_us, u.waitlisted_at, u.intro, u.avatar_url, u.skills, u.wants_to_volunteer,
         (SELECT COUNT(*) FROM tickets t WHERE t.user_id = u.id AND t.status IN ('paid', 'reserved')) AS tickets,
         (SELECT COUNT(*) FROM door_entries d WHERE d.user_id = u.id AND d.voided_at IS NULL) AS came
       FROM users u WHERE u.waitlisted_at IS NOT NULL ORDER BY u.waitlisted_at, u.id`
    ).all();
    return json({ waiting: results.map((r) => ({ ...r, intro: parseIntro(r.intro), email: r.email.endsWith("@door.carnivalsociety.org") ? null : r.email })) });
  }
  if (pathname === "/api/waitlist/admit" && method === "POST") {
    if (!user?.is_ringleader) return err(403, "Ringleaders only.");
    const b = await body(request);
    let ids = Array.isArray(b.ids) ? b.ids.slice(0, 200).map(String) : [];
    if (!ids.length && b.next) ids = (await env.DB.prepare("SELECT id FROM users WHERE waitlisted_at IS NOT NULL ORDER BY waitlisted_at, id LIMIT ?").bind(Math.min(200, Math.max(1, Math.round(Number(b.next)) || 1))).all()).results.map((r) => r.id);
    let n = 0;
    for (const id of ids) {
      const res = await env.DB.prepare("UPDATE users SET waitlisted_at = NULL WHERE id = ? AND waitlisted_at IS NOT NULL").bind(id).run();
      if (!res.meta.changes) continue;
      n++;
      await publishIntro(env, id);
      await notifyUser(env, id, { kind: "rank", title: "🎪 You're in! Welcome to Carnival Society", body: "The Ringleader let you in. Your Dressing Room is ready.", url: "#/dressing-room" });
      await sendYoureInEmail(env, id);
    }
    return json({ ok: true, admitted: n });
  }
  const memberMatch = pathname.match(/^\/api\/members\/([^/]+)$/);
  if (memberMatch && method === "PATCH") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    if (!user.is_ringleader) return err(403, "Ringleaders only.");
    const { is_partner, display_name, home_chapter_id, birthday, skills, rank, is_ringleader, is_organization, dues_paid, dues_amount, dues_date, steward_role, email, password, city, phone, instagram_handle, knows_who, heard_about_us, materials_to_donate, tier } = await body(request);
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
    if (is_partner !== void 0) {
      updates.push("is_partner = ?");
      binds.push(is_partner ? 1 : 0);
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
    // Non-Ringleaders get the public shape: contact fields only where the
    // member opted in (share_*). See shapeMemberPublic.
    const shape = user.is_ringleader ? shapeMember : shapeMemberPublic;
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
    return json({ members: results.map(shape) });
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
    await env.DB.prepare("UPDATE conversation_participants SET last_read_at = datetime('now') WHERE conversation_id = ? AND user_id = ?").bind(convId, user.id).run();
    return json({ other: other[0] || null, messages });
  }
  if (dmMessagesMatch && method === "POST") {
    const authErr = requireAuth();
    if (authErr) return authErr;
    const convId = dmMessagesMatch[1];
    const participant = await env.DB.prepare("SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?").bind(convId, user.id).first();
    if (!participant) return err(403, "Not a participant.");
    const { body: text, holler } = await body(request);
    if (!text) return err(400, "body required.");
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO direct_messages (id, conversation_id, sender_id, body) VALUES (?, ?, ?, ?)").bind(id, convId, user.id, text).run();
    await env.DB.prepare("UPDATE conversation_participants SET last_read_at = datetime('now') WHERE conversation_id = ? AND user_id = ?").bind(convId, user.id).run();
    const { results: others } = await env.DB.prepare("SELECT user_id FROM conversation_participants WHERE conversation_id = ? AND user_id != ?").bind(convId, user.id).all();
    // The Ringleader's letter can ring through the cone, for them alone.
    if (holler && user.is_ringleader) {
      const said = text.length > 1400 ? text.slice(0, 1399) + "… (the rest is in your letters)" : text;
      for (const o of others) await sendBlast(env, ctx, user, { title: "A letter, just for you", body: said, url: `#/dm/${convId}`, audience: { type: "user", value: o.user_id, label: "A letter" } });
      return json({ id, hollered: others.length });
    }
    ctx.waitUntil(Promise.all(others.map((o) => notifyUser(env, o.user_id, { kind: "letter", title: `SQUAWK! A letter from ${user.display_name}`, body: text.length > 120 ? text.slice(0, 117) + "…" : text, url: `#/dm/${convId}` }, "notify_letters"))));
    return json({ id });
  }
  { const r = await volunteerRoutes(request, env, url, user); if (r) return r; }
  { const r = await jobRoutes(request, env, url, user); if (r) return r; }
  { const r = await crewRoutes(request, env, url, user); if (r) return r; }
  { const r = await doorRoutes(request, env, url, user); if (r) return r; }
  { const r = await partnerRoutes(request, env, url, user, ctx); if (r) return r; }
  { const r = await roomRoutes(request, env, url, user); if (r) return r; }
  { const r = await needRoutes(request, env, url, user); if (r) return r; }
  { const r = await passportRoutes(request, env, url, user); if (r) return r; }
  { const r = await pushRoutes(request, env, url, user); if (r) return r; }
  { const r = await blastRoutes(request, env, url, user, ctx); if (r) return r; }
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
    author: { display_name: row.a_name, rank: row.a_rank, is_ringleader: !!row.a_ring, photo: row.a_photo || null }
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
    door_cents: row.door_cents ?? null,
    partner_id: row.partner_id ?? null,
    partner_name: row.partner_name ?? null,
    partner_logo: row.partner_logo ?? null,
    tagline: row.tagline ?? null,
    lineup: row.lineup ?? null,
    photos_url: row.photos_url ?? null,
    flyer_url: row.flyer_url ?? null,
    entry_tickets: row.entry_tickets ?? null,
    slug: row.slug ?? null,
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
    is_partner: !!row.is_partner,
    waitlisted: !!row.waitlisted_at,
    tier: row.tier || "courtyard",
    last_seen_at: row.last_seen_at || null,
    created_at: row.created_at
  };
}

// What one member may see of another: no email/phone/Instagram unless that
// member switched sharing on for the field; no birthday, notes, dues, or
// signup answers ever.
function shapeMemberPublic(row) {
  return {
    id: row.id,
    display_name: row.display_name,
    rank: row.rank,
    is_ringleader: !!row.is_ringleader,
    is_organization: !!row.is_organization,
    is_partner: !!row.is_partner,
    waitlisted: !!row.waitlisted_at,
    home_chapter_id: row.home_chapter_id,
    home_chapter: row.home_chapter_id ? { name: row.c_name } : null,
    city: row.city || null,
    skills: row.skills || "",
    email: row.share_email ? row.email : null,
    phone: row.share_phone ? row.phone || null : null,
    instagram_handle: row.share_instagram ? row.instagram_handle || null : null
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
// The first email after signing up. Most people wait in line (the
// Ringleader lets new carnies in by hand); backers walk straight in.
async function sendWelcomeEmail(env, u) {
  const site = siteUrl(env), first = escapeEmailHtml(String(u.display_name || "").split(" ")[0]);
  if (!u.waitlisted_at) {
    return sendEmail(env, { to: u.email, subject: "🎪 Welcome backstage, " + String(u.display_name || "").split(" ")[0] + "!",
      html: emailFrame(env, { heading: "Come on in!", body: `<p style="margin:0 0 12px;">Hi ${first}! Carnival Society is a real carnival we're building together: real nights, real fire, real sawdust, real people. The app is the backstage.</p><p style="margin:0;">Your Dressing Room is ready. Say hello to the troupe, and the Ringleader has something waiting for you.</p>`, button: ["Open my Dressing Room", `${site}/#/dressing-room`] }),
      text: `Hi ${u.display_name}! Your Dressing Room is ready: ${site}/#/dressing-room` });
  }
  return sendEmail(env, { to: u.email, subject: "🎪 You're on the list!",
    html: emailFrame(env, { heading: "You're on the list!", body: `<p style="margin:0 0 12px;">Hi ${first}! Carnival Society is a real carnival we're building together: real nights, real fire, real sawdust, real people. The app is the backstage.</p><p style="margin:0 0 12px;">We open the doors a few carnies at a time, and <b>the Ringleader reads every hello by hand</b>. If you haven't introduced yourself yet, that's your first step: it's how we get to know you.</p><p style="margin:0;">You don't have to wait to come to a carnival. Grab a ticket anytime, and we'll email you the moment you're in.</p>`, button: ["Say hello", `${site}/#/dressing-room`] }),
    text: `Hi ${u.display_name}! You're on the list. Introduce yourself at ${site} and the Ringleader will let you in by hand. You can grab a carnival ticket anytime.` });
}
// "You're in!" when the Ringleader lets someone in from the waitlist.
async function sendYoureInEmail(env, id) {
  const who = await env.DB.prepare("SELECT email, display_name FROM users WHERE id = ?").bind(id).first();
  if (!who || who.email.endsWith("@door.carnivalsociety.org")) return false;
  const claim = await claimLinkFor(env, id);
  return sendEmail(env, { to: who.email, subject: "🎪 You're in! Welcome to Carnival Society",
    html: emailFrame(env, { heading: "You're in!", body: `<p style="margin:0 0 12px;">Hi ${escapeEmailHtml(who.display_name.split(" ")[0])}! The Ringleader just let you in, and your hello is up in the <b>Introduce yourself!</b> thread for the troupe to see.</p><p style="margin:0 0 12px;">Your Dressing Room is ready: decorate it, turn over your card of the day, wander backstage and visit someone's room, find a carnival, take a job.</p><p style="margin:0;">Everything you win in there, you earn out here, at real carnivals.</p>`, button: [claim ? "Claim my Dressing Room" : "Open my Dressing Room", claim ? `${siteUrl(env)}/#/claim/${claim}` : `${siteUrl(env)}/#/dressing-room`] }),
    text: `The Ringleader just let you in to Carnival Society! ${claim ? `Claim your Dressing Room: ${siteUrl(env)}/#/claim/${claim}` : `${siteUrl(env)}/#/dressing-room`}` });
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
// Jobs: tickets pinned to an event's flyer. Moderators post them; anyone
// signed in claims one (first come, first served), which also signs them up
// to volunteer. Marking a claim done grants the event's Roustabout stamp.
const UPCOMING = "COALESCE(e.ends_at, e.starts_at) >= datetime('now')";
async function jobsWithClaims(env, where, binds) {
  const { results: jobs } = await env.DB.prepare(
    `SELECT j.*, e.title AS event_title, e.starts_at AS event_starts FROM event_jobs j JOIN events e ON e.id = j.event_id WHERE ${where} ORDER BY e.starts_at, j.created_at`
  ).bind(...binds).all();
  if (!jobs.length) return [];
  const { results: claims } = await env.DB.prepare(
    `SELECT c.job_id, c.user_id, c.done_at, u.display_name FROM job_claims c JOIN users u ON u.id = c.user_id
     WHERE c.job_id IN (${jobs.map(() => "?").join(",")}) ORDER BY c.created_at`
  ).bind(...jobs.map((j) => j.id)).all();
  return jobs.map((j) => ({
    id: j.id, event_id: j.event_id, event_title: j.event_title, event_starts: j.event_starts,
    title: j.title, details: j.details, shift: j.shift, slots: j.slots,
    claims: claims.filter((c) => c.job_id === j.id).map((c) => ({ user_id: c.user_id, display_name: c.display_name, done: !!c.done_at })),
  }));
}
async function jobRoutes(request, env, url, user) {
  const { pathname } = url;
  const method = request.method;
  if (pathname === "/api/jobs" && method === "GET") {
    if (!user) return err(401, "Sign in required.");
    return json({ jobs: await jobsWithClaims(env, UPCOMING, []) });
  }
  if (pathname === "/api/me/jobs" && method === "GET") {
    if (!user) return err(401, "Sign in required.");
    return json({ jobs: await jobsWithClaims(env, `${UPCOMING} AND j.id IN (SELECT job_id FROM job_claims WHERE user_id = ?)`, [user.id]) });
  }
  const postMatch = pathname.match(/^\/api\/events\/([^/]+)\/jobs$/);
  if (postMatch && method === "POST") {
    if (!await canHost(env, user, postMatch[1])) return err(403, "Moderators only.");
    const evt = await env.DB.prepare(`SELECT e.id FROM events e WHERE e.id = ? AND ${UPCOMING}`).bind(postMatch[1]).first();
    if (!evt) return err(404, "That event has already happened.");
    const { title, details, shift, slots } = await body(request);
    const t = (title || "").trim().slice(0, 80);
    if (!t) return err(400, "Give the job a name.");
    const n = Math.min(Math.max(parseInt(slots, 10) || 1, 1), 20);
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO event_jobs (id, event_id, title, details, shift, slots, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, evt.id, t, (details || "").trim().slice(0, 300) || null, (shift || "").trim().slice(0, 40) || null, n, user.id).run();
    return json({ id });
  }
  const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobMatch && method === "DELETE") {
    const jobEv = await env.DB.prepare("SELECT event_id FROM event_jobs WHERE id = ?").bind(jobMatch[1]).first();
    if (!jobEv || !await canHost(env, user, jobEv.event_id)) return err(403, "Moderators only.");
    await env.DB.prepare("DELETE FROM event_jobs WHERE id = ?").bind(jobMatch[1]).run();
    return json({ ok: true });
  }
  const claimMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/claim$/);
  if (claimMatch && method === "POST") {
    if (!user) return err(401, "Sign in required.");
    const job = await env.DB.prepare(
      `SELECT j.id, j.slots, j.event_id, (SELECT COUNT(*) FROM job_claims c WHERE c.job_id = j.id) AS taken,
              EXISTS(SELECT 1 FROM job_claims c WHERE c.job_id = j.id AND c.user_id = ?) AS mine
       FROM event_jobs j JOIN events e ON e.id = j.event_id WHERE j.id = ? AND ${UPCOMING}`
    ).bind(user.id, claimMatch[1]).first();
    if (!job) return err(404, "That job isn't open anymore.");
    if (job.mine) return json({ ok: true });
    if (job.taken >= job.slots) return err(409, "Somebody beat you to it. That job is covered.");
    await env.DB.prepare("INSERT OR IGNORE INTO job_claims (job_id, user_id) VALUES (?, ?)").bind(job.id, user.id).run();
    await env.DB.prepare("INSERT OR IGNORE INTO event_volunteers (event_id, user_id) VALUES (?, ?)").bind(job.event_id, user.id).run();
    return json({ ok: true });
  }
  if (claimMatch && method === "DELETE") {
    if (!user) return err(401, "Sign in required.");
    await env.DB.prepare("DELETE FROM job_claims WHERE job_id = ? AND user_id = ? AND done_at IS NULL").bind(claimMatch[1], user.id).run();
    return json({ ok: true });
  }
  const otherMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/claims\/([^/]+)(\/done)?$/);
  if (otherMatch) {
    if (!isModerator(user)) return err(403, "Moderators only.");
    const [, jobId, userId, done] = otherMatch;
    if (done && method === "POST") {
      const job = await env.DB.prepare("SELECT j.event_id, j.title FROM event_jobs j JOIN job_claims c ON c.job_id = j.id WHERE j.id = ? AND c.user_id = ?").bind(jobId, userId).first();
      if (!job) return err(404, "They're not on that job.");
      await env.DB.prepare("UPDATE job_claims SET done_at = datetime('now') WHERE job_id = ? AND user_id = ?").bind(jobId, userId).run();
      const r = await grantStamp(env, { userId, kind: "roustabout", eventId: job.event_id, note: `Job: ${job.title}`, grantedBy: user.id });
      return json({ ok: true, ...r });
    }
    if (!done && method === "DELETE") {
      await env.DB.prepare("DELETE FROM job_claims WHERE job_id = ? AND user_id = ?").bind(jobId, userId).run();
      return json({ ok: true });
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// Crew tables + handshakes. Your crew = everyone volunteering at the event
// (taking a job signs you up). Handshakes open 2h before it starts and stay
// open a week after it ends; both people must say yes.
const SHAKE_OPEN = "datetime('now') >= datetime(e.starts_at, '-2 hours') AND datetime('now') <= datetime(COALESCE(e.ends_at, e.starts_at), '+7 days')";
const pair = (a, b) => (a < b ? [a, b] : [b, a]);
async function crewRoutes(request, env, url, user) {
  const { pathname } = url;
  const method = request.method;
  const crewMatch = pathname.match(/^\/api\/events\/([^/]+)\/table$/);
  if (crewMatch && method === "GET") {
    if (!user) return err(401, "Sign in required.");
    const evt = await env.DB.prepare(`SELECT e.id, e.title, (${SHAKE_OPEN}) AS shake_open FROM events e WHERE e.id = ?`).bind(crewMatch[1]).first();
    if (!evt) return err(404, "No such event.");
    const mine = await env.DB.prepare("SELECT 1 FROM event_volunteers WHERE event_id = ? AND user_id = ?").bind(evt.id, user.id).first();
    if (!mine && !isModerator(user)) return json({ am_crew: false });
    const { results: crew } = await env.DB.prepare(
      `SELECT u.id, u.display_name, u.rank, u.is_ringleader,
              (SELECT GROUP_CONCAT(j.title, ' · ') FROM job_claims c JOIN event_jobs j ON j.id = c.job_id WHERE c.user_id = u.id AND j.event_id = v.event_id) AS jobs,
              h.met_at, h.asked_by
       FROM event_volunteers v JOIN users u ON u.id = v.user_id
       LEFT JOIN handshakes h ON (h.user_a = MIN(u.id, ?) AND h.user_b = MAX(u.id, ?))
       WHERE v.event_id = ? ORDER BY v.created_at`
    ).bind(user.id, user.id, evt.id).all();
    const { results: messages } = await env.DB.prepare(
      `SELECT m.id, m.user_id, m.body, m.created_at, u.display_name FROM crew_messages m JOIN users u ON u.id = m.user_id
       WHERE m.event_id = ? ORDER BY m.id DESC LIMIT 60`
    ).bind(evt.id).all();
    return json({
      am_crew: !!mine, shake_open: !!evt.shake_open,
      crew: crew.map((c) => ({
        id: c.id, display_name: c.display_name, rank: c.rank, is_ringleader: !!c.is_ringleader, jobs: c.jobs || null,
        shake: c.id === user.id ? "me" : c.met_at ? "met" : c.asked_by === user.id ? "asked" : c.asked_by ? "asks_you" : null,
      })),
      messages: messages.reverse(),
    });
  }
  const msgMatch = pathname.match(/^\/api\/events\/([^/]+)\/table\/messages$/);
  if (msgMatch && method === "POST") {
    if (!user) return err(401, "Sign in required.");
    const ok = await env.DB.prepare(
      `SELECT 1 FROM event_volunteers v JOIN events e ON e.id = v.event_id
       WHERE v.event_id = ? AND v.user_id = ? AND datetime('now') <= datetime(COALESCE(e.ends_at, e.starts_at), '+7 days')`
    ).bind(msgMatch[1], user.id).first();
    if (!ok) return err(403, "The crew table is for this event's crew.");
    const text = ((await body(request)).body || "").trim().slice(0, 600);
    if (!text) return err(400, "Say something first.");
    await env.DB.prepare("INSERT INTO crew_messages (event_id, user_id, body) VALUES (?, ?, ?)").bind(msgMatch[1], user.id, text).run();
    return json({ ok: true });
  }
  if (pathname === "/api/handshakes" && method === "POST") {
    if (!user) return err(401, "Sign in required.");
    const { user_id, event_id } = await body(request);
    if (!user_id || user_id === user.id) return err(400, "Pick someone to shake hands with.");
    const both = await env.DB.prepare(
      `SELECT e.title FROM events e WHERE e.id = ? AND ${SHAKE_OPEN}
         AND EXISTS(SELECT 1 FROM event_volunteers WHERE event_id = e.id AND user_id = ?)
         AND EXISTS(SELECT 1 FROM event_volunteers WHERE event_id = e.id AND user_id = ?)`
    ).bind(event_id || "", user.id, user_id).first();
    if (!both) return err(403, "Handshakes are for crewmates, from just before the event to a week after.");
    const [a, b] = pair(user.id, user_id);
    const row = await env.DB.prepare("SELECT asked_by, met_at FROM handshakes WHERE user_a = ? AND user_b = ?").bind(a, b).first();
    if (row?.met_at) return json({ status: "met" });
    if (row && row.asked_by !== user.id) {
      await env.DB.prepare("UPDATE handshakes SET met_at = datetime('now') WHERE user_a = ? AND user_b = ?").bind(a, b).run();
      await notifyUser(env, row.asked_by, { kind: "letter", title: `🤝 You and ${user.display_name} shook hands!`, body: `Met at ${both.title}. They're in your Troupe Album now.`, url: "#/album", ref: `met:${a}:${b}` }, "notify_letters");
      return json({ status: "met" });
    }
    if (!row) {
      await env.DB.prepare("INSERT INTO handshakes (user_a, user_b, event_id, asked_by) VALUES (?, ?, ?, ?)").bind(a, b, event_id, user.id).run();
      await notifyUser(env, user_id, { kind: "letter", title: `🤝 ${user.display_name} wants to shake hands`, body: `You were on the ${both.title} crew together. Say yes and you're in each other's Troupe Album.`, url: `#/event/${event_id}`, ref: `shake:${a}:${b}` }, "notify_letters");
    }
    return json({ status: "asked" });
  }
  if (pathname === "/api/me/album" && method === "GET") {
    if (!user) return err(401, "Sign in required.");
    const { results } = await env.DB.prepare(
      `SELECT u.id, u.display_name, u.rank, u.is_ringleader, u.city, h.met_at, e.title AS event_title
       FROM handshakes h JOIN users u ON u.id = CASE WHEN h.user_a = ? THEN h.user_b ELSE h.user_a END
       LEFT JOIN events e ON e.id = h.event_id
       WHERE (h.user_a = ? OR h.user_b = ?) AND h.met_at IS NOT NULL ORDER BY h.met_at DESC`
    ).bind(user.id, user.id, user.id).all();
    return json({ album: results });
  }
  // For the raven: crews you're on with handshakes waiting.
  if (pathname === "/api/me/crews" && method === "GET") {
    if (!user) return err(401, "Sign in required.");
    const { results } = await env.DB.prepare(
      `SELECT e.id, e.title,
              (SELECT COUNT(*) FROM event_volunteers v2 WHERE v2.event_id = e.id AND v2.user_id != ?
                 AND NOT EXISTS(SELECT 1 FROM handshakes h WHERE h.user_a = MIN(v2.user_id, ?) AND h.user_b = MAX(v2.user_id, ?) AND (h.met_at IS NOT NULL OR h.asked_by = ?))) AS unshaken,
              (SELECT COUNT(*) FROM event_volunteers v3 JOIN handshakes h ON h.user_a = MIN(v3.user_id, ?) AND h.user_b = MAX(v3.user_id, ?)
                 WHERE v3.event_id = e.id AND v3.user_id != ? AND h.met_at IS NULL AND h.asked_by = v3.user_id) AS asks
       FROM events e JOIN event_volunteers v ON v.event_id = e.id AND v.user_id = ?
       WHERE ${SHAKE_OPEN} ORDER BY e.starts_at`
    ).bind(user.id, user.id, user.id, user.id, user.id, user.id, user.id, user.id).all();
    return json({ crews: results });
  }
  return null;
}

// ---------------------------------------------------------------------
// Personal Dressing Rooms. Everyone has one: a theme (painting) and a
// layout. Most decorations are free; a few specials are earned at real
// carnivals (stamps), by meeting people (handshakes) or by rank. The
// Ringleader's room falls back to the original shared layout.
const ROOM_THEMES = ["classic", "fire", "aerial", "celestial", "original", "office"];
// The Ringleader's own rooms: the Ringmaster's Office (Sunny & Daisy roam it)
// and the Original painting. Nobody else can pick them.
const RINGLEADER_THEMES = ["office", "original"];
const ROOM_ITEM_ROLES = ["decor", "mirror", "trunk", "costume", "flyer", "raven", "book", "drawer", "exit", "hatbox", "potion", "stars", "popcorn", "events", "tickets", "megaphone"];
const ROOM_ANIM = ["", "sway", "flutter", "float", "breathe", "hop", "shimmer", "wobble"];
const ROOM_SPECIALS = {
  "items/crystal_ball": { stamp: "ticket", how: "Get checked in at a carnival (Ticket Punched)." },
  "items/unicycle": { stamp: "roustabout", how: "Work a volunteer shift (Roustabout)." },
  "items/rocking_horse": { stamp: "roustabout", how: "Work a volunteer shift (Roustabout)." },
  "items/juggling_pins": { stamp: "sawdust", how: "Build something for a carnival (Sawdust)." },
  "items/rabbit_hat": { stamp: "barker", how: "Bring a friend who shows up (Barker)." },
  "items/big_top": { stamp: "canvasman", how: "Lead a crew or teach a skill (Boss Canvasman)." },
  "items/gramophone": { handshakes: 3, how: "Shake hands with 3 crewmates." },
  "items/aerial_silks": { rank: true, how: "Become an Apprentice." },
  "items/mercury_deck": { backer: true, how: "A thank-you gift for the Mercury Oracle's backers." },
  // Prizes (2026-10-14, Neeff's Kooky Collector sheet). A few unlock on
  // their own; the rest the Ringleader hands out as surprises (gift).
  "items/first_ticket": { stamp: "ticket", how: "Come to your first carnival." },
  "items/friendship_bracelet": { handshakes: 5, how: "Shake hands with 5 crewmates." },
  "items/pennant_kooks": { event: "kooks", how: "Come to Carnival for Kooks." },
  "items/quill_ink": { notesWritten: 10, how: "Leave notes on 10 mirrors." },
  "items/guestbook": { visitors: 10, how: "Get notes from 10 different visitors." },
  "items/paint_pot": { gift: true, how: "Paint a sign for a carnival. (You will be painting signs!)" },
  "items/pie": { gift: true, how: "Bring food to a carnival. You must, I'm afraid." },
  "items/rope_knot": { gift: true, how: "Tie the ropes: rig something at a carnival." },
  "items/juggling_clubs": { gift: true, how: "Make a game for a carnival." },
  "items/gift_basket": { gift: true, how: "Bring something for everyone. Generosity is a virtue." },
  "items/clown_nose": { gift: true, how: "Ask for a role instead of how you can help. 🤡" },
  "items/jack_o_lantern": { gift: true, how: "Come to the Halloween carnival." },
  "items/snow_globe": { gift: true, how: "Come to the winter Freakshow." },
  "items/welcome_wreath": { gift: true, how: "Finish your first-day checklist." },
  "items/thank_you_card": { gift: true, how: "Someone's thank-you." },
  "items/golden_ticket": { gift: true, how: "A gift from the Ringleader." },
  "items/backstage_pass": { gift: true, how: "A gift from the Ringleader." },
  "items/medal": { gift: true, how: "Save the day. A gift from the Ringleader." },
  "items/plush_sunny": { gift: true, how: "A gift from the Ringleader (and Sunny)." },
  "items/plush_daisy": { gift: true, how: "A gift from the Ringleader (and Daisy)." },
  "items/photo_frame": { gift: true, how: "A gift from the Ringleader." },
  // Trophies (2026-10-14): only ever handed out by the Ringleader.
  "items/trophy_cup": { gift: true, how: "A trophy from the Ringleader: Grand Champion Cup." },
  "items/trophy_hoops": { gift: true, how: "A trophy from the Ringleader: Golden Hoops." },
  "items/trophy_horse": { gift: true, how: "A trophy from the Ringleader: Bareback Rider." },
  "items/trophy_bigtop": { gift: true, how: "A trophy from the Ringleader: Big Top Award." },
  "items/trophy_stars": { gift: true, how: "A trophy from the Ringleader: Shooting Stars." },
  "items/trophy_jester": { gift: true, how: "A trophy from the Ringleader: Fool of the Year." },
  "items/trophy_elephant": { gift: true, how: "A trophy from the Ringleader: The Elephant Never Forgets." },
  "items/trophy_laurel": { gift: true, how: "A trophy from the Ringleader: Laurels." },
  "items/trophy_cup_bigtop": { gift: true, how: "A trophy from the Ringleader: Big Top Cup." },
  "items/trophy_cannon": { gift: true, how: "A trophy from the Ringleader: Human Cannonball." },
  "items/trophy_crown": { gift: true, how: "A trophy from the Ringleader: King or Queen of the Carnival." },
  "items/trophy_star": { gift: true, how: "A trophy from the Ringleader: Star of the Show." },
};
async function roomUnlocks(env, userId) {
  const u = await env.DB.prepare("SELECT rank, is_ringleader FROM users WHERE id = ?").bind(userId).first();
  if (u?.is_ringleader) return Object.keys(ROOM_SPECIALS);
  const { results } = await env.DB.prepare("SELECT DISTINCT kind FROM stamps WHERE user_id = ?").bind(userId).all();
  const kinds = new Set(results.map((r) => r.kind));
  const met = (await env.DB.prepare("SELECT COUNT(*) AS n FROM handshakes WHERE (user_a = ? OR user_b = ?) AND met_at IS NOT NULL").bind(userId, userId).first()).n;
  // A special you were given as a surprise is yours, earned or not.
  const { results: gifts } = await env.DB.prepare("SELECT DISTINCT img FROM room_gifts WHERE room_user_id = ? AND opened_at IS NOT NULL").bind(userId).all();
  const given = new Set(gifts.map((g) => g.img));
  const backer = !!(await env.DB.prepare("SELECT 1 FROM backers b JOIN users u ON lower(u.email) = b.email WHERE u.id = ?").bind(userId).first());
  const c = await env.DB.prepare(
    `SELECT (SELECT COUNT(DISTINCT room_user_id) FROM room_notes WHERE author_id = ?1 AND room_user_id != ?1) AS wrote,
            (SELECT COUNT(DISTINCT author_id) FROM room_notes WHERE room_user_id = ?1 AND author_id != ?1) AS visitors,
            (SELECT group_concat(DISTINCT e.slug) FROM door_entries d JOIN events e ON e.id = d.event_id WHERE d.user_id = ?1 AND d.voided_at IS NULL) AS came`
  ).bind(userId).first();
  const came = new Set(String(c.came || "").split(","));
  return Object.entries(ROOM_SPECIALS).filter(([k, r]) => given.has(k) || (r.backer && backer) ||
    (r.event && came.has(r.event)) || (r.notesWritten && c.wrote >= r.notesWritten) || (r.visitors && c.visitors >= r.visitors) || (r.stamp && kinds.has(r.stamp)) || (r.handshakes && met >= r.handshakes) || (r.rank && u && u.rank !== "clown")).map(([k]) => k);
}
function cleanRoomItems(raw, { ringleader, unlocked }) {
  if (raw === null) return null;
  if (!Array.isArray(raw) || raw.length > 90) throw new Error("That room has too many things in it.");
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : d; };
  return raw.map((it) => {
    const img = it.img == null ? null : String(it.img);
    if (img !== null && !/^(items\/|cats\/)?[a-z_]{2,30}$/.test(img)) throw new Error("Unknown decoration.");
    if (img && img.startsWith("cats/") && !ringleader) throw new Error("Sunny and Daisy live in the Ringmaster's office.");
    if (img && ROOM_SPECIALS[img] && !unlocked.includes(img)) throw new Error(`Not unlocked yet: ${ROOM_SPECIALS[img].how}`);
    const role = ROOM_ITEM_ROLES.includes(it.role) ? it.role : "decor";
    if (role === "megaphone" || img === "megaphone_floor") return null; // the cone lives in code, not in rooms
    if (role === "hatbox" && !ringleader) throw new Error("The hat box is the Ringleader's.");
    return {
      id: String(it.id || "").slice(0, 16) || Math.random().toString(36).slice(2, 8), role, img,
      l: num(it.l, -10, 105, 40), t: num(it.t, -10, 105, 40), w: num(it.w, 1, 80, 10), ...(it.h != null ? { h: num(it.h, 1, 80, 10) } : {}),
      ...(it.rot ? { rot: num(it.rot, -45, 45, 0) } : {}), ...(it.flip ? { flip: true } : {}), ...(it.z ? { z: Math.round(num(it.z, -50, 50, 0)) } : {}),
      ...(ROOM_ANIM.includes(it.anim) && it.anim ? { anim: it.anim } : {}), ...(role === "flyer" ? { n: Math.round(num(it.n, 0, 5, 0)) } : {}),
      ...(typeof it.gift === "string" && /^[a-f0-9]{8,32}$/.test(it.gift) ? { gift: it.gift } : {}),
    };
  }).filter(Boolean);
}
async function roomFor(env, ownerId) {
  const owner = await env.DB.prepare("SELECT id, display_name, rank, is_ringleader FROM users WHERE id = ?").bind(ownerId).first();
  if (!owner) return null;
  const row = await env.DB.prepare("SELECT theme, items FROM user_rooms WHERE user_id = ?").bind(ownerId).first();
  let theme = row?.theme || "classic", items = row?.items ? JSON.parse(row.items) : null;
  if (!row && owner.is_ringleader) {
    const shared = await env.DB.prepare("SELECT data FROM room_layout WHERE id = 'main'").first();
    theme = "original"; items = shared ? JSON.parse(shared.data) : null;
  }
  const { results: notes } = await env.DB.prepare(
    `SELECT n.id, n.body, n.created_at, n.author_id, u.display_name FROM room_notes n JOIN users u ON u.id = n.author_id
     WHERE n.room_user_id = ? ORDER BY n.id DESC LIMIT 12`
  ).bind(ownerId).all();
  return { owner: { ...owner, is_ringleader: !!owner.is_ringleader }, theme, items, notes };
}
// The surprises in a room. The owner sees all of theirs (to unwrap, and to
// reread the notes); a Ringleader visiting sees the ones still wrapped.
async function roomGifts(env, ownerId, { wrappedOnly = false } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.kind, g.img, g.note, g.code, g.event_id, g.created_at, g.opened_at, g.redeemed_at,
            u.display_name AS from_name, e.title AS event_title, r.title AS redeemed_title
     FROM room_gifts g LEFT JOIN users u ON u.id = g.from_id LEFT JOIN events e ON e.id = g.event_id LEFT JOIN events r ON r.id = g.redeemed_event_id
     WHERE g.room_user_id = ? ${wrappedOnly ? "AND g.opened_at IS NULL" : ""} ORDER BY g.created_at`
  ).bind(ownerId).all();
  return results.map((g) => (g.opened_at ? g : { ...g, code: null }));
}
// ---------------------------------------------------------------------
// Getting in (2026-10-14): one public page per carnival (/t/<slug>), no
// sign-up first. Name + email, then either "Save my spot" (pay at the
// door) or, once Stripe is set up, pay now. The email puts you in the
// system: a new account (with a claim link), or the one you already have.
// Entry is the event's door price plus the one-time registration the first
// time, and comes with entry_tickets paper carnival tickets.
const EVENT_COLS = "id, title, description, location, starts_at, ends_at, capacity, door_cents, entry_tickets, ticket_cents, slug, partner_id, photos_url, tagline, lineup, flyer_url, (SELECT display_name FROM users WHERE id = events.partner_id) AS partner_name";
// SQLite and ISO times both, read as UTC.
const whenMs = (t) => Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(t) ? t : String(t).replace(" ", "T") + "Z");
async function findEvent(env, idOrSlug) {
  return env.DB.prepare(`SELECT ${EVENT_COLS} FROM events WHERE id = ? OR slug = ?`).bind(idOrSlug, String(idOrSlug).toLowerCase()).first();
}
// The hidden tier every entry ticket hangs off (active = 0 keeps it out of
// the members-only tier panel; it's sold from the public page instead).
async function entryTier(env, ev) {
  const t = await env.DB.prepare("SELECT id FROM ticket_tiers WHERE event_id = ? AND name = 'Entry' AND active = 0").bind(ev.id).first();
  if (t) { await env.DB.prepare("UPDATE ticket_tiers SET price_cents = ? WHERE id = ?").bind(ev.door_cents || 0, t.id).run(); return t.id; }
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO ticket_tiers (id, event_id, name, description, price_cents, active) VALUES (?, ?, 'Entry', 'Entry, sold from the public page', ?, 0)").bind(id, ev.id, ev.door_cents || 0).run();
  return id;
}
// Already registered: paid the $5 once (the Fix stamp), or already let into
// the troupe (off the waitlist: members, backers). Only waitlisted and brand
// new accounts owe the one-time $5.
async function hasFix(env, userId) {
  return !!await env.DB.prepare(
    "SELECT 1 FROM stamps WHERE user_id = ? AND kind = 'fix' UNION SELECT 1 FROM users WHERE id = ? AND waitlisted_at IS NULL LIMIT 1"
  ).bind(userId, userId).first();
}
// Name + email → an account: the one that email already has, or a new
// Courtyard account with a claim link (never a claim link for an old one).
// ── Introductions (2026-10-14) ── one pinned thread in the Courtyard where
// every newcomer's hello lands (from the Ringleader's welcome on down).
const INTRO_TITLE = "Introduce yourself! 👋";
const INTRO_OPENING = "This is a real carnival we're building together: real nights, real fire, real sawdust, real people. This app is the backstage, and this thread is the stage door.\n\nWhen you arrive, say hello: where you're from, what brings you here, what you want to make or do or see. Then say hi to whoever came in before you. Welcome to the troupe!";
const parseIntro = (s) => { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } };
async function introThreadId(env, { create = true } = {}) {
  const found = await env.DB.prepare("SELECT p.id FROM posts p JOIN boards b ON b.id = p.board_id WHERE b.slug = ? AND p.parent_id IS NULL AND p.title = ? ORDER BY p.created_at LIMIT 1").bind(COURTYARD_SLUG, INTRO_TITLE).first();
  if (found || !create) return found?.id || null;
  const board = await env.DB.prepare("SELECT id FROM boards WHERE slug = ?").bind(COURTYARD_SLUG).first();
  const rl = await env.DB.prepare("SELECT id FROM users WHERE is_ringleader = 1 ORDER BY created_at LIMIT 1").first();
  if (!board || !rl) return null;
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO posts (id, board_id, author_id, title, body, pinned) VALUES (?, ?, ?, ?, ?, 1)").bind(id, board.id, rl.id, INTRO_TITLE, INTRO_OPENING).run();
  return id;
}
// "Welcome, Dot!" in the introductions thread: the newcomers it names (or,
// if it names nobody, the newest one) get a squawk that someone said hello.
async function nudgeHellos(env, from, threadId, text) {
  const { results } = await env.DB.prepare(
    `SELECT p.author_id AS id, u.display_name FROM posts p JOIN users u ON u.id = p.author_id
     WHERE p.parent_id = ? AND p.author_id != ? AND p.id = u.intro_post_id AND p.created_at > datetime('now', '-30 days')
     ORDER BY p.created_at DESC LIMIT 40`
  ).bind(threadId, from.id).all();
  const low = text.toLowerCase();
  let to = results.filter((r) => { const f = r.display_name.split(" ")[0].toLowerCase(); return f.length > 1 && new RegExp(`\\b${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(low); });
  if (!to.length && results[0]) to = [results[0]];
  for (const r of to) await notifyUser(env, r.id, { kind: "letter", title: `👋 ${from.display_name} said hello to you!`, body: text.slice(0, 120), url: `#/post/${threadId}` }, "notify_letters");
}
// Their hello goes up in the thread, once, when they're in (not while waiting).
async function publishIntro(env, userId) {
  const u = await env.DB.prepare("SELECT intro, intro_post_id, skills, waitlisted_at FROM users WHERE id = ?").bind(userId).first();
  const intro = parseIntro(u?.intro);
  if (!intro || u.intro_post_id || u.waitlisted_at) return;
  const thread = await introThreadId(env);
  if (!thread) return;
  const board = await env.DB.prepare("SELECT board_id FROM posts WHERE id = ?").bind(thread).first();
  const id = crypto.randomUUID();
  const text = `📍 ${intro.from}${u.skills ? `\n🎪 ${u.skills}` : ""}\n\n${intro.about}`;
  await env.DB.prepare("INSERT INTO posts (id, board_id, author_id, parent_id, body) VALUES (?, ?, ?, ?, ?)").bind(id, board.board_id, userId, thread, text).run();
  await env.DB.prepare("UPDATE users SET intro_post_id = ? WHERE id = ?").bind(id, userId).run();
}
// ── Backers (2026-10-14) ── people who backed the Mercury Oracle with extra
// support: a private list (name + email) the Ringleader keeps. They skip the
// waitlist and get a welcome holler + the Mercury Oracle deck on their dresser.
const MERCURY_ORACLE = "https://mercury-oracle.vercel.app";
// The deck's cards (title, phrase, meaning, image), straight from the
// oracle's own cards.json; kept warm for an hour per worker.
let mercuryCache = { at: 0, cards: [] };
async function mercuryCards() {
  if (mercuryCache.cards.length && Date.now() - mercuryCache.at < 3600e3) return mercuryCache.cards;
  try {
    const res = await fetch(`${MERCURY_ORACLE}/cards.json`, { cf: { cacheTtl: 3600 } });
    const d = await res.json();
    const cards = (d.tiers || []).flatMap((t) => t.cards || []).filter((c) => c.title);
    if (cards.length) mercuryCache = { at: Date.now(), cards };
  } catch (e) { console.error("mercury cards", e); }
  return mercuryCache.cards;
}
// Backers (and the Ringleader) hold the whole deck; everyone gets a card a day.
async function hasFullDeck(env, user) {
  return !!user && (!!user.is_ringleader || !!(await backerOf(env, user)));
}
const BACKER_WELCOME = "Welcome and thank you for all of your help seeing this project get finished! I've spent a while getting this organized and would love to give you all the gift of a digital oracle.";
const backerOf = (env, user) => user?.email ? env.DB.prepare("SELECT * FROM backers WHERE email = lower(?)").bind(user.email).first() : null;
async function letBackerIn(env, userId, email) {
  await env.DB.prepare("UPDATE users SET waitlisted_at = NULL WHERE id = ? AND EXISTS (SELECT 1 FROM backers WHERE email = lower(?))").bind(userId, email).run();
}
async function userByEmail(env, name, email, heard) {
  const user = await env.DB.prepare("SELECT id, email, display_name FROM users WHERE lower(email) = ?").bind(email).first();
  if (user) return { user, claim: null };
  const id = crypto.randomUUID();
  const { hash, salt } = await hashPassword(bytesToHex(crypto.getRandomValues(new Uint8Array(24))));
  await env.DB.prepare("INSERT INTO users (id, email, password_hash, salt, display_name, rank, heard_about_us, waitlisted_at) VALUES (?, ?, ?, ?, ?, 'clown', ?, datetime('now'))")
    .bind(id, email, hash, salt, name, (heard || "").trim().slice(0, 120) || null).run();
  await letBackerIn(env, id, email);
  const token = bytesToHex(crypto.getRandomValues(new Uint8Array(24)));
  await env.DB.prepare("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+60 days'))").bind(await sha256Hex(token), id).run();
  return { user: { id, email, display_name: name }, claim: token };
}
const friendCount = async (env, id) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM handshakes WHERE (user_a = ? OR user_b = ?) AND met_at IS NOT NULL").bind(id, id).first()).n;
async function publicRoutes(request, env, url) {
  const { pathname } = url;
  const method = request.method;
  const reg = Number(env.MEMBERSHIP_PRICE_CENTS || 500);
  const flyerImg = pathname.match(/^\/api\/public\/flyers\/([^/]+)$/);
  if (flyerImg && method === "GET") {
    const row = await env.DB.prepare("SELECT data FROM event_flyers WHERE event_id = ?").bind(flyerImg[1]).first();
    if (!row) return err(404, "No poster.");
    const [, type, b64] = row.data.match(/^data:([^;]+);base64,(.*)$/);
    return new Response(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), { headers: { "Content-Type": type, "Cache-Control": "public, max-age=604800, immutable" } });
  }
  const evMatch = pathname.match(/^\/api\/public\/events\/([^/]+)$/);
  if (evMatch && method === "GET") {
    const ev = await findEvent(env, evMatch[1]);
    if (!ev) return err(404, "No such carnival.");
    const taken = await env.DB.prepare("SELECT COALESCE(SUM(quantity), 0) AS n FROM tickets WHERE event_id = ? AND status IN ('paid', 'reserved')").bind(ev.id).first();
    const host = ev.partner_id ? await env.DB.prepare("SELECT display_name, partner_slug, avatar_url FROM users WHERE id = ?").bind(ev.partner_id).first() : null;
    return json({ event: ev, partner: host && { name: host.display_name, slug: host.partner_slug, logo: host.avatar_url },  registration_cents: reg, payments_enabled: cardPayments(env),
      spots_left: ev.capacity ? Math.max(0, ev.capacity - taken.n) : null, open: whenMs(ev.ends_at || ev.starts_at) > Date.now() - 6 * 3600e3 });
  }
  const getMatch = pathname.match(/^\/api\/public\/events\/([^/]+)\/get$/);
  if (getMatch && method === "POST") {
    if (await rateLimited(env, request, "signup")) return err(429, "Too many tries. Wait a minute and try again.");
    const ev = await findEvent(env, getMatch[1]);
    if (!ev) return err(404, "No such carnival.");
    if (ev.door_cents == null) return err(400, "Tickets for this one aren't open yet.");
    const b = await body(request);
    const name = (b.name || "").trim().slice(0, 60);
    const email = normalizeEmail(b.email || "");
    if (!name) return err(400, "What's your name?");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err(400, "That email doesn't look right.");
    const { user, claim } = await userByEmail(env, name, email, b.heard);
    // "Also join <co-host>": friends now, not just once they're through the door.
    if (b.join_partner && ev.partner_id) await befriendPartner(env, ev.partner_id, user.id, ev.id);
    // How many people this ticket lets in: the buyer plus guests.
    const qty = Math.min(TICKET_MAX, Math.max(1, Math.round(Number(b.quantity)) || 1));
    const have = await env.DB.prepare("SELECT code, status FROM tickets WHERE event_id = ? AND user_id = ? AND status IN ('paid', 'reserved') LIMIT 1").bind(ev.id, user.id).first();
    // Already have one and just saving a single spot again: with email on, it
    // goes to the inbox (never shown to whoever typed the address). Paying, or
    // bringing friends, makes a new ticket.
    if (have && qty === 1 && !b.pay) {
      if (env.RESEND_API_KEY) {
        const t = await env.DB.prepare("SELECT id FROM tickets WHERE code = ?").bind(have.code).first();
        if (await sendTicketEmail(env, t.id, { claim })) return json({ emailed: true, already: true });
      }
      return json({ code: have.code, already: true, claim });
    }
    const first = !await hasFix(env, user.id);
    const owe = (ev.door_cents || 0) * qty + (first ? reg : 0);
    const tierId = await entryTier(env, ev);
    const id = crypto.randomUUID(), code = ticketCode();
    const pay = !!b.pay && cardPayments(env) && owe > 0;
    await env.DB.prepare("INSERT INTO tickets (id, event_id, tier_id, user_id, status, price_cents, code, quantity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, ev.id, tierId, user.id, pay ? "pending" : owe === 0 ? "paid" : "reserved", ev.door_cents || 0, code, qty).run();
    if (!pay) {
      const emailed = await sendTicketEmail(env, id, { claim });
      // An existing account's ticket goes to its inbox, not the screen.
      if (emailed && !claim) return json({ emailed: true, reserved: owe > 0 });
      return json({ code, claim, reserved: owe > 0, emailed });
    }
    let session;
    try {
      session = await stripeCheckout(env, checkoutParams(env, {
        user, name: `${ev.title}: ${qty > 1 ? qty + " entries, each with " : "entry + "}${ev.entry_tickets || 0} free carnival tickets${first ? " + one-time $5 membership (first carnival only)" : ""}`, amountCents: owe,
        metadata: { kind: "ticket", user_id: user.id, ticket_id: id, registration: first ? String(reg) : "0" },
        successPath: `/#/ticket/${code}${claim ? "/" + claim : ""}`,
      }));
    } catch (e) {
      console.error(e);
      await env.DB.prepare("DELETE FROM tickets WHERE id = ?").bind(id).run();
      return err(502, "Card payments aren't working right now. Tap “Save my spot” and pay at the door instead.");
    }
    await env.DB.prepare("UPDATE tickets SET stripe_session_id = ? WHERE id = ?").bind(session.id, id).run();
    return json({ url: session.url });
  }
  // A partner's join page.
  const pMatch = pathname.match(/^\/api\/public\/partners\/([a-z0-9-]{2,40})(\/join)?$/);
  if (pMatch) {
    const pt = await env.DB.prepare("SELECT id, display_name, partner_slug, partner_blurb, partner_link, avatar_url FROM users WHERE partner_slug = ? AND is_partner = 1").bind(pMatch[1]).first();
    if (!pt) return err(404, "No partner by that name.");
    if (!pMatch[2] && method === "GET") {
      const { results: events } = await env.DB.prepare(
        `SELECT id, title, starts_at, location, door_cents, entry_tickets, slug FROM events WHERE partner_id = ? AND COALESCE(ends_at, starts_at) >= datetime('now') ORDER BY starts_at LIMIT 6`
      ).bind(pt.id).all();
      return json({ partner: { name: pt.display_name, slug: pt.partner_slug, blurb: pt.partner_blurb, link: pt.partner_link, logo: pt.avatar_url }, friends: await friendCount(env, pt.id), events });
    }
    if (pMatch[2] && method === "POST") {
      if (await rateLimited(env, request, "signup")) return err(429, "Too many tries. Wait a minute and try again.");
      const b = await body(request);
      const name = (b.name || "").trim().slice(0, 60), email = normalizeEmail(b.email || "");
      if (!name) return err(400, "What's your name?");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err(400, "That email doesn't look right.");
      const { user, claim } = await userByEmail(env, name, email, `Joined ${pt.display_name}`);
      if (user.id === pt.id) return err(400, "That's you!");
      const [x, y] = pt.id < user.id ? [pt.id, user.id] : [user.id, pt.id];
      const was = await env.DB.prepare("SELECT met_at FROM handshakes WHERE user_a = ? AND user_b = ?").bind(x, y).first();
      await befriendPartner(env, pt.id, user.id, null);
      if (!was?.met_at) await notifyUser(env, pt.id, { kind: "letter", title: `🤝 ${name} joined ${pt.display_name}`, body: "A new friend from your join page.", url: "#/partner" }, "notify_letters");
      return json({ ok: true, already: !!was?.met_at, claim, name: pt.display_name });
    }
  }
  // A ticket, by its code: what the buyer's phone shows at the door.
  const tMatch = pathname.match(/^\/api\/public\/tickets\/([0-9a-f]{20})$/);
  if (tMatch && method === "GET") {
    const t = await env.DB.prepare(
      `SELECT t.code, t.status, t.stripe_session_id, t.checked_in_at, t.price_cents, t.quantity, t.user_id, u.display_name, e.title, e.starts_at, e.location, e.entry_tickets, e.slug, e.id AS event_id
       FROM tickets t JOIN users u ON u.id = t.user_id JOIN events e ON e.id = t.event_id WHERE t.code = ?`
    ).bind(tMatch[1]).first();
    if (!t) return err(404, "No ticket with that code.");
    // Paid on Stripe but no webhook yet: ask Stripe ourselves.
    if (t.status === "pending" && t.stripe_session_id && env.STRIPE_SECRET_KEY) {
      try {
        const s = await stripeSession(env, t.stripe_session_id);
        if (s && await fulfillCheckout(env, s)) t.status = "paid";
      } catch (e) { console.error(e); }
    }
    const first = !await hasFix(env, t.user_id);
    return json({ ticket: { code: t.code, status: t.status, checked_in: !!t.checked_in_at, name: t.display_name.split(" ")[0], title: t.title, starts_at: t.starts_at, location: t.location,
      entry_tickets: t.entry_tickets || 0, entry_cents: t.price_cents * t.quantity, quantity: t.quantity, owe_cents: t.status === "reserved" ? t.price_cents * t.quantity + (first ? reg : 0) : 0, event: t.slug || t.event_id } });
  }
  return null;
}

// ---------------------------------------------------------------------
// The door (2026-10-14). Every person let in at a physical event becomes a
// door_entries row: how they got in, what they paid at the door and how.
// Run by Ringleaders, or by whoever claimed the event's "Door" job (on
// the night only). New faces get a Courtyard account on the spot and a
// claim QR, since we can't email them yet.
const DOOR_VIAS = ["ticket", "pass", "door", "comp", "crew", "performer"];
const DOOR_METHODS = ["cash", "card"];
const DOOR_EMAIL_DOMAIN = "door.carnivalsociety.org";
async function canRunDoor(env, user, eventId) {
  if (!user) return false;
  if (isModerator(user)) return true;
  const row = await env.DB.prepare(
    `SELECT 1 FROM job_claims c JOIN event_jobs j ON j.id = c.job_id JOIN events e ON e.id = j.event_id
     WHERE j.event_id = ? AND c.user_id = ? AND lower(j.title) LIKE '%door%'
       AND datetime('now') BETWEEN datetime(e.starts_at, '-8 hours') AND datetime(CASE WHEN e.ends_at > e.starts_at THEN e.ends_at ELSE datetime(e.starts_at, '+12 hours') END, '+4 hours')`
  ).bind(eventId, user.id).first();
  return !!row;
}
async function doorTotals(env, eventId) {
  const t = await env.DB.prepare(
    `SELECT COUNT(*) AS inside, COALESCE(SUM(first_time), 0) AS first_time,
       COALESCE(SUM(CASE WHEN method = 'cash' THEN amount_cents END), 0) AS cash,
       COALESCE(SUM(CASE WHEN method = 'card' THEN amount_cents END), 0) AS card,
       COALESCE(SUM(registration_cents), 0) AS registration,
       COALESCE(SUM(registration_cents > 0), 0) AS registrations
     FROM door_entries WHERE event_id = ? AND voided_at IS NULL`
  ).bind(eventId).first();
  const { results } = await env.DB.prepare("SELECT via, COUNT(*) AS n FROM door_entries WHERE event_id = ? AND voided_at IS NULL GROUP BY via").bind(eventId).all();
  const given = await env.DB.prepare("SELECT COALESCE(SUM(tickets_given), 0) AS n FROM door_entries WHERE event_id = ? AND voided_at IS NULL").bind(eventId).first();
  const sold = await env.DB.prepare(
    `SELECT COALESCE(SUM(qty), 0) AS qty, COALESCE(SUM(amount_cents), 0) AS cents,
       COALESCE(SUM(CASE WHEN method = 'cash' THEN amount_cents END), 0) AS cash, COALESCE(SUM(CASE WHEN method = 'card' THEN amount_cents END), 0) AS card
     FROM door_sales WHERE event_id = ? AND voided_at IS NULL`
  ).bind(eventId).first();
  // cash/card = everything that came in at the door tonight, entry and tickets.
  return { ...t, entry_cash: t.cash, entry_card: t.card, cash: t.cash + sold.cash, card: t.card + sold.card,
    tickets_given: given.n, tickets_sold: sold.qty, ticket_sales: sold.cents, by_via: Object.fromEntries(results.map((r) => [r.via, r.n])) };
}
// First time at any carnival = never been let in before, by entry or stamp.
async function firstTimer(env, userId) {
  const seen = await env.DB.prepare(
    "SELECT 1 FROM door_entries WHERE user_id = ? AND voided_at IS NULL UNION SELECT 1 FROM stamps WHERE user_id = ? AND kind = 'ticket' LIMIT 1"
  ).bind(userId, userId).first();
  return seen ? 0 : 1;
}
async function admitted(env, eventId, userId) {
  return env.DB.prepare("SELECT id, created_at FROM door_entries WHERE event_id = ? AND user_id = ? AND voided_at IS NULL").bind(eventId, userId).first();
}
// Let in at a co-hosted carnival = the partner's friend: a handshake both
// sides already agreed to, so it lands in each other's Troupe Album.
async function befriendPartner(env, partnerId, userId, eventId) {
  if (!partnerId || !userId || partnerId === userId) return;
  const [a, b] = partnerId < userId ? [partnerId, userId] : [userId, partnerId];
  await env.DB.prepare(
    `INSERT INTO handshakes (user_a, user_b, event_id, asked_by, met_at) VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_a, user_b) DO UPDATE SET met_at = COALESCE(handshakes.met_at, datetime('now'))`
  ).bind(a, b, eventId, partnerId).run();
}
// Most people one ticket lets in (the buyer plus guests).
const TICKET_MAX = 10;
// A group ticket's guests come through with the buyer: one door entry each,
// no account, nothing stamped.
async function addGuests(env, { eventId, ticketId, buyer, n, by, tickets }) {
  const first = String(buyer || "").split(" ")[0];
  for (let i = 1; i < n; i++) {
    await addEntry(env, { eventId, name: `${first}'s guest${n > 2 ? " " + i : ""}`, via: "ticket", ticketId, by, tickets });
  }
  return Math.max(0, n - 1);
}
async function addEntry(env, e) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO door_entries (id, event_id, user_id, name, via, ticket_id, gift_id, amount_cents, registration_cents, method, first_time, note, by_user, tickets_given)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, e.eventId, e.userId || null, e.name, e.via, e.ticketId || null, e.giftId || null, e.amount || 0, e.registration || 0, e.method || null, e.firstTime ? 1 : 0, e.note || null, e.by, e.tickets || 0).run();
  // Being let in is the Ticket Punched stamp; paying the $5 is The Fix.
  let promoted = false;
  if (e.userId && e.partnerId) await befriendPartner(env, e.partnerId, e.userId, e.eventId);
  if (e.userId) {
    promoted = (await grantStamp(env, { userId: e.userId, kind: "ticket", eventId: e.eventId, grantedBy: e.by })).promoted;
    if (e.registration) promoted = (await grantStamp(env, { userId: e.userId, kind: "fix", grantedBy: e.by })).promoted || promoted;
  }
  return { id, promoted };
}
// A scanned code: a ticket, or a guest pass from a Surprise.
async function doorScan(env, user, ev, code) {
  const eventId = ev.id, give = ev.entry_tickets || 0;
  const t = await env.DB.prepare(
    `SELECT tickets.*, users.display_name, ticket_tiers.name AS tier_name FROM tickets
     JOIN users ON users.id = tickets.user_id JOIN ticket_tiers ON ticket_tiers.id = tickets.tier_id
     WHERE tickets.code = ? AND tickets.event_id = ?`
  ).bind(code || "", eventId).first();
  if (t) {
    const was = await admitted(env, eventId, t.user_id);
    if (was || t.checked_in_at) return json({ ok: false, already: true, display_name: t.display_name, checked_in_at: was?.created_at || t.checked_in_at });
    // A saved spot: they pay at the door, through the "Let in" sheet.
    if (t.status === "reserved") {
      const fix = await hasFix(env, t.user_id);
      return json({ ok: false, owes: true, ticket_id: t.id, user_id: t.user_id, display_name: t.display_name, entry_cents: t.price_cents * (t.quantity || 1), quantity: t.quantity || 1, has_fix: fix });
    }
    if (t.status !== "paid") return err(404, "That ticket was never paid for.");
    await env.DB.prepare("UPDATE tickets SET checked_in_at = datetime('now') WHERE id = ?").bind(t.id).run();
    const first = await firstTimer(env, t.user_id);
    const { promoted } = await addEntry(env, { eventId, userId: t.user_id, name: t.display_name, via: "ticket", ticketId: t.id, firstTime: first, by: user.id, tickets: give, partnerId: ev.partner_id });
    const guests = await addGuests(env, { eventId, ticketId: t.id, buyer: t.display_name, n: t.quantity || 1, by: user.id, tickets: give });
    return json({ ok: true, display_name: t.display_name, tier_name: t.tier_name === "Entry" ? "Paid ahead" : t.tier_name, first_time: !!first, promoted, tickets_given: give * (guests + 1), guests });
  }
  const g = await env.DB.prepare(
    `SELECT g.id, g.event_id, g.redeemed_at, u.display_name, e.title AS event_title FROM room_gifts g
     JOIN users u ON u.id = g.room_user_id LEFT JOIN events e ON e.id = g.event_id WHERE g.code = ? AND g.kind = 'pass'`
  ).bind(code || "").first();
  if (!g) {
    const other = await env.DB.prepare("SELECT e.title FROM tickets t JOIN events e ON e.id = t.event_id WHERE t.code = ?").bind(code || "").first();
    return err(404, other ? `That ticket is for ${other.title}.` : "No valid ticket for that code.");
  }
  if (g.event_id && g.event_id !== eventId) return err(400, `That guest pass is for ${g.event_title}.`);
  if (g.redeemed_at) return json({ ok: false, already: true, display_name: `${g.display_name}'s guest`, checked_in_at: g.redeemed_at });
  await env.DB.prepare("UPDATE room_gifts SET redeemed_at = datetime('now'), redeemed_event_id = ?, opened_at = COALESCE(opened_at, datetime('now')) WHERE id = ?").bind(eventId, g.id).run();
  await addEntry(env, { eventId, name: `${g.display_name}'s guest`, via: "pass", giftId: g.id, firstTime: 1, by: user.id, tickets: give });
  return json({ ok: true, display_name: `${g.display_name}'s guest`, tier_name: "Guest pass (Admit One)", guest: true, first_time: true, tickets_given: give });
}
// The partner's desk: their friends, their carnivals, their join page.
async function partnerRoutes(request, env, url, user, ctx) {
  const { pathname } = url;
  const method = request.method;
  if (pathname === "/api/partner") {
    if (!user) return err(401, "Sign in required.");
    const pid = user?.is_ringleader && url.searchParams.get("id") ? url.searchParams.get("id") : user?.id;
    const pt = await env.DB.prepare("SELECT id, display_name, is_partner, partner_slug, partner_blurb, partner_link FROM users WHERE id = ?").bind(pid || "").first();
    if (!pt || !pt.is_partner || (pt.id !== user.id && !user.is_ringleader)) return err(403, "Partners only.");
    if (method === "PATCH") {
      const b = await body(request);
      const slug = (b.slug || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || null;
      if (slug && await env.DB.prepare("SELECT 1 FROM users WHERE partner_slug = ? AND id != ?").bind(slug, pt.id).first()) return err(400, `Someone already has /p/${slug}.`);
      const link = (b.link || "").trim().slice(0, 200);
      if (link && !/^https?:\/\//.test(link)) return err(400, "Links start with https://");
      await env.DB.prepare("UPDATE users SET partner_slug = ?, partner_blurb = ?, partner_link = ? WHERE id = ?").bind(slug, (b.blurb || "").trim().slice(0, 400) || null, link || null, pt.id).run();
      return json({ ok: true });
    }
    if (method !== "GET") return null;
    const { results: friends } = await env.DB.prepare(
      `SELECT u.id, u.display_name, u.city, h.met_at, e.title AS event_title FROM handshakes h
       JOIN users u ON u.id = CASE WHEN h.user_a = ? THEN h.user_b ELSE h.user_a END LEFT JOIN events e ON e.id = h.event_id
       WHERE (h.user_a = ? OR h.user_b = ?) AND h.met_at IS NOT NULL ORDER BY h.met_at DESC LIMIT 60`
    ).bind(pt.id, pt.id, pt.id).all();
    const { results: events } = await env.DB.prepare(
      `SELECT e.id, e.title, e.starts_at, e.ends_at, e.photos_url, e.slug,
         (SELECT COUNT(*) FROM door_entries d WHERE d.event_id = e.id AND d.voided_at IS NULL) AS came,
         (SELECT COALESCE(SUM(d.first_time), 0) FROM door_entries d WHERE d.event_id = e.id AND d.voided_at IS NULL) AS first_time
       FROM events e WHERE e.partner_id = ? OR e.created_by = ? ORDER BY e.starts_at DESC LIMIT 20`
    ).bind(pt.id, pt.id).all();
    return json({ partner: { id: pt.id, name: pt.display_name, slug: pt.partner_slug, blurb: pt.partner_blurb, link: pt.partner_link },
      join_url: pt.partner_slug ? siteUrl(env) + "/p/" + pt.partner_slug : null, friends: await friendCount(env, pt.id), recent: friends, events });
  }
  // The poster (2026-10-15): hosts upload it; it hangs on every wall.
  const fl = pathname.match(/^\/api\/events\/([^/]+)\/flyer$/);
  if (fl && (method === "POST" || method === "DELETE")) {
    if (!user) return err(401, "Sign in required.");
    if (!await canHost(env, user, fl[1])) return err(403, "Only the hosts can hang the poster.");
    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM event_flyers WHERE event_id = ?").bind(fl[1]).run();
      await env.DB.prepare("UPDATE events SET flyer_url = NULL WHERE id = ?").bind(fl[1]).run();
      return json({ flyer_url: null });
    }
    const data = String((await body(request)).data || "");
    if (!/^data:image\/(jpeg|webp|png);base64,[A-Za-z0-9+/=]+$/.test(data)) return err(400, "That doesn't look like a picture.");
    if (data.length > 900000) return err(400, "That poster is too big. Try a smaller one.");
    await env.DB.prepare("INSERT INTO event_flyers (event_id, data, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(event_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at").bind(fl[1], data).run();
    const url = `/api/public/flyers/${fl[1]}?v=${Date.now().toString(36)}`;
    await env.DB.prepare("UPDATE events SET flyer_url = ? WHERE id = ?").bind(url, fl[1]).run();
    return json({ flyer_url: url });
  }
  // The night's photos: set the link, and everyone who came hears about it.
  const ph = pathname.match(/^\/api\/events\/([^/]+)\/photos$/);
  if (ph && method === "POST") {
    if (!await canHost(env, user, ph[1])) return err(403, "Only the hosts can add the photos.");
    const link = ((await body(request)).url || "").trim().slice(0, 300);
    if (link && !/^https?:\/\//.test(link)) return err(400, "Paste the full link, starting with https://");
    const ev = await env.DB.prepare("SELECT id, title, photos_url FROM events WHERE id = ?").bind(ph[1]).first();
    if (!ev) return err(404, "No such carnival.");
    await env.DB.prepare("UPDATE events SET photos_url = ? WHERE id = ?").bind(link || null, ev.id).run();
    let told = 0;
    if (link && link !== ev.photos_url) {
      const r = await sendBlast(env, ctx, user, { title: `📸 The photos from ${ev.title} are up!`, body: "Go find yourself. Tag your friends, and save your favorites.", url: link, audience: { type: "attended", value: ev.id, label: `Everyone who came to ${ev.title}` } });
      told = r.recipients;
    }
    return json({ ok: true, told });
  }
  return null;
}
async function doorRoutes(request, env, url, user) {
  const { pathname } = url;
  const method = request.method;
  const m = pathname.match(/^\/api\/events\/([^/]+)\/(door|checkin)(?:\/([a-z]+))?(?:\/([^/]+))?$/);
  if (!m) return null;
  const [, eventId, base, part, arg] = m;
  if (!await canRunDoor(env, user, eventId)) return err(403, "Only the door crew runs the door.");
  const ev = await env.DB.prepare(`SELECT ${EVENT_COLS} FROM events WHERE id = ?`).bind(eventId).first();
  if (!ev) return err(404, "No such carnival.");

  // The old scanner route, kept working.
  if (base === "checkin" && method === "POST" && !part) return doorScan(env, user, ev, (await body(request)).code);
  if (base !== "door") return null;

  if (!part && method === "GET") {
    const { results: entries } = await env.DB.prepare(
      `SELECT d.id, d.name, d.via, d.amount_cents, d.registration_cents, d.method, d.first_time, d.note, d.created_at, d.voided_at, b.display_name AS by_name
       FROM door_entries d LEFT JOIN users b ON b.id = d.by_user WHERE d.event_id = ? ORDER BY d.created_at DESC LIMIT 40`
    ).bind(eventId).all();
    const { results: sales } = await env.DB.prepare(
      `SELECT s.id, s.qty, s.amount_cents, s.method, s.created_at, s.voided_at, b.display_name AS by_name FROM door_sales s LEFT JOIN users b ON b.id = s.by_user
       WHERE s.event_id = ? ORDER BY s.created_at DESC LIMIT 10`
    ).bind(eventId).all();
    const partners = isModerator(user) ? (await env.DB.prepare("SELECT id, display_name FROM users WHERE is_partner = 1 ORDER BY display_name").all()).results : [];
    return json({ event: ev, partners, totals: await doorTotals(env, eventId), entries, sales, ringleader: isModerator(user), registration_cents: Number(env.MEMBERSHIP_PRICE_CENTS || 500), link: ev.slug ? siteUrl(env) + "/t/" + ev.slug : null });
  }
  if (!part && method === "PATCH") {
    if (!isModerator(user)) return err(403, "Ringleaders set the door.");
    const b = await body(request);
    const cap = b.capacity === null || b.capacity === "" ? null : Math.max(0, Math.round(Number(b.capacity)) || 0);
    const price = b.door_cents === null || b.door_cents === "" ? null : Math.max(0, Math.round(Number(b.door_cents)) || 0);
    const give = Math.max(0, Math.min(100, Math.round(Number(b.entry_tickets)) || 0));
    const each = b.ticket_cents === null || b.ticket_cents === "" ? null : Math.max(0, Math.round(Number(b.ticket_cents)) || 0);
    const slug = (b.slug || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || null;
    if (slug && await env.DB.prepare("SELECT 1 FROM events WHERE slug = ? AND id != ?").bind(slug, eventId).first()) return err(400, `Another carnival already uses /t/${slug}.`);
    let partner = ev.partner_id;
    if (b.partner_id !== undefined) {
      partner = b.partner_id || null;
      if (partner && !await env.DB.prepare("SELECT 1 FROM users WHERE id = ? AND is_partner = 1").bind(partner).first()) return err(400, "That isn't a partner yet. Mark them as one in the Directory.");
    }
    const tagline = b.tagline === undefined ? ev.tagline : (String(b.tagline || "").trim().slice(0, 60) || null);
    const lineup = b.lineup === undefined ? ev.lineup : (String(b.lineup || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 12).join(", ").slice(0, 300) || null);
    await env.DB.prepare("UPDATE events SET capacity = ?, door_cents = ?, entry_tickets = ?, ticket_cents = ?, slug = ?, partner_id = ?, tagline = ?, lineup = ? WHERE id = ?").bind(cap, price, give, each, slug, partner, tagline, lineup, eventId).run();
    if (partner && partner !== ev.partner_id) {
      const { results: inside } = await env.DB.prepare("SELECT DISTINCT user_id FROM door_entries WHERE event_id = ? AND user_id IS NOT NULL AND voided_at IS NULL").bind(eventId).all();
      for (const r of inside) await befriendPartner(env, partner, r.user_id, eventId);
    }
    if (price != null) await entryTier(env, { ...ev, door_cents: price });
    return json({ ok: true, link: slug ? siteUrl(env) + "/t/" + slug : null });
  }
  if (part === "scan" && method === "POST") return doorScan(env, user, ev, (await body(request)).code);

  // Find a member by name: just enough to let them in.
  if (part === "search" && method === "GET") {
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    if (q.length < 2) return json({ members: [] });
    const { results } = await env.DB.prepare(
      `SELECT u.id, u.display_name, u.city,
         EXISTS (SELECT 1 FROM stamps s WHERE s.user_id = u.id AND s.kind = 'fix') AS has_fix,
         (SELECT t.code FROM tickets t WHERE t.user_id = u.id AND t.event_id = ? AND t.status = 'paid' LIMIT 1) AS ticket_code,
         EXISTS (SELECT 1 FROM job_claims c JOIN event_jobs j ON j.id = c.job_id WHERE c.user_id = u.id AND j.event_id = ?) AS crew,
         (SELECT d.created_at FROM door_entries d WHERE d.user_id = u.id AND d.event_id = ? AND d.voided_at IS NULL) AS admitted_at
       FROM users u WHERE lower(u.display_name) LIKE ? ORDER BY u.display_name LIMIT 8`
    ).bind(eventId, eventId, eventId, `%${q}%`).all();
    return json({ members: results.map((r) => ({ ...r, has_fix: !!r.has_fix, crew: !!r.crew })) });
  }

  // Let someone in: a member by id, or a new face (makes their account).
  if (part === "admit" && method === "POST") {
    const b = await body(request);
    const via = DOOR_VIAS.includes(b.via) && !["ticket", "pass"].includes(b.via) ? b.via : "door";
    const amount = Math.max(0, Math.round(Number(b.amount_cents) || 0));
    const pay = via === "door" && (amount > 0 || b.registration) ? (DOOR_METHODS.includes(b.method) ? b.method : null) : null;
    if (via === "door" && amount > 0 && !pay) return err(400, "Cash or card?");
    let target, claim = null, isNew = false;
    if (b.user_id) {
      target = await env.DB.prepare("SELECT id, display_name FROM users WHERE id = ?").bind(b.user_id).first();
      if (!target) return err(404, "No such member.");
    } else {
      const name = (b.name || "").trim().slice(0, 60);
      if (!name) return err(400, "What's their name?");
      const email = normalizeEmail(b.email || "");
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err(400, "That email doesn't look right.");
      const phone = (b.phone || "").trim().slice(0, 30) || null;
      if (email) target = await env.DB.prepare("SELECT id, display_name FROM users WHERE lower(email) = ?").bind(email).first();
      if (!target) {
        // A Courtyard account with no usable password; the claim QR sets one.
        const id = crypto.randomUUID();
        const { hash, salt } = await hashPassword(bytesToHex(crypto.getRandomValues(new Uint8Array(24))));
        const city = (b.city || "").trim().slice(0, 60) || null;
        const chapterId = city ? (await env.DB.prepare("SELECT id FROM chapters WHERE instr(lower(?), lower(name)) > 0 LIMIT 1").bind(city).first())?.id || null : null;
        await env.DB.prepare(
          "INSERT INTO users (id, email, password_hash, salt, display_name, home_chapter_id, city, phone, rank, heard_about_us, waitlisted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'clown', ?, datetime('now'))"
        ).bind(id, email || `${id}@${DOOR_EMAIL_DOMAIN}`, hash, salt, name, chapterId, city, phone, (b.heard || "").trim().slice(0, 120) || null).run();
        if (email) await letBackerIn(env, id, email);
        target = { id, display_name: name };
        isNew = true;
      }
    }
    const was = await admitted(env, eventId, target.id);
    if (was) return json({ ok: false, already: true, display_name: target.display_name, checked_in_at: was.created_at });
    const hasFix = !!await env.DB.prepare("SELECT 1 FROM stamps WHERE user_id = ? AND kind = 'fix'").bind(target.id).first();
    const regCents = Number(env.MEMBERSHIP_PRICE_CENTS || 500);
    // The one-time registration goes on top of entry, the first time.
    const registration = b.registration && !hasFix && via === "door" ? regCents : 0;
    if (registration && !pay) return err(400, "Cash or card?");
    // Paying off a saved spot: the reserved ticket becomes a paid one.
    let ticketId = null, party = 1;
    if (b.ticket_id) {
      const t = await env.DB.prepare("SELECT id, quantity FROM tickets WHERE id = ? AND event_id = ? AND user_id = ? AND status = 'reserved'").bind(b.ticket_id, eventId, target.id).first();
      if (!t) return err(400, "That saved spot is already settled.");
      ticketId = t.id;
      party = t.quantity || 1;
      await env.DB.prepare("UPDATE tickets SET status = 'paid', price_cents = ?, checked_in_at = datetime('now') WHERE id = ?").bind(via === "door" ? amount : 0, t.id).run();
    }
    const first = await firstTimer(env, target.id);
    const give = via === "crew" ? 0 : ev.entry_tickets || 0;
    if (via === "performer") await grantStamp(env, { userId: target.id, kind: "kinker", eventId, grantedBy: user.id });
    const { id: entryId, promoted } = await addEntry(env, {
      eventId, userId: target.id, partnerId: ev.partner_id, name: target.display_name, via, ticketId, amount: via === "door" ? amount + registration : 0, registration, method: pay,
      firstTime: first, note: (b.note || "").trim().slice(0, 140) || null, by: user.id, tickets: give,
    });
    const guests = ticketId ? await addGuests(env, { eventId, ticketId, buyer: target.display_name, n: party, by: user.id, tickets: give }) : 0;
    // New faces (and anyone who never set a password) get a 30-day claim link.
    if (isNew) {
      const token = bytesToHex(crypto.getRandomValues(new Uint8Array(24)));
      await env.DB.prepare("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))").bind(await sha256Hex(token), target.id).run();
      claim = siteUrl(env) + "/#/claim/" + token;
    }
    return json({ ok: true, id: entryId, display_name: target.display_name, first_time: !!first, new_account: isNew, claim, promoted, tickets_given: give * (guests + 1), guests });
  }

  // A 50¢ test charge (Stripe's minimum) through the real checkout + webhook,
  // so the Ringleader can prove payments work without buying a $20 entry.
  if (part === "testpay" && method === "POST") {
    if (!isModerator(user)) return err(403, "Ringleaders only.");
    if (!env.STRIPE_SECRET_KEY) return err(503, "Stripe isn't connected yet.");
    const tierId = await entryTier(env, ev);
    await env.DB.prepare("DELETE FROM tickets WHERE event_id = ? AND user_id = ? AND status = 'pending'").bind(eventId, user.id).run();
    const id = crypto.randomUUID(), code = ticketCode();
    await env.DB.prepare("INSERT INTO tickets (id, event_id, tier_id, user_id, status, price_cents, code) VALUES (?, ?, ?, ?, 'pending', 50, ?)").bind(id, eventId, tierId, user.id, code).run();
    try {
      const session = await stripeCheckout(env, checkoutParams(env, { user, name: `TEST: ${ev.title} (50¢ payment check)`, amountCents: 50, metadata: { kind: "ticket", user_id: user.id, ticket_id: id, registration: "0", test: "1" }, successPath: `/#/ticket/${code}` }));
      await env.DB.prepare("UPDATE tickets SET stripe_session_id = ? WHERE id = ?").bind(session.id, id).run();
      return json({ url: session.url, code });
    } catch (e) {
      await env.DB.prepare("DELETE FROM tickets WHERE id = ?").bind(id).run();
      return err(502, "Stripe said no: " + e.message);
    }
  }
  // Extra carnival tickets, at the door or the ticket booth.
  if (part === "sell" && method === "POST") {
    const b = await body(request);
    const qty = Math.round(Number(b.qty));
    if (!(qty > 0 && qty <= 500)) return err(400, "How many tickets?");
    if (!DOOR_METHODS.includes(b.method)) return err(400, "Cash or card?");
    const each = ev.ticket_cents ?? 100;
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO door_sales (id, event_id, qty, amount_cents, method, by_user) VALUES (?, ?, ?, ?, ?, ?)").bind(id, eventId, qty, qty * each, b.method, user.id).run();
    return json({ ok: true, id, qty, amount_cents: qty * each });
  }
  if (part === "sales" && arg && method === "DELETE") {
    const res = await env.DB.prepare("UPDATE door_sales SET voided_at = datetime('now') WHERE id = ? AND event_id = ? AND voided_at IS NULL").bind(arg, eventId).run();
    return res.meta.changes ? json({ ok: true }) : err(404, "Already undone.");
  }
  // Undo a mistake: the row stays, out of every count.
  if (part === "entries" && arg && method === "DELETE") {
    const e = await env.DB.prepare("SELECT id, via, gift_id, ticket_id, user_id FROM door_entries WHERE id = ? AND event_id = ? AND voided_at IS NULL").bind(arg, eventId).first();
    if (!e) return err(404, "Already undone.");
    await env.DB.prepare("UPDATE door_entries SET voided_at = datetime('now') WHERE id = ?").bind(e.id).run();
    // A group ticket's guests came in on it too: undo them together.
    if (e.ticket_id) await env.DB.prepare("UPDATE door_entries SET voided_at = datetime('now') WHERE event_id = ? AND ticket_id = ? AND voided_at IS NULL").bind(eventId, e.ticket_id).run();
    if (e.ticket_id) await env.DB.prepare("UPDATE tickets SET checked_in_at = NULL, status = CASE WHEN ? = 'door' THEN 'reserved' ELSE status END WHERE id = ?").bind(e.via, e.ticket_id).run();
    if (e.gift_id) await env.DB.prepare("UPDATE room_gifts SET redeemed_at = NULL, redeemed_event_id = NULL WHERE id = ?").bind(e.gift_id).run();
    if (e.user_id) await env.DB.prepare("DELETE FROM stamps WHERE user_id = ? AND kind = 'ticket' AND event_id = ?").bind(e.user_id, eventId).run();
    return json({ ok: true });
  }

  // The night's report: everything, for the Ringleader.
  if (part === "report" && method === "GET") {
    if (!isModerator(user)) return err(403, "Ringleaders only.");
    const { results: entries } = await env.DB.prepare(
      `SELECT d.*, b.display_name AS by_name, u.city, u.email AS user_email FROM door_entries d
       LEFT JOIN users b ON b.id = d.by_user LEFT JOIN users u ON u.id = d.user_id WHERE d.event_id = ? ORDER BY d.created_at`
    ).bind(eventId).all();
    const sold = await env.DB.prepare("SELECT COALESCE(SUM(quantity), 0) AS n, COALESCE(SUM(price_cents * quantity), 0) AS cents FROM tickets WHERE event_id = ? AND status = 'paid' AND stripe_session_id IS NOT NULL").bind(eventId).first();
    const saved = await env.DB.prepare(
      `SELECT COALESCE(SUM(t.quantity), 0) AS n, COALESCE(SUM(t.quantity * EXISTS (SELECT 1 FROM door_entries d WHERE d.ticket_id = t.id AND d.voided_at IS NULL)), 0) AS came
       FROM tickets t JOIN ticket_tiers tt ON tt.id = t.tier_id WHERE t.event_id = ? AND tt.name = 'Entry' AND tt.active = 0 AND t.stripe_session_id IS NULL AND t.status IN ('reserved', 'paid')`
    ).bind(eventId).first();
    const { results: hours } = await env.DB.prepare(
      "SELECT strftime('%Y-%m-%dT%H:00:00Z', created_at) AS hour, COUNT(*) AS n FROM door_entries WHERE event_id = ? AND voided_at IS NULL GROUP BY hour ORDER BY hour"
    ).bind(eventId).all();
    // Every ticket so far, paid online or saved for the door (newest first).
    const { results: tickets } = await env.DB.prepare(
      `SELECT u.display_name AS name, u.email, t.status, t.price_cents, t.quantity, t.created_at, t.checked_in_at, p.amount_cents AS paid_cents
       FROM tickets t JOIN users u ON u.id = t.user_id LEFT JOIN payments p ON p.stripe_session_id = t.stripe_session_id
       WHERE t.event_id = ? AND t.status IN ('paid', 'reserved') ORDER BY t.created_at DESC`
    ).bind(eventId).all();
    return json({ event: ev, totals: await doorTotals(env, eventId), advance: sold, saved, hours, tickets,
      entries: entries.map((e) => ({ ...e, user_email: e.user_email && e.user_email.endsWith("@" + DOOR_EMAIL_DOMAIN) ? null : e.user_email })) });
  }
  return null;
}

async function roomRoutes(request, env, url, user) {
  const { pathname } = url;
  const method = request.method;
  // Backstage (2026-10-14): everyone you can visit, with who's a friend
  // (shook hands), who's new, and who's around right now (in the app lately).
  if (pathname === "/api/backstage" && method === "GET") {
    if (!user) return err(401, "Sign in required.");
    const { results } = await env.DB.prepare(
      `SELECT u.id, u.display_name, u.avatar_url, u.city, u.created_at, u.is_ringleader,
         EXISTS (SELECT 1 FROM handshakes h WHERE h.met_at IS NOT NULL AND ((h.user_a = u.id AND h.user_b = ?1) OR (h.user_b = u.id AND h.user_a = ?1))) AS friend,
         EXISTS (SELECT 1 FROM chat_presence p WHERE p.user_id = u.id AND p.seen_at > datetime('now', '-3 minutes')) AS here
       FROM users u
       WHERE u.id != ?1 AND u.waitlisted_at IS NULL AND COALESCE(u.is_partner, 0) = 0
       ORDER BY u.created_at DESC LIMIT 400`
    ).bind(user.id).all();
    return json({ people: results.map((r) => ({ id: r.id, display_name: r.display_name, photo: r.avatar_url || null, city: r.city || null, created_at: r.created_at,
      ringleader: !!r.is_ringleader, friend: !!r.friend, here: !!r.here })) });
  }
  if (pathname === "/api/me/room" && method === "GET") {
    if (!user) return err(401, "Sign in required.");
    const backer = await backerOf(env, user);
    return json({ ...(await roomFor(env, user.id)), gifts: await roomGifts(env, user.id), unlocked: await roomUnlocks(env, user.id), specials: ROOM_SPECIALS,
      backer: backer ? { welcomed: !!backer.welcomed_at, deck: !!backer.deck_at } : null });
  }
  // Card of the day (2026-10-14): one Mercury Oracle card per member per
  // day, everyone. Picked from the day + who you are, so it can't be
  // re-rolled. The full deck (draw freely) is for backers and the Ringleader.
  if (pathname === "/api/me/card" && method === "GET") {
    if (!user) return err(401, "Sign in required.");
    const today = new Date().toISOString().slice(0, 10);
    let day = url.searchParams.get("day") || today;
    // Your own calendar day, give or take a day of time zones.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Math.abs(Date.parse(day) - Date.parse(today)) > 864e5) day = today;
    const cards = await mercuryCards();
    if (!cards.length) return err(503, "The deck is shuffling. Try again in a moment.");
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${user.id}|${day}`)));
    const c = cards[((h[0] << 24 | h[1] << 16 | h[2] << 8 | h[3]) >>> 0) % cards.length];
    return json({ day, full_deck: await hasFullDeck(env, user), back: "/oracle/mercury/images/card-back.jpg",
      card: { title: c.title, phrase: c.phrase || null, meaning: c.meaning || null, image: c.imageUrl ? `/oracle/mercury/${c.imageUrl}` : null } });
  }
  if (pathname === "/api/me/room" && method === "PUT") {
    if (!user) return err(401, "Sign in required.");
    const { theme, items } = await body(request);
    if (!ROOM_THEMES.includes(theme)) return err(400, "Unknown room.");
    if (RINGLEADER_THEMES.includes(theme) && !user.is_ringleader) return err(403, "That room belongs to the Ringleader.");
    let clean;
    try { clean = cleanRoomItems(items ?? null, { ringleader: !!user.is_ringleader, unlocked: await roomUnlocks(env, user.id) }); } catch (e) { return err(400, e.message); }
    await env.DB.prepare(
      "INSERT INTO user_rooms (user_id, theme, items, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(user_id) DO UPDATE SET theme = excluded.theme, items = excluded.items, updated_at = excluded.updated_at"
    ).bind(user.id, theme, clean ? JSON.stringify(clean) : null).run();
    return json({ ok: true });
  }
  const roomMatch = pathname.match(/^\/api\/rooms\/([^/]+)$/);
  if (roomMatch && method === "GET") {
    if (!user) return err(401, "Sign in required.");
    const room = await roomFor(env, roomMatch[1]);
    if (!room) return err(404, "No such room.");
    return json(isModerator(user) ? { ...room, gifts: await roomGifts(env, roomMatch[1], { wrappedOnly: true }) } : room);
  }
  // Surprises: a Ringleader wraps something up in someone's room.
  const giftMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/gifts$/);
  if (giftMatch && method === "POST") {
    if (!isModerator(user)) return err(403, "Only the Ringleader leaves surprises.");
    const owner = giftMatch[1];
    if (owner === user.id) return err(400, "That's your own room!");
    const who = await env.DB.prepare("SELECT display_name FROM users WHERE id = ?").bind(owner).first();
    if (!who) return err(404, "No such room.");
    const b = await body(request);
    const pass = !!b.pass;
    const img = pass ? "items/ticket_admit" : String(b.img || "");
    if (!/^items\/[a-z_]{2,30}$/.test(img)) return err(400, "Pick something to give.");
    const note = (b.note || "").trim().slice(0, 200) || null;
    let eventId = null;
    if (pass && b.event_id) {
      const ev = await env.DB.prepare("SELECT id FROM events WHERE id = ?").bind(b.event_id).first();
      if (!ev) return err(400, "No such carnival.");
      eventId = ev.id;
    }
    const id = bytesToHex(crypto.getRandomValues(new Uint8Array(12)));
    await env.DB.prepare("INSERT INTO room_gifts (id, room_user_id, from_id, kind, img, note, code, event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, owner, user.id, pass ? "pass" : "item", img, note, pass ? ticketCode() : null, eventId).run();
    await notifyUser(env, owner, { kind: "letter", title: `🎁 ${user.display_name} left a surprise in your Dressing Room`, body: "It's wrapped and waiting. Go see!", url: "#/dressing-room" }, "notify_letters");
    return json({ ok: true, id });
  }
  const giftOne = pathname.match(/^\/api\/gifts\/([a-f0-9]+)(\/open)?$/);
  if (giftOne && method === "POST" && giftOne[2]) {
    if (!user) return err(401, "Sign in required.");
    const g = await env.DB.prepare("SELECT id FROM room_gifts WHERE id = ? AND room_user_id = ?").bind(giftOne[1], user.id).first();
    if (!g) return err(404, "That surprise isn't yours to open.");
    await env.DB.prepare("UPDATE room_gifts SET opened_at = COALESCE(opened_at, datetime('now')) WHERE id = ?").bind(g.id).run();
    const gifts = await roomGifts(env, user.id);
    return json({ gift: gifts.find((x) => x.id === g.id), unlocked: await roomUnlocks(env, user.id) });
  }
  if (giftOne && method === "DELETE" && !giftOne[2]) {
    if (!isModerator(user)) return err(403, "Only the Ringleader takes surprises back.");
    const res = await env.DB.prepare("DELETE FROM room_gifts WHERE id = ? AND opened_at IS NULL").bind(giftOne[1]).run();
    return res.meta.changes ? json({ ok: true }) : err(400, "Already unwrapped. It's theirs now!");
  }
  const noteMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/notes$/);
  if (noteMatch && method === "POST") {
    if (!user) return err(401, "Sign in required.");
    const owner = noteMatch[1];
    if (owner === user.id) return err(400, "That's your own mirror!");
    const text = ((await body(request)).body || "").trim().slice(0, 140);
    if (!text) return err(400, "Write something first.");
    const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM room_notes WHERE author_id = ? AND created_at > datetime('now', '-1 hour')").bind(user.id).first();
    if (recent.n >= 10) return err(429, "That's a lot of notes. Give the mirror a rest for a bit.");
    await env.DB.prepare("INSERT INTO room_notes (room_user_id, author_id, body) VALUES (?, ?, ?)").bind(owner, user.id, text).run();
    await notifyUser(env, owner, { kind: "letter", title: `📝 ${user.display_name} left a note on your mirror`, body: text, url: "#/dressing-room" }, "notify_letters");
    return json({ ok: true });
  }
  const delNote = pathname.match(/^\/api\/rooms\/([^/]+)\/notes\/(\d+)$/);
  if (delNote && method === "DELETE") {
    if (!user) return err(401, "Sign in required.");
    await env.DB.prepare("DELETE FROM room_notes WHERE id = ? AND room_user_id = ? AND (room_user_id = ? OR author_id = ?)").bind(delNote[2], delNote[1], user.id, user.id).run();
    return json({ ok: true });
  }
  return null;
}

// ---------------------------------------------------------------------
// Needs on flyers: each upcoming event's materials (needed / wanted, ★ for
// priority) shown to everyone; members pledge "I can bring it!", and when
// the Ringleader marks it received they win the Junk Saint stamp.
async function needRoutes(request, env, url, user) {
  const { pathname } = url;
  const method = request.method;
  if (pathname === "/api/materials" && method === "GET") {
    if (!user) return err(401, "Sign in required.");
    const { results: mats } = await env.DB.prepare(
      `SELECT m.id, m.event_id, m.item, m.category, m.priority FROM event_materials m JOIN events e ON e.id = m.event_id
       WHERE ${UPCOMING} AND lower(trim(m.item)) NOT IN ('none', '') ORDER BY m.category, m.priority DESC, m.position, m.created_at`
    ).all();
    if (!mats.length) return json({ materials: [] });
    const { results: pl } = await env.DB.prepare(
      `SELECT p.material_id, p.user_id, p.received_at, u.display_name FROM material_pledges p JOIN users u ON u.id = p.user_id
       WHERE p.material_id IN (${mats.map(() => "?").join(",")}) ORDER BY p.created_at`
    ).bind(...mats.map((m) => m.id)).all();
    return json({ materials: mats.map((m) => ({ ...m, pledges: pl.filter((p) => p.material_id === m.id).map((p) => ({ user_id: p.user_id, display_name: p.display_name, received: !!p.received_at })) })) });
  }
  const addMatch = pathname.match(/^\/api\/events\/([^/]+)\/needs$/);
  if (addMatch && method === "POST") {
    if (!await canHost(env, user, addMatch[1])) return err(403, "Moderators only.");
    const { item, category, priority } = await body(request);
    const t = (item || "").trim().slice(0, 80);
    if (!t) return err(400, "What's needed?");
    await env.DB.prepare("INSERT INTO event_materials (id, event_id, item, category, priority, position, created_by) VALUES (?, ?, ?, ?, ?, 0, ?)")
      .bind(crypto.randomUUID(), addMatch[1], t, category === "want" ? "want" : "need", priority ? 1 : 0, user.id).run();
    return json({ ok: true });
  }
  const pledgeMatch = pathname.match(/^\/api\/materials\/([^/]+)\/pledge$/);
  if (pledgeMatch && (method === "POST" || method === "DELETE")) {
    if (!user) return err(401, "Sign in required.");
    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM material_pledges WHERE material_id = ? AND user_id = ? AND received_at IS NULL").bind(pledgeMatch[1], user.id).run();
      return json({ ok: true });
    }
    const m = await env.DB.prepare(`SELECT m.id FROM event_materials m JOIN events e ON e.id = m.event_id WHERE m.id = ? AND ${UPCOMING}`).bind(pledgeMatch[1]).first();
    if (!m) return err(404, "That's not needed anymore.");
    await env.DB.prepare("INSERT OR IGNORE INTO material_pledges (material_id, user_id) VALUES (?, ?)").bind(m.id, user.id).run();
    return json({ ok: true });
  }
  const recvMatch = pathname.match(/^\/api\/materials\/([^/]+)\/pledges\/([^/]+)(\/received)?$/);
  if (recvMatch) {
    if (!isModerator(user)) return err(403, "Moderators only.");
    const [, matId, userId, received] = recvMatch;
    if (received && method === "POST") {
      const m = await env.DB.prepare("SELECT m.event_id, m.item FROM event_materials m JOIN material_pledges p ON p.material_id = m.id WHERE m.id = ? AND p.user_id = ?").bind(matId, userId).first();
      if (!m) return err(404, "They didn't pledge that.");
      await env.DB.prepare("UPDATE material_pledges SET received_at = datetime('now') WHERE material_id = ? AND user_id = ?").bind(matId, userId).run();
      const r = await grantStamp(env, { userId, kind: "junk", eventId: m.event_id, note: `Brought: ${m.item}`, grantedBy: user.id });
      return json({ ok: true, ...r });
    }
    if (!received && method === "DELETE") {
      await env.DB.prepare("DELETE FROM material_pledges WHERE material_id = ? AND user_id = ?").bind(matId, userId).run();
      return json({ ok: true });
    }
  }
  // Run of show (lives here with the other flyer lists).
  if (pathname === "/api/run" && method === "GET") {
    if (!user) return err(401, "Sign in required.");
    const { results } = await env.DB.prepare(
      `SELECT r.id, r.event_id, r.at, r.title, r.who, r.place FROM run_of_show r JOIN events e ON e.id = r.event_id WHERE ${UPCOMING} ORDER BY r.at`
    ).all();
    return json({ run: results });
  }
  const runAdd = pathname.match(/^\/api\/events\/([^/]+)\/run$/);
  if (runAdd && method === "POST") {
    if (!await canHost(env, user, runAdd[1])) return err(403, "Moderators only.");
    const { at, title, who, place } = await body(request);
    const t = (title || "").trim().slice(0, 80);
    const when = Date.parse(at || "");
    if (!t || !Number.isFinite(when)) return err(400, "Give it a time and a name.");
    await env.DB.prepare("INSERT INTO run_of_show (id, event_id, at, title, who, place, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), runAdd[1], new Date(when).toISOString(), t, (who || "").trim().slice(0, 60) || null, (place || "").trim().slice(0, 60) || null, user.id).run();
    return json({ ok: true });
  }
  const runDel = pathname.match(/^\/api\/run\/([^/]+)$/);
  if (runDel && method === "DELETE") {
    const runEv = await env.DB.prepare("SELECT event_id FROM run_of_show WHERE id = ?").bind(runDel[1]).first();
    if (!runEv || !await canHost(env, user, runEv.event_id)) return err(403, "Moderators only.");
    await env.DB.prepare("DELETE FROM run_of_show WHERE id = ?").bind(runDel[1]).run();
    return json({ ok: true });
  }
  const delMatch = pathname.match(/^\/api\/needs\/([^/]+)$/);
  if (delMatch && method === "DELETE") {
    const needEv = await env.DB.prepare("SELECT event_id FROM event_materials WHERE id = ?").bind(delMatch[1]).first();
    if (!needEv || !await canHost(env, user, needEv.event_id)) return err(403, "Moderators only.");
    await env.DB.prepare("DELETE FROM event_materials WHERE id = ?").bind(delMatch[1]).run();
    return json({ ok: true });
  }
  return null;
}

// ---------------------------------------------------------------------
// Blasts: the Ringleader rings everyone's telephone. Audience → recipient
// set (SQL), a receipt each (seen_at = picked up), an in-app notification
// + push each, optional Courtyard post. The app shows unseen blasts as the
// ringing-telephone moment.
// ---------------------------------------------------------------------
function blastAudienceSql(a) {
  switch (a?.type) {
    case "all": return ["SELECT id FROM users", []];
    case "inner": return ["SELECT id FROM users WHERE tier = 'inner' OR is_ringleader = 1", []];
    case "courtyard": return ["SELECT id FROM users WHERE tier != 'inner' AND is_ringleader = 0", []];
    case "chapter": return ["SELECT id FROM users WHERE home_chapter_id = ?", [a.value || ""]];
    case "city": return ["SELECT id FROM users WHERE lower(city) LIKE lower(?) || '%'", [String(a.value || "").trim()]];
    case "event": return ["SELECT user_id AS id FROM event_volunteers WHERE event_id = ? UNION SELECT user_id FROM tickets WHERE event_id = ? AND status = 'paid'", [a.value || "", a.value || ""]];
    // Just one person (a Ringleader's letter, hollered).
    case "user": return ["SELECT id FROM users WHERE id = ?", [a.value || ""]];
    // Everyone let in at that carnival's door.
    case "attended": return ["SELECT DISTINCT user_id AS id FROM door_entries WHERE event_id = ? AND user_id IS NOT NULL AND voided_at IS NULL", [a.value || ""]];
    // Everyone someone has shaken hands with (a partner's friends).
    case "friends": return ["SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END AS id FROM handshakes WHERE (user_a = ? OR user_b = ?) AND met_at IS NOT NULL", [a.value || "", a.value || "", a.value || ""]];
    default: return null;
  }
}
// The sender never rings their own phone.
function blastAudience(a, senderId) {
  const q = blastAudienceSql(a);
  return q && [`SELECT id FROM (${q[0]}) WHERE id != ?`, [...q[1], senderId]];
}
// A partner runs the events they co-host (or posted themselves).
async function ownsEvent(env, user, eventId) {
  if (!user?.is_partner) return false;
  return !!await env.DB.prepare("SELECT 1 FROM events WHERE id = ? AND (partner_id = ? OR created_by = ?)").bind(eventId, user.id, user.id).first();
}
// Ringleaders run every event; a partner runs the ones they co-host.
async function canHost(env, user, eventId) {
  return isModerator(user) || await ownsEvent(env, user, eventId);
}
// A partner may holler at their own friends, or at who came to their carnival.
async function mayHoller(env, user, a) {
  if (user?.is_ringleader) return true;
  if (!user?.is_partner) return false;
  if (a?.type === "friends") return a.value === user.id;
  if (a?.type === "attended") return !!await env.DB.prepare("SELECT 1 FROM events WHERE id = ? AND partner_id = ?").bind(a.value || "", user.id).first();
  return false;
}
// Ring everyone in an audience: receipts, in-app notices, phones.
async function sendBlast(env, ctx, sender, { title: t, body: b, url: link, audience, postToCourtyard = false }) {
  const q = blastAudience(audience, sender.id);
  if (!q) throw new Error("Pick who to ring.");
  const res = await env.DB.prepare("INSERT INTO blasts (sender_id, title, body, url, audience) VALUES (?, ?, ?, ?, ?)").bind(sender.id, t, b, link || null, JSON.stringify(audience)).run();
  const blastId = res.meta.last_row_id;
  await env.DB.prepare(`INSERT OR IGNORE INTO blast_receipts (blast_id, user_id) SELECT ?, id FROM (${q[0]})`).bind(blastId, ...q[1]).run();
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM blast_receipts WHERE blast_id = ?").bind(blastId).first();
  await env.DB.prepare("UPDATE blasts SET recipients = ? WHERE id = ?").bind(n, blastId).run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO notifications (user_id, kind, title, body, url, ref) SELECT user_id, 'blast', ?, ?, ?, ? FROM blast_receipts WHERE blast_id = ?"
  ).bind(`📣 ${sender.is_ringleader ? "HEAR YE! " : sender.display_name + ": "}${t}`, b.length > 140 ? b.slice(0, 137) + "…" : b, "#/dressing-room", `blast:${blastId}`, blastId).run();
  if (postToCourtyard) {
    const yard = await env.DB.prepare("SELECT id FROM boards WHERE slug = 'courtyard'").first();
    if (yard) await env.DB.prepare("INSERT INTO posts (id, board_id, author_id, title, body) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), yard.id, sender.id, t, b).run();
  }
  // Wake phones (capped per invocation; everyone still gets it in-app).
  const { results: subs } = await env.DB.prepare("SELECT s.endpoint FROM push_subscriptions s JOIN blast_receipts r ON r.user_id = s.user_id WHERE r.blast_id = ? LIMIT 45").bind(blastId).all();
  ctx.waitUntil(wakeEndpoints(env, subs.map((r) => r.endpoint)));
  return { id: blastId, recipients: n, phones: subs.length };
}
async function blastRoutes(request, env, url, user, ctx) {
  const { pathname } = url;
  const method = request.method;
  if (pathname === "/api/blasts/preview" && method === "POST") {
    const audience = (await body(request)).audience;
    if (!await mayHoller(env, user, audience)) return err(403, "Ringleaders only.");
    const q = blastAudience(audience, user.id);
    if (!q) return err(400, "Pick who to ring.");
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n, (SELECT COUNT(DISTINCT s.user_id) FROM push_subscriptions s WHERE s.user_id IN (${q[0]})) AS phones FROM (${q[0]})`).bind(...q[1], ...q[1]).first();
    return json({ recipients: row.n, phones: row.phones });
  }
  if (pathname === "/api/blasts" && method === "POST") {
    const { title, body: text, audience, url: link, post_to_courtyard } = await body(request);
    if (!await mayHoller(env, user, audience)) return err(403, "Ringleaders only.");
    const t = String(title || "").trim(), b = String(text || "").trim();
    if (!t || !b) return err(400, "A blast needs a title and a message.");
    if (t.length > 120 || b.length > 1500) return err(400, "Keep it under 120 characters for the title and 1500 for the message.");
    if (!blastAudience(audience, user.id)) return err(400, "Pick who to ring.");
    return json(await sendBlast(env, ctx, user, { title: t, body: b, url: link, audience, postToCourtyard: !!post_to_courtyard && !!user.is_ringleader }));
  }
  if (pathname === "/api/blasts" && method === "GET") {
    if (!user?.is_ringleader) return err(403, "Ringleaders only.");
    const { results } = await env.DB.prepare(
      `SELECT b.id, b.title, b.body, b.audience, b.recipients, b.created_at, (SELECT COUNT(*) FROM blast_receipts r WHERE r.blast_id = b.id AND r.seen_at IS NOT NULL) AS seen
       FROM blasts b ORDER BY b.id DESC LIMIT 30`
    ).all();
    return json({ blasts: results.map((r) => ({ ...r, audience: JSON.parse(r.audience) })) });
  }
  // The newest blast you haven't picked up (the app rings for it).
  if (pathname === "/api/me/blast" && method === "GET") {
    if (!user) return err(401, "Sign in required.");
    const backer = await backerOf(env, user);
    if (backer && !backer.welcomed_at) {
      const rl = await env.DB.prepare("SELECT display_name FROM users WHERE is_ringleader = 1 ORDER BY created_at LIMIT 1").first();
      return json({ blast: { id: "welcome", title: "Welcome, backer!", body: BACKER_WELCOME, url: null, sender: rl?.display_name || "Neeff", from_partner: false, gift: "mercury_deck" } });
    }
    const row = await env.DB.prepare(
      `SELECT b.id, b.title, b.body, b.url, b.created_at, u.display_name AS sender, (u.is_ringleader = 0) AS from_partner FROM blast_receipts r
       JOIN blasts b ON b.id = r.blast_id LEFT JOIN users u ON u.id = b.sender_id
       WHERE r.user_id = ? AND r.seen_at IS NULL AND b.created_at > datetime('now', '-14 days')
       ORDER BY b.id DESC LIMIT 1`
    ).bind(user.id).first();
    return json({ blast: row || null });
  }
  // The backer's welcome heard / the deck placed on their dresser: once each.
  const backerStep = pathname.match(/^\/api\/me\/backer\/(welcomed|deck)$/);
  if (backerStep && method === "POST") {
    if (!user) return err(401, "Sign in required.");
    const col = backerStep[1] === "deck" ? "deck_at" : "welcomed_at";
    await env.DB.prepare(`UPDATE backers SET ${col} = COALESCE(${col}, datetime('now')), user_id = ? WHERE email = lower(?)`).bind(user.id, user.email).run();
    return json({ ok: true });
  }
  const seenMatch = pathname.match(/^\/api\/me\/blast\/(\d+)\/seen$/);
  if (seenMatch && method === "POST") {
    if (!user) return err(401, "Sign in required.");
    await env.DB.prepare("UPDATE blast_receipts SET seen_at = datetime('now') WHERE blast_id = ? AND user_id = ? AND seen_at IS NULL").bind(seenMatch[1], user.id).run();
    return json({ ok: true });
  }
  return null;
}

// ---------------------------------------------------------------------
// The raven on your phone: Web Push with VAPID and NO payload. A push just
// wakes the service worker (sw.js), which fetches the actual squawk from
// /api/me/notifications/pending — so no content ever passes through the
// push services, and no payload encryption is needed. Private key: secret
// VAPID_PRIVATE_JWK; public key: var VAPID_PUBLIC_KEY.
// ---------------------------------------------------------------------
function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
let vapidSigningKey = null;
async function vapidAuth(env, endpoint) {
  if (!vapidSigningKey) {
    vapidSigningKey = await crypto.subtle.importKey("jwk", JSON.parse(env.VAPID_PRIVATE_JWK), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  }
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ typ: "JWT", alg: "ES256" }) + "." + enc({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1e3) + 12 * 3600, sub: "mailto:hello@carnivalsociety.org" });
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, vapidSigningKey, new TextEncoder().encode(unsigned));
  return `vapid t=${unsigned}.${b64url(new Uint8Array(sig))}, k=${env.VAPID_PUBLIC_KEY}`;
}
async function wakeEndpoints(env, endpoints) {
  if (!env.VAPID_PRIVATE_JWK || !env.VAPID_PUBLIC_KEY) return;
  await Promise.all(endpoints.map(async (endpoint) => {
    try {
      const res = await fetch(endpoint, { method: "POST", headers: { TTL: "86400", Urgency: "high", Authorization: await vapidAuth(env, endpoint), "Content-Length": "0" } });
      if (res.status === 404 || res.status === 410) await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).run();
      else if (!res.ok) console.error("push", res.status, await res.text());
    } catch (e) { console.error("push", e); }
  }));
}
// One member. pref = the users.notify_* column that must be on (or null).
async function notifyUser(env, userId, { kind, title, body = null, url = null, ref = null }, pref = null) {
  if (pref) {
    const ok = await env.DB.prepare(`SELECT ${pref} AS on_ FROM users WHERE id = ?`).bind(userId).first();
    if (!ok || !ok.on_) return;
  }
  const res = await env.DB.prepare("INSERT OR IGNORE INTO notifications (user_id, kind, title, body, url, ref) VALUES (?, ?, ?, ?, ?, ?)").bind(userId, kind, title, body, url, ref).run();
  if (!res.meta.changes) return;
  const { results } = await env.DB.prepare("SELECT endpoint FROM push_subscriptions WHERE user_id = ?").bind(userId).all();
  await wakeEndpoints(env, results.map((r) => r.endpoint));
}
// Everyone who wants this kind (pref column), except `exceptId`. One INSERT
// for the rows; pushes capped per invocation (Workers subrequest limits) —
// anyone past the cap still gets it in-app; move to a Queue at scale.
async function notifyEveryone(env, { kind, title, body = null, url = null, ref = null }, pref, exceptId = "") {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO notifications (user_id, kind, title, body, url, ref) SELECT id, ?, ?, ?, ?, ? FROM users WHERE ${pref} = 1 AND id != ?`
  ).bind(kind, title, body, url, ref, exceptId).run();
  const { results } = await env.DB.prepare(
    `SELECT s.endpoint FROM push_subscriptions s JOIN users u ON u.id = s.user_id WHERE u.${pref} = 1 AND u.id != ? LIMIT 45`
  ).bind(exceptId).all();
  await wakeEndpoints(env, results.map((r) => r.endpoint));
}
function eventWhen(iso) {
  try { return new Date(iso).toLocaleString("en-US", { timeZone: "America/Denver", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; }
}
// Hourly: remind volunteers and ticket holders the day before.
async function sendReminders(env) {
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.title, e.starts_at, e.location, x.user_id FROM events e
     JOIN (SELECT event_id, user_id FROM event_volunteers UNION SELECT event_id, user_id FROM tickets WHERE status = 'paid') x ON x.event_id = e.id
     WHERE e.starts_at > datetime('now', '+20 hours') AND e.starts_at <= datetime('now', '+28 hours')`
  ).all();
  for (const r of results) {
    await notifyUser(env, r.user_id, { kind: "reminder", title: `Tomorrow: ${r.title}`, body: `${eventWhen(r.starts_at)}${r.location ? " · " + r.location : ""}. The raven will be watching for you.`, url: `#/event/${r.id}`, ref: `reminder:${r.id}` }, "notify_calls");
  }
}
async function pushRoutes(request, env, url, user) {
  const { pathname } = url;
  const method = request.method;
  if (pathname === "/api/push/subscribe" && method === "POST") {
    if (!user) return err(401, "Sign in required.");
    const { endpoint } = await body(request);
    if (!endpoint || !/^https:\/\//.test(endpoint)) return err(400, "Bad subscription.");
    await env.DB.prepare("INSERT INTO push_subscriptions (endpoint, user_id) VALUES (?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id").bind(endpoint, user.id).run();
    return json({ ok: true });
  }
  if (pathname === "/api/push/unsubscribe" && method === "POST") {
    if (!user) return err(401, "Sign in required.");
    const { endpoint } = await body(request);
    await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?").bind(endpoint || "", user.id).run();
    return json({ ok: true });
  }
  if (pathname === "/api/push/test" && method === "POST") {
    if (!user) return err(401, "Sign in required.");
    await notifyUser(env, user.id, { kind: "test", title: "SQUAWK! Testing, testing…", body: "The raven can find you. See you under the big top.", url: "#/dressing-room" });
    return json({ ok: true });
  }
  // The service worker asks what woke it: newest undelivered squawks.
  if (pathname === "/api/me/notifications/pending" && method === "GET") {
    if (!user) return err(401, "Sign in required.");
    const { results } = await env.DB.prepare("SELECT id, kind, title, body, url FROM notifications WHERE user_id = ? AND delivered_at IS NULL ORDER BY id DESC LIMIT 5").bind(user.id).all();
    await env.DB.prepare("UPDATE notifications SET delivered_at = datetime('now') WHERE user_id = ? AND delivered_at IS NULL").bind(user.id).run();
    return json({ notifications: results });
  }
  return null;
}

// ---------------------------------------------------------------------
// Carnival Passport: merit-badge stamps that earn rank. Rule lives in the
// vault ("CSI Rank and Passport Rule"): Clown → Apprentice is automatic at
// 3 stamps incl. 2 Roustabouts, and crosses the Threshold (tier = inner).
// Journeyman needs a human nod; Master is conferred. Never ranked/compared.
// ---------------------------------------------------------------------
var STAMP_KINDS = ["fix", "ticket", "roustabout", "sawdust", "barker", "junk", "canvasman", "kinker"];
var BADGE_NAMES = { fix: ["The Fix Is In", "I bribed my way in."], ticket: ["Ticket Punched", "I was there."], roustabout: ["Roustabout", "Hauled the canvas."], sawdust: ["Sawdust", "Made it with my hands."], barker: ["Barker", "Step right up!"], junk: ["Junk Saint", "One carnie's trash…"], canvasman: ["Boss Canvasman", "Raised the big top."], kinker: ["Kinker", "I took the ring."] };
var APPRENTICE_STAMPS = 3;
var APPRENTICE_ROUSTABOUTS = 2;
// Unique indexes make repeats (same kind+event, or a second Fix) no-ops.
async function grantStamp(env, { userId, kind, eventId = null, note = null, grantedBy = null }) {
  const res = await env.DB.prepare(
    "INSERT OR IGNORE INTO stamps (id, user_id, kind, event_id, note, granted_by) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(crypto.randomUUID(), userId, kind, eventId, note, grantedBy).run();
  const granted = !!res.meta.changes;
  const promoted = granted ? await checkPromotion(env, userId) : false;
  if (granted) {
    const b = BADGE_NAMES[kind];
    await notifyUser(env, userId, promoted
      ? { kind: "rank", title: "You're an Apprentice!", body: "Two shifts worked, the Threshold crossed. Step inside the guild.", url: "#/dressing-room" }
      : { kind: "prize", title: `You won a prize: ${b ? b[0] : "a stamp"}!`, body: b ? `“${b[1]}” Open your trunk to see it.` : "Open your trunk to see it.", url: "#/dressing-room" }, "notify_prizes");
  }
  return { granted, promoted };
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
  // Unread letters (DMs) for the raven and the Messages badges.
  // What's new: the latest thing someone else added in each place. The
  // client remembers when you last looked (per device) and lights up the room.
  if (pathname === "/api/me/news" && method === "GET") {
    if (!user) return err(401, "Sign in required.");
    const row = await env.DB.prepare(
      `SELECT
         (SELECT MAX(p.created_at) FROM posts p JOIN boards b ON b.id = p.board_id WHERE b.slug = ? AND p.author_id != ?) AS courtyard,
         (SELECT MAX(p.created_at) FROM posts p JOIN boards b ON b.id = p.board_id WHERE b.slug != ? AND p.author_id != ?) AS guild,
         (SELECT MAX(created_at) FROM events WHERE COALESCE(ends_at, starts_at) >= datetime('now') AND COALESCE(created_by, '') != ?) AS events`
    ).bind(COURTYARD_SLUG, user.id, COURTYARD_SLUG, user.id, user.id).first();
    // Your newest stamp, so the app can throw confetti the moment it lands.
    const stamp = await env.DB.prepare(
      "SELECT s.id, s.kind, s.created_at, e.title AS event_title FROM stamps s LEFT JOIN events e ON e.id = s.event_id WHERE s.user_id = ? ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1"
    ).bind(user.id).first();
    return json({ courtyard: row.courtyard, guild: isInner(user) ? row.guild : null, events: row.events, stamp: stamp || null });
  }
  if (pathname === "/api/me/letters" && method === "GET") {
    if (!user) return err(401, "Sign in required.");
    const { results } = await env.DB.prepare(
      `SELECT cp.conversation_id, u.display_name, COUNT(*) AS n, MAX(m.created_at) AS latest
       FROM conversation_participants cp
       JOIN direct_messages m ON m.conversation_id = cp.conversation_id AND m.sender_id != cp.user_id
         AND m.created_at > COALESCE(cp.last_read_at, '1970-01-01')
       JOIN users u ON u.id = m.sender_id
       WHERE cp.user_id = ?
       GROUP BY cp.conversation_id ORDER BY latest DESC`
    ).bind(user.id).all();
    return json({ unread: results.reduce((a, r) => a + r.n, 0), from: results.map((r) => ({ conversation_id: r.conversation_id, display_name: r.display_name, n: r.n })) });
  }
  // Live chat (polled). GET ?after=<id> returns newer messages (or the last
  // 40), and who's been here in the last minute; each poll marks you here.
  if (pathname === "/api/chat" && method === "GET") {
    if (!user) return err(401, "Sign in required.");
    const after = parseInt(url.searchParams.get("after") || "0", 10) || 0;
    await env.DB.prepare("INSERT INTO chat_presence (user_id, seen_at) VALUES (?, datetime('now')) ON CONFLICT(user_id) DO UPDATE SET seen_at = excluded.seen_at").bind(user.id).run();
    const sel = `SELECT m.id, m.user_id, m.body, m.created_at, u.display_name, u.rank, u.is_ringleader
      FROM chat_messages m JOIN users u ON u.id = m.user_id`;
    const { results } = after
      ? await env.DB.prepare(`${sel} WHERE m.id > ? ORDER BY m.id ASC LIMIT 100`).bind(after).all()
      : await env.DB.prepare(`SELECT * FROM (${sel} ORDER BY m.id DESC LIMIT 40) ORDER BY id ASC`).all();
    const { results: here } = await env.DB.prepare(
      `SELECT u.display_name FROM chat_presence p JOIN users u ON u.id = p.user_id
       WHERE p.seen_at > datetime('now', '-60 seconds') ORDER BY p.seen_at DESC LIMIT 30`
    ).all();
    return json({
      messages: results.map((r) => ({ id: r.id, user_id: r.user_id, body: r.body, created_at: r.created_at, display_name: r.display_name, rank: r.rank, is_ringleader: !!r.is_ringleader })),
      here: here.map((h) => h.display_name),
    });
  }
  if (pathname === "/api/chat" && method === "POST") {
    if (!user) return err(401, "Sign in required.");
    const text = String((await body(request)).body || "").trim();
    if (!text) return err(400, "Say something first.");
    if (text.length > 500) return err(400, "Keep it under 500 characters.");
    const last = await env.DB.prepare("SELECT 1 FROM chat_messages WHERE user_id = ? AND created_at > datetime('now', '-2 seconds')").bind(user.id).first();
    if (last) return err(429, "Easy, barker. One at a time.");
    const res = await env.DB.prepare("INSERT INTO chat_messages (user_id, body) VALUES (?, ?)").bind(user.id, text).run();
    return json({ id: res.meta.last_row_id });
  }
  const chatMatch = pathname.match(/^\/api\/chat\/(\d+)$/);
  if (chatMatch && method === "DELETE") {
    if (!user) return err(401, "Sign in required.");
    const msg = await env.DB.prepare("SELECT user_id FROM chat_messages WHERE id = ?").bind(chatMatch[1]).first();
    if (!msg) return err(404, "Not found.");
    if (msg.user_id !== user.id && !isModerator(user)) return err(403, "Not yours to delete.");
    await env.DB.prepare("DELETE FROM chat_messages WHERE id = ?").bind(chatMatch[1]).run();
    return json({ ok: true });
  }
  // The Dressing Room layout: everyone signed in reads it; Ringleaders
  // arrange it (Arrange mode in the room) and save it for everyone.
  if (pathname === "/api/room-layout" && method === "GET") {
    if (!user) return err(401, "Sign in required.");
    const row = await env.DB.prepare("SELECT data, updated_at FROM room_layout WHERE id = 'main'").first();
    return json({ items: row ? JSON.parse(row.data) : null, updated_at: row?.updated_at || null });
  }
  if (pathname === "/api/room-layout" && method === "PUT") {
    if (!user?.is_ringleader) return err(403, "Ringleaders only.");
    const { items } = await body(request);
    if (items === null) {
      await env.DB.prepare("DELETE FROM room_layout WHERE id = 'main'").run();
      return json({ ok: true, reset: true });
    }
    if (!Array.isArray(items) || items.length > 120) return err(400, "items must be an array (max 120).");
    const data = JSON.stringify(items);
    if (data.length > 60000) return err(400, "Layout too large.");
    await env.DB.prepare(
      "INSERT INTO room_layout (id, data, updated_by, updated_at) VALUES ('main', ?, ?, datetime('now')) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_by = excluded.updated_by, updated_at = excluded.updated_at"
    ).bind(data, user.id).run();
    return json({ ok: true });
  }
  // "Your troupe": the people you've actually shared events with (both
  // stamped at the same event). Earned, not picked; names and rank only.
  if (pathname === "/api/me/troupe" && method === "GET") {
    if (!user) return err(401, "Sign in required.");
    const { results } = await env.DB.prepare(
      `SELECT u.id, u.display_name, u.rank, u.is_ringleader, COUNT(DISTINCT s2.event_id) AS shared
       FROM stamps s1
       JOIN stamps s2 ON s2.event_id = s1.event_id AND s2.user_id != s1.user_id
       JOIN users u ON u.id = s2.user_id
       WHERE s1.user_id = ? AND s1.event_id IS NOT NULL
         AND s1.kind IN ('ticket', 'roustabout', 'sawdust') AND s2.kind IN ('ticket', 'roustabout', 'sawdust')
       GROUP BY u.id ORDER BY shared DESC, u.display_name LIMIT 8`
    ).bind(user.id).all();
    return json({ troupe: results.map((r) => ({ id: r.id, display_name: r.display_name, rank: r.rank, is_ringleader: !!r.is_ringleader, shared: r.shared })) });
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
// A paid Checkout Session → its stamp or ticket. Runs from the webhook, or
// from the ticket page asking Stripe directly when the webhook is late (or
// missing). Idempotent: the payments row is the lock.
async function fulfillCheckout(env, s) {
  if (s.payment_status !== "paid") return false;
  const md = s.metadata || {};
  const userId = md.user_id;
  const ins = await env.DB.prepare(
    "INSERT OR IGNORE INTO payments (id, user_id, kind, amount_cents, stripe_session_id, stripe_payment_intent) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(crypto.randomUUID(), userId, md.kind, s.amount_total, s.id, s.payment_intent || null).run();
  if (!ins.meta.changes) return true; // already processed
  if (md.kind === "membership") {
    // The $5 buys a stamp ("The Fix Is In"), not a rank or inner access —
    // see CSI Rank and Passport Rule.
    await grantStamp(env, { userId, kind: "fix" });
  } else if (md.kind === "ticket") {
    await env.DB.prepare("UPDATE tickets SET status = 'paid' WHERE id = ?").bind(md.ticket_id).run();
    // Bought entry online for the first time: the registration was in it.
    if (Number(md.registration) > 0) await grantStamp(env, { userId, kind: "fix" });
    await sendTicketEmail(env, md.ticket_id, { claim: await claimLinkFor(env, userId) });
  }
  return true;
}
// Hourly: any card checkout from the last week still "pending" gets checked
// with Stripe, so a missed webhook never strands a paid ticket.
async function catchUpPayments(env) {
  if (!env.STRIPE_SECRET_KEY) return;
  const { results } = await env.DB.prepare("SELECT stripe_session_id FROM tickets WHERE status = 'pending' AND stripe_session_id IS NOT NULL AND created_at > datetime('now', '-7 days')").all();
  for (const r of results) {
    try { const s = await stripeSession(env, r.stripe_session_id); if (s) await fulfillCheckout(env, s); }
    catch (e) { console.error(e); }
  }
}
async function stripeSession(env, id) {
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions/" + encodeURIComponent(id), {
    headers: { Authorization: "Bearer " + env.STRIPE_SECRET_KEY }
  });
  return res.ok ? res.json() : null;
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
    await fulfillCheckout(env, event.data.object);
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
      `SELECT tickets.id, tickets.code, tickets.status, tickets.checked_in_at, tickets.event_id, ticket_tiers.name AS tier_name, events.title, events.starts_at, events.location
       FROM tickets JOIN ticket_tiers ON ticket_tiers.id = tickets.tier_id JOIN events ON events.id = tickets.event_id
       WHERE tickets.user_id = ? AND tickets.status IN ('paid', 'reserved') ORDER BY events.starts_at`
    ).bind(user.id).all();
    const passes = (await roomGifts(env, user.id)).filter((g) => g.kind === "pass" && g.opened_at);
    return json({ tickets: results, passes });
  }

  return null;
}

// Partners (often Courtyard-tier org accounts) may also post and run their
// own events and holler at their friends; each route checks ownership.
function partnerAllowed(method, pathname) {
  if (pathname === "/api/events" && method === "POST") return true;
  if (/^\/api\/events\/[^/]+$/.test(pathname) && (method === "PATCH" || method === "DELETE")) return true;
  if (/^\/api\/events\/[^/]+\/(photos|flyer)$/.test(pathname)) return true;
  if (pathname === "/api/blasts" || pathname === "/api/blasts/preview" || pathname === "/api/partner") return true;
  if (method === "POST" && /^\/api\/events\/[^/]+\/(jobs|needs|run)$/.test(pathname)) return true;
  if (method === "DELETE" && /^\/api\/(jobs|needs|run)\/[^/]+$/.test(pathname)) return true;
  return false;
}
function waitlistAllowed(method, pathname) {
  if (pathname === "/api/me/intro" || pathname === "/api/me/photo" || (method === "GET" && /^\/api\/photos\/[^/]+$/.test(pathname))) return true;
  if (method === "GET" && (pathname === "/api/me/waitlist" || pathname === "/api/me/tickets" || pathname === "/api/me/notifications/pending")) return true;
  if (method === "POST" && /^\/api\/push\/(subscribe|unsubscribe|test)$/.test(pathname)) return true;
  return false;
}
function courtyardAllowed(method, pathname) {
  if (method === "GET" && (pathname === "/api/chapters" || pathname === "/api/events" || pathname === "/api/me/tickets" || pathname === "/api/me/volunteering" || pathname === "/api/me/passport" || pathname === "/api/me/troupe" || pathname === "/api/room-layout" || pathname === "/api/me/news" || pathname === "/api/jobs" || pathname === "/api/me/jobs" || pathname === "/api/me/album" || pathname === "/api/me/crews" || pathname === "/api/me/room" || pathname === "/api/materials" || pathname === "/api/run")) return true;
  if ((method === "POST" || method === "DELETE") && /^\/api\/materials\/[^/]+\/pledge$/.test(pathname)) return true;
  if (method === "PUT" && pathname === "/api/me/room") return true;
  if (pathname.startsWith("/api/public/")) return true;
  // Door crew can be Courtyard folk; doorRoutes checks the Door job.
  if (/^\/api\/events\/[^/]+\/(door|checkin)(\/|$)/.test(pathname)) return true;
  if (method === "POST" && /^\/api\/gifts\/[a-f0-9]+\/open$/.test(pathname)) return true;
  if (method === "GET" && /^\/api\/rooms\/[^/]+$/.test(pathname)) return true;
  if ((method === "POST" && /^\/api\/rooms\/[^/]+\/notes$/.test(pathname)) || (method === "DELETE" && /^\/api\/rooms\/[^/]+\/notes\/\d+$/.test(pathname))) return true;
  if (method === "GET" && /^\/api\/events\/[^/]+\/table$/.test(pathname)) return true;
  if (method === "POST" && (/^\/api\/events\/[^/]+\/table\/messages$/.test(pathname) || pathname === "/api/handshakes")) return true;
  if ((method === "POST" || method === "DELETE") && /^\/api\/jobs\/[^/]+\/claim$/.test(pathname)) return true;
  if (pathname === "/api/chat" && (method === "GET" || method === "POST")) return true;
  if (method === "POST" && /^\/api\/push\/(subscribe|unsubscribe|test)$/.test(pathname)) return true;
  if (method === "GET" && pathname === "/api/me/notifications/pending") return true;
  if (method === "GET" && pathname === "/api/me/blast") return true;
  if (method === "GET" && pathname === "/api/me/card") return true;
  if (method === "GET" && pathname === "/api/backstage") return true;
  if (method === "POST" && pathname === "/api/posts") return true; // replies in the introductions thread only (checked there)
  if (method === "POST" && /^\/api\/me\/backer\/(welcomed|deck)$/.test(pathname)) return true;
  if (method === "POST" && /^\/api\/me\/blast\/\d+\/seen$/.test(pathname)) return true;
  if (method === "DELETE" && /^\/api\/chat\/\d+$/.test(pathname)) return true;
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
