-- ============================================
-- Bunny's Home · Migration 001：向量记忆检索
-- 在 Supabase SQL Editor 中运行
-- ============================================

-- 1. 启用 pgvector 扩展
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. memories 表加 embedding 列（1024 维 = BGE-M3 标准维度）
ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS embedding vector(1024);

-- 3. 加热度列（为后续热度系统做准备）
ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS heat FLOAT DEFAULT 1.0;

-- 4. 加事实类型列（区分压缩摘要 vs 独立事实）
ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS fact_type TEXT DEFAULT 'summary';
  -- 'summary' = 旧的整段摘要
  -- 'fact'    = 拆分后的独立事实

-- 5. 向量索引（IVFFlat，适合 1000+ 条记录）
-- 如果数据量小（<1000），先不加索引，直接暴力扫描也很快
-- CREATE INDEX IF NOT EXISTS idx_memories_embedding
--   ON memories USING ivfflat (embedding vector_cosine_ops)
--   WITH (lists = 50);

-- 6. 向量相似度搜索函数
CREATE OR REPLACE FUNCTION search_memories(
  query_embedding vector(1024),
  match_threshold FLOAT DEFAULT 0.3,
  match_count INT DEFAULT 10
)
RETURNS TABLE(
  id INT,
  summary TEXT,
  fact_type TEXT,
  heat FLOAT,
  similarity FLOAT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.summary,
    m.fact_type,
    m.heat,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM memories m
  WHERE m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
