-- Acharyas (guru-parampara) — portal-only biographies + works, linked to
-- Granthas/Teekas at read time via alias matching. No Strapi change.
CREATE TABLE IF NOT EXISTS acharya_profiles (
  id             serial PRIMARY KEY,
  slug           varchar NOT NULL UNIQUE,
  source_ref     varchar,
  source_url     text,
  name_devanagari text NOT NULL,
  name_iast      text,
  name_display   text,
  aliases        jsonb NOT NULL DEFAULT '[]'::jsonb,
  dates          text,
  lineage_order  integer NOT NULL DEFAULT 0,
  guru_devanagari text,
  category       text,
  biography      jsonb NOT NULL DEFAULT '[]'::jsonb,
  works_list     jsonb NOT NULL DEFAULT '[]'::jsonb,
  avatar_url     text,
  bio_status     text NOT NULL DEFAULT 'empty',
  created_at     timestamp DEFAULT now(),
  updated_at     timestamp DEFAULT now(),
  updated_by     varchar REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS acharya_profiles_lineage_order_idx
  ON acharya_profiles (lineage_order);
