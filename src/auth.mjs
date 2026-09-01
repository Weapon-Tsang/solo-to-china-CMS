import crypto from "node:crypto";

const COOKIE_NAME = "solo_to_china_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

export function createAuth(db, config) {
  const enabled = Boolean(config.password && config.sessionSecret);
  if (!enabled) return disabledAuth();

  ensureBootstrapUser(db, config);
  const signingKey = crypto.createHash("sha256").update(config.sessionSecret).digest();

  return {
    enabled: true,
    status(request) {
      const session = readSession(request, signingKey);
      if (!session) return { authenticated: false, username: null, mustChangePassword: false };
      const user = findUser(db, session.username);
      if (!user) return { authenticated: false, username: null, mustChangePassword: false };
      return { authenticated: true, username: user.username, mustChangePassword: Boolean(user.force_password_change) };
    },
    login(username, password) {
      const user = findUser(db, username);
      if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) return null;
      return { username: user.username, mustChangePassword: Boolean(user.force_password_change), cookie: createCookie(user.username, signingKey) };
    },
    changePassword(request, currentPassword, nextPassword) {
      const session = readSession(request, signingKey);
      const user = session && findUser(db, session.username);
      if (!user || !verifyPassword(currentPassword, user.password_salt, user.password_hash)) return null;
      validatePassword(nextPassword);
      const { salt, hash } = hashPassword(nextPassword);
      db.prepare("UPDATE app_users SET password_salt = ?, password_hash = ?, force_password_change = 0, updated_at = datetime('now') WHERE username = ?")
        .run(salt, hash, user.username);
      return { username: user.username, mustChangePassword: false, cookie: createCookie(user.username, signingKey) };
    },
    updateCredentials(request, currentPassword, nextUsername, nextPassword = "") {
      const session = readSession(request, signingKey);
      const user = session && findUser(db, session.username);
      if (!user || !verifyPassword(currentPassword, user.password_salt, user.password_hash)) return null;
      const username = validateUsername(nextUsername);
      const password = String(nextPassword || "");
      if (username !== user.username && findUser(db, username)) throw httpError(409, "That administrator account name is already in use.");
      if (password) validatePassword(password);
      const credentials = password ? hashPassword(password) : { salt: user.password_salt, hash: user.password_hash };
      db.prepare("UPDATE app_users SET username = ?, password_salt = ?, password_hash = ?, force_password_change = 0, updated_at = datetime('now') WHERE username = ?")
        .run(username, credentials.salt, credentials.hash, user.username);
      return { username, mustChangePassword: false, cookie: createCookie(username, signingKey) };
    },
    require(request, { allowPasswordChange = false } = {}) {
      const session = readSession(request, signingKey);
      const user = session && findUser(db, session.username);
      if (!user) throw httpError(401, "Please sign in to continue.");
      if (user.force_password_change && !allowPasswordChange) throw httpError(403, "Change the initial password before using the dashboard.");
      return user;
    },
    clearCookie() {
      return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
    },
  };
}

function disabledAuth() {
  return {
    enabled: false,
    status: () => ({ authenticated: true, username: null, mustChangePassword: false }),
    login: () => null,
    changePassword: () => null,
    updateCredentials: () => null,
    require: () => null,
    clearCookie: () => "",
  };
}

function ensureBootstrapUser(db, config) {
  const existing = db.prepare("SELECT username FROM app_users LIMIT 1").get();
  if (existing) return;
  if (config.password !== "123456") validatePassword(config.password);
  const { salt, hash } = hashPassword(config.password);
  db.prepare("INSERT INTO app_users(username, password_salt, password_hash, force_password_change, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))")
    .run(config.username, salt, hash, config.forcePasswordChange ? 1 : 0);
}

function findUser(db, username) {
  return db.prepare("SELECT username, password_salt, password_hash, force_password_change FROM app_users WHERE username = ?").get(String(username || ""));
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString("base64url") };
}

function verifyPassword(password, salt, expectedHash) {
  const actual = crypto.scryptSync(String(password || ""), salt, 64).toString("base64url");
  const expected = Buffer.from(expectedHash);
  const supplied = Buffer.from(actual);
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < 8) throw httpError(400, "Password must contain at least 8 characters.");
}

function validateUsername(username) {
  const normalized = String(username || "").trim();
  if (!/^[A-Za-z0-9_.-]{3,64}$/.test(normalized)) throw httpError(400, "Administrator account names must be 3–64 letters, numbers, dots, hyphens, or underscores.");
  return normalized;
}

function createCookie(username, signingKey) {
  const payload = Buffer.from(JSON.stringify({ username, expiresAt: Date.now() + SESSION_TTL_MS })).toString("base64url");
  const signature = crypto.createHmac("sha256", signingKey).update(payload).digest("base64url");
  return `${COOKIE_NAME}=${payload}.${signature}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

function readSession(request, signingKey) {
  const token = parseCookies(request.headers.cookie || "")[COOKIE_NAME];
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = crypto.createHmac("sha256", signingKey).update(payload).digest("base64url");
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== suppliedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof parsed.username === "string" && Number(parsed.expiresAt) > Date.now() ? parsed : null;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  return Object.fromEntries(String(header).split(";").map((part) => part.trim().split(/=(.*)/s, 2)).filter(([key, value]) => key && value));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
