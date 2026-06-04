export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { GITHUB_TOKEN, GITHUB_REPO, ANTHROPIC_API_KEY } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPO || !ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Faltan variables de entorno' });
  }

  const { question, app, component, lastVersionOnly, history } = req.body;
  if (!question) return res.status(400).json({ error: 'Pregunta requerida' });

  const GH = { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' };
  const BASE = `https://api.github.com/repos/${GITHUB_REPO}/contents`;

  async function ghList(path) {
    const r = await fetch(`${BASE}/${path}`, { headers: GH });
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data) ? data : [];
  }

  async function ghRead(path) {
    const r = await fetch(`${BASE}/${path}`, { headers: GH });
    if (!r.ok) return null;
    const data = await r.json();
    return data.content ? Buffer.from(data.content, 'base64').toString('utf8') : null;
  }

  async function callClaude(messages, maxTokens = 1000) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens, messages })
    });
    const data = await r.json();
    return data.content?.map(b => b.text || '').join('') || '';
  }

  function normSeg(s) {
    return String(s || '').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._\-]/g, '_');
  }

  try {
    const appSafe = normSeg(app);

    // 1. List version folders under data/raw/{app}/
    const versionItems = await ghList(`data/raw/${appSafe}`);
    const versionFolders = versionItems.filter(i => i.type === 'dir').map(i => i.name);

    if (!versionFolders.length) {
      return res.status(200).json({ answer: 'No hay requerimientos publicados para esta aplicación todavía.', references: [] });
    }

    // Sort versions — treat as strings, most recent last alphabetically
    // Try to sort by date suffix if present, otherwise alphabetical desc
    versionFolders.sort((a, b) => b.localeCompare(a));

    const versionsToSearch = lastVersionOnly ? [versionFolders[0]] : versionFolders;

    // 2. Collect candidate files
    const candidates = [];
    for (const version of versionsToSearch) {
      let componentFolders = [];
      if (component) {
        componentFolders = [normSeg(component)];
      } else {
        const items = await ghList(`data/raw/${appSafe}/${version}`);
        componentFolders = items.filter(i => i.type === 'dir').map(i => i.name);
      }
      for (const comp of componentFolders) {
        const files = await ghList(`data/raw/${appSafe}/${version}/${comp}`);
        for (const file of files.filter(f => f.type === 'file' && f.name.endsWith('.txt'))) {
          candidates.push({ version, component: comp, filename: file.name, path: file.path });
        }
      }
    }

    if (!candidates.length) {
      return res.status(200).json({
        answer: `No he encontrado requerimientos de ${component || app} en los datos disponibles. No puedo responder preguntas fuera del ámbito de los requerimientos publicados.`,
        references: []
      });
    }

    // 3. Phase 1 — Load snippets (first 600 chars of each file) and find relevant ones
    const snippets = [];
    for (const c of candidates) {
      const text = await ghRead(c.path);
      snippets.push({ ...c, snippet: (text || '').slice(0, 600), fullText: text });
    }

    const snippetBlock = snippets.map((s, i) =>
      `[${i}] ${s.component} / ${s.version} / ${s.filename.replace('.txt','')}\n${s.snippet}`
    ).join('\n\n---\n\n');

    const phase1Prompt = `Eres un asistente de soporte técnico sanitario. El usuario ha preguntado: "${question}"

Tienes estos requerimientos disponibles (fragmentos iniciales):
${snippetBlock}

Identifica los índices (números entre corchetes) de los 1-3 requerimientos más relevantes para responder esta pregunta.
Responde ÚNICAMENTE con un JSON: {"indices": [0, 2]} o {"indices": []} si ninguno es relevante.`;

    const phase1Raw = await callClaude([{ role: 'user', content: phase1Prompt }], 200);
    let relevantIndices = [];
    try {
      const clean = phase1Raw.replace(/```json|```/g, '').trim();
      relevantIndices = JSON.parse(clean).indices || [];
    } catch(e) {
      // fallback: try all
      relevantIndices = snippets.map((_, i) => i).slice(0, 3);
    }

    if (!relevantIndices.length) {
      return res.status(200).json({
        answer: `No he encontrado información relevante sobre tu pregunta en los requerimientos de ${component || app}. No puedo responder preguntas fuera del ámbito de los requerimientos publicados.`,
        references: []
      });
    }

    // 4. Phase 2 — Load full text of relevant reqs and generate answer
    const relevantDocs = relevantIndices
      .filter(i => snippets[i])
      .map(i => snippets[i]);

    const docsBlock = relevantDocs.map(d =>
      `=== ${d.component} / ${d.version} / ${d.filename.replace('.txt','')} ===\n${(d.fullText || d.snippet).slice(0, 8000)}`
    ).join('\n\n');

    // Build conversation history for context (last 6 messages max)
    const recentHistory = (history || []).slice(-6);
    const messages = [
      ...recentHistory,
      {
        role: 'user',
        content: `Eres un asistente de soporte técnico sanitario especializado en los sistemas ${app || 'GAIA/SIA'}. 
Responde ÚNICAMENTE basándote en la información de los siguientes requerimientos. 
Si la respuesta no está en estos documentos, dilo claramente: "No tengo información sobre esto en los requerimientos disponibles."
No inventes ni supongas información que no esté en los documentos.

REQUERIMIENTOS DISPONIBLES:
${docsBlock}

PREGUNTA: ${question}`
      }
    ];

    const answer = await callClaude(messages, 1500);

    const references = relevantDocs.map(d => ({
      title: d.filename.replace('.txt', '').replace(/_/g, ' '),
      version: d.version.replace(/_/g, ' '),
      component: d.component
    }));

    return res.status(200).json({ answer, references });

  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: err.message });
  }
}
