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

async function gmailFetch(url, token) {
  const r = await fetch(url, {headers:{Authorization:`Bearer ${token}`}});
  if (!r.ok) throw new Error(`Gmail API ${r.status}`);
  return r.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({error:'POST only'});
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({error:'OPENAI_API_KEY is not configured on the server.'});

  try {
    const body=req.body||{};
    const messages=Array.isArray(body.messages)?body.messages.slice(-20):[];
    const googleAccessToken=typeof body.googleAccessToken==='string'?body.googleAccessToken:'';
    const latestUserMessage=String([...messages].reverse().find(m=>m.role==='user')?.content||'');
    const emailIntent=/\b(gmail|email|emails|inbox|mailbox|message|messages|recruiter|recruiters|cab[- ]?con|drafting|roger|follow.?up|received|sent|label|labels|phone|number|contact|conversation|thread|analy[sz]e)\b/i.test(latestUserMessage);
    const accessQuestion=/(can you|do you|are you|have you).{0,60}(see|access|read|search|look).{0,60}(my )?(email|emails|gmail|inbox|mail)/i.test(latestUserMessage)||/do you have (access to|my) (email|emails|gmail|inbox)/i.test(latestUserMessage);

    let gmailContext='';
    let gmailStatus='not_connected';

    if (googleAccessToken && emailIntent) {
      try {
        await gmailFetch('https://gmail.googleapis.com/gmail/v1/users/me/profile',googleAccessToken);
        gmailStatus='connected';

        if (!accessQuestion) {
          let q=latestUserMessage;
          const isAnalyze=/\b(analy[sz]e|summari[sz]e|review|go through|look through|check)\b.{0,50}\b(my )?(email|emails|inbox|mail)\b/i.test(q);
          const isPerson=/\b(roger|cab[- ]?con|hire nelson|system inc|clean kayak)\b/i.test(q);

          if (isAnalyze && !isPerson) q='in:inbox newer_than:90d';
          else {
            q=q.replace(/^\s*(can you|could you|please)?\s*(search|find|look up|show|check|read|analyze|review)\s+(my\s+)?(gmail|email|emails|inbox|messages?)\s*(for|about|from|with)?\s*/i,'').trim();
            if (!q || /^(gmail|email|emails|inbox|messages?)$/i.test(q)) q='newer_than:90d';
            if (isPerson && !/\b(from:|to:|cc:|subject:|label:|in:|newer_than:|after:|before:)\b/i.test(q)) q=`"${q.replace(/[\"']/g,'').slice(0,80)}"`;
          }
          q=q.slice(0,180);

          const list=await gmailFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=30&q=${encodeURIComponent(q)}`,googleAccessToken);
          if (list.messages?.length) {
            const detailed=[];
            for (const item of list.messages.slice(0,30)) {
              try {
                const m=await gmailFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${item.id}?format=full`,googleAccessToken);
                const h=getHeaders(m);
                detailed.push(`EMAIL\nDate: ${h.date||''}\nFrom: ${h.from||''}\nTo: ${h.to||''}\nSubject: ${h.subject||''}\nLabels: ${(m.labelIds||[]).join(', ')}\nSnippet: ${m.snippet||''}\nBody: ${extractText(m.payload).slice(0,10000)}`);
              } catch (_) {}
            }
            gmailContext=`SEARCH: ${q}\nFOUND: ${detailed.length}\n\n${detailed.join('\n\n')}`;
          } else gmailContext=`NO_MATCHING_EMAILS\nThe Gmail account is connected, but no messages matched: ${q}`;
        }
      } catch (err) {
        gmailStatus=String(err.message).includes('401')||String(err.message).includes('403')?'expired':'error';
      }
    }

    let contextInstruction='';
    if(gmailStatus==='connected'&&accessQuestion) contextInstruction='\n\nGMAIL ACCESS CONFIRMED: The app successfully authenticated to the user\'s Gmail. You can search and read Gmail when the user asks. Do not claim you lack access.';
    else if(gmailContext) contextInstruction=`\n\nGMAIL DATA RETRIEVED FROM THE USER'S REAL ACCOUNT:\n${gmailContext}\n\nUse this data as the source of truth. You may identify people, companies, dates, conversation topics, contact information, and phone numbers when they appear in the retrieved messages. Do not invent details. If the search found nothing, say so.`;
    else if(gmailStatus==='expired') contextInstruction='\n\nGMAIL ACCESS EXPIRED: Tell the user to reconnect Google in the app.';

    const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({
      model:'gpt-5.6-luna',
      instructions:`You are the AI brain inside Alexander's Personal AI Tools command center. Be practical, concise, and action-oriented. When Gmail data is supplied, actually analyze it rather than saying you cannot access email. If the user asks for a phone number, look through the supplied email bodies and signatures for it. Distinguish clearly between a number found in an email and a number not found. Never invent email details or claim an action happened unless the app reports success.${contextInstruction}`,
      input:messages.map(m=>({role:m.role==='assistant'?'assistant':'user',content:String(m.content||'')})),
      max_output_tokens:1800
    })});
    const data=await response.json();
    if(!response.ok) return res.status(response.status).json({error:data?.error?.message||'OpenAI request failed.'});
    const text=data.output_text||(data.output||[]).flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join('\n')||'I did not receive a text response.';
    return res.status(200).json({text});
  } catch(err) { return res.status(500).json({error:err.message||'Server error.'}); }
}
