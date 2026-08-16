import { randomUUID } from "crypto";
import { Pool } from "pg";
import { dailyCheckinAmountForStreak } from "../core/DailyCheckin";

export const pool = new Pool({
  connectionString:
    process.env.AUTH_DATABASE_URL ??
    "postgres://postgres:frontline_dev@127.0.0.1:5432/frontline",
});

export interface Account {
  id: string;
  discord_id: string | null;
  discord_username: string | null;
  discord_global_name: string | null;
  discord_avatar: string | null;
  google_email: string | null;
  username_base: string | null;
  // ponytail: no real payment/subscription gate exists yet, so claiming a
  // bare username directly sets "premium" -- upgrade path is to require a
  // real subscription check here once Stripe (or similar) exists.
  username_status: "unclaimed" | "claimed" | "premium" | "indefinite";
  created_at: Date;
  // Free currency, earned by winning games (see /game/:gameId in
  // AuthServer.ts) and spent in /shop/purchase. INTEGER (not BIGINT) so pg
  // returns it as a plain JS number -- BIGINT comes back as a string from
  // pg by default, and no account will realistically earn anywhere near
  // 2^31 from win-based grants.
  soft_currency: number;
  // Consecutive daily-check-in count (see grantDailyCheckinIfEligible) and
  // the UTC date it last advanced on. checkin_streak resets to 1 (not 0) on
  // the next check-in after a missed day -- 0 only means "never checked in".
  checkin_streak: number;
  last_checkin_date: string | null; // YYYY-MM-DD (pg date), null = never
}

export async function initSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id UUID PRIMARY KEY,
      discord_id TEXT UNIQUE,
      discord_username TEXT,
      discord_global_name TEXT,
      discord_avatar TEXT,
      google_email TEXT UNIQUE,
      username_base TEXT UNIQUE,
      username_status TEXT NOT NULL DEFAULT 'unclaimed',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      soft_currency INTEGER NOT NULL DEFAULT 0
    );
    -- CREATE TABLE IF NOT EXISTS is a no-op on an already-existing table
    -- (the common case once this account was created before this column
    -- existed), so the column also needs an explicit migration here.
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS soft_currency INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS checkin_streak INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_checkin_date DATE;
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      token_hash TEXT PRIMARY KEY,
      account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS friend_requests (
      requester_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      recipient_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (requester_id, recipient_id)
    );
    -- account_a < account_b always, so a pair is stored once regardless of
    -- who requested -- simplifies "are they friends" / listing to one row.
    CREATE TABLE IF NOT EXISTS friendships (
      account_a UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      account_b UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (account_a, account_b),
      CHECK (account_a < account_b)
    );
    -- One row per completed game (archive() posts here automatically at
    -- game end -- singleplayer, public, private, and ranked alike).
    CREATE TABLE IF NOT EXISTS games (
      game_id TEXT PRIMARY KEY,
      game_type TEXT NOT NULL,
      game_mode TEXT NOT NULL,
      ranked_type TEXT,
      game_map TEXT,
      difficulty TEXT,
      duration INT NOT NULL,
      ended_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- Team-size bucket for clan game-history/stats labelling (mirrors
      -- src/client/components/baseComponents/stats/GameTypeLabels.ts's
      -- isFfa()/formatGameType() bucketing exactly): raw config.playerTeams
      -- value stringified (e.g. "Duos"/"Humans Vs Nations"/"5"), null for
      -- FFA/non-team games.
      player_teams TEXT,
      num_players INT
    );
    ALTER TABLE games ADD COLUMN IF NOT EXISTS player_teams TEXT;
    ALTER TABLE games ADD COLUMN IF NOT EXISTS num_players INT;
    CREATE TABLE IF NOT EXISTS game_players (
      game_id TEXT NOT NULL REFERENCES games(game_id) ON DELETE CASCADE,
      client_id TEXT NOT NULL,
      account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
      username TEXT,
      won BOOLEAN NOT NULL,
      PRIMARY KEY (game_id, client_id)
    );
    CREATE INDEX IF NOT EXISTS game_players_account_idx ON game_players (account_id);
    -- ponytail: simplified team-average Elo (real accounts only; guest
    -- opponents are priced at DEFAULT_ELO for the calculation but never
    -- stored). Upgrade path if this matters: per-player K-factor decay,
    -- placement-match variance, proper multi-team support beyond 2 sides.
    CREATE TABLE IF NOT EXISTS ranked_stats (
      account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      ranked_type TEXT NOT NULL,
      elo DOUBLE PRECISION NOT NULL DEFAULT 1000,
      peak_elo DOUBLE PRECISION NOT NULL DEFAULT 1000,
      wins INT NOT NULL DEFAULT 0,
      losses INT NOT NULL DEFAULT 0,
      PRIMARY KEY (account_id, ranked_type)
    );
    -- Persists cosmetic ownership as flare strings (e.g. "pattern:diamonds"),
    -- matching the flare format cosmeticRelationship()/patternRelationship()
    -- already check client-side (src/client/Cosmetics.ts) -- granted by
    -- /shop/purchase, read back into accountToUserMe()'s player.flares.
    CREATE TABLE IF NOT EXISTS account_flares (
      account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      flare TEXT NOT NULL,
      granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (account_id, flare)
    );
    -- Unclaimed/claimed reward grants (matches RewardSchema in
    -- src/core/ApiSchemas.ts, id/amount round-trip as strings there since
    -- amount can in principle exceed Number.MAX_SAFE_INTEGER -- BIGINT here
    -- for the same reason, though every current grant fits an INTEGER).
    -- id is app-generated (randomUUID(), matching AuthServer.ts's existing
    -- pattern) rather than DB-generated -- no pgcrypto/uuid-ossp extension
    -- is set up for gen_random_uuid().
    CREATE TABLE IF NOT EXISTS rewards (
      id UUID PRIMARY KEY,
      account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      currency_type TEXT NOT NULL,
      amount BIGINT NOT NULL,
      reason TEXT NOT NULL,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      claimed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS rewards_unclaimed_idx
      ON rewards (account_id) WHERE claimed_at IS NULL;
    -- tag is always stored/looked-up uppercase (ClanTagSchema: 2-5
    -- alphanumeric, core/Schemas.ts) -- app code uppercases before every
    -- query, never enforced in SQL. leader_account_id is informational
    -- (also present as a 'leader'-role row in clan_members); ON DELETE
    -- RESTRICT so an account with a clan they lead can't vanish out from
    -- under it -- transfer or disband first.
    CREATE TABLE IF NOT EXISTS clans (
      tag TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      discord_url TEXT,
      is_open BOOLEAN NOT NULL DEFAULT true,
      leader_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- A player may belong to more than one clan (player.clans is an array
    -- client-side) -- no uniqueness on account_id alone.
    CREATE TABLE IF NOT EXISTS clan_members (
      clan_tag TEXT NOT NULL REFERENCES clans(tag) ON DELETE CASCADE,
      account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (clan_tag, account_id)
    );
    CREATE INDEX IF NOT EXISTS clan_members_account_idx ON clan_members (account_id);
    CREATE TABLE IF NOT EXISTS clan_join_requests (
      clan_tag TEXT NOT NULL REFERENCES clans(tag) ON DELETE CASCADE,
      account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (clan_tag, account_id)
    );
    CREATE INDEX IF NOT EXISTS clan_join_requests_account_idx ON clan_join_requests (account_id);
    CREATE TABLE IF NOT EXISTS clan_bans (
      clan_tag TEXT NOT NULL REFERENCES clans(tag) ON DELETE CASCADE,
      account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      banned_by_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (clan_tag, account_id)
    );
    -- Raw per-game conquest stats (ArchivedPlayerStatsSchema, core/StatsSchemas.ts
    -- -- tiles/gold/attacks/boats/bombs/buildings), verbatim from the game
    -- server's archive POST (/game/:gameId). Stored as-is (JSONB) rather than
    -- normalized into columns: the shape has per-unit-type partial records and
    -- fixed-index arrays that don't map cleanly to columns, and the only
    -- consumer (player-profile stats aggregation) needs the whole blob anyway.
    CREATE TABLE IF NOT EXISTS game_player_stats (
      game_id TEXT NOT NULL REFERENCES games(game_id) ON DELETE CASCADE,
      account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      stats JSONB NOT NULL,
      PRIMARY KEY (game_id, account_id)
    );
    CREATE INDEX IF NOT EXISTS game_player_stats_account_idx ON game_player_stats (account_id);
  `);
}

export async function getAccountFlares(accountId: string): Promise<string[]> {
  const { rows } = await pool.query<{ flare: string }>(
    "SELECT flare FROM account_flares WHERE account_id = $1",
    [accountId],
  );
  return rows.map((r) => r.flare);
}

export async function grantFlare(
  accountId: string,
  flare: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO account_flares (account_id, flare) VALUES ($1, $2)
     ON CONFLICT (account_id, flare) DO NOTHING`,
    [accountId, flare],
  );
}

