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

  const { question, app, component, lastVersionOnly, history, confirmedKeywords } = req.body;
  if (!question) return res.status(400).json({ error: 'Pregunta requerida' });

  const GH = { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' };
  const BASE = `https://api.github.com/repos/${GITHUB_REPO}/contents`;

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
    if (data.type === 'error') throw new Error(data.error?.message || 'API error');
    return data.content?.map(b => b.text || '').join('') || '';
  }

  // Normalize text for keyword comparison
  function normalize(str) {
    return String(str || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9\s\-]/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  // Opción B: substring match between question words and keywords
  function matchKeywordsB(question, keywords) {
    const qNorm = normalize(question);
    const qWords = qNorm.split(/[\s\-]+/).filter(w => w.length > 3);
    const matched = [];
    for (const kw of keywords) {
      const kwNorm = normalize(kw);
      const kwParts = kwNorm.split('-');
      // Match if any keyword part appears in question, or keyword appears as substring
      const hit = kwParts.some(part => part.length > 3 && qNorm.includes(part))
        || qWords.some(word => kwNorm.includes(word));
      if (hit) matched.push(kw);
    }
    return matched;
  }

  try {
    // ── 1. Load deployments.json (single GitHub call) ──
    const dbResp = await fetch(`${BASE}/data/deployments.json`, { headers: GH });
    if (!dbResp.ok) return res.status(200).json({ answer: 'No hay requerimientos publicados todavía.', references: [] });
    const dbFile = await dbResp.json();
    const db = JSON.parse(Buffer.from(dbFile.content, 'base64').toString('utf8'));
    let deployments = db.deployments || [];

    // ── 2. Filter by app and component ──
    if (app) deployments = deployments.filter(d => d.app === app);

    // Sort by date descending (most recent first)
    deployments.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    // If lastVersionOnly, keep only deployments of the most recent version
    if (lastVersionOnly && deployments.length) {
      const latestVersion = deployments[0].version;
      deployments = deployments.filter(d => d.version === latestVersion);
    }

    // Flatten all requirements with their deployment context
    let allCandidates = [];
    for (const dep of deployments) {
      for (const req of (dep.requirements || [])) {
        const reqComp = req.component || '';
        if (component && reqComp !== component) continue;
        allCandidates.push({
          dep,
          req,
          keywords: req.keywords || [],
          component: reqComp,
          version: dep.version,
          date: dep.date || ''
        });
      }
    }

    if (!allCandidates.length) {
      return res.status(200).json({
        answer: `No he encontrado requerimientos de ${component || app || 'esta aplicación'} en los datos disponibles.`,
        references: [],
        suggestedKeywords: []
      });
    }

    // ── 3. Keyword matching ──

    // If user already confirmed keywords (from UX step), filter directly
    if (confirmedKeywords && confirmedKeywords.length) {
      const confirmed = confirmedKeywords.map(k => normalize(k));
      allCandidates = allCandidates.filter(c =>
        c.keywords.some(kw => confirmed.some(ck => normalize(kw).includes(ck) || ck.includes(normalize(kw))))
      );
    } else {
      // Opción B: fast substring match
      let matched = allCandidates.filter(c => matchKeywordsB(question, c.keywords).length > 0);

      // Opción A fallback: if no match, ask IA to extract keywords from question
      if (!matched.length) {
        console.log('[search] Opción B no match, trying Opción A...');
        try {
          const kwPrompt = `Extrae 2-4 palabras clave de esta pregunta de soporte sanitario para buscar en documentación.
Devuelve solo términos del dominio clínico/funcional, en español, sin palabras genéricas.
Pregunta: "${question}"
Responde ÚNICAMENTE con JSON: {"keywords": ["termino1", "termino2"]}`;
          const kwRaw = await callClaude([{ role: 'user', content: kwPrompt }], 100);
          const kwClean = kwRaw.replace(/```json|```/g, '').trim();
          const extracted = JSON.parse(kwClean).keywords || [];
          console.log('[search] Opción A extracted:', extracted);

          matched = allCandidates.filter(c =>
            extracted.some(ek => matchKeywordsB(ek, c.keywords).length > 0 || matchKeywordsB(question, [ek]).length > 0)
          );
        } catch(e) {
          console.warn('[search] Opción A failed:', e.message);
        }
      }

      // If still no match, use all candidates (fallback — let IA decide)
      if (!matched.length) {
        console.log('[search] No keyword match, using all candidates');
        matched = allCandidates;
      }

      allCandidates = matched;
    }

    // ── 4. Build suggested keywords for UX (Fase 4) ──
    const allKeywords = [...new Set(allCandidates.flatMap(c => c.keywords))];
    const questionNorm = normalize(question);
    const suggestedKeywords = allKeywords.map(kw => ({
      keyword: kw,
      matched: matchKeywordsB(question, [kw]).length > 0
    })).sort((a, b) => b.matched - a.matched);

    // Limit to top 2 candidates for reading (larger raw = fewer docs to avoid timeout)
    const topCandidates = allCandidates.slice(0, 2);

    // ── 5. Build raw file paths and read them ──
    function sanitize(str) {
      return String(str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9.\-]/g, '')
        .replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
    }

    const docs = [];
    for (const c of topCandidates) {
      const appSafe = sanitize(c.dep.app);
      const versionSafe = sanitize(c.dep.version);
      const compSafe = sanitize(c.component);
      const titleSafe = sanitize(c.req.title || '');
      const kwPrefix = c.keywords.length ? c.keywords.map(k => `[${k}]`).join('') : '';
      const rawPath = `data/raw/${appSafe}/${versionSafe}/${compSafe}/${kwPrefix}${titleSafe}.txt`;

      const text = await ghRead(rawPath);
      if (text) {
        docs.push({ ...c, text, rawPath });
      } else {
        // Fallback: try without keyword prefix (older files)
        const fallbackPath = `data/raw/${appSafe}/${versionSafe}/${compSafe}/${titleSafe}.txt`;
        const fallbackText = await ghRead(fallbackPath);
        if (fallbackText) docs.push({ ...c, text: fallbackText, rawPath: fallbackPath });
        else console.warn('[search] Raw not found:', rawPath);
      }
    }

    if (!docs.length) {
      return res.status(200).json({
        answer: `Encontré requerimientos relacionados pero no pude acceder a su contenido detallado.`,
        references: [],
        suggestedKeywords
      });
    }

    // ── 6. Generate answer with full raw text ──
    const docsBlock = docs.map(d => {
      const compMatch = d.text.match(/^\[COMPONENTE_REAL\] (.+)/m);
      const realComp = compMatch ? compMatch[1].trim() : d.component;
      return `=== ${realComp} / ${d.version} / ${d.req.title} ===\n${d.text.slice(0, 60000)}`;
    }).join('\n\n');

    const recentHistory = (history || []).slice(-6);

    const systemPrompt = `Eres un asistente de soporte técnico sanitario especializado en los sistemas ${app || 'GAIA/SIA'}.

REGLAS ESTRICTAS:
1. Responde SOLO con información que esté en los documentos proporcionados. Si la respuesta no está, dilo claramente.
2. Respuesta breve y directa: máximo 3-4 párrafos. Ve al grano.
3. Lenguaje orientado al soporte: explica qué ve el usuario, qué debe hacer, qué ocurre en pantalla.
4. NUNCA menciones: casos de uso, CU1/CU2, nombres de tablas de base de datos, variables técnicas, nombres de ficheros, SQL, diagramas, estimaciones, ni referencias técnicas de ningún tipo.
5. NUNCA digas de dónde sacas la información (no cites secciones, apartados, ni documentos).
6. Si la pregunta es sobre un error o incidencia no contemplada: indica que no tienes información sobre esa situación.

DOCUMENTOS DISPONIBLES:
${docsBlock}`;

    const messages = [
      ...recentHistory,
      { role: 'user', content: `PREGUNTA: ${question}` }
    ];

    const answer = await callClaude(
      [{ role: 'user', content: systemPrompt + '\n\n' + messages.map(m => m.role.toUpperCase() + ': ' + m.content).join('\n') }],
      1500
    );

    const references = docs.map(d => {
      const compMatch = d.text.match(/^\[COMPONENTE_REAL\] (.+)/m);
      return {
        title: d.req.title || d.rawPath,
        version: d.version,
        component: compMatch ? compMatch[1].trim() : d.component
      };
    });

    return res.status(200).json({ answer, references, suggestedKeywords });

  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: err.message });
  }
}
