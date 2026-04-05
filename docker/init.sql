-- Sciurus Database Schema

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Projects table
CREATE TABLE projects (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(255) NOT NULL UNIQUE,
    description TEXT DEFAULT '',
    repo_path   VARCHAR(500) DEFAULT NULL,
    color       VARCHAR(7) DEFAULT '#3b82f6',
    active_in_ide BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Categories table
CREATE TABLE categories (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(255) NOT NULL UNIQUE,
    sort_order  INTEGER DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default categories
INSERT INTO categories (name, sort_order) VALUES
    ('Uncategorized', 0),
    ('cvstomize.com', 1),
    ('PowerToys', 2),
    ('LLM Setup', 3),
    ('Hardware/GPU', 4),
    ('Ideas', 5),
    ('Code Patterns', 6);

-- Settings table
CREATE TABLE settings (
    key         VARCHAR(100) PRIMARY KEY,
    value       JSONB NOT NULL DEFAULT '{}',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default settings
INSERT INTO settings (key, value) VALUES
    ('general', '{"launchOnStartup": true, "openWindowOnLaunch": true, "minimizeToTray": true, "theme": "dark"}'),
    ('capture', '{"hotkey": "ctrl+shift+q", "watchClipboard": true, "pollInterval": 500, "autoCategory": true}'),
    ('ai', '{"enabled": true, "autoCategorizeonSave": true, "retryUncategorizedOnStartup": true}'),
    ('database', '{"host": "localhost", "port": 5432}');

-- Clips table
CREATE TABLE clips (
    id          VARCHAR(20) PRIMARY KEY,
    image       TEXT,
    comment     TEXT DEFAULT '',
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    tags        TEXT[] DEFAULT '{}',
    ai_summary  TEXT DEFAULT NULL,
    url         VARCHAR(2000) DEFAULT NULL,
    status      VARCHAR(10) NOT NULL DEFAULT 'parked' CHECK (status IN ('active', 'parked')),
    completed_at TIMESTAMPTZ DEFAULT NULL,
    archived    BOOLEAN NOT NULL DEFAULT FALSE,
    ai_fix_prompt TEXT DEFAULT NULL,
    deleted_at  TIMESTAMPTZ DEFAULT NULL,
    timestamp   BIGINT NOT NULL,
    source      VARCHAR(10) NOT NULL DEFAULT 'full' CHECK (source IN ('full', 'lite')),
    window_title  TEXT DEFAULT NULL,
    process_name  VARCHAR(255) DEFAULT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Clip comments (thread)
CREATE TABLE clip_comments (
    id          SERIAL PRIMARY KEY,
    clip_id     VARCHAR(20) NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    text        TEXT NOT NULL,
    ts          BIGINT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_clips_project     ON clips(project_id);
CREATE INDEX idx_clips_category    ON clips(category_id);
CREATE INDEX idx_clips_status      ON clips(status);
CREATE INDEX idx_clips_archived    ON clips(archived);
CREATE INDEX idx_clips_deleted     ON clips(deleted_at);
CREATE INDEX idx_clips_timestamp   ON clips(timestamp DESC);
CREATE INDEX idx_clips_tags        ON clips USING GIN(tags);
CREATE INDEX idx_clip_comments_clip ON clip_comments(clip_id);

-- Full-text search index
CREATE INDEX idx_clips_fts ON clips USING GIN(
    to_tsvector('english', COALESCE(comment, '') || ' ' || COALESCE(ai_summary, ''))
);

-- Updated-at trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_clips_updated_at
    BEFORE UPDATE ON clips
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_projects_updated_at
    BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_settings_updated_at
    BEFORE UPDATE ON settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Window rules for rule-based categorization
CREATE TABLE window_rules (
    id          SERIAL PRIMARY KEY,
    pattern     VARCHAR(500) NOT NULL,
    match_field VARCHAR(20) NOT NULL DEFAULT 'window_title'
                CHECK (match_field IN ('window_title', 'process_name', 'both')),
    match_type  VARCHAR(10) NOT NULL DEFAULT 'contains'
                CHECK (match_type IN ('contains', 'startswith', 'regex')),
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    priority    INTEGER DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_clips_process ON clips(process_name);
CREATE INDEX idx_window_rules_priority ON window_rules(priority DESC);