export async function addSoftCurrency(
  accountId: string,
  amount: number,
): Promise<void> {
  await pool.query(
    "UPDATE accounts SET soft_currency = soft_currency + $2 WHERE id = $1",
    [accountId, amount],
  );
}

// Atomic conditional deduct -- returns false (no row updated, no changes
// made) if the balance is insufficient at the moment the query runs, so a
// double-click or two tabs can't both succeed against the same balance.
export async function trySpendSoftCurrency(
  accountId: string,
  amount: number,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    "UPDATE accounts SET soft_currency = soft_currency - $2 WHERE id = $1 AND soft_currency >= $2",
    [accountId, amount],
  );
  return (rowCount ?? 0) > 0;
}

export interface RewardRow {
  id: string;
  currency_type: string;
  amount: string; // BIGINT comes back as a string from pg
  reason: string;
  note: string | null;
}

// Grants today's daily-login reward (per DAILY_CHECKIN_SCHEDULE) if this
// account hasn't already gotten one today (compared in UTC, so the boundary
// doesn't drift with server TZ). The UPDATE's WHERE clause is the atomicity
// guard -- it only affects a row (and returns one) for whichever of two
// near-simultaneous /users/@me calls (e.g. two tabs) gets there first; the
// loser sees rowCount 0 and grants nothing. checkin_streak advances only when
// yesterday (UTC) was the last check-in; any gap (or first-ever check-in)
// resets it to 1.
export async function grantDailyCheckinIfEligible(
  accountId: string,
): Promise<void> {
  const { rows } = await pool.query<{ checkin_streak: number }>(
    `UPDATE accounts
     SET checkin_streak = CASE
           WHEN last_checkin_date = (now() AT TIME ZONE 'UTC')::date - 1
           THEN checkin_streak + 1
           ELSE 1
         END,
         last_checkin_date = (now() AT TIME ZONE 'UTC')::date
     WHERE id = $1
       AND (last_checkin_date IS NULL
            OR last_checkin_date < (now() AT TIME ZONE 'UTC')::date)
     RETURNING checkin_streak`,
    [accountId],
  );
  const streak = rows[0]?.checkin_streak;
  if (streak === undefined) return; // already checked in today
  await pool.query(
    `INSERT INTO rewards (id, account_id, currency_type, amount, reason, note)
     VALUES ($1, $2, 'soft', $3, 'daily_checkin', $4)`,
    [
      randomUUID(),
      accountId,
      dailyCheckinAmountForStreak(streak),
      String(streak),
    ],
  );
}

