/**
 * 用户画像服务 —— 她逐渐了解你
 *
 * 核心设计：
 *   不是"用户标签系统"（标签是机器的思维方式）
 *   而是"她记住的关于你的事"（记忆是人的思维方式）
 *
 * 三类"知道"：
 *   - user_stated ：你明确告诉她的（"我喜欢下雨天"）
 *   - she_observed：她观察到的（"他每次不开心的时候打字速度会变慢"）
 *   - she_inferred：她推测的（"他可能不太会拒绝人"）
 */

const fs = require('fs');
const path = require('path');

const PROFILE_PATH = path.join(__dirname, '..', '..', 'data', 'user_profile.json');

// ========== 初始画像 ==========
const DEFAULT_PROFILE = {
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  first_chat_at: null,
  total_messages_exchanged: 0,
  total_sessions: 0,
  deep_conversations: 0,     // 她认为"深入"的对话次数

  // 她知道你什么
  known_facts: [],            // [{content, source, importance, created_at, first_mentioned_at, times_referenced}]

  // 你们一起经历过什么
  shared_experiences: [],     // [{date, description, emotional_tone, created_at}]

  // 她观察到的模式（不是标签，是观察）
  observed_patterns: [],      // [{pattern, evidence_count, confidence, created_at}]

  // 当前上下文——跨会话传递的关键信息
  current_context: {
    summary: '',              // 简短摘要
    key_points: [],           // 关键事实/决定
    last_updated: null,
    source_session: null,
  },

  // 她正在了解中的事（还未确认，她在试探）
  things_she_is_figuring_out: [],

  // 当前关系阶段的自然标记
  relationship_markers: {
    has_used_nickname: false,
    has_initiated_conversation: false,
    has_shared_vulnerability: false,
    has_been_sarcastic_with_you: false,
    has_said_goodnight_first: false,
    deep_night_conversations: 0,       // 超过凌晨 1 点的对话
    times_she_almost_said_it: 0,       // 差点说出心里话的次数
  },
};

// ========== 内存缓存 ==========
let profile = null;
let profileLoaded = false;

function loadProfile() {
  try {
    if (fs.existsSync(PROFILE_PATH)) {
      profile = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf-8'));
    } else {
      profile = { ...DEFAULT_PROFILE, created_at: new Date().toISOString() };
      saveProfile();
    }
    profileLoaded = true;
    console.log(`[UserProfile] 已加载用户画像：${profile.known_facts.length} 件已知事实，${profile.shared_experiences.length} 段共享经历`);
  } catch (err) {
    console.error('[UserProfile] 加载失败:', err.message);
    profile = { ...DEFAULT_PROFILE, created_at: new Date().toISOString() };
    profileLoaded = true;
  }
}

function saveProfile() {
  try {
    profile.updated_at = new Date().toISOString();
    const dir = path.dirname(PROFILE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2), 'utf-8');
  } catch (err) {
    console.error('[UserProfile] 保存失败:', err.message);
  }
}

loadProfile();

// ========== 记录对话 ==========

function recordConversation(messageCount = 2) {
  if (!profile.first_chat_at) {
    profile.first_chat_at = new Date().toISOString();
  }
  profile.total_messages_exchanged += messageCount;
  profile.total_sessions += 1;

  // 深夜对话标记
  const hour = new Date().getHours();
  if (hour >= 1 && hour < 5) {
    profile.relationship_markers.deep_night_conversations += 1;
    // 深夜对话往往是关系转折点
    if (profile.relationship_markers.deep_night_conversations === 1) {
      addKnownFact('第一次在深夜聊天。那晚她说了比平时多很多的话。', 'she_observed', 8);
    }
  }

  saveProfile();
}

// ========== 事实记录 ==========

/**
 * 她知道了关于你的一件事
 *
 * @param {string} content - 事实内容（用她的视角描述）
 * @param {string} source - 'user_stated' | 'she_observed' | 'she_inferred'
 * @param {number} importance - 1-10，这件事有多重要（影响记忆保留时间）
 */
function addKnownFact(content, source = 'user_stated', importance = 5) {
  // 去重：检查是否已有相似事实
  const existing = profile.known_facts.find(f =>
    f.content === content ||
    (f.content.length > 5 && content.includes(f.content.slice(0, 10)))
  );
  if (existing) {
    existing.times_referenced = (existing.times_referenced || 0) + 1;
    existing.updated_at = new Date().toISOString();
    // 重复提到 = 对这件事更确定了
    if (source === 'user_stated' && existing.source === 'she_inferred') {
      existing.source = 'user_stated'; // 升级为确认信息
      existing.importance = Math.min(10, (existing.importance || 5) + 2);
    }
    saveProfile();
    return existing;
  }

  const fact = {
    content,
    source,
    importance,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    first_mentioned_at: new Date().toISOString(),
    times_referenced: 1,
  };

  profile.known_facts.push(fact);

  // 限制总条数，删除最不重要且最旧的
  if (profile.known_facts.length > 100) {
    profile.known_facts.sort((a, b) =>
      (a.importance || 5) - (b.importance || 5) ||
      new Date(a.updated_at) - new Date(b.updated_at)
    );
    profile.known_facts = profile.known_facts.slice(-80);
  }

  console.log(`[UserProfile] 她知道了：「${content.slice(0, 40)}...」(${source}, 重要度${importance})`);
  saveProfile();
  return fact;
}

