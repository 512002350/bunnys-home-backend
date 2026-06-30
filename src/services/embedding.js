/**
 * Embedding 服务
 *
 * 把文本转成 1024 维向量，用于语义检索。
 * 使用 OpenRouter embedding API（兼容 OpenAI 格式），
 * 模型默认用 BGE-M3（1024 维，中英文都好）。
 */

const OPENROUTER_BASE = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;

/** 默认 embedding 模型 */
const EMBEDDING_MODEL = 'openai/text-embedding-3-small';
// BGE-M3 备选: 'intfloat/multilingual-e5-large' (via OpenRouter)
// text-embedding-3-small 便宜且维度可调，设 1024 维即可

/**
 * 单个文本 → 向量
 */
async function getEmbedding(text) {
  if (!text || text.trim().length === 0) return null;
  if (!OPENROUTER_KEY) {
    console.warn('[Embedding] 未配置 OPENROUTER_API_KEY，跳过向量化');
    return null;
  }

  try {
    const res = await fetch(`${OPENROUTER_BASE}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENROUTER_KEY}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: text.trim(),
        dimensions: 1024, // 强行输出 1024 维
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('[Embedding] API 调用失败:', res.status, err.slice(0, 200));
      return null;
    }

    const data = await res.json();
    return data.data?.[0]?.embedding || null;
  } catch (e) {
    console.error('[Embedding] 异常:', e.message);
    return null;
  }
}

/**
 * 批量文本 → 向量（一次 API 调用）
 */
async function getEmbeddings(texts) {
  if (!texts || texts.length === 0) return [];
  if (!OPENROUTER_KEY) return texts.map(() => null);

  const valid = texts.filter(t => t && t.trim().length > 0);
  if (valid.length === 0) return texts.map(() => null);

  try {
    const res = await fetch(`${OPENROUTER_BASE}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENROUTER_KEY}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: valid.map(t => t.trim()),
        dimensions: 1024,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('[Embedding] 批量调用失败:', res.status, err.slice(0, 200));
      return texts.map(() => null);
    }

    const data = await res.json();
    const embeddings = data.data || [];
    // 按顺序映射回去
    let ei = 0;
    return texts.map(t => {
      if (!t || t.trim().length === 0) return null;
      return embeddings[ei++]?.embedding || null;
    });
  } catch (e) {
    console.error('[Embedding] 批量异常:', e.message);
    return texts.map(() => null);
  }
}

module.exports = { getEmbedding, getEmbeddings, EMBEDDING_MODEL };