export async function getUnclaimedRewards(
  accountId: string,
): Promise<RewardRow[]> {
  const { rows } = await pool.query<RewardRow>(
    `SELECT id, currency_type, amount::text AS amount, reason, note
     FROM rewards WHERE account_id = $1 AND claimed_at IS NULL
     ORDER BY created_at`,
    [accountId],
  );
  return rows;
}

// Atomically claims one reward (only if it belongs to this account and isn't
// already claimed) and credits the balance. Returns the claimed row, or null
// if it didn't exist / wasn't this account's / was already claimed -- the
// caller treats all three as "not_found" (see claimReward()'s doc comment in
// Api.ts: indistinguishable by design).
export async function claimRewardRow(
  accountId: string,
  rewardId: string,
): Promise<RewardRow | null> {
  const { rows } = await pool.query<RewardRow>(
    `UPDATE rewards SET claimed_at = now()
     WHERE id = $1 AND account_id = $2 AND claimed_at IS NULL
     RETURNING id, currency_type, amount::text AS amount, reason, note`,
    [rewardId, accountId],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.currency_type === "soft") {
    await addSoftCurrency(accountId, Number(row.amount));
  }
  return row;
}

// Claims every unclaimed reward for this account in one round trip.
export async function claimAllRewardRows(
  accountId: string,
): Promise<RewardRow[]> {
  const { rows } = await pool.query<RewardRow>(
    `UPDATE rewards SET claimed_at = now()
     WHERE account_id = $1 AND claimed_at IS NULL
     RETURNING id, currency_type, amount::text AS amount, reason, note`,
    [accountId],
  );
  const softTotal = rows
    .filter((r) => r.currency_type === "soft")
    .reduce((sum, r) => sum + Number(r.amount), 0);
  if (softTotal > 0) {
    await addSoftCurrency(accountId, softTotal);
  }
  return rows;
}

// ---- Clans ----
// Tags are always normalized to uppercase before touching the DB (the
// client doesn't do this consistently everywhere -- see fetchClanDetail's
// doc note -- so the server is the single source of truth for casing).

export interface ClanRow {
  tag: string;
  name: string;
  description: string;
  discord_url: string | null;
  is_open: boolean;
  leader_account_id: string;
  created_at: Date;
  member_count: string; // COUNT(*) comes back as a string from pg
}

const CLAN_TAG_RE = /^[A-Z0-9]{2,5}$/;

export function normalizeClanTag(tag: string): string | null {
  const upper = tag.toUpperCase();
  return CLAN_TAG_RE.test(upper) ? upper : null;
}

export async function clanExists(tag: string): Promise<boolean> {
  const { rowCount } = await pool.query("SELECT 1 FROM clans WHERE tag = $1", [
    tag,
  ]);
  return (rowCount ?? 0) > 0;
}

export async function getAllClanTags(): Promise<string[]> {
  const { rows } = await pool.query<{ tag: string }>("SELECT tag FROM clans");
  return rows.map((r) => r.tag);
}

async function clanWithMemberCount(
  tag: string,
): Promise<ClanRow | null> {
  const { rows } = await pool.query<ClanRow>(
    `SELECT c.*, (SELECT COUNT(*) FROM clan_members m WHERE m.clan_tag = c.tag) AS member_count
     FROM clans c WHERE c.tag = $1`,
    [tag],
  );
  return rows[0] ?? null;
}

export async function getClan(tag: string): Promise<ClanRow | null> {
  return clanWithMemberCount(tag);
}

export async function browseClans(
  search: string | undefined,
  page: number,
  limit: number,
): Promise<{ results: ClanRow[]; total: number }> {
  const offset = (page - 1) * limit;
  const whereClause = search ? "WHERE c.tag ILIKE $1 OR c.name ILIKE $1" : "";
  const params: unknown[] = search ? [`%${search}%`] : [];
  const { rows } = await pool.query<ClanRow>(
    `SELECT c.*, (SELECT COUNT(*) FROM clan_members m WHERE m.clan_tag = c.tag) AS member_count
     FROM clans c ${whereClause}
     ORDER BY c.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) FROM clans c ${whereClause}`,
    params,
  );
  return { results: rows, total: Number(countRows[0]?.count ?? 0) };
}

export type ClanRole = "leader" | "officer" | "member";

export async function getMembership(
  tag: string,
  accountId: string,
): Promise<ClanRole | null> {
  const { rows } = await pool.query<{ role: ClanRole }>(
    "SELECT role FROM clan_members WHERE clan_tag = $1 AND account_id = $2",
    [tag, accountId],
  );
  return rows[0]?.role ?? null;
}

export async function isBanned(
  tag: string,
  accountId: string,
): Promise<boolean> {
  return (await getBan(tag, accountId)) !== null;
}

export async function getBan(
  tag: string,
  accountId: string,
): Promise<{ reason: string | null } | null> {
  const { rows } = await pool.query<{ reason: string | null }>(
    "SELECT reason FROM clan_bans WHERE clan_tag = $1 AND account_id = $2",
    [tag, accountId],
  );
  return rows[0] ?? null;
}

export interface AccountClanSummary {
  tag: string;
  name: string;
  role: ClanRole;
  joined_at: Date;
  member_count: string;
}

// Backs player.clans on /users/@me -- every clan this account is a member of.
export async function getAccountClans(
  accountId: string,
): Promise<AccountClanSummary[]> {
  const { rows } = await pool.query<AccountClanSummary>(
    `SELECT c.tag, c.name, m.role, m.joined_at,
            (SELECT COUNT(*) FROM clan_members m2 WHERE m2.clan_tag = c.tag) AS member_count
     FROM clan_members m JOIN clans c ON c.tag = m.clan_tag
     WHERE m.account_id = $1`,
    [accountId],
  );
  return rows;
}

