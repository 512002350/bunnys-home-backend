/**
 * ============================================================
 * Skills Registry — 中央技能/提示词管理中心
 * ============================================================
 *
 * 核心职责：
 *   1. 从 Supabase 加载所有 skill → 内存缓存
 *   2. {{变量}} 模板解析与替换
 *   3. 按组合蓝图 (composition) 组装完整 System Prompt
 *   4. 热重载 (不重启服务)
 *   5. CRUD + 语义化版本管理 + Diff + 回滚
 *   6. DB 不可用时自动回退到 data/skills_defaults.json
 */

const fs = require('fs');
const path = require('path');
const { getSupabase, isConfigured } = require('./supabase');

// ========== 内存缓存 ==========

/** @type {Map<string, object>} skillId → { ...row, content } */
const skillCache = new Map();

/** @type {Map<string, object>} compositionId → { ...row } */
const compositionCache = new Map();

let cacheLoaded = false;
let initPromise = null;

// ========== 模板变量解析 ==========

/**
 * 解析模板中的 {{变量}} 占位符
 * - 支持嵌套路径: {{character.identity.name}}
 * - 支持默认值: {{healthSummary || 暂无数据}}
 *
 * @param {string} template - 含 {{var}} 的模板字符串
 * @param {object} context  - 变量上下文对象
 * @returns {string} 替换后的字符串
 */
function resolveVariables(template, context = {}) {
  if (!template || typeof template !== 'string') return template || '';
  return template.replace(
    /{{(\w+(?:\.\w+)*)(?:\s*\|\|\s*([^}]+))?}}/g,
    (match, varPath, fallback) => {
      const value = varPath.split('.').reduce((obj, key) => {
        if (obj === null || obj === undefined) return undefined;
        return obj[key];
      }, context);
      if (value !== undefined && value !== null && value !== '') return String(value);
      return (fallback || '').trim();
    }
  );
}

/**
 * 解析单个 skill 的内容（从缓存取 + 替换变量）
 * 如果解析后内容为空（所有变量都无值 + 无 fallback），返回空字符串
 *
 * @param {string} skillId
 * @param {object} context
 * @returns {Promise<string>} 解析后的文本
 */
async function resolve(skillId, context = {}) {
  await ensureLoaded();
  const skill = skillCache.get(skillId);
  if (!skill) {
    console.warn(`[Skills] 技能不存在: ${skillId}`);
    return '';
  }
  if (!skill.enabled) return '';

  return resolveVariables(skill.content, context);
}

/**
 * 解析裸模板字符串（不依赖 skill ID）
 */
function resolveTemplate(template, context = {}) {
  return resolveVariables(template, context);
}

/**
 * 按组合蓝图组装完整 Prompt
 * @param {string} compositionId - 蓝图 ID
 * @param {object} context        - 全局变量上下文
 * @returns {Promise<string>} 组装后的完整 System Prompt
 */
async function compose(compositionId, context = {}) {
  await ensureLoaded();
  const comp = compositionCache.get(compositionId);
  if (!comp) {
    console.warn(`[Skills] 组合蓝图不存在: ${compositionId}`);
    return '';
  }
  if (!comp.enabled) return '';

  const separator = comp.separator || '\n\n';
  const blocks = [];
  for (const skillId of comp.skill_ids) {
    const block = await resolve(skillId, context);
    if (block && block.trim()) {
      blocks.push(block);
    }
  }
  return blocks.join(separator);
}

/**
 * 按自定义 skill ID 列表组装 Prompt（不走蓝图）
 */
async function composeCustom(skillIds, context = {}, separator = '\n\n') {
  await ensureLoaded();
  const blocks = [];
  for (const skillId of skillIds) {
    const block = await resolve(skillId, context);
    if (block && block.trim()) {
      blocks.push(block);
    }
  }
  return blocks.join(separator);
}

// ========== 缓存管理 ==========

const DEFAULTS_PATH = path.join(__dirname, '..', '..', 'data', 'skills_defaults.json');

/**
 * 确保缓存已加载（懒加载，幂等）
 */
async function ensureLoaded() {
  if (cacheLoaded) return;
  if (initPromise) {
    await initPromise;
    return;
  }
  return init();
}

/**
 * 加载所有 skill 到内存
 */
