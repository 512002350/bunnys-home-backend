/**
 * Skills REST API — 技能/提示词管理中心
 *
 * 端点清单:
 *   Skills CRUD
 *     GET    /api/skills
 *     GET    /api/skills/:id
 *     POST   /api/skills
 *     PUT    /api/skills/:id
 *     DELETE /api/skills/:id
 *
 *   版本管理
 *     GET    /api/skills/:id/versions
 *     GET    /api/skills/:id/versions/:v
 *     GET    /api/skills/:id/diff?v1=&v2=
 *     POST   /api/skills/:id/rollback
 *
 *   组合蓝图
 *     GET    /api/skills/compositions
 *     GET    /api/skills/compositions/:id
 *     PUT    /api/skills/compositions/:id
 *     POST   /api/skills/compositions/:id/preview
 *
 *   管理
 *     POST   /api/skills/reload
 *     POST   /api/skills/reload/:id
 *     POST   /api/skills/batch/toggle
 *     POST   /api/skills/test
 *
 *   导入/导出
 *     POST   /api/skills/export
 *     POST   /api/skills/import
 *
 * ⚠️ 路由顺序很重要: 静态路径必须在 /:id 之前，否则 Express 会把
 *    "compositions"/"reload"/"test" 等当作 :id 参数匹配
 */

const express = require('express');
const router = express.Router();
const skills = require('../services/skills');

// ========== 列表 & 创建 (无 :id) ==========

// 列表 + 筛选
router.get('/', async (req, res) => {
  try {
    const opts = {};
    if (req.query.type) opts.type = req.query.type;
    if (req.query.category) opts.category = req.query.category;
    if (req.query.enabled !== undefined) opts.enabled = req.query.enabled === 'true';
    if (req.query.search) opts.search = req.query.search;
    if (req.query.tags) opts.tags = req.query.tags.split(',');

    const list = skills.getAllSkills(opts);
    res.json({ skills: list, total: list.length });
  } catch (err) {
    res.status(500).json({ error: `获取技能列表失败: ${err.message}` });
  }
});

// 创建
router.post('/', async (req, res) => {
  try {
    const { id, name, description, type, category, content, variables, tags, priority, enabled } = req.body;
    if (!id || !name || !type || !content) {
      return res.status(400).json({ error: '缺少必填字段: id, name, type, content' });
    }
    const skill = await skills.createSkill({
      id, name, description, type, category, content, variables, tags, priority, enabled,
      author: req.body.author || 'api',
    });
    res.status(201).json({ skill });
  } catch (err) {
    res.status(500).json({ error: `创建技能失败: ${err.message}` });
  }
});

// ========== 组合蓝图 (静态路径，必须在 /:id 之前) ==========

// 蓝图列表
router.get('/compositions', async (req, res) => {
  try {
    const compositions = skills.getAllCompositions();
    res.json({ compositions });
  } catch (err) {
    res.status(500).json({ error: `获取组合列表失败: ${err.message}` });
  }
});

// 蓝图详情 + 实时预览
router.get('/compositions/:id', async (req, res) => {
  try {
    const comp = skills.getComposition(req.params.id);
    if (!comp) return res.status(404).json({ error: `组合蓝图 ${req.params.id} 不存在` });

    // 可选：组装预览
    let preview = null;
    if (req.query.preview === 'true') {
      preview = await skills.compose(req.params.id, {});
    }

    res.json({ composition: comp, preview });
  } catch (err) {
    res.status(500).json({ error: `获取组合失败: ${err.message}` });
  }
});

// 修改蓝图
router.put('/compositions/:id', async (req, res) => {
  try {
    const comp = await skills.updateComposition(req.params.id, {
      name: req.body.name,
      description: req.body.description,
      skill_ids: req.body.skill_ids,
      separator: req.body.separator,
      enabled: req.body.enabled,
    });
    res.json({ composition: comp });
  } catch (err) {
    res.status(500).json({ error: `更新组合失败: ${err.message}` });
  }
});

// 蓝图预览（自定义 context）
router.post('/compositions/:id/preview', async (req, res) => {
  try {
    const context = req.body.context || {};
    const composed = await skills.compose(req.params.id, context);
    res.json({ composition_id: req.params.id, composed_prompt: composed, token_estimate: Math.round(composed.length / 2) });
  } catch (err) {
    res.status(500).json({ error: `预览失败: ${err.message}` });
  }
});

// ========== 管理端点 (静态路径，必须在 /:id 之前) ==========

// 全量热重载
router.post('/reload', async (req, res) => {
  try {
    const result = await skills.reloadAll();
    res.json({ message: '全部技能已重新加载', ...result });
  } catch (err) {
    res.status(500).json({ error: `重载失败: ${err.message}` });
  }
});

