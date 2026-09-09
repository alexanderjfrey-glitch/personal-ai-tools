const MODEL = 'gemini-2.5-flash';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent';

const tools = [{functionDeclarations:[
  {name:'list_tasks',description:'Read the current tasks in the app.',parameters:{type:'object',properties:{}}},
  {name:'add_task',description:'Add a new task to the user’s task list.',parameters:{type:'object',properties:{text:{type:'string'}},required:['text']}},
  {name:'complete_task',description:'Mark a current task complete or incomplete. Use list_tasks first when needed.',parameters:{type:'object',properties:{task_id:{type:'string'},done:{type:'boolean'}},required:['task_id','done']}},
  {name:'search_gmail',description:'Search Gmail and return message metadata/snippets. Use this to find the right email, then use read_gmail for its full contents when needed.',parameters:{type:'object',properties:{query:{type:'string',description:'A Gmail search query such as newer_than:7d, from:name@example.com, or subject:invoice'},max_results:{type:'integer',description:'Number of messages to return, 1-10'}},required:['query','max_results']}},
  {name:'read_gmail',description:'Read the full contents of one Gmail message after finding it with search_gmail.',parameters:{type:'object',properties:{message_id:{type:'string'}},required:['message_id']}}
]}];

const system = `You are the personal AI agent inside Alexander's Personal AI Tools command center. Be helpful, concise, and action-oriented. Use app tools when the user asks you to manage tasks. When the user asks about email, use Gmail tools when Google is connected. Search first, then read a specific message when the user wants details or a summary. Never claim an action happened unless a tool succeeded.`;

function gmailFetch(url, token) {
  return fetch(url,{headers:{Authorization:'Bearer '+token}}).then(async r=>{
    const data=await r.json();
    if(!r.ok) throw new Error(`Gmail API ${r.status}`);
    return data;
  });
}

function decode(v='') {
  try { return Buffer.from(v.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8'); }
  catch (_) { return ''; }
}

function cleanHtml(v='') {
  return v.replace(/<[^>]+>/g,' ').replace(/\\s+/g,' ').trim();
}

function textPart(p) {
  if(!p) return '';
  if(p.mimeType==='text/plain' && p.body?.data) return decode(p.body.data);
  if(p.mimeType==='text/html' && p.body?.data) return cleanHtml(decode(p.body.data));
  if(p.parts) return p.parts.map(textPart).filter(Boolean).join('\\n');
  return '';
}

function getHeaders(m) {
  const h={};
  (m.payload?.headers||[]).forEach(x=>h[String(x.name).toLowerCase()]=x.value||'');
  return h;
}

async function searchGmail(token, query, max=5) {
  const list=await gmailFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults='+Math.min(Math.max(Number(max)||5,1),10)+'&q='+encodeURIComponent(String(query||'')),token);
  const out=[];
  for(const item of (list.messages||[])) {
    const m=await gmailFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/'+item.id+'?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date',token);
    const h=getHeaders(m);
    out.push({id:item.id,date:h.date||'',from:h.from||'',to:h.to||'',subject:h.subject||'',labels:m.labelIds||[],snippet:m.snippet||''});
  }
  return out;
}

async function readGmail(token, messageId) {
  const m=await gmailFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/'+encodeURIComponent(String(messageId||''))+'?format=full',token);
  const h=getHeaders(m);
  return {id:m.id||messageId,date:h.date||'',from:h.from||'',to:h.to||'',subject:h.subject||'',labels:m.labelIds||[],snippet:m.snippet||'',body:textPart(m.payload).slice(0,30000)};
}

function toGeminiHistory(messages) {
  return messages.map(m=>({
    role:m.role==='assistant'?'model':'user',
    parts:[{text:String(m.content||'')}]
  }));
}

async function geminiGenerate(contents, key, toolConfig) {
  const payload={contents,systemInstruction:{parts:[{text:system}]},tools};
  if(toolConfig) payload.toolConfig=toolConfig;
  const r=await fetch(GEMINI_API_URL+'?key='+encodeURIComponent(key),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const data=await r.json();
  if(!r.ok) throw new Error(data?.error?.message||'Gemini request failed.');
  return data;
}

function partsOf(response) {
  return response?.candidates?.[0]?.content?.parts||[];
}

function textOf(response) {
  return partsOf(response).filter(p=>typeof p.text==='string').map(p=>p.text).join('\\n').trim();
}

export default async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'POST only'});
  if(!process.env.GEMINI_API_KEY) return res.status(500).json({error:'GEMINI_API_KEY is not configured on the server.'});
  try {
    const body=req.body||{};
    const messages=Array.isArray(body.messages)?body.messages.slice(-10):[];
    let tasks=Array.isArray(body.tasks)?body.tasks:[];
    const googleAccessToken=typeof body.googleAccessToken==='string'?body.googleAccessToken:'';
    let contents=toGeminiHistory(messages);
    const actions=[];

    for(let step=0;step<5;step++) {
      const response=await geminiGenerate(contents,process.env.GEMINI_API_KEY);
      const parts=partsOf(response);
      const calls=parts.filter(p=>p.functionCall?.name);
      if(!calls.length) {
        return res.status(200).json({text:textOf(response)||'I’m here. What can I help you with?',actions,tasks});
      }

      contents.push({role:'model',parts:parts.filter(Boolean)});
      const resultParts=[];

      for(const part of calls) {
        const call=part.functionCall;
        const args=call.args||{};
        let result;
        if(call.name==='list_tasks') result={tasks};
        else if(call.name==='add_task') {
          const text=String(args.text||'').trim();
          if(!text) result={success:false,error:'Task text was empty.'};
          else {
            const task={id:String(Date.now()+tasks.length),text,done:false};
            tasks=[task,...tasks];
            actions.push({type:'add_task',task});
            result={success:true,task};
          }
        } else if(call.name==='complete_task') {
          const id=String(args.task_id||'');
          const task=tasks.find(t=>String(t.id)===id);
          if(!task) result={success:false,error:'Task not found.'};
          else {
            task.done=Boolean(args.done);
            actions.push({type:'complete_task',task_id:id,done:task.done});
            result={success:true,task};
          }
        } else if(call.name==='search_gmail') {
          if(!googleAccessToken) result={success:false,error:'Google is not connected.'};
          else result={success:true,messages:await searchGmail(googleAccessToken,args.query,args.max_results||5)};
        } else if(call.name==='read_gmail') {
          if(!googleAccessToken) result={success:false,error:'Google is not connected.'};
          else if(!args.message_id) result={success:false,error:'message_id is required.'};
          else result={success:true,message:await readGmail(googleAccessToken,args.message_id)};
        } else result={success:false,error:'Unknown tool.'};

        resultParts.push({functionResponse:{name:call.name,response:result}});
      }
      contents.push({role:'user',parts:resultParts});
    }
    return res.status(200).json({text:'I reached the action limit for this request. Please try that again.',actions,tasks});
  } catch(err) {
    return res.status(500).json({error:err.message||'Server error.'});
  }
}
