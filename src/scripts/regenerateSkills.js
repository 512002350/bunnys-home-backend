/**
 * ============================================================
 * Skills 再生脚本 — 用 AI 重新生成每条 skill 的 description 和 content
 * ============================================================
 *
 * 用法:
 *   node src/scripts/regenerateSkills.js                  # 处理所有 skills
 *   node src/scripts/regenerateSkills.js --dry-run        # 仅预览 AI 输出，不写入 DB
 *   node src/scripts/regenerateSkills.js --skill=char-default-core  # 仅处理指定 skill
 *   node src/scripts/regenerateSkills.js --model=deepseek-chat      # 指定模型（默认 deepseek-chat）
 *
 * 工作流程:
 *   1. 从 Supabase 查询所有 skills（或指定 skill）
 *   2. 备份原始数据到 data/skills_backup_<timestamp>.json
 *   3. 逐条调用 AI 重新生成 description 和 content
 *   4. 通过 skills.updateSkill() 写入 DB（自动创建版本记录）
 *   5. 输出变更汇总
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

// ========== 配置 ==========

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const deepseekKey = process.env.DEEPSEEK_API_KEY;
const openrouterKey = process.env.OPENROUTER_API_KEY;
const openrouterBase = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ 缺少 SUPABASE_URL 或 SUPABASE_KEY 环境变量');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ========== 参数解析 ==========

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SKILL_FILTER = args.find(a => a.startsWith('--skill='))?.split('=')[1] || null;
const MODEL = args.find(a => a.startsWith('--model='))?.split('=')[1] || 'deepseek-chat';

// ========== AI 调用 ==========

/**
 * 调用 AI 模型（支持 DeepSeek 直连 和 OpenRouter）
 */
async function callAI(messages, model, temperature = 0.3, maxTokens = 4096) {
  // 判断 provider
  if (model.startsWith('deepseek')) {
    return callDeepSeek(messages, temperature, maxTokens);
  }
  return callOpenRouter(messages, model, temperature, maxTokens);
}

async function callDeepSeek(messages, temperature, maxTokens) {
  if (!deepseekKey) throw new Error('未配置 DEEPSEEK_API_KEY');

  const body = {
    model: 'deepseek-chat',
    messages,
    temperature,
    max_tokens: maxTokens,
  };

  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${deepseekKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`DeepSeek API 错误 ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return {
    content: data.choices?.[0]?.message?.content || '',
    model: data.model || 'deepseek-chat',
    usage: data.usage || null,
  };
}

async function callOpenRouter(messages, model, temperature, maxTokens) {
  if (!openrouterKey) throw new Error('未配置 OPENROUTER_API_KEY');

  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };

  const res = await fetch(`${openrouterBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openrouterKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter API 错误 ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return {
    content: data.choices?.[0]?.message?.content || '',
    model: data.model || model,
    usage: data.usage || null,
  };
}

// ========== AI Prompt 构建 ==========

/**
 * 构建发给 AI 的 system prompt
 */
function buildSystemPrompt() {
  return `你是一个专业的 AI 提示词工程师（Prompt Engineer），精通中文。
你正在为一个 AI 伴侣聊天应用的 "Skills Registry" 系统优化技能定义。

## 系统背景
- 这是一个 AI 伴侣（AI Companion）聊天应用，名叫 "Bunny's Home"
- Skills 是模块化的系统提示词片段，通过模板变量 {{variable}} 在运行时动态组装
- 每个 skill 有 type（类型）和 category（分类），不同类型在组装时扮演不同角色
- Skill 类型：character（角色定义）、style（风格）、instruction（指令）、tool（工具提示词）
- content 字段是实际被注入到 AI 系统提示词中的文本，支持 {{variable.path}} 模板语法
- description 字段是人类可读的简短说明，用于在 UI 中展示

## 你的任务
根据每个 skill 的当前内容，重新生成更优质的 description 和 content。

## 优化原则
1. **description（描述）**：用流畅的中文，清晰说明该 skill 做什么、何时生效。1-2 句话。
2. **content（内容/提示词）**：
   - 保留原有的核心逻辑、模板变量 {{}}、结构
   - 提升表达质量：更清晰、更精准、更有条理
   - 中文表达自然流畅，避免翻译腔
   - 如果是角色定义，保持人设一致性
   - 如果是 tool/instruction，提升指令的精确度
   - 不要改变变量的命名和路径（{{xxx.yyy}} 保持原样）
   - 不要大幅改变 skill 的核心功能——这是优化，不是重写
   - 如果原文已经很好，可以做小幅度润色

## 输出格式
严格按以下 JSON 格式输出（不要包含 markdown 代码块标记，直接输出纯 JSON）:
{
  "description": "新的描述文本",
  "content": "新的内容文本（保持原有变量模板语法）"
}`;
}

/**
 * 为单个 skill 构建 user prompt
 */
function buildUserPrompt(skill) {
  return `请优化以下 skill：

## 基本信息
- ID: ${skill.id}
- 名称: ${skill.name}
- 类型: ${skill.type}${skill.type === 'character' ? '（角色定义）' : skill.type === 'tool' ? '（工具提示词）' : skill.type === 'instruction' ? '（系统指令）' : skill.type === 'style' ? '（风格定义）' : ''}
- 分类: ${skill.category}
- 标签: ${(skill.tags || []).join(', ')}

## 当前描述
${skill.description || '（无）'}

## 当前内容
\`\`\`
${skill.content || ''}
\`\`\`

## 变量定义（如有）
${JSON.stringify(skill.variables || {}, null, 2)}

请输出优化后的 JSON。`;
}

/**
 * 解析 AI 返回的 JSON
 */
function parseAIResponse(rawText) {
  // 尝试提取 JSON（可能被包裹在 markdown 代码块中）
  let jsonStr = rawText.trim();

  // 去掉可能的 markdown 代码块标记
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }

  // 尝试找到第一个 { 到最后一个 }
  const firstBrace = jsonStr.indexOf('{');
  const lastBrace = jsonStr.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
  }

  const parsed = JSON.parse(jsonStr);

  if (!parsed.description || !parsed.content) {
    throw new Error('AI 返回的 JSON 缺少 description 或 content 字段');
  }

  return {
    description: parsed.description.trim(),
    content: parsed.content.trim(),
  };
}

