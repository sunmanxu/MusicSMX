// Release 后处理：合并 electron-builder 拆开的多个 Draft、写入更新说明、正式发布。
// 由 .github/workflows/release.yml 在构建完成后调用。
// 环境变量：GH_TOKEN（GitHub 提供的 secrets.GITHUB_TOKEN）、
//          GITHUB_REPOSITORY（owner/repo）、GITHUB_REF_NAME（tag 名，如 v1.2.3）。
//
// 更新说明来源（按优先级）：
//   1. RELEASE-NOTES.md 里 `## v<版本号>` 段落（人工精选文案，推荐）
//   2. 自动生成：上一个 tag 到 HEAD 的 git 提交记录（每行一条 `- 提交标题`）
const fs = require('fs');
const { execSync } = require('child_process');

const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';
const REPO = process.env.GITHUB_REPOSITORY;
const TAG = (process.env.GITHUB_REF_NAME || '').replace(/^refs\/tags\//, '');
const TOKEN = process.env.GH_TOKEN;
if (!TAG || !TOKEN || !REPO) { console.error('缺少 TAG / GH_TOKEN / GITHUB_REPOSITORY'); process.exit(1); }

const H = {
  'Authorization': `token ${TOKEN}`,
  'Accept': 'application/vnd.github+json',
  'User-Agent': 'finalize-release'
};

async function gh(method, path, body, raw) {
  const res = await fetch(API + path, {
    method,
    headers: raw ? { ...H, 'Accept': 'application/octet-stream' }
      : (body ? { ...H, 'Content-Type': 'application/json' } : H),
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return raw ? res : (res.status === 204 ? null : res.json());
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// RELEASE-NOTES.md 里找 `## v1.2.3` 或 `## 1.2.3` 标题下的段落
function notesFromFile(version) {
  let md;
  try { md = fs.readFileSync('RELEASE-NOTES.md', 'utf8'); } catch { return null; }
  const lines = md.split(/\r?\n/);
  let out = null;
  for (const line of lines) {
    const h = line.match(/^##\s+v?([\d.]+)\s*$/);
    if (h) { out = (h[1] === version) ? [] : null; continue; }
    if (out) out.push(line);
  }
  const body = out ? out.join('\n').trim() : '';
  return body || null;
}

// 兜底：git log 自动生成
function notesFromGit() {
  try {
    const tags = execSync('git tag --sort=-creatordate', { encoding: 'utf8' })
      .split('\n').map(t => t.trim()).filter(t => t && t !== TAG);
    const prev = tags[0];
    const range = prev ? `${prev}..HEAD` : 'HEAD';
    const log = execSync(`git log ${range} --pretty="- %s"`, { encoding: 'utf8' }).trim();
    return log || null;
  } catch (e) { return null; }
}

function buildBody() {
  const version = TAG.replace(/^v/, '');
  const fromFile = notesFromFile(version);
  if (fromFile) { console.log('更新说明来自 RELEASE-NOTES.md'); return fromFile; }
  const fromGit = notesFromGit();
  if (fromGit) { console.log('更新说明自动生成自 git log'); return fromGit; }
  return `MusicSMX v${version}`;
}

(async () => {
  console.log('TAG =', TAG, '| REPO =', REPO);
  // 1. 等待 Draft 出现（electron-builder 上传完成即有）
  let mine = [];
  for (let i = 0; i < 12; i++) {
    const drafts = await gh('GET', `/repos/${REPO}/releases?per_page=100`);
    mine = drafts.filter(r => r.draft && r.tag_name === TAG);
    if (mine.length) break;
    console.log(`Draft 未出现，10s 后重试（${i + 1}/12）…`);
    await sleep(10000);
  }

  const body = buildBody();

  // 2. 没找到 Draft：可能已正式发布，只更新说明
  if (!mine.length) {
    const rel = await gh('GET', `/repos/${REPO}/releases/tags/${TAG}`).catch(() => null);
    if (!rel) { console.error('既没有 Draft 也没有正式 Release'); process.exit(1); }
    await gh('PATCH', `/repos/${REPO}/releases/${rel.id}`, { body });
    console.log('Release 已正式，更新说明已补充');
    return;
  }

  // 3. 合并拆开的多个 Draft（选含 setup.exe 的当主 Draft，其余资产搬过去再删）
  const primary = mine.find(d => (d.assets || []).some(a => a.name.endsWith('setup.exe'))) || mine[0];
  for (const d of mine) {
    if (d.id === primary.id) continue;
    for (const a of (d.assets || [])) {
      const res = await gh('GET', `/repos/${REPO}/releases/assets/${a.id}`, null, true);
      const buf = Buffer.from(await res.arrayBuffer());
      const up = await fetch(`${UPLOADS}/repos/${REPO}/releases/${primary.id}/assets?name=${encodeURIComponent(a.name)}`, {
        method: 'POST',
        headers: { ...H, 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length },
        body: buf
      });
      if (!up.ok) throw new Error(`上传资产失败 ${a.name} -> ${up.status}: ${(await up.text()).slice(0, 200)}`);
      console.log('资产已合并:', a.name);
    }
    await gh('DELETE', `/repos/${REPO}/releases/${d.id}`);
    console.log('多余 Draft 已删除:', d.id);
  }

  // 4. 正式发布（草稿对未登录的 /releases/latest 不可见，必须 draft:false）
  await gh('PATCH', `/repos/${REPO}/releases/${primary.id}`, {
    draft: false,
    name: `MusicSMX v${TAG.replace(/^v/, '')}`,
    body
  });
  console.log('=== 已正式发布 ===\n' + body);
})().catch(e => { console.error(e); process.exit(1); });