/**
 * 添加一段共享经历
 */
function addSharedExperience(description, emotionalTone = 'neutral') {
  const exp = {
    date: new Date().toISOString(),
    description,
    emotional_tone: emotionalTone,
    created_at: new Date().toISOString(),
  };
  profile.shared_experiences.push(exp);

  // 限制条数
  if (profile.shared_experiences.length > 50) {
    profile.shared_experiences = profile.shared_experiences.slice(-30);
  }

  saveProfile();
  return exp;
}

// ========== 自动提取（从用户消息中识别事实） ==========

/**
 * 从用户消息中自动提取"她可以记住的事"
 *
 * 不是 NLP 解析——而是识别用户消息中的"自我披露"模式。
 * 一个人告诉你关于自己的事，往往有一些语言标记。
 */
function extractFactsFromMessage(message) {
  if (!message || message.length < 10) return [];

  const facts = [];
  const addFact = (content, importance) => {
    const trimmed = content.trim();
    if (trimmed.length >= 4) {
      facts.push({ content: trimmed, source: 'user_stated', importance });
    }
  };

  // 用箭头函数包一层 String.match，避免 g 标志 exec 的状态残留问题
  const matchAll = (text, regexStr) => {
    const r = new RegExp(regexStr, 'g');
    return text.match(r) || [];
  };

  // 模式 1：直接陈述偏好
  for (const m of matchAll(message, '我喜欢.{1,30}')) addFact(m, 6);
  for (const m of matchAll(message, '我不喜欢.{1,30}')) addFact(m, 6);
  for (const m of matchAll(message, '我最(?:喜欢|爱|讨厌|怕).{1,30}')) addFact(m, 6);
  for (const m of matchAll(message, '我.{0,10}习惯.{1,20}')) addFact(m, 6);

  // 模式 2：身份/状态声明
  for (const m of matchAll(message, '我是.{1,30}')) addFact(m, 7);
  for (const m of matchAll(message, '我在.{1,20}(?:工作|上班|上学|住|生活)')) addFact(m, 7);
  for (const m of matchAll(message, '我(?:今年|刚|已经).{1,30}')) addFact(m, 7);
  for (const m of matchAll(message, '我(?:叫|名字是).{1,15}')) addFact(m, 7);

  // 模式 3：情感/状态表露
  for (const m of matchAll(message, '我(?:觉得|感觉|有点|很|特别).{1,30}')) addFact(m, 4);
  for (const m of matchAll(message, '我(?:今天|最近|一直).{1,30}')) addFact(m, 4);
  for (const m of matchAll(message, '我好像.{1,30}')) addFact(m, 4);

  // 去重
  const seen = new Set();
  return facts.filter(f => {
    const key = f.content.slice(0, 12);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 标记关系里程碑
 */
function markRelationshipMilestone(marker) {
  if (marker in profile.relationship_markers) {
    if (!profile.relationship_markers[marker]) {
      profile.relationship_markers[marker] = true;
      console.log(`[UserProfile] 关系里程碑：${marker}`);
      saveProfile();
    }
  }
}

function getProfile() {
  return profile;
}

/**
 * 保存跨会话的关键上下文
 * @param {object} context - { summary, key_points, sessionId }
 */
function preserveContext(context) {
  profile.current_context = {
    summary: context.summary || '',
    key_points: context.key_points || [],
    last_updated: new Date().toISOString(),
    source_session: context.sessionId || null,
  };
  saveProfile();
  console.log(`[UserProfile] 关键上下文已保存：${context.key_points?.length || 0} 个关键点`);
}

/**
 * 获取当前保存的上下文提示词块
 */
function getContextPromptBlock() {
  const ctx = profile.current_context;
  if (!ctx?.summary && (!ctx?.key_points || ctx.key_points.length === 0)) {
    return '';
  }
  let block = '\n\n# 你们最近的对话要点（跨会话保留）';
  if (ctx.summary) {
    block += `\n${ctx.summary}`;
  }
  if (ctx.key_points && ctx.key_points.length > 0) {
    block += '\n\n关键信息：\n' + ctx.key_points.map(p => `- ${p}`).join('\n');
  }
  block += '\n\n自然地融入对话，不要逐条复述这些内容。';
  return block;
}

module.exports = {
  getProfile,
  addKnownFact,
  addSharedExperience,
  extractFactsFromMessage,
  recordConversation,
  markRelationshipMilestone,
  preserveContext,
  getContextPromptBlock,
  loadProfile,
};
