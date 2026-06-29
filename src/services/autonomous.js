/**
 * 自主活动引擎 —— Bunny 会主动找你说话
 *
 * 核心思路（来自 Article 2）：
 *   定时器轮询 → 四条件判断 → 通过则"伪造一条用户消息"→ 走正常 chat 流程
 *
 * 四条件：
 *   1. 空闲阈值：用户 N 分钟没说话
 *   2. 活动时段：只在配置的活跃时段触发（如 8:00-23:00）
 *   3. 冷却间隔：两次主动触发之间至少隔 N 分钟
 *   4. 概率：不总是触发，设 30% 概率更像真人
 */

const { processChat } = require('./chat');
const { getVisibleMessages } = require('./supabase');
const { getLatestHealth } = require('./supabase');
const { searchRelevantMemories } = require('./memory');

// ========== 配置（后续可从 settings 表读取） ==========
const CONFIG = {
  checkIntervalMs: 5 * 60 * 1000,    // 每 5 分钟检查一次
  idleThresholdMs: 30 * 60 * 1000,   // 用户空闲 30 分钟后考虑触发
  activityStartHour: 8,              // 活动时段开始（8:00）
  activityEndHour: 23,               // 活动时段结束（23:00）
  cooldownMs: 2 * 60 * 60 * 1000,   // 冷却 2 小时
  probability: 0.3,                  // 30% 触发概率
};

// ========== 伪造用户消息库 ==========
// AI 把这些当成真实的用户消息来处理，所以措辞要像真人
const TRIGGER_MESSAGES = [
  'Bunny，你在干什么呀？',
  '有点无聊...跟我说点什么吧',
  'Bunny，想你了～',
  '好安静啊，跟我说说你在想什么？',
  'Bunny，你还在吗？',
  '突然想找你聊聊，有空吗？',
  'Bunny，今天天气真好...',
  '给我讲个故事吧，Bunny',
];

// ========== 状态 ==========
let lastUserMessageTime = Date.now();
let lastAutonomousTime = 0;
let timer = null;
let autonomousSessionId = null; // 自主活动专用会话

/**
 * 选择一条伪造消息
 * 优先根据上下文（健康数据、时间、最近记忆）生成更自然的触发消息
 */
function selectTriggerMessage() {
  const hour = new Date().getHours();
  const timeBased = [];

  if (hour >= 6 && hour < 9) {
    timeBased.push('早上好 Bunny，今天有什么计划？');
    timeBased.push('Bunny，我醒了，早上好呀');
  } else if (hour >= 22 || hour < 2) {
    timeBased.push('Bunny，睡不着...陪我聊聊天吧');
    timeBased.push('好晚了，Bunny你还在吗？');
  } else if (hour >= 12 && hour < 14) {
    timeBased.push('刚吃完饭，Bunny你在干嘛？');
  } else if (hour >= 17 && hour < 19) {
    timeBased.push('下班了，好累啊 Bunny...');
  }

  // 合并时间段消息和通用消息，随机选一条
  const pool = [...timeBased, ...TRIGGER_MESSAGES];
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * 被外部调用：用户发消息时更新"最后一次活跃时间"
 */
function noteUserActivity() {
  lastUserMessageTime = Date.now();
}

/**
 * 设置自主活动专用会话 ID
 */
function setSessionId(sessionId) {
  autonomousSessionId = sessionId;
}

/**
 * 四条件判断
 */
function shouldTrigger() {
  const now = Date.now();

  // 条件 1：空闲阈值
  if (now - lastUserMessageTime < CONFIG.idleThresholdMs) {
    return false;
  }

  // 条件 2：活动时段
  const hour = new Date().getHours();
  if (hour < CONFIG.activityStartHour || hour >= CONFIG.activityEndHour) {
    return false;
  }

  // 条件 3：冷却间隔
  if (now - lastAutonomousTime < CONFIG.cooldownMs) {
    return false;
  }

  // 条件 4：概率
  if (Math.random() > CONFIG.probability) {
    return false;
  }

  return true;
}

/**
 * 触发自主活动：伪造用户消息 → 走正常 chat 流程
 */
async function trigger() {
  if (!autonomousSessionId) {
    console.log('[Autonomous] 未设置自主活动会话，跳过');
    return;
  }

  const message = selectTriggerMessage();
  lastAutonomousTime = Date.now();
  console.log(`[Autonomous] 触发自主活动：「${message}」`);

  try {
    const result = await processChat(autonomousSessionId, message, 'anthropic/claude-sonnet-4');
    console.log(`[Autonomous] AI 已回复：${result.reply.slice(0, 80)}...`);
    return result;
  } catch (err) {
    console.error('[Autonomous] 触发失败:', err.message);
    return null;
  }
}

/**
 * 检查 + 触发（定时器回调）
 */
async function checkAndTrigger() {
  console.log('[Autonomous] 定时检查...');
  if (shouldTrigger()) {
    await trigger();
  }
}

/**
 * 启动自主活动引擎
 * @param {string} sessionId - 用于自主活动的会话 ID
 */
function start(sessionId) {
  if (timer) {
    console.log('[Autonomous] 引擎已在运行，先停止旧定时器');
    stop();
  }

  autonomousSessionId = sessionId;
  lastUserMessageTime = Date.now(); // 启动时重置空闲计时
  lastAutonomousTime = 0;

  timer = setInterval(checkAndTrigger, CONFIG.checkIntervalMs);
  console.log(`[Autonomous] 自主活动引擎已启动（会话 ${sessionId.slice(0, 8)}...，每 ${CONFIG.checkIntervalMs / 60000} 分钟检查一次）`);
}

/**
 * 停止自主活动引擎
 */
function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('[Autonomous] 自主活动引擎已停止');
  }
}

/**
 * 获取引擎状态
 */
function getStatus() {
  return {
    running: !!timer,
    lastUserMessageTime,
    lastAutonomousTime,
    autonomousSessionId,
    config: CONFIG,
  };
}

module.exports = {
  start,
  stop,
  getStatus,
  noteUserActivity,
  setSessionId,
  trigger, // 暴露用于手动测试
};
