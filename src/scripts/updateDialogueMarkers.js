/**
 * 更新 instruction-format-rules skill —— 添加「」对话标记规则
 *
 * 用法: node src/scripts/updateDialogueMarkers.js
 *
 * 这会把新的对话标记指令写入 DB（Supabase）或本地 JSON 回退文件，
 * 然后触发热重载让下次对话立即生效。
 */

const skills = require('../services/skills');

async function main() {
  console.log('🔧 正在更新 instruction-format-rules skill...\n');

  try {
    // 确保 skills registry 已初始化
    await skills.ensureLoaded();

    // 读取旧内容
    const skill = skills.getSkill('instruction-format-rules');
    if (!skill) {
      console.error('❌ 未找到 instruction-format-rules skill');
      process.exit(1);
    }

    // 检查是否已有「」规则
    if (skill.content.includes('角色说出口的对话必须用「」包裹')) {
      console.log('✅ 对话标记规则已存在，无需更新');
      console.log(`   当前版本: v${skill.current_version}`);
      process.exit(0);
    }

    // 准备新内容：在"环境氛围"那行后插入「」标记规则
    const oldLine = '- 你的回复应该包含：环境氛围 + {{identity.name || 角色名}}的身体语言 + 她/他的内心活动 + 她/他实际说出口的话\n- 她/他说话的方式要符合性格';
    const newLine = '- 你的回复应该包含：环境氛围 + {{identity.name || 角色名}}的身体语言 + 她/他的内心活动 + 她/他实际说出口的话\n- **重要：角色说出口的对话必须用「」包裹。** 内心活动、环境描写、旁白叙述、身体语言不要用「」。示例：她靠在窗边看着外面的雨。「带伞了吗？」她的手指绞在一起——这句话她想了三遍才说出口。\n- 她/他说话的方式要符合性格';

    if (!skill.content.includes(oldLine)) {
      // 尝试匹配已包含转义字符的版本
      const altOldLine = '她/他实际说出口的话\\n- 她/他说话的方式要符合性格';
      if (skill.content.includes(altOldLine)) {
        console.log('⚠️  内容格式不同，但似乎是旧版本。尝试更新...');
      } else {
        console.log('⚠️  技能内容格式不匹配，可能已经被修改过。');
        console.log('   请在 SkillManager UI 中手动添加以下内容到 instruction-format-rules：');
        console.log('   ---');
        console.log('   - **重要：角色说出口的对话必须用「」包裹。** 内心活动、环境描写、旁白叙述、身体语言不要用「」');
        console.log('   ---');
        process.exit(0);
      }
    }

    const newContent = skill.content.replace(oldLine, newLine);

    // 通过 skills API 更新（会自动写入 DB + 热重载）
    const updated = await skills.updateSkill('instruction-format-rules', {
      content: newContent,
      author: 'migration',
      change_summary: '添加「」对话标记规则，支持前端叙述/对话分离显示',
    });

    console.log(`✅ 已更新！新版本: v${updated.current_version}`);
    console.log('   下次对话中 AI 将用「」包裹对话内容');
    console.log('   前端可切换"完整模式"和"纯对话模式"');
  } catch (err) {
    console.error('❌ 更新失败:', err.message);
    // 如果是 DB 不可用，提示手动更新
    console.log('\n💡 手动方案: 打开前端 SkillManager → 选择 instruction-format-rules →');
    console.log('   在"环境氛围"那行后添加:');
    console.log('   - **重要：角色说出口的对话必须用「」包裹。** 内心活动、环境描写、旁白叙述、身体语言不要用「」');
    process.exit(1);
  }
}

main();