// ========== 备份 ==========

function backupSkills(skills, label = '') {
  const backupDir = path.join(__dirname, '..', '..', 'data');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `skills_backup_${timestamp}${label ? '_' + label : ''}.json`;
  const filepath = path.join(backupDir, filename);

  const backup = {
    backed_up_at: new Date().toISOString(),
    count: skills.length,
    skills: skills.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      content: s.content,
      type: s.type,
      category: s.category,
      tags: s.tags,
      variables: s.variables,
      current_version: s.current_version,
    })),
  };

  fs.writeFileSync(filepath, JSON.stringify(backup, null, 2), 'utf-8');
  console.log(`📦 已备份 ${skills.length} 条 skill → ${filepath}`);
  return filepath;
}

// ========== 写入 DB ==========

/**
 * 通过 skills 服务的 updateSkill 写入（自动版本管理）
 */
async function updateSkillInDB(skillId, updates, author = 'ai-regenerator') {
  // 动态加载 skills 服务以避免循环依赖和缓存问题
  const skillsService = require('../services/skills');

  // 确保缓存已加载
  await skillsService.ensureLoaded();

  return skillsService.updateSkill(skillId, {
    description: updates.description,
    content: updates.content,
    change_summary: 'AI 自动优化：重新生成 description 和 content',
    author,
  });
}

// ========== 单条处理 ==========

async function regenerateSkill(skill, index, total) {
  const prefix = `[${index + 1}/${total}]`;

  console.log(`\n${prefix} 🔄 处理: ${skill.id} (${skill.name})`);
  console.log(`${' '.repeat(prefix.length)}   类型: ${skill.type} | 分类: ${skill.category}`);

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildUserPrompt(skill) },
  ];

  try {
    const result = await callAI(messages, MODEL, 0.3, 4096);
    const parsed = parseAIResponse(result.content);

    console.log(`${' '.repeat(prefix.length)}   📝 新描述: ${parsed.description.slice(0, 80)}${parsed.description.length > 80 ? '...' : ''}`);
    console.log(`${' '.repeat(prefix.length)}   📏 内容长度: ${skill.content.length} → ${parsed.content.length} 字符`);

    if (result.usage) {
      const u = result.usage;
      console.log(`${' '.repeat(prefix.length)}   💰 Token: ${u.prompt_tokens} in / ${u.completion_tokens} out`);
    }

    return {
      skillId: skill.id,
      original: {
        description: skill.description,
        content: skill.content,
      },
      regenerated: parsed,
      success: true,
    };
  } catch (err) {
    console.error(`${' '.repeat(prefix.length)}   ❌ 失败: ${err.message}`);
    return {
      skillId: skill.id,
      original: {
        description: skill.description,
        content: skill.content,
      },
      error: err.message,
      success: false,
    };
  }
}