async function init() {
  if (initPromise) {
    await initPromise;
    return;
  }

  initPromise = (async () => {
    const db = getSupabase();
    const dbOk = isConfigured() && db;

    if (dbOk) {
      try {
        // 加载 skills
        const { data: skills, error: skillsErr } = await db
          .from('skills')
          .select('*')
          .order('priority', { ascending: true });

        if (skillsErr) throw skillsErr;

        skillCache.clear();
        for (const s of (skills || [])) {
          skillCache.set(s.id, s);
        }

        // 加载 compositions
        const { data: comps, error: compsErr } = await db
          .from('prompt_compositions')
          .select('*');

        if (compsErr) throw compsErr;

        compositionCache.clear();
        for (const c of (comps || [])) {
          compositionCache.set(c.id, c);
        }

        cacheLoaded = true;
        console.log(`[Skills] 已加载 ${skillCache.size} 个技能, ${compositionCache.size} 个组合蓝图 (来源: DB)`);
      } catch (err) {
        console.error('[Skills] DB 加载失败，回退到本地默认文件:', err.message);
        await loadDefaults();
      }
    } else {
      await loadDefaults();
    }

    initPromise = null;
  })();

  return initPromise;
}

/**
 * 从 data/skills_defaults.json 加载回退数据
 */
async function loadDefaults() {
  try {
    if (!fs.existsSync(DEFAULTS_PATH)) {
      console.warn('[Skills] skills_defaults.json 不存在，Skills 系统无数据');
      cacheLoaded = true;
      return;
    }
    const raw = fs.readFileSync(DEFAULTS_PATH, 'utf-8');
    const bundle = JSON.parse(raw);

    skillCache.clear();
    for (const s of (bundle.skills || [])) {
      skillCache.set(s.id, s);
    }

    compositionCache.clear();
    for (const c of (bundle.compositions || [])) {
      compositionCache.set(c.id, c);
    }

    cacheLoaded = true;
    console.log(`[Skills] 已加载 ${skillCache.size} 个技能, ${compositionCache.size} 个组合蓝图 (来源: defaults JSON)`);
  } catch (err) {
    console.error('[Skills] 默认文件加载失败:', err.message);
    cacheLoaded = true;
  }
}

/**
 * 全量热重载
 */
async function reloadAll() {
  cacheLoaded = false;
  skillCache.clear();
  compositionCache.clear();
  await init();
  return { reloaded: skillCache.size + compositionCache.size };
}

/**
 * 热重载单个 skill
 */
async function reloadSkill(skillId) {
  const db = getSupabase();
  if (!isConfigured() || !db) {
    throw new Error('数据库不可用，无法热重载');
  }
  const { data, error } = await db
    .from('skills')
    .select('*')
    .eq('id', skillId)
    .single();
  if (error) throw error;
  if (!data) throw new Error(`Skill ${skillId} 不存在`);

  skillCache.set(skillId, data);
  console.log(`[Skills] 热重载: ${skillId} v${data.current_version}`);
  return getSkill(skillId);
}

/**
 * 热重载单个组合蓝图
 */
async function reloadComposition(compositionId) {
  const db = getSupabase();
  if (!isConfigured() || !db) {
    throw new Error('数据库不可用，无法热重载');
  }
  const { data, error } = await db
    .from('prompt_compositions')
    .select('*')
    .eq('id', compositionId)
    .single();
  if (error) throw error;
  if (!data) throw new Error(`Composition ${compositionId} 不存在`);

  compositionCache.set(compositionId, data);
  return data;
}

// ========== 查询 ==========

function getSkill(skillId) {
  return skillCache.get(skillId) || null;
}

function getAllSkills(opts = {}) {
  let list = [...skillCache.values()];
  if (opts.type) list = list.filter(s => s.type === opts.type);
  if (opts.category) list = list.filter(s => s.category === opts.category);
  if (opts.enabled !== undefined) list = list.filter(s => s.enabled === opts.enabled);
  if (opts.search) {
    const q = opts.search.toLowerCase();
    list = list.filter(s =>
      (s.name && s.name.toLowerCase().includes(q)) ||
      (s.id && s.id.toLowerCase().includes(q)) ||
      (s.description && s.description.toLowerCase().includes(q)) ||
      (s.tags && s.tags.some(t => t.toLowerCase().includes(q)))
    );
  }
  if (opts.tags && opts.tags.length) {
    list = list.filter(s =>
      s.tags && opts.tags.some(t => s.tags.includes(t))
    );
  }
  return list;
}

function getAllCompositions() {
  return [...compositionCache.values()];
}

