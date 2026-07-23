CREATE TABLE IF NOT EXISTS pokemon (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL,
  num INT,
  type1 VARCHAR(20),
  type2 VARCHAR(20),
  hp INT, atk INT, def INT,
  spa INT, spd INT, spe INT,
  ability1 VARCHAR(100),
  ability2 VARCHAR(100),
  ability_hidden VARCHAR(100)
);

CREATE TABLE IF NOT EXISTS moves (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL,
  type VARCHAR(20),
  category VARCHAR(20),
  power INT,
  accuracy INT,
  pp INT,
  priority INT DEFAULT 0,
  flags JSONB
);

CREATE TABLE IF NOT EXISTS pokemon_moves (
  pokemon_id INT REFERENCES pokemon(id),
  move_id INT REFERENCES moves(id),
  PRIMARY KEY (pokemon_id, move_id)
);

CREATE TABLE IF NOT EXISTS abilities (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS items (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS balance_patches (
  id           SERIAL PRIMARY KEY,
  pokemon_name VARCHAR(100) NOT NULL,
  change_type  VARCHAR(20)  NOT NULL,
  stat_changed VARCHAR(50)  NOT NULL,
  old_value    VARCHAR(100),
  new_value    VARCHAR(100),
  raw_text     TEXT,
  detected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  release_date DATE
);

CREATE TABLE IF NOT EXISTS tournament_teams (
  id SERIAL PRIMARY KEY,
  tournament_id VARCHAR(100) NOT NULL,
  tournament_name TEXT,
  tournament_date DATE,
  player_name VARCHAR(100),
  placement INT,
  wins INT,
  losses INT,
  team_hash VARCHAR(64) UNIQUE,
  pokemon JSONB,
  scraped_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS usage_stats (
  id SERIAL PRIMARY KEY,
  pokemon_name VARCHAR(100) NOT NULL,
  format VARCHAR(50) DEFAULT 'Champions-MB',
  usage_count INT DEFAULT 0,
  total_teams INT DEFAULT 0,
  usage_percent DECIMAL(5,2),
  avg_win_rate DECIMAL(5,2),
  best_placement INT,
  computed_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(pokemon_name, format)
);

CREATE TABLE IF NOT EXISTS scraper_health (
  id SERIAL PRIMARY KEY,
  scraper_name VARCHAR(100) UNIQUE NOT NULL,
  last_success TIMESTAMPTZ,
  last_attempt TIMESTAMPTZ,
  last_error TEXT,
  total_runs INT DEFAULT 0,
  total_failures INT DEFAULT 0
);

-- sp holds Champions' native Stat Points (0-32 per stat, 66 total) — the format
-- actually used in Reg M-B, not classic EVs. See CLAUDE.md's "Stat Point System" section.
CREATE TABLE IF NOT EXISTS ev_observations (
  id              SERIAL PRIMARY KEY,
  pokemon_name    VARCHAR(100) NOT NULL,
  normalized_name VARCHAR(100),
  nature          VARCHAR(20),
  item            VARCHAR(100),
  sp              JSONB NOT NULL,
  moves           JSONB,
  tournament_id   VARCHAR(100),
  placement       INTEGER,
  scraped_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ev_obs_pokemon ON ev_observations
  (LOWER(normalized_name));

CREATE INDEX IF NOT EXISTS idx_pokemon_name ON pokemon(name);
CREATE INDEX IF NOT EXISTS idx_moves_name ON moves(name);
CREATE INDEX IF NOT EXISTS idx_abilities_name ON abilities(name);
CREATE INDEX IF NOT EXISTS idx_items_name ON items(name);
CREATE INDEX IF NOT EXISTS idx_usage_format ON usage_stats(format);
CREATE INDEX IF NOT EXISTS idx_usage_recorded_at ON usage_stats(computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_pokemon_format ON usage_stats(pokemon_name, format);
CREATE INDEX IF NOT EXISTS idx_teams_tournament ON tournament_teams(tournament_id);
CREATE INDEX IF NOT EXISTS idx_teams_placement ON tournament_teams(placement);
CREATE INDEX IF NOT EXISTS idx_teams_date ON tournament_teams(tournament_date DESC);
CREATE INDEX IF NOT EXISTS idx_balance_patches_pokemon ON balance_patches (LOWER(pokemon_name));
CREATE INDEX IF NOT EXISTS idx_balance_patches_detected ON balance_patches (detected_at DESC);