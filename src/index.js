require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const errorHandler = require('./middleware/errorHandler');

const chatRoutes = require('./routes/chat');
const sessionsRoutes = require('./routes/sessions');
const settingsRoutes = require('./routes/settings');
const healthRoutes = require('./routes/health');
const skillsRoutes = require('./routes/skills');
// sticker 路由已合并到 chat.js 中（/api/stickers）

const app = express();
const PORT = process.env.PORT || 3000;

// 确保上传目录存在
const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
const stickersDir = path.join(uploadsDir, 'stickers');
[uploadsDir, stickersDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`📁 已创建目录: ${dir}`);
  }
});

// ---- 中间件 ----
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true,
}));
app.use(express.json({ limit: '50mb' })); // 支持 base64 图片上传（手机照片约 3-15MB）

// ---- 路由 ----
app.use('/uploads', express.static(path.join(__dirname, '..', 'public', 'uploads'), {
  maxAge: '7d',
  immutable: true,
}));
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api', chatRoutes);      // /api/chat, /api/stickers
app.use('/api/sessions', sessionsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/health', healthRoutes);  // /api/health/update, /api/health/latest
app.use('/api/skills', skillsRoutes); // /api/skills, /api/skills/:id, /api/skills/compositions

// ---- 错误处理 ----
app.use(errorHandler);

// ---- 定时拉取华为 Health Kit 健康数据（每 30 分钟） ----
const { pullAndStore } = require('./services/huaweiHealth');
const { decayAllMemories } = require('./services/supabase');
const PULL_INTERVAL = 30 * 60 * 1000;
const DECAY_INTERVAL = 60 * 60 * 1000; // 热度衰减：每小时

setTimeout(() => {
  pullAndStore().catch(() => {});
  setInterval(() => pullAndStore().catch(() => {}), PULL_INTERVAL);
}, 10000);

// 记忆热度定时衰减（每小时）
setTimeout(() => {
  decayAllMemories(0.95).catch(() => {});
  setInterval(() => decayAllMemories(0.95).catch(() => {}), DECAY_INTERVAL);
}, 30000);

// 日历层级压缩（每 24 小时一次，首次延迟 2 小时）
const { compressCalendarLevel } = require('./services/memory');
const CALENDAR_INTERVAL = 24 * 60 * 60 * 1000;

setTimeout(() => {
  compressCalendarLevel('daily').catch(() => {});
  setInterval(() => compressCalendarLevel('daily').catch(() => {}), CALENDAR_INTERVAL);
}, 2 * 60 * 60 * 1000); // 启动 2 小时后首次运行

// ---- 自主活动引擎 ----
const autonomous = require('./services/autonomous');
const { createSession, getSessions } = require('./services/supabase');

// 自主活动专用 API
app.get('/api/autonomous/status', (req, res) => {
  res.json(autonomous.getStatus());
});

app.post('/api/autonomous/start', async (req, res, next) => {
  try {
    const { sessionId } = req.body;
    const sid = sessionId || await ensureAutonomousSession();
    autonomous.start(sid);
    res.json({ ok: true, sessionId: sid, status: autonomous.getStatus() });
  } catch (err) { next(err); }
});

app.post('/api/autonomous/stop', (req, res) => {
  autonomous.stop();
  res.json({ ok: true, status: autonomous.getStatus() });
});

// 手动触发一次（调试用）
app.post('/api/autonomous/trigger', async (req, res, next) => {
  try {
    if (!autonomous.getStatus().autonomousSessionId) {
      await ensureAutonomousSession();
    }
    const result = await autonomous.trigger();
    res.json({ ok: true, result });
  } catch (err) { next(err); }
});

/**
 * 确保存在一个"Bunny的主动问候"会话
 */
async function ensureAutonomousSession() {
  try {
    const sessions = await getSessions();
    const existing = sessions.find(s => s.name === 'Bunny的主动问候');
    if (existing) {
      autonomous.setSessionId(existing.id);
      return existing.id;
    }
    const created = await createSession('Bunny的主动问候');
    autonomous.setSessionId(created.id);
    return created.id;
  } catch (err) {
    console.error('[Autonomous] 创建会话失败:', err.message);
    return null;
  }
}

// 如果在 Render 环境且配置了 AUTONOMOUS_ENABLED，自动启动
if (process.env.AUTONOMOUS_ENABLED === 'true') {
  setTimeout(async () => {
    const sid = await ensureAutonomousSession();
    if (sid) autonomous.start(sid);
  }, 5000); // 等 Supabase 连接就绪
}

// ---- 启动 ----
app.listen(PORT, () => {
  console.log(`🐰 Bunny's Home 后端已启动 → http://localhost:${PORT}`);
  console.log(`   健康检查: http://localhost:${PORT}/api/health`);
  if (process.env.HUAWEI_APP_ID) {
    console.log('🫀 华为 Health Kit 自动拉取已启用（每 30 分钟）');
  } else {
    console.log('🫀 华为 Health Kit 未配置，访问 /api/health/huawei/auth 开始授权');
  }
  if (process.env.AUTONOMOUS_ENABLED === 'true') {
    console.log('🤖 自主活动引擎将在会话就绪后自动启动');
  }
  if (!process.env.OPENROUTER_API_KEY && !process.env.CLAUDE_API_KEY) {
    console.warn('⚠️  未配置模型 API Key，对话接口将无法工作');
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.warn('⚠️  未配置 Supabase 环境变量，数据库功能将无法工作');
  }

  // ---- Skills Registry ----
  const skills = require('./services/skills');
  skills.init().then(() => {
    console.log('🧩 Skills Registry 已就绪，热重载 API: POST /api/skills/reload');
  }).catch(err => {
    console.warn('⚠️  Skills Registry 初始化失败（将使用回退文件）:', err.message);
  });

  // ---- 自保活：每 10 分钟 ping 自己，防止 Render 免费版休眠 ----
  const hostname = process.env.RENDER_EXTERNAL_HOSTNAME; // Render 自动注入
  const selfUrl = hostname
    ? `https://${hostname}`
    : (process.env.SELF_URL || `http://localhost:${PORT}`);
  const keepAliveIntervalMs = 10 * 60 * 1000; // 10 分钟（Render 15 分钟无请求就休眠）
  setInterval(async () => {
    try {
      await fetch(`${selfUrl}/api/health`);
    } catch (_) { /* 静默 */ }
  }, keepAliveIntervalMs);
  console.log(`🫀 自保活已启用：每 ${keepAliveIntervalMs / 60000} 分钟 ping ${selfUrl}/api/health`);
});
