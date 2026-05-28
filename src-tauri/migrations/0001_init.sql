-- v1 schema. UUIDs as TEXT for cross-DB portability.
-- File paths stored as (library_id, relative_path) so libraries can move.

CREATE TABLE libraries (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    root_path   TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE models (
    id              TEXT PRIMARY KEY,
    library_id      TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    relative_path   TEXT NOT NULL,
    filename        TEXT NOT NULL,
    extension       TEXT NOT NULL,
    size_bytes      INTEGER NOT NULL,
    byte_hash       TEXT,           -- sha256 of file bytes
    geometry_hash   TEXT,           -- canonical mesh hash (for cross-format dedup)
    thumbnail_path  TEXT,
    source_url      TEXT,
    source_license  TEXT,
    notes           TEXT,
    indexed_at      TEXT NOT NULL DEFAULT (datetime('now')),
    modified_at     TEXT NOT NULL,
    UNIQUE (library_id, relative_path)
);

CREATE INDEX models_byte_hash      ON models(byte_hash);
CREATE INDEX models_geometry_hash  ON models(geometry_hash);
CREATE INDEX models_library        ON models(library_id);

-- Parsed slicer / format metadata stored as JSON for flexibility.
CREATE TABLE model_metadata (
    model_id    TEXT PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
    format      TEXT NOT NULL,    -- stl | obj | 3mf-bambu | 3mf-orca | 3mf-prusa | 3mf-cura | gcode
    plate_count INTEGER,
    print_time_seconds INTEGER,
    filament_grams REAL,
    filament_types TEXT,           -- JSON array
    nozzle_diameter REAL,
    layer_height REAL,
    bbox_min_x REAL, bbox_min_y REAL, bbox_min_z REAL,
    bbox_max_x REAL, bbox_max_y REAL, bbox_max_z REAL,
    triangle_count INTEGER,
    extra_json  TEXT               -- everything else, slicer-specific
);

CREATE TABLE tags (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    color       TEXT,
    category    TEXT,              -- functional / decorative / subject / etc.
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE model_tags (
    model_id    TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    tag_id      TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    source      TEXT NOT NULL DEFAULT 'manual',  -- manual | auto-tier1 | auto-tier2 | auto-tier3
    confidence  REAL,                            -- for auto tags
    confirmed   INTEGER NOT NULL DEFAULT 1,      -- 0 if auto and unconfirmed
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (model_id, tag_id)
);

CREATE INDEX model_tags_tag ON model_tags(tag_id);

-- Smart collections = saved searches expressed as a query string.
CREATE TABLE smart_collections (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    query       TEXT NOT NULL,
    icon        TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- v2-ready: prints table, empty for v1.
CREATE TABLE prints (
    id          TEXT PRIMARY KEY,
    model_id    TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    success     INTEGER,
    notes       TEXT,
    photo_path  TEXT
);

-- v2-ready: embeddings table (CLIP-on-thumbnail similarity).
CREATE TABLE embeddings (
    model_id    TEXT PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
    model_name  TEXT NOT NULL,    -- e.g. "clip-vit-b-32"
    vector      BLOB NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- App-wide key/value config.
CREATE TABLE app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