// ========== 主流程 ==========

async function main() {
  console.log('🔧 Skills 再生脚本');
  console.log(`   模式: ${DRY_RUN ? '🧪 DRY-RUN（预览不写入）' : '✍️  实际写入'}`);
  console.log(`   模型: ${MODEL}`);
  if (SKILL_FILTER) console.log(`   目标: ${SKILL_FILTER}`);
  console.log('');

  // 1. 查询 skills
  console.log('📡 查询数据库...');
  let query = supabase.from('skills').select('*').order('priority', { ascending: true });
  if (SKILL_FILTER) {
    query = query.eq('id', SKILL_FILTER);
  }

  const { data: skills, error } = await query;

  if (error) {
    console.error('❌ 查询失败:', error.message);
    process.exit(1);
  }

  if (!skills || skills.length === 0) {
    console.log('⚠️  没有找到 skills 记录');
    process.exit(0);
  }

  console.log(`   找到 ${skills.length} 条 skill 记录\n`);

  // 2. 备份原始数据
  const backupPath = backupSkills(skills, DRY_RUN ? 'dry-run' : '');

  // 3. 逐条调用 AI 再生
  const results = [];
  for (let i = 0; i < skills.length; i++) {
    const result = await regenerateSkill(skills[i], i, skills.length);
    results.push(result);

    // 请求间隔（避免 API 限流）
    if (i < skills.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // 4. 写入 DB（非 dry-run）
  if (!DRY_RUN) {
    console.log('\n' + '='.repeat(60));
    console.log('💾 写入数据库...\n');

    const successful = results.filter(r => r.success);
    let written = 0;

    for (const result of successful) {
      try {
        await updateSkillInDB(result.skillId, result.regenerated);
        console.log(`   ✅ ${result.skillId} → v${skills.find(s => s.id === result.skillId).current_version + 1}`);
        written++;
      } catch (err) {
        console.error(`   ❌ ${result.skillId} 写入失败: ${err.message}`);
      }

      // 请求间隔
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    console.log(`\n   写入成功: ${written}/${successful.length}`);
  }

  // 5. 汇总报告
  console.log('\n' + '='.repeat(60));
  console.log('📊 汇总报告');
  console.log('='.repeat(60));

  const succeeded = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  console.log(`   总计: ${results.length} 条`);
  console.log(`   成功: ${succeeded.length} 条`);
  console.log(`   失败: ${failed.length} 条`);

  if (failed.length > 0) {
    console.log('\n   失败列表:');
    for (const f of failed) {
      console.log(`     - ${f.skillId}: ${f.error}`);
    }
  }

  // 变更统计
  if (succeeded.length > 0) {
    console.log('\n   变更概览:');
    for (const r of succeeded) {
      const descChanged = r.original.description !== r.regenerated.description;
      const contentChanged = r.original.content !== r.regenerated.content;
      const contentDiff = r.regenerated.content.length - r.original.content.length;

      const changes = [];
      if (descChanged) changes.push('description ✏️');
      if (contentChanged) changes.push(`content ${contentDiff >= 0 ? '+' : ''}${contentDiff}字符`);
      if (!descChanged && !contentChanged) changes.push('无变更');

      console.log(`     ${r.skillId}: ${changes.join(', ')}`);
    }
  }

  // 保存再生结果
  const resultPath = path.join(__dirname, '..', '..', 'data',
    `regenerate_result_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(resultPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    model: MODEL,
    dry_run: DRY_RUN,
    backup_path: backupPath,
    summary: {
      total: results.length,
      succeeded: succeeded.length,
      failed: failed.length,
    },
    results,
  }, null, 2), 'utf-8');
  console.log(`\n📄 详细结果已保存: ${resultPath}`);

  if (DRY_RUN) {
    console.log('\n⚠️  DRY-RUN 模式：以上变更未实际写入数据库。');
    console.log('   确认无误后，运行不带 --dry-run 的命令来执行写入。');
  }

  console.log('\n✅ 完成！');
}

main().catch(err => {
  console.error('\n❌ 脚本执行失败:', err.message);
  console.error(err.stack);
  process.exit(1);
});
