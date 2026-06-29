const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

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

async function createSession(name = '新对话') {
  const db = getSupabase();
  if (!db) return { id: 'local-' + Date.now(), name, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  const { data, error } = await db
    .from('sessions')
    .insert({ name })
    .select()
    .single();
  if (error) throw error;
  return data;
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

async function insertMemory(summary, compressedMessageIds) {
  const db = getSupabase();
  if (!db) return { id: Date.now(), summary, compressed_message_ids: compressedMessageIds };
  const tokenCount = Math.ceil(summary.length / 3.5);
  const { data, error } = await db
    .from('memories')
    .insert({ summary, compressed_message_ids: compressedMessageIds, token_count: tokenCount })
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

module.exports = {
  getSupabase,
  isConfigured,
  getSessions,
  createSession,
  updateSession,
  deleteSession,
  getVisibleMessages,
  insertMessage,
  hideMessages,
  getMemories,
  insertMemory,
  getSettings,
  updateSettings,
  insertHealthData,
  getLatestHealth,
};
