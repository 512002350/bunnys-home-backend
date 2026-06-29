/**
 * 反思系统 —— 从对话中学习，下次做得更好
 *
 * 核心思路（Article 4）：
 *   每次对话后分析得失 → 存入经验库 → 下次匹配到类似场景时注入提示
 *
 * 两个阶段：
 *   1. 反思（reflect）：分析一轮对话，提取教训 → 写入 lessons.json
 *   2. 匹配（getRelevantLessons）：新消息来，匹配相关经验 → 注入 prompt
 */

const fs = require('fs');
const path = require('path');

const LESSONS_PATH = path.join(__dirname, '..', '..', 'data', 'lessons.json');

// ========== 内存缓存 ==========
let lessons = [];
let lessonsLoaded = false;

function loadLessons() {
  try {
    if (fs.existsSync(LESSONS_PATH)) {
      const raw = fs.readFileSync(LESSONS_PATH, 'utf-8');
      lessons = JSON.parse(raw);
    } else {
      lessons = [];
    }
    lessonsLoaded = true;
    console.log(`[Reflection] 已加载 ${lessons.length} 条经验`);
  } catch (err) {
    console.error('[Reflection] 加载 lessons.json 失败:', err.message);
    lessons = [];
    lessonsLoaded = true;
  }
}

function saveLessons() {
  try {
    const dir = path.dirname(LESSONS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LESSONS_PATH, JSON.stringify(lessons, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Reflection] 保存 lessons.json 失败:', err.message);
  }
}

// 启动时加载
loadLessons();

// ========== 经验匹配（简单关键词匹配，后期可升级为 embedding） ==========

/**
 * 根据用户消息匹配相关经验
 * @param {string} userMessage - 用户消息
 * @param {number} limit - 最多返回条数
 * @returns {Array} 匹配的经验条目
 */
function getRelevantLessons(userMessage, limit = 3) {
  if (!userMessage || lessons.length === 0) return [];

  const scored = lessons.map(lesson => {
    const keywords = lesson.pattern.split(/\s+/).filter(Boolean);
    const msgLower = userMessage.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (msgLower.includes(kw.toLowerCase())) score += 1;
    }
    // 高频使用的经验适度降权（避免反复注入旧经验）
    const recallPenalty = lesson.times_recalled > 10 ? 0.5 : 0;
    return { ...lesson, score: score - recallPenalty };
  });

  const matched = scored
    .filter(l => l.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return matched;
}

/**
 * 将匹配的经验注入系统提示词
 * @param {string} userMessage - 用户消息
 * @returns {string} 经验提示块（追加到 system prompt）
 */
function lessonsPromptBlock(userMessage) {
  const relevant = getRelevantLessons(userMessage, 3);
  if (relevant.length === 0) return '';

  const lines = relevant.map(l => `· ${l.lesson}`);
  return '\n\n## 过往经验（请自然地参考，不要逐条复述）\n' + lines.join('\n');
}

// ========== 反思：分析对话提取教训 ==========

/**
 * 分析一轮对话，自动提取经验教训
 *
 * 在每次 AI 回复后异步调用，不会阻塞主流程。
 * 用简单的启发式规则做初步判断（不耗 token），
 * 只有触发条件时才调模型做深入分析。
 *
 * @param {object} context
 * @param {string} context.userMessage - 用户消息
 * @param {string} context.aiReply - AI 回复
 * @param {string} context.model - 使用的模型
 * @param {boolean} context.wasCompressed - 是否触发了压缩
 */
async function reflect(context) {
  try {
    const { userMessage, aiReply, model, wasCompressed } = context;

    // 启发式：短回复可能意味着没帮上忙
    const replyLen = aiReply?.length || 0;
    const veryShort = replyLen < 30 && replyLen > 0;

    // 启发式：用户消息很长但回复很短 → 可能敷衍
    const userLen = userMessage?.length || 0;
    const suspiciousRatio = userLen > 100 && replyLen < 50;

    // 没有触发条件，跳过
    if (!veryShort && !suspiciousRatio && !wasCompressed) return;

    // 有触发条件：生成一条经验
    const lesson = generateLesson(userMessage, aiReply, { veryShort, suspiciousRatio, wasCompressed });
    if (!lesson) return;

    // 去重：检查是否已有相似的 lesson
    const duplicate = lessons.find(l => l.lesson === lesson.lesson);
    if (duplicate) {
      duplicate.times_recalled += 1;
      duplicate.updated_at = new Date().toISOString();
    } else {
      lessons.push({
        id: 'lsn-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        pattern: extractKeywords(userMessage),
        lesson: lesson.lesson,
        context: lesson.context,
        created_at: new Date().toISOString(),
        times_recalled: 0,
      });
    }

    saveLessons();
    console.log(`[Reflection] 新经验已记录：${lesson.lesson.slice(0, 60)}...`);
  } catch (err) {
    console.error('[Reflection] 反思失败:', err.message);
  }
}

/**
 * 基于启发式信号生成经验教训
 */
function generateLesson(userMessage, aiReply, signals) {
  if (signals.veryShort && signals.suspiciousRatio) {
    return {
      lesson: '当用户发长消息时，AI回复不应过短。应逐点回应或用提问引导用户补充细节。',
      context: 'short_reply_to_long_message',
    };
  }
  if (signals.wasCompressed) {
    return {
      lesson: '对话压缩刚发生，新旧记忆交替时可能出现上下文断裂。后续回复应多确认是否理解了用户当前的需求。',
      context: 'after_compression',
    };
  }
  if (signals.veryShort) {
    return {
      lesson: 'AI回复过短时可能显得敷衍。应增加共情语句或提问来延长对话。',
      context: 'short_reply',
    };
  }
  return null;
}

/**
 * 从用户消息中提取关键词作为匹配 pattern
 */
function extractKeywords(message) {
  if (!message) return '一般';
  // 简单：取前 20 个字做关键词
  const trimmed = message.trim().slice(0, 30);
  return trimmed.replace(/[，。！？、\s]+/g, ' ').trim();
}

// ========== 手动管理 API ==========

function addLesson(pattern, lesson, context = 'manual') {
  const entry = {
    id: 'lsn-' + Date.now(),
    pattern,
    lesson,
    context,
    created_at: new Date().toISOString(),
    times_recalled: 0,
  };
  lessons.push(entry);
  saveLessons();
  return entry;
}

function removeLesson(id) {
  const idx = lessons.findIndex(l => l.id === id);
  if (idx < 0) return false;
  lessons.splice(idx, 1);
  saveLessons();
  return true;
}

function getAllLessons() {
  return [...lessons];
}

module.exports = {
  getRelevantLessons,
  lessonsPromptBlock,
  reflect,
  addLesson,
  removeLesson,
  getAllLessons,
};
