import fs from 'node:fs/promises';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {scoreStrictReportClaims} from '../../src/audit-report/report-strict-rubric.ts';
import {renderReportMarkdown} from '../../src/audit-report/report-pipeline.ts';
import {planReportSemantics,parseSemanticPolicy} from '../../src/audit-report/report-semantic.ts';
const out=process.argv[2];
const policy=parseSemanticPolicy(JSON.parse(await fs.readFile('specs/audit-report/skills/semantic-policy.json','utf8')));
const rows=[];
const text=['# 按需语义处理效果对比','', '以下为模拟数据的实际运行结果。分段保留完整业务块，归纳仅补充必要类别概括；历史compare作业判断两期具体缺陷是否一致。确定性逐句分数不等于模型判断已被独立核验。',''];
for(const file of (await fs.readdir(out)).filter(f=>f.endsWith('-document.json'))){
 const id=file.replace('-document.json','');
 const document=JSON.parse(await fs.readFile(join(out,file),'utf8'));
 const before=JSON.parse(await fs.readFile(join(out,`${id}-rule-baseline.json`),'utf8'));
 const {dataset}=JSON.parse(await fs.readFile(join(out,`${id}-input.json`),'utf8'));
 const plan=planReportSemantics(dataset,before.report,policy);
 const map=new Map(before.nodes.map(n=>[n.nodeId,n]));
 const changes=document.nodes.filter(n=>n.text!==map.get(n.nodeId)?.text);
 const allowed=new Set(plan.jobs.flatMap(j=>j.paragraphIds));
 if(plan.jobs.some(j=>j.kind==='compare'))allowed.add('turnover-conclusion');
 const checks={noUnplannedChanges:changes.every(n=>allowed.has(n.nodeId)), structurePreserved:document.structureHash===before.structureHash,
  citationsPreserved:isDeepStrictEqual(document.citations,before.citations),nodeIdsPreserved:isDeepStrictEqual(document.nodes.map(n=>n.nodeId),before.nodes.map(n=>n.nodeId)),
  originalSentencesPreserved:plan.jobs.filter(j=>j.kind==='organize').every(j=>j.paragraphIds.every(pid=>document.nodes.find(n=>n.nodeId===pid).text.replaceAll('\n','')===map.get(pid).text.replaceAll('\n','')))};
 const score=scoreStrictReportClaims(dataset,document.report);
 await fs.writeFile(join(out,`${id}-strict-claims.json`),JSON.stringify(score,null,2));
 await fs.writeFile(join(out,`${id}-报告预览.md`),renderReportMarkdown(document.report));
 rows.push({id,plannedJobs:plan.jobs.map(j=>({id:j.id,kind:j.kind,reason:j.reason})),changedParagraphs:changes.map(n=>n.nodeId),checks,strict:{passed:score.passedSentenceCount,total:score.sentenceCount,failed:score.sentences.filter(s=>s.value===0).map(s=>({text:s.text,reason:s.reason}))}});
 text.push(`## ${id}`,'',`计划处理${plan.jobs.length}项，实际改变${changes.length}个段落；逐句评分${score.passedSentenceCount}/${score.sentenceCount}。`,'');
 if(!changes.length)text.push('最终正文保持规则原文；是否执行过作业请见上方计划项数。','');
 for(const n of changes){text.push(`### ${n.nodeId}`,'','处理前：','',map.get(n.nodeId).text,'','处理后：','',n.text,'');}
}
await fs.writeFile(join(out,'semantic-comparison.json'),JSON.stringify(rows,null,2));
await fs.writeFile(join(out,'接入前后对比.md'),text.join('\n'));
console.log(JSON.stringify(rows));
