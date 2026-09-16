import fs from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { resolve,join } from 'node:path';
import * as XLSX from '@e965/xlsx';
import {startAuditReportMockSystem} from '../../test/fixtures/audit-report-mock-system.ts';
import {loadAuditReportDataset,generateReportDraft,toAuditReportJavaDocument} from '../../src/audit-report/index.ts';
import {reportDocumentMatches} from '../../src/audit-report/report-java-contract.ts';
import {createDefaultRuntimeFactory,startServer} from '../../src/server/main.ts';
const out=resolve(process.argv[2]);
const source=resolve(process.argv[3]);
const envPath=resolve(process.argv[4]);
const readWorkbook=async(path)=>{const wb=XLSX.read(await fs.readFile(path),{type:'buffer'});return Object.fromEntries(wb.SheetNames.map(name=>[name,XLSX.utils.sheet_to_json(wb.Sheets[name],{defval:null})]));};
const tables=await readWorkbook(source);
const extra=await readWorkbook(join(out,'流程与检查模拟补充.xlsx'));
if(process.argv[5]){
 const changes=await readWorkbook(resolve(process.argv[5]));
 for(const change of changes.问题详情输入){
  const record=tables.审计发现.find(f=>f.findingId===change.findingId);
  if(!record)throw Error('Unknown finding in Excel override');
  for(const key of ['policyBasis','factText','rawDetail','internalSubitems'])record[key]=change[key]??'';
 }
}
const regular=tables.审计项目.find(t=>t.reportType==='regular');
const turnover=tables.审计项目.find(t=>t.reportType==='turnover');
tables.审计项目=[...extra.任务补充.map(t=>({... (t.reportType==='turnover'?turnover:regular),...t})),...tables.审计项目.filter(t=>t.auditEnd<regular.auditStart)];
tables.报告流程=extra.报告流程;
tables.业务检查=extra.业务检查;
const mock=await startAuditReportMockSystem(tables);
loadEnvFile(envPath);
process.env.LLM_API_KEY=process.env.DEEPSEEK_API_KEY;
const summary=[];
const datasets=[];
for(const task of tables.审计项目.filter(t=>extra.任务补充.some(x=>x.taskId===t.taskId) && (!process.env.AUDIT_E2E_TASK_TYPE || t.reportType===process.env.AUDIT_E2E_TASK_TYPE))){
 const loaded=await loadAuditReportDataset({taskId:task.taskId,reportType:task.reportType,apiBaseUrl:mock.baseUrl,operatingWorkbookPath:source});
 const draft=generateReportDraft(loaded.dataset);
 await fs.writeFile(join(out,`${task.taskId}-input.json`),JSON.stringify(loaded,null,2));
 const duplicates=loaded.dataset.evidence.filter((e,i,a)=>a.findIndex(x=>x.evidenceId===e.evidenceId)!==i);
 if(duplicates.length){console.log(JSON.stringify({task:task.taskId,duplicates}));continue;}
 const doc=toAuditReportJavaDocument(loaded.dataset,draft);
 await fs.writeFile(join(out,`${task.taskId}-input.json`),JSON.stringify(loaded,null,2));
 await fs.writeFile(join(out,`${task.taskId}-rule-baseline.json`),JSON.stringify(doc,null,2));
 const row={taskId:task.taskId,type:task.reportType,status:draft.status,blockers:draft.blockers,sourceReads:loaded.sourceReadTrace.length,documentChars:JSON.stringify(doc).length,prettyDocumentChars:JSON.stringify(doc,null,2).length,nodes:doc.nodes.length,citations:doc.citations.length,missingBasis:doc.nodes.filter(n=>n.basis?.kind==='missing').map(n=>n.nodeId)};
 summary.push(row); datasets.push({task,dataset:loaded.dataset,doc,row}); console.log(JSON.stringify(row));
}
await fs.writeFile(join(out,'baseline-summary.json'),JSON.stringify(summary,null,2));
if(process.env.AUDIT_E2E_PREFLIGHT_ONLY==='1'){await mock.close();process.exit(0);}
const factory=await createDefaultRuntimeFactory({profilePath:resolve('profiles/deepseek-cloud.json'),workRoot:join(out,'runs'),specsDir:resolve('specs'),auditReportSources:{apiBaseUrl:mock.baseUrl,operatingWorkbookPath:source}});
// Opt-in local mock evaluation only. Production event-store redaction remains unchanged.
const comparisonTrace=[];
const captureFactory=async(input)=>{
 const runtime=await factory(input);
 if(process.env.AUDIT_E2E_CAPTURE_COMPARISONS==='1')runtime.subscribe(event=>{
  const p=event.payload;
  if(event.type!=='tool_execution_end' || p?.toolName!=='submit_report_semantic_job')return;
  const job=p.result?.details?.job;
  if(job?.kind==='compare')comparisonTrace.push({runId:input.runId,taskId:input.options.reportTaskId,jobId:job.id,status:job.status,attempts:job.attempts,errors:job.errors,comparisons:job.comparisons});
 });
 return runtime;
};
const server=await startServer({port:0,dbPath:join(out,`runs-${Date.now()}.sqlite`),specsDir:resolve('specs'),internalToken:'local-e2e-only',runtimeFactory:captureFactory,maxConcurrent:4,maxQueueDepth:4});
const base=`http://127.0.0.1:${server.port}`;
const headers={'content-type':'application/json','X-Internal-Token':'local-e2e-only'};
try{
 await Promise.all(datasets.map(async({task,dataset,doc,row},index)=>{
  const request={taskKind:'audit-report',input:'生成当前任务报告，先读取任务和必要事实，然后调用 generate_report_draft；如无必要不要改写。按任务规范完成报告交付。',sessionId:`e2e-${task.taskId}-${Date.now()}`,clientRequestId:`e2e-${task.taskId}-${Date.now()}`,waitMs:0,filters:{owner:'local-e2e',projectId:task.projectId,corpusTypes:['internal']},options:{reportTaskId:task.taskId,reportType:task.reportType}};
  await fs.writeFile(join(out,`${task.taskId}-request.json`),JSON.stringify(request,null,2));
  let response=await fetch(`${base}/runs`,{method:'POST',headers,body:JSON.stringify(request)});
  let result=await response.json(); const runId=result.runId;row.submitStatus=response.status;
  console.log(JSON.stringify({task:task.taskId,submitted:response.status,runId}));
  const deadline=Date.now()+600000;
  while(['queued','running'].includes(result.status)){
   if(Date.now()>deadline){await fetch(`${base}/runs/${runId}/cancel`,{method:'POST',headers});row.harnessDeadlineExceeded=true;}
   await new Promise(r=>setTimeout(r,1000));
   response=await fetch(`${base}/runs/${runId}`,{headers});result=await response.json();
  }
  await fs.writeFile(join(out,`${task.taskId}-result.json`),JSON.stringify(result,null,2));
  row.liveStatus=result.status;row.error=result.errorMessage;row.stopReason=result.stopReason;row.usage=result.usage;row.sameAsRuleBaseline=result.answer?reportDocumentMatches(doc,result.answer):false;
  if(result.answer)await fs.writeFile(join(out,`${task.taskId}-document.json`),JSON.stringify(result.answer,null,2));
  console.log(JSON.stringify({task:task.taskId,status:row.liveStatus,error:row.error,usage:row.usage}));
 }));
}finally{await fs.writeFile(join(out,'e2e-summary.json'),JSON.stringify(summary,null,2));await fs.writeFile(join(out,'http-source-requests.json'),JSON.stringify(mock.requests,null,2));if(process.env.AUDIT_E2E_CAPTURE_COMPARISONS==='1')await fs.writeFile(join(out,'comparison-trace.json'),JSON.stringify(comparisonTrace,null,2));await server.close();await mock.close();}
