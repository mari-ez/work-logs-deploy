const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { marked } = require('marked');

const app = express();
app.use(express.json());

// Allow requests from Vercel deployment and local file access
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (origin.includes('vercel.app') || origin.includes('localhost') || origin.startsWith('file://') || !origin) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const PORT = 4567;
const DIR = path.join(__dirname, '..'); // work-logs-deploy root (not _server/)
const OBSIDIAN_BASE = '/Users/hyejeankim/Documents/Obsidian Vault/00_에너지노';
const DOCS_DIR = path.join(DIR, 'docs');
const MANIFEST_PATH = path.join(DIR, 'manifest.json');
const FILES_JSON_PATH = path.join(DIR, 'files.json');
const CONFIG_PATH = path.join(DIR, 'config.json');

// ─── Category definitions ────────────────────────────────────────────────────

const CATEGORIES = [
  {
    id: 'daily',
    label: '일일업무보고',
    dir: path.join(OBSIDIAN_BASE, '01_일일업무보고'),
    filter: name => name.endsWith('.md')
  },
  {
    id: 'weekly',
    label: '주간보고',
    dir: path.join(OBSIDIAN_BASE, '01_01_주간회의(에너지노)'),
    filter: name => name.endsWith('.md') && (/주간보고|주간업무보고|팀메모/.test(name))
  },
  {
    id: 'retro',
    label: '회고',
    dir: path.join(OBSIDIAN_BASE, '03_회고'),
    filter: name => name.endsWith('.md')
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')); }
  catch { return {}; }
}

function saveManifest(m) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2));
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return { vercelUrl: '' }; }
}

function saveConfig(c) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
}

function hashFile(p) {
  return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
}

// file ID: category/relative/path.md
function makeId(catId, rel) {
  return catId + '/' + rel.replace(/\\/g, '/');
}

// slug for HTML output path: category/folder__name (no .md)
function makeSlug(catId, rel) {
  return catId + '/' + rel.replace(/\\/g, '/').replace('.md', '').replace(/\//g, '__');
}

function scanCategory(cat) {
  const items = [];
  if (!fs.existsSync(cat.dir)) return items;

  function walk(dir, folder) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return; }
    entries.sort((a, b) => b.localeCompare(a, 'ko')); // newest first

    for (const name of entries) {
      const full = path.join(dir, name);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }

      if (stat.isDirectory()) {
        walk(full, folder ? `${folder}/${name}` : name);
      } else if (cat.filter(name)) {
        const rel = path.relative(cat.dir, full);
        items.push({
          id: makeId(cat.id, rel),
          slug: makeSlug(cat.id, rel),
          category: cat.id,
          categoryLabel: cat.label,
          name: name.replace('.md', ''),
          folder: folder || '',
          fullPath: full,
          lastModified: stat.mtime.toISOString(),
          hash: hashFile(full)
        });
      }
    }
  }

  walk(cat.dir, '');
  return items;
}

function getAllFiles() {
  const manifest = loadManifest();
  const all = [];
  for (const cat of CATEGORIES) {
    for (const f of scanCategory(cat)) {
      const m = manifest[f.id];
      f.status = m ? (m.hash === f.hash ? 'deployed' : 'updated') : 'new';
      f.deployedAt = m ? m.deployedAt : null;
      all.push(f);
    }
  }
  return all;
}

// ─── Heading ID & section extraction ─────────────────────────────────────────

