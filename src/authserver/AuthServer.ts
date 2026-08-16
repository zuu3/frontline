import { randomBytes, randomUUID, createHash } from "crypto";
import * as dotenv from "dotenv";
import express from "express";
import cookieParser from "cookie-parser";
import { SignJWT } from "jose";
import { z } from "zod";
import { WebSocket, WebSocketServer } from "ws";
import { base64urlToUuid, uuidToBase64url } from "../core/Base64";
import { cosmeticsCatalog } from "./cosmeticsCatalog";
import {
  Account,
  addSoftCurrency,
  approveClanRequest,
  banClanMember,
  browseClans,
  claimAllRewardRows,
  claimRewardRow,
  clanExists,
  computeMemberStats,
  createClan,
  denyClanRequest,
  disbandClan,
  fetchClanBans,
  fetchClanGames,
  fetchClanLeaderboard,
  fetchClanMembers,
  fetchClanRequests,
  findAccountByDiscordId,
  findAccountByGoogleEmail,
  findAccountById,
  getAccountClanRequests,
  getAccountClans,
  getAccountFlares,
  getAllClanTags,
  getClan,
  getMembership,
  getPlayerStatsBlobs,
  getPlayerStatsRows,
  getPublicPlayerGames,
  saveGamePlayerStats,
  getUnclaimedRewards,
  grantDailyCheckinIfEligible,
  grantFlare,
  initSchema,
  joinClan,
  leaveClan,
  normalizeClanTag,
  pool,
  removeMember,
  setMemberRole,
  transferLeadership,
  trySpendSoftCurrency,
  unbanClanMember,
  updateClan,
  withdrawClanRequest,
  type ClanMemberWL,
  type PlayerStatsBlobRow,
  type PlayerStatsRow,
} from "./db";
import { loadOrCreateKeyPair } from "./keys";

dotenv.config();

const PORT = parseInt(process.env.AUTH_PORT ?? "8787", 10);
// The URL a browser actually ends up at after the vite /authapi proxy --
// used to build OAuth authorize/token redirect_uris. Must match what's
// registered with Discord/Google exactly.
const PUBLIC_URL =
  process.env.AUTH_PUBLIC_URL ?? `http://localhost:9000/authapi`;
// Must equal exactly what the browser's getApiBase()/jwtIssuer() compute
// (same-origin "<origin>/authapi"), since Auth.ts rejects a JWT whose `iss`
// doesn't match that string exactly. That origin varies with how the box
// is reached (localhost:9000 directly vs. the tunnel domain), so this has
// to be set to match however testers actually reach it -- it can't be
// derived automatically the way PUBLIC_URL's default is.
const ISSUER = process.env.AUTH_ISSUER ?? PUBLIC_URL;
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_DAYS = 30;
const REFRESH_COOKIE = "refresh_token";

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID ?? "";
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET ?? "";
// Shared secret the game server sends on internal calls (game-record
// ingestion) -- matches ServerEnv.apiKey() / Archive.ts's x-api-key header.
const API_KEY = process.env.API_KEY ?? "";
const RANKED_K_FACTOR = 32;
const RANKED_DEFAULT_ELO = 1000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";

const UsernameBodySchema = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(20)
    .regex(/^[a-zA-Z0-9_-]+( [a-zA-Z0-9_-]+)*$/),
});

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function encodeState(redirectUri: string): string {
  return Buffer.from(JSON.stringify({ redirectUri })).toString("base64url");
}

function decodeState(state: string): { redirectUri: string } {
  return JSON.parse(Buffer.from(state, "base64url").toString("utf-8"));
}

