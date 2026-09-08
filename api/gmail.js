function decodeBase64Url(value='') {
  try {
    return Buffer.from(value.replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf8');
  } catch (_) { return ''; }
}

function extractText(part) {
  if (!part) return '';
  const mime = String(part.mimeType || '').toLowerCase();
  if (mime === 'text/plain' && part.body?.data) return decodeBase64Url(part.body.data);
  if (Array.isArray(part.parts)) return part.parts.map(extractText).filter(Boolean).join('\n');
  if (mime === 'text/html' && part.body?.data) {
    return decodeBase64Url(part.body.data).replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
  }
  return '';
}

function headers(message) {
  const h = {};
  (message.payload?.headers || []).forEach(x => h[String(x.name).toLowerCase()] = x.value || '');
  return h;
}

async function gmailFetch(url, token) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Gmail API ${r.status}: ${await r.text()}`);
  return r.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const token = typeof req.body?.googleAccessToken === 'string' ? req.body.googleAccessToken : '';
  if (!token) return res.status(401).json({ error: 'Google is not connected.' });

  try {
    await gmailFetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', token);
    const action = req.body?.action || 'analyze';
    let q = String(req.body?.query || '').trim();
    if (action === 'analyze') q = 'in:inbox newer_than:90d';
    if (!q) q = 'newer_than:90d';

    const list = await gmailFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=30&q=${encodeURIComponent(q)}`, token);
    const messages = [];
    for (const item of (list.messages || []).slice(0,30)) {
      const m = await gmailFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${item.id}?format=full`, token);
      const h = headers(m);
      messages.push({
        id: m.id,
        threadId: m.threadId,
        date: h.date || '',
        from: h.from || '',
        to: h.to || '',
        cc: h.cc || '',
        subject: h.subject || '',
        labels: m.labelIds || [],
        snippet: m.snippet || '',
        text: extractText(m.payload).slice(0,12000)
      });
    }

    return res.status(200).json({ action, query: q, count: messages.length, messages });
  } catch (err) {
    const msg = String(err.message || err);
    if (msg.includes('401') || msg.includes('403')) return res.status(401).json({ error: 'Your Google connection expired. Reconnect Google in the app.' });
    return res.status(500).json({ error: msg });
  }
}