function headingId(raw) {
  return raw
    .replace(/\*\*/g, '').replace(/\*/g, '').replace(/`/g, '')
    .trim()
    .replace(/[\s\/\\~()■\[\]「」]/g, '-')
    .replace(/[^\w\-가-힣]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'section';
}

// Extract h3 headings for dashboard TOC (stored in files.json)
function extractSections(mdContent) {
  const sections = [];
  for (const line of mdContent.split('\n')) {
    const m = line.match(/^#{3}\s+(.+)/);
    if (m) {
      const raw = m[1].trim();
      sections.push({ id: headingId(raw), text: raw.replace(/\*\*/g, '').replace(/\*/g, '') });
    }
  }
  return sections;
}

// ─── HTML builder ─────────────────────────────────────────────────────────────

function buildDocHtml(name, mdContent, config) {
  const renderer = new marked.Renderer();
  const tocItems = [];
  const idCount = {};

  renderer.heading = function(text, level, raw) {
    if (level >= 2 && level <= 4) {
      const base = headingId(raw);
      const count = idCount[base] = (idCount[base] || 0) + 1;
      const id = count > 1 ? `${base}-${count}` : base;
      const plainText = raw.replace(/\*\*/g, '').replace(/\*/g, '').trim();
      tocItems.push({ id, text: plainText, level });
      return `<h${level} id="${id}">${text}</h${level}>\n`;
    }
    return `<h${level}>${text}</h${level}>\n`;
  };

  const body = marked.parse(mdContent, { renderer });
  const listUrl = '/logs-list.html';

  // Build TOC sidebar HTML
  let tocSidebarHtml = '';
  if (tocItems.length > 0) {
    const minLevel = Math.min(...tocItems.map(t => t.level));
    const items = tocItems.map(item => {
      const indent = (item.level - minLevel) * 14;
      return `<a href="#${item.id}" class="toc-link lv${item.level}" style="padding-left:${8 + indent}px">${escapeHtml(item.text)}</a>`;
    }).join('');
    tocSidebarHtml = `<aside class="toc-aside">
  <div class="toc-label">목차</div>
  <nav class="toc-nav">${items}</nav>
</aside>`;
  }

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(name)} — 에너지노 업무기록</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Noto Sans KR',-apple-system,sans-serif;background:#f9fafb;color:#111827;line-height:1.7;font-size:15px}
    .hdr{background:#1e3a5f;color:#fff;padding:24px 0 20px}
    .hdr .inner{max-width:1120px;margin:0 auto;padding:0 28px}
    .hdr a{color:#93c5fd;font-size:13px;text-decoration:none;display:inline-block;margin-bottom:8px}
    .hdr a:hover{text-decoration:underline}
    .hdr h1{font-size:20px;font-weight:700;line-height:1.3}
    /* Two-column layout */
    .page-wrap{display:flex;align-items:flex-start;max-width:1120px;margin:28px auto 80px;padding:0 28px;gap:24px}
    /* TOC sidebar */
    .toc-aside{width:190px;flex-shrink:0;position:sticky;top:24px;max-height:calc(100vh - 48px);overflow-y:auto;scrollbar-width:thin;scrollbar-color:#d1d5db transparent}
    .toc-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#9ca3af;padding:0 8px;margin-bottom:8px}
    .toc-nav{display:flex;flex-direction:column;gap:1px}
    .toc-link{display:block;font-size:12.5px;color:#6b7280;text-decoration:none;padding:5px 8px;border-radius:5px;line-height:1.45;border-left:2px solid transparent;transition:all .12s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .toc-link:hover{background:#f3f4f6;color:#111827;border-left-color:#d1d5db}
    .toc-link.active{color:#2563eb;border-left-color:#2563eb;background:#eff6ff}
    /* Doc content */
    .doc-main{flex:1;min-width:0;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:40px 44px}
    h1,h2,h3,h4{font-weight:700;margin:1.5em 0 .5em;line-height:1.3}
    h1{font-size:22px;border-bottom:2px solid #e5e7eb;padding-bottom:12px;margin-top:0}
    h2{font-size:17px}h3{font-size:15px}h4{font-size:14px;color:#374151}
    /* Anchor offset for sticky nav clearance */
    h2[id],h3[id],h4[id]{scroll-margin-top:80px}
    p{margin:.7em 0}
    ul,ol{padding-left:20px;margin:.5em 0}li{margin:.25em 0}
    table{border-collapse:collapse;width:100%;margin:1em 0;font-size:14px}
    th,td{border:1px solid #e5e7eb;padding:8px 12px;text-align:left}
    th{background:#f9fafb;font-weight:600}
    code{background:#f3f4f6;padding:2px 6px;border-radius:4px;font-size:.88em;font-family:monospace}
    pre{background:#f3f4f6;padding:16px;border-radius:8px;overflow-x:auto;margin:1em 0}pre code{background:none;padding:0}
    strong{font-weight:700}
    hr{border:none;border-top:1px solid #e5e7eb;margin:24px 0}
    blockquote{border-left:3px solid #d1d5db;padding-left:16px;color:#6b7280;margin:1em 0}
    a{color:#2563eb}
    @media(max-width:768px){.page-wrap{flex-direction:column}.toc-aside{width:100%;position:static;max-height:none}}
  </style>
</head>
<body>
  <div class="hdr">
    <div class="inner">
      <a href="${listUrl}">← 목록으로</a>
      <h1>${escapeHtml(name)}</h1>
    </div>
  </div>
  <div class="page-wrap">
    ${tocSidebarHtml}
    <main class="doc-main">${body}</main>
  </div>
  ${tocItems.length > 0 ? `<script>
(function(){
  const links = document.querySelectorAll('.toc-link');
  const headings = Array.from(document.querySelectorAll('h2[id],h3[id],h4[id]'));
  if (!headings.length) return;
  function update() {
    const y = window.scrollY + 100;
    let cur = headings[0];
    for (const h of headings) { if (h.offsetTop <= y) cur = h; }
    links.forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + cur.id));
  }
  window.addEventListener('scroll', update, { passive: true });
  update();
})();
</script>` : ''}
</body>
</html>`;
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Deploy logic ─────────────────────────────────────────────────────────────

