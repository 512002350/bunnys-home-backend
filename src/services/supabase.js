const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

let supabase = null;
let configured = false;

function getSupabase() {
  if (!supabase && supabaseUrl && supabaseKey) {
    supabase = createClient(supabaseUrl, supabaseKey, {
      db: { schema: 'public' },
      global: { headers: {} },
      realtime: {}, // 不需要实时功能，但 SDK 要求传 transport
    });
    configured = true;
  }
  return supabase;
}

function isConfigured() {
  return configured && !!getSupabase();
}

// ---- sessions ----

async function getSessions() {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from('sessions')
    .select('*')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data;
}

/**
 * 批量获取多个会话的最后一条可见消息的预览
 * 用于侧边栏会话列表的消息预览
 */
async function getLastMessagesForSessions(sessionIds) {
  const db = getSupabase();
  if (!db || !sessionIds.length) return [];

  // 对每个 session 查询最后一条可见消息 (使用 Promise.all 并行)
  const results = await Promise.all(
    sessionIds.map(async (sid) => {
      const { data, error } = await db
        .from('messages')
        .select('session_id, content')
        .eq('session_id', sid)
        .eq('visible', true)
        .order('created_at', { ascending: false })
        .limit(1);
      if (error || !data?.length) return null;
      return data[0];
    })
  );

  return results.filter(Boolean);
}

