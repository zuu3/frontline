import { Pool } from "pg";

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
      ended_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
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
