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
const autonomousRoutes = require('./routes/autonomous');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- 目录准备 ----
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
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '50mb' }));

// ---- 静态文件 ----
app.use('/uploads', express.static(path.join(__dirname, '..', 'public', 'uploads'), {
  maxAge: process.env.STATIC_CACHE_MAX_AGE || '7d',
  immutable: true,
}));

// ---- 路由挂载 ----
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
app.use('/api', chatRoutes);             // /api/chat, /api/stickers
app.use('/api/sessions', sessionsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/health', healthRoutes);    // /api/health/update, /api/health/latest, etc.
app.use('/api/skills', skillsRoutes);
app.use('/api/autonomous', autonomousRoutes);

// ---- 错误处理 ----
app.use(errorHandler);

// ---- 启动 ----
app.listen(PORT, () => {
  console.log(`🐰 Bunny's Home 后端已启动 → http://localhost:${PORT}`);
  console.log(`   健康检查: http://localhost:${PORT}/api/health`);

  if (process.env.HUAWEI_APP_ID) {
    console.log('🫀 华为 Health Kit 自动拉取已启用');
  } else {
    console.log('🫀 华为 Health Kit 未配置，访问 /api/health/huawei/auth 开始授权');
  }

  if (!process.env.OPENROUTER_API_KEY && !process.env.CLAUDE_API_KEY) {
    console.warn('⚠️  未配置模型 API Key，对话接口将无法工作');
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.warn('⚠️  未配置 Supabase 环境变量，数据库功能将无法工作');
  }

  // ---- 定时任务 ----
  const scheduler = require('./services/scheduler');
  scheduler.startAll();

  // ---- 自主活动引擎（AUTONOMOUS_ENABLED 时自动启动） ----
  if (process.env.AUTONOMOUS_ENABLED === 'true') {
    const autonomous = require('./services/autonomous');
    const { createSession, getSessions } = require('./services/supabase');
    setTimeout(async () => {
      try {
        const sessions = await getSessions();
        let existing = sessions.find(s => s.name === 'Bunny的主动问候');
        if (!existing) existing = await createSession('Bunny的主动问候');
        if (existing) autonomous.start(existing.id);
      } catch (err) {
        console.warn('[Autonomous] 自动启动失败:', err.message);
      }
    }, 5000);
    console.log('🤖 自主活动引擎将在会话就绪后自动启动');
  }

  // ---- Skills Registry ----
  const skills = require('./services/skills');
  skills.init().then(() => {
    console.log('🧩 Skills Registry 已就绪，热重载 API: POST /api/skills/reload');
  }).catch(err => {
    console.warn('⚠️  Skills Registry 初始化失败（将使用回退文件）:', err.message);
  });
});
