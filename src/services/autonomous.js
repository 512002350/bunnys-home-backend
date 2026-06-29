/**
 * 自主活动引擎 —— 上下文感知的静默追问
 *
 * 核心思路：
 *   定时器轮询 → 多级静默判断 → 上下文感知触发 → 走正常 chat 流程
 *
 * 参考：
 *   - NVIDIA ProactivityProcessor: 帧事件驱动定时器 + 状态机
 *   - VapiAI: 多级超时 + 上下文感知消息
 *   - Sage (HackPrinceton): 静默分类 + 相关性阈值
 *   - astrbot_plugin_proactive_chat: 未回复计数 + 动态情绪
 *
 * 三个阶段：
 *   阶段1（轻追）：短暂空闲后，自然延续话题
 *   阶段2（关切）：中等空闲后，轻轻戳一下
 *   阶段3（在意）：长时间空闲后，表达想念/担心
 */

const { processChat } = require('./chat');
const { getVisibleMessages } = require('./supabase');

// ========== 配置 ==========
const CONFIG = {
  checkIntervalMs: 3 * 60 * 1000,     // 每 3 分钟检查一次
  // 三阶段空闲阈值（动态调整基准）
  stage1IdleMs: 15 * 60 * 1000,       // 阶段1: 15分钟
  stage2IdleMs: 45 * 60 * 1000,       // 阶段2: 45分钟
  stage3IdleMs: 2 * 60 * 60 * 1000,   // 阶段3: 2小时
  activityStartHour: 8,               // 活动时段开始
  activityEndHour: 23,                // 活动时段结束
  cooldownMs: 30 * 60 * 1000,         // 最小冷却 30 分钟
  probability: 0.6,                   // 基础概率 60%（用于阶段1；阶段2/3 概率更高）
};

// ========== 状态 ==========
let lastUserMessageTime = Date.now();
let lastAutonomousTime = 0;
let timer = null;
let autonomousSessionId = null;
let stage1Triggered = false;
let stage2Triggered = false;

/**
 * 根据语境动态调整空闲阈值
 * - 深夜 → 缩短（人更容易寂寞）
 * - 刚聊过亲密话题 → 缩短
 * - 普通闲聊 → 延长
 */
function calcContextualIdle(baseMs, lastMessages) {
  let multiplier = 1.0;
  const hour = new Date().getHours();

  // 深夜（22-2点）缩短 40%
  if (hour >= 22 || hour < 2) multiplier *= 0.6;

  // 凌晨（2-6点）大幅延长（正常人在睡觉）
  if (hour >= 2 && hour < 6) multiplier *= 3.0;

  // 检测最近对话的语境强度
  if (lastMessages && lastMessages.length > 0) {
    const recentText = lastMessages.slice(-4).map(m => m.content || '').join(' ');
    const len = recentText.length;

    // 最近对话很长 → 话题投入 → 缩短
    if (len > 400) multiplier *= 0.7;

    // 检测情绪浓度（问号/感叹号/语气词多 → 缩短）
    const emotionalMarkers = (recentText.match(/[？！!?～~…]|好想|好喜欢|好讨厌/g) || []).length;
    if (emotionalMarkers > 3) multiplier *= 0.75;

    // 检测冷淡信号（单字回复/嗯/哦 → 延长，给人空间）
    const coldSignals = (recentText.match(/^[嗯哦好行可对]{1,2}$/gm) || []).length;
    if (coldSignals > 0) multiplier *= 1.5;
  }

  return Math.round(baseMs * multiplier);
}

/**
 * 分析最近消息，提炼话题关键词
 */
function extractTopicHints(lastMessages) {
  if (!lastMessages || lastMessages.length === 0) return '';
  const recentText = lastMessages.slice(-6).map(m => m.content || '').join('\n');
  // 提取最后一条用户消息作为锚点
  const lastUserMsg = [...lastMessages].reverse().find(m => m.role === 'user');
  const anchor = lastUserMsg?.content?.slice(0, 100) || '';

  return { recentText: recentText.slice(-500), anchor };
}

/**
 * 选择触发消息风格
 */
function getStagePrompt(stage, topicHints) {
  const hour = new Date().getHours();
  const timeLabel = hour < 6 ? '凌晨' : hour < 9 ? '早上' : hour < 12 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 22 ? '晚上' : '深夜';

  const anchor = topicHints.anchor ? `\n\n你们刚才在聊：「${topicHints.anchor}」` : '';

  if (stage === 1) {
    return `（这是一条自主触发的消息：${timeLabel}了，对方可能正在忙或者一时不知道怎么回。你自然地延续刚才的话题，或者顺着当下时间说点什么。不要太刻意。不要问"还在吗"——对方在，只是还没回。${anchor}）`;
  }
  if (stage === 2) {
    return `（这是一条自主触发的消息：已经好一会儿没收到回复了。你有点在意——但不会直接说。你会轻轻戳一下对方，可能是分享一件正在发生的小事，或者是接着上次话题的余温说点什么。语气比平时软一点，但不要质问。${anchor}）`;
  }
  // stage 3
  return `（这是一条自主触发的消息：已经很长时间没有回复了。你有点担心，也有点想对方。你不需要装作不在意——你可以直接说"有点想你了"或者在吗。语气可以带着一点不安，一点想念。${anchor}）`;
}