function deployOneFile(file, config) {
  const manifest = loadManifest();
  const mdContent = fs.readFileSync(file.fullPath, 'utf8');
  const html = buildDocHtml(file.name, mdContent, config);

  const outPath = path.join(DOCS_DIR, file.slug + '.html');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html);

  manifest[file.id] = {
    hash: file.hash,
    deployedAt: new Date().toISOString(),
    htmlPath: 'docs/' + file.slug + '.html',
    sections: extractSections(mdContent)
  };
  saveManifest(manifest);
  return 'docs/' + file.slug + '.html';
}

function updateFilesJson() {
  const manifest = loadManifest();
  const files = getAllFiles();
  const deployed = files
    .filter(f => manifest[f.id])
    .map(f => ({
      id: f.id,
      slug: f.slug,
      category: f.category,
      categoryLabel: f.categoryLabel,
      name: f.name,
      folder: f.folder,
      lastModified: f.lastModified,
      deployedAt: manifest[f.id].deployedAt,
      htmlPath: manifest[f.id].htmlPath,
      sections: manifest[f.id].sections || []
    }));
  fs.writeFileSync(FILES_JSON_PATH, JSON.stringify(deployed, null, 2));
}

function runGitPush(commitMsg) {
  try {
    const cfg = loadConfig();
    const token = cfg.githubToken || '';
    const remote = cfg.githubRemote || '';
    if (!token || !remote) return { ok: false, error: 'config.json에 githubToken, githubRemote가 없습니다.' };

    // Inject token into remote URL for authentication
    const authedRemote = remote.replace('https://', `https://${token}@`);

    execSync('git add .', { cwd: DIR, encoding: 'utf8' });

    // Check if there's anything to commit
    const status = execSync('git status --porcelain', { cwd: DIR, encoding: 'utf8' });
    if (!status.trim()) return { ok: true, url: cfg.vercelUrl || '', output: '변경 없음 — push 생략' };

    execSync(`git commit -m "${commitMsg.replace(/"/g, "'")}"`, { cwd: DIR, encoding: 'utf8' });
    execSync(`git push ${authedRemote} main`, { cwd: DIR, encoding: 'utf8', timeout: 60000 });

    return { ok: true, url: cfg.vercelUrl || '', output: 'GitHub push 완료 → Vercel 자동 배포 진행 중' };
  } catch (e) {
    const errText = (e.stderr || e.stdout || e.message || '').slice(0, 400);
    return { ok: false, error: errText };
  }
}

// ─── API routes ───────────────────────────────────────────────────────────────

app.get('/api/files', (req, res) => {
  res.json(getAllFiles());
});

app.get('/api/config', (req, res) => {
  res.json(loadConfig());
});

app.post('/api/config', (req, res) => {
  const config = { ...loadConfig(), ...req.body };
  saveConfig(config);
  res.json({ ok: true, config });
});

app.post('/api/deploy', (req, res) => {
  const { ids } = req.body;
  const fileIds = Array.isArray(ids) ? ids : [ids];
  const files = getAllFiles();
  const toProcess = files.filter(f => fileIds.includes(f.id));

  if (!toProcess.length) {
    return res.status(404).json({ error: '파일을 찾을 수 없습니다' });
  }

  const config = loadConfig();
  const results = [];
  for (const file of toProcess) {
    try {
      const htmlPath = deployOneFile(file, config);
      results.push({ id: file.id, ok: true, htmlPath });
    } catch (e) {
      results.push({ id: file.id, ok: false, error: e.message });
    }
  }

  updateFilesJson();
  const names = toProcess.map(f => f.name).join(', ');
  const git = runGitPush(`docs: ${names} 배포`);

  res.json({ ok: true, results, vercel: git });
});

app.post('/api/deploy-all', (req, res) => {
  const files = getAllFiles();
  const toDeploy = files.filter(f => f.status !== 'deployed');

  if (!toDeploy.length) {
    return res.json({ ok: true, deployed: 0, message: '배포할 새 내용이 없습니다.' });
  }

  const config = loadConfig();
  const results = [];
  for (const file of toDeploy) {
    try {
      const htmlPath = deployOneFile(file, config);
      results.push({ id: file.id, ok: true, htmlPath });
    } catch (e) {
      results.push({ id: file.id, ok: false, error: e.message });
      console.error(`Deploy error [${file.id}]:`, e.message);
    }
  }

  updateFilesJson();
  const git = runGitPush('docs: 전체 문서 배포');

  res.json({
    ok: true,
    deployed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    results,
    vercel: git
  });
});

// ─── Local dashboard ─────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'local-dashboard.html'));
});

app.listen(PORT, () => {
  console.log(`\n✅ Work Logs 배포 관리자: http://localhost:${PORT}`);
  console.log('   Ctrl+C 로 종료\n');
});
