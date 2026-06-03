export const config = { api: { bodyParser: { sizeLimit: '50mb' } } };

async function uploadToCloudinary(base64Data, publicId, cloudName, apiKey, apiSecret) {
  const crypto = await import('crypto');
  const timestamp = Math.floor(Date.now() / 1000);
  const sigString = `overwrite=true&public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
  const signature = crypto.createHash('sha1').update(sigString).digest('hex');

  const formData = new URLSearchParams();
  formData.append('file', `data:image/png;base64,${base64Data}`);
  formData.append('public_id', publicId);
  formData.append('overwrite', 'true');
  formData.append('timestamp', timestamp);
  formData.append('signature', signature);
  formData.append('api_key', apiKey);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    { method: 'POST', body: formData }
  );
  const data = await response.json();
  if (!data.secure_url) throw new Error('Cloudinary error: ' + JSON.stringify(data));
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
  if (!response.ok) {
    const err = await response.text();
    throw new Error('GitHub save error: ' + err);
  }
  return true;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { GITHUB_TOKEN, GITHUB_REPO, CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPO || !CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    return res.status(500).json({ error: 'Faltan variables de entorno' });
  }

  try {
    // Frontend sends ONE call with ALL requirements from ALL files combined
    const { app, version, author, date, files, requirements } = req.body;

    if (!app || !version || !author || !requirements?.length) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    const depId = `dep_${Date.now()}`;

    // Upload images to Cloudinary
    // requirements[i].images is array of base64 strings
    const cleanReqs = [];
    for (let rIdx = 0; rIdx < requirements.length; rIdx++) {
      const req_item = requirements[rIdx];
      const cloudinaryUrls = [];
      const rawImages = req_item.images || [];

      for (let iIdx = 0; iIdx < rawImages.length; iIdx++) {
        const b64 = rawImages[iIdx];
        if (!b64 || b64.length < 100) continue;
        try {
          const publicId = `gaia-releases/${depId}/req${String(rIdx).padStart(2,'0')}_img${String(iIdx).padStart(2,'0')}`;
          const url = await uploadToCloudinary(b64, publicId, CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET);
          cloudinaryUrls.push(url);
        } catch (e) {
          console.error(`Cloudinary skip req${rIdx} img${iIdx}:`, e.message);
        }
      }

      const { images: _removed, ...rest } = req_item;
      cleanReqs.push({ ...rest, images: cloudinaryUrls });
    }

    // Load current DB
    const { content: db, sha } = await getGitHubFile(GITHUB_REPO, GITHUB_TOKEN);

    // Check if same app+version exists → merge
    const existingIdx = db.deployments.findIndex(d => d.app === app && d.version === version);

    if (existingIdx >= 0) {
      const existing = db.deployments[existingIdx];
      const offset = existing.requirements.length;
      const reindexed = cleanReqs.map((r, i) => ({
        ...r,
        id: `REQ-${String(offset + i + 1).padStart(2, '0')}`
      }));
      existing.requirements = [...existing.requirements, ...reindexed];
      (files || []).forEach(f => { if (!existing.files.includes(f)) existing.files.push(f); });
    } else {
      db.deployments.push({
        id: depId,
        app, version,
        date: date || new Date().toISOString().split('T')[0],
        author,
        files: files || [],
        requirements: cleanReqs
      });
    }

    await saveGitHubFile(GITHUB_REPO, GITHUB_TOKEN, db, sha, `Deploy: ${app} ${version} (${(files||[]).join(', ')})`);

    return res.status(200).json({ ok: true, depId, reqCount: cleanReqs.length });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
}
