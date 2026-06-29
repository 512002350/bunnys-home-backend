-- Migration 002: 会话级角色绑定
-- 允许每个会话使用不同的角色，而不是全局单一角色

-- 添加 character_id 列（默认 'default' 兼容现有数据）
ALTER TABLE sessions
ADD COLUMN IF NOT EXISTS character_id TEXT NOT NULL DEFAULT 'default';

-- 索引（按角色筛选会话）
CREATE INDEX IF NOT EXISTS idx_sessions_character ON sessions(character_id);