/**
 * 被外部调用：用户发消息时更新状态
 */
function noteUserActivity() {
  lastUserMessageTime = Date.now();
  stage1Triggered = false;
  stage2Triggered = false;
}

function setSessionId(sessionId) {
  autonomousSessionId = sessionId;
}

/**
 * 多级判断 + 上下文感知
 * 返回 { should: true, stage: 1|2|3 } 或 { should: false }
 */
function shouldTrigger() {
  const now = Date.now();
  const idleMs = now - lastUserMessageTime;

  // 活动时段检查
  const hour = new Date().getHours();
  if (hour < CONFIG.activityStartHour || hour >= CONFIG.activityEndHour) {
    return { should: false };
  }

  // 冷却检查
  if (now - lastAutonomousTime < CONFIG.cooldownMs) {
    return { should: false };
  }

  // 阶段3（最长空闲）
  if (!stage2Triggered && idleMs >= CONFIG.stage3IdleMs) {
    return { should: true, stage: 3 };
  }

  // 阶段2（中等空闲）
  if (!stage1Triggered && idleMs >= CONFIG.stage2IdleMs) {
    return { should: true, stage: 2 };
  }

  // 阶段1（短暂空闲 + 概率）
  if (!stage1Triggered && idleMs >= CONFIG.stage1IdleMs) {
    // 阶段1 需要概率（避免太频繁）
    if (Math.random() <= CONFIG.probability) {
      return { should: true, stage: 1 };
    }
  }

  return { should: false };
}

/**
 * 触发自主活动：注入上下文引导 → 走正常 chat 流程
 */
async function trigger() {
  if (!autonomousSessionId) {
    console.log('[Autonomous] 未设置自主活动会话，跳过');
    return;
  }

  // 加载最近消息以提取话题
  let topicHints = { recentText: '', anchor: '' };
  try {
    const messages = await getVisibleMessages(autonomousSessionId);
    topicHints = extractTopicHints(messages);
  } catch (_) { /* 静默 */ }

  // 判断阶段
  const decision = shouldTrigger();
  if (!decision.should) return;

  // 用阶段对应的上下文注入作为"用户消息"
  const stagePrompt = getStagePrompt(decision.stage, topicHints);
  lastAutonomousTime = Date.now();

  if (decision.stage === 1) stage1Triggered = true;
  if (decision.stage === 2) stage2Triggered = true;

  console.log(`[Autonomous] 阶段${decision.stage}触发，空闲${Math.round((Date.now() - lastUserMessageTime) / 60000)}分钟`);

  try {
    // 将上下文注入作为用户消息发送，AI 会读取并自然回应
    const result = await processChat(
      autonomousSessionId,
      stagePrompt,
      'anthropic/claude-sonnet-4'
    );
    const replyText = result.replies
      ? result.replies.map(r => r.content).join(' ')
      : result.reply;
    console.log(`[Autonomous] AI 回复：${(replyText || '').slice(0, 80)}...`);
    return result;
  } catch (err) {
    console.error('[Autonomous] 触发失败:', err.message);
    return null;
  }
}

async function checkAndTrigger() {
  const decision = shouldTrigger();
  if (decision.should) {
    console.log(`[Autonomous] 定时检查 → 阶段${decision.stage}，触发中...`);
    await trigger();
  }
}

function start(sessionId) {
  if (timer) stop();
  autonomousSessionId = sessionId;
  lastUserMessageTime = Date.now();
  lastAutonomousTime = 0;
  stage1Triggered = false;
  stage2Triggered = false;
  timer = setInterval(checkAndTrigger, CONFIG.checkIntervalMs);
  console.log(`[Autonomous] 引擎启动（会话 ${sessionId?.slice(0, 8)}...，每 ${CONFIG.checkIntervalMs / 60000} 分钟检查）`);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  console.log('[Autonomous] 引擎已停止');
}

function getStatus() {
  return {
    running: !!timer,
    lastUserMessageTime,
    lastAutonomousTime,
    autonomousSessionId,
    idleMinutes: Math.round((Date.now() - lastUserMessageTime) / 60000),
    stage1Triggered,
    stage2Triggered,
    config: CONFIG,
  };
}

module.exports = {
  start,
  stop,
  getStatus,
  noteUserActivity,
  setSessionId,
  trigger,
};