// 单 skill 热重载
router.post('/reload/:id', async (req, res) => {
  try {
    const skill = await skills.reloadSkill(req.params.id);
    res.json({ message: `技能 ${req.params.id} 已重新加载`, skill });
  } catch (err) {
    res.status(500).json({ error: `重载失败: ${err.message}` });
  }
});

// 批量开关
router.post('/batch/toggle', async (req, res) => {
  try {
    const { ids, enabled } = req.body;
    if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: '请提供 ids 数组' });
    const result = await skills.batchToggle(ids, !!enabled);
    res.json({ message: `已${enabled ? '启用' : '禁用'} ${result.updated} 个技能`, ...result });
  } catch (err) {
    res.status(500).json({ error: `批量操作失败: ${err.message}` });
  }
});

// 测试 prompt
router.post('/test', async (req, res) => {
  try {
    const { skillId, compositionId, context, model } = req.body;
    const result = await skills.testSkill({
      skillId,
      compositionId,
      context: context || {},
      model: model || 'deepseek-chat',
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: `测试失败: ${err.message}` });
  }
});

// ========== 导出/导入 (静态路径，必须在 /:id 之前) ==========

router.post('/export', async (req, res) => {
  try {
    const bundle = skills.exportBundle();
    res.json(bundle);
  } catch (err) {
    res.status(500).json({ error: `导出失败: ${err.message}` });
  }
});

router.post('/import', async (req, res) => {
  try {
    const result = await skills.importBundle(req.body);
    res.json({ message: `导入完成: ${result.skills} 个技能, ${result.compositions} 个组合`, ...result });
  } catch (err) {
    res.status(500).json({ error: `导入失败: ${err.message}` });
  }
});

// ========== Skills CRUD (带 :id，必须在所有静态路径之后) ==========

// 详情
router.get('/:id', async (req, res) => {
  try {
    const version = req.query.version != null ? parseInt(req.query.version) : null;
    if (version != null) {
      const v = await skills.getSkillVersion(req.params.id, version);
      res.json({ skill: v, version });
    } else {
      const skill = skills.getSkill(req.params.id);
      if (!skill) return res.status(404).json({ error: `技能 ${req.params.id} 不存在` });
      res.json({ skill });
    }
  } catch (err) {
    res.status(500).json({ error: `获取技能详情失败: ${err.message}` });
  }
});

// 更新
router.put('/:id', async (req, res) => {
  try {
    const skill = await skills.updateSkill(req.params.id, {
      content: req.body.content,
      name: req.body.name,
      description: req.body.description,
      tags: req.body.tags,
      category: req.body.category,
      priority: req.body.priority,
      variables: req.body.variables,
      enabled: req.body.enabled,
      author: req.body.author || 'api',
      change_summary: req.body.change_summary || '',
    });
    res.json({ skill, version: skill.current_version });
  } catch (err) {
    res.status(500).json({ error: `更新技能失败: ${err.message}` });
  }
});

// 删除
router.delete('/:id', async (req, res) => {
  try {
    await skills.deleteSkill(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: `删除技能失败: ${err.message}` });
  }
});

// ========== 版本管理 (带 :id) ==========

// 版本列表
router.get('/:id/versions', async (req, res) => {
  try {
    const versions = await skills.listVersions(req.params.id);
    res.json({ versions });
  } catch (err) {
    res.status(500).json({ error: `获取版本列表失败: ${err.message}` });
  }
});

// 特定版本内容
router.get('/:id/versions/:v', async (req, res) => {
  try {
    const version = await skills.getSkillVersion(req.params.id, parseInt(req.params.v));
    if (!version) return res.status(404).json({ error: `版本不存在` });
    res.json({ version });
  } catch (err) {
    res.status(500).json({ error: `获取版本失败: ${err.message}` });
  }
});

// 版本对比
router.get('/:id/diff', async (req, res) => {
  try {
    const v1 = parseInt(req.query.v1);
    const v2 = parseInt(req.query.v2);
    if (isNaN(v1) || isNaN(v2)) return res.status(400).json({ error: '请指定 v1 和 v2 参数' });
    const result = await skills.diff(req.params.id, v1, v2);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: `版本对比失败: ${err.message}` });
  }
});

// 回滚
router.post('/:id/rollback', async (req, res) => {
  try {
    const { version, change_summary } = req.body;
    if (!version) return res.status(400).json({ error: '请指定目标版本号' });
    const skill = await skills.rollbackSkill(
      req.params.id,
      version,
      change_summary || `回滚至 v${version}`,
      req.body.author || 'api'
    );
    res.json({ skill, version: skill.current_version, note: `已回滚至 v${version} 内容，当前版本号为 ${skill.current_version}` });
  } catch (err) {
    res.status(500).json({ error: `回滚失败: ${err.message}` });
  }
});

module.exports = router;
