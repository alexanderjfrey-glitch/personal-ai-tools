export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY is not configured on the server.' });

  try {
    const body = req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
    const googleAccessToken = typeof body.googleAccessToken === 'string' ? body.googleAccessToken : '';
    const latestUserMessage = [...messages].reverse().find(m => m.role === 'user')?.content || '';

    let gmailContext = '';
    const wantsEmail = /\b(gmail|email|emails|inbox|message|messages|recruiter|recruiters|cab[- ]?con|drafting|roger|follow.?up|received|sent|label|labels)\b/i.test(latestUserMessage);

    if (googleAccessToken && wantsEmail) {
      try {
        // Use a useful Gmail search instead of sending the user's entire sentence as the query.
        const raw = String(latestUserMessage).trim();
        let q = raw
          .replace(/^\s*(search|find|look up|show|check|read)\s+(my\s+)?(gmail|email|emails|inbox|messages?)\s*(for|about|from|with)?\s*/i, '')
          .replace(/^\s*(what|which)\s+(emails?|messages?)\s+(do i have|are there)\s*/i, '')
          .trim();
        if (!q || /^(gmail|email|emails|inbox|messages?)$/i.test(q)) q = 'newer_than:90d';
        q = q.slice(0, 180);

        const listResponse = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=15&q=${encodeURIComponent(q)}`, {
          headers: { Authorization: `Bearer ${googleAccessToken}` }
        });
        if (listResponse.ok) {
          const list = await listResponse.json();
          if (list.messages?.length) {
            const emailItems = await Promise.all(list.messages.slice(0, 15).map(async m => {
              const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Label`, {
                headers: { Authorization: `Bearer ${googleAccessToken}` }
              });
              return r.ok ? r.json() : null;
            }));
            gmailContext = emailItems.filter(Boolean).map(m => {
              const h = {};
              (m.payload?.headers || []).forEach(x => h[x.name.toLowerCase()] = x.value);
              return `EMAIL\nDate: ${h.date || ''}\nFrom: ${h.from || ''}\nTo: ${h.to || ''}\nSubject: ${h.subject || ''}\nLabels: ${(m.labelIds || []).join(', ')}\nSnippet: ${m.snippet || ''}`;
            }).join('\n\n');
          } else {
            gmailContext = 'NO_MATCHING_EMAILS';
          }
        }
      } catch (_) {
        gmailContext = 'GMAIL_SEARCH_ERROR';
      }
    }

    const contextInstruction = gmailContext
      ? `\n\nGmail context retrieved for this request:\n${gmailContext}\n\nTreat this as the source of truth. Do not invent email details. If it says NO_MATCHING_EMAILS, say no matching emails were found. If it says GMAIL_SEARCH_ERROR, explain that Gmail could not be searched.`
      : '';

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-5.6-luna',
        instructions: `You are the AI brain inside Alexander's Personal AI Tools command center. Be practical, concise, and action-oriented. Help with tasks, job searching, aviation career planning, millwork/drafting work, Gmail organization, Drive organization, contacts, projects, and daily planning. When Gmail context is supplied, answer from it. Never claim you performed an action unless the app actually reports that it succeeded. The app can search Gmail and can later apply labels only after the user approves. If the user asks to organize or label email, explain the suggested matches and ask for approval rather than claiming labels were changed.${contextInstruction}`,
        input: messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') })),
        max_output_tokens: 1400
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data?.error?.message || 'OpenAI request failed.' });

    const text = data.output_text || (data.output || []).flatMap(x => x.content || []).filter(x => x.type === 'output_text').map(x => x.text).join('\n') || 'I did not receive a text response.';
    return res.status(200).json({ text });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error.' });
  }
}
