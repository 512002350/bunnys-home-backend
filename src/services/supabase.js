const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

let supabase = null;
let configured = false;

function getSupabase() {
  if (!supabase && supabaseUrl && supabaseKey) {
    supabase = createClient(supabaseUrl, supabaseKey);
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
};