// Backs player.clanRequests on /users/@me -- this account's own outstanding
// join requests against closed clans.
export async function getAccountClanRequests(
  accountId: string,
): Promise<{ tag: string; name: string; created_at: Date }[]> {
  const { rows } = await pool.query<{
    tag: string;
    name: string;
    created_at: Date;
  }>(
    `SELECT c.tag, c.name, r.created_at
     FROM clan_join_requests r JOIN clans c ON c.tag = r.clan_tag
     WHERE r.account_id = $1`,
    [accountId],
  );
  return rows;
}

const CLAN_CREATE_COST = 1500;

// Atomic: charges CLAN_CREATE_COST soft currency, creates the clan, and adds
// the creator as leader, all or nothing. Uses a dedicated transaction (unlike
// the rest of this file's single-statement queries) because a partial
// failure here would either charge currency for no clan or create a
// leaderless clan.
export async function createClan(
  accountId: string,
  tag: string,
  name: string,
  description: string,
  isOpen: boolean,
): Promise<
  | { ok: true; clan: ClanRow }
  | { ok: false; error: "tag_taken" | "insufficient_funds" }
> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query(
        "INSERT INTO clans (tag, name, description, is_open, leader_account_id) VALUES ($1, $2, $3, $4, $5)",
        [tag, name, description, isOpen, accountId],
      );
    } catch (e) {
      await client.query("ROLLBACK");
      if (e instanceof Error && "code" in e && e.code === "23505") {
        return { ok: false, error: "tag_taken" };
      }
      throw e;
    }
    const { rowCount } = await client.query(
      "UPDATE accounts SET soft_currency = soft_currency - $2 WHERE id = $1 AND soft_currency >= $2",
      [accountId, CLAN_CREATE_COST],
    );
    if ((rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return { ok: false, error: "insufficient_funds" };
    }
    await client.query(
      "INSERT INTO clan_members (clan_tag, account_id, role) VALUES ($1, $2, 'leader')",
      [tag, accountId],
    );
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  const clan = await clanWithMemberCount(tag);
  if (!clan) throw new Error("createClan: clan vanished after commit");
  return { ok: true, clan };
}

export type JoinClanOutcome =
  | { status: "joined" | "requested" | "already_member" | "already_requested" | "not_found" }
  | { status: "banned"; reason: string | null };

export async function joinClan(
  tag: string,
  accountId: string,
): Promise<JoinClanOutcome> {
  const clan = await getClan(tag);
  if (!clan) return { status: "not_found" };
  const ban = await getBan(tag, accountId);
  if (ban) return { status: "banned", reason: ban.reason };
  if (await getMembership(tag, accountId)) return { status: "already_member" };
  if (clan.is_open) {
    await pool.query(
      "INSERT INTO clan_members (clan_tag, account_id, role) VALUES ($1, $2, 'member')",
      [tag, accountId],
    );
    await pool.query(
      "DELETE FROM clan_join_requests WHERE clan_tag = $1 AND account_id = $2",
      [tag, accountId],
    );
    return { status: "joined" };
  }
  const { rowCount } = await pool.query(
    `INSERT INTO clan_join_requests (clan_tag, account_id) VALUES ($1, $2)
     ON CONFLICT (clan_tag, account_id) DO NOTHING`,
    [tag, accountId],
  );
  if ((rowCount ?? 0) === 0) return { status: "already_requested" };
  return { status: "requested" };
}

export async function leaveClan(
  tag: string,
  accountId: string,
): Promise<boolean | "is_leader"> {
  const role = await getMembership(tag, accountId);
  if (!role) return false;
  if (role === "leader") return "is_leader";
  await pool.query(
    "DELETE FROM clan_members WHERE clan_tag = $1 AND account_id = $2",
    [tag, accountId],
  );
  return true;
}

export async function updateClan(
  tag: string,
  patch: {
    name?: string;
    description?: string;
    discordUrl?: string | null;
    isOpen?: boolean;
  },
): Promise<ClanRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    params.push(patch.name);
    sets.push(`name = $${params.length}`);
  }
  if (patch.description !== undefined) {
    params.push(patch.description);
    sets.push(`description = $${params.length}`);
  }
  if (patch.discordUrl !== undefined) {
    params.push(patch.discordUrl);
    sets.push(`discord_url = $${params.length}`);
  }
  if (patch.isOpen !== undefined) {
    params.push(patch.isOpen);
    sets.push(`is_open = $${params.length}`);
  }
  if (sets.length === 0) return clanWithMemberCount(tag);
  params.push(tag);
  await pool.query(
    `UPDATE clans SET ${sets.join(", ")} WHERE tag = $${params.length}`,
    params,
  );
  return clanWithMemberCount(tag);
}

export async function disbandClan(tag: string): Promise<void> {
  // Cascades to clan_members/clan_join_requests/clan_bans via FK.
  await pool.query("DELETE FROM clans WHERE tag = $1", [tag]);
}

export async function setMemberRole(
  tag: string,
  accountId: string,
  role: ClanRole,
): Promise<void> {
  await pool.query(
    "UPDATE clan_members SET role = $3 WHERE clan_tag = $1 AND account_id = $2",
    [tag, accountId, role],
  );
}

export async function removeMember(
  tag: string,
  accountId: string,
): Promise<void> {
  await pool.query(
    "DELETE FROM clan_members WHERE clan_tag = $1 AND account_id = $2",
    [tag, accountId],
  );
}

