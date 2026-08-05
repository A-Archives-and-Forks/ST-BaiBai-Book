import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

async function importStandalone(relativePath) {
  const sourceUrl = new URL(relativePath, import.meta.url);
  const sourcePath = fileURLToPath(sourceUrl);
  const source = await readFile(sourceUrl, 'utf8');
  const transpiled = ts.transpileModule(source, {
    fileName: sourcePath,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      strict: true,
      verbatimModuleSyntax: true,
    },
  });
  const compileErrors = (transpiled.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error);
  if (compileErrors.length) {
    const host = {
      getCanonicalFileName: fileName => fileName,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => '\n',
    };
    throw new Error(ts.formatDiagnosticsWithColorAndContext(compileErrors, host));
  }
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`;
  return import(moduleUrl);
}

let assertions = 0;
function equal(actual, expected, message) {
  assertions++;
  assert.equal(actual, expected, message);
}
function deepEqual(actual, expected, message) {
  assertions++;
  assert.deepEqual(actual, expected, message);
}
function includes(text, expected, message) {
  assertions++;
  assert.ok(text.includes(expected), message ?? `缺少文本: ${expected}`);
}
function occurrence(text, needle, expected, message) {
  const count = text.split(needle).length - 1;
  equal(count, expected, message ?? `${JSON.stringify(needle)} 出现次数错误`);
}

const { mergeProtagonistDelta } = await importStandalone('../src/memory/protagonist.ts');

// 年龄没有参与补丁时，绝不能误删已有锚点。
deepEqual(
  mergeProtagonistDelta({ age: '18', ageTime: '2020/1/1', identity: '学生' }, { identity: '教师' }),
  { age: '18', ageTime: '2020/1/1', identity: '教师' },
  '编辑非年龄字段不应改变年龄锚点',
);

// 用户修改年龄而未显式给新锚点：必须删除旧锚点，交给当前叶子重新建立。
deepEqual(
  mergeProtagonistDelta({ age: '18', ageTime: '2020/1/1' }, { age: '25' }),
  { age: '25' },
  '修改年龄后旧锚点不应残留',
);

// UI 在年龄未变化时会显式带回原锚点，必须原样保留。
deepEqual(
  mergeProtagonistDelta({ age: '18', ageTime: '2020/1/1' }, { age: '18', ageTime: '2020/1/1' }),
  { age: '18', ageTime: '2020/1/1' },
  '未修改年龄时应保留原锚点',
);

// carryover/导入等调用方显式给了新锚点时，以新锚点为准。
deepEqual(
  mergeProtagonistDelta({ age: '18', ageTime: '2020/1/1' }, { age: '20', ageTime: '2022/1/1' }),
  { age: '20', ageTime: '2022/1/1' },
  '显式新锚点不应被删除',
);

// 清空年龄必须连旧锚点一起移除；随后再次填写也不能复活旧锚点。
const cleared = mergeProtagonistDelta({ age: '18', ageTime: '2020/1/1' }, { age: '' });
deepEqual(cleared, { age: '' }, '清空年龄时应删除锚点');
deepEqual(mergeProtagonistDelta(cleared, { age: '30' }), { age: '30' }, '清空后重新填写不应复活旧锚点');

// 同一叶子连续多次修改时，只保留最终年龄，且没有任何历史锚点泄漏。
const firstEdit = mergeProtagonistDelta({ age: '18', ageTime: '2020/1/1', outfit: '校服' }, { age: '24' });
const secondEdit = mergeProtagonistDelta(firstEdit, { age: '25' });
deepEqual(secondEdit, { age: '25', outfit: '校服' }, '同叶子反复编辑年龄应保持 last-write-wins');

// 合并函数不能改写传入对象，否则 Vue 当前状态或叶子克隆可能被意外污染。
const original = { age: '18', ageTime: '2020/1/1' };
mergeProtagonistDelta(original, { age: '25' });
deepEqual(original, { age: '18', ageTime: '2020/1/1' }, '合并不应修改原对象');

// 直观复现用户看到的故障：新年龄若误套旧锚点会再次增长；锚到当前时间才显示用户输入值。
const { ageDisplay } = await importStandalone('../src/memory/timeRel.ts');
equal(ageDisplay('25', '2020/1/1', '2025/1/1'), '约30岁(2020年时25岁)', '旧锚点会让刚输入的年龄被二次推算');
equal(ageDisplay('25', '2025/1/1', '2025/1/1'), '25', '新年龄锚到当前时间后应原样显示');

const { fmtNpcTiesContext, fmtNpcSummaryList } = await importStandalone('../src/memory/npcRelations.ts');

// 四个对象模拟主要/在场/同区域/不在场。关系块不接收分档，因此必须全部出现且各一次。
const allTiers = fmtNpcTiesContext([
  { name: '主要甲', ties: '乙之父' },
  { name: '在场乙', ties: '主要甲之子' },
  { name: '附近丙', ties: '与丁为宿敌' },
  { name: '远处丁', ties: '丙的宿敌' },
]);
for (const name of ['主要甲', '在场乙', '附近丙', '远处丁']) occurrence(allTiers, `  - ${name}:`, 1, `${name} 的关系应恰好注入一次`);

// 空白字段不产生空壳；多行用户输入必须压成单行，避免破坏提示词结构。
const sparse = fmtNpcTiesContext([
  { name: '无关系', ties: '   ' },
  { name: '多行', ties: '阿黛尔之父\n与镇长有旧怨' },
]);
occurrence(sparse, '无关系', 0, '空 ties 不应生成关系行');
includes(sparse, '  - 多行:阿黛尔之父 与镇长有旧怨', '多行 ties 应压成单行');

// 异常导入可能产生大小写/空白不同的同名项：相同关系去重，不同关系合并且不丢失。
const duplicateLegacy = fmtNpcTiesContext([
  { name: 'Alice', ties: 'Bob之姐；与Carol为宿敌' },
  { name: ' alice ', ties: 'Bob之姐;Dave的主人' },
  { name: 'ALICE', ties: ' 与Carol为宿敌 ' },
]);
occurrence(duplicateLegacy, '  - Alice:', 1, '同名旧数据应合并为一行');
occurrence(duplicateLegacy, 'Bob之姐', 1, '交叠关系不应重复');
occurrence(duplicateLegacy, '与Carol为宿敌', 1, '跨记录重复关系不应重复');
occurrence(duplicateLegacy, 'Dave的主人', 1, '后续独有关系不应丢失');

equal(fmtNpcTiesContext([]), '', '无 NPC 时不应输出关系块');
equal(fmtNpcTiesContext([{ name: '甲', ties: undefined }]), '', '全无 ties 时不应输出关系块');

// 摘要模型看到的旧状态必须同时包含两类关系，且用户多行内容只能占一条 NPC 记录。
const summaryNpc = fmtNpcSummaryList([{
  name: '阿黛尔',
  gender: '女',
  age: '30',
  ageTime: '2024/1/1',
  relation: '主角的导师,态度严厉',
  ties: '鲍勃之姐\n与卡萝有旧怨',
  title: '炼金术师',
  important: true,
  follow: true,
  outfit: '黑袍',
  condition: '左臂受伤',
}]);
occurrence(summaryNpc, '与主角:主角的导师,态度严厉', 1, '摘要输入应包含一次与主角关系');
occurrence(summaryNpc, '人际:鲍勃之姐 与卡萝有旧怨', 1, '摘要输入应包含一次长期关系');
occurrence(summaryNpc, '  - ★ 阿黛尔', 1, '一个 NPC 不应因两类关系被拆成重复记录');
equal(fmtNpcSummaryList([]), '  (无)', '空 NPC 名册应保持既有占位格式');

console.log(`memory regression tests passed: ${assertions} assertions`);