function getComposition(id) {
  return compositionCache.get(id) || null;
}

// ========== CRUD ==========

/**
 * 创建新 skill
 */
async function createSkill(data) {
  const db = getSupabase();
  if (!isConfigured() || !db) throw new Error('数据库不可用');

  const now = new Date().toISOString();
  const row = {
    id: data.id,
    name: data.name,
    description: data.description || '',
    type: data.type,
    category: data.category || 'general',
    content: data.content,
    variables: data.variables || {},
    tags: data.tags || [],
    priority: data.priority || 100,
    enabled: data.enabled !== undefined ? data.enabled : true,
    is_builtin: false,
    current_version: 1,
    created_at: now,
    updated_at: now,
  };

  const { data: inserted, error } = await db
    .from('skills')
    .insert(row)
    .select()
    .single();
  if (error) throw error;

  // 创建 v1 版本记录
  await insertVersion(inserted.id, 1, inserted.content, null, 'create', data.author || 'system');

  // 更新缓存
  skillCache.set(inserted.id, inserted);
  console.log(`[Skills] 创建: ${inserted.id} v1`);
  return inserted;
}

/**
 * 更新 skill（自动生成新版本 + diff）
 */
async function updateSkill(skillId, data) {
  const db = getSupabase();
  if (!isConfigured() || !db) throw new Error('数据库不可用');

  const existing = skillCache.get(skillId);
  if (!existing) throw new Error(`Skill ${skillId} 不存在`);

  const newVersion = (existing.current_version || 0) + 1;
  const newContent = data.content;
  const oldContent = existing.content;

  // 生成 diff
  const diff = generateDiff(oldContent, newContent);

  const updates = {
    content: newContent,
    current_version: newVersion,
    updated_at: new Date().toISOString(),
  };
  if (data.name !== undefined) updates.name = data.name;
  if (data.description !== undefined) updates.description = data.description;
  if (data.tags !== undefined) updates.tags = data.tags;
  if (data.category !== undefined) updates.category = data.category;
  if (data.priority !== undefined) updates.priority = data.priority;
  if (data.variables !== undefined) updates.variables = data.variables;
  if (data.enabled !== undefined) updates.enabled = data.enabled;

  const { data: updated, error } = await db
    .from('skills')
    .update(updates)
    .eq('id', skillId)
    .select()
    .single();
  if (error) throw error;

  // 插入新版本记录
  await insertVersion(skillId, newVersion, newContent, diff, 'update', data.author || 'system', data.change_summary || '');

  // 更新缓存
  skillCache.set(skillId, updated);
  console.log(`[Skills] 更新: ${skillId} → v${newVersion}`);
  return updated;
}

/**
 * 删除 skill（级联删除版本记录）
 */
async function deleteSkill(skillId) {
  const db = getSupabase();
  if (!isConfigured() || !db) throw new Error('数据库不可用');

  const existing = skillCache.get(skillId);
  if (!existing) throw new Error(`Skill ${skillId} 不存在`);

  const { error } = await db
    .from('skills')
    .delete()
    .eq('id', skillId);
  if (error) throw error;

  skillCache.delete(skillId);
  console.log(`[Skills] 删除: ${skillId}`);
  return { success: true };
}

/**
 * 开关 skill
 */
async function toggleSkill(skillId, enabled) {
  const db = getSupabase();
  if (!isConfigured() || !db) throw new Error('数据库不可用');

  const { data, error } = await db
    .from('skills')
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq('id', skillId)
    .select()
    .single();
  if (error) throw error;

  skillCache.set(skillId, data);
  return data;
}

// ========== 版本管理 ==========

async function insertVersion(skillId, version, content, diff, changeType, author, changeSummary = '') {
  const db = getSupabase();
  if (!isConfigured() || !db) return;

  const row = {
    skill_id: skillId,
    version,
    content,
    change_summary: changeSummary,
    change_diff: diff || '',
    change_type: changeType,
    author: author || 'system',
  };
  await db.from('skill_versions').insert(row);
}

async function getSkillVersion(skillId, version) {
  const db = getSupabase();
  if (!isConfigured() || !db) throw new Error('数据库不可用');

  const { data, error } = await db
    .from('skill_versions')
    .select('*')
    .eq('skill_id', skillId)
    .eq('version', version)
    .single();
  if (error) throw error;
  return data;
}

