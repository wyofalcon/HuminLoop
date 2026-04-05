// renderer/lite-index.js — Lite mode main window

let clips = [];
let currentIndex = 0;
let activeProjectId = null;

// ── Init ──

(async () => {
  const settings = await window.quickclip.getSettings();
  activeProjectId = settings.lite_active_project || null;
  await loadProjects();
  if (!activeProjectId) {
    document.getElementById('projectOverlay').style.display = 'flex';
  } else {
    await loadClips();
  }
})();

// ── Projects ──

async function loadProjects() {
  const projects = await window.quickclip.getProjects();
  const select = document.getElementById('projectSelect');
  while (select.options.length > 1) select.remove(1);
  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    if (p.id === activeProjectId) opt.selected = true;
    select.appendChild(opt);
  }

  const list = document.getElementById('projectList');
  list.innerHTML = '';
  for (const p of projects) {
    const btn = document.createElement('button');
    btn.className = 'project-item';
    const dot = document.createElement('span');
    dot.className = 'project-dot';
    dot.style.background = /^#[0-9a-fA-F]{3,8}$/.test(p.color) ? p.color : '#3b82f6';
    btn.appendChild(dot);
    btn.appendChild(document.createTextNode(p.name));
    btn.onclick = () => selectProject(p.id);
    list.appendChild(btn);
  }
}

document.getElementById('projectSelect').addEventListener('change', async (e) => {
  const id = parseInt(e.target.value, 10);
  if (id) await selectProject(id);
});

async function selectProject(projectId) {
  activeProjectId = projectId;
  await window.quickclip.setLiteActiveProject(projectId);
  document.getElementById('projectOverlay').style.display = 'none';
  const select = document.getElementById('projectSelect');
  for (const opt of select.options) {
    opt.selected = parseInt(opt.value, 10) === projectId;
  }
  await loadClips();
}

async function createNewProject() {
  const name = prompt('Project name:');
  if (!name || !name.trim()) return;
  const project = await window.quickclip.createProject({ name: name.trim() });
  if (project) {
    await loadProjects();
    await selectProject(project.id);
  }
}

// ── Clips ──

async function loadClips() {
  clips = await window.quickclip.getLiteClips();
  clips.sort((a, b) => b.timestamp - a.timestamp);
  currentIndex = 0;
  renderCurrentClip();
}

function renderCurrentClip() {
  const empty = document.getElementById('emptyState');
  const img = document.getElementById('clipImage');
  const noteSection = document.getElementById('noteSection');
  const promptSection = document.getElementById('promptSection');
  const promptLoading = document.getElementById('promptLoading');
  const position = document.getElementById('clipPosition');
  const counter = document.getElementById('navCounter');

  if (clips.length === 0) {
    empty.style.display = 'flex';
    img.style.display = 'none';
    noteSection.style.display = 'none';
    promptSection.style.display = 'none';
    promptLoading.style.display = 'none';
    position.textContent = '';
    counter.textContent = '';
    document.getElementById('prevBtn').disabled = true;
    document.getElementById('nextBtn').disabled = true;
    return;
  }

  const clip = clips[currentIndex];
  empty.style.display = 'none';

  // Screenshot
  if (clip.image && clip.image !== '__on_disk__') {
    img.src = clip.image;
    img.style.display = 'block';
  } else if (clip.image === '__on_disk__') {
    window.quickclip.getClipImage(clip.id).then(dataUrl => {
      if (dataUrl) { img.src = dataUrl; img.style.display = 'block'; }
    });
  } else {
    img.style.display = 'none';
  }

  // Note
  if (clip.comment) {
    document.getElementById('clipNote').textContent = clip.comment;
    noteSection.style.display = 'block';
  } else {
    noteSection.style.display = 'none';
  }

  // Prompt
  if (clip.aiFixPrompt) {
    document.getElementById('promptContent').textContent = clip.aiFixPrompt;
    promptSection.style.display = 'block';
    promptLoading.style.display = 'none';
  } else if (clip.comment || clip.image) {
    promptSection.style.display = 'none';
    promptLoading.style.display = 'flex';
  } else {
    promptSection.style.display = 'none';
    promptLoading.style.display = 'none';
  }

  // Navigation
  const num = currentIndex + 1;
  const total = clips.length;
  position.textContent = `${num} of ${total}`;
  counter.textContent = `${num} / ${total}`;
  document.getElementById('prevBtn').disabled = currentIndex >= clips.length - 1;
  document.getElementById('nextBtn').disabled = currentIndex <= 0;
}

function navigate(delta) {
  const newIndex = currentIndex - delta;
  if (newIndex >= 0 && newIndex < clips.length) {
    currentIndex = newIndex;
    renderCurrentClip();
  }
}

async function copyPrompt() {
  const clip = clips[currentIndex];
  if (!clip) return;
  const text = clip.aiFixPrompt || clip.comment || '';
  await navigator.clipboard.writeText(text);
  const btn = document.getElementById('copyBtn');
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
}

function openSettings() {
  window.quickclip.toggleAppMode();
}

// ── Live updates ──

window.quickclip.onClipsChanged(async () => {
  const prevId = clips[currentIndex]?.id;
  await loadClips();
  if (prevId) {
    const idx = clips.findIndex(c => c.id === prevId);
    if (idx >= 0) currentIndex = idx;
  }
  renderCurrentClip();
});

// ── Keyboard nav ──

document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') navigate(-1);
  else if (e.key === 'ArrowRight') navigate(1);
  else if (e.key === 'c' && (e.ctrlKey || e.metaKey)) copyPrompt();
});