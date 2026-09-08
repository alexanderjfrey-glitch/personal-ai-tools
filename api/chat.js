function decodeBase64Url(value='') {
  try { return Buffer.from(value.replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf8'); } catch (_) { return ''; }
}

function extractText(part) {
  if (!part) return '';
  const mime = String(part.mimeType || '').toLowerCase();
  if (mime === 'text/plain' && part.body?.data) return decodeBase64Url(part.body.data);
  if (Array.isArray(part.parts)) return part.parts.map(extractText).filter(Boolean).join('\n');
  if (mime === 'text/html' && part.body?.data) return decodeBase64Url(part.body.data).replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
  return '';
}

function getHeaders(message) {
  const h = {};
  (message.payload?.headers || []).forEach(x => h[String(x.name).toLowerCase()] = x.value || '');
  return h;
}

async function gmailFetch(url, token, options={}) {
  const r = await fetch(url, { ...options, headers:{...(options.headers||{}), Authorization:`Bearer ${token}`} });
  if (!r.ok) throw new Error(`Gmail API ${r.status}: ${await r.text()}`);
  return r.json();
}

async function searchGmail(token, query, maxResults=20) {
  const list=await gmailFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${Math.min(maxResults,30)}&q=${encodeURIComponent(query)}`,token);
  const detailed=[];
  for(const item of (list.messages||[]).slice(0,30)) {
    try {
      const m=await gmailFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${item.id}?format=full`,token);
      const h=getHeaders(m);
      detailed.push({id:item.id,date:h.date||'',from:h.from||'',to:h.to||'',subject:h.subject||'',labels:m.labelIds||[],snippet:m.snippet||'',body:extractText(m.payload).slice(0,12000)});
    } catch (_) {}
  }
  return detailed;
}

const tools=[
  {type:'function',name:'search_gmail',description:'Search the user\'s real Gmail and return matching messages with sender, recipient, subject, date, labels, snippet, and readable body text. Use this whenever the user asks about email, a person, a company, a phone number in email, a conversation, or a follow-up.',parameters:{type:'object',properties:{query:{type:'string',description:'Gmail search query. Use Gmail syntax when useful, for example from:, to:, subject:, newer_than:, after:, before:, or a quoted name.'},max_results:{type:'integer',minimum:1,maximum:30}},required:['query'],additionalProperties:false},strict:true},
  {type:'function',name:'get_gmail_labels',description:'Get the user\'s current Gmail user labels. Use this before recommending or applying a Gmail label.',parameters:{type:'object',properties:{},additionalProperties:false},strict:true},
  {type:'function',name:'label_gmail_message',description:'Apply an existing Gmail label to a message. If remove_from_inbox is true, also remove it from the Inbox. Only use an existing label ID returned by get_gmail_labels or known from retrieved message labels.',parameters:{type:'object',properties:{message_id:{type:'string'},label_id:{type:'string'},remove_from_inbox:{type:'boolean'}},required:['message_id','label_id','remove_from_inbox'],additionalProperties:false},strict:true}
];

async function runTool(name,args,token) {
  if(name==='search_gmail') return {messages:await searchGmail(token,args.query,args.max_results||20)};
  if(name==='get_gmail_labels') {
    const d=await gmailFetch('https://gmail.googleapis.com/gmail/v1/users/me/labels',token);
    return {labels:(d.labels||[]).filter(x=>x.type==='user').map(x=>({id:x.id,name:x.name}))};
  }
  if(name==='label_gmail_message') {
    await gmailFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(args.message_id)}/modify`,token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({addLabelIds:[args.label_id],removeLabelIds:args.remove_from_inbox?['INBOX']:[]})});
    return {success:true,message_id:args.message_id,label_id:args.label_id,removed_from_inbox:args.remove_from_inbox};
  }
  throw new Error(`Unknown tool: ${name}`);
}

export default async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'POST only'});
  if(!process.env.OPENAI_API_KEY) return res.status(500).json({error:'OPENAI_API_KEY is not configured on the server.'});
  try {
    const body=req.body||{};
    const messages=Array.isArray(body.messages)?body.messages.slice(-20):[];
    const googleAccessToken=typeof body.googleAccessToken==='string'?body.googleAccessToken:'';
    const latest=String([...messages].reverse().find(m=>m.role==='user')?.content||'');
    let gmailConnected=false;
    if(googleAccessToken){
      try { await gmailFetch('https://gmail.googleapis.com/gmail/v1/users/me/profile',googleAccessToken); gmailConnected=true; } catch (_) {}
    }

    const system=`You are the AI agent inside Alexander's Personal AI Tools command center. You are not a passive chatbot. You have tools and should use them to accomplish the user's request.

Your operating rules:
- If the user asks about Gmail, email, a person, a company, a phone number, a conversation, a follow-up, or organizing email, use the Gmail tools instead of saying you cannot access email.
- Search intelligently. Start with a focused Gmail query, then broaden it if needed. For a person's phone number, inspect message bodies and signatures, not just subjects/snippets.
- When organizing email, inspect the available Gmail labels and choose an appropriate existing label. Do not invent a label ID.
- You may apply a Gmail label when the user's request clearly asks you to organize/move/label the email. For ambiguous recommendations, explain the recommendation instead of taking the action.
- Never invent a phone number, sender, message, label, or action result. If the data is not found, say exactly that.
- If Gmail is not connected, tell the user to connect Google in the app. Do not pretend you searched.
- Be concise and practical. Say what you found and what you did.
- You are the agent brain; the web/app interface is only the shell around you.`;

    if(!gmailConnected && /\b(gmail|email|emails|inbox|mail|roger|cab[- ]?con|hire nelson|system inc|clean kayak|phone number|contact)\b/i.test(latest)) {
      return res.status(200).json({text:'Google is not connected to the agent yet. Tap “Connect Google” in the app, then ask me again. I will search the real Gmail account rather than guessing.',gmailStatus:'not_connected'});
    }

    let input=messages.map(m=>({role:m.role==='assistant'?'assistant':'user',content:String(m.content||'')}));
    const actions=[];
    let response=null;

    for(let step=0;step<5;step++) {
      const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-5.6-luna',instructions:system,tools,input,max_output_tokens:2200})});
      const data=await r.json();
      if(!r.ok) return res.status(r.status).json({error:data?.error?.message||'OpenAI request failed.'});
      response=data;
      const calls=(data.output||[]).filter(x=>x.type==='function_call');
      if(!calls.length) break;
      input.push(...(data.output||[]));
      for(const call of calls){
        let args={};
        try{args=JSON.parse(call.arguments||'{}')}catch(_){args={}};
        try{
          const result=await runTool(call.name,args,googleAccessToken);
          actions.push({tool:call.name,result});
          input.push({type:'function_call_output',call_id:call.call_id,output:JSON.stringify(result)});
        }catch(err){
          const result={error:err.message||'Tool failed'};
          actions.push({tool:call.name,result});
          input.push({type:'function_call_output',call_id:call.call_id,output:JSON.stringify(result)});
        }
      }
    }

    const text=response?.output_text||(response?.output||[]).flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join('\n')||'I completed the available steps but did not receive a final response.';
    return res.status(200).json({text,gmailStatus:gmailConnected?'connected':'not_connected',actions});
  } catch(err){ return res.status(500).json({error:err.message||'Server error.'}); }
}