// Swaps leadership: target becomes 'leader', the current leader becomes
// 'officer', and clans.leader_account_id is updated to match. Single
// transaction so the clan is never briefly leaderless or double-led.
export async function transferLeadership(
  tag: string,
  fromAccountId: string,
  toAccountId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE clan_members SET role = 'officer' WHERE clan_tag = $1 AND account_id = $2",
      [tag, fromAccountId],
    );
    await client.query(
      "UPDATE clan_members SET role = 'leader' WHERE clan_tag = $1 AND account_id = $2",
      [tag, toAccountId],
    );
    await client.query("UPDATE clans SET leader_account_id = $2 WHERE tag = $1", [
      tag,
      toAccountId,
    ]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Bucket definitions mirror
// src/client/components/baseComponents/stats/GameTypeLabels.ts's
// isFfa()/formatGameType() exactly, so a clan member's stat breakdown always
// agrees with how their own game-history list labels the same games.
const STAT_BUCKETS: readonly [key: string, condition: string][] = [
  ["total", "TRUE"],
  ["ffa", "g.game_mode = 'Free For All'"],
  ["hvn", "g.player_teams = 'Humans Vs Nations'"],
  ["duos", "g.player_teams = 'Duos'"],
  ["trios", "g.player_teams = 'Trios'"],
  ["quads", "g.player_teams = 'Quads'"],
  ["2", "g.player_teams = '2'"],
  ["3", "g.player_teams = '3'"],
  ["4", "g.player_teams = '4'"],
  ["5", "g.player_teams = '5'"],
  ["6", "g.player_teams = '6'"],
  ["7", "g.player_teams = '7'"],
  [
    "team",
    `g.game_mode = 'Team' AND (g.player_teams IS NULL OR g.player_teams NOT IN
      ('Humans Vs Nations','Duos','Trios','Quads','2','3','4','5','6','7'))`,
  ],
  ["ranked", "g.ranked_type IS NOT NULL"],
  ["1v1", "g.ranked_type = '1v1'"],
];

export interface ClanMemberWL {
  wins: number;
  losses: number;
}

// One row of wins/losses per STAT_BUCKETS entry, per account. Empty map
// entries (an account with zero games) are backfilled with zeros by the
// caller -- this only returns rows for accounts that have played at least
// one game.
export async function computeMemberStats(
  accountIds: string[],
): Promise<Map<string, Record<string, ClanMemberWL>>> {
  if (accountIds.length === 0) return new Map();
  const selects = STAT_BUCKETS.map(
    ([, cond], i) =>
      `COUNT(*) FILTER (WHERE gp.won AND ${cond}) AS w${i}, COUNT(*) FILTER (WHERE NOT gp.won AND ${cond}) AS l${i}`,
  ).join(", ");
  const { rows } = await pool.query<Record<string, string> & { account_id: string }>(
    `SELECT gp.account_id, ${selects}
     FROM game_players gp JOIN games g ON g.game_id = gp.game_id
     WHERE gp.account_id = ANY($1::uuid[])
     GROUP BY gp.account_id`,
    [accountIds],
  );
  const result = new Map<string, Record<string, ClanMemberWL>>();
  for (const row of rows) {
    const stats: Record<string, ClanMemberWL> = {};
    STAT_BUCKETS.forEach(([key], i) => {
      stats[key] = { wins: Number(row[`w${i}`]), losses: Number(row[`l${i}`]) };
    });
    result.set(row.account_id, stats);
  }
  return result;
}

export interface ClanMemberRow {
  account_id: string;
  role: ClanRole;
  joined_at: Date;
  username_base: string | null;
}

const MEMBER_SORT_COLUMNS: Record<string, string> = {
  winsTotal: "total_w",
  lossesTotal: "total_l",
  winsFfa: "ffa_w",
  lossesFfa: "ffa_l",
  winsTeam: "team_w",
  lossesTeam: "team_l",
  winsHvn: "hvn_w",
  lossesHvn: "hvn_l",
  winsRanked: "ranked_w",
  lossesRanked: "ranked_l",
  wins1v1: "v1v1_w",
  losses1v1: "v1v1_l",
};

export async function fetchClanMembers(
  tag: string,
  page: number,
  limit: number,
  sort: string,
  order: "asc" | "desc" | undefined,
): Promise<{ results: ClanMemberRow[]; total: number }> {
  const offset = (page - 1) * limit;
  // Sorting by a computed stat needs the same per-member aggregate the
  // stats endpoint computes, joined in rather than sorted in JS, so paging
  // stays correct. Default sort (joined_at) skips the join entirely.
  if (sort === "default" || !(sort in MEMBER_SORT_COLUMNS)) {
    const { rows } = await pool.query<ClanMemberRow>(
      `SELECT m.account_id, m.role, m.joined_at, a.username_base
       FROM clan_members m JOIN accounts a ON a.id = m.account_id
       WHERE m.clan_tag = $1
       ORDER BY m.joined_at ASC
       LIMIT $2 OFFSET $3`,
      [tag, limit, offset],
    );
    const { rows: countRows } = await pool.query<{ count: string }>(
      "SELECT COUNT(*) FROM clan_members WHERE clan_tag = $1",
      [tag],
    );
    return { results: rows, total: Number(countRows[0]?.count ?? 0) };
  }
  const col = MEMBER_SORT_COLUMNS[sort];
  const dir = order === "asc" ? "ASC" : "DESC";
  const selects = STAT_BUCKETS.map(
    ([, cond], i) =>
      `COUNT(*) FILTER (WHERE gp.won AND ${cond}) AS w${i}, COUNT(*) FILTER (WHERE NOT gp.won AND ${cond}) AS l${i}`,
  ).join(", ");
  // Aliases fed to MEMBER_SORT_COLUMNS below must match these -- total is
  // index 0, ffa 1, team 12, hvn 2, ranked 13, "1v1" 14 (see STAT_BUCKETS).
  const { rows } = await pool.query<ClanMemberRow>(
    `SELECT m.account_id, m.role, m.joined_at, a.username_base
     FROM clan_members m
     JOIN accounts a ON a.id = m.account_id
     LEFT JOIN (
       SELECT gp.account_id,
         COUNT(*) FILTER (WHERE gp.won) AS total_w, COUNT(*) FILTER (WHERE NOT gp.won) AS total_l,
         COUNT(*) FILTER (WHERE gp.won AND g.game_mode = 'Free For All') AS ffa_w,
         COUNT(*) FILTER (WHERE NOT gp.won AND g.game_mode = 'Free For All') AS ffa_l,
         COUNT(*) FILTER (WHERE gp.won AND g.game_mode = 'Team' AND (g.player_teams IS NULL OR g.player_teams NOT IN ('Humans Vs Nations','Duos','Trios','Quads','2','3','4','5','6','7'))) AS team_w,
         COUNT(*) FILTER (WHERE NOT gp.won AND g.game_mode = 'Team' AND (g.player_teams IS NULL OR g.player_teams NOT IN ('Humans Vs Nations','Duos','Trios','Quads','2','3','4','5','6','7'))) AS team_l,
         COUNT(*) FILTER (WHERE gp.won AND g.player_teams = 'Humans Vs Nations') AS hvn_w,
         COUNT(*) FILTER (WHERE NOT gp.won AND g.player_teams = 'Humans Vs Nations') AS hvn_l,
         COUNT(*) FILTER (WHERE gp.won AND g.ranked_type IS NOT NULL) AS ranked_w,
         COUNT(*) FILTER (WHERE NOT gp.won AND g.ranked_type IS NOT NULL) AS ranked_l,
         COUNT(*) FILTER (WHERE gp.won AND g.ranked_type = '1v1') AS v1v1_w,
         COUNT(*) FILTER (WHERE NOT gp.won AND g.ranked_type = '1v1') AS v1v1_l
       FROM game_players gp JOIN games g ON g.game_id = gp.game_id
       GROUP BY gp.account_id
     ) s ON s.account_id = m.account_id
     WHERE m.clan_tag = $1
     ORDER BY COALESCE(s.${col}, 0) ${dir}
     LIMIT $2 OFFSET $3`,
    [tag, limit, offset],
  );
  const { rows: countRows } = await pool.query<{ count: string }>(
    "SELECT COUNT(*) FROM clan_members WHERE clan_tag = $1",
    [tag],
  );
  return { results: rows, total: Number(countRows[0]?.count ?? 0) };
}

export async function fetchClanRequests(
  tag: string,
  page: number,
  limit: number,
): Promise<{
  results: { account_id: string; username_base: string | null; created_at: Date }[];
  total: number;
}> {
  const offset = (page - 1) * limit;
  const { rows } = await pool.query<{
    account_id: string;
    username_base: string | null;
    created_at: Date;
  }>(
    `SELECT r.account_id, a.username_base, r.created_at
     FROM clan_join_requests r JOIN accounts a ON a.id = r.account_id
     WHERE r.clan_tag = $1
     ORDER BY r.created_at ASC
     LIMIT $2 OFFSET $3`,
    [tag, limit, offset],
  );
  const { rows: countRows } = await pool.query<{ count: string }>(
    "SELECT COUNT(*) FROM clan_join_requests WHERE clan_tag = $1",
    [tag],
  );
  return { results: rows, total: Number(countRows[0]?.count ?? 0) };
}

export async function approveClanRequest(
  tag: string,
  targetAccountId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    "DELETE FROM clan_join_requests WHERE clan_tag = $1 AND account_id = $2",
    [tag, targetAccountId],
  );
  if ((rowCount ?? 0) === 0) return false;
  await pool.query(
    `INSERT INTO clan_members (clan_tag, account_id, role) VALUES ($1, $2, 'member')
     ON CONFLICT (clan_tag, account_id) DO NOTHING`,
    [tag, targetAccountId],
  );
  return true;
}

