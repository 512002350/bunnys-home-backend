-- ============================================
-- Bunny's Home · Migration 003：Skills/Prompt 管理系统
-- 在 Supabase SQL Editor 中运行
-- ============================================

-- ① skills：技能/提示词注册中心
CREATE TABLE IF NOT EXISTS skills (
  id              TEXT PRIMARY KEY,              -- e.g. 'char-default-core', 'tool-stance-analysis'
  name            TEXT NOT NULL,                 -- 技能名称（支持中文）
  description     TEXT,                          -- 技能描述
  type            TEXT NOT NULL CHECK (type IN (
                    'character',                  -- 角色身份/人格 Prompt
                    'tool',                       -- 工具/推理 Prompt
                    'style',                      -- 叙事/文风 Prompt
                    'instruction',               -- 行为指令 Prompt
                    'template',                   -- 参数化模板
                    'variable'                    -- 变量定义
                  )),
  category        TEXT DEFAULT 'general',         -- e.g. 'character-core', 'reasoning', 'health', 'memory'
  content         TEXT NOT NULL,                  -- 实际 Prompt 文本，可含 {{variable}} 占位符
  variables       JSONB DEFAULT '{}',             -- { varName: { type, description, required, default } }
  tags            TEXT[] DEFAULT '{}',            -- 标签数组，用于过滤搜索
  priority        INTEGER DEFAULT 100,            -- 排序优先级（越大越靠后）
  enabled         BOOLEAN DEFAULT TRUE,           -- 软开关
  is_builtin      BOOLEAN DEFAULT FALSE,          -- true = 系统内置（不可删，只能覆盖）
  source_file     TEXT,                           -- 迁移追踪：原始来源文件
  source_line     INTEGER,                        -- 迁移追踪：原始来源行号
  current_version INTEGER DEFAULT 1,              -- 当前版本号
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_skills_type ON skills(type);
CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category);
CREATE INDEX IF NOT EXISTS idx_skills_enabled ON skills(enabled) WHERE enabled = TRUE;
CREATE INDEX IF NOT EXISTS idx_skills_tags ON skills USING GIN(tags);


-- ② skill_versions：语义化版本管理
CREATE TABLE IF NOT EXISTS skill_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id        TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,              -- 单调递增版本号
  content         TEXT NOT NULL,                  -- 该版本的完整内容
  change_summary  TEXT,                           -- 人工写的变更说明
  change_diff     TEXT,                           -- 与上一版本的 unified diff
  change_type     TEXT DEFAULT 'update' CHECK (change_type IN ('create','update','rollback','migrate')),
  author          TEXT DEFAULT 'system',          -- 变更人
  created_at      TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (skill_id, version)
);

CREATE INDEX IF NOT EXISTS idx_skill_versions_skill ON skill_versions(skill_id, version DESC);


-- ③ prompt_compositions：组装蓝图
CREATE TABLE IF NOT EXISTS prompt_compositions (
  id              TEXT PRIMARY KEY,              -- e.g. 'main-chat', 'autonomous-stage1'
  name            TEXT NOT NULL,                  -- 蓝图名称
  description     TEXT,                           -- 说明
  skill_ids       TEXT[] NOT NULL,                -- 有序的 skill ID 列表
  separator       TEXT DEFAULT E'\n\n',            -- 各 skill 块之间的分隔符
  enabled         BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);


-- ④ settings 加字段：活跃组合引用
ALTER TABLE settings
ADD COLUMN IF NOT EXISTS active_compositions JSONB DEFAULT '{}';
-- 格式: { "main-chat": "main-chat", "autonomous": "autonomous-default" }
