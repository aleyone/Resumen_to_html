export const config = { api: { bodyParser: { sizeLimit: '50mb' } } };

async function uploadToCloudinary(base64Data, publicId, cloudName, apiKey, apiSecret) {
  const formData = new URLSearchParams();
  formData.append('file', `data:image/png;base64,${base64Data}`);
  formData.append('public_id', publicId);
  formData.append('overwrite', 'true');

  const timestamp = Math.floor(Date.now() / 1000);
  formData.append('timestamp', timestamp);

  // Simple signature
  const crypto = await import('crypto');
  const sigString = `overwrite=true&public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
  const signature = crypto.createHash('sha1').update(sigString).digest('hex');
  formData.append('signature', signature);
  formData.append('api_key', apiKey);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    { method: 'POST', body: formData }
  );
  const data = await response.json();
  return data.secure_url;
}

async function getGitHubFile(repo, token) {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/contents/data/deployments.json`,
    { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' } }
  );
  if (!response.ok) return { content: { deployments: [] }, sha: null };
  const file = await response.json();
  return {
    content: JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')),
    sha: file.sha
  };
}

async function saveGitHubFile(repo, token, content, sha, message) {
  const body = {
    message,
    content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64')
  };
  if (sha) body.sha = sha;

  const response = await fetch(
    `https://api.github.com/repos/${repo}/contents/data/deployments.json`,
    {
      method: 'PUT',
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );
  return response.ok;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    ANTHROPIC_API_KEY, GITHUB_TOKEN, GITHUB_REPO,
    CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
  } = process.env;

  if (!ANTHROPIC_API_KEY || !GITHUB_TOKEN || !GITHUB_REPO ||
      !CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    return res.status(500).json({ error: 'Faltan variables de entorno' });
  }

  try {
    const { app, version, author, requirements, images, filename } = req.body;
    // requirements: array of parsed reqs from frontend
    // images: { "dep_id/req_idx/img_idx": "base64string", ... }

    const depId = `dep_${Date.now()}`;

    // Upload images to Cloudinary
    const imageUrls = {};
    if (images && Object.keys(images).length > 0) {
      for (const [key, b64] of Object.entries(images)) {
        const publicId = `gaia-releases/${depId}/${key}`;
        try {
          const url = await uploadToCloudinary(b64, publicId, CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET);
          imageUrls[key] = url;
        } catch (e) {
          console.error('Cloudinary error for', key, e.message);
        }
      }
    }

    // Replace base64 in requirements with Cloudinary URLs
    const cleanReqs = requirements.map((req, rIdx) => {
      const cleanImages = (req.images || []).map((img, iIdx) => {
        const key = `${rIdx}/${iIdx}`;
        return imageUrls[key] || img;
      });
      const { images: _removed, ...rest } = req;
      return { ...rest, images: cleanImages };
    });

    // Load current deployments.json from GitHub
    const { content: db, sha } = await getGitHubFile(GITHUB_REPO, GITHUB_TOKEN);

    // Check if same app+version already exists → merge
    const existingIdx = db.deployments.findIndex(d => d.app === app && d.version === version);

    if (existingIdx >= 0) {
      // Merge: append requirements and file
      const existing = db.deployments[existingIdx];
      const offset = existing.requirements.length;
      const reindexed = cleanReqs.map((r, i) => ({
        ...r,
        id: `REQ-${String(offset + i + 1).padStart(2, '0')}`
      }));
      existing.requirements = [...existing.requirements, ...reindexed];
      if (!existing.files.includes(filename)) existing.files.push(filename);
    } else {
      // New deployment
      db.deployments.push({
        id: depId,
        app, version,
        date: new Date().toISOString().split('T')[0],
        author,
        files: [filename],
        requirements: cleanReqs
      });
    }

    // Save back to GitHub
    const saved = await saveGitHubFile(
      GITHUB_REPO, GITHUB_TOKEN, db, sha,
      `Deploy: ${app} ${version} - ${filename}`
    );

    if (!saved) return res.status(500).json({ error: 'Error guardando en GitHub' });

    return res.status(200).json({ ok: true, depId, reqCount: cleanReqs.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