export async function denyClanRequest(
  tag: string,
  targetAccountId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    "DELETE FROM clan_join_requests WHERE clan_tag = $1 AND account_id = $2",
    [tag, targetAccountId],
  );
  return (rowCount ?? 0) > 0;
}

export async function withdrawClanRequest(
  tag: string,
  accountId: string,
): Promise<boolean> {
  return denyClanRequest(tag, accountId);
}

export async function banClanMember(
  tag: string,
  targetAccountId: string,
  bannedByAccountId: string,
  reason: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO clan_bans (clan_tag, account_id, banned_by_account_id, reason)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (clan_tag, account_id) DO UPDATE
       SET banned_by_account_id = $3, reason = $4, created_at = now()`,
    [tag, targetAccountId, bannedByAccountId, reason],
  );
  await removeMember(tag, targetAccountId);
  await denyClanRequest(tag, targetAccountId);
}

export async function unbanClanMember(
  tag: string,
  targetAccountId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    "DELETE FROM clan_bans WHERE clan_tag = $1 AND account_id = $2",
    [tag, targetAccountId],
  );
  return (rowCount ?? 0) > 0;
}

export async function fetchClanBans(
  tag: string,
  page: number,
  limit: number,
): Promise<{
  results: {
    account_id: string;
    username_base: string | null;
    banned_by_account_id: string;
    banned_by_username_base: string | null;
    reason: string | null;
    created_at: Date;
  }[];
  total: number;
}> {
  const offset = (page - 1) * limit;
  const { rows } = await pool.query(
    `SELECT b.account_id, a.username_base, b.banned_by_account_id,
            ab.username_base AS banned_by_username_base, b.reason, b.created_at
     FROM clan_bans b
     JOIN accounts a ON a.id = b.account_id
     LEFT JOIN accounts ab ON ab.id = b.banned_by_account_id
     WHERE b.clan_tag = $1
     ORDER BY b.created_at DESC
     LIMIT $2 OFFSET $3`,
    [tag, limit, offset],
  );
  const { rows: countRows } = await pool.query<{ count: string }>(
    "SELECT COUNT(*) FROM clan_bans WHERE clan_tag = $1",
    [tag],
  );
  return { results: rows, total: Number(countRows[0]?.count ?? 0) };
}

const CLAN_GAMES_PAGE_SIZE = 20;

// Cursor-paginated: the opaque cursor is just "<ended_at ISO>|<game_id>" so
// paging stays stable even as new games are ingested between pages (unlike
// an OFFSET, which would skip/repeat rows).
export async function fetchClanGames(
  tag: string,
  filter: "ffa" | "team" | "hvn" | "ranked" | undefined,
  cursor: string | null,
): Promise<{
  results: {
    game_id: string;
    ended_at: Date;
    duration: number;
    game_map: string | null;
    game_mode: string;
    player_teams: string | null;
    ranked_type: string | null;
    num_players: number | null;
    players: { account_id: string; username: string; won: boolean }[];
  }[];
  nextCursor: string | null;
}> {
  const filterClause =
    filter === "ffa"
      ? "AND g.game_mode = 'Free For All'"
      : filter === "hvn"
        ? "AND g.player_teams = 'Humans Vs Nations'"
        : filter === "team"
          ? "AND g.game_mode = 'Team'"
          : filter === "ranked"
            ? "AND g.ranked_type IS NOT NULL"
            : "";
  const params: unknown[] = [tag];
  let cursorClause = "";
  if (cursor) {
    const [endedAt, gameId] = cursor.split("|");
    params.push(endedAt, gameId);
    cursorClause = `AND (g.ended_at, g.game_id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(CLAN_GAMES_PAGE_SIZE + 1);
  const { rows: gameRows } = await pool.query<{
    game_id: string;
    ended_at: Date;
    duration: number;
    game_map: string | null;
    game_mode: string;
    player_teams: string | null;
    ranked_type: string | null;
    num_players: number | null;
  }>(
    `SELECT DISTINCT g.game_id, g.ended_at, g.duration, g.game_map, g.game_mode,
            g.player_teams, g.ranked_type, g.num_players
     FROM games g
     JOIN game_players gp ON gp.game_id = g.game_id
     JOIN clan_members m ON m.account_id = gp.account_id AND m.clan_tag = $1
     WHERE TRUE ${filterClause} ${cursorClause}
     ORDER BY g.ended_at DESC, g.game_id DESC
     LIMIT $${params.length}`,
    params,
  );
  const hasMore = gameRows.length > CLAN_GAMES_PAGE_SIZE;
  const page = gameRows.slice(0, CLAN_GAMES_PAGE_SIZE);
  const nextCursor = hasMore
    ? `${page[page.length - 1].ended_at.toISOString()}|${page[page.length - 1].game_id}`
    : null;
  if (page.length === 0) return { results: [], nextCursor: null };
  const gameIds = page.map((g) => g.game_id);
  const { rows: playerRows } = await pool.query<{
    game_id: string;
    account_id: string;
    username: string | null;
    won: boolean;
  }>(
    `SELECT gp.game_id, gp.account_id, gp.username, gp.won
     FROM game_players gp
     JOIN clan_members m ON m.account_id = gp.account_id AND m.clan_tag = $1
     WHERE gp.game_id = ANY($2::text[])`,
    [tag, gameIds],
  );
  const playersByGame = new Map<string, typeof playerRows>();
  for (const p of playerRows) {
    const list = playersByGame.get(p.game_id) ?? [];
    list.push(p);
    playersByGame.set(p.game_id, list);
  }
  return {
    results: page.map((g) => ({
      ...g,
      players: (playersByGame.get(g.game_id) ?? []).map((p) => ({
        account_id: p.account_id,
        username: p.username ?? "",
        won: p.won,
      })),
    })),
    nextCursor,
  };
}

// ponytail: "weighted" wins/losses/ratio have no definition anywhere in the
// client (schema comment confirms this is undefined) -- weight = 1 (i.e.
// identical to the unweighted counts) until there's an actual design for
// what should weight a clan's leaderboard contribution differently.
export async function fetchClanLeaderboard(): Promise<{
  start: Date;
  end: Date;
  clans: {
    clan_tag: string;
    games: number;
    wins: number;
    losses: number;
    player_sessions: number;
  }[];
}> {
  const { rows } = await pool.query<{
    clan_tag: string;
    games: string;
    wins: string;
    losses: string;
    player_sessions: string;
  }>(
    `SELECT m.clan_tag,
            COUNT(DISTINCT gp.game_id) AS games,
            COUNT(*) FILTER (WHERE gp.won) AS wins,
            COUNT(*) FILTER (WHERE NOT gp.won) AS losses,
            COUNT(*) AS player_sessions
     FROM clan_members m
     JOIN game_players gp ON gp.account_id = m.account_id
     GROUP BY m.clan_tag
     ORDER BY wins DESC
     LIMIT 100`,
  );
  const { rows: windowRows } = await pool.query<{ start: Date | null }>(
    "SELECT MIN(ended_at) AS start FROM games",
  );
  return {
    start: windowRows[0]?.start ?? new Date(),
    end: new Date(),
    clans: rows.map((r) => ({
      clan_tag: r.clan_tag,
      games: Number(r.games),
      wins: Number(r.wins),
      losses: Number(r.losses),
      player_sessions: Number(r.player_sessions),
    })),
  };
}

// ---- Player profile stats/history ----
// Backs GET /player/:publicId and GET /public/player/:publicId
// (fetchPlayerById/fetchPublicPlayerProfile, src/client/Api.ts) -- built from
// the same games/game_players tables as clan stats, grouped by
// (game_type, game_mode, difficulty) for the Public/Private/Singleplayer
// tree and separately by ranked_type for the Ranked leaf. Real win/loss
// counts; per-game conquest metrics (tiles/gold/kills/etc -- PlayerStatsSchema
// in StatsSchemas.ts) aren't captured by /game/:gameId's ingest at all, so
// those leaves omit `stats` entirely (the field is optional specifically so
// a leaf can be win/loss-only).
export interface PlayerStatsRow {
  game_type: string;
  game_mode: string;
  player_teams: string | null;
  difficulty: string | null;
  ranked_type: string | null;
  wins: string;
  losses: string;
}

export async function getPlayerStatsRows(
  accountId: string,
): Promise<PlayerStatsRow[]> {
  const { rows } = await pool.query<PlayerStatsRow>(
    `SELECT g.game_type, g.game_mode, g.player_teams, g.difficulty, g.ranked_type,
            COUNT(*) FILTER (WHERE gp.won) AS wins,
            COUNT(*) FILTER (WHERE NOT gp.won) AS losses
     FROM game_players gp JOIN games g ON g.game_id = gp.game_id
     WHERE gp.account_id = $1
     GROUP BY g.game_type, g.game_mode, g.player_teams, g.difficulty, g.ranked_type`,
    [accountId],
  );
  return rows;
}

export async function saveGamePlayerStats(
  gameId: string,
  accountId: string,
  stats: unknown,
): Promise<void> {
  await pool.query(
    `INSERT INTO game_player_stats (game_id, account_id, stats) VALUES ($1, $2, $3)
     ON CONFLICT (game_id, account_id) DO NOTHING`,
    [gameId, accountId, JSON.stringify(stats)],
  );
}

export interface PlayerStatsBlobRow {
  game_type: string;
  game_mode: string;
  player_teams: string | null;
  difficulty: string | null;
  ranked_type: string | null;
  stats: unknown;
}

// Bucket key columns mirror getPlayerStatsRows exactly -- AuthServer.ts's
// buildStatsTree() groups both by the same key so a leaf's win/loss and its
// summed conquest stats (attacks/gold/boats/bombs/units) land together.
export async function getPlayerStatsBlobs(
  accountId: string,
): Promise<PlayerStatsBlobRow[]> {
  const { rows } = await pool.query<PlayerStatsBlobRow>(
    `SELECT g.game_type, g.game_mode, g.player_teams, g.difficulty, g.ranked_type, s.stats
     FROM game_player_stats s JOIN games g ON g.game_id = s.game_id
     WHERE s.account_id = $1`,
    [accountId],
  );
  return rows;
}

const PLAYER_GAMES_PAGE_SIZE = 20;

// Same opaque "<ended_at ISO>|<game_id>" cursor as fetchClanGames.
export async function getPublicPlayerGames(
  accountId: string,
  modeFilter: "ffa" | "team" | "hvn" | "ranked" | undefined,
  typeFilter: "public" | "private" | "singleplayer" | undefined,
  cursor: string | null,
): Promise<{
  results: {
    game_id: string;
    ended_at: Date;
    duration: number;
    game_map: string | null;
    game_mode: string;
    game_type: string;
    player_teams: string | null;
    ranked_type: string | null;
    num_players: number | null;
    username: string | null;
    won: boolean;
  }[];
  nextCursor: string | null;
}> {
  const modeClause =
    modeFilter === "ffa"
      ? "AND g.game_mode = 'Free For All'"
      : modeFilter === "hvn"
        ? "AND g.player_teams = 'Humans Vs Nations'"
        : modeFilter === "team"
          ? "AND g.game_mode = 'Team'"
          : modeFilter === "ranked"
            ? "AND g.ranked_type IS NOT NULL"
            : "";
  const typeClause =
    typeFilter === "public"
      ? "AND g.game_type = 'Public'"
      : typeFilter === "private"
        ? "AND g.game_type = 'Private'"
        : typeFilter === "singleplayer"
          ? "AND g.game_type = 'Singleplayer'"
          : "";
  const params: unknown[] = [accountId];
  let cursorClause = "";
  if (cursor) {
    const [endedAt, gameId] = cursor.split("|");
    params.push(endedAt, gameId);
    cursorClause = `AND (g.ended_at, g.game_id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(PLAYER_GAMES_PAGE_SIZE + 1);
  const { rows } = await pool.query<{
    game_id: string;
    ended_at: Date;
    duration: number;
    game_map: string | null;
    game_mode: string;
    game_type: string;
    player_teams: string | null;
    ranked_type: string | null;
    num_players: number | null;
    username: string | null;
    won: boolean;
  }>(
    `SELECT g.game_id, g.ended_at, g.duration, g.game_map, g.game_mode, g.game_type,
            g.player_teams, g.ranked_type, g.num_players, gp.username, gp.won
     FROM games g JOIN game_players gp ON gp.game_id = g.game_id
     WHERE gp.account_id = $1 ${modeClause} ${typeClause} ${cursorClause}
     ORDER BY g.ended_at DESC, g.game_id DESC
     LIMIT $${params.length}`,
    params,
  );
  const hasMore = rows.length > PLAYER_GAMES_PAGE_SIZE;
  const page = rows.slice(0, PLAYER_GAMES_PAGE_SIZE);
  const nextCursor = hasMore
    ? `${page[page.length - 1].ended_at.toISOString()}|${page[page.length - 1].game_id}`
    : null;
  return { results: page, nextCursor };
}

export async function findAccountByDiscordId(
  discordId: string,
): Promise<Account | null> {
  const { rows } = await pool.query<Account>(
    "SELECT * FROM accounts WHERE discord_id = $1",
    [discordId],
  );
  return rows[0] ?? null;
}

export async function findAccountByGoogleEmail(
  email: string,
): Promise<Account | null> {
  const { rows } = await pool.query<Account>(
    "SELECT * FROM accounts WHERE google_email = $1",
    [email],
  );
  return rows[0] ?? null;
}

export async function findAccountById(id: string): Promise<Account | null> {
  const { rows } = await pool.query<Account>(
    "SELECT * FROM accounts WHERE id = $1",
    [id],
  );
  return rows[0] ?? null;
}