async function createSession(name = '新对话', characterId = 'default') {
  const db = getSupabase();
  if (!db) return { id: 'local-' + Date.now(), name, character_id: characterId, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };

  // 先尝试插入 character_id（如果列存在），失败则只插 name
  try {
    const { data, error } = await db
      .from('sessions')
      .insert({ name, character_id: characterId })
      .select()
      .single();
    if (!error) return data;
  } catch (_) { /* character_id 列不存在，回退 */ }

  const { data, error } = await db
    .from('sessions')
    .insert({ name })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * 获取会话的角色 ID
 */
async function getSessionCharacter(sessionId) {
  const db = getSupabase();
  if (!db) return 'default';
  const { data, error } = await db
    .from('sessions')
    .select('character_id')
    .eq('id', sessionId)
    .single();
  if (error || !data) return 'default';
  return data.character_id || 'default';
}

async function updateSession(id, updates) {
  const db = getSupabase();
  if (!db) return { id, ...updates };
  const { data, error } = await db
    .from('sessions')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function deleteSession(id) {
  const db = getSupabase();
  if (!db) return;
  const { error } = await db.from('sessions').delete().eq('id', id);
  if (error) throw error;
}

/**
 * 清除会话的所有可见消息（保留会话本身）
 */
async function deleteSessionMessages(sessionId) {
  const db = getSupabase();
  if (!db) return;
  // 标记所有消息为不可见（软删除）
  const { error } = await db
    .from('messages')
    .update({ visible: false })
    .eq('session_id', sessionId);
  if (error) throw error;
}

// ---- messages ----

async function getVisibleMessages(sessionId) {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from('messages')
    .select('*')
    .eq('session_id', sessionId)
    .eq('visible', true)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

async function insertMessage(sessionId, role, content, thinkingContent = null) {
  const db = getSupabase();
  if (!db) return { id: 'msg-' + Date.now(), session_id: sessionId, role, content, thinking_content: thinkingContent };
  const tokenCount = Math.ceil(content.length / 3.5);
  const { data, error } = await db
    .from('messages')
    .insert({
      session_id: sessionId,
      role,
      content,
      thinking_content: thinkingContent,
      token_count: tokenCount,
      visible: true,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function hideMessages(messageIds) {
  const db = getSupabase();
  if (!db) return;
  const { error } = await db.from('messages').update({ visible: false }).in('id', messageIds);
  if (error) throw error;
}

async function hideMessage(messageId) {
  const db = getSupabase();
  if (!db) return;
  const { error } = await db.from('messages').update({ visible: false }).eq('id', messageId);
  if (error) throw error;
}

/** 获取会话的最后一条可见用户消息 */
async function getLastUserMessage(sessionId) {
  const db = getSupabase();
  if (!db) return null;
  const { data, error } = await db
    .from('messages')
    .select('*')
    .eq('session_id', sessionId)
    .eq('role', 'user')
    .eq('visible', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  if (error) return null;
  return data;
}

// ---- memories 扩展操作 ----

/** 删除单条记忆 */
async function deleteMemory(id) {
  const db = getSupabase();
  if (!db) return;
  const { error } = await db.from('memories').delete().eq('id', id);
  if (error) throw error;
}

/** 批量删除记忆 */
async function deleteMemories(ids) {
  if (!ids || ids.length === 0) return;
  const db = getSupabase();
  if (!db) return;
  const { error } = await db.from('memories').delete().in('id', ids);
  if (error) throw error;
}

// ---- memories ----

async function getMemories() {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from('memories')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

/** 向量语义搜索记忆（pgvector） */
async function searchMemoriesByEmbedding(embedding, threshold = 0.3, limit = 10) {
  const db = getSupabase();
  if (!db || !embedding) return [];
  const { data, error } = await db.rpc('search_memories', {
    query_embedding: embedding,
    match_threshold: threshold,
    match_count: limit,
  });
  if (error) {
    console.error('[Supabase] 向量搜索失败:', error.message);
    return [];
  }
  return data || [];
}

async function insertMemory(summary, compressedMessageIds, options = {}) {
  const db = getSupabase();
  if (!db) return { id: Date.now(), summary, compressed_message_ids: compressedMessageIds };
  const tokenCount = Math.ceil(summary.length / 3.5);
  const { data, error } = await db
    .from('memories')
    .insert({
      summary,
      compressed_message_ids: compressedMessageIds,
      token_count: tokenCount,
      embedding: options.embedding || null,
      fact_type: options.factType || 'summary',
      heat: options.heat || 1.0,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ---- settings ----

async function getSettings() {
  const db = getSupabase();
  if (!db) {
    // 返回默认设置
    return {
      system_prompt: '你是一个温柔友善的名叫 Bunny 的 AI 伴侣。你的回复温暖、简洁、有共鸣。',
      temperature: 0.7,
      context_rounds: 10,
      compression_threshold_tokens: 8000,
      compressed_rounds_to_keep: 3,
      max_response_tokens: 2048,
    };
  }
  const { data, error } = await db
    .from('settings')
    .select('*')
    .order('id', { ascending: true })
    .limit(1)
    .single();
  if (error) {
    // 表可能还没创建
    if (error.code === '42P01') {
      return {
        system_prompt: '你是一个温柔友善的名叫 Bunny 的 AI 伴侣。你的回复温暖、简洁、有共鸣。',
        temperature: 0.7,
        context_rounds: 10,
        compression_threshold_tokens: 8000,
        compressed_rounds_to_keep: 3,
        max_response_tokens: 2048,
      };
    }
    throw error;
  }
  return data;
}

async function updateSettings(updates) {
  const db = getSupabase();
  if (!db) return { ...updates };
  const { data: existing } = await db.from('settings').select('id').limit(1).single();
  if (!existing) {
    const { data, error } = await db
      .from('settings')
      .insert({ ...updates, updated_at: new Date().toISOString() })
      .select()
      .single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await db
    .from('settings')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', existing.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ---- health_data ----

async function insertHealthData(fields) {
  const db = getSupabase();
  if (!db) return { id: Date.now(), ...fields };
  const { data, error } = await db
    .from('health_data')
    .insert({
      heart_rate: fields.heart_rate || null,
      steps: fields.steps || null,
      sleep_total: fields.sleep_total || null,
      sleep_deep: fields.sleep_deep || null,
      sleep_light: fields.sleep_light || null,
      calories: fields.calories || null,
      source: fields.source || 'macroDroid',
      recorded_at: fields.recorded_at || new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// 获取最近 24 小时内的健康数据，汇成摘要
async function getLatestHealth() {
  const db = getSupabase();
  if (!db) return null;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from('health_data')
    .select('*')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  if (!data || data.length === 0) return null;
  return summarizeHealth(data);
}

// 把原始数据汇成一段自然语言摘要
function summarizeHealth(rows) {
  const latest = rows[0];
  const parts = [];

  if (latest.heart_rate) {
    parts.push(`最近心率: ${latest.heart_rate} bpm`);
  }
  if (latest.steps) {
    parts.push(`今日步数: ${latest.steps} 步`);
  }
  if (latest.sleep_total) {
    const h = Math.floor(latest.sleep_total / 60);
    const m = latest.sleep_total % 60;
    parts.push(`昨晚睡眠: ${h}小时${m}分钟`);
    if (latest.sleep_deep) {
      const dh = Math.floor(latest.sleep_deep / 60);
      const dm = latest.sleep_deep % 60;
      parts.push(`深度睡眠: ${dh}小时${dm}分钟`);
    }
  }
  if (latest.calories) {
    parts.push(`消耗卡路里: ${latest.calories} kcal`);
  }

  if (parts.length === 0) return null;

  return '【' + (latest.source || '健康数据') + '】' + parts.join('，') + '。';
}

// ---- 记忆热度系统 ----

/** 召回记忆时加热（单条） */
async function reheatMemory(id, amount = 0.3) {
  const db = getSupabase();
  if (!db) return;
  // 先读当前热度，再加温
  const { data } = await db.from('memories').select('heat').eq('id', id).single();
  if (!data) return;
  const newHeat = Math.min((data.heat || 1.0) + amount, 5.0);
  await db.from('memories').update({ heat: newHeat }).eq('id', id);
}

/** 批量加热已召回的记忆 */
async function reheatMemories(ids, amount = 0.3) {
  if (!ids || ids.length === 0) return;
  const db = getSupabase();
  if (!db) return;
  const { data } = await db.from('memories').select('id, heat').in('id', ids);
  if (!data) return;
  for (const m of data) {
    const newHeat = Math.min((m.heat || 1.0) + amount, 5.0);
    await db.from('memories').update({ heat: newHeat }).eq('id', m.id);
  }
}

/** 定时衰减所有记忆的热度（每小时调用一次） */
async function decayAllMemories(decayRate = 0.95) {
  const db = getSupabase();
  if (!db) return;
  const { data } = await db.from('memories').select('id, heat').gt('heat', 0.11);
  if (!data) return;
  let updated = 0;
  for (const m of data) {
    const newHeat = Math.max((m.heat || 1.0) * decayRate, 0.1);
    if (newHeat < m.heat) {
      await db.from('memories').update({ heat: newHeat }).eq('id', m.id);
      updated++;
    }
  }
  if (updated > 0) {
    console.log(`[Supabase] 记忆热度衰减：${updated} 条已降温`);
  }
}

// ---- 简易 key-value 存储（存 refresh token 等敏感配置） ----
async function getSetting(key) {
  const db = getSupabase();
  if (!db) return null;
  const { data, error } = await db
    .from('settings')
    .select('system_prompt')
    .limit(1)
    .single();
  if (error || !data) return null;
  // 用 system_prompt 字段旁边存额外键值对的方式不可行，改用 env 回退
  return null;
}

async function setSetting(key, value) {
  // 个人项目简化：refresh token 建议直接设到 Render 环境变量
  // 这个函数预留给未来扩展
  console.log(`[settings] ${key} 已更新，建议同步到环境变量`);
  return true;
}

module.exports = {
  getSupabase,
  isConfigured,
  getSessions,
  getLastMessagesForSessions,
  createSession,
  getSessionCharacter,
  updateSession,
  deleteSession,
  deleteSessionMessages,
  getVisibleMessages,
  insertMessage,
  hideMessages,
  hideMessage,
  getLastUserMessage,
  deleteMemory,
  deleteMemories,
  getMemories,
  insertMemory,
  searchMemoriesByEmbedding,
  getSettings,
  updateSettings,
  insertHealthData,
  getLatestHealth,
  getSetting,
  setSetting,
  reheatMemory,
  reheatMemories,
  decayAllMemories,
};
