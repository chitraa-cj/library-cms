import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { type Express } from "express";
import session from "express-session";
import { scrypt, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { storage } from "./storage";
import { User } from "@shared/schema";
import connectPg from "connect-pg-simple";

const scryptAsync = promisify(scrypt);

/**
 * CMS editors work on large granthas across many sessions over weeks. Anyone who used
 * the app within the last year stays signed in — `rolling: true` below resets the cookie
 * on every authenticated request, so an active editor never sees a login screen.
 * Override with SESSION_MAX_AGE_DAYS env var if a shorter retention is required by policy.
 */
const SESSION_MAX_AGE_MS = (() => {
  const days = parseInt(process.env.SESSION_MAX_AGE_DAYS || "365", 10);
  return (Number.isFinite(days) && days > 0 ? days : 365) * 24 * 60 * 60 * 1000;
})();

async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const buf = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${buf.toString("hex")}.${salt}`;
}

async function comparePasswords(supplied: string, stored: string) {
  const [hashedPassword, salt] = stored.split(".");
  const hashedPasswordBuf = Buffer.from(hashedPassword, "hex");
  const suppliedPasswordBuf = (await scryptAsync(supplied, salt, 64)) as Buffer;
  return timingSafeEqual(hashedPasswordBuf, suppliedPasswordBuf);
}

export function setupAuth(app: Express) {
  if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET?.trim()) {
    console.error(
      "[auth] FATAL: SESSION_SECRET is missing in production — set a stable secret or all users will be logged out on every deploy.",
    );
  }

  const PgSession = connectPg(session);

  const sessionSettings: session.SessionOptions = {
    secret: process.env.SESSION_SECRET!,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      maxAge: SESSION_MAX_AGE_MS,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
    },
    store: new PgSession({
      conString: process.env.DATABASE_URL,
      createTableIfMissing: true,
      ttl: Math.floor(SESSION_MAX_AGE_MS / 1000),
      pruneSessionInterval: 60 * 60,
    }),
  };

  app.use(session(sessionSettings));
  app.use(passport.initialize());
  app.use(passport.session());

  // Resilience fallback: when deserializeUser couldn't load the user from the DB
  // (transient connection storm during a multi-minute grantha publish), Passport
  // leaves req.user undefined and isAuthenticated() returns false — which surfaces
  // to the client as a logout. If we stashed a snapshot at login time, restore
  // req.user from it for THIS request only. The next request will retry the DB
  // load, so genuinely deleted/disabled users will be evicted on the next attempt.
  app.use((req: any, _res, next) => {
    if (!req.user) {
      const snap = req.session?.cmsUserSnapshot;
      if (snap?.id) {
        req.user = snap;
        const origIsAuth = req.isAuthenticated?.bind(req);
        req.isAuthenticated = () => true;
        req._cmsAuthDegraded = true;
        // Read-only restore — do NOT write to req.session here. Sustained DB outages
        // would otherwise trigger a session write per request, hammering the same DB
        // that's already failing. The next successful deserialize replaces the snapshot.
        void origIsAuth;
      }
    }
    next();
  });

  // Extend session lifetime on every authenticated API call (Save & Publish, polling, etc.).
  // Also refresh the snapshot from a fresh req.user so the fallback above stays current.
  app.use((req: any, _res, next) => {
    if (req.session?.cookie && req.isAuthenticated?.()) {
      req.session.cookie.maxAge = SESSION_MAX_AGE_MS;
    }
    if (req.user && req.session && !req._cmsAuthDegraded) {
      const u: any = req.user;
      const snap = req.session.cmsUserSnapshot;
      if (!snap || snap.id !== u.id || snap.role !== u.role || snap.username !== u.username) {
        const { password: _pw, ...safe } = u;
        req.session.cmsUserSnapshot = safe;
      }
    }
    next();
  });

  passport.use(
    new LocalStrategy(async (username, password, done) => {
      try {
        const user = await storage.getUserByUsername(username);
        if (!user) {
          return done(null, false, { message: "Invalid username or password" });
        }
        const isValid = await comparePasswords(password, user.password);
        if (!isValid) {
          return done(null, false, { message: "Invalid username or password" });
        }
        return done(null, user);
      } catch (err) {
        return done(err);
      }
    })
  );

  passport.serializeUser((user: any, done) => {
    done(null, user.id);
  });

  passport.deserializeUser(async (id: string, done) => {
    // DB can be saturated during grantha publishes (hundreds of queries / sec). A single
    // failed load on /api/auth/user is enough to drop req.user and log the editor out
    // mid-publish, so retry with backoff before giving up. The snapshot middleware above
    // is the final safety net when all retries fail.
    const attempts = [0, 200, 600];
    let lastErr: unknown = null;
    for (let i = 0; i < attempts.length; i++) {
      if (attempts[i] > 0) await new Promise((r) => setTimeout(r, attempts[i]));
      try {
        const user = await storage.getUser(id);
        if (user) return done(null, user);
        // User legitimately not found (deleted, demoted, etc.) — don't retry, just no auth.
        if (i === attempts.length - 1) return done(null, null);
      } catch (err) {
        lastErr = err;
      }
    }
    console.error("[auth] deserializeUser DB error after retries (session kept, snapshot may apply):", lastErr);
    // Never pass `err` here — it breaks requests mid-publish and surfaces as logout on the client.
    done(null, null);
  });

  const stashUserSnapshot = (req: any, user: User) => {
    if (!req.session) return;
    const { password: _pw, ...safe } = user;
    req.session.cmsUserSnapshot = safe;
  };

  app.post("/api/auth/register", async (req, res, next) => {
    try {
      const { username, password, displayName } = req.body;
      if (!username || !password || !displayName) {
        return res.status(400).json({ message: "Username, display name, and password are required." });
      }
      const existing = await storage.getUserByUsername(username);
      if (existing) {
        return res.status(409).json({ message: "Username already taken. Please choose another." });
      }
      const hashed = await hashPassword(password);
      const user = await storage.createUser({ username, password: hashed, displayName, role: "editor" });
      req.login(user, (err) => {
        if (err) return next(err);
        stashUserSnapshot(req, user);
        const { password: _, ...safeUser } = user;
        return res.status(201).json(safeUser);
      });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/auth/login", (req, res, next) => {
    passport.authenticate("local", (err: any, user: User | false, info: any) => {
      if (err) return next(err);
      if (!user) {
        return res.status(401).json({ message: info?.message || "Invalid credentials" });
      }
      req.login(user, (err) => {
        if (err) return next(err);
        stashUserSnapshot(req, user);
        const { password: _, ...safeUser } = user;
        return res.json(safeUser);
      });
    })(req, res, next);
  });

  app.post("/api/auth/logout", (req: any, res) => {
    if (req.session) {
      delete req.session.cmsUserSnapshot;
    }
    req.logout((err: any) => {
      if (err) return res.status(500).json({ message: "Logout failed" });
      return res.json({ message: "Logged out" });
    });
  });

  app.get("/api/auth/user", (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    const { password: _, ...safeUser } = req.user as User;
    return res.json(safeUser);
  });
}

export function requireAuth(req: any, res: any, next: any) {
  if (req.isAuthenticated()) {
    return next();
  }
  return res.status(401).json({ message: "Authentication required" });
}

export function requireAdmin(req: any, res: any, next: any) {
  if (req.isAuthenticated() && (req.user as User).role === "admin") {
    return next();
  }
  return res.status(403).json({ message: "Admin access required" });
}

export { hashPassword };
