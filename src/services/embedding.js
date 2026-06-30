/**
 * Embedding 服务
 *
 * 把文本转成 1024 维向量，用于语义检索。
 *
 * 优先级:
 *   1. 千问 DashScope (text-embedding-v4) — 已有 Key，中文优秀，免费额度大
 *   2. OpenRouter (text-embedding-3-small) — 兜底
 */

const DASHSCOPE_KEY = process.env.DASHSCOPE_API_KEY;
const DASHSCOPE_BASE = process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const QWEN_EMBED_MODEL = 'text-embedding-v4';

const OPENROUTER_BASE = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const OR_EMBED_MODEL = 'openai/text-embedding-3-small';

const VECTOR_DIM = 1024; // pgvector 列定义

/**
 * 单个文本 → 向量
 */
async function getEmbedding(text) {
  if (!text || text.trim().length === 0) return null;

  // 1. 千问 DashScope
  if (DASHSCOPE_KEY) {
    try {
      return await callDashScopeEmbedding(text);
    } catch (e) {
      console.warn('[Embedding] 千问失败:', e.message);
    }
  }

  // 2. OpenRouter 兜底
  if (OPENROUTER_KEY) {
    try {
      return await callOpenRouterEmbedding(text);
    } catch (e) {
      console.error('[Embedding] OpenRouter 失败:', e.message);
    }
  }

  console.warn('[Embedding] 无可用 provider');
  return null;
}

/**
 * 批量文本 → 向量
 */
async function getEmbeddings(texts) {
  if (!texts || texts.length === 0) return [];
  const valid = texts.filter(t => t && t.trim().length > 0);
  if (valid.length === 0) return texts.map(() => null);

  let embeddings = null;

  // 1. 千问 DashScope 批量
  if (DASHSCOPE_KEY) {
    try {
      embeddings = await callDashScopeEmbeddings(valid);
      console.log('[Embedding] 千问批量:', valid.length, '条');
    } catch (e) {
      console.warn('[Embedding] 千问批量失败:', e.message);
    }
  }

  // 2. OpenRouter 兜底
  if (!embeddings && OPENROUTER_KEY) {
    try {
      embeddings = await callOpenRouterEmbeddings(valid);
      console.log('[Embedding] OpenRouter 批量:', valid.length, '条');
    } catch (e) {
      console.error('[Embedding] OpenRouter 批量失败:', e.message);
    }
  }

  if (!embeddings) {
    console.error('[Embedding] 全部 provider 失败，回退到无过滤');
    return texts.map(() => null);
  }

  // 按原始顺序映射
  let ei = 0;
  return texts.map(t => {
    if (!t || t.trim().length === 0) return null;
    return embeddings[ei++] || null;
  });
}

// ========== Provider 实现 ==========

async function callDashScopeEmbedding(text) {
  const res = await fetch(`${DASHSCOPE_BASE}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DASHSCOPE_KEY}`,
    },
    body: JSON.stringify({
      model: QWEN_EMBED_MODEL,
      input: text.trim(),
      dimensions: VECTOR_DIM,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${res.status} ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.data?.[0]?.embedding || null;
}

async function callDashScopeEmbeddings(texts) {
  const res = await fetch(`${DASHSCOPE_BASE}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DASHSCOPE_KEY}`,
    },
    body: JSON.stringify({
      model: QWEN_EMBED_MODEL,
      input: texts.map(t => t.trim()),
      dimensions: VECTOR_DIM,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${res.status} ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return (data.data || []).map(d => d.embedding || null);
}

async function callOpenRouterEmbedding(text) {
  const res = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENROUTER_KEY}`,
    },
    body: JSON.stringify({
      model: OR_EMBED_MODEL,
      input: text.trim(),
      dimensions: VECTOR_DIM,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${res.status} ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.data?.[0]?.embedding || null;
}

async function callOpenRouterEmbeddings(texts) {
  const res = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENROUTER_KEY}`,
    },
    body: JSON.stringify({
      model: OR_EMBED_MODEL,
      input: texts.map(t => t.trim()),
      dimensions: VECTOR_DIM,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${res.status} ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return (data.data || []).map(d => d.embedding || null);
}

module.exports = { getEmbedding, getEmbeddings };
