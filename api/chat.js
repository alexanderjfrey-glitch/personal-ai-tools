async function openaiResponses(input, tools, instructions) {
  const r = await fetch('https://api.openai.com/v1/responses', {method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-5.6-luna',instructions,tools,input,max_output_tokens:2200})});
  const data=await r.json(); if(!r.ok) throw new Error(data?.error?.message||'OpenAI request failed.'); return data;
}
const tools=[
 {type:'function',name:'list_tasks',description:'Read the current tasks in the app.',parameters:{type:'object',properties:{},additionalProperties:false},strict:true},
 {type:'function',name:'add_task',description:'Add a new task to the user’s task list.',parameters:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},strict:true},
 {type:'function',name:'complete_task',description:'Mark a current task complete or incomplete. Use list_tasks first when needed.',parameters:{type:'object',properties:{task_id:{type:'string'},done:{type:'boolean'}},required:['task_id','done'],additionalProperties:false},strict:true},
 {type:'function',name:'search_gmail',description:'Search the connected Gmail account and return readable message bodies.',parameters:{type:'object',properties:{query:{type:'string'},max_results:{type:'integer',minimum:1,maximum:20}},required:['query'],additionalProperties:false},strict:true}
];
function gmailFetch(url,token,options={}){return fetch(url,{...options,headers:{...(options.headers||{}),Authorization:`Bearer ${token}`}}).then(async r=>{if(!r.ok)throw new Error(`Gmail API ${r.status}`);return r.json()})}
function decode(v=''){try{return Buffer.from(v.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8')}catch(_){return ''}}
function textPart(p){if(!p)return '';if(p.body?.data&&p.mimeType==='text/plain')return decode(p.body.data);if(p.parts)return p.parts.map(textPart).filter(Boolean).join('\n');if(p.body?.data&&p.mimeType==='text/html')return decode(p.body.data).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();return ''}
function headers(m){const h={};(m.payload?.headers||[]).forEach(x=>h[String(x.name).toLowerCase()]=x.value||'');return h}
async function searchGmail(token,query,max=10){const list=await gmailFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${Math.min(max,20)}&q=${encodeURIComponent(query)}`,token);const out=[];for(const item of (list.messages||[])){const m=await gmailFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${item.id}?format=full`,token);const h=headers(m);out.push({id:item.id,date:h.date||'',from:h.from||'',to:h.to||'',subject:h.subject||'',labels:m.labelIds||[],snippet:m.snippet||'',body:textPart(m.payload).slice(0,20000)});}return out}
export default async function handler(req,res){
 if(req.method!=='POST')return res.status(405).json({error:'POST only'}); if(!process.env.OPENAI_API_KEY)return res.status(500).json({error:'OPENAI_API_KEY is not configured on the server.'});
 try{
  const body=req.body||{},messages=Array.isArray(body.messages)?body.messages.slice(-20):[]; let tasks=Array.isArray(body.tasks)?body.tasks:[]; const googleAccessToken=typeof body.googleAccessToken==='string'?body.googleAccessToken:'';
  const system=`You are the action-oriented AI agent inside Alexander's Personal AI Tools command center. Use tools to operate the app, not merely discuss what the user could do. Use app tools for task requests. Use Gmail search for email questions when Google is connected. Never claim an action happened unless the tool succeeded. Be concise and practical.`;
  const input=messages.map(m=>({role:m.role==='assistant'?'assistant':'user',content:String(m.content||'')})); let response=await openaiResponses(input,tools,system); const actions=[];
  for(let step=0;step<5;step++){
   const calls=(response.output||[]).filter(x=>x.type==='function_call'); if(!calls.length)break; input.push(...(response.output||[]));
   for(const call of calls){let args={};try{args=JSON.parse(call.arguments||'{}')}catch(_){} let result;
    if(call.name==='list_tasks') result={tasks};
    else if(call.name==='add_task'){const task={id:String(Date.now()+tasks.length),text:String(args.text||'').trim(),done:false};result=task.text?{success:true,task}:{success:false,error:'Task text was empty.'};if(result.success){tasks=[task,...tasks];actions.push({type:'add_task',task});}}
    else if(call.name==='complete_task'){const id=String(args.task_id),task=tasks.find(t=>String(t.id)===id);if(task){task.done=Boolean(args.done);result={success:true,task};actions.push({type:'complete_task',task_id:id,done:task.done});}else result={success:false,error:'Task not found.'};}
    else if(call.name==='search_gmail'){if(!googleAccessToken)result={success:false,error:'Google is not connected.'};else result={success:true,messages:await searchGmail(googleAccessToken,args.query,args.max_results||10)};}
    else result={success:false,error:'Unknown tool.'}; input.push({type:'function_call_output',call_id:call.call_id,output:JSON.stringify(result)});
   }
   response=await openaiResponses(input,tools,system);
  }
  return res.status(200).json({text:response.output_text||'Done.',actions,tasks});
 }catch(err){return res.status(500).json({error:err.message||'Server error.'})}
}