async function listVersions(skillId) {
  const db = getSupabase();
  if (!isConfigured() || !db) return [];

  const { data, error } = await db
    .from('skill_versions')
    .select('id, skill_id, version, change_summary, change_type, author, created_at')
    .eq('skill_id', skillId)
    .order('version', { ascending: false });
  if (error) throw error;
  return data || [];
}

/**
 * 回滚到指定版本（生成新版本指向旧内容）
 */
async function rollbackSkill(skillId, targetVersion, changeSummary, author) {
  const db = getSupabase();
  if (!isConfigured() || !db) throw new Error('数据库不可用');

  const target = await getSkillVersion(skillId, targetVersion);
  if (!target) throw new Error(`Skill ${skillId} v${targetVersion} 不存在`);

  // 用旧内容创建新版本
  return updateSkill(skillId, {
    content: target.content,
    author: author || 'system',
    change_summary: changeSummary || `回滚至 v${targetVersion}`,
  });
}

/**
 * 对比两个版本，返回 unified diff
 */
async function diff(skillId, v1, v2) {
  const db = getSupabase();
  if (!isConfigured() || !db) throw new Error('数据库不可用');

  const [ver1, ver2] = await Promise.all([
    getSkillVersion(skillId, v1).catch(() => null),
    getSkillVersion(skillId, v2).catch(() => null),
  ]);
  if (!ver1 || !ver2) throw new Error('版本不存在');

  return {
    v1,
    v2,
    content_v1: ver1.content,
    content_v2: ver2.content,
    diff: generateDiff(ver1.content, ver2.content),
  };
}

// ========== 组合蓝图管理 ==========

async function updateComposition(id, data) {
  const db = getSupabase();
  if (!isConfigured() || !db) throw new Error('数据库不可用');

  const updates = { updated_at: new Date().toISOString() };
  if (data.skill_ids !== undefined) updates.skill_ids = data.skill_ids;
  if (data.name !== undefined) updates.name = data.name;
  if (data.description !== undefined) updates.description = data.description;
  if (data.separator !== undefined) updates.separator = data.separator;
  if (data.enabled !== undefined) updates.enabled = data.enabled;

  const { data: updated, error } = await db
    .from('prompt_compositions')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;

  compositionCache.set(id, updated);
  return updated;
}

/**
 * 创建组合蓝图
 */
async function createComposition(data) {
  const db = getSupabase();
  if (!isConfigured() || !db) throw new Error('数据库不可用');

  const row = {
    id: data.id,
    name: data.name,
    description: data.description || '',
    skill_ids: data.skill_ids || [],
    separator: data.separator || '\n\n',
    enabled: data.enabled !== undefined ? data.enabled : true,
  };
  const { data: inserted, error } = await db
    .from('prompt_compositions')
    .insert(row)
    .select()
    .single();
  if (error) throw error;

  compositionCache.set(inserted.id, inserted);
  return inserted;
}

// ========== 批量操作 ==========

async function batchToggle(skillIds, enabled) {
  const db = getSupabase();
  if (!isConfigured() || !db) throw new Error('数据库不可用');

  const { error } = await db
    .from('skills')
    .update({ enabled, updated_at: new Date().toISOString() })
    .in('id', skillIds);
  if (error) throw error;

  // 更新缓存
  for (const id of skillIds) {
    const s = skillCache.get(id);
    if (s) {
      s.enabled = enabled;
      skillCache.set(id, s);
    }
  }
  return { updated: skillIds.length };
}

// ========== 导出/导入 ==========

function exportBundle() {
  return {
    exported_at: new Date().toISOString(),
    skills: [...skillCache.values()],
    compositions: [...compositionCache.values()],
  };
}

