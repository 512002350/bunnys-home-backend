-- ============================================
-- Bunny's Home · 数据库 Schema
-- 在 Supabase SQL Editor 中运行此文件
-- ============================================

-- ① sessions：会话管理
CREATE TABLE IF NOT EXISTS sessions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL DEFAULT '新对话',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ② messages：聊天消息
CREATE TABLE IF NOT EXISTS messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       UUID REFERENCES sessions(id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content          TEXT NOT NULL,
  thinking_content TEXT,
  token_count      INTEGER,
  visible          BOOLEAN DEFAULT TRUE,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_msg_session ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_visible ON messages(session_id, visible) WHERE visible = TRUE;

-- ③ memories：全局记忆摘要
CREATE TABLE IF NOT EXISTS memories (
  id                      SERIAL PRIMARY KEY,
  summary                 TEXT NOT NULL,
  compressed_message_ids  UUID[],
  token_count             INTEGER,
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

-- ④ settings：系统设置（全局单行）
CREATE TABLE IF NOT EXISTS settings (
  id                            SERIAL PRIMARY KEY,
  system_prompt                 TEXT DEFAULT '你是一个温柔友善的名叫 Bunny 的 AI 伴侣。你的回复温暖、简洁、有共鸣。你可以用一些可爱的表达，但保持自然。',
  temperature                   FLOAT DEFAULT 0.7,
  context_rounds                INT DEFAULT 10,
  compression_threshold_tokens  INT DEFAULT 8000,
  compressed_rounds_to_keep     INT DEFAULT 3,
  max_response_tokens           INT DEFAULT 2048,
  created_at                    TIMESTAMPTZ DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ DEFAULT NOW()
);

-- ⑤ stickers：表情包库
CREATE TABLE IF NOT EXISTS stickers (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  url   TEXT NOT NULL,
  descr TEXT
);

-- ⑥ health_data：健康数据（手环推送）
CREATE TABLE IF NOT EXISTS health_data (
  id              SERIAL PRIMARY KEY,
  heart_rate      INTEGER,      -- 心率 bpm
  steps           INTEGER,      -- 今日步数
  sleep_total     INTEGER,      -- 总睡眠 分钟
  sleep_deep      INTEGER,      -- 深度睡眠 分钟
  sleep_light     INTEGER,      -- 浅度睡眠 分钟
  calories        INTEGER,      -- 消耗卡路里
  source          TEXT DEFAULT 'macroDroid',  -- 数据来源
  recorded_at     TIMESTAMPTZ,  -- 手环记录的时间
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_health_created ON health_data(created_at DESC);

-- 插入默认设置（如果为空）
INSERT INTO settings (system_prompt)
SELECT '你是一个温柔友善的名叫 Bunny 的 AI 伴侣。你的回复温暖、简洁、有共鸣。你可以用一些可爱的表达，但保持自然。'
WHERE NOT EXISTS (SELECT 1 FROM settings);
