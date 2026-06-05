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
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens, messages })
    });
    const data = await r.json();
    if (data.type === 'error') throw new Error(data.error?.message || 'API error');
    return data.content?.map(b => b.text || '').join('') || '';
  }

  function normSeg(s) {
    return String(s || '').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._\-]/g, '_');
  }

  // Extract functional snippet from structured raw text using tags
  function extractFunctionalSnippet(rawText) {
    if (!rawText) return '';
    const sections = [];

    // Extract [DOCUMENTO] — title
    const docMatch = rawText.match(/\[DOCUMENTO\]\n([^\n]+)/);
    if (docMatch) sections.push('Requerimiento: ' + docMatch[1]);

    // Extract [VERSIONES] — last version
    const verMatch = rawText.match(/\[VERSIONES\]\n((?:[^\n]+\n?){1,3})/);
    if (verMatch) {
      const lastVer = verMatch[1].trim().split('\n').pop();
      if (lastVer) sections.push('Última versión: ' + lastVer);
    }

    // Extract [SITUACION_ACTUAL] content — next ~400 chars
    const saMatch = rawText.match(/\[SITUACION_ACTUAL\]\n([\s\S]{0,500}?)(?=\[|$)/);
    if (saMatch) sections.push('[SITUACION_ACTUAL]\n' + saMatch[1].trim());

    // Extract [DESCRIPCION] content — next ~400 chars
    const descMatch = rawText.match(/\[DESCRIPCION\]\n([\s\S]{0,500}?)(?=\[|$)/);
    if (descMatch) sections.push('[DESCRIPCION]\n' + descMatch[1].trim());

    // Extract first [CASO_DE_USO] — just the header + 200 chars
    const cuMatch = rawText.match(/\[CASO_DE_USO\][^\n]*\n([\s\S]{0,200}?)(?=\[CASO_DE_USO\]|\[SECCION\]|$)/);
    if (cuMatch) sections.push('[CASO_DE_USO]\n' + cuMatch[1].trim());

    return sections.join('\n\n').slice(0, 900);
  }

  try {
    const appSafe = normSeg(app);

    // 1. List version folders under data/raw/{app}/
    const versionItems = await ghList(`data/raw/${appSafe}`);
    const versionFolders = versionItems.filter(i => i.type === 'dir').map(i => i.name);

    if (!versionFolders.length) {
      return res.status(200).json({
        answer: 'No hay requerimientos publicados para esta aplicación todavía.',
        references: []
      });
    }

    // Sort versions descending (most recent first)
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

    // 3. Load full texts
    const docs = [];
    for (const c of candidates) {
      const text = await ghRead(c.path);
      docs.push({ ...c, text: text || '' });
    }

    // 4. Phase 1 — relevance check using functional snippets (not first N chars)
    const snippetBlock = docs.map((d, i) =>
      `[${i}] ${d.component} / ${d.version.replace(/_/g,' ')} / ${d.filename.replace('.txt','').replace(/_/g,' ')}\n${extractFunctionalSnippet(d.text)}`
    ).join('\n\n---\n\n');

    const phase1Prompt = `Eres un asistente de soporte técnico sanitario.
El usuario pregunta: "${question}"

Tienes los siguientes requerimientos disponibles. Identifica los índices (números entre corchetes) de los 1-3 requerimientos cuyo contenido es más relevante para responder esta pregunta.
Si ninguno es relevante, devuelve indices:[].

${snippetBlock}

Responde ÚNICAMENTE con JSON: {"indices": [0, 2]}`;

    let relevantIndices = [];
    try {
      const phase1Raw = await callClaude([{ role: 'user', content: phase1Prompt }], 150);
      const clean = phase1Raw.replace(/```json|```/g, '').trim();
      relevantIndices = JSON.parse(clean).indices || [];
    } catch(e) {
      // Fallback: use all (max 3)
      relevantIndices = docs.map((_, i) => i).slice(0, 3);
    }

    if (!relevantIndices.length) {
      return res.status(200).json({
        answer: `No he encontrado información sobre esto en los requerimientos de ${component || app} disponibles. Para preguntas sobre errores o incidencias no contempladas en la funcionalidad, contacta con el equipo de soporte de segundo nivel.`,
        references: []
      });
    }

    // 5. Phase 2 — answer with full text of relevant docs
    const relevantDocs = relevantIndices.filter(i => docs[i]).map(i => docs[i]);

    const docsBlock = relevantDocs.map(d =>
      `=== ${d.component} / ${d.version.replace(/_/g,' ')} / ${d.filename.replace('.txt','').replace(/_/g,' ')} ===\n${d.text.slice(0, 10000)}`
    ).join('\n\n');

    // Build conversation history (last 6 messages max)
    const recentHistory = (history || []).slice(-6);

    const systemPrompt = `Eres un asistente de soporte técnico sanitario especializado en los sistemas ${app || 'GAIA/SIA'}.

REGLAS ESTRICTAS:
1. Responde SOLO con información que esté en los documentos proporcionados. Si la respuesta no está, dilo claramente.
2. Respuesta breve y directa: máximo 3-4 párrafos. Ve al grano.
3. Lenguaje orientado al soporte: explica qué ve el usuario, qué debe hacer, qué ocurre en pantalla.
4. NUNCA menciones: casos de uso, CU1/CU2, nombres de tablas de base de datos, variables técnicas, nombres de ficheros, SQL, diagramas, estimaciones, ni referencias técnicas de ningún tipo.
5. NUNCA digas de dónde sacas la información (no cites secciones, apartados, ni documentos).
6. Si la pregunta es sobre un error o incidencia no contemplada en la funcionalidad: indica claramente que no tienes información sobre esa situación en los requerimientos disponibles.

DOCUMENTOS DISPONIBLES:
${docsBlock}`;

    const messages = [
      ...recentHistory,
      { role: 'user', content: `PREGUNTA: ${question}` }
    ];

    const answer = await callClaude(
      [{ role: 'user', content: systemPrompt + '\n\n' + messages.map(m => m.role.toUpperCase() + ': ' + m.content).join('\n') }],
      1200
    );

    const references = relevantDocs.map(d => ({
      title: d.filename.replace('.txt', '').replace(/_/g, ' '),
      version: d.version.replace(/_/g, ' '),
      component: d.component.replace(/_/g, ' ')
    }));

    return res.status(200).json({ answer, references });

  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: err.message });
  }
}
