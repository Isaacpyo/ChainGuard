/**
 * Forward-only SQL migrations, applied in order and recorded in schema_migrations.
 * Kept in TypeScript so the bundled server carries them without extra files.
 */
export const migrations: { id: string; sql: string }[] = [
  {
    id: '001_init',
    sql: `
      CREATE TABLE users (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email         text NOT NULL,
        name          text,
        password_hash text NOT NULL,
        is_demo       boolean NOT NULL DEFAULT false,
        created_at    timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX users_email_key ON users (lower(email));

      CREATE TABLE vaults (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        slug          text NOT NULL UNIQUE,
        name          text NOT NULL,
        network       text NOT NULL CHECK (network IN ('sandbox', 'sepolia')),
        chain_id      integer NOT NULL,
        address       text NOT NULL,
        known_callers text[] NOT NULL DEFAULT '{}',
        created_at    timestamptz NOT NULL DEFAULT now(),
        UNIQUE (network, address)
      );

      CREATE TABLE simulations (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     uuid REFERENCES users (id) ON DELETE SET NULL,
        status      text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
        result      jsonb,
        error       text,
        started_at  timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz
      );
      CREATE INDEX simulations_started_at_idx ON simulations (started_at DESC);

      CREATE TABLE alerts (
        id               uuid PRIMARY KEY,
        stream_id        text UNIQUE,
        vault_id         uuid REFERENCES vaults (id) ON DELETE CASCADE,
        network          text NOT NULL,
        vault_address    text NOT NULL,
        tx_hash          text NOT NULL,
        stage            text NOT NULL CHECK (stage IN ('pending', 'mined')),
        from_address     text NOT NULL,
        function_name    text NOT NULL,
        args             jsonb NOT NULL DEFAULT '{}',
        value_wei        numeric(78, 0) NOT NULL DEFAULT 0,
        score            smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
        severity         text NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
        rules            jsonb NOT NULL DEFAULT '[]',
        response         text NOT NULL DEFAULT 'none',
        response_tx_hash text,
        status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
        acknowledged_by  uuid REFERENCES users (id) ON DELETE SET NULL,
        acknowledged_at  timestamptz,
        simulation_id    uuid REFERENCES simulations (id) ON DELETE SET NULL,
        detected_at      timestamptz NOT NULL,
        created_at       timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX alerts_vault_detected_idx ON alerts (vault_id, detected_at DESC, id DESC);
      CREATE INDEX alerts_detected_idx ON alerts (detected_at DESC, id DESC);
    `,
  },
];
