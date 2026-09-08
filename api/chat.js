export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY is not configured on the server.' });

  try {
    const body = req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
    const googleAccessToken = typeof body.googleAccessToken === 'string' ? body.googleAccessToken : '';
    const latestUserMessage = [...messages].reverse().find(m => m.role === 'user')?.content || '';

    let gmailContext = '';
    const wantsEmail = /\b(gmail|email|emails|inbox|message|messages|recruiter|recruiters|cab-con|cabcon|drafting|roger|follow.?up|from|subject|received|sent)\b/i.test(latestUserMessage);

    if (googleAccessToken && wantsEmail) {
      try {
        const q = encodeURIComponent(latestUserMessage.slice(0, 180));
        const listResponse = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&q=${q}`, {
          headers: { Authorization: `Bearer ${googleAccessToken}` }
        });
        if (listResponse.ok) {
          const list = await listResponse.json();
          if (list.messages?.length) {
            const emailItems = await Promise.all(list.messages.slice(0, 10).map(async m => {
              const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`, {
                headers: { Authorization: `Bearer ${googleAccessToken}` }
              });
              return r.ok ? r.json() : null;
            }));
            gmailContext = emailItems.filter(Boolean).map(m => {
              const h = {};
              (m.payload?.headers || []).forEach(x => h[x.name.toLowerCase()] = x.value);
              return `EMAIL\nDate: ${h.date || ''}\nFrom: ${h.from || ''}\nTo: ${h.to || ''}\nSubject: ${h.subject || ''}\nSnippet: ${m.snippet || ''}`;
            }).join('\n\n');
          }
        }
      } catch (_) {
        gmailContext = '';
      }
    }

    const contextInstruction = gmailContext
      ? `\n\nThe app retrieved these Gmail results for the user's latest request. Use them as source material. Do not invent email details.\n\n${gmailContext}`
      : '';

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-5.6-luna',
        instructions: `You are the AI brain inside Alexander's Personal AI Tools command center. Be practical, concise, and action-oriented. Help with tasks, job searching, aviation career planning, millwork/drafting work, Gmail organization, Drive organization, contacts, projects, and daily planning. You have read-only access to Gmail search results when the app supplies them. If Gmail results are supplied, answer questions about those emails using the supplied data. Never claim you performed an action unless the app actually reports that it succeeded. If the user asks about email but no Gmail results were retrieved, say that Google needs to be connected or that no matching emails were found.${contextInstruction}`,
        input: messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') })),
        max_output_tokens: 1200
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
