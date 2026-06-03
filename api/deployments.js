export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { GITHUB_TOKEN, GITHUB_REPO } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPO) return res.status(500).json({ error: 'GitHub env vars missing' });

  try {
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/data/deployments.json`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' } }
    );
    if (!response.ok) return res.status(200).json({ deployments: [] });

    const file = await response.json();
    const content = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));

    // Filter by app and version if provided
    const { app, version } = req.query;
    let deployments = content.deployments || [];
    if (app) deployments = deployments.filter(d => d.app === app);
    if (version) deployments = deployments.filter(d => d.version === version);

    // Sort by date desc
    deployments.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Return list without requirements (for index page)
    const { full } = req.query;
    if (!full) {
      return res.status(200).json({
        deployments: deployments.map(d => ({
          id: d.id, app: d.app, version: d.version,
          date: d.date, author: d.author, files: d.files,
          reqCount: (d.requirements || []).length
        }))
      });
    }

    return res.status(200).json({ deployments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