async function importBundle(bundle) {
  const db = getSupabase();
  if (!isConfigured() || !db) throw new Error('数据库不可用');

  let imported = { skills: 0, compositions: 0 };

  for (const skill of (bundle.skills || [])) {
    try {
      // upsert: 先删再插
      await db.from('skills').delete().eq('id', skill.id);
      await db.from('skill_versions').delete().eq('skill_id', skill.id);

      await db.from('skills').insert({
        ...skill,
        is_builtin: false,
        current_version: skill.current_version || 1,
        created_at: skill.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      // 重建缓存
      const { data: refreshed } = await db.from('skills').select('*').eq('id', skill.id).single();
      if (refreshed) skillCache.set(skill.id, refreshed);

      imported.skills++;
    } catch (err) {
      console.warn(`[Skills] 导入 skill ${skill.id} 失败:`, err.message);
    }
  }

  for (const comp of (bundle.compositions || [])) {
    try {
      await db.from('prompt_compositions').upsert({
        ...comp,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });

      const { data: refreshed } = await db.from('prompt_compositions').select('*').eq('id', comp.id).single();
      if (refreshed) compositionCache.set(comp.id, refreshed);

      imported.compositions++;
    } catch (err) {
      console.warn(`[Skills] 导入 composition ${comp.id} 失败:`, err.message);
    }
  }

  return imported;
}

// ========== Diff 生成（纯 Node.js，无外部依赖） ==========

/**
 * 生成两个文本的 unified diff
 * 简单的逐行 LCS 算法实现
 */
function generateDiff(oldText, newText) {
  if (!oldText && !newText) return '';
  if (!oldText) return `+ 全部新增 (${newText.split('\n').length} 行)`;
  if (!newText) return `- 全部删除 (${oldText.split('\n').length} 行)`;

  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  // 使用简单的逐行比较（非 LCS，但实用）
  const diffLines = [];
  const maxLen = Math.max(oldLines.length, newLines.length);
  let addedCount = 0, removedCount = 0;

  // 对短文本用 LCS，对长文本用简单比较
  if (oldLines.length + newLines.length <= 500) {
    const lcsResult = computeLCS(oldLines, newLines);
    diffLines.push(...lcsResult);
    // 统计
    for (const line of lcsResult) {
      if (line.startsWith('+ ')) addedCount++;
      else if (line.startsWith('- ')) removedCount++;
    }
  } else {
    // 长文本：逐行对比
    for (let i = 0; i < maxLen; i++) {
      if (i >= oldLines.length) {
        diffLines.push(`+ ${newLines[i]}`);
        addedCount++;
      } else if (i >= newLines.length) {
        diffLines.push(`- ${oldLines[i]}`);
        removedCount++;
      } else if (oldLines[i] !== newLines[i]) {
        diffLines.push(`- ${oldLines[i]}`);
        diffLines.push(`+ ${newLines[i]}`);
        removedCount++;
        addedCount++;
      } else {
        diffLines.push(`  ${oldLines[i]}`);
      }
    }
  }

  return `@@ -${removedCount},+${addedCount} @@\n${diffLines.join('\n')}`;
}

/**
 * 简单 LCS 实现，返回 diff 格式的行数组
 */
function computeLCS(a, b) {
  const m = a.length;
  const n = b.length;

  // 构建 LCS 表
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // 回溯生成 diff
  const result = [];
  let i = m, j = n;
  const stack = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      stack.push(`  ${a[i - 1]}`);
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push(`+ ${b[j - 1]}`);
      j--;
    } else {
      stack.push(`- ${a[i - 1]}`);
      i--;
    }
  }

  while (stack.length > 0) result.push(stack.pop());
  return result;
}

// ========== 测试（用真实模型测试 prompt 效果） ==========

async function testSkill({ skillId, compositionId, context, model }) {
  const ai = require('./ai');

  let prompt;
  if (compositionId) {
    prompt = await compose(compositionId, context || {});
  } else if (skillId) {
    prompt = await resolve(skillId, context || {});
  } else {
    throw new Error('请指定 skillId 或 compositionId');
  }

  const result = await ai.callModel(
    [{ role: 'user', content: '(测试消息)' }],
    model || 'deepseek-chat',
    { temperature: 0.7, max_response_tokens: 512 },
    prompt,
    [] // no memory summaries for testing
  );

  return {
    system_prompt: prompt,
    response: result.content,
    model: result.model,
    usage: result.usage,
  };
}

// ========== 导出 ==========

module.exports = {
  // 生命周期
  init,
  ensureLoaded,
  reloadAll,
  reloadSkill,
  reloadComposition,

  // 模板与组合
  resolve,
  resolveTemplate,
  resolveVariables,
  compose,
  composeCustom,

  // 查询
  getSkill,
  getAllSkills,
  getAllCompositions,
  getComposition,

  // CRUD
  createSkill,
  updateSkill,
  deleteSkill,
  toggleSkill,

  // 版本管理
  getSkillVersion,
  listVersions,
  diff,
  rollbackSkill,

  // 组合蓝图
  createComposition,
  updateComposition,

  // 批量
  batchToggle,

  // 导出/导入
  exportBundle,
  importBundle,

  // 测试
  testSkill,

  // 工具
  generateDiff,
};
