const state = { posts: [], current: null };
const $ = (sel) => document.querySelector(sel);

async function api(url, options = {}) {
  const init = { method: options.method || 'GET' };
  if (options.body !== undefined) {
    init.method = options.method || 'POST';
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(options.body);
  }
  const res = await fetch(url, init);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const pad = (n) => String(n).padStart(2, '0');
function fmtDate(v) {
  const d = v ? new Date(v) : new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const splitList = (s) => s.split(/[,，]/).map((x) => x.trim()).filter(Boolean);

function status(msg, isError) {
  const el = $('#status');
  el.textContent = msg;
  el.className = isError ? 'error' : 'ok';
}

/* ---------- 列表 ---------- */
async function loadList() {
  state.posts = await api('/api/posts');
  const ul = $('#post-list');
  ul.innerHTML = '';
  for (const p of state.posts) {
    const li = document.createElement('li');
    li.className = p.file === state.current ? 'active' : '';
    const title = document.createElement('span');
    title.className = 'item-title';
    title.textContent = (p.draft ? '【草稿】' : '') + p.title;
    const meta = document.createElement('span');
    meta.className = 'item-meta';
    // 列表按修改时间倒序，这里把修改时间也显示出来，便于核对顺序
    meta.textContent = p.isUpdated ? `${p.date} · 改 ${p.updated}` : p.date;
    li.append(title, meta);
    li.onclick = () => openPost(p.file);
    ul.appendChild(li);
  }
}

/* ---------- 编辑 ---------- */
async function openPost(file) {
  try {
    const p = await api('/api/posts/' + encodeURIComponent(file));
    state.current = file;
    $('#title').value = p.title;
    $('#date').value = p.date;
    // 「更新于」不回填：留空表示保存时写入当前时间，当前值放在 placeholder 里提示
    $('#updated').value = '';
    $('#updated').placeholder = `留空 = 保存时间（当前 ${p.updated}）`;
    $('#tags').value = p.tags.join(', ');
    $('#categories').value = p.categories.join(', ');
    $('#draft').checked = p.draft;
    $('#content').value = p.content;
    $('#delete-btn').style.display = '';
    loadList();
    updatePreview();
    status('已载入：' + file);
  } catch (err) {
    status(err.message, true);
  }
}

function newPost() {
  state.current = null;
  $('#title').value = '';
  $('#date').value = fmtDate();
  $('#updated').value = '';
  $('#updated').placeholder = '留空 = 创建时间';
  $('#tags').value = '';
  $('#categories').value = '';
  $('#draft').checked = true;
  $('#content').value = '[[toc]]\n\n在这里开始写作…\n';
  $('#delete-btn').style.display = 'none';
  loadList();
  updatePreview();
  status('新文章（默认草稿，取消勾选即发布）');
}

async function save() {
  const body = {
    file: state.current,
    title: $('#title').value.trim(),
    date: $('#date').value.trim(),
    updated: $('#updated').value.trim(),
    tags: splitList($('#tags').value),
    categories: splitList($('#categories').value),
    draft: $('#draft').checked,
    content: $('#content').value,
  };
  if (!body.title) return status('标题不能为空', true);
  try {
    const r = await api('/api/posts', { body });
    state.current = r.file;
    $('#delete-btn').style.display = '';
    await loadList();
    status(`已保存并重建站点（${r.posts} 篇文章）`);
  } catch (err) {
    status('保存失败：' + err.message, true);
  }
}

async function removePost() {
  if (!state.current || !confirm('确定删除这篇文章？此操作不可恢复。')) return;
  try {
    await api('/api/posts/' + encodeURIComponent(state.current), { method: 'DELETE' });
    newPost();
    status('已删除并重建站点');
  } catch (err) {
    status('删除失败：' + err.message, true);
  }
}

/* ---------- 预览 ---------- */
let previewTimer = null;
function updatePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    try {
      const r = await api('/api/preview', { body: { content: $('#content').value } });
      $('#preview').innerHTML = r.html || '<p class="hint">预览区域</p>';
    } catch (err) { /* 预览失败不打断写作 */ }
  }, 300);
}

$('#new-btn').onclick = newPost;
$('#save-btn').onclick = save;
$('#delete-btn').onclick = removePost;
$('#content').addEventListener('input', updatePreview);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    save();
  }
});

loadList().then(newPost).catch((err) => status(err.message, true));