async function issueSession(
  res: express.Response,
  accountId: string,
  provider: string,
): Promise<{ jwt: string; expiresIn: number }> {
  const { privateKey } = await loadOrCreateKeyPair();
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({ provider })
    .setProtectedHeader({ alg: "EdDSA" })
    .setJti(randomUUID())
    .setSubject(uuidToBase64url(accountId))
    .setIssuedAt(now)
    .setIssuer(ISSUER)
    .setAudience("localhost")
    .setExpirationTime(now + ACCESS_TOKEN_TTL_SECONDS)
    .sign(privateKey);

  const refreshToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(
    Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  );
  await pool.query(
    "INSERT INTO refresh_tokens (token_hash, account_id, expires_at) VALUES ($1, $2, $3)",
    [hashToken(refreshToken), accountId, expiresAt],
  );
  res.cookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: PUBLIC_URL.startsWith("https"),
    maxAge: REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    path: "/",
  });

  return { jwt, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

async function fetchSingleplayerAchievements(
  accountId: string,
): Promise<{ mapName: string; difficulty: string }[]> {
  const { rows } = await pool.query<{ game_map: string; difficulty: string }>(
    `SELECT DISTINCT g.game_map, g.difficulty
     FROM game_players gp
     JOIN games g ON g.game_id = gp.game_id
     WHERE gp.account_id = $1 AND gp.won = true AND g.game_type = 'Singleplayer'
       AND g.game_map IS NOT NULL AND g.difficulty IS NOT NULL`,
    [accountId],
  );
  return rows.map((r) => ({ mapName: r.game_map, difficulty: r.difficulty }));
}

async function fetchRankedElo(
  accountId: string,
): Promise<{ oneVone?: { elo: number }; twoVtwo?: { elo: number } }> {
  const { rows } = await pool.query<{ ranked_type: string; elo: number }>(
    "SELECT ranked_type, elo FROM ranked_stats WHERE account_id = $1",
    [accountId],
  );
  const result: { oneVone?: { elo: number }; twoVtwo?: { elo: number } } = {};
  for (const r of rows) {
    if (r.ranked_type === "1v1") result.oneVone = { elo: r.elo };
    if (r.ranked_type === "2v2") result.twoVtwo = { elo: r.elo };
  }
  return result;
}

async function accountToUserMe(account: Account) {
  const username = account.username_base;
  const [achievements, leaderboard, flares, rewardRows, clanRows, clanRequestRows] =
    await Promise.all([
      fetchSingleplayerAchievements(account.id),
      fetchRankedElo(account.id),
      getAccountFlares(account.id),
      getUnclaimedRewards(account.id),
      getAccountClans(account.id),
      getAccountClanRequests(account.id),
    ]);
  const rewards = rewardRows.map((r) => ({
    id: r.id,
    currencyType: r.currency_type as "soft" | "hard",
    amount: r.amount,
    reason: r.reason,
    note: r.note,
  }));
  const clans = clanRows.map((c) => ({
    tag: c.tag,
    name: c.name,
    role: c.role,
    joinedAt: c.joined_at.toISOString(),
    memberCount: Number(c.member_count),
  }));
  const clanRequests = clanRequestRows.map((r) => ({
    tag: r.tag,
    name: r.name,
    createdAt: r.created_at.toISOString(),
  }));
  return {
    user: {
      discord: account.discord_id
        ? {
            id: account.discord_id,
            avatar: account.discord_avatar,
            username: account.discord_username ?? "",
            global_name: account.discord_global_name,
            discriminator: "0",
          }
        : undefined,
      google: account.google_email
        ? { email: account.google_email }
        : undefined,
    },
    ban: null,
    player: {
      publicId: account.id,
      adfree: true,
      unlimitedRanked: account.username_status !== "unclaimed",
      canCreatePublicLobbies: account.username_status !== "unclaimed",
      username,
      usernameBase: username,
      usernameDiscriminator: null,
      usernameStatus: account.username_status,
      usernameClaimExpiresAt: null,
      nextUsernameChangeAt: null,
      flares,
      // No real-money purchase backend -- only `soft` is ever nonzero.
      // Earned by winning games (/game/:gameId), spent in /shop/purchase.
      currency: { soft: account.soft_currency, hard: 0 },
      achievements: { singleplayerMap: achievements },
      leaderboard,
      friends: [],
      subscription: null,
      // Unclaimed rewards -- NOT reflected in `currency` above until the
      // player claims them (POST /rewards/:id/claim or /rewards/claim-all).
      // Currently the only source is the daily-login grant (see
      // grantDailyCheckinIfEligible(), called from /game/:gameId below);
      // Main.ts auto-opens <rewards-modal> with these on a clean homepage
      // load.
      rewards,
      // See the `dailyCheckin` field comment in ApiSchemas.ts.
      dailyCheckin: { streak: account.checkin_streak },
      clans,
      clanRequests,
    },
  };
}

async function main() {
  await initSchema();
  const { publicJwk } = await loadOrCreateKeyPair();

  const app = express();
  app.use(cookieParser());
  // Full game records carry per-turn history and can get large on long
  // games -- express's 100kb default is too small.
  app.use(express.json({ limit: "50mb" }));

  app.get("/.well-known/jwks.json", (_req, res) => {
    res.json({ keys: [publicJwk] });
  });

  // Public catalog -- no auth required to browse the store. Ownership is
  // resolved separately client-side from /users/@me's flares (see
  // cosmeticsCatalog.ts for why everything here is free).
  app.get("/cosmetics.json", (_req, res) => {
    res.json(cosmeticsCatalog);
  });

  // --- Discord OAuth ---
  app.get("/auth/login/discord", (req, res) => {
    if (!DISCORD_CLIENT_ID) {
      res.status(503).send("Discord login not configured (DISCORD_CLIENT_ID)");
      return;
    }
    const redirectUri = String(req.query.redirect_uri ?? "/");
    const callback = `${PUBLIC_URL}/auth/callback/discord`;
    const url = new URL("https://discord.com/oauth2/authorize");
    url.searchParams.set("client_id", DISCORD_CLIENT_ID);
    url.searchParams.set("redirect_uri", callback);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "identify");
    url.searchParams.set("state", encodeState(redirectUri));
    res.redirect(url.toString());
  });

  app.get("/auth/callback/discord", async (req, res) => {
    try {
      const code = String(req.query.code ?? "");
      const { redirectUri } = decodeState(String(req.query.state ?? ""));
      const callback = `${PUBLIC_URL}/auth/callback/discord`;

      const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: DISCORD_CLIENT_ID,
          client_secret: DISCORD_CLIENT_SECRET,
          grant_type: "authorization_code",
          code,
          redirect_uri: callback,
        }),
      });
      if (!tokenRes.ok) throw new Error(`discord token exchange: ${tokenRes.status}`);
      const { access_token } = await tokenRes.json();

      const userRes = await fetch("https://discord.com/api/users/@me", {
        headers: { authorization: `Bearer ${access_token}` },
      });
      if (!userRes.ok) throw new Error(`discord user fetch: ${userRes.status}`);
      const discordUser = await userRes.json();

      let account = await findAccountByDiscordId(discordUser.id);
      if (!account) {
        const id = randomUUID();
        await pool.query(
          `INSERT INTO accounts (id, discord_id, discord_username, discord_global_name, discord_avatar)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            id,
            discordUser.id,
            discordUser.username,
            discordUser.global_name ?? null,
            discordUser.avatar ?? null,
          ],
        );
        account = await findAccountById(id);
      }
      if (!account) throw new Error("account upsert failed");

      await issueSession(res, account.id, "discord");
      res.redirect(redirectUri);
    } catch (e) {
      console.error("[auth] discord callback failed", e);
      res.status(500).send("Discord login failed");
    }
  });

  // --- Google OAuth ---
  app.get("/auth/login/google", (req, res) => {
    if (!GOOGLE_CLIENT_ID) {
      res.status(503).send("Google login not configured (GOOGLE_CLIENT_ID)");
      return;
    }
    const redirectUri = String(req.query.redirect_uri ?? "/");
    const callback = `${PUBLIC_URL}/auth/callback/google`;
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", GOOGLE_CLIENT_ID);
    url.searchParams.set("redirect_uri", callback);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email");
    url.searchParams.set("state", encodeState(redirectUri));
    res.redirect(url.toString());
  });

  app.get("/auth/callback/google", async (req, res) => {
    try {
      const code = String(req.query.code ?? "");
      const { redirectUri } = decodeState(String(req.query.state ?? ""));
      const callback = `${PUBLIC_URL}/auth/callback/google`;

      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          grant_type: "authorization_code",
          code,
          redirect_uri: callback,
        }),
      });
      if (!tokenRes.ok) throw new Error(`google token exchange: ${tokenRes.status}`);
      const { access_token } = await tokenRes.json();

      const userRes = await fetch(
        "https://www.googleapis.com/oauth2/v3/userinfo",
        { headers: { authorization: `Bearer ${access_token}` } },
      );
      if (!userRes.ok) throw new Error(`google userinfo fetch: ${userRes.status}`);
      const googleUser = await userRes.json();

      let account = await findAccountByGoogleEmail(googleUser.email);
      if (!account) {
        const id = randomUUID();
        await pool.query(
          "INSERT INTO accounts (id, google_email) VALUES ($1, $2)",
          [id, googleUser.email],
        );
        account = await findAccountById(id);
      }
      if (!account) throw new Error("account upsert failed");

      await issueSession(res, account.id, "google");
      res.redirect(redirectUri);
    } catch (e) {
      console.error("[auth] google callback failed", e);
      res.status(500).send("Google login failed");
    }
  });

  // --- Session lifecycle ---
  app.post("/auth/refresh", async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) {
      res.status(401).json({ error: "no refresh token" });
      return;
    }
    const { rows } = await pool.query<{
      account_id: string;
      expires_at: Date;
    }>(
      "SELECT account_id, expires_at FROM refresh_tokens WHERE token_hash = $1",
      [hashToken(token)],
    );
    const row = rows[0];
    if (!row || row.expires_at.getTime() < Date.now()) {
      res.status(401).json({ error: "invalid or expired refresh token" });
      return;
    }
    const { jwt, expiresIn } = await issueSession(res, row.account_id, "refresh");
    res.json({ jwt, expiresIn });
  });

  app.post("/auth/logout", async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (token) {
      await pool.query("DELETE FROM refresh_tokens WHERE token_hash = $1", [
        hashToken(token),
      ]);
    }
    res.clearCookie(REFRESH_COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  app.post("/auth/revoke", async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (token) {
      const { rows } = await pool.query<{ account_id: string }>(
        "SELECT account_id FROM refresh_tokens WHERE token_hash = $1",
        [hashToken(token)],
      );
      if (rows[0]) {
        await pool.query("DELETE FROM refresh_tokens WHERE account_id = $1", [
          rows[0].account_id,
        ]);
      }
    }
    res.clearCookie(REFRESH_COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  // --- Account ---
  // Access tokens are short-lived and only ever presented right after being
  // minted by this same process, so a lightweight unverified decode is
  // enough here -- signature verification matters for the *game* server
  // (jwt.ts, via JWKS), not for these self-service routes.
  function decodeAccountIdFromJwt(jwt: string): string | null {
    try {
      const payload = JSON.parse(
        Buffer.from(jwt.split(".")[1], "base64url").toString("utf-8"),
      );
      if (typeof payload.sub !== "string") return null;
      return base64urlToUuid(payload.sub);
    } catch {
      return null;
    }
  }

  function requireBearerAccountId(req: express.Request): string | null {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    return decodeAccountIdFromJwt(header.slice(7));
  }

  app.get("/users/@me", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    // No grant here on purpose -- daily_checkin only advances from a visit
    // to playing a game (see grantDailyCheckinIfEligible's call site in
    // /game/:gameId below), not to visiting any particular page.
    const account = await findAccountById(accountId);
    if (!account) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.json(await accountToUserMe(account));
  });

  // Claims matching client's claimReward()/claimAllRewards() contracts
  // exactly (src/client/Api.ts): both return the post-claim balances so the
  // UI can update without re-fetching /users/@me. A reward that's unknown,
  // already claimed, or belongs to another account is deliberately
  // indistinguishable (404) -- see claimReward()'s doc comment.
  app.post("/rewards/:rewardId/claim", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const claimed = await claimRewardRow(accountId, req.params.rewardId);
    if (!claimed) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const account = await findAccountById(accountId);
    res.json({ currency: { soft: account?.soft_currency ?? 0, hard: 0 } });
  });

  app.post("/rewards/claim-all", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const claimed = await claimAllRewardRows(accountId);
    const account = await findAccountById(accountId);
    res.json({
      claimed: claimed.map((r) => ({ id: r.id })),
      currency: { soft: account?.soft_currency ?? 0, hard: 0 },
    });
  });

  // Matches purchaseWithCurrency()'s contract exactly (src/client/Api.ts):
  // POST body { cosmeticType, cosmeticName, currencyType, colorPaletteName? },
  // 200 on success, any non-2xx read as failure client-side, 401 logs out.
  // cosmeticType "pattern" or "effect", currencyType "soft" only -- there is
  // no real-money purchase path (see cosmeticsCatalog.ts). Rejects (409) a
  // repurchase of an already-owned flare before charging, since the store
  // grid hiding owned items is a UI convenience, not the actual guard.
  app.post("/shop/purchase", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const PurchaseBodySchema = z.object({
      cosmeticType: z.string(),
      cosmeticName: z.string(),
      currencyType: z.string(),
    });
    const parsed = PurchaseBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid request" });
      return;
    }
    const { cosmeticType, cosmeticName, currencyType } = parsed.data;
    if (
      (cosmeticType !== "pattern" && cosmeticType !== "effect") ||
      currencyType !== "soft"
    ) {
      res.status(400).json({ error: "unsupported purchase" });
      return;
    }
    // Effects are nested catalog.effects[effectType][name]; the name itself
    // is unique across effect types in this catalog, so search every bucket
    // rather than requiring the client to also send effectType.
    const item =
      cosmeticType === "pattern"
        ? cosmeticsCatalog.patterns[cosmeticName]
        : Object.values(cosmeticsCatalog.effects ?? {})
            .flatMap((byName) => Object.values(byName ?? {}))
            .find((e) => e.name === cosmeticName);
    if (!item || item.priceSoft === undefined) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const flare = `${cosmeticType}:${cosmeticName}`;
    // Reject before charging if already owned -- otherwise a stale grid (or a
    // double-click racing the post-purchase refresh) re-charges an account
    // for a flare grantFlare() would just no-op on anyway.
    const flares = await getAccountFlares(accountId);
    if (flares.includes(flare) || flares.includes(`${cosmeticType}:*`)) {
      res.status(409).json({ error: "already_owned" });
      return;
    }
    const spent = await trySpendSoftCurrency(accountId, item.priceSoft);
    if (!spent) {
      res.status(402).json({ error: "insufficient funds" });
      return;
    }
    await grantFlare(accountId, flare);
    res.status(200).json({ ok: true });
  });

  // ---- Clans ----
  // publicId (sent by the client as targetPublicId in mutation bodies) IS
  // the account id (accountToUserMe: player.publicId = account.id) -- no
  // separate lookup needed to resolve a target to an accountId.

  function toClanInfo(clan: {
    tag: string;
    name: string;
    description: string;
    discord_url: string | null;
    is_open: boolean;
    created_at: Date;
    member_count: string;
  }) {
    return {
      tag: clan.tag,
      name: clan.name,
      description: clan.description,
      discordUrl: clan.discord_url,
      isOpen: clan.is_open,
      createdAt: clan.created_at.toISOString(),
      memberCount: Number(clan.member_count),
    };
  }

  const EMPTY_WL = { wins: 0, losses: 0 };
  function toClanMemberStats(stats: Record<string, ClanMemberWL> | undefined) {
    const keys = [
      "total", "ffa", "team", "hvn", "duos", "trios", "quads",
      "2", "3", "4", "5", "6", "7", "ranked", "1v1",
    ] as const;
    const out: Record<string, ClanMemberWL> = {};
    for (const k of keys) out[k] = stats?.[k] ?? EMPTY_WL;
    return out;
  }

  // Officers can act on plain members; leaders can act on anyone but
  // themselves (self-actions go through dedicated endpoints -- leave,
  // transfer -- not kick/ban).
  function canModerate(actorRole: string, targetRole: string | null): boolean {
    if (actorRole === "leader") return targetRole !== "leader";
    if (actorRole === "officer") return targetRole === "member" || targetRole === null;
    return false;
  }

  app.get("/public/clans/leaderboard", async (req, res) => {
    const board = await fetchClanLeaderboard();
    res.json({
      start: board.start.toISOString(),
      end: board.end.toISOString(),
      clans: board.clans.map((c) => ({
        clanTag: c.clan_tag,
        games: c.games,
        wins: c.wins,
        losses: c.losses,
        playerSessions: c.player_sessions,
        // ponytail: weight = 1 -- see fetchClanLeaderboard's doc comment.
        weightedWins: c.wins,
        weightedLosses: c.losses,
        weightedWLRatio: c.wins + c.losses > 0 ? c.wins / (c.wins + c.losses) : 0,
      })),
    });
  });

  app.get("/public/clan/:tag/exists", async (req, res) => {
    const tag = normalizeClanTag(req.params.tag);
    if (!tag) {
      res.status(404).end();
      return;
    }
    const exists = await clanExists(tag);
    res.status(exists ? 200 : 404).end();
  });

  app.get("/reserved_clan_tags", async (_req, res) => {
    res.json(await getAllClanTags());
  });

  const CLAN_CREATE_COST = 1500;

  app.post("/clans", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const CreateClanSchema = z.object({
      tag: z.string(),
      name: z.string().trim().min(1).max(35),
      description: z.string().trim().max(200).optional(),
      isOpen: z.boolean().optional(),
    });
    const parsed = CreateClanSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid request" });
      return;
    }
    const tag = normalizeClanTag(parsed.data.tag);
    if (!tag) {
      res.status(400).json({ error: "invalid_tag" });
      return;
    }
    const result = await createClan(
      accountId,
      tag,
      parsed.data.name,
      parsed.data.description ?? "",
      parsed.data.isOpen ?? true,
    );
    if (!result.ok) {
      res
        .status(result.error === "tag_taken" ? 409 : 402)
        .json({ error: result.error, cost: CLAN_CREATE_COST });
      return;
    }
    res.status(201).json(toClanInfo(result.clan));
  });

  app.get("/clans", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const search =
      typeof req.query.search === "string" && req.query.search.length >= 2
        ? req.query.search
        : undefined;
    const { results, total } = await browseClans(search, page, limit);
    res.json({
      results: results.map(toClanInfo),
      total,
      page,
      limit,
    });
  });

  app.get("/clans/:tag", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const tag = normalizeClanTag(req.params.tag);
    const clan = tag ? await getClan(tag) : null;
    if (!clan) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(toClanInfo(clan));
  });

  app.get("/clans/:tag/members", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const tag = normalizeClanTag(req.params.tag);
    if (!tag || !(await getClan(tag))) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const sort = typeof req.query.sort === "string" ? req.query.sort : "default";
    const order = req.query.order === "asc" ? "asc" : undefined;
    const { results, total } = await fetchClanMembers(tag, page, limit, sort, order);
    const statsMap = await computeMemberStats(results.map((m) => m.account_id));
    res.json({
      results: results.map((m) => ({
        role: m.role,
        joinedAt: m.joined_at.toISOString(),
        publicId: m.account_id,
        username: m.username_base,
        stats: toClanMemberStats(statsMap.get(m.account_id)),
      })),
      total,
      page,
      limit,
    });
  });

  app.post("/clans/:tag/join", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const tag = normalizeClanTag(req.params.tag);
    if (!tag) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const result = await joinClan(tag, accountId);
    if (result.status === "not_found") {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (result.status === "banned") {
      res.status(403).json({ code: "BANNED", reason: result.reason });
      return;
    }
    if (result.status === "already_member") {
      res.status(409).json({ message: "already a member" });
      return;
    }
    if (result.status === "already_requested") {
      res.status(409).json({ message: "request already pending" });
      return;
    }
    res.status(200).json({ status: result.status });
  });

  app.post("/clans/:tag/leave", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const tag = normalizeClanTag(req.params.tag);
    if (!tag) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const result = await leaveClan(tag, accountId);
    if (result === "is_leader") {
      res.status(400).json({ error: "leader_must_transfer" });
      return;
    }
    if (!result) {
      res.status(404).json({ error: "not a member" });
      return;
    }
    res.status(200).json({ ok: true });
  });

  app.patch("/clans/:tag", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const tag = normalizeClanTag(req.params.tag);
    const role = tag ? await getMembership(tag, accountId) : null;
    if (!tag || !role) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (role !== "leader" && role !== "officer") {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const PatchClanSchema = z.object({
      name: z.string().trim().min(1).max(35).optional(),
      description: z.string().trim().max(200).optional(),
      discordUrl: z.string().trim().max(255).nullable().optional(),
      isOpen: z.boolean().optional(),
    });
    const parsed = PatchClanSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid request" });
      return;
    }
    // discordUrl edit is leader-only (ClanManageView.ts only renders the
    // input for leaders; enforced here too, not just hidden client-side).
    if (parsed.data.discordUrl !== undefined && role !== "leader") {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const clan = await updateClan(tag, parsed.data);
    if (!clan) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(toClanInfo(clan));
  });

  app.delete("/clans/:tag", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const tag = normalizeClanTag(req.params.tag);
    const role = tag ? await getMembership(tag, accountId) : null;
    if (!tag || !role) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (role !== "leader") {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    await disbandClan(tag);
    res.status(200).json({ ok: true });
  });

  const TargetPublicIdSchema = z.object({ targetPublicId: z.string() });

  app.post("/clans/:tag/kick", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const tag = normalizeClanTag(req.params.tag);
    const parsed = TargetPublicIdSchema.safeParse(req.body);
    const role = tag ? await getMembership(tag, accountId) : null;
    if (!tag || !role || !parsed.success) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const targetRole = await getMembership(tag, parsed.data.targetPublicId);
    if (!canModerate(role, targetRole)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    await removeMember(tag, parsed.data.targetPublicId);
    res.status(200).json({ ok: true });
  });

  app.post("/clans/:tag/promote", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const tag = normalizeClanTag(req.params.tag);
    const parsed = TargetPublicIdSchema.safeParse(req.body);
    const role = tag ? await getMembership(tag, accountId) : null;
    if (!tag || !parsed.success) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (role !== "leader") {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const targetRole = await getMembership(tag, parsed.data.targetPublicId);
    if (targetRole !== "member") {
      res.status(400).json({ error: "not a member" });
      return;
    }
    await setMemberRole(tag, parsed.data.targetPublicId, "officer");
    res.status(200).json({ ok: true });
  });

  app.post("/clans/:tag/demote", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const tag = normalizeClanTag(req.params.tag);
    const parsed = TargetPublicIdSchema.safeParse(req.body);
    const role = tag ? await getMembership(tag, accountId) : null;
    if (!tag || !parsed.success) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (role !== "leader") {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const targetRole = await getMembership(tag, parsed.data.targetPublicId);
    if (targetRole !== "officer") {
      res.status(400).json({ error: "not an officer" });
      return;
    }
    await setMemberRole(tag, parsed.data.targetPublicId, "member");
    res.status(200).json({ ok: true });
  });

  app.post("/clans/:tag/transfer", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const tag = normalizeClanTag(req.params.tag);
    const parsed = TargetPublicIdSchema.safeParse(req.body);
    const role = tag ? await getMembership(tag, accountId) : null;
    if (!tag || !parsed.success) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (role !== "leader") {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const targetRole = await getMembership(tag, parsed.data.targetPublicId);
    if (!targetRole) {
      res.status(400).json({ error: "not a member" });
      return;
    }
    await transferLeadership(tag, accountId, parsed.data.targetPublicId);
    res.status(200).json({ ok: true });
  });

  app.get("/clans/:tag/requests", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const tag = normalizeClanTag(req.params.tag);
    const role = tag ? await getMembership(tag, accountId) : null;
    if (!tag || !role) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (role !== "leader" && role !== "officer") {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const { results, total } = await fetchClanRequests(tag, page, limit);
    res.json({
      results: results.map((r) => ({
        publicId: r.account_id,
        username: r.username_base,
        createdAt: r.created_at.toISOString(),
      })),
      total,
      page,
      limit,
    });
  });

  app.post("/clans/:tag/requests/approve", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const tag = normalizeClanTag(req.params.tag);
    const parsed = TargetPublicIdSchema.safeParse(req.body);
    const role = tag ? await getMembership(tag, accountId) : null;
    if (!tag || !parsed.success) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (role !== "leader" && role !== "officer") {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const ok = await approveClanRequest(tag, parsed.data.targetPublicId);
    if (!ok) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.status(200).json({ ok: true });
  });

  app.post("/clans/:tag/requests/deny", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const tag = normalizeClanTag(req.params.tag);
    const parsed = TargetPublicIdSchema.safeParse(req.body);
    const role = tag ? await getMembership(tag, accountId) : null;
    if (!tag || !parsed.success) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (role !== "leader" && role !== "officer") {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const ok = await denyClanRequest(tag, parsed.data.targetPublicId);
    if (!ok) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.status(200).json({ ok: true });
  });

  app.post("/clans/:tag/requests/withdraw", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const tag = normalizeClanTag(req.params.tag);
    if (!tag) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const ok = await withdrawClanRequest(tag, accountId);
    if (!ok) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.status(200).json({ ok: true });
  });

  app.post("/clans/:tag/ban", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const tag = normalizeClanTag(req.params.tag);
    const BanSchema = z.object({
      targetPublicId: z.string(),
      reason: z.string().trim().max(200).optional(),
    });
    const parsed = BanSchema.safeParse(req.body);
    const role = tag ? await getMembership(tag, accountId) : null;
    if (!tag || !parsed.success) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (role !== "leader" && role !== "officer") {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const targetRole = await getMembership(tag, parsed.data.targetPublicId);
    if (targetRole && !canModerate(role, targetRole)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    await banClanMember(
      tag,
      parsed.data.targetPublicId,
      accountId,
      parsed.data.reason ?? null,
    );
    res.status(200).json({ ok: true });
  });

  app.post("/clans/:tag/unban", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const tag = normalizeClanTag(req.params.tag);
    const parsed = TargetPublicIdSchema.safeParse(req.body);
    const role = tag ? await getMembership(tag, accountId) : null;
    if (!tag || !parsed.success) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (role !== "leader" && role !== "officer") {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const ok = await unbanClanMember(tag, parsed.data.targetPublicId);
    if (!ok) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.status(200).json({ ok: true });
  });

  app.get("/clans/:tag/bans", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const tag = normalizeClanTag(req.params.tag);
    const role = tag ? await getMembership(tag, accountId) : null;
    if (!tag || !role) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (role !== "leader" && role !== "officer") {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const { results, total } = await fetchClanBans(tag, page, limit);
    res.json({
      results: results.map((b) => ({
        publicId: b.account_id,
        username: b.username_base,
        bannedBy: b.banned_by_account_id,
        bannedByUsername: b.banned_by_username_base,
        reason: b.reason,
        createdAt: b.created_at.toISOString(),
      })),
      total,
      page,
      limit,
    });
  });

  app.get("/clans/:tag/games", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const tag = normalizeClanTag(req.params.tag);
    const role = tag ? await getMembership(tag, accountId) : null;
    if (!tag || !(await getClan(tag))) {
      res.status(404).json({ error: "not found" });
      return;
    }
    // Members-only -- matches the client's distinct 403 handling for this
    // endpoint (see fetchClanGames's status-code doc comment).
    if (!role) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const filterParsed = z
      .enum(["ffa", "team", "hvn", "ranked"])
      .optional()
      .safeParse(req.query.filter);
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
    const { results, nextCursor } = await fetchClanGames(
      tag,
      filterParsed.success ? filterParsed.data : undefined,
      cursor,
    );
    res.json({
      results: results.map((g) => ({
        gameId: g.game_id,
        start: g.ended_at.toISOString(),
        durationSeconds: g.duration,
        map: g.game_map ?? undefined,
        mode: g.game_mode,
        playerTeams: g.player_teams,
        rankedType: g.ranked_type ?? undefined,
        totalPlayers: g.num_players,
        clanPlayers: g.players.map((p) => ({
          publicId: p.account_id,
          username: p.username,
          verified: true,
          won: p.won,
        })),
      })),
      nextCursor,
    });
  });

  // ---- Player profile stats/history ----
  // GameType/GameMode keys ("Public"/"Private"/"Singleplayer",
  // "Free For All"/"Team") are literal string keys the client's
  // PlayerStatsTreeSchema/GameModeStatsSchema expect to match
  // GameType/GameMode enum values exactly -- see core/game/Game.ts.
  // "Humans Vs Nations" is bucketed as its own top-level mode (not nested
  // under "Team"), matching PlayerStatsGameModes in ApiSchemas.ts.
  // A row's (typeKey, modeKey, diffKey) bucket, shared by win/loss rows
  // (PlayerStatsRow) and raw conquest-stats rows (PlayerStatsBlobRow) so a
  // leaf's wins/losses and its summed `stats` land in the same place.
  function bucketKey(r: {
    game_type: string;
    game_mode: string;
    player_teams: string | null;
    difficulty: string | null;
  }): [type: string, mode: string, diff: string] {
    const modeKey =
      r.player_teams === "Humans Vs Nations" ? "Humans Vs Nations" : r.game_mode;
    return [r.game_type, modeKey, r.difficulty ?? "Medium"];
  }

  // Element-wise sum of two BigIntString arrays (different-length arrays are
  // zero-padded to the longer one -- e.g. one game logged 4 gold sources,
  // another logged 6 after a schema addition).
  function sumNumArrays(a: string[] | undefined, b: string[] | undefined): string[] {
    const len = Math.max(a?.length ?? 0, b?.length ?? 0);
    const out: string[] = [];
    for (let i = 0; i < len; i++) {
      out.push((BigInt(a?.[i] ?? "0") + BigInt(b?.[i] ?? "0")).toString());
    }
    return out;
  }

  function sumRecordArrays(
    a: Record<string, string[]> | undefined,
    b: Record<string, string[]> | undefined,
  ): Record<string, string[]> {
    const out: Record<string, string[]> = { ...a };
    for (const [k, v] of Object.entries(b ?? {})) {
      out[k] = sumNumArrays(out[k], v);
    }
    return out;
  }

  // Sums the subset of ArchivedPlayerStatsSchema (core/StatsSchemas.ts) that
  // the client's stats UI actually displays -- attacks/gold/conquests
  // (fixed-index arrays) and boats/bombs/units (per-unit-type arrays).
  // Skips fields that aren't meaningful summed across games (killedBy/
  // killedAt/deathPosition/finalTiles/kills -- all describe a single game's
  // ending, not an aggregate).
  function sumPlayerStats(blobs: unknown[]): Record<string, unknown> {
    let attacks: string[] | undefined;
    let gold: string[] | undefined;
    let conquests: string[] | undefined;
    let betrayals = 0n;
    let boats: Record<string, string[]> = {};
    let bombs: Record<string, string[]> = {};
    let units: Record<string, string[]> = {};
    for (const raw of blobs) {
      const b = raw as {
        attacks?: string[];
        gold?: string[];
        conquests?: string[];
        betrayals?: string;
        boats?: Record<string, string[]>;
        bombs?: Record<string, string[]>;
        units?: Record<string, string[]>;
      };
      attacks = sumNumArrays(attacks, b.attacks);
      gold = sumNumArrays(gold, b.gold);
      conquests = sumNumArrays(conquests, b.conquests);
      betrayals += BigInt(b.betrayals ?? "0");
      boats = sumRecordArrays(boats, b.boats);
      bombs = sumRecordArrays(bombs, b.bombs);
      units = sumRecordArrays(units, b.units);
    }
    const out: Record<string, unknown> = {};
    if (attacks) out.attacks = attacks;
    if (gold) out.gold = gold;
    if (conquests) out.conquests = conquests;
    if (betrayals > 0n) out.betrayals = betrayals.toString();
    if (Object.keys(boats).length) out.boats = boats;
    if (Object.keys(bombs).length) out.bombs = bombs;
    if (Object.keys(units).length) out.units = units;
    return out;
  }

  function buildStatsTree(rows: PlayerStatsRow[], blobRows: PlayerStatsBlobRow[]) {
    const tree: Record<string, Record<string, Record<string, unknown>>> = {};
    const ranked: Record<string, unknown> = {};
    const blobsByKey = new Map<string, unknown[]>();
    const rankedBlobsByType = new Map<string, unknown[]>();
    for (const r of blobRows) {
      const key = bucketKey(r).join("|");
      const list = blobsByKey.get(key) ?? [];
      list.push(r.stats);
      blobsByKey.set(key, list);
      if (r.ranked_type) {
        const rlist = rankedBlobsByType.get(r.ranked_type) ?? [];
        rlist.push(r.stats);
        rankedBlobsByType.set(r.ranked_type, rlist);
      }
    }
    for (const r of rows) {
      const wins = r.wins;
      const losses = r.losses;
      const total = String(Number(r.wins) + Number(r.losses));
      const [typeKey, modeKey, diffKey] = bucketKey(r);
      const key = [typeKey, modeKey, diffKey].join("|");
      const leaf = {
        wins,
        losses,
        total,
        stats: sumPlayerStats(blobsByKey.get(key) ?? []),
      };
      if (!tree[typeKey]) tree[typeKey] = {};
      // Multiple raw rows (e.g. different player_teams values that all fall
      // under generic "Team") can collapse onto the same tree leaf -- merge
      // rather than overwrite.
      if (!tree[typeKey][modeKey]) tree[typeKey][modeKey] = {};
      const existing = tree[typeKey][modeKey][diffKey] as
        | { wins: string; losses: string; total: string }
        | undefined;
      tree[typeKey][modeKey][diffKey] = existing
        ? {
            wins: String(Number(existing.wins) + Number(wins)),
            losses: String(Number(existing.losses) + Number(losses)),
            total: String(Number(existing.total) + Number(total)),
            stats: leaf.stats,
          }
        : leaf;
      if (r.ranked_type) {
        const existingRanked = ranked[r.ranked_type] as
          | { wins: string; losses: string; total: string }
          | undefined;
        const rankedLeaf = {
          wins,
          losses,
          total,
          stats: sumPlayerStats(rankedBlobsByType.get(r.ranked_type) ?? []),
        };
        ranked[r.ranked_type] = existingRanked
          ? {
              wins: String(Number(existingRanked.wins) + Number(wins)),
              losses: String(Number(existingRanked.losses) + Number(losses)),
              total: String(Number(existingRanked.total) + Number(total)),
              stats: rankedLeaf.stats,
            }
          : rankedLeaf;
      }
    }
    return { ...tree, Ranked: ranked };
  }

  async function buildPlayerProfile(accountId: string) {
    const account = await findAccountById(accountId);
    if (!account) return null;
    const [statsRows, statsBlobRows, clanRows] = await Promise.all([
      getPlayerStatsRows(accountId),
      getPlayerStatsBlobs(accountId),
      getAccountClans(accountId),
    ]);
    return {
      createdAt: account.created_at.toISOString(),
      username: account.username_base,
      stats: buildStatsTree(statsRows, statsBlobRows),
      clans: clanRows.map((c) => ({
        tag: c.tag,
        name: c.name,
        role: c.role,
        joinedAt: c.joined_at.toISOString(),
        memberCount: Number(c.member_count),
      })),
    };
  }

  app.get("/player/:publicId", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const profile = await buildPlayerProfile(req.params.publicId);
    if (!profile) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(profile);
  });

  app.get("/public/player/:publicId", async (req, res) => {
    const profile = await buildPlayerProfile(req.params.publicId);
    if (!profile) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(profile);
  });

  app.get("/public/player/:publicId/games", async (req, res) => {
    const modeParsed = z
      .enum(["ffa", "team", "hvn", "ranked"])
      .optional()
      .safeParse(req.query.filter);
    const typeParsed = z
      .enum(["public", "private", "singleplayer"])
      .optional()
      .safeParse(req.query.type);
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
    const { results, nextCursor } = await getPublicPlayerGames(
      req.params.publicId,
      modeParsed.success ? modeParsed.data : undefined,
      typeParsed.success ? typeParsed.data : undefined,
      cursor,
    );
    res.json({
      results: results.map((g) => ({
        gameId: g.game_id,
        start: g.ended_at.toISOString(),
        durationSeconds: g.duration,
        map: g.game_map ?? "",
        mode: g.game_mode,
        type: g.game_type,
        playerTeams: g.player_teams,
        // "unranked" sentinel, not null -- matches formatGameType()'s check
        // in GameTypeLabels.ts (`rankedType && rankedType !== "unranked"`).
        rankedType: g.ranked_type ?? "unranked",
        result: g.won ? "victory" : "defeat",
        totalPlayers: g.num_players,
        username: g.username ?? "",
        // Historical per-game clan tag isn't tracked (game_players has no
        // clan_tag column) -- always null until that's added.
        clanTag: null,
      })),
      nextCursor,
    });
  });

  app.put("/users/@me/username", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const parsed = UsernameBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid username" });
      return;
    }
    try {
      await pool.query(
        "UPDATE accounts SET username_base = $1, username_status = 'premium' WHERE id = $2",
        [parsed.data.username, accountId],
      );
    } catch (e: any) {
      if (e.code === "23505") {
        res.status(409).json({ error: "username taken" });
        return;
      }
      throw e;
    }
    res.json({
      username: parsed.data.username,
      base: parsed.data.username,
      discriminator: "",
      usernameStatus: "premium",
      nextUsernameChangeAt: null,
    });
  });

  // --- Friends ---
  function friendEntry(account: Account, createdAt: Date) {
    return {
      publicId: account.id,
      username: account.username_base,
      createdAt: createdAt.toISOString(),
    };
  }

  app.get("/friends/requests", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const incoming = await pool.query<{ created_at: Date } & Account>(
      `SELECT a.*, r.created_at FROM friend_requests r
       JOIN accounts a ON a.id = r.requester_id
       WHERE r.recipient_id = $1 ORDER BY r.created_at DESC`,
      [accountId],
    );
    const outgoing = await pool.query<{ created_at: Date } & Account>(
      `SELECT a.*, r.created_at FROM friend_requests r
       JOIN accounts a ON a.id = r.recipient_id
       WHERE r.requester_id = $1 ORDER BY r.created_at DESC`,
      [accountId],
    );
    res.json({
      incoming: incoming.rows.map((r) => friendEntry(r, r.created_at)),
      outgoing: outgoing.rows.map((r) => friendEntry(r, r.created_at)),
    });
  });

  app.get("/friends", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20),
    );
    const total = await pool.query<{ count: string }>(
      "SELECT count(*) FROM friendships WHERE account_a = $1 OR account_b = $1",
      [accountId],
    );
    const rows = await pool.query<{ created_at: Date } & Account>(
      `SELECT a.*, f.created_at FROM friendships f
       JOIN accounts a ON a.id = (CASE WHEN f.account_a = $1 THEN f.account_b ELSE f.account_a END)
       WHERE f.account_a = $1 OR f.account_b = $1
       ORDER BY f.created_at DESC
       LIMIT $2 OFFSET $3`,
      [accountId, limit, (page - 1) * limit],
    );
    res.json({
      results: rows.rows.map((r) => friendEntry(r, r.created_at)),
      total: parseInt(total.rows[0].count, 10),
      page,
      limit,
    });
  });

  app.post("/friends/requests/:publicId", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const targetId = req.params.publicId;
    if (targetId === accountId) {
      res.status(400).json({ error: "cannot friend self" });
      return;
    }
    const target = await findAccountById(targetId);
    if (!target) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const [lo, hi] = accountId < targetId ? [accountId, targetId] : [targetId, accountId];
    const already = await pool.query(
      "SELECT 1 FROM friendships WHERE account_a = $1 AND account_b = $2",
      [lo, hi],
    );
    if ((already.rowCount ?? 0) > 0) {
      res.status(409).json({ error: "already friends" });
      return;
    }
    // Reverse request already pending -- auto-accept instead of a second
    // pending row (matches the client's "request_auto_accepted" toast).
    const reverse = await pool.query(
      "DELETE FROM friend_requests WHERE requester_id = $1 AND recipient_id = $2",
      [targetId, accountId],
    );
    if ((reverse.rowCount ?? 0) > 0) {
      await pool.query(
        "INSERT INTO friendships (account_a, account_b) VALUES ($1, $2)",
        [lo, hi],
      );
      res.json({ status: "accepted" });
      return;
    }
    try {
      await pool.query(
        "INSERT INTO friend_requests (requester_id, recipient_id) VALUES ($1, $2)",
        [accountId, targetId],
      );
    } catch (e: any) {
      if (e.code === "23505") {
        res.status(409).json({ error: "already requested" });
        return;
      }
      throw e;
    }
    res.json({ status: "requested" });
  });

  app.post("/friends/requests/:publicId/accept", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const requesterId = req.params.publicId;
    const deleted = await pool.query(
      "DELETE FROM friend_requests WHERE requester_id = $1 AND recipient_id = $2",
      [requesterId, accountId],
    );
    if ((deleted.rowCount ?? 0) === 0) {
      res.status(404).json({ error: "no such request" });
      return;
    }
    const [lo, hi] =
      accountId < requesterId ? [accountId, requesterId] : [requesterId, accountId];
    await pool.query(
      "INSERT INTO friendships (account_a, account_b) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [lo, hi],
    );
    res.json({ ok: true });
  });

  app.delete("/friends/requests/:publicId", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const otherId = req.params.publicId;
    const deleted = await pool.query(
      `DELETE FROM friend_requests
       WHERE (requester_id = $1 AND recipient_id = $2)
          OR (requester_id = $2 AND recipient_id = $1)`,
      [accountId, otherId],
    );
    if ((deleted.rowCount ?? 0) === 0) {
      res.status(404).json({ error: "no such request" });
      return;
    }
    res.json({ ok: true });
  });

  app.delete("/friends/:publicId", async (req, res) => {
    const accountId = requireBearerAccountId(req);
    if (!accountId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const otherId = req.params.publicId;
    const [lo, hi] =
      accountId < otherId ? [accountId, otherId] : [otherId, accountId];
    const deleted = await pool.query(
      "DELETE FROM friendships WHERE account_a = $1 AND account_b = $2",
      [lo, hi],
    );
    if ((deleted.rowCount ?? 0) === 0) {
      res.status(404).json({ error: "not friends" });
      return;
    }
    res.json({ ok: true });
  });

  // --- Game record ingestion (archive() in the game server posts every
  // completed game here automatically -- singleplayer/public/private/
  // ranked alike. This is the sole data source for match history,
  // singleplayer achievements, and the ranked ladder below.) ---
  function expectedScore(a: number, b: number): number {
    return 1 / (1 + Math.pow(10, (b - a) / 400));
  }

  async function eloFor(accountId: string, rankedType: string): Promise<number> {
    const { rows } = await pool.query<{ elo: number }>(
      "SELECT elo FROM ranked_stats WHERE account_id = $1 AND ranked_type = $2",
      [accountId, rankedType],
    );
    return rows[0]?.elo ?? RANKED_DEFAULT_ELO;
  }

  async function applyEloChange(
    accountId: string,
    rankedType: string,
    newElo: number,
    won: boolean,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO ranked_stats (account_id, ranked_type, elo, peak_elo, wins, losses)
       VALUES ($1, $2, $3, $3, $4, $5)
       ON CONFLICT (account_id, ranked_type) DO UPDATE SET
         elo = $3,
         peak_elo = GREATEST(ranked_stats.peak_elo, $3),
         wins = ranked_stats.wins + $4,
         losses = ranked_stats.losses + $5`,
      [accountId, rankedType, newElo, won ? 1 : 0, won ? 0 : 1],
    );
  }

  // Simplified team-average Elo: both sides' current ratings are averaged
  // (unlinked/guest participants price in at RANKED_DEFAULT_ELO for the
  // calculation only, never stored), one K-factor update is computed from
  // those two averages, and every account on a side gets the same delta.
  // Correct for 1v1; a reasonable approximation for 2v2.
  async function updateRankedElo(
    rankedType: "1v1" | "2v2",
    players: { clientID: string; persistentID: string | null }[],
    winningClientIds: Set<string>,
  ): Promise<void> {
    const winners = players.filter((p) => winningClientIds.has(p.clientID));
    const losers = players.filter((p) => !winningClientIds.has(p.clientID));

    const resolve = async (list: typeof players) => {
      const accounts = await Promise.all(
        list.map((p) => (p.persistentID ? findAccountById(p.persistentID) : null)),
      );
      return accounts.filter((a): a is Account => a !== null);
    };
    const [winnerAccounts, loserAccounts] = await Promise.all([
      resolve(winners),
      resolve(losers),
    ]);
    if (winnerAccounts.length === 0 && loserAccounts.length === 0) return;

    const [winnerElos, loserElos] = await Promise.all([
      Promise.all(winnerAccounts.map((a) => eloFor(a.id, rankedType))),
      Promise.all(loserAccounts.map((a) => eloFor(a.id, rankedType))),
    ]);
    const avg = (xs: number[]) =>
      xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : RANKED_DEFAULT_ELO;
    const avgWin = avg(winnerElos);
    const avgLose = avg(loserElos);

    const winDelta = RANKED_K_FACTOR * (1 - expectedScore(avgWin, avgLose));
    const loseDelta = RANKED_K_FACTOR * (0 - expectedScore(avgLose, avgWin));

    await Promise.all([
      ...winnerAccounts.map((a, i) =>
        applyEloChange(a.id, rankedType, winnerElos[i] + winDelta, true),
      ),
      ...loserAccounts.map((a, i) =>
        applyEloChange(a.id, rankedType, loserElos[i] + loseDelta, false),
      ),
    ]);
  }

  app.post("/game/:gameId", async (req, res) => {
    if (!API_KEY || req.headers["x-api-key"] !== API_KEY) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    try {
      const info = req.body?.info;
      const gameId = req.params.gameId;
      const config = info?.config ?? {};
      const players: {
        clientID: string;
        persistentID: string | null;
        // ArchivedPlayerStatsSchema (core/StatsSchemas.ts) -- already present
        // on every archived player record; stored verbatim in
        // game_player_stats for the profile stats aggregation. Untyped here
        // (not re-declaring the full schema) since this handler only passes
        // it through to storage, never reads individual fields.
        stats?: unknown;
      }[] = info?.players ?? [];
      const winner: [string, ...string[]] | undefined = info?.winner;
      const rankedType: "1v1" | "2v2" | undefined = config.rankedType;
      // Stringified for clan game-history/stat-bucket labelling (see
      // GameTypeLabels.ts's formatGameType()) -- config.playerTeams is
      // number|string on the wire (number for "N Teams", string for the
      // named presets like "Duos"/"Humans Vs Nations").
      const playerTeams: string | null =
        config.playerTeams === undefined || config.playerTeams === null
          ? null
          : String(config.playerTeams);

      await pool.query(
        `INSERT INTO games (game_id, game_type, game_mode, ranked_type, game_map, difficulty, duration, player_teams, num_players)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (game_id) DO NOTHING`,
        [
          gameId,
          config.gameType ?? "Public",
          config.gameMode ?? "Free For All",
          rankedType ?? null,
          config.gameMap ?? null,
          config.difficulty ?? null,
          info?.duration ?? 0,
          playerTeams,
          players.length || null,
        ],
      );

      const winningClientIds = new Set<string>(winner ? winner.slice(1) : []);
      // Free soft currency awarded to a winning account per game, spendable
      // in /shop/purchase. Tunable -- 25 buys a common (50) pattern every
      // other win.
      const SOFT_CURRENCY_PER_WIN = 25;
      for (const p of players) {
        let accountId: string | null = null;
        if (p.persistentID) {
          const acc = await findAccountById(p.persistentID);
          if (acc) accountId = acc.id;
        }
        const won = winningClientIds.has(p.clientID);
        const { rowCount } = await pool.query(
          `INSERT INTO game_players (game_id, client_id, account_id, username, won)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (game_id, client_id) DO NOTHING`,
          [gameId, p.clientID, accountId, (p as { username?: string }).username ?? null, won],
        );
        // rowCount === 0 means this exact (game_id, client_id) was already
        // ingested (a retried POST) -- skip the award so a retry can't
        // double-grant currency for the same win.
        if ((rowCount ?? 0) > 0 && accountId) {
          if (won) {
            await addSoftCurrency(accountId, SOFT_CURRENCY_PER_WIN);
          }
          // Daily-checkin streak advances on playing a game (any result),
          // not on visiting the checkin page or the homepage -- see
          // grantDailyCheckinIfEligible's doc comment. The checkin page
          // (CheckinModal.ts) only displays state and claims; it never
          // triggers a grant itself.
          await grantDailyCheckinIfEligible(accountId);
        }
        if ((rowCount ?? 0) > 0 && accountId && p.stats) {
          await saveGamePlayerStats(gameId, accountId, p.stats);
        }
      }

      if (rankedType === "1v1" || rankedType === "2v2") {
        await updateRankedElo(rankedType, players, winningClientIds);
      }

      res.status(200).json({ ok: true });
    } catch (e) {
      console.error("[auth] game ingest failed", e);
      res.status(500).json({ error: "ingest failed" });
    }
  });

  app.get("/leaderboard/ranked", async (req, res) => {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const limit = 20;

    async function ladder(rankedType: string) {
      const { rows } = await pool.query<{
        account_id: string;
        elo: number;
        peak_elo: number;
        wins: number;
        losses: number;
        username_base: string | null;
      }>(
        `SELECT rs.account_id, rs.elo, rs.peak_elo, rs.wins, rs.losses, a.username_base
         FROM ranked_stats rs
         JOIN accounts a ON a.id = rs.account_id
         WHERE rs.ranked_type = $1
         ORDER BY rs.elo DESC
         LIMIT $2 OFFSET $3`,
        [rankedType, limit, (page - 1) * limit],
      );
      return rows.map((r, i) => ({
        rank: (page - 1) * limit + i + 1,
        elo: r.elo,
        peakElo: r.peak_elo,
        wins: r.wins,
        losses: r.losses,
        total: r.wins + r.losses,
        public_id: r.account_id,
        accountUsername: r.username_base,
      }));
    }

    const [oneVone, twoVtwo] = await Promise.all([
      ladder("1v1"),
      ladder("2v2"),
    ]);
    res.json({ "1v1": oneVone, "2v2": twoVtwo });
  });

  // --- Ranked matchmaking ---
  // In-memory queue: fine for a single dev-box process. A real deployment
  // with multiple auth-service instances would need this in Postgres/Redis
  // instead so queued players aren't stranded on the wrong instance.
  type MatchmakingMode = "1v1" | "2v2";
  const MODE_PLAYER_COUNT: Record<MatchmakingMode, number> = {
    "1v1": 2,
    "2v2": 4,
  };
  interface QueuedPlayer {
    accountId: string;
    ws: WebSocket;
  }
  const queues: Record<MatchmakingMode, QueuedPlayer[]> = {
    "1v1": [],
    "2v2": [],
  };

  function isMatchmakingMode(v: unknown): v is MatchmakingMode {
    return v === "1v1" || v === "2v2";
  }

  function removeFromQueues(ws: WebSocket) {
    for (const mode of ["1v1", "2v2"] as const) {
      const i = queues[mode].findIndex((q) => q.ws === ws);
      if (i !== -1) queues[mode].splice(i, 1);
    }
  }

  // The client's matchmaking modal treats >15s of silence as a dead
  // connection and reconnects, so this must fire well under that.
  function broadcastQueueSizes() {
    for (const mode of ["1v1", "2v2"] as const) {
      const payload = JSON.stringify({
        type: "queue-size",
        count: queues[mode].length,
      });
      for (const q of queues[mode]) {
        if (q.ws.readyState === WebSocket.OPEN) q.ws.send(payload);
      }
    }
  }
  setInterval(broadcastQueueSizes, 3000);

  // Workers poll this every ~5-6s per (worker, mode) offering a candidate
  // gameId (Worker.ts's startMatchmakingLoop). If enough players are
  // already queued for that mode we hand them out immediately; otherwise
  // we just say "nothing yet" -- the worker's own retry loop picks newly
  // queued players up within a few seconds, so no long-polling is needed.
  app.post("/matchmaking/checkin", (req, res) => {
    if (!API_KEY || req.headers["x-api-key"] !== API_KEY) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const { gameId, mode } = req.body ?? {};
    if (!isMatchmakingMode(mode) || typeof gameId !== "string") {
      res.status(400).json({ error: "bad request" });
      return;
    }
    const need = MODE_PLAYER_COUNT[mode];
    if (queues[mode].length < need) {
      res.json({});
      return;
    }
    // Synchronous from the length check through the splice -- no await in
    // between -- so two near-simultaneous checkins for the same mode can't
    // both claim the same players.
    const matched = queues[mode].splice(0, need);
    const teams =
      mode === "2v2"
        ? [
            [matched[0].accountId, matched[1].accountId],
            [matched[2].accountId, matched[3].accountId],
          ]
        : [[matched[0].accountId], [matched[1].accountId]];
    const payload = JSON.stringify({ type: "match-assignment", gameId });
    for (const p of matched) {
      if (p.ws.readyState === WebSocket.OPEN) p.ws.send(payload);
      p.ws.close(1000, "matched");
    }
    res.json({
      assignment: { players: matched.map((p) => p.accountId), teams },
    });
  });

  const httpServer = app.listen(PORT, () => {
    console.log(`[auth] listening on :${PORT}, issuer=${ISSUER}, public=${PUBLIC_URL}`);
    if (!DISCORD_CLIENT_ID) console.warn("[auth] DISCORD_CLIENT_ID not set -- Discord login disabled");
    if (!GOOGLE_CLIENT_ID) console.warn("[auth] GOOGLE_CLIENT_ID not set -- Google login disabled");
  });

  const wss = new WebSocketServer({
    server: httpServer,
    path: "/matchmaking/join",
  });
  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "", "http://internal");
    const mode = url.searchParams.get("mode");
    if (!isMatchmakingMode(mode)) {
      ws.close(1008, "invalid_mode");
      return;
    }

    let joined = false;
    const joinTimeout = setTimeout(() => {
      if (!joined) ws.close(1008, "join_timeout");
    }, 10000);

    ws.on("message", (raw) => {
      if (joined) return;
      let msg: { type?: string; jwt?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.close(1008, "invalid_message");
        return;
      }
      if (msg?.type !== "join" || typeof msg.jwt !== "string") {
        ws.close(1008, "invalid_message");
        return;
      }
      const accountId = decodeAccountIdFromJwt(msg.jwt);
      if (!accountId) {
        ws.close(1008, "Invalid session");
        return;
      }
      joined = true;
      clearTimeout(joinTimeout);
      queues[mode].push({ accountId, ws });
      broadcastQueueSizes();
    });

    ws.on("close", () => {
      clearTimeout(joinTimeout);
      removeFromQueues(ws);
    });
  });
}

main().catch((e) => {
  console.error("[auth] fatal startup error", e);
  process.exit(1);
});
