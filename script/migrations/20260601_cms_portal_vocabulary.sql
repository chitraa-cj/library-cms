-- Admin-managed dropdown values (teeka authors, structure level names).
CREATE TABLE IF NOT EXISTS cms_portal_vocabulary (
  id integer PRIMARY KEY DEFAULT 1,
  custom jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamp DEFAULT now(),
  updated_by varchar REFERENCES users(id)
);

INSERT INTO cms_portal_vocabulary (id, custom)
VALUES (1, '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;
