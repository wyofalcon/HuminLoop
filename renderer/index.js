// renderer/index.js — Main window: tabbed notes viewer, projects, settings

// ── State ──

let activeTab = 'general';
let isFocusedMode = false;
let clips = [];
let categories = [];
let projects = [];
let settings = {};
let appVersion = null;
let apiBase = 'http://127.0.0.1:7277'; // local HTTP API (media streaming); port refined at init

// General Notes tab state
let filterCat = 'All';
let filterStatus = 'all';
let filterTag = null;
let sortBy = 'date-newest';
let showTrash = false;
let trashClips = [];
let aiMatchedIds = null;
let searchQuery = '';
let groupByCategory = false;
let collapsedGroups = new Set();

// Projects tab state
let selectedProjectId = null;
let hideCompleted = false;
let promptFilter = 'all'; // 'all' | 'with-prompt' | 'no-prompt'
let selectMode = false;
let selectedClipIds = new Set();
let projectFilterTags = []; // tags chosen in the project sidebar (multi-select)
let projectTagMatchMode = 'any'; // 'any' (OR) | 'all' (AND) — how selected tags combine
let projectSearchQuery = ''; // raw project search text, kept in sync across re-renders
let tagGroupNaming = false; // whether the "name a new tag group" input is showing

// Dev mode state
let isDevMode = false;
let ideStatus = null;
let devPrompts = [];
let devFilter = 'all'; // 'all' | 'pending' | 'done'
let devPollInterval = null;

// Workflow state — loaded for the currently-selected project
let workflowStatus = null;
let workflowChangelog = null;
let workflowPrompts = [];
let workflowAudits = null;
let workflowSection = 'status';

// Project detail sub-tab: 'notes' (clips), 'demos' (recordings), or 'workflow'
let projectDetailTab = 'notes';

// Demos sub-tab state
let projectDemos = [];
let expandedDemoId = null; // which demo's <video> is currently open inline
let demoTrash = [];        // trashed demos (all projects; filtered per project on render)
let demoTrashOpen = false;
let dubRecordingId = null; // demo id currently recording a self-dub (mic over muted playback)
let _dubMicStream = null, _dubRecorder = null, _dubTail = Promise.resolve();
let _demoPlayState = null;   // preserves <video> position across innerHTML re-renders
let _demoAutoplayNext = null; // demo id that should start playing after the next render

// ── Init ──

(async () => {
  const hasKey = await window.quickclip.hasApiKey();
  if (!hasKey) document.getElementById('noKeyBanner').style.display = 'block';
  appVersion = await window.quickclip.getAppVersion();
  if (appVersion && appVersion.apiPort) apiBase = `http://127.0.0.1:${appVersion.apiPort}`;

  // Check if we're in focused mode
  const mode = await window.quickclip.getAppMode();
  if (mode === 'focused') {
    isFocusedMode = true;
    applyFocusedMode();
  }

  await loadData();
  renderAll();
})();

function applyFocusedMode() {
  // Hide General Notes tab (workflow tab no longer exists at top level)
  document.querySelectorAll('.tab').forEach((btn) => {
    if (btn.dataset.tab === 'general') {
      btn.style.display = 'none';
    }
  });
  // Add "Focused" label to header
  const h1 = document.querySelector('.header h1');
  if (h1) {
    const label = document.createElement('span');
    label.className = 'focused-mode-label';
    label.id = 'mode-label';
    label.textContent = 'Focused';
    h1.parentNode.insertBefore(label, h1.nextSibling);
  }
  // Force Projects tab active
  activeTab = 'projects';
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === 'projects');
  });
}

async function loadData() {
  [clips, categories, projects, settings] = await Promise.all([
    window.quickclip.getClips(),
    window.quickclip.getCategories(),
    window.quickclip.getProjects(),
    window.quickclip.getSettings(),
  ]);
  // Restore the user's preferred tag match mode (persisted globally).
  if (settings.tag_match_mode === 'all' || settings.tag_match_mode === 'any') {
    projectTagMatchMode = settings.tag_match_mode;
  }
  // In focused mode, auto-select the active project (or first project if none set)
  if (isFocusedMode && selectedProjectId === null) {
    const focusedProject = settings.focused_active_project;
    if (focusedProject) {
      selectedProjectId = focusedProject;
    } else if (projects.length > 0) {
      selectedProjectId = projects[0].id;
      window.quickclip.setFocusedActiveProject(projects[0].id);
    }
  }

  // Dev mode detection
  if (isFocusedMode && selectedProjectId) {
    isDevMode = await window.quickclip.hasProjectWorkflow(selectedProjectId);
    if (isDevMode) {
      const project = projects.find(p => p.id === selectedProjectId);
      ideStatus = await window.quickclip.detectIde(project?.repo_path);
      devPrompts = await window.quickclip.getWorkflowPrompts(selectedProjectId);
      window._activePlans = await window.quickclip.getActivePlans();
      startDevPolling();
    } else {
      ideStatus = null;
      devPrompts = [];
      window._activePlans = [];
      stopDevPolling();
    }
  } else {
    isDevMode = false;
    ideStatus = null;
    devPrompts = [];
    window._activePlans = [];
    stopDevPolling();
  }
  updateModeLabel();
}

function updateModeLabel() {
  const label = document.getElementById('mode-label');
  if (label) {
    label.textContent = isDevMode ? 'Focused \u2014 Dev' : 'Focused';
  }
}

// Escape hides the main window to tray
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.quickclip.hideMain();
});

// Debounced reload to prevent race conditions when clips-changed and
// projects-changed fire back-to-back (e.g. AI assigns clip to project).
let _reloadTimer = null;
function scheduleReload() {
  if (_reloadTimer) clearTimeout(_reloadTimer);
  _reloadTimer = setTimeout(async () => {
    _reloadTimer = null;
    await loadData();
    renderAll();
  }, 80);
}

window.quickclip.onClipsChanged(() => scheduleReload());
window.quickclip.onProjectsChanged(() => scheduleReload());
window.quickclip.onPromptAutoCopied(() => showToast('Prompt copied to clipboard'));
window.quickclip.onDemosChanged(() => {
  if (activeTab === 'projects' && selectedProjectId && projectDetailTab === 'demos') {
    loadDemosData(selectedProjectId).then(renderAll);
  }
});

// ── Toast ──

function showToast(msg) {
  let toast = document.getElementById('huminloop-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'huminloop-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

// Action toast: corner notification with one or more clickable buttons.
// actions: [{ label, primary?, onClick }]
function showActionToast({ title, message, actions, sticky }) {
  let toast = document.getElementById('huminloop-action-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'huminloop-action-toast';
    document.body.appendChild(toast);
  }
  toast.innerHTML = '';
  if (title) {
    const t = document.createElement('div');
    t.className = 'action-toast-title';
    t.textContent = title;
    toast.appendChild(t);
  }
  if (message) {
    const m = document.createElement('div');
    m.className = 'action-toast-msg';
    m.textContent = message;
    toast.appendChild(m);
  }
  const row = document.createElement('div');
  row.className = 'action-toast-row';
  (actions || []).forEach(a => {
    const btn = document.createElement('button');
    btn.className = 'action-toast-btn' + (a.primary ? ' primary' : '');
    btn.textContent = a.label;
    btn.addEventListener('click', () => {
      try { a.onClick && a.onClick(); } finally { toast.classList.remove('show'); }
    });
    row.appendChild(btn);
  });
  toast.appendChild(row);
  toast.classList.add('show');
  if (!sticky) setTimeout(() => toast.classList.remove('show'), 30000);
}

function showWorkspaceProposal(data) {
  if (!data || !data.root) return;
  const name = data.name || data.root.split(/[\\/]/).filter(Boolean).pop() || 'Workspace';
  showActionToast({
    title: 'Register this workspace?',
    message: `An IDE just connected from ${data.root}. Register it as a HuminLoop project?`,
    sticky: true,
    actions: [
      { label: 'Register', primary: true, onClick: async () => {
        const project = await window.quickclip.registerWorkspace({ root: data.root, name });
        if (project) showToast(`Registered "${project.name}"`);
      } },
      { label: 'Not now', onClick: () => window.quickclip.dismissWorkspaceProposal() },
      { label: "Don't ask again", onClick: () => window.quickclip.ignoreWorkspace({ root: data.root }) },
    ],
  });
}

window.quickclip.onWorkspaceProposed((data) => showWorkspaceProposal(data));
window.quickclip.getPendingWorkspaceProposal().then(p => { if (p) showWorkspaceProposal(p); });

if (window.quickclip.onIdeCollision) {
  window.quickclip.onIdeCollision((data) => {
    if (!data) return;
    const projName = data.project_name || `project ${data.project_id}`;
    showActionToast({
      title: 'Another IDE tried to connect',
      message: `${data.rejected_ide || 'An IDE'} tried to claim "${projName}", but ${data.owner_ide || 'another IDE'} is already connected. Each project allows one IDE at a time.`,
      sticky: false,
      actions: [{ label: 'OK', primary: true, onClick: () => {} }],
    });
  });
}

// ── Escaping ──

function esc(s) {
  if (!s) return '';
  if (typeof s !== 'string') s = String(s);
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
          .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(s) {
  if (!s) return '';
  if (typeof s !== 'string') s = String(s);
  return s.replace(/&/g, '&amp;').replace(/'/g, '&#39;')
          .replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/\\/g, '\\\\');
}

// ── Tab Switching ──

function switchTab(tab) {
  // In focused mode, only allow projects, settings, and help tabs
  if (isFocusedMode && tab === 'general') return;
  // Workflow is no longer a top-level tab — redirect to Projects
  if (tab === 'workflow') tab = 'projects';
  activeTab = tab;
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  // Highlight header icon buttons for settings/help
  document.querySelectorAll('.hdr-icon-btn').forEach((btn) => btn.classList.remove('active'));
  if (tab === 'settings' || tab === 'help') {
    const icons = document.querySelectorAll('.hdr-icon-btn');
    if (tab === 'help' && icons[0]) icons[0].classList.add('active');
    if (tab === 'settings' && icons[1]) icons[1].classList.add('active');
  }
  renderAll();
}

// ── Actions ──

function openCapture() {
  window.quickclip.openCapture();
}

// ── Time Formatting ──

function timeAgo(ts) {
  const ms = Date.now() - ts;
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  if (days < 7) return days + 'd ago';
  return new Date(ts).toLocaleDateString();
}

// ── Rendering Entry Point ──

function renderAll() {
  renderSidebar();
  renderContent();
  updateStatusBar();
}

function updateStatusBar() {
  const sub = document.getElementById('subtitle');
  if (activeTab === 'general') {
    const generalClips = clips.filter((c) => !c.project_id);
    const parked = generalClips.filter((c) => c.status === 'parked' && !c.completedAt).length;
    const completed = generalClips.filter((c) => c.completedAt).length;
    let parts = [`${generalClips.length} general notes`];
    if (parked > 0) parts.push(`${parked} parked`);
    if (completed > 0) parts.push(`${completed} completed`);
    sub.textContent = parts.join(' · ');
  } else if (activeTab === 'projects') {
    sub.textContent = `${projects.length} project${projects.length !== 1 ? 's' : ''} · ${clips.length} total clips`;
  } else if (showTrash) {
    sub.textContent = `${trashClips.length} trashed note${trashClips.length !== 1 ? 's' : ''}`;
  } else if (activeTab === 'help') {
    sub.textContent = 'Help — how to use HuminLoop';
  } else {
    sub.textContent = 'App settings';
  }
}

// =====================================================================
//  SIDEBAR
// =====================================================================

function renderSidebar() {
  const el = document.getElementById('sidebar');
  if (activeTab === 'general') renderGeneralSidebar(el);
  else if (activeTab === 'projects') {
    if (selectedProjectId && projectDetailTab === 'workflow') renderWorkflowSidebar(el);
    else renderProjectsSidebar(el);
  }
  else if (activeTab === 'settings') renderSettingsSidebar(el);
  else if (activeTab === 'help') renderHelpSidebar(el);
}

function renderGeneralSidebar(el) {
  const generalClips = clips.filter((c) => !c.project_id);
  const allCats = ['All', ...categories.filter((c) => c !== 'Uncategorized')];

  let html = '<div class="sec">Categories</div>';
  allCats.forEach((cat) => {
    const count = cat === 'All' ? generalClips.length : generalClips.filter((c) => c.category === cat).length;
    if (cat !== 'All' && count === 0) return;
    const active = filterCat === cat ? 'active' : '';
    html += `<button class="sb-btn ${active}" onclick="setCat('${escAttr(cat)}')" title="Filter by ${escAttr(cat)}">`
      + `<span>${esc(cat)}</span><span class="sb-count">${count}</span></button>`;
  });

  html += '<div class="sec">Status</div>';
  ['all', 'parked', 'active', 'completed'].forEach((s) => {
    const label = s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1);
    html += `<button class="sb-btn ${filterStatus === s ? 'active' : ''}" onclick="setStatus('${s}')">${label}</button>`;
  });

  // Tags section
  const allTags = [];
  generalClips.forEach((c) => {
    if (c.tags && c.tags.length) c.tags.forEach((t) => { if (!allTags.includes(t)) allTags.push(t); });
  });
  allTags.sort();
  if (allTags.length > 0) {
    html += '<div class="sec">Tags</div>';
    html += `<button class="sb-btn ${filterTag === null ? 'active' : ''}" onclick="setTag(null)">All Tags</button>`;
    allTags.forEach((tag) => {
      const count = generalClips.filter((c) => c.tags && c.tags.includes(tag)).length;
      html += `<button class="sb-btn ${filterTag === tag ? 'active' : ''}" onclick="setTag('${escAttr(tag)}')" title="Filter by #${escAttr(tag)}">
        <span>#${esc(tag)}</span><span class="sb-count">${count}</span></button>`;
    });
  }

  // Sort section
  html += '<div class="sec">Sort</div>';
  html += `<select class="sb-select" onchange="setSortBy(this.value)">
    <option value="date-newest" ${sortBy === 'date-newest' ? 'selected' : ''}>Newest First</option>
    <option value="date-oldest" ${sortBy === 'date-oldest' ? 'selected' : ''}>Oldest First</option>
    <option value="tag-az" ${sortBy === 'tag-az' ? 'selected' : ''}>Tag A-Z</option>
  </select>`;

  html += '<div class="sec" style="margin-top:12px">View</div>';
  html += `<button class="sb-btn ${groupByCategory ? 'active' : ''}" onclick="toggleGroupBy()" title="Group notes under category headings">
    &#x1F4C2; Group by Category</button>`;

  html += '<div class="sec" style="margin-top:12px">Trash</div>';
  html += `<button class="sb-btn ${showTrash ? 'active' : ''}" onclick="toggleTrash()" title="View recently deleted notes">
    &#x1F5D1; Trash</button>`;

  html += renderWorkspacesSection();

  el.innerHTML = html;
}

function renderProjectsSidebar(el) {
  let html = '<div class="sec">Projects</div>';
  // In focused mode, hide "All Projects" — user must select a single project
  if (!isFocusedMode) {
    html += `<button class="sb-btn ${selectedProjectId === null ? 'active' : ''}" onclick="selectProject(null)">
      <span>All Projects</span><span class="sb-count">${projects.length}</span></button>`;
  }

  projects.forEach((p) => {
    const active = selectedProjectId === p.id ? 'active' : '';
    const ideIndicator = (p.active_in_ide || p.activeInIde) ? '<span class="ide-dot" title="Connected via MCP">&#x1F7E2;</span>' : '';
    html += `<button class="sb-btn ${active}" onclick="selectProject(${p.id})" style="${selectedProjectId === p.id ? 'border-left:3px solid ' + esc(p.color) : ''}">
      <span><span class="proj-dot" style="background:${esc(p.color)}"></span>${esc(p.name)}${ideIndicator}</span>
      <span class="sb-count">${p.clipCount || 0}</span></button>`;
  });

  html += `<button class="sb-btn sb-add" onclick="showNewProjectDialog()">+ New Project</button>`;

  // IDE Connection section (focused mode only)
  html += renderIdeConnectionSection();

  // Tags + saved tag groups for the open project — lets the user filter this
  // project's clips by one or more tags. Only shown when a project is selected.
  if (selectedProjectId !== null) {
    // Saved tag groups (named tag sets applied as a one-click filter).
    const tagGroups = getProjectTagGroups(selectedProjectId);
    if (tagGroups.length > 0) {
      html += '<div class="sec" style="margin-top:12px">Tag Groups</div>';
      tagGroups.forEach((g) => {
        const active = g.tags.length > 0
          && g.tags.length === projectFilterTags.length
          && g.tags.every((t) => projectFilterTags.includes(t));
        html += `<button class="sb-btn tag-group-btn ${active ? 'active' : ''}" onclick="applyTagGroup('${escAttr(g.id)}')" title="Filter by ${escAttr(g.tags.map((t) => '#' + t).join(' '))}">
          <span class="tg-name">${esc(g.name)}</span>
          <span class="tg-right"><span class="sb-count">${g.tags.length}</span><span class="tg-del" onclick="event.stopPropagation();deleteTagGroup('${escAttr(g.id)}')" title="Delete group">&times;</span></span></button>`;
      });
    }

    const tagCounts = new Map();
    clips.forEach((c) => {
      if (c.project_id !== selectedProjectId) return;
      (c.tags || []).forEach((t) => tagCounts.set(t, (tagCounts.get(t) || 0) + 1));
    });
    const projTags = Array.from(tagCounts.keys()).sort((a, b) => a.localeCompare(b));
    if (projTags.length > 0) {
      const anyActive = projectFilterTags.length > 0;
      // "Tags" header with an Any/All match-mode toggle (only useful with 2+ tags).
      html += '<div class="sec tags-sec" style="margin-top:12px"><span>Tags</span>';
      if (projTags.length > 1) {
        html += `<span class="tag-mode">
          <button class="tmode ${projectTagMatchMode === 'any' ? 'active' : ''}" onclick="setTagMatchMode('any')" title="Match clips with ANY selected tag (OR)">Any</button>
          <button class="tmode ${projectTagMatchMode === 'all' ? 'active' : ''}" onclick="setTagMatchMode('all')" title="Match clips with ALL selected tags (AND)">All</button></span>`;
      }
      html += '</div>';
      html += `<button class="sb-btn ${anyActive ? '' : 'active'}" onclick="clearProjectTags()" title="Show clips with any tag">All Tags</button>`;
      projTags.forEach((tag) => {
        const on = projectFilterTags.includes(tag);
        html += `<button class="sb-btn ${on ? 'active' : ''}" onclick="toggleProjectTag('${escAttr(tag)}')" title="Filter by #${escAttr(tag)}">
          <span>#${esc(tag)}</span><span class="sb-count">${tagCounts.get(tag)}</span></button>`;
      });
      if (anyActive) {
        if (tagGroupNaming) {
          html += `<div class="tag-group-form">
            <input id="tagGroupNameInput" class="tag-group-input" placeholder="Group name…" maxlength="40"
              onkeydown="if(event.key==='Enter'){saveTagGroup()}else if(event.key==='Escape'){cancelTagGroupNaming()}" />
            <button class="tg-form-btn save" onclick="saveTagGroup()" title="Save group">&#x2713;</button>
            <button class="tg-form-btn cancel" onclick="cancelTagGroupNaming()" title="Cancel">&#x2715;</button>
          </div>`;
        } else {
          html += `<button class="sb-btn sb-save-group" onclick="startTagGroupNaming()" title="Save the ${projectFilterTags.length} selected tag${projectFilterTags.length > 1 ? 's' : ''} as a reusable group">&#x1F4BE; Save as group</button>`;
        }
        html += `<button class="sb-btn sb-clear-tags" onclick="clearProjectTags()" title="Clear tag filters">&#x2715; Clear ${projectFilterTags.length} tag${projectFilterTags.length > 1 ? 's' : ''}</button>`;
      }
    }
  }

  html += '<div class="sec" style="margin-top:12px">Trash</div>';
  html += `<button class="sb-btn ${showTrash ? 'active' : ''}" onclick="toggleTrash()" title="View recently deleted notes">
    &#x1F5D1; Trash</button>`;

  html += renderWorkspacesSection();

  el.innerHTML = html;
}

function renderSettingsSidebar(el) {
  const ver = appVersion ? `v${appVersion.version}` : '';
  el.innerHTML = `
    <div class="sec">Settings</div>
    <button class="sb-btn active">All Settings</button>
    <div class="sidebar-version">${esc(ver)}</div>
  `;
}

function renderHelpSidebar(el) {
  if (isFocusedMode) {
    el.innerHTML = `
      <div class="sec">Help</div>
      <button class="sb-btn active" onclick="scrollHelpTo('getting-started')">Getting Started</button>
      <button class="sb-btn" onclick="scrollHelpTo('annotations')">Annotation Colors</button>
      <button class="sb-btn" onclick="scrollHelpTo('toolbar')">Toolbar</button>
      <button class="sb-btn" onclick="scrollHelpTo('prompt')">AI Prompts</button>
      <button class="sb-btn" onclick="scrollHelpTo('projects')">Projects</button>
      <button class="sb-btn" onclick="scrollHelpTo('shortcuts')">Shortcuts</button>
      <button class="sb-btn" onclick="scrollHelpTo('switching')">Switching Modes</button>
    `;
    return;
  }
  el.innerHTML = `
    <div class="sec">Help</div>
    <button class="sb-btn active" onclick="scrollHelpTo('getting-started')">Getting Started</button>
    <button class="sb-btn" onclick="scrollHelpTo('capturing')">Capturing</button>
    <button class="sb-btn" onclick="scrollHelpTo('organizing')">Organizing</button>
    <button class="sb-btn" onclick="scrollHelpTo('projects')">Projects</button>
    <button class="sb-btn" onclick="scrollHelpTo('smart-categorization')">Smart Categorization</button>
    <button class="sb-btn" onclick="scrollHelpTo('ai-features')">AI Features</button>
    <button class="sb-btn" onclick="scrollHelpTo('database')">Database</button>
    <button class="sb-btn" onclick="scrollHelpTo('shortcuts')">Keyboard Shortcuts</button>
    <button class="sb-btn" onclick="scrollHelpTo('tips')">Tips</button>
  `;
}

function scrollHelpTo(id) {
  const target = document.getElementById('help-' + id);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderHelpContent(el) {
  const ver = appVersion || { version: '?' };
  if (isFocusedMode) {
    el.innerHTML = `
      <div class="help-page">
        <h2>Help — HuminLoop Focused Mode v${esc(ver.version)}</h2>

        <div class="help-section" id="help-getting-started">
          <h3>Getting Started</h3>
          <p>Focused Mode is designed for fast iteration during active development. Annotate your screen, type a short note,
          and get an AI-generated coding prompt you can paste directly into your AI coding tool.</p>
          <div class="help-steps">
            <div class="help-step"><span class="help-num">1</span>Select your active project in the sidebar</div>
            <div class="help-step"><span class="help-num">2</span>Open the <strong>Toolbar</strong> from the tray menu</div>
            <div class="help-step"><span class="help-num">3</span>Annotate your screen with colored markup</div>
            <div class="help-step"><span class="help-num">4</span>Take a snippet or press <kbd>Ctrl+Shift+Q</kbd></div>
            <div class="help-step"><span class="help-num">5</span>Add a note describing what needs to change</div>
            <div class="help-step"><span class="help-num">6</span>Click <strong>Save &amp; Generate Prompt</strong></div>
          </div>
        </div>

        <div class="help-section" id="help-annotations">
          <h3>Annotation Colors</h3>
          <p>Use the floating toolbar to draw on your screen before capturing. Each color has a meaning that the AI understands:</p>
          <ul>
            <li><strong style="color:#ff4444">Red</strong> — Remove, delete, or fix what is marked</li>
            <li><strong style="color:#10b981">Green</strong> — Add or create something at this location</li>
            <li><strong style="color:#ec4899">Pink</strong> — Reference point — identifies something for context (may or may not need changes)</li>
          </ul>
          <p>The <strong>T</strong> button on the toolbar lets you type text directly on screen in the active color.</p>
          <p><strong>Priority:</strong> Your typed note is the primary source of intent. If the note conflicts with the annotations, AI follows the note.</p>
        </div>

        <div class="help-section" id="help-toolbar">
          <h3>Toolbar</h3>
          <p>The floating toolbar gives you quick access to annotation tools:</p>
          <ul>
            <li><strong>Color dots</strong> (red/green/pink) — Click to draw freehand in that color</li>
            <li><strong>T button</strong> — Click to enter text mode, then click anywhere on screen to type</li>
            <li><strong>Capture</strong> — Takes a region snippet of the annotated screen</li>
            <li><strong>Right-click</strong> — Exits draw mode while on the overlay</li>
          </ul>
        </div>

        <div class="help-section" id="help-prompt">
          <h3>AI Prompt Generation</h3>
          <p>After saving a capture, the AI generates a focused coding prompt based on:</p>
          <ul>
            <li>Your colored annotations (what to add, remove, or reference)</li>
            <li>Your typed note (highest priority)</li>
            <li>The active project's context (name, repo path, description)</li>
            <li>Workflow session context (current branch, recent commits) — if the project has an <code>.ai-workflow/</code> directory</li>
          </ul>
          <p>The prompt appears in the clip card. Click <strong>Note</strong> or <strong>Prompt</strong> buttons to view them. Copy the prompt and paste it into your AI coding tool.</p>
        </div>

        <div class="help-section" id="help-projects">
          <h3>Projects</h3>
          <p>Focused Mode is project-focused — select one project at a time in the sidebar. All captures go to the active project.</p>
          <ul>
            <li><strong>Open in IDE</strong> — Mark a project as actively open in your IDE for visual tracking</li>
            <li><strong>Show/hide completed</strong> — Toggle the checkbox to filter out completed notes</li>
            <li><strong>Switch projects</strong> — Click a different project in the sidebar</li>
          </ul>
        </div>

        <div class="help-section" id="help-shortcuts">
          <h3>Keyboard Shortcuts</h3>
          <table class="help-table">
            <tr><td><kbd>Ctrl+Shift+Q</kbd></td><td>Quick capture (global — works from any app)</td></tr>
            <tr><td><kbd>Enter</kbd></td><td>Save clip (in capture popup)</td></tr>
            <tr><td><kbd>Escape</kbd></td><td>Close capture popup / Hide main window to tray</td></tr>
            <tr><td><kbd>1</kbd> / <kbd>2</kbd> / <kbd>3</kbd></td><td>Switch to red / green / pink (while in draw mode)</td></tr>
            <tr><td><kbd>T</kbd></td><td>Toggle text mode (while in draw mode)</td></tr>
            <tr><td><kbd>S</kbd></td><td>Take snippet (while in draw mode)</td></tr>
            <tr><td><kbd>Right-click</kbd></td><td>Exit draw mode</td></tr>
          </table>
        </div>

        <div class="help-section" id="help-switching">
          <h3>Switching Modes</h3>
          <p>Right-click the HuminLoop tray icon and select <strong>Switch to Full Mode</strong> to access all features
          (General Notes, Workflow tab, categories, window rules, and more). From Full Mode, you can switch back to Focused Mode the same way.</p>
        </div>
      </div>
    `;
    return;
  }
  el.innerHTML = `
    <div class="help-page">
      <h2>Help — HuminLoop v${esc(ver.version)}</h2>

      <div class="help-section" id="help-getting-started">
        <h3>Getting Started</h3>
        <p>HuminLoop is an AI-powered knowledge capture tool. Screenshot anything on your screen,
        add a quick note, and let AI organize it for you.</p>
        <div class="help-steps">
          <div class="help-step"><span class="help-num">1</span>Press <kbd>Ctrl+Shift+Q</kbd> or click <strong>Capture</strong></div>
          <div class="help-step"><span class="help-num">2</span>A popup appears with your screenshot preview</div>
          <div class="help-step"><span class="help-num">3</span>Type a quick note describing what it is</div>
          <div class="help-step"><span class="help-num">4</span>Optionally pick a category and/or project</div>
          <div class="help-step"><span class="help-num">5</span>Press <kbd>Enter</kbd> — done! AI handles the rest</div>
        </div>
      </div>

      <div class="help-section" id="help-capturing">
        <h3>Capturing</h3>
        <p><strong>Automatic detection:</strong> HuminLoop watches your clipboard. When you take a screenshot
        (Win+Shift+S, Print Screen, or any snipping tool), the capture popup opens automatically.</p>
        <p><strong>Manual capture:</strong> Click the <strong>Capture</strong> button in the header or press
        <kbd>Ctrl+Shift+Q</kbd> at any time.</p>
        <p><strong>The capture popup:</strong></p>
        <ul>
          <li><strong>Comment box</strong> — Describe what you captured. This is the main context for AI categorization.</li>
          <li><strong>Category</strong> — Optional. Pick one or let AI choose for you.</li>
          <li><strong>Project</strong> — Optional. Assign to a project or leave in General Notes.</li>
          <li><strong>Park It</strong> — Saves the clip. You can also press Enter.</li>
        </ul>
      </div>

      <div class="help-section" id="help-organizing">
        <h3>Organizing Notes</h3>
        <p><strong>General Notes tab:</strong> Shows all clips not assigned to a project. Use the sidebar to filter by category or status.</p>
        <ul>
          <li><strong>Categories</strong> — Filter by topic (AI creates these automatically)</li>
          <li><strong>Status: Parked vs Active</strong> — Click the status badge on a clip to toggle. Parked = saved for later. Active = working on it now.</li>
          <li><strong>Search</strong> — Type keywords in the search bar to filter clips instantly</li>
          <li><strong>Move to project</strong> — Use the "Move..." dropdown on any clip to assign it to a project</li>
        </ul>
        <p><strong>Clip cards:</strong></p>
        <ul>
          <li>Click the <strong>thumbnail</strong> to expand/collapse the full screenshot</li>
          <li>Click <strong>+ Tag</strong> to add a tag from existing tags or create a new one</li>
          <li>Click <strong>+ Comment</strong> to add a follow-up note (threaded)</li>
          <li>Click <strong>x</strong> to move a clip to trash</li>
        </ul>
      </div>

      <div class="help-section" id="help-projects">
        <h3>Projects</h3>
        <p>Group your notes by project — great for tracking issues across multiple repos or work streams.</p>
        <ul>
          <li><strong>Create a project:</strong> Go to the Projects tab and click <strong>+ New Project</strong></li>
          <li><strong>Assign clips:</strong> Use the "Move..." dropdown on any General Notes clip, or select a project in the capture popup</li>
          <li><strong>Unassign:</strong> Inside a project, click the <strong>&larr;</strong> arrow on a clip to move it back to General Notes</li>
          <li><strong>Repo path:</strong> Optionally link a project to a local folder path for future auto-detection</li>
        </ul>
      </div>

      <div class="help-section" id="help-smart-categorization">
        <h3>Smart Categorization</h3>
        <p>HuminLoop uses a <strong>priority chain</strong> to categorize clips automatically:</p>
        <ul>
          <li><strong>1. Your selection</strong> — Manual category/project choice always wins</li>
          <li><strong>2. Window context</strong> — Active window title + process name captured before popup opens. If the title contains a project's repo folder name, auto-assigned.</li>
          <li><strong>3. Window rules</strong> — Custom pattern matching on window title or process name (regex supported)</li>
          <li><strong>4. AI fallback</strong> — Only called if rules didn't categorize. Gemini analyzes screenshot + note + window context.</li>
        </ul>
        <p><strong>Markup colors:</strong> If you annotate with colored markers before capturing, AI reads the meaning:</p>
        <ul>
          <li><strong style="color:#ff4444">Red</strong> = bug, error, needs fixing</li>
          <li><strong style="color:#10b981">Green</strong> = working, approved, keep this</li>
          <li><strong style="color:#ec4899">Pink</strong> = question, needs discussion</li>
        </ul>
      </div>

      <div class="help-section" id="help-ai-features">
        <h3>AI Features</h3>
        <p>HuminLoop uses <strong>Gemini 2.5 Flash</strong> for vision analysis and search. AI is optional — the rule engine handles most categorization without it.</p>
        <ul>
          <li><strong>Auto-categorization:</strong> When rules don't match, AI reads the screenshot + note + window context and picks category, tags, summary, and URLs</li>
          <li><strong>AI Search:</strong> Type a natural language query like <em>"that paste thing for Marcus"</em> and click AI Search</li>
          <li><strong>Setup options:</strong> Free Gemini API key (recommended) or GCP Vertex AI service account. Configure in Settings or during first-run setup.</li>
        </ul>
      </div>

      <div class="help-section" id="help-database">
        <h3>Database</h3>
        <p>HuminLoop supports two database backends:</p>
        <ul>
          <li><strong>SQLite (built-in)</strong> — Zero setup. Data stored locally. Perfect for personal use and distribution.</li>
          <li><strong>PostgreSQL (Docker)</strong> — For power users. Run <code>docker compose up -d</code> to start.</li>
        </ul>
        <p>Screenshots are saved to disk (not in the database) for performance. Set <code>DB_BACKEND</code> in .env to <code>pg</code>, <code>sqlite</code>, or <code>auto</code>.</p>
      </div>

      <div class="help-section" id="help-shortcuts">
        <h3>Keyboard Shortcuts</h3>
        <table class="help-table">
          <tr><td><kbd>Ctrl+Shift+Q</kbd></td><td>Quick capture (global — works from any app)</td></tr>
          <tr><td><kbd>Enter</kbd></td><td>Save clip (in capture popup) / Run AI search</td></tr>
          <tr><td><kbd>Escape</kbd></td><td>Close capture popup / Hide main window to tray</td></tr>
        </table>
      </div>

      <div class="help-section" id="help-tips">
        <h3>Tips</h3>
        <ul>
          <li><strong>One-button capture:</strong> Map Ctrl+Shift+Q to a spare mouse button (like Logitech MX Master) for zero-friction capture</li>
          <li><strong>Don't overthink the note:</strong> A few words is enough — AI fills in the details</li>
          <li><strong>Use projects for sprints:</strong> Create a project per feature or bug hunt, then review all notes when you're done</li>
          <li><strong>Thread comments:</strong> Come back to a clip later and add follow-up notes — great for tracking progress on an issue</li>
          <li><strong>Hover anything:</strong> Most buttons and elements have tooltips — hover for 1-2 seconds to see what they do</li>
          <li><strong>Linux on GNOME:</strong> If you don't see a tray icon, install <code>gnome-shell-extension-appindicator</code> and enable it. WSLg has no tray support — use the taskbar entry or <kbd>Ctrl+Shift+Q</kbd> instead.</li>
        </ul>
      </div>
    </div>
  `;
}

// =====================================================================
//  WORKFLOW TAB
// =====================================================================

function renderProjectDetailWorkflow(el, proj) {
  const ideActive = proj.active_in_ide || proj.activeInIde;
  let html = `<div class="project-detail-header">
    <div>
      <button class="back-btn" onclick="selectProject(null)">&larr; All Projects</button>
      <h2 style="display:inline;margin-left:8px"><span class="proj-dot big" style="background:${esc(proj.color)}"></span>${esc(proj.name)}</h2>
      ${ideActive ? `<span class="ide-badge" title="${esc(proj.ide || 'IDE')} connected">IN IDE${proj.ide ? ' · ' + esc(proj.ide) : ''}</span>` : ''}
    </div>
    <div class="project-detail-actions">
      ${renderWorkspacePinButton(proj)}
      ${ideActive
        ? `<span class="sb-btn-action ide-active" title="Connected via MCP" style="cursor:default">&#x1F7E2; Connected</span>`
        : `<button class="sb-btn-action" onclick="openIdeConnect(${proj.id})" title="Pick the VS Code window that has this project open">&#x1F50C; Connect IDE&hellip;</button>`}
    </div>
  </div>`;
  html += renderProjectTabStrip('workflow');
  html += `<div id="workflow-content"></div>`;
  el.innerHTML = html;
  renderWorkflowContent(document.getElementById('workflow-content'));
}

// Shared Notes / Demos / Workflow sub-tab strip (single source of truth —
// previously duplicated across the Notes and Workflow project views).
function renderProjectTabStrip(activeSubTab) {
  const tab = (id, label) =>
    `<button class="project-tab${activeSubTab === id ? ' active' : ''}" onclick="setProjectDetailTab('${id}')">${label}</button>`;
  return `<div class="project-tab-strip">${tab('notes', 'Notes')}${tab('demos', 'Demos')}${tab('workflow', 'Workflow')}</div>`;
}

async function loadWorkflowData(projectId) {
  if (!projectId) {
    workflowStatus = null; workflowChangelog = null;
    workflowPrompts = []; workflowAudits = null;
    return;
  }
  [workflowStatus, workflowChangelog, workflowPrompts, workflowAudits] = await Promise.all([
    window.quickclip.getWorkflowStatus(projectId),
    window.quickclip.getWorkflowChangelog(projectId),
    window.quickclip.getWorkflowPrompts(projectId),
    window.quickclip.getWorkflowAudits(projectId),
  ]);
}

function renderWorkflowSidebar(el) {
  const proj = projects.find(p => p.id === selectedProjectId);
  const projName = proj ? proj.name : '';
  const sections = [
    { id: 'status', label: 'Status' },
    { id: 'prompts', label: 'Prompts' },
    { id: 'audits', label: 'Audits' },
    { id: 'session', label: 'Session' },
    { id: 'changelog', label: 'Changelog' },
  ];
  let html = `<div class="sec">${esc(projName)} · Workflow</div>`;
  sections.forEach((s) => {
    html += `<button class="sb-btn${workflowSection === s.id ? ' active' : ''}" onclick="workflowSection='${s.id}';renderAll()">${esc(s.label)}</button>`;
  });
  html += `<div class="sec">View</div>`;
  html += `<button class="sb-btn" onclick="setProjectDetailTab('notes')">&#x2190; Back to Notes</button>`;
  el.innerHTML = html;
}

function setProjectDetailTab(tab) {
  projectDetailTab = tab;
  if (tab === 'workflow' && selectedProjectId) {
    loadWorkflowData(selectedProjectId).then(renderAll);
  } else if (tab === 'demos' && selectedProjectId) {
    loadDemosData(selectedProjectId).then(renderAll);
  } else {
    renderAll();
  }
}

// =====================================================================
//  DEMOS TAB
// =====================================================================

async function loadDemosData(projectId) {
  if (!projectId) { projectDemos = []; demoTrash = []; return; }
  try { projectDemos = await window.quickclip.getDemos(projectId); }
  catch { projectDemos = []; }
  try { demoTrash = await window.quickclip.getDemoTrash(); }
  catch { demoTrash = []; }
}

function renderProjectDetailDemos(el, proj) {
  // Preserve playback across re-renders — innerHTML tears the <video> down
  // (e.g. background AI enrichment firing demos-changed mid-watch), so capture
  // position/paused state here and restore it in wireDemoPlayers().
  const prevVideo = el.querySelector('video[data-demo-video]');
  if (prevVideo) {
    _demoPlayState = { id: prevVideo.dataset.demoVideo, time: prevVideo.currentTime || 0, paused: prevVideo.paused };
  }

  let html = `<div class="project-detail-header">
    <div>
      <button class="back-btn" onclick="selectProject(null)">&larr; All Projects</button>
      <h2 style="display:inline;margin-left:8px"><span class="proj-dot big" style="background:${esc(proj.color)}"></span>${esc(proj.name)}</h2>
    </div>
    <div class="project-detail-actions">
      <button class="sb-btn-action" onclick="startNewDemo(${proj.id})" title="Record a new demo for this project">&#x1F3AC; New Demo</button>
    </div>
  </div>`;
  html += renderProjectTabStrip('demos');

  if (!projectDemos.length) {
    html += `<div class="empty"><div class="ico">&#x1F3AC;</div>
      <div class="empty-title">No demos yet</div>
      <div class="empty-sub">Click &ldquo;New Demo&rdquo; to record your screen (and narrate it). Afterwards, AI can turn your narration into a clean script you can read back.</div></div>`;
    html += renderDemoTrashSection(proj.id);
    el.innerHTML = html;
    return;
  }

  html += `<div class="demo-list">` + projectDemos.map(renderDemoCard).join('') + `</div>`;
  html += renderDemoTrashSection(proj.id);
  el.innerHTML = html;
  wireDemoPlayers();
}

// Collapsible trash for this project's demos — restore or delete forever.
function renderDemoTrashSection(projectId) {
  const trash = demoTrash.filter((t) => t.project_id === projectId);
  if (!trash.length) return '';
  let html = `<div class="demo-trash">`;
  html += `<button class="demo-trash-toggle" onclick="demoTrashOpen=!demoTrashOpen;renderAll()">`
    + `${demoTrashOpen ? '&#x25BE;' : '&#x25B8;'} &#x1F5D1; Trash (${trash.length})</button>`;
  if (demoTrashOpen) {
    html += `<div class="demo-trash-list">`;
    for (const t of trash) {
      const tid = escAttr(t.id);
      const deleted = new Date(t.deletedAt).getTime();
      html += `<div class="demo-trash-row">
        <span class="demo-trash-title">${esc(t.title || 'Untitled demo')}</span>
        <span class="demo-badge">${fmtClock(t.durationMs)}</span>
        <span class="demo-time">trashed ${timeAgo(isFinite(deleted) ? deleted : Date.now())}</span>
        <button class="sb-btn-action" onclick="restoreDemoFromTrash('${tid}')" title="Restore this demo">&#x21A9; Restore</button>
        <button class="del-btn" onclick="permanentDeleteDemoNow('${tid}')" title="Delete forever — removes the video files from disk">&#x2715;</button>
      </div>`;
    }
    html += `</div>`;
  }
  html += `</div>`;
  return html;
}

async function restoreDemoFromTrash(id) {
  await window.quickclip.restoreDemo(id);
  await loadDemosData(selectedProjectId);
  renderAll();
  showToast('Demo restored');
}

async function permanentDeleteDemoNow(id) {
  if (!confirm('Delete this demo forever? Its video and audio files will be removed from disk.')) return;
  await window.quickclip.permanentDeleteDemo(id);
  await loadDemosData(selectedProjectId);
  renderAll();
}

function fmtClock(ms) {
  const t = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = Math.floor(t / 60), s = t % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function renderDemoCard(d) {
  const id = escAttr(d.id);
  const title = d.title || 'Untitled demo';
  const posterUrl = d.posterPath ? `${apiBase}/api/demos/${id}/poster` : '';
  const videoUrl = `${apiBase}/api/demos/${id}/video`;
  const isExpanded = expandedDemoId === d.id;
  const t = d.transcript;
  const hasTranscript = t && (t.plain || (t.segments && t.segments.length));
  const script = d.script && (d.script.plain || (d.script.segments && d.script.segments.length)) ? d.script : null;
  const created = new Date(d.createdAt).getTime();
  // Route the video's sound through the dub track when one is active — but not
  // while RE-recording a dub, when the old file is already gone.
  const dubActive = d.audioMode === 'dubbed' && d.audioDubbedPath && dubRecordingId !== d.id;

  let html = `<div class="demo-card" data-demo-id="${id}">`;

  // Header
  html += `<div class="demo-card-hdr">`;
  html += `<div class="demo-title" id="dtitle-${id}" onclick="showDemoTitleInput('${id}')" title="Click to rename">${esc(title)}</div>`;
  html += `<input class="demo-title-input" id="dtitle-in-${id}" style="display:none" value="${escAttr(title)}" `
    + `onkeydown="if(event.key==='Enter')saveDemoTitle('${id}');if(event.key==='Escape')hideDemoTitleInput('${id}')" onblur="saveDemoTitle('${id}')" />`;
  html += `<div class="demo-meta">`;
  html += `<span class="demo-badge">${fmtClock(d.durationMs)}</span>`;
  if (d.hasAudio) html += `<span class="demo-badge">&#x1F3A4;</span>`;
  if (d.speechSegments && d.speechSegments.length) html += `<span class="demo-badge" title="${d.speechSegments.length} narrated stretch(es) — highlighted on the timeline">&#x1F399; ${d.speechSegments.length}</span>`;
  if (d.markers && d.markers.length) html += `<span class="demo-badge" title="${d.markers.length} marker(s)">&#x1F6A9; ${d.markers.length}</span>`;
  if (d.audioDubbedPath) html += `<span class="demo-badge" title="This demo has a dubbed narration track">&#x1F50A; dub</span>`;
  html += `<span class="demo-time">${timeAgo(isFinite(created) ? created : Date.now())}</span>`;
  html += `<button class="del-btn" onclick="removeDemo('${id}')" title="Move demo to trash">&#x2715;</button>`;
  html += `</div></div>`;

  // Player / poster
  if (isExpanded) {
    html += `<video class="demo-video" data-demo-video="${id}" src="${videoUrl}" controls preload="metadata"${dubActive ? ' muted' : ''}></video>`;
    if (dubActive) {
      // Hidden dub track, kept in sync with the muted video by wireDemoPlayers().
      html += `<audio data-demo-dub="${id}" preload="auto" src="${apiBase}/api/demos/${id}/audio?which=dubbed"></audio>`;
    }
    html += renderDemoReel(d);
  } else {
    html += `<div class="demo-poster" onclick="playDemo('${id}')" title="Play demo">`;
    if (posterUrl) html += `<img src="${posterUrl}" alt="" />`;
    html += `<div class="demo-play">&#x25B6;</div></div>`;
  }

  // Script / transcript + actions
  html += `<div class="demo-transcript">`;
  if (script || hasTranscript) {
    const active = script || t;
    html += `<div class="demo-transcript-hdr"><span class="ai-label">${script ? 'Voice-over Script' : 'Demo Script'}</span>`;
    html += `<button class="copy-prompt-btn" onclick="copyDemoScript('${id}')" title="Copy the full script">&#x1F4CB; Copy</button></div>`;
    const segs = active.segments || [];
    if (segs.length) {
      html += `<div class="demo-segs">` + segs.map((seg) => {
        const start = Number(seg.start) || 0;
        return `<div class="demo-seg" onclick="seekDemo('${id}', ${start})" title="Jump to this moment">`
          + `<span class="demo-seg-t">${fmtClock(start * 1000)}</span>`
          + `<span class="demo-seg-txt">${esc(seg.text || '')}</span></div>`;
      }).join('') + `</div>`;
    } else if (active.plain) {
      html += `<div class="demo-plain">${esc(active.plain)}</div>`;
    }
    if (script && hasTranscript) {
      html += `<details class="demo-raw"><summary>Raw transcript</summary><div class="demo-plain">${esc(t.plain || (t.segments || []).map((s) => s.text).join(' '))}</div></details>`;
    }
    html += `<div class="demo-actions-row">`;
    if (hasTranscript) {
      html += `<button class="ai-trigger-btn" onclick="makeDemoScript('${id}')" `
        + `title="AI rewrites the narration into a polished voice-over script, using the window-focus and activity data captured while you recorded">`
        + `&#x1FA84; ${script ? 'Regenerate script' : 'Write voice-over script'}</button>`;
    }
    html += renderDubControls(d, id);
    html += `</div>`;
  } else {
    html += `<div class="demo-transcript-empty">`;
    if (d.hasAudio) {
      html += `<button class="btn-primary" onclick="transcribeDemo('${id}')" title="Transcribe the narration with AI">&#x2728; Transcribe narration</button>`;
    } else {
      html += `<span class="demo-note">No audio was recorded, so there is no narration to transcribe.</span>`;
    }
    html += `<div class="demo-actions-row">` + renderDubControls(d, id) + `</div>`;
    html += `</div>`;
  }
  html += `</div></div>`; // .demo-transcript .demo-card
  return html;
}

// Timeline reel: narrated stretches highlighted, marker pins, live playhead.
// Click anywhere to jump the video there.
function renderDemoReel(d) {
  const durMs = d.durationMs || 0;
  if (!durMs) return '';
  const id = escAttr(d.id);
  const pct = (ms) => Math.max(0, Math.min(100, (ms / durMs) * 100));
  let html = `<div class="demo-reel" data-demo-reel="${id}" onclick="reelSeek(event, '${id}', ${durMs})" `
    + `title="Click to jump — highlighted stretches are moments you were narrating">`;
  for (const s of d.speechSegments || []) {
    const left = pct((Number(s.start) || 0) * 1000);
    const width = Math.max(0.6, pct((Number(s.end) || 0) * 1000) - left);
    html += `<div class="demo-reel-speech" style="left:${left}%;width:${width}%"></div>`;
  }
  for (const m of d.markers || []) {
    html += `<div class="demo-reel-marker" style="left:${pct(m.t || 0)}%" title="Marker at ${fmtClock(m.t || 0)}"></div>`;
  }
  html += `<div class="demo-reel-playhead" data-demo-playhead="${id}"></div>`;
  html += `</div>`;
  if ((d.speechSegments || []).length) {
    html += `<div class="demo-reel-legend">&#x1F399; highlights = you were narrating &middot; &#x1F6A9; = markers &middot; click the reel to jump</div>`;
  }
  return html;
}

function reelSeek(event, id, durMs) {
  const rect = event.currentTarget.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  seekDemo(id, (frac * durMs) / 1000);
}

function renderDubControls(d, id) {
  if (dubRecordingId === d.id) {
    return `<span class="demo-badge dub-live">&#x23FA; recording your narration&hellip;</span>`
      + `<button class="btn-primary" onclick="stopSelfDub(true)">&#x23F9; Stop &amp; Save</button>`
      + `<button class="sb-btn-action" onclick="stopSelfDub(false)">Cancel</button>`;
  }
  let html = '';
  if (d.audioDubbedPath) {
    const mode = d.audioMode === 'dubbed' ? 'dubbed' : 'original';
    html += `<span class="demo-audio-toggle">Play:`
      + `<button class="demo-mode-btn${mode === 'original' ? ' active' : ''}" onclick="setDemoAudioMode('${id}','original')" title="Play the original recorded narration">Original</button>`
      + `<button class="demo-mode-btn${mode === 'dubbed' ? ' active' : ''}" onclick="setDemoAudioMode('${id}','dubbed')" title="Play the dubbed narration over the video">Dub</button>`
      + `</span>`;
    html += `<button class="sb-btn-action" onclick="recordSelfDub('${id}')" title="Re-record the dub in your own voice while the video plays muted">&#x1F399; Re-record dub</button>`;
    html += `<button class="sb-btn-action" onclick="removeDub('${id}')" title="Delete the dub and go back to the original audio">Remove dub</button>`;
  } else {
    if ((d.script && d.script.plain) || (d.transcript && d.transcript.plain)) {
      html += `<button class="ai-trigger-btn" onclick="dubDemo('${id}')" title="Experimental: synthesize an AI voice-over from the script (needs a Gemini TTS-capable key)">&#x1F50A; AI dub (beta)</button>`;
    }
    html += `<button class="sb-btn-action" onclick="recordSelfDub('${id}')" title="Play the video muted and record yourself reading the script — saved as this demo's narration">&#x1F399; Dub it myself</button>`;
  }
  return html;
}

function startNewDemo(projectId) {
  window.quickclip.openRecorder(projectId);
  showToast('Opening recorder…');
}

// Post-render wiring for the expanded demo player: restores playback state the
// innerHTML render destroyed, drives the reel playhead, and keeps an active dub
// track (or an in-progress self-dub) glued to the video.
function wireDemoPlayers() {
  const id = expandedDemoId;
  if (!id) { _demoPlayState = null; _demoAutoplayNext = null; return; }
  const v = document.querySelector(`video[data-demo-video="${CSS.escape(id)}"]`);
  if (!v) return;

  if (_demoPlayState && _demoPlayState.id === id) {
    if (_demoPlayState.time > 0) v.currentTime = _demoPlayState.time;
    if (!_demoPlayState.paused) v.play().catch(() => {});
  } else if (_demoAutoplayNext === id) {
    v.play().catch(() => {});
  }
  _demoPlayState = null;
  _demoAutoplayNext = null;

  const playhead = document.querySelector(`[data-demo-playhead="${CSS.escape(id)}"]`);
  if (playhead) {
    v.addEventListener('timeupdate', () => {
      if (v.duration) playhead.style.left = `${(v.currentTime / v.duration) * 100}%`;
    });
  }

  const dub = document.querySelector(`audio[data-demo-dub="${CSS.escape(id)}"]`);
  if (dub) {
    v.muted = true;
    v.addEventListener('play', () => { dub.currentTime = v.currentTime; dub.play().catch(() => {}); });
    v.addEventListener('pause', () => dub.pause());
    v.addEventListener('seeking', () => { dub.currentTime = v.currentTime; });
    v.addEventListener('ratechange', () => { dub.playbackRate = v.playbackRate; });
    v.addEventListener('ended', () => dub.pause());
  }

  // Self-dub in progress: video stays muted; finishing the video saves the dub.
  if (dubRecordingId === id) {
    v.muted = true;
    v.addEventListener('ended', () => { if (dubRecordingId === id) stopSelfDub(true); });
  }
}

function playDemo(id) {
  if (dubRecordingId) { showToast('Finish or cancel the dub recording first'); return; }
  expandedDemoId = (expandedDemoId === id) ? null : id;
  if (expandedDemoId) _demoAutoplayNext = id;
  renderAll();
}

function seekDemo(id, seconds) {
  const v = document.querySelector(`video[data-demo-video="${CSS.escape(id)}"]`);
  if (v) {
    v.currentTime = seconds;
    v.play().catch(() => {});
  } else {
    // Player not open yet — open it, then seek once it mounts.
    expandedDemoId = id;
    renderAll();
    setTimeout(() => {
      const vv = document.querySelector(`video[data-demo-video="${CSS.escape(id)}"]`);
      if (vv) { vv.currentTime = seconds; vv.play().catch(() => {}); }
    }, 250);
  }
}

async function transcribeDemo(id) {
  showToast('Transcribing demo…');
  const r = await window.quickclip.generateDemoTranscript(id);
  if (r && r.success) { await loadDemosData(selectedProjectId); renderAll(); showToast('Transcript ready'); }
  else showToast('Transcription failed: ' + ((r && r.error) || 'unknown'));
}

async function makeDemoScript(id) {
  showToast('Writing voice-over script from your narration + screen activity…');
  const r = await window.quickclip.generateDemoScript(id);
  if (r && r.success) { await loadDemosData(selectedProjectId); renderAll(); showToast('Voice-over script ready'); }
  else showToast('Script failed: ' + ((r && r.error) || 'unknown'));
}

async function dubDemo(id) {
  showToast('Generating AI voice-over (experimental)…');
  const r = await window.quickclip.generateDemoDub(id, {});
  if (r && r.success) { await loadDemosData(selectedProjectId); renderAll(); showToast('Dub ready — playback now uses the AI narration'); }
  else showToast('Dub failed: ' + ((r && r.error) || 'unknown'));
}

async function setDemoAudioMode(id, mode) {
  await window.quickclip.updateDemo(id, { audio_mode: mode });
  await loadDemosData(selectedProjectId);
  renderAll();
}

async function removeDub(id) {
  if (!confirm('Remove the dubbed narration? Playback goes back to the original audio.')) return;
  await window.quickclip.demoDubCancel(id);
  await loadDemosData(selectedProjectId);
  renderAll();
}

// ── Self-dub: record your own narration while the video plays muted ──

async function recordSelfDub(id) {
  if (dubRecordingId) return;
  let mic;
  try { mic = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { showToast('Microphone unavailable: ' + e.message); return; }

  const begin = await window.quickclip.demoDubBegin(id);
  if (!begin || !begin.success) {
    mic.getTracks().forEach((t) => t.stop());
    showToast('Could not start dub: ' + ((begin && begin.error) || 'unknown'));
    return;
  }

  const mime = ['audio/webm;codecs=opus', 'audio/webm'].find((m) => {
    try { return MediaRecorder.isTypeSupported(m); } catch { return false; }
  }) || 'audio/webm';
  _dubMicStream = mic;
  _dubTail = Promise.resolve();
  _dubRecorder = new MediaRecorder(mic, { mimeType: mime });
  _dubRecorder.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    _dubTail = _dubTail.then(() => e.data.arrayBuffer()).then((buf) => window.quickclip.demoDubChunk(id, buf));
  };

  dubRecordingId = id;
  expandedDemoId = id;
  _demoPlayState = null;
  _demoAutoplayNext = null;
  renderAll();

  const v = document.querySelector(`video[data-demo-video="${CSS.escape(id)}"]`);
  if (v) { v.muted = true; v.currentTime = 0; }
  _dubRecorder.start(1000);
  if (v) v.play().catch(() => {});
  showToast('Recording your narration — the video plays muted and saves automatically at the end.');
}

async function stopSelfDub(save = true) {
  const id = dubRecordingId;
  if (!id) return;
  dubRecordingId = null;

  const v = document.querySelector(`video[data-demo-video="${CSS.escape(id)}"]`);
  if (v) { try { v.pause(); } catch {} }
  if (_dubRecorder && _dubRecorder.state !== 'inactive') {
    await new Promise((r) => { _dubRecorder.onstop = r; _dubRecorder.stop(); });
  }
  await _dubTail; // flush in-flight chunk sends
  if (_dubMicStream) { _dubMicStream.getTracks().forEach((t) => t.stop()); _dubMicStream = null; }
  _dubRecorder = null;

  const r = save
    ? await window.quickclip.demoDubFinish(id)
    : await window.quickclip.demoDubCancel(id);
  if (save) {
    showToast(r && r.success ? 'Dub saved — playback now uses your new narration' : 'Dub failed: ' + ((r && r.error) || 'unknown'));
  }
  await loadDemosData(selectedProjectId);
  renderAll();
}

async function removeDemo(id) {
  if (!confirm('Move this demo to trash? Its files are kept until the trash is purged (30 days).')) return;
  await window.quickclip.deleteDemo(id);
  await loadDemosData(selectedProjectId);
  renderAll();
}

function showDemoTitleInput(id) {
  const label = document.getElementById(`dtitle-${id}`);
  const input = document.getElementById(`dtitle-in-${id}`);
  if (label) label.style.display = 'none';
  if (input) { input.style.display = 'block'; input.focus(); input.select(); }
}

function hideDemoTitleInput(id) {
  const label = document.getElementById(`dtitle-${id}`);
  const input = document.getElementById(`dtitle-in-${id}`);
  if (input) input.style.display = 'none';
  if (label) label.style.display = 'block';
}

async function saveDemoTitle(id) {
  const input = document.getElementById(`dtitle-in-${id}`);
  if (!input) return;
  const next = input.value.trim();
  const d = projectDemos.find((x) => x.id === id);
  if (d && next !== (d.title || '')) {
    await window.quickclip.updateDemo(id, { title: next });
    await loadDemosData(selectedProjectId);
  }
  renderAll();
}

function copyDemoScript(id) {
  const d = projectDemos.find((x) => x.id === id);
  if (!d) return;
  const src = (d.script && d.script.plain) ? d.script : d.transcript;
  if (!src) return;
  const text = src.plain || (src.segments || []).map((s) => s.text).join('\n');
  navigator.clipboard.writeText(text).then(() => showToast('Script copied')).catch(() => {});
}

function renderWorkflowContent(el) {
  const proj = projects.find(p => p.id === selectedProjectId);
  if (!proj) {
    el.innerHTML = '<div class="wf-empty"><h2>No Project Selected</h2><p>Open a project to view its workflow.</p></div>';
    return;
  }
  if (!proj.repo_path) {
    el.innerHTML = `<div class="wf-empty"><h2>No repo path set</h2><p>This project has no <code>repo_path</code> — set one in the project Edit dialog so HuminLoop can find its <code>.ai-workflow/</code> directory.</p></div>`;
    return;
  }
  if (!workflowStatus || !workflowStatus.hasWorkflow) {
    el.innerHTML = `<div class="wf-empty">
      <h2>Workflow not initialized</h2>
      <p>No <code>.ai-workflow/</code> directory at <code>${esc(proj.repo_path)}</code>.</p>
      <button class="btn-primary" onclick="initWorkflowForProject(${proj.id})">Initialize workflow</button>
    </div>`;
    return;
  }
  if (workflowSection === 'status') renderWorkflowStatus(el);
  else if (workflowSection === 'prompts') renderWorkflowPrompts(el);
  else if (workflowSection === 'audits') renderWorkflowAudits(el);
  else if (workflowSection === 'session') renderWorkflowSession(el);
  else if (workflowSection === 'changelog') renderWorkflowChangelog(el);
}

function renderWorkflowStatus(el) {
  const s = workflowStatus;
  const relayOn = s.relayMode === 'auto';
  const auditOn = s.auditMode === 'on';
  const pendingCount = workflowPrompts.filter((p) => p.status === 'CRAFTED' || p.status === 'SENT' || p.status === 'BUILDING').length;
  const doneCount = workflowPrompts.filter((p) => p.status === 'DONE').length;

  el.innerHTML = `
    <div class="wf-status-grid">
      <div class="wf-card wf-card-toggle" onclick="toggleRelay()" title="Click to toggle relay mode">
        <div class="wf-card-label">Relay Mode</div>
        <div class="wf-card-value">
          <label class="wf-switch"><input type="checkbox" ${relayOn ? 'checked' : ''} tabindex="-1"><span class="wf-slider"></span></label>
          <span class="wf-toggle-label">${relayOn ? 'Auto' : 'Review'}</span>
        </div>
        <div class="wf-card-hint">${relayOn ? 'Prompts relay immediately' : 'You review before sending'}</div>
      </div>
      <div class="wf-card wf-card-toggle" onclick="toggleAudit()" title="Click to toggle audit watch">
        <div class="wf-card-label">Audit Watch</div>
        <div class="wf-card-value">
          <label class="wf-switch"><input type="checkbox" ${auditOn ? 'checked' : ''} tabindex="-1"><span class="wf-slider"></span></label>
          <span class="wf-toggle-label">${auditOn ? 'On' : 'Off'}</span>
        </div>
        <div class="wf-card-hint">${auditOn ? 'Auto-audit files on save' : 'Manual auditing only'}</div>
      </div>
      <div class="wf-card wf-card-click${pendingCount > 0 ? ' wf-card-active' : ''}" onclick="showPromptFilter('pending')" title="View pending prompts">
        <div class="wf-card-label">Pending Prompts</div>
        <div class="wf-card-value wf-card-num">${pendingCount}</div>
        <div class="wf-card-hint">${pendingCount > 0 ? 'Click to view details' : 'No prompts in progress'}</div>
      </div>
      <div class="wf-card wf-card-click${doneCount > 0 ? ' wf-card-active' : ''}" onclick="showPromptFilter('done')" title="View completed prompts">
        <div class="wf-card-label">Completed Prompts</div>
        <div class="wf-card-value wf-card-num">${doneCount}</div>
        <div class="wf-card-hint">${doneCount > 0 ? 'Click to view details' : 'No prompts completed'}</div>
      </div>
    </div>
    <div class="wf-section">
      <h3>Agent Roles</h3>
      <table class="wf-roles-table">
        <tr><th>Role</th><th>Model</th><th>Purpose</th></tr>
        <tr><td>Architect</td><td>Sonnet 4.6</td><td>Orchestrates, refines prompts, manages git</td></tr>
        <tr><td>Builder</td><td>Opus 4.6</td><td>Writes all application code</td></tr>
        <tr><td>Reviewer</td><td>Gemini 3.1 Pro</td><td>Audits diffs, structured JSON verdicts</td></tr>
        <tr><td>Screener</td><td>Gemini 2.0 Flash</td><td>Pre-commit AI analysis</td></tr>
      </table>
    </div>
  `;
}

async function toggleRelay() {
  if (!selectedProjectId) return;
  const next = await window.quickclip.toggleRelayMode(selectedProjectId);
  workflowStatus.relayMode = next;
  renderAll();
}

async function toggleAudit() {
  if (!selectedProjectId) return;
  const next = await window.quickclip.toggleAuditWatch(selectedProjectId);
  workflowStatus.auditMode = next;
  renderAll();
}

// Display zoom controls — Chromium zoom levels are integer steps where each ≈ 20%.
// Level 0 = 100%, +1 ≈ 120%, -1 ≈ 83%, etc. We clamp [-3, 3] in the main process.
async function setZoom(level) {
  const applied = await window.quickclip.setZoomLevel(level);
  updateZoomReadout(applied);
}
async function adjustZoom(delta) {
  const current = await window.quickclip.getZoomLevel();
  await setZoom(current + delta);
}
function updateZoomReadout(level) {
  const pct = Math.round(Math.pow(1.2, level) * 100);
  const el = document.getElementById('zoomReadout');
  if (el) el.textContent = pct + '%';
}
// Keep the readout in sync when Settings opens.
async function refreshZoomReadout() {
  const level = await window.quickclip.getZoomLevel();
  updateZoomReadout(level);
}

async function initWorkflowForProject(projectId) {
  try {
    const result = await window.quickclip.initDevWorkflow(projectId);
    if (!result || !result.success) {
      const reason = result?.reason || 'unknown';
      showToast(`Initialization failed: ${reason}`);
      return;
    }
    if (result.repaired) {
      showToast(result.repaired.length
        ? `Workflow repaired: ${result.repaired.join(', ')}`
        : 'Workflow already set up — nothing missing');
    } else {
      showToast('Workflow initialized');
    }
    await loadWorkflowData(projectId);
    renderAll();
  } catch (e) {
    showToast(`Initialization failed: ${e.message}`);
  }
}

let workflowPromptFilter = null;

function showPromptFilter(filter) {
  workflowPromptFilter = filter;
  workflowSection = 'prompts';
  renderAll();
}

function renderWorkflowPrompts(el) {
  const backBtn = '<div class="wf-back-bar"><button class="wf-back-btn" onclick="workflowSection=\'status\';renderAll()" title="Back to Workflow status">&#x2190; Back to Workflow</button></div>';
  if (!workflowPrompts.length) {
    el.innerHTML = backBtn + '<div class="wf-empty"><h2>No Prompts Yet</h2><p>Prompt tracking starts when the Architect generates prompt IDs.</p></div>';
    return;
  }
  const isPending = (p) => p.status === 'CRAFTED' || p.status === 'SENT' || p.status === 'BUILDING';
  const isDone = (p) => p.status === 'DONE';
  let filtered = workflowPrompts;
  if (workflowPromptFilter === 'pending') filtered = workflowPrompts.filter(isPending);
  else if (workflowPromptFilter === 'done') filtered = workflowPrompts.filter(isDone);

  let html = backBtn + '<div class="wf-prompt-filter-bar">';
  html += `<button class="wf-filter-btn${!workflowPromptFilter ? ' active' : ''}" onclick="workflowPromptFilter=null;renderAll()">All (${workflowPrompts.length})</button>`;
  html += `<button class="wf-filter-btn${workflowPromptFilter === 'pending' ? ' active' : ''}" onclick="workflowPromptFilter='pending';renderAll()">Pending (${workflowPrompts.filter(isPending).length})</button>`;
  html += `<button class="wf-filter-btn${workflowPromptFilter === 'done' ? ' active' : ''}" onclick="workflowPromptFilter='done';renderAll()">Done (${workflowPrompts.filter(isDone).length})</button>`;
  html += '</div>';

  if (!filtered.length) {
    html += `<div class="wf-empty"><p>No ${workflowPromptFilter || ''} prompts found.</p></div>`;
    el.innerHTML = html;
    return;
  }
  html += '<div class="wf-prompt-list">';
  filtered.forEach((p) => {
    const statusClass = p.status === 'DONE' ? 'wf-badge-green' : p.status === 'FAILED' ? 'wf-badge-red' : 'wf-badge-yellow';
    const typeLabel = p.type === 'DIRECT' ? '<span class="wf-badge wf-badge-dim">direct</span> ' : '';
    html += `<div class="wf-prompt-row">
      <span class="wf-prompt-id">${esc(p.id)}</span>
      ${typeLabel}<span class="wf-badge ${statusClass}">${esc(p.status)}</span>
      <span class="wf-prompt-desc">${esc(p.description || '')}</span>
      <span class="wf-prompt-time">${p.timestamp ? esc(p.timestamp) : ''}</span>
    </div>`;
  });
  html += '</div>';
  el.innerHTML = html;
}

function renderWorkflowAudits(el) {
  if (!workflowAudits || workflowAudits.trim() === '' || !workflowAudits.includes('## ')) {
    el.innerHTML = '<div class="wf-empty"><h2>No Audits Yet</h2><p>Pre-feature audit findings will appear here after the next audit runs.</p></div>';
    return;
  }
  // Parse markdown sections (## headings) into audit entries
  const sections = workflowAudits.split(/^(?=## )/m).filter((s) => s.startsWith('## '));
  let html = '<div class="wf-audit-list">';
  sections.forEach((section, i) => {
    const firstLine = section.substring(0, section.indexOf('\n')).replace(/^## /, '');
    const body = section.substring(section.indexOf('\n') + 1).trim();
    const id = 'audit-' + i;
    html += `<div class="wf-audit-entry">
      <div class="wf-audit-header" onclick="document.getElementById('${id}').classList.toggle('collapsed')">
        <span class="wf-audit-title">${esc(firstLine)}</span>
        <span class="wf-audit-arrow">&#x25BC;</span>
      </div>
      <div class="wf-audit-body" id="${id}"><pre>${esc(body)}</pre></div>
    </div>`;
  });
  html += '</div>';
  el.innerHTML = html;
}

function renderWorkflowSession(el) {
  const session = workflowStatus?.session;
  if (!session) {
    el.innerHTML = '<div class="wf-empty"><h2>No Session</h2><p>SESSION.md not found.</p></div>';
    return;
  }
  el.innerHTML = `<div class="wf-markdown"><pre>${esc(session)}</pre></div>`;
}

function renderWorkflowChangelog(el) {
  if (!workflowChangelog) {
    el.innerHTML = '<div class="wf-empty"><h2>No Changelog</h2><p>CHANGELOG.md not found.</p></div>';
    return;
  }
  el.innerHTML = `<div class="wf-markdown"><pre>${esc(workflowChangelog)}</pre></div>`;
}

// =====================================================================
//  MAIN CONTENT
// =====================================================================

function renderContent() {
  const el = document.getElementById('mainArea');
  if (showTrash) renderTrashContent(el);
  else if (activeTab === 'general') renderGeneralContent(el);
  else if (activeTab === 'projects') renderProjectsContent(el);
  else if (activeTab === 'settings') { renderSettingsContent(el); loadPromptBlocks(); loadAuditLog(); refreshZoomReadout(); }
  else if (activeTab === 'help') renderHelpContent(el);
}

// ── General Notes ──

function renderGeneralContent(el) {
  let html = `<div class="search-bar">
    <input id="searchInput" placeholder='Search or ask "that paste thing for Marcus"'
      value="${escAttr(searchQuery)}"
      title="Type keywords to filter, or a natural language query for AI Search"
      onkeydown="if(event.key==='Enter')doAiSearch()" />
    <button type="button" class="ai-btn" id="aiSearchBtn" onclick="doAiSearch()" title="Use Gemini AI to find clips with natural language">AI Search</button>
  </div>`;

  if (aiMatchedIds) {
    html += `<div class="ai-result-bar"><span id="aiResultText"></span>
      <button type="button" class="clear-btn" onclick="clearSearch()">Clear</button></div>`;
  }

  const filtered = getFilteredGeneral();

  if (aiMatchedIds) {
    // We need to update the result count after rendering
    setTimeout(() => {
      const rt = document.getElementById('aiResultText');
      if (rt) rt.textContent = `${filtered.length} result${filtered.length !== 1 ? 's' : ''}`;
    });
  }

  if (filtered.length === 0) {
    const isEmpty = clips.filter((c) => !c.project_id).length === 0;
    html += `<div class="empty"><div class="ico">&#x26a1;</div>`
      + `<div class="empty-title">${isEmpty ? 'No notes yet' : 'No matches'}</div>`
      + `<div class="empty-sub">${isEmpty ? 'Take a screenshot — capture pops automatically' : 'Try a different search'}</div></div>`;
  } else if (groupByCategory && filterCat === 'All') {
    // Grouped view: clips arranged under category headings
    const tags = getAllKnownTags();
    const grouped = {};
    filtered.forEach((c) => {
      const cat = c.category || 'Uncategorized';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(c);
    });
    const sortedCats = Object.keys(grouped).sort((a, b) => a === 'Uncategorized' ? 1 : b === 'Uncategorized' ? -1 : a.localeCompare(b));
    sortedCats.forEach((cat) => {
      const isCollapsed = collapsedGroups.has(cat);
      html += `<div class="group-header" onclick="toggleGroup('${escAttr(cat)}')">`;
      html += `<span class="group-arrow">${isCollapsed ? '&#x25B6;' : '&#x25BC;'}</span>`;
      html += `<span class="group-name">${esc(cat)}</span>`;
      html += `<span class="group-count">${grouped[cat].length}</span>`;
      html += `</div>`;
      if (!isCollapsed) {
        html += grouped[cat].map((c) => renderClipCard(c, false, tags)).join('');
      }
    });
  } else {
    const tags = getAllKnownTags();
    html += filtered.map((c) => renderClipCard(c, false, tags)).join('');
  }

  el.innerHTML = html;
  loadDiskImages(el);
}

function getFilteredGeneral() {
  let filtered = clips.filter((c) => !c.project_id);
  if (filterCat !== 'All') filtered = filtered.filter((c) => c.category === filterCat);
  if (filterStatus !== 'all') {
    if (filterStatus === 'completed') {
      filtered = filtered.filter((c) => c.completedAt);
    } else {
      filtered = filtered.filter((c) => c.status === filterStatus && !c.completedAt);
    }
  }
  if (aiMatchedIds) {
    filtered = filtered.filter((c) => aiMatchedIds.includes(c.id));
  } else if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter((c) => clipMatchesQuery(c, q));
  }
  // Tag filter
  if (filterTag) {
    filtered = filtered.filter((c) => c.tags && c.tags.includes(filterTag));
  }
  // Sort
  if (sortBy === 'date-oldest') {
    filtered.sort((a, b) => a.timestamp - b.timestamp);
  } else if (sortBy === 'tag-az') {
    filtered.sort((a, b) => {
      const ta = (a.tags && a.tags.length) ? a.tags[0].toLowerCase() : 'zzz';
      const tb = (b.tags && b.tags.length) ? b.tags[0].toLowerCase() : 'zzz';
      return ta.localeCompare(tb);
    });
  }
  // date-newest is the default order from DB
  return filtered;
}

function setCat(cat) {
  filterCat = cat;
  aiMatchedIds = null;
  renderAll();
}

function setStatus(status) {
  filterStatus = status;
  renderAll();
}

function setTag(tag) {
  filterTag = tag;
  renderAll();
}

// Project detail: toggle a tag in the multi-select filter.
function toggleProjectTag(tag) {
  const i = projectFilterTags.indexOf(tag);
  if (i === -1) projectFilterTags.push(tag);
  else projectFilterTags.splice(i, 1);
  if (projectFilterTags.length === 0) tagGroupNaming = false;
  renderAll();
}

function clearProjectTags() {
  if (projectFilterTags.length === 0) return;
  projectFilterTags = [];
  tagGroupNaming = false;
  renderAll();
}

// Any (OR) vs All (AND) matching for the selected tags. Persisted globally.
function setTagMatchMode(mode) {
  if (mode !== 'any' && mode !== 'all') return;
  if (projectTagMatchMode === mode) return;
  projectTagMatchMode = mode;
  settings.tag_match_mode = mode;
  window.quickclip.saveSetting('tag_match_mode', mode).catch(() => {});
  renderAll();
}

// ── Tag Groups: named, saved sets of tags scoped to a project ──

function getProjectTagGroups(projectId) {
  const all = (settings && settings.tag_groups) || {};
  return Array.isArray(all[projectId]) ? all[projectId] : [];
}

async function saveProjectTagGroups(projectId, groups) {
  const all = (settings && settings.tag_groups) ? { ...settings.tag_groups } : {};
  if (groups.length) all[projectId] = groups;
  else delete all[projectId];
  settings.tag_groups = all;
  try { await window.quickclip.saveSetting('tag_groups', all); }
  catch (e) { console.error('[tag-groups] save failed', e); }
}

function startTagGroupNaming() {
  if (!projectFilterTags.length) return;
  tagGroupNaming = true;
  renderAll();
  const inp = document.getElementById('tagGroupNameInput');
  if (inp) { inp.focus(); inp.select(); }
}

function cancelTagGroupNaming() {
  tagGroupNaming = false;
  renderAll();
}

async function saveTagGroup() {
  const inp = document.getElementById('tagGroupNameInput');
  const name = (inp && inp.value || '').trim();
  if (!name || !projectFilterTags.length) { tagGroupNaming = false; renderAll(); return; }
  const groups = getProjectTagGroups(selectedProjectId).slice();
  // Update in place if a group with this name already exists, else append.
  const existing = groups.findIndex((g) => g.name.toLowerCase() === name.toLowerCase());
  const entry = { id: existing !== -1 ? groups[existing].id : 'g' + Date.now(), name, tags: [...projectFilterTags] };
  if (existing !== -1) groups[existing] = entry; else groups.push(entry);
  await saveProjectTagGroups(selectedProjectId, groups);
  tagGroupNaming = false;
  renderAll();
}

// Applying a group replaces the current tag selection with the group's tags.
function applyTagGroup(groupId) {
  const g = getProjectTagGroups(selectedProjectId).find((x) => x.id === groupId);
  if (!g) return;
  projectFilterTags = [...g.tags];
  tagGroupNaming = false;
  renderAll();
}

async function deleteTagGroup(groupId) {
  const groups = getProjectTagGroups(selectedProjectId).filter((x) => x.id !== groupId);
  await saveProjectTagGroups(selectedProjectId, groups);
  renderAll();
}

function setSortBy(sort) {
  sortBy = sort;
  renderAll();
}

function toggleGroupBy() {
  groupByCategory = !groupByCategory;
  renderAll();
}

function toggleGroup(cat) {
  if (collapsedGroups.has(cat)) collapsedGroups.delete(cat);
  else collapsedGroups.add(cat);
  renderAll();
}

async function toggleTrash() {
  showTrash = !showTrash;
  if (showTrash) {
    trashClips = await window.quickclip.getTrash();
  }
  renderAll();
}

async function restoreClip(id) {
  await window.quickclip.restoreClip(id);
  trashClips = trashClips.filter((c) => c.id !== id);
  clips = await window.quickclip.getClips();
  renderAll();
}

async function permanentDeleteClip(id) {
  if (!confirm('Permanently delete this note? This cannot be undone.')) return;
  await window.quickclip.permanentDeleteClip(id);
  trashClips = trashClips.filter((c) => c.id !== id);
  renderAll();
}

async function emptyTrash() {
  if (!confirm(`Permanently delete all ${trashClips.length} trashed note(s)? This cannot be undone.`)) return;
  await window.quickclip.emptyTrash();
  trashClips = [];
  renderAll();
}

function renderTrashContent(el) {
  let html = `<div class="project-detail-header">
    <div>
      <h2 style="display:inline">&#x1F5D1; Trash</h2>
      <span style="color:var(--text-dim);margin-left:8px;font-size:12px">Items auto-delete after 30 days</span>
    </div>`;
  if (trashClips.length > 0) {
    html += `<div class="project-detail-actions">
      <button class="sb-btn-action" onclick="emptyTrash()" title="Permanently delete all trashed notes" style="color:var(--danger)">&#x1F5D1; Empty Trash</button>
    </div>`;
  }
  html += `</div>`;

  if (trashClips.length === 0) {
    html += `<div class="empty"><div class="ico">&#x2705;</div>
      <div class="empty-title">Trash is empty</div>
      <div class="empty-sub">Deleted notes appear here for 30 days before being permanently removed</div></div>`;
  } else {
    trashClips.forEach((c) => {
      const id = escAttr(c.id);
      html += `<div class="clip trash-clip">`;
      html += `<div class="clip-header">`;
      html += `<span class="cat-badge" style="opacity:0.6">${esc(c.category)}</span>`;
      if (c.projectName) html += `<span class="proj-badge" style="opacity:0.6">${esc(c.projectName)}</span>`;
      html += `<div class="clip-actions">`;
      html += `<span class="clip-time">${timeAgo(c.timestamp)}</span>`;
      html += `<button class="sb-btn-action" onclick="restoreClip('${id}')" title="Restore this note" style="font-size:12px;padding:2px 8px">&#x21A9; Restore</button>`;
      html += `<button class="del-btn" onclick="permanentDeleteClip('${id}')" title="Permanently delete">&#x2715;</button>`;
      html += `</div></div>`;
      if (c.comment) html += `<div class="comment">${esc(c.comment)}</div>`;
      if (c.aiSummary) html += `<div class="ai-summary" style="opacity:0.6">${esc(c.aiSummary)}</div>`;
      if (c.tags && c.tags.length) {
        html += `<div class="tags" style="opacity:0.6">${c.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>`;
      }
      html += `</div>`;
    });
  }

  el.innerHTML = html;
  loadDiskImages(el);
}

let _aiSearchInFlight = false;
async function doAiSearch() {
  if (_aiSearchInFlight) return;
  const input = document.getElementById('searchInput');
  searchQuery = input ? input.value.trim() : '';
  if (!searchQuery) { clearSearch(); return; }
  const btn = document.getElementById('aiSearchBtn');
  _aiSearchInFlight = true;
  if (btn) { btn.disabled = true; btn.textContent = '...'; }
  try {
    aiMatchedIds = await window.quickclip.aiSearch(searchQuery);
  } catch (e) {
    console.error('[AI] Search failed:', e);
  } finally {
    _aiSearchInFlight = false;
    if (btn) { btn.disabled = false; btn.textContent = 'AI Search'; }
    renderContent();
  }
}

function clearSearch() {
  aiMatchedIds = null;
  searchQuery = '';
  renderAll();
}

// ── Projects Content ──

function renderProjectsContent(el) {
  if (selectedProjectId === null) {
    renderProjectsList(el);
  } else {
    renderProjectDetail(el);
  }
}

function renderProjectsList(el) {
  if (projects.length === 0) {
    el.innerHTML = `<div class="empty">
      <div class="ico">&#x1F4C1;</div>
      <div class="empty-title">No projects yet</div>
      <div class="empty-sub">Create a project to organize notes by topic or repo</div>
      <button class="cap-btn" style="margin-top:16px" onclick="showNewProjectDialog()">+ New Project</button>
    </div>`;
    return;
  }

  let html = `<div class="projects-header">
    <h2>All Projects</h2>
    <button class="cap-btn small" onclick="showNewProjectDialog()">+ New Project</button>
  </div>`;
  html += '<div class="projects-grid">';
  projects.forEach((p) => {
    html += `<div class="project-card" onclick="selectProject(${p.id})" style="border-left-color:${esc(p.color)}">
      <div class="project-card-name">${esc(p.name)}</div>
      <div class="project-card-desc">${esc(p.description) || 'No description'}</div>
      <div class="project-card-meta">${p.clipCount || 0} clips${p.repo_path ? ' · ' + esc(p.repo_path) : ''}</div>
    </div>`;
  });
  html += '</div>';
  el.innerHTML = html;
}

function renderProjectDetail(el) {
  const proj = projects.find((p) => p.id === selectedProjectId);
  if (!proj) { selectProject(null); return; }

  // If the workflow sub-tab is active, render the workflow content here. The
  // sidebar already swapped to renderWorkflowSidebar via renderSidebar().
  if (projectDetailTab === 'workflow') {
    renderProjectDetailWorkflow(el, proj);
    return;
  }
  if (projectDetailTab === 'demos') {
    renderProjectDetailDemos(el, proj);
    return;
  }

  let projectClips = clips.filter((c) => c.project_id === selectedProjectId);
  const totalInProject = projectClips.length;
  const completedCount = projectClips.filter((c) => c.completedAt).length;
  if (hideCompleted) {
    projectClips = projectClips.filter((c) => !c.completedAt);
  }

  const withPromptCount = projectClips.filter((c) => c.aiFixPrompt).length;
  const noPromptCount = projectClips.length - withPromptCount;
  if (promptFilter === 'with-prompt') {
    projectClips = projectClips.filter((c) => c.aiFixPrompt);
  } else if (promptFilter === 'no-prompt') {
    projectClips = projectClips.filter((c) => !c.aiFixPrompt);
  }

  // Dev workflow filter (only in dev mode)
  if (isDevMode && devFilter !== 'all') {
    if (devFilter === 'pending') {
      projectClips = projectClips.filter(c => !c.sentToIdeAt || !c.completedAt);
    } else if (devFilter === 'done') {
      projectClips = projectClips.filter(c => c.completedAt);
    }
  }

  const ideActive = proj.active_in_ide || proj.activeInIde;

  let html = `<div class="project-detail-header">
    <div>
      <button class="back-btn" onclick="selectProject(null)">&larr; All Projects</button>
      <h2 style="display:inline;margin-left:8px"><span class="proj-dot big" style="background:${esc(proj.color)}"></span>${esc(proj.name)}</h2>
      ${ideActive ? `<span class="ide-badge" title="${esc(proj.ide || 'IDE')} connected">IN IDE${proj.ide ? ' · ' + esc(proj.ide) : ''}</span>` : ''}
    </div>
    <div class="project-detail-actions">
      <span class="sb-btn-action ${ideActive ? 'ide-active' : ''}" title="${ideActive ? 'Connected via MCP — one IDE per project; new IDE sessions on this project are rejected while this one is active' : 'No active IDE connection. Each project allows a single IDE at a time.'}" style="cursor:default;opacity:${ideActive ? '1' : '0.5'}">
        ${ideActive ? '&#x1F7E2; Connected' : '&#x26AA; Not Connected'}
      </span>
      <button class="sb-btn-action ${selectMode ? 'select-active' : ''}" onclick="toggleSelectMode()" title="${selectMode ? 'Cancel selection' : 'Select clips to combine into one prompt'}">
        ${selectMode ? '&#x2715; Cancel' : '&#x2610; Select'}
      </button>
      <button class="sb-btn-action summarize-btn" onclick="showProjectSummary(${proj.id})" title="Generate a side-by-side summary of all notes">&#x2728; Summarize</button>
      <button class="sb-btn-action" onclick="editProject(${proj.id})">Edit</button>
      <button class="sb-btn-action danger" onclick="confirmDeleteProject(${proj.id})">Delete</button>
    </div>
  </div>`;

  // Notes / Demos / Workflow sub-tab strip
  html += renderProjectTabStrip('notes');

  if (completedCount > 0 || withPromptCount > 0) {
    html += `<div class="project-filters">`;
    if (completedCount > 0) {
      html += `<label class="toggle-label" title="Show or hide completed notes">
        <input type="checkbox" ${hideCompleted ? '' : 'checked'} onchange="toggleCompleted()" />
        <span>Show completed (${completedCount})</span>
      </label>`;
    }
    if (withPromptCount > 0 || noPromptCount > 0) {
      html += `<div class="prompt-filter-bar">
        <button class="prompt-filter-btn ${promptFilter === 'all' ? 'active' : ''}" onclick="setPromptFilter('all')">All</button>
        <button class="prompt-filter-btn ${promptFilter === 'with-prompt' ? 'active' : ''}" onclick="setPromptFilter('with-prompt')">Prompts (${withPromptCount})</button>
        <button class="prompt-filter-btn ${promptFilter === 'no-prompt' ? 'active' : ''}" onclick="setPromptFilter('no-prompt')">No Prompt (${noPromptCount})</button>
      </div>`;
    }
    html += `</div>`;
  }

  if (isDevMode) {
    const pendingCount = projectClips.filter(c => !c.completedAt).length;
    const doneCount = projectClips.filter(c => c.completedAt).length;
    html += `<div class="dev-filter-bar">
      <button class="filter-btn${devFilter === 'all' ? ' active' : ''}" onclick="setDevFilter('all')">All</button>
      <button class="filter-btn${devFilter === 'pending' ? ' active' : ''}" onclick="setDevFilter('pending')">Pending (${pendingCount})</button>
      <button class="filter-btn${devFilter === 'done' ? ' active' : ''}" onclick="setDevFilter('done')">Done (${doneCount})</button>
    </div>`;
  }

  if (proj.description) {
    html += `<div class="project-desc">${esc(proj.description)}</div>`;
  }
  if (proj.repo_path) {
    html += `<div class="project-repo">${esc(proj.repo_path)}</div>`;
  }
  if (proj.ide) {
    html += `<div class="project-ide-label">${esc(proj.ide)}</div>`;
  }

  // Final list = the same filter chain the search box uses (single source of
  // truth). The staged filtering above is only kept for the count badges.
  projectClips = getFilteredProjectClips();

  html += `<div class="search-bar" style="margin-top:12px">
    <input id="projectSearchInput" value="${escAttr(projectSearchQuery)}" placeholder="Search in project..."
      onkeydown="if(event.key==='Enter')searchProject()" oninput="searchProject()" />
  </div>`;

  if (projectFilterTags.length) {
    const joiner = projectFilterTags.length > 1
      ? `<span class="tag-join">${projectTagMatchMode === 'all' ? 'all of' : 'any of'}</span>` : '';
    html += `<div class="active-tag-filters">Filtering by ${joiner}${projectFilterTags.map((t) =>
      `<span class="tag" onclick="toggleProjectTag('${escAttr(t)}')" title="Remove #${escAttr(t)} filter">#${esc(t)} &times;</span>`).join('')}</div>`;
  }

  if (projectClips.length === 0) {
    if (totalInProject === 0) {
      html += `<div class="empty"><div class="ico">&#x1F4DD;</div>
        <div class="empty-title">No clips in this project</div>
        <div class="empty-sub">Assign clips from General Notes or capture new ones</div></div>`;
    } else {
      html += `<div class="empty"><div class="ico">&#x1F50D;</div>
        <div class="empty-title">No matching notes</div>
        <div class="empty-sub">No notes match the current tag or search filters</div></div>`;
    }
  } else {
    try {
      const tags = getAllKnownTags();
      html += projectClips.map((c) => renderClipCard(c, true, tags)).join('');
    } catch (e) {
      html += `<div class="empty"><div class="empty-title">Render error: ${e.message}</div></div>`;
    }
  }

  if (selectMode && selectedClipIds.size > 0) {
    html += `<div class="combine-bar">
      <span>${selectedClipIds.size} clip${selectedClipIds.size > 1 ? 's' : ''} selected</span>
      <button class="cap-btn small" onclick="combineSelectedPrompt()">Combine Prompt</button>
      ${isDevMode
        ? `<button class="cap-btn small send-ide" onclick="bundleAndSendSelected()">Bundle &amp; Send to IDE</button>`
        : `<button class="cap-btn small send-ide" onclick="combineAndSendToIde()">Combine &amp; Send to IDE</button>`
      }
      ${isDevMode && selectedClipIds.size >= 2 ? `<button class="queue-plan-btn" onclick="queueAsPlan()">Queue as Plan (${selectedClipIds.size} tasks)</button>` : ''}
      <button class="cancel-btn" onclick="clearSelection()">Clear</button>
    </div>`;
  }

  el.innerHTML = html;
  loadDiskImages(el);
}

let _projectSearchTimer = null;
function searchProject() {
  clearTimeout(_projectSearchTimer);
  _projectSearchTimer = setTimeout(_doSearchProject, 200);
}

function _doSearchProject() {
  const input = document.getElementById('projectSearchInput');
  if (!input) return;
  projectSearchQuery = input.value.trim();
  const el = document.getElementById('mainArea');
  if (!projects.find((p) => p.id === selectedProjectId)) return;

  // Incremental re-render of just the clip list — the search input keeps focus
  // because its DOM node is left untouched. Same filter chain as the full render.
  const projectClips = getFilteredProjectClips();
  const clipListHtml = projectClips.length > 0
    ? projectClips.map((c) => renderClipCard(c, true, getAllKnownTags())).join('')
    : `<div class="empty"><div class="empty-title">No matching notes</div></div>`;

  const container = el.querySelectorAll('.clip, .empty');
  container.forEach((node) => node.remove());

  const wrapper = document.createElement('div');
  wrapper.innerHTML = clipListHtml;
  while (wrapper.firstChild) el.appendChild(wrapper.firstChild);
  loadDiskImages(el);
}

// Single source of truth for the open project's visible clips: applies the
// completed / prompt / dev-mode / tag / search filters in order. Used by both
// renderProjectDetail (full render) and _doSearchProject (incremental render).
function getFilteredProjectClips() {
  let list = clips.filter((c) => c.project_id === selectedProjectId);
  if (hideCompleted) list = list.filter((c) => !c.completedAt);
  if (promptFilter === 'with-prompt') list = list.filter((c) => c.aiFixPrompt);
  else if (promptFilter === 'no-prompt') list = list.filter((c) => !c.aiFixPrompt);
  if (isDevMode && devFilter !== 'all') {
    if (devFilter === 'pending') list = list.filter((c) => !c.sentToIdeAt || !c.completedAt);
    else if (devFilter === 'done') list = list.filter((c) => c.completedAt);
  }
  if (projectFilterTags.length) {
    if (projectTagMatchMode === 'all') {
      // AND: clip must carry every selected tag
      list = list.filter((c) => projectFilterTags.every((t) => (c.tags || []).includes(t)));
    } else {
      // OR: clip carries any selected tag
      list = list.filter((c) => (c.tags || []).some((t) => projectFilterTags.includes(t)));
    }
  }
  if (projectSearchQuery) {
    const q = projectSearchQuery.toLowerCase();
    list = list.filter((c) => clipMatchesQuery(c, q));
  }
  return list;
}

function toggleCompleted() {
  hideCompleted = !hideCompleted;
  renderAll();
}

function setPromptFilter(value) {
  promptFilter = value;
  renderAll();
}

async function selectProject(id) {
  // In focused mode, must always have a project selected
  if (isFocusedMode && id === null) return;
  selectedProjectId = id;
  selectMode = false;
  selectedClipIds.clear();
  devFilter = 'all';
  projectDetailTab = 'notes';
  projectFilterTags = [];
  projectSearchQuery = '';
  tagGroupNaming = false;
  // Sync active project setting in focused mode
  if (isFocusedMode && id !== null) {
    window.quickclip.setFocusedActiveProject(id);
    // Re-detect dev mode for the new project
    isDevMode = await window.quickclip.hasProjectWorkflow(id);
    if (isDevMode) {
      const project = projects.find(p => p.id === id);
      ideStatus = await window.quickclip.detectIde(project?.repo_path);
      devPrompts = await window.quickclip.getWorkflowPrompts(id);
      startDevPolling();
    } else {
      ideStatus = null;
      devPrompts = [];
      stopDevPolling();
    }
    updateModeLabel();
  }
  renderAll();
}

// ── Clip Selection + Combine ──

function toggleSelectMode() {
  selectMode = !selectMode;
  selectedClipIds.clear();
  renderAll();
}

function toggleClipSelection(id) {
  if (!selectMode) return;
  if (selectedClipIds.has(id)) {
    selectedClipIds.delete(id);
  } else {
    selectedClipIds.add(id);
  }
  renderAll();
}

function clearSelection() {
  selectedClipIds.clear();
  renderAll();
}

async function combineSelectedPrompt() {
  if (selectedClipIds.size === 0) return;
  const clipIds = [...selectedClipIds];

  // Show loading overlay
  const overlay = document.createElement('div');
  overlay.id = 'combineOverlay';
  overlay.className = 'combine-overlay';
  overlay.innerHTML = `<div class="combine-modal">
    <div class="combine-loading"><span class="spinner">&#x2728;</span> Combining ${clipIds.length} clips&hellip;</div>
  </div>`;
  document.body.appendChild(overlay);

  try {
    const prompt = await window.quickclip.combineClipsPrompt(clipIds);
    overlay.innerHTML = `<div class="combine-modal">
      <div class="combine-header">
        <h3>Combined Prompt</h3>
        <button class="xbtn nd" onclick="document.getElementById('combineOverlay').remove()" title="Close">&#x2715;</button>
      </div>
      <div class="combine-result">${esc(prompt || 'No prompt generated.')}</div>
      <div class="combine-actions">
        <button class="cap-btn small" onclick="copyCombinedPrompt()">Copy</button>
        ${selectedProjectId
          ? (isDevMode
              ? `<button class="cap-btn small send-ide" onclick="bundleAndSendSelected()">Bundle &amp; Send</button>`
              : `<button class="cap-btn small send-ide" onclick="sendCombinedResultToIde()">Send to IDE</button>`)
          : ''}
        <button class="cancel-btn" onclick="document.getElementById('combineOverlay').remove()">Close</button>
      </div>
    </div>`;
  } catch (e) {
    overlay.innerHTML = `<div class="combine-modal">
      <div class="combine-header">
        <h3>Error</h3>
        <button class="xbtn nd" onclick="document.getElementById('combineOverlay').remove()" title="Close">&#x2715;</button>
      </div>
      <div class="combine-result">${esc(e.message)}</div>
      <div class="combine-actions">
        <button class="cancel-btn" onclick="document.getElementById('combineOverlay').remove()">Close</button>
      </div>
    </div>`;
  }
}

async function copyCombinedPrompt() {
  const el = document.querySelector('.combine-result');
  if (!el) return;
  await navigator.clipboard.writeText(el.textContent);
  showToast('Combined prompt copied to clipboard');
}

// ── Send to IDE ──

async function sendClipToIde(id) {
  try {
    await window.quickclip.sendToIde(id);
    showToast('Prompt sent to IDE');
  } catch (e) {
    showToast(e.message || 'Failed to send to IDE');
  }
}

async function combineAndSendToIde() {
  if (selectedClipIds.size === 0) return;
  if (!selectedProjectId) { showToast('Select a project first'); return; }
  const clipIds = [...selectedClipIds];

  showToast('Combining and sending to IDE...');
  try {
    await window.quickclip.combineAndSendToIde(clipIds, selectedProjectId);
    showToast('Combined prompt sent to IDE');
  } catch (e) {
    showToast(e.message || 'Failed to send to IDE');
  }
}

async function sendCombinedResultToIde() {
  if (selectedClipIds.size === 0 || !selectedProjectId) return;
  const clipIds = [...selectedClipIds];
  try {
    await window.quickclip.combineAndSendToIde(clipIds, selectedProjectId);
    showToast('Combined prompt sent to IDE');
    const overlay = document.getElementById('combineOverlay');
    if (overlay) overlay.remove();
  } catch (e) {
    showToast(e.message || 'Failed to send to IDE');
  }
}

window.quickclip.onClipSentToIde(() => {
  // Visual feedback already handled by showToast in the functions above
});

// ── Project Summary Panel ──

async function showProjectSummary(projectId) {
  const el = document.getElementById('mainArea');
  const proj = projects.find((p) => p.id === projectId);
  if (!proj) return;

  // Show loading state
  el.innerHTML = `<div class="project-detail-header">
    <div>
      <button class="back-btn" onclick="selectProject(${projectId})">&larr; Back to ${esc(proj.name)}</button>
      <h2 style="display:inline;margin-left:8px"><span class="proj-dot big" style="background:${esc(proj.color)}"></span>${esc(proj.name)} — Summary</h2>
    </div>
  </div>
  <div class="summary-loading"><span class="spinner">&#x2728;</span> Generating summaries&hellip;</div>`;

  try {
    const results = await window.quickclip.summarizeProject(projectId);
    renderSummaryPanel(el, proj, results);
    // Refresh clips in background since new summaries may have been saved
    clips = await window.quickclip.getClips();
  } catch (e) {
    el.innerHTML += `<div class="empty"><div class="empty-title">Summarization failed</div><div class="empty-sub">${esc(e.message)}</div></div>`;
  }
}

function renderSummaryPanel(el, proj, results) {
  const withContent = results.filter((r) => r.aiSummary || r.aiFixPrompt);
  if (withContent.length === 0) {
    el.innerHTML = `<div class="project-detail-header">
      <div>
        <button class="back-btn" onclick="selectProject(${proj.id})">&larr; Back to ${esc(proj.name)}</button>
        <h2 style="display:inline;margin-left:8px"><span class="proj-dot big" style="background:${esc(proj.color)}"></span>${esc(proj.name)} — Summary</h2>
      </div>
    </div>
    <div class="empty"><div class="empty-title">No notes to summarize</div></div>`;
    return;
  }

  let html = `<div class="project-detail-header">
    <div>
      <button class="back-btn" onclick="selectProject(${proj.id})">&larr; Back to ${esc(proj.name)}</button>
      <h2 style="display:inline;margin-left:8px"><span class="proj-dot big" style="background:${esc(proj.color)}"></span>${esc(proj.name)} — Summary</h2>
    </div>
    <div class="project-detail-actions">
      <button class="sb-btn-action summarize-btn" onclick="copySummaryPanel()" title="Copy all notes and summaries to clipboard">&#x1F4CB; Copy All</button>
    </div>
  </div>`;

  html += `<div class="summary-panel">`;
  html += `<div class="summary-row summary-header-row">
    <div class="summary-col-label">AI Summary</div>
    <div class="summary-col-label">AI Fix Prompt</div>
  </div>`;

  withContent.forEach((r) => {
    const catBadge = r.category ? `<span class="cat-badge">${esc(r.category)}</span>` : '';
    const tags = (r.tags && r.tags.length) ? `<div class="summary-tags">${r.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>` : '';
    const sumCount = r.summarizeCount || 0;
    const rowDarken = sumCount > 0 ? ` style="background: color-mix(in srgb, var(--bg-card), black ${Math.min(sumCount * 6, 30)}%)"` : '';
    const hasOriginal = r.comment && r.comment.trim();
    html += `<div class="summary-row"${rowDarken}>
      <div class="summary-col summary-original">
        <div class="summary-note-text">${esc(r.aiSummary) || '<em>No AI summary</em>'}</div>
        <div class="summary-note-meta">${catBadge} ${timeAgo(r.timestamp)}${sumCount > 0 ? ` <span class="badge badge-summarized">&#x2728; ${sumCount}x</span>` : ''}</div>
        ${hasOriginal ? `<details class="original-note-toggle"><summary>Original Note</summary><div class="original-note-body">${esc(r.comment)}</div></details>` : ''}
      </div>
      <div class="summary-col summary-ai">
        ${r.aiFixPrompt ? `<div class="summary-ai-text">${esc(r.aiFixPrompt)}</div>${tags}` : '<div class="summary-no-ai">No fix prompt generated</div>'}
      </div>
    </div>`;
  });

  html += `</div>`;
  el.innerHTML = html;
}

function copySummaryPanel() {
  const rows = document.querySelectorAll('.summary-row:not(.summary-header-row)');
  if (!rows.length) return;

  let text = '';
  rows.forEach((row) => {
    const summary = row.querySelector('.summary-original .summary-note-text');
    const ai = row.querySelector('.summary-ai-text');
    const summaryText = summary ? summary.textContent.trim() : '';
    const prompt = ai ? ai.textContent.trim() : '(no prompt generated)';
    text += `## Task\n${prompt}\n\nAI Summary: ${summaryText}\n\n---\n\n`;
  });

  navigator.clipboard.writeText(text.trim()).then(() => {
    const btn = document.querySelector('.summarize-btn');
    if (btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = '&#x2713; Copied!';
      setTimeout(() => { btn.innerHTML = orig; }, 1500);
    }
  }).catch(() => {});
}

// ── Project CRUD ──

function showNewProjectDialog() {
  const el = document.getElementById('mainArea');
  const existing = document.getElementById('projectDialog');
  if (existing) { existing.remove(); return; }

  const dialog = document.createElement('div');
  dialog.id = 'projectDialog';
  dialog.className = 'project-dialog';
  dialog.innerHTML = `
    <h3>New Project</h3>
    <label class="field-label">Name</label>
    <input id="projName" class="field-input" placeholder="e.g. Cvstomize" onkeydown="if(event.key==='Enter')saveNewProject()" />
    <label class="field-label">Description</label>
    <input id="projDesc" class="field-input" placeholder="What is this project about?" />
    <label class="field-label">Repo Path <span class="field-hint">— optional, for auto-detect</span></label>
    <input id="projRepo" class="field-input" placeholder="C:\\Users\\..." />
    <label class="field-label">Color</label>
    <div class="color-picker">
      <button class="color-dot active" style="background:#3b82f6" onclick="pickColor(this,'#3b82f6')"></button>
      <button class="color-dot" style="background:#8b5cf6" onclick="pickColor(this,'#8b5cf6')"></button>
      <button class="color-dot" style="background:#10b981" onclick="pickColor(this,'#10b981')"></button>
      <button class="color-dot" style="background:#f59e0b" onclick="pickColor(this,'#f59e0b')"></button>
      <button class="color-dot" style="background:#ef4444" onclick="pickColor(this,'#ef4444')"></button>
      <button class="color-dot" style="background:#ec4899" onclick="pickColor(this,'#ec4899')"></button>
      <button class="color-dot" style="background:#06b6d4" onclick="pickColor(this,'#06b6d4')"></button>
      <button class="color-dot" style="background:#84cc16" onclick="pickColor(this,'#84cc16')"></button>
    </div>
    <div class="dev-project-row">
      <div class="dev-project-info">
        <label class="field-label" style="margin:0">Developer Project</label>
        <span class="field-hint">— enables IDE integration</span>
      </div>
      <label class="toggle">
        <input type="checkbox" id="projDevToggle" onchange="toggleDevProject(this.checked)">
        <span class="toggle-slider"></span>
      </label>
    </div>
    <div id="ideField" class="ide-field hidden">
      <label class="field-label">IDE</label>
      <select id="projIde" class="field-input">
        <option value="">Select IDE...</option>
        <option value="VS Code">VS Code</option>
        <option value="Cursor">Cursor</option>
        <option value="Windsurf">Windsurf</option>
        <option value="IntelliJ">IntelliJ</option>
        <option value="WebStorm">WebStorm</option>
        <option value="Neovim">Neovim</option>
        <option value="Vim">Vim</option>
        <option value="Emacs">Emacs</option>
        <option value="Sublime Text">Sublime Text</option>
        <option value="Zed">Zed</option>
      </select>
    </div>
    <div class="dialog-actions">
      <button class="cap-btn small" onclick="saveNewProject()">Create</button>
      <button class="cancel-btn" onclick="document.getElementById('projectDialog').remove()">Cancel</button>
    </div>
  `;
  el.prepend(dialog);
  document.getElementById('projName').focus();
}

let newProjectColor = '#3b82f6';

function toggleDevProject(checked, targetId) {
  const ideField = document.getElementById(targetId || 'ideField');
  if (ideField) ideField.classList.toggle('hidden', !checked);
}

function pickColor(btn, color) {
  newProjectColor = color;
  document.querySelectorAll('.color-dot').forEach((d) => d.classList.remove('active'));
  btn.classList.add('active');
}

async function saveNewProject() {
  const name = document.getElementById('projName').value.trim();
  if (!name) return;
  const desc = document.getElementById('projDesc').value.trim();
  const repo = document.getElementById('projRepo').value.trim();
  const isDev = document.getElementById('projDevToggle')?.checked;
  const ide = isDev ? (document.getElementById('projIde')?.value || null) : null;
  await window.quickclip.createProject({
    name,
    description: desc,
    repo_path: repo || null,
    color: newProjectColor,
    ide,
  });
  projects = await window.quickclip.getProjects();
  newProjectColor = '#3b82f6';
  renderAll();
}

function editProject(id) {
  const proj = projects.find((p) => p.id === id);
  if (!proj) return;

  const el = document.getElementById('mainArea');
  const existing = document.getElementById('projectDialog');
  if (existing) existing.remove();

  const dialog = document.createElement('div');
  dialog.id = 'projectDialog';
  dialog.className = 'project-dialog';
  dialog.innerHTML = `
    <h3>Edit Project</h3>
    <label class="field-label">Name</label>
    <input id="editProjName" class="field-input" value="${escAttr(proj.name)}" />
    <label class="field-label">Description</label>
    <input id="editProjDesc" class="field-input" value="${escAttr(proj.description)}" />
    <label class="field-label">Repo Path</label>
    <input id="editProjRepo" class="field-input" value="${escAttr(proj.repo_path || '')}" />
    <label class="field-label">Color</label>
    <div class="color-picker">
      ${['#3b82f6','#8b5cf6','#10b981','#f59e0b','#ef4444','#ec4899','#06b6d4','#84cc16'].map((c) =>
        `<button class="color-dot ${proj.color === c ? 'active' : ''}" style="background:${c}" onclick="pickEditColor(this,'${c}')"></button>`
      ).join('')}
    </div>
    <div class="dev-project-row">
      <div class="dev-project-info">
        <label class="field-label" style="margin:0">Developer Project</label>
        <span class="field-hint">— enables IDE integration</span>
      </div>
      <label class="toggle">
        <input type="checkbox" id="editProjDevToggle" ${proj.ide ? 'checked' : ''} onchange="toggleDevProject(this.checked, 'editIdeField')">
        <span class="toggle-slider"></span>
      </label>
    </div>
    <div id="editIdeField" class="ide-field ${proj.ide ? '' : 'hidden'}">
      <label class="field-label">IDE</label>
      <select id="editProjIde" class="field-input">
        ${['', 'VS Code', 'Cursor', 'Windsurf', 'IntelliJ', 'WebStorm', 'Neovim', 'Vim', 'Emacs', 'Sublime Text', 'Zed'].map((v) =>
          `<option value="${v}" ${proj.ide === v ? 'selected' : ''}>${v || 'Select IDE...'}</option>`
        ).join('')}
      </select>
    </div>
    <div class="dialog-actions">
      <button class="cap-btn small" onclick="saveEditProject(${id})">Save</button>
      <button class="cancel-btn" onclick="document.getElementById('projectDialog').remove()">Cancel</button>
    </div>
  `;
  el.prepend(dialog);
  document.getElementById('editProjName').focus();
}

let editProjectColor = null;

function pickEditColor(btn, color) {
  editProjectColor = color;
  document.querySelectorAll('.color-dot').forEach((d) => d.classList.remove('active'));
  btn.classList.add('active');
}

async function saveEditProject(id) {
  const name = document.getElementById('editProjName').value.trim();
  if (!name) return;
  const desc = document.getElementById('editProjDesc').value.trim();
  const repo = document.getElementById('editProjRepo').value.trim();
  const isDev = document.getElementById('editProjDevToggle')?.checked;
  const ide = isDev ? (document.getElementById('editProjIde')?.value || null) : null;
  const proj = projects.find((p) => p.id === id);
  await window.quickclip.updateProject(id, {
    name,
    description: desc,
    repo_path: repo || null,
    color: editProjectColor || (proj ? proj.color : '#3b82f6'),
    ide,
  });
  projects = await window.quickclip.getProjects();
  editProjectColor = null;
  renderAll();
}

async function confirmDeleteProject(id) {
  const proj = projects.find((p) => p.id === id);
  if (!proj) return;
  // Simple confirm via re-rendering with a confirm banner
  const confirmed = confirm(`Delete project "${proj.name}"?\n\nClips will be moved to General Notes.`);
  if (!confirmed) return;
  await window.quickclip.deleteProject(id);
  projects = await window.quickclip.getProjects();
  clips = await window.quickclip.getClips();
  selectedProjectId = null;
  renderAll();
}

// ── Settings Content ──

function renderSettingsContent(el) {
  const general = settings.general || { openWindowOnLaunch: true, minimizeToTray: true, theme: 'dark' };
  const capture = settings.capture || { hotkey: 'ctrl+shift+q', watchClipboard: true, pollInterval: 500, autoCategory: true };
  const aiSettings = settings.ai || { enabled: true, autoCategorizeonSave: true, retryUncategorizedOnStartup: true, autoCopyFocusedPrompt: false };

  const ver = appVersion || { version: '?', electron: '?', node: '?' };

  el.innerHTML = `
    <div class="settings-page">
      <h2>Settings</h2>

      <div class="version-banner">
        HuminLoop v${esc(ver.version)}
        <span class="version-detail">Electron ${esc(ver.electron)} · Node ${esc(ver.node)}</span>
      </div>

      <div class="settings-section">
        <h3>Display</h3>
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">Display size</div>
            <div class="setting-desc">Scales text, spacing and icons together. Also bound to <kbd>Ctrl</kbd>+<kbd>=</kbd>/<kbd>-</kbd>/<kbd>0</kbd>.</div>
          </div>
          <div class="zoom-controls">
            <button class="zoom-btn" id="zoomOutBtn" onclick="adjustZoom(-1)" title="Smaller (Ctrl+-)">A&#8722;</button>
            <button class="zoom-btn" onclick="setZoom(0)" title="Reset to default (Ctrl+0)">Reset</button>
            <button class="zoom-btn" id="zoomInBtn" onclick="adjustZoom(1)" title="Larger (Ctrl+=)">A+</button>
            <span class="zoom-readout" id="zoomReadout">100%</span>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <h3>General</h3>
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">Open window on launch</div>
            <div class="setting-desc">Show the main window when HuminLoop starts</div>
          </div>
          <label class="toggle">
            <input type="checkbox" ${general.openWindowOnLaunch ? 'checked' : ''} onchange="updateSetting('general','openWindowOnLaunch',this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">Minimize to tray</div>
            <div class="setting-desc">Hide to system tray instead of closing</div>
          </div>
          <label class="toggle">
            <input type="checkbox" ${general.minimizeToTray ? 'checked' : ''} onchange="updateSetting('general','minimizeToTray',this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">Theme</div>
            <div class="setting-desc">Color theme for the app</div>
          </div>
          <select class="setting-select" onchange="updateSetting('general','theme',this.value)">
            <option value="dark" ${general.theme === 'dark' ? 'selected' : ''}>Dark</option>
            <option value="light" ${general.theme === 'light' ? 'selected' : ''}>Light</option>
          </select>
        </div>
      </div>

      <div class="settings-section">
        <h3>Capture</h3>
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">Hotkey</div>
            <div class="setting-desc">Keyboard shortcut for quick capture</div>
          </div>
          <input class="setting-input" value="${escAttr(capture.hotkey)}" onchange="updateSetting('capture','hotkey',this.value)" />
        </div>
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">Watch clipboard</div>
            <div class="setting-desc">Auto-detect screenshots from clipboard</div>
          </div>
          <label class="toggle">
            <input type="checkbox" ${capture.watchClipboard ? 'checked' : ''} onchange="updateSetting('capture','watchClipboard',this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">Poll interval (ms)</div>
            <div class="setting-desc">How often to check the clipboard for new screenshots</div>
          </div>
          <input class="setting-input" type="number" value="${capture.pollInterval}" onchange="updateSetting('capture','pollInterval',parseInt(this.value))" />
        </div>
      </div>

      <div class="settings-section">
        <h3>AI</h3>
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">AI enabled</div>
            <div class="setting-desc">Enable Gemini AI for categorization and search</div>
          </div>
          <label class="toggle">
            <input type="checkbox" ${aiSettings.enabled ? 'checked' : ''} onchange="updateSetting('ai','enabled',this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">Auto-categorize on save</div>
            <div class="setting-desc">Automatically run AI categorization when a clip is saved</div>
          </div>
          <label class="toggle">
            <input type="checkbox" ${aiSettings.autoCategorizeonSave ? 'checked' : ''} onchange="updateSetting('ai','autoCategorizeonSave',this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">Retry uncategorized on startup</div>
            <div class="setting-desc">Re-attempt AI categorization for unsorted clips when app starts</div>
          </div>
          <label class="toggle">
            <input type="checkbox" ${aiSettings.retryUncategorizedOnStartup ? 'checked' : ''} onchange="updateSetting('ai','retryUncategorizedOnStartup',this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">Auto-copy focused prompt</div>
            <div class="setting-desc">Copy the AI-generated prompt to clipboard automatically after focused capture</div>
          </div>
          <label class="toggle">
            <input type="checkbox" ${aiSettings.autoCopyFocusedPrompt ? 'checked' : ''} onchange="updateSetting('ai','autoCopyFocusedPrompt',this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>

      ${renderAnnotationColorSettings()}

      <div class="settings-section">
        <h3>AI Instructions</h3>
        <p class="setting-desc">Toggle which instructions the AI follows when categorizing. Disabling blocks reduces token usage and API cost.</p>
        <div id="promptBlockList" class="prompt-block-list">Loading...</div>
        <div id="customBlockList" class="prompt-block-list"></div>
        <div class="prompt-footer">
          <div class="prompt-meta">
            <span id="tokenCount" class="token-count">~ 0 tokens</span>
            <span class="token-hint">per categorization request</span>
          </div>
          <div class="prompt-actions">
            <button type="button" class="btn-sm secondary" onclick="showAddCustomBlock()">+ Custom Rule</button>
            <button type="button" class="btn-sm secondary" onclick="resetPromptBlocks()">Reset All</button>
          </div>
        </div>
        <div id="customBlockForm" class="custom-block-form hidden">
          <input id="customBlockLabel" class="setting-input" placeholder="Rule name (e.g. &quot;Ignore browser tabs&quot;)" />
          <textarea id="customBlockText" class="setting-textarea" rows="3" placeholder="Instruction text for the AI..."></textarea>
          <div class="prompt-actions">
            <button type="button" class="btn-sm secondary" onclick="hideCustomBlockForm()">Cancel</button>
            <button type="button" class="btn-sm primary" onclick="addCustomBlock()">Add Rule</button>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <h3>Database</h3>
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">Status</div>
            <div class="setting-desc">PostgreSQL connection via Docker</div>
          </div>
          <span class="setting-badge ok">Connected</span>
        </div>
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">Total clips</div>
            <div class="setting-desc">Across all projects and general notes</div>
          </div>
          <span class="setting-value">${clips.length}</span>
        </div>
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">Projects</div>
            <div class="setting-desc">Active project count</div>
          </div>
          <span class="setting-value">${projects.length}</span>
        </div>
      </div>

      <div class="settings-section">
        <h3>Activity Log</h3>
        <p class="setting-desc" style="margin-bottom:8px">Recent changes — create, update, delete, AI categorization</p>
        <div id="auditLogList" class="audit-log-list">Loading...</div>
        <div class="prompt-actions" style="margin-top:8px">
          <button type="button" class="btn-sm secondary" onclick="clearAuditLog()">Clear Log</button>
        </div>
      </div>
    </div>
  `;
}

async function updateSetting(section, key, value) {
  const current = settings[section] || {};
  current[key] = value;
  settings[section] = current;
  await window.quickclip.saveSetting(section, current);
}

// ── Annotation Color Settings ──

function renderAnnotationColorSettings() {
  const colors = settings.annotation_colors || [
    { id: 'red', hex: '#FF0000', label: 'Delete / Remove / Error', shortLabel: 'remove' },
    { id: 'green', hex: '#00FF00', label: 'Add / Insert', shortLabel: 'add' },
    { id: 'pink', hex: '#FF69B4', label: 'Identify / Reference / Question', shortLabel: 'reference' },
  ];

  let html = '<div class="settings-section"><h3>Annotation Colors</h3>';
  html += '<p class="settings-hint">Define colors used in screenshot annotations. These labels are used by AI when interpreting your markings.</p>';
  html += '<div id="annotation-colors-list">';

  colors.forEach((c, i) => {
    html += `<div class="annotation-color-row" data-index="${i}">`;
    html += `<input type="color" value="${escAttr(c.hex)}" onchange="updateAnnotationColor(${i}, 'hex', this.value)" />`;
    html += `<input type="text" value="${escAttr(c.id)}" placeholder="ID (e.g. red)" class="color-id-input" onchange="updateAnnotationColor(${i}, 'id', this.value)" />`;
    html += `<input type="text" value="${escAttr(c.label)}" placeholder="Label" class="color-label-input" onchange="updateAnnotationColor(${i}, 'label', this.value)" />`;
    html += `<input type="text" value="${escAttr(c.shortLabel)}" placeholder="Short" class="color-short-input" onchange="updateAnnotationColor(${i}, 'shortLabel', this.value)" />`;
    if (i > 0) html += `<button class="color-move-btn" onclick="moveAnnotationColor(${i}, -1)" title="Move up">&uarr;</button>`;
    if (i < colors.length - 1) html += `<button class="color-move-btn" onclick="moveAnnotationColor(${i}, 1)" title="Move down">&darr;</button>`;
    html += `<button class="del-btn" onclick="removeAnnotationColor(${i})" title="Remove">&times;</button>`;
    html += `</div>`;
  });

  html += '</div>';
  html += '<button class="btn-secondary" onclick="addAnnotationColor()">+ Add Color</button>';
  html += '</div>';
  return html;
}

async function updateAnnotationColor(index, field, value) {
  const colors = settings.annotation_colors || [
    { id: 'red', hex: '#FF0000', label: 'Delete / Remove / Error', shortLabel: 'remove' },
    { id: 'green', hex: '#00FF00', label: 'Add / Insert', shortLabel: 'add' },
    { id: 'pink', hex: '#FF69B4', label: 'Identify / Reference / Question', shortLabel: 'reference' },
  ];
  colors[index][field] = value;
  await window.quickclip.saveAnnotationColors(colors);
  settings.annotation_colors = colors;
}

async function addAnnotationColor() {
  const colors = settings.annotation_colors || [
    { id: 'red', hex: '#FF0000', label: 'Delete / Remove / Error', shortLabel: 'remove' },
    { id: 'green', hex: '#00FF00', label: 'Add / Insert', shortLabel: 'add' },
    { id: 'pink', hex: '#FF69B4', label: 'Identify / Reference / Question', shortLabel: 'reference' },
  ];
  colors.push({ id: 'new', hex: '#808080', label: 'New color', shortLabel: 'new' });
  await window.quickclip.saveAnnotationColors(colors);
  settings.annotation_colors = colors;
  renderAll();
}

async function removeAnnotationColor(index) {
  const colors = settings.annotation_colors || [];
  colors.splice(index, 1);
  await window.quickclip.saveAnnotationColors(colors);
  settings.annotation_colors = colors;
  renderAll();
}

async function moveAnnotationColor(index, direction) {
  const colors = settings.annotation_colors || [];
  const newIndex = index + direction;
  if (newIndex < 0 || newIndex >= colors.length) return;
  [colors[index], colors[newIndex]] = [colors[newIndex], colors[index]];
  await window.quickclip.saveAnnotationColors(colors);
  settings.annotation_colors = colors;
  renderAll();
}

// ── AI Prompt Blocks ──

let promptData = null;

async function loadPromptBlocks() {
  const el = document.getElementById('promptBlockList');
  if (!el) return;
  promptData = await window.quickclip.getPromptBlocks();
  renderPromptBlocks();
}

function renderPromptBlocks() {
  if (!promptData) return;
  const el = document.getElementById('promptBlockList');
  const customEl = document.getElementById('customBlockList');
  const tokenEl = document.getElementById('tokenCount');

  // Built-in blocks
  el.innerHTML = promptData.blocks.map(b => `
    <div class="prompt-block ${b.enabled ? '' : 'disabled'}">
      <label class="toggle">
        <input type="checkbox" ${b.enabled ? 'checked' : ''} onchange="toggleBlock('${b.id}', this.checked)">
        <span class="toggle-slider"></span>
      </label>
      <div class="prompt-block-info">
        <div class="prompt-block-label">${esc(b.label)}</div>
        <div class="prompt-block-desc">${esc(b.desc)}</div>
      </div>
      <span class="prompt-block-tokens">~${b.tokens} tok</span>
    </div>
  `).join('');

  // Custom blocks
  if (promptData.custom.length > 0) {
    customEl.innerHTML = '<div class="prompt-block-divider">Custom Rules</div>' +
      promptData.custom.map(cb => `
        <div class="prompt-block ${cb.enabled ? '' : 'disabled'}">
          <label class="toggle">
            <input type="checkbox" ${cb.enabled ? 'checked' : ''} onchange="toggleCustomBlock('${cb.id}', this.checked)">
            <span class="toggle-slider"></span>
          </label>
          <div class="prompt-block-info">
            <div class="prompt-block-label">${esc(cb.label)}</div>
            <div class="prompt-block-desc">${esc(cb.text.slice(0, 80))}${cb.text.length > 80 ? '...' : ''}</div>
          </div>
          <span class="prompt-block-tokens">~${cb.tokens} tok</span>
          <button type="button" class="prompt-block-delete" onclick="deleteCustomBlock('${cb.id}')" title="Remove">x</button>
        </div>
      `).join('');
  } else {
    customEl.innerHTML = '';
  }

  if (tokenEl) tokenEl.textContent = `~ ${promptData.totalTokens.toLocaleString()} tokens`;
}

async function toggleBlock(id, enabled) {
  const enabledMap = {};
  for (const b of promptData.blocks) enabledMap[b.id] = b.id === id ? enabled : b.enabled;
  const custom = promptData.custom.map(c => ({ id: c.id, label: c.label, text: c.text, enabled: c.enabled }));
  promptData = await window.quickclip.savePromptBlocks(enabledMap, custom);
  renderPromptBlocks();
}

async function toggleCustomBlock(id, enabled) {
  const enabledMap = {};
  for (const b of promptData.blocks) enabledMap[b.id] = b.enabled;
  const custom = promptData.custom.map(c => ({
    id: c.id, label: c.label, text: c.text, enabled: c.id === id ? enabled : c.enabled,
  }));
  promptData = await window.quickclip.savePromptBlocks(enabledMap, custom);
  renderPromptBlocks();
}

async function deleteCustomBlock(id) {
  const enabledMap = {};
  for (const b of promptData.blocks) enabledMap[b.id] = b.enabled;
  const custom = promptData.custom.filter(c => c.id !== id).map(c => ({ id: c.id, label: c.label, text: c.text, enabled: c.enabled }));
  promptData = await window.quickclip.savePromptBlocks(enabledMap, custom);
  renderPromptBlocks();
}

async function resetPromptBlocks() {
  promptData = await window.quickclip.resetPromptBlocks();
  renderPromptBlocks();
}

function showAddCustomBlock() {
  document.getElementById('customBlockForm').classList.remove('hidden');
  document.getElementById('customBlockLabel').focus();
}

function hideCustomBlockForm() {
  document.getElementById('customBlockForm').classList.add('hidden');
  document.getElementById('customBlockLabel').value = '';
  document.getElementById('customBlockText').value = '';
}

async function addCustomBlock() {
  const label = document.getElementById('customBlockLabel').value.trim();
  const text = document.getElementById('customBlockText').value.trim();
  if (!label || !text) return;
  promptData = await window.quickclip.addCustomBlock(label, text);
  hideCustomBlockForm();
  renderPromptBlocks();
}

// ── Audit Ledger ──

async function loadAuditLog() {
  const el = document.getElementById('auditLogList');
  if (!el) return;
  const log = await window.quickclip.getAuditLog();
  if (!log || log.length === 0) {
    el.innerHTML = '<div class="audit-empty">No activity recorded yet</div>';
    return;
  }
  el.innerHTML = log.slice(0, 50).map(entry => {
    const icon = { create: '&#x2795;', delete: '&#x1F5D1;', update: '&#x270E;', complete: '&#x2713;', ai: '&#x2728;' }[entry.action] || '&#x25CF;';
    return `<div class="audit-entry"><span class="audit-icon">${icon}</span><span class="audit-detail">${esc(entry.detail)}</span><span class="audit-time">${timeAgo(entry.ts)}</span></div>`;
  }).join('');
}

async function clearAuditLog() {
  await window.quickclip.clearAuditLog();
  const el = document.getElementById('auditLogList');
  if (el) el.innerHTML = '<div class="audit-empty">Log cleared</div>';
}

// =====================================================================
//  CLIP CARD
// =====================================================================

function getAllKnownTags() {
  const tagSet = new Set();
  for (const cl of clips) {
    if (cl.tags && cl.tags.length) cl.tags.forEach(t => tagSet.add(t));
  }
  return Array.from(tagSet).sort();
}

// Shared free-text search predicate — q must already be lower-cased.
function clipMatchesQuery(c, q) {
  return (c.comment || '').toLowerCase().includes(q) ||
    (c.category || '').toLowerCase().includes(q) ||
    (c.tags || []).some((t) => t.toLowerCase().includes(q)) ||
    (c.aiSummary || '').toLowerCase().includes(q) ||
    (c.comments || []).some((x) => x.text.toLowerCase().includes(q));
}

function renderClipCard(c, inProject, allKnownTags) {
  const id = escAttr(c.id);
  const isActive = c.status === 'active';
  const isCompleted = !!c.completedAt;
  const statusClass = isActive ? 'badge-active' : 'badge-parked';
  const statusLabel = isActive ? 'ACTIVE' : 'PARKED';

  // Progressive darkening based on summarize count
  const sumCount = c.summarizeCount || 0;
  const darkenStyle = sumCount > 0 ? ` style="background: color-mix(in srgb, var(--bg-card), black ${Math.min(sumCount * 6, 30)}%)"` : '';

  const isSelected = selectMode && inProject && selectedClipIds.has(c.id);
  const selectClick = selectMode && inProject ? ` onclick="toggleClipSelection('${id}')"` : '';
  const selectCursor = selectMode && inProject ? ' select-mode' : '';

  let html = `<div class="clip${isCompleted ? ' clip-completed' : ''}${isSelected ? ' clip-selected' : ''}${selectCursor}"${isSelected ? '' : darkenStyle} data-testid="clip-card-${id}"${selectClick}>`;

  // Header row
  html += `<div class="clip-hdr">`;
  html += `<div class="clip-meta">`;

  if (isCompleted) {
    html += `<span class="badge badge-completed" onclick="uncompleteClip('${id}')" title="Click to mark as incomplete">&#x2713; DONE</span>`;
  } else {
    html += `<span class="badge ${statusClass}" onclick="toggleStatus('${id}')" title="Click to toggle between Active and Parked">${statusLabel}</span>`;
  }

  html += `<span class="cat-badge" title="Category — assigned by AI or manually">${esc(c.category)}</span>`;
  if (c.projectName && !inProject) {
    html += `<span class="proj-badge" style="border-color:${esc(c.projectColor || '#3b82f6')}">${esc(c.projectName)}</span>`;
  }
  if (sumCount > 0) {
    html += `<span class="badge badge-summarized" title="Summarized ${sumCount} time${sumCount > 1 ? 's' : ''}">&#x2728; ${sumCount}x</span>`;
  }
  html += `</div>`;
  html += `<div class="clip-actions">`;
  html += `<span class="clip-time">${timeAgo(c.timestamp)}</span>`;

  // Copy note text button
  if (c.comment) {
    html += `<button class="copy-note-btn" onclick="copyNoteText('${id}')" title="Copy note text + screenshot to clipboard">&#x1F4CB; Note</button>`;
  }

  // Copy prompt button (if aiFixPrompt exists)
  if (c.aiFixPrompt) {
    html += `<button class="copy-prompt-btn" onclick="copyPrompt('${id}')" title="Copy AI fix prompt to clipboard">&#x1F4CB; Prompt</button>`;
    if (c.project_id) {
      if (isDevMode) {
        if (c.sentToIdeAt) {
          html += `<button class="send-ide-btn sent" onclick="bundleAndSend('${id}')" title="Bundled ${timeAgo(new Date(c.sentToIdeAt).getTime())} — click to resend">&#x2705; Bundled</button>`;
        } else {
          html += `<button class="bundle-send-btn" onclick="bundleAndSend('${id}')" title="Bundle context and send to IDE">&#x1F4E6; Bundle &amp; Send</button>`;
        }
      } else {
        if (c.sentToIdeAt) {
          html += `<button class="send-ide-btn sent" onclick="sendClipToIde('${id}')" title="Sent to IDE ${timeAgo(new Date(c.sentToIdeAt).getTime())} — click to resend">&#x2705; Sent</button>`;
        } else {
          html += `<button class="send-ide-btn" onclick="sendClipToIde('${id}')" title="Send prompt to IDE AI chat">&#x1F4E4; IDE</button>`;
        }
      }
    }
  }

  // Manual AI trigger (if has comment but no AI summary, or no aiFixPrompt)
  if ((c.comment && !c.aiSummary) || (c.comment && !c.aiFixPrompt)) {
    html += `<button class="ai-trigger-btn" onclick="retriggerAi('${id}')" title="Run AI categorization on this clip">&#x2728; AI</button>`;
  }

  // Complete button (only if not already complete)
  if (!isCompleted) {
    html += `<button class="complete-btn" onclick="showCompleteDialog('${id}')" title="Mark as complete" data-testid="clip-complete-btn">&#x2713;</button>`;
  }

  // Move to project dropdown
  if (!inProject && projects.length > 0) {
    html += `<select class="move-select" onchange="moveToProject('${id}', this.value)" title="Move to project">`;
    html += `<option value="">Move...</option>`;
    projects.forEach((p) => {
      html += `<option value="${p.id}">${esc(p.name)}</option>`;
    });
    html += `</select>`;
  }
  if (inProject) {
    html += `<button class="del-btn" onclick="unassignClip('${id}')" title="Move to General Notes">&#x2190;</button>`;
  }

  html += `<button class="del-btn" onclick="deleteClip('${id}')" title="Delete this clip">&#x2715;</button>`;
  html += `</div></div>`;

  // Screenshot
  if (c.image === '__on_disk__') {
    html += `<div class="img-wrap">`;
    html += `<img data-clip-id="${id}" class="img-loading" onclick="this.classList.toggle('expanded')" title="Click to expand/collapse screenshot" />`;
    html += `<button class="img-copy-btn" onclick="event.stopPropagation();copyClipImage('${id}',this)" title="Copy image to clipboard">&#x1F4CB;</button>`;
    html += `</div>`;
  } else if (c.image) {
    html += `<div class="img-wrap">`;
    html += `<img src="${esc(c.image)}" onclick="this.classList.toggle('expanded')" title="Click to expand/collapse screenshot" />`;
    html += `<button class="img-copy-btn" onclick="event.stopPropagation();copyClipImage('${id}',this)" title="Copy image to clipboard">&#x1F4CB;</button>`;
    html += `</div>`;
  }

  // Comment (flows beside the thumbnail)
  if (c.comment) html += `<div class="comment copyable" onclick="copyInline(this, 'comment', '${id}')">${esc(c.comment)}<span class="copy-hint" title="Click to copy comment">&#x1F4CB;</span></div>`;

  // Clear float so everything below sits under the thumbnail
  html += `<div class="clip-clearfix"></div>`;

  // AI summary (filing label)
  if (c.aiSummary) html += `<div class="ai-summary copyable" onclick="copyInline(this, 'aiSummary', '${id}')"><span class="ai-label">AI Summary</span> ${esc(c.aiSummary)}<span class="copy-hint" title="Click to copy AI summary">&#x1F4CB;</span></div>`;

  // AI fix prompt inline (actionable prompt for IDE injection)
  if (c.aiFixPrompt) html += `<div class="ai-fix-prompt copyable" onclick="copyInline(this, 'aiFixPrompt', '${id}')"><span class="ai-label">AI Prompt</span> ${esc(c.aiFixPrompt)}<span class="copy-hint" title="Click to copy AI prompt">&#x1F4CB;</span></div>`;

  // Completed timestamp
  if (isCompleted) {
    html += `<div class="completed-stamp" title="Completed at ${esc(c.completedAt)}">&#x2713; Completed ${timeAgo(new Date(c.completedAt).getTime())}</div>`;
  }

  // Tags
  html += `<div class="tags-row">`;
  if (c.tags && c.tags.length) {
    html += c.tags.map((t) => `<span class="tag">#${esc(t)}<button class="tag-remove" onclick="removeTag('${id}','${escAttr(t)}')" title="Remove tag">&times;</button></span>`).join('');
    html += `<span class="copy-hint tag-copy" onclick="event.stopPropagation(); copyTags('${id}')" title="Click to copy all tags">&#x1F4CB;</span>`;
  }
  html += `<button class="add-tag-btn" onclick="showTagInput('${id}')" title="Add a tag">+ Tag</button>`;
  html += `</div>`;
  html += `<div id="ti-${id}" style="display:none;margin-bottom:6px;gap:4px">`;
  html += `<select class="tag-select" id="tsel-${id}" onchange="onTagSelect('${id}', this.value)">`;
  html += `<option value="">Pick a tag...</option>`;
  const currentTags = c.tags || [];
  allKnownTags.forEach((t) => {
    if (!currentTags.includes(t)) html += `<option value="${escAttr(t)}">#${esc(t)}</option>`;
  });
  html += `<option value="__new__">New tag...</option>`;
  html += `</select>`;
  html += `<input class="tag-input" id="tin-${id}" placeholder="new tag..." style="display:none" `
    + `onkeydown="if(event.key==='Enter')addTag('${id}');if(event.key==='Escape')hideTagInput('${id}')" />`;
  html += `</div>`;

  // Thread comments
  if (c.comments && c.comments.length) {
    html += `<div class="thread">`;
    c.comments.forEach((x, idx) => {
      html += `<div class="thread-item" id="thread-${id}-${idx}">`;
      html += `<span class="thread-text">${esc(x.text)}</span> <span class="ts">— ${timeAgo(x.ts)}</span>`;
      html += `<span class="thread-actions">`;
      html += `<button class="thread-edit-btn" onclick="editComment('${id}', ${idx})" title="Edit comment">&#x270E;</button>`;
      html += `<button class="thread-del-btn" onclick="deleteComment('${id}', ${idx})" title="Delete comment">&times;</button>`;
      html += `</span>`;
      html += `</div>`;
    });
    html += `</div>`;
  }

  // Add comment input
  html += `<button class="add-comment-btn" onclick="showCommentInput('${id}')" title="Add a follow-up note to this clip">+ Comment</button>`;
  html += `<div id="ci-${id}" style="display:none;margin-top:6px">`;
  html += `<input class="comment-input" id="cin-${id}" placeholder="Add a thought..." spellcheck="true" `
    + `onkeydown="if(event.key==='Enter')addComment('${id}');if(event.key==='Escape')hideCommentInput('${id}')" />`;
  html += `</div></div>`;

  return html;
}

// ── Lazy-load images stored on disk ──

async function loadDiskImages(container) {
  const imgs = container.querySelectorAll('img[data-clip-id]');
  for (const img of imgs) {
    const dataUrl = await window.quickclip.getClipImage(img.dataset.clipId);
    if (dataUrl) {
      img.src = dataUrl;
      img.classList.remove('img-loading');
    }
  }
}

// ── Clip Actions ──

async function toggleStatus(id) {
  const clip = clips.find((c) => c.id === id);
  if (!clip) return;
  const newStatus = clip.status === 'active' ? 'parked' : 'active';
  await window.quickclip.updateClip(id, { status: newStatus });
  clip.status = newStatus;
  renderAll();
}

function showCompleteDialog(id) {
  // Remove any existing dialog
  const existing = document.getElementById('completeDialog');
  if (existing) existing.remove();

  const dialog = document.createElement('div');
  dialog.id = 'completeDialog';
  dialog.className = 'complete-dialog-overlay';
  dialog.setAttribute('data-testid', 'complete-dialog');
  dialog.innerHTML = `
    <div class="complete-dialog">
      <h3>Mark as Complete</h3>
      <p>What would you like to do with this note?</p>
      <div class="complete-dialog-actions">
        <button class="complete-dialog-btn keep-btn" onclick="completeClip('${escAttr(id)}', false)" data-testid="complete-keep-btn">
          <span class="complete-icon">&#x2713;</span>
          <span class="complete-label">Complete</span>
          <span class="complete-desc">Mark done, stays visible</span>
        </button>
        <button class="complete-dialog-btn archive-btn" onclick="completeClip('${escAttr(id)}', true)" data-testid="complete-trash-btn">
          <span class="complete-icon">&#x1F5D1;</span>
          <span class="complete-label">Trash</span>
          <span class="complete-desc">Done &amp; moved to trash</span>
        </button>
      </div>
      <button class="cancel-btn" onclick="document.getElementById('completeDialog').remove()">Cancel</button>
    </div>
  `;
  document.body.appendChild(dialog);
}

async function completeClip(id, archive) {
  const dialog = document.getElementById('completeDialog');
  if (dialog) dialog.remove();
  await window.quickclip.completeClip(id, archive);
  clips = await window.quickclip.getClips();
  renderAll();
}

async function uncompleteClip(id) {
  await window.quickclip.uncompleteClip(id);
  clips = await window.quickclip.getClips();
  renderAll();
}

async function deleteClip(id) {
  await window.quickclip.deleteClip(id);
  clips = clips.filter((c) => c.id !== id);
  renderAll();
}

async function copyPrompt(id) {
  const clip = clips.find(c => c.id === id);
  if (clip && clip.aiFixPrompt) {
    await navigator.clipboard.writeText(clip.aiFixPrompt);
  }
}

async function copyClipImage(id, btn) {
  const ok = await window.quickclip.copyImageToClipboard(id);
  if (ok) {
    btn.classList.add('img-copy-flash');
    setTimeout(() => btn.classList.remove('img-copy-flash'), 800);
  }
}

async function copyInline(el, field, id) {
  const clip = clips.find(c => c.id === id);
  if (!clip) return;
  const text = field === 'comment' ? clip.comment : field === 'aiSummary' ? clip.aiSummary : clip.aiFixPrompt;
  if (!text) return;
  await navigator.clipboard.writeText(text);
  el.classList.add('copy-flash');
  setTimeout(() => el.classList.remove('copy-flash'), 600);
}

async function copyTags(id) {
  const clip = clips.find(c => c.id === id);
  if (!clip || !clip.tags || !clip.tags.length) return;
  await navigator.clipboard.writeText(clip.tags.map(t => '#' + t).join(' '));
  const row = document.querySelector(`#ci-${id}`)?.previousElementSibling || document.querySelector(`.tags-row`);
  const hint = document.querySelector(`[onclick="event.stopPropagation(); copyTags('${id}')"]`);
  if (hint) { hint.classList.add('copy-flash'); setTimeout(() => hint.classList.remove('copy-flash'), 600); }
}

async function retriggerAi(id) {
  const result = await window.quickclip.retriggerAi(id);
  if (result) {
    const idx = clips.findIndex(c => c.id === id);
    if (idx !== -1) {
      clips[idx] = { ...clips[idx], ...result };
    }
    renderAll();
  }
}

async function moveToProject(clipId, projectId) {
  if (!projectId) return;
  await window.quickclip.assignClipToProject(clipId, parseInt(projectId));
  clips = await window.quickclip.getClips();
  projects = await window.quickclip.getProjects();
  renderAll();
}

async function unassignClip(clipId) {
  await window.quickclip.assignClipToProject(clipId, null);
  clips = await window.quickclip.getClips();
  projects = await window.quickclip.getProjects();
  renderAll();
}

function showCommentInput(id) {
  const el = document.getElementById('ci-' + id);
  if (el) { el.style.display = 'block'; document.getElementById('cin-' + id).focus(); }
}

function hideCommentInput(id) {
  const el = document.getElementById('ci-' + id);
  if (el) el.style.display = 'none';
}

async function addComment(id) {
  const input = document.getElementById('cin-' + id);
  const text = input.value.trim();
  if (!text) return;
  const clip = clips.find((c) => c.id === id);
  if (!clip) return;
  if (!clip.comments) clip.comments = [];
  clip.comments.push({ text, ts: Date.now() });
  await window.quickclip.updateClip(id, { comments: clip.comments });
  input.value = '';
  hideCommentInput(id);
  renderAll();
}

function editComment(clipId, idx) {
  const clip = clips.find((c) => c.id === clipId);
  if (!clip || !clip.comments || !clip.comments[idx]) return;
  const el = document.getElementById(`thread-${escAttr(clipId)}-${idx}`);
  if (!el) return;
  const textSpan = el.querySelector('.thread-text');
  if (!textSpan) return;
  const oldText = clip.comments[idx].text;
  el.innerHTML = `<input class="comment-input thread-edit-input" value="${escAttr(oldText)}" `
    + `onkeydown="if(event.key==='Enter')saveEditComment('${escAttr(clipId)}',${idx},this.value);if(event.key==='Escape')renderAll()" />`
    + `<button class="thread-save-btn" onclick="saveEditComment('${escAttr(clipId)}',${idx},this.previousElementSibling.value)">&#x2713;</button>`;
  el.querySelector('input').focus();
}

async function saveEditComment(clipId, idx, newText) {
  newText = (newText || '').trim();
  if (!newText) return;
  const clip = clips.find((c) => c.id === clipId);
  if (!clip || !clip.comments || !clip.comments[idx]) return;
  clip.comments[idx].text = newText;
  await window.quickclip.updateClip(clipId, { comments: clip.comments });
  renderAll();
}

async function deleteComment(clipId, idx) {
  const clip = clips.find((c) => c.id === clipId);
  if (!clip || !clip.comments || !clip.comments[idx]) return;
  clip.comments.splice(idx, 1);
  await window.quickclip.updateClip(clipId, { comments: clip.comments });
  renderAll();
}

async function copyNoteText(id) {
  const clip = clips.find(c => c.id === id);
  if (!clip) return;

  // Gather all note + AI-generated text
  const parts = [];
  if (clip.comment) parts.push(clip.comment);
  if (clip.aiSummary) parts.push(`AI Summary: ${clip.aiSummary}`);
  if (clip.aiFixPrompt) parts.push(`AI Prompt:\n${clip.aiFixPrompt}`);
  const text = parts.join('\n\n');
  if (!text) return;

  // Get screenshot data URL
  let imageDataUrl = null;
  if (clip.image === '__on_disk__') {
    imageDataUrl = await window.quickclip.getClipImage(id);
  } else if (clip.image) {
    imageDataUrl = clip.image;
  }

  // Write text + image to clipboard together
  if (imageDataUrl) {
    try {
      const resp = await fetch(imageDataUrl);
      const blob = await resp.blob();
      const pngBlob = blob.type === 'image/png'
        ? blob
        : new Blob([await blob.arrayBuffer()], { type: 'image/png' });
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'image/png': pngBlob,
        })
      ]);
    } catch {
      await navigator.clipboard.writeText(text);
    }
  } else {
    await navigator.clipboard.writeText(text);
  }
}

// ── Tag Management ──

function showTagInput(id) {
  const el = document.getElementById('ti-' + id);
  if (el) { el.style.display = 'flex'; }
}

function hideTagInput(id) {
  const el = document.getElementById('ti-' + id);
  if (el) el.style.display = 'none';
  const input = document.getElementById('tin-' + id);
  if (input) { input.style.display = 'none'; input.value = ''; }
  const sel = document.getElementById('tsel-' + id);
  if (sel) sel.value = '';
}

async function onTagSelect(id, value) {
  if (value === '__new__') {
    const input = document.getElementById('tin-' + id);
    input.style.display = 'block';
    input.focus();
    return;
  }
  if (!value) return;
  const clip = clips.find((c) => c.id === id);
  if (!clip) return;
  if (!clip.tags) clip.tags = [];
  if (!clip.tags.includes(value)) {
    clip.tags.push(value);
    await window.quickclip.updateClip(id, { tags: clip.tags });
  }
  hideTagInput(id);
  renderAll();
}

async function addTag(id) {
  const input = document.getElementById('tin-' + id);
  const raw = input.value.trim().replace(/^#/, '').trim();
  if (!raw) return;
  const clip = clips.find((c) => c.id === id);
  if (!clip) return;
  if (!clip.tags) clip.tags = [];
  if (clip.tags.includes(raw)) { input.value = ''; return; }
  clip.tags.push(raw);
  await window.quickclip.updateClip(id, { tags: clip.tags });
  input.value = '';
  hideTagInput(id);
  renderAll();
}

async function removeTag(id, tag) {
  const clip = clips.find((c) => c.id === id);
  if (!clip || !clip.tags) return;
  clip.tags = clip.tags.filter((t) => t !== tag);
  await window.quickclip.updateClip(id, { tags: clip.tags });
  renderAll();
}

// ── IDE Connection Sidebar ──

function renderIdeConnectionSection() {
  if (!isFocusedMode) return '';
  const project = projects.find(p => p.id === selectedProjectId);
  if (!project?.repo_path) return '';

  let html = '<div class="sidebar-section ide-connection">';
  html += '<div class="sec">IDE Connection</div>';

  if (!isDevMode) {
    html += `<p class="sidebar-hint">No dev workflow found.</p>`;
    html += `<button class="btn-primary" onclick="initDevWorkflow(${project.id})">Set up Dev Workflow</button>`;
    html += '</div>';
    return html;
  }

  if (!ideStatus) {
    html += '<p class="sidebar-hint">Checking IDE...</p>';
  } else if (!ideStatus.vsCodeInstalled) {
    html += '<p class="sidebar-hint">VS Code not found.</p>';
  } else if (!ideStatus.claudeCodeExtension) {
    html += '<p class="sidebar-hint">Claude Code extension not installed.</p>';
  } else if (!ideStatus.mcpConfigured) {
    html += '<p class="sidebar-hint">VS Code + Claude Code found.</p>';
    html += `<button class="btn-primary" onclick="showMcpSetup(${project.id})">Connect HuminLoop</button>`;
  } else {
    const connected = project.active_in_ide || project.activeInIde;
    const dotClass = connected ? 'ide-dot-green' : 'ide-dot-gray';
    const label = connected ? 'Connected' : 'Waiting for connection...';
    html += `<div class="ide-status"><span class="ide-dot ${dotClass}"></span> ${label}</div>`;
  }

  // Pending prompt count
  const pendingCount = devPrompts.filter(p => p.status !== 'DONE' && p.status !== 'FAILED').length;
  if (pendingCount > 0) {
    html += `<div class="pending-badge">${pendingCount} prompt${pendingCount > 1 ? 's' : ''} pending</div>`;
  }

  // Plan progress
  const plans = window._activePlans || [];
  plans.forEach(plan => {
    const done = plan.tasks.filter(t => {
      const p = devPrompts.find(dp => dp.id === t.promptId);
      return p?.status === 'DONE';
    }).length;
    html += `<div class="plan-progress">`;
    html += `<div class="plan-label">Plan: ${done}/${plan.totalTasks} tasks</div>`;
    html += `<div class="plan-bar"><div class="plan-bar-fill" style="width:${(done / plan.totalTasks) * 100}%"></div></div>`;

    const currentTask = plan.tasks[plan.currentIndex];
    const currentPrompt = devPrompts.find(p => p.id === currentTask?.promptId);
    if (currentPrompt?.status === 'DONE' && plan.currentIndex < plan.totalTasks - 1) {
      html += `<button class="btn-primary btn-sm" onclick="advancePlan('${escAttr(plan.planId)}')">Send next task</button>`;
    }
    html += `<button class="btn-danger btn-sm" onclick="cancelPlan('${escAttr(plan.planId)}')">Cancel</button>`;
    html += `</div>`;
  });

  html += '</div>';
  return html;
}

// ── Connect IDE Window Wizard ──
// Lets the user point HuminLoop at the VS Code window that has this project
// open. Verification (folder ↔ repo_path) happens in main; the actual
// "Connected" state still comes only from MCP heartbeats — the wizard just
// guides the user there (MCP setup → reload window → heartbeat arrives).

let _ideConnect = null; // { projectId, step, windows, chosen, verdict, ideStatus, poll }

// Display-only helper; the authoritative comparison lives in main's connect-ide-window.
function projectRepoBase(proj) {
  if (!proj || !proj.repo_path) return null;
  const norm = String(proj.repo_path).replace(/\\/g, '/').replace(/\/+$/, '');
  return norm.split('/').pop() || null;
}

async function openIdeConnect(projectId) {
  closeIdeConnect();
  _ideConnect = { projectId, step: 'loading', windows: [], chosen: null, verdict: null, ideStatus: null, poll: null };
  renderIdeConnectOverlay();
  await refreshIdeWindows();
}

async function refreshIdeWindows() {
  const st = _ideConnect;
  if (!st) return;
  st.step = 'loading';
  renderIdeConnectOverlay();
  let wins = [];
  try { wins = await window.quickclip.listIdeWindows(); } catch {}
  if (_ideConnect !== st) return; // closed/reopened while scanning
  st.windows = wins || [];
  st.step = 'pick';
  renderIdeConnectOverlay();
}

function closeIdeConnect() {
  if (_ideConnect && _ideConnect.poll) clearInterval(_ideConnect.poll);
  _ideConnect = null;
  const el = document.getElementById('ide-connect-overlay');
  if (el) el.remove();
}

async function chooseIdeWindow(index) {
  const st = _ideConnect;
  if (!st) return;
  const win = st.windows[index];
  if (!win) return;
  st.chosen = win;
  let verdict = null;
  try { verdict = await window.quickclip.connectIdeWindow(st.projectId, win); } catch (e) { verdict = { error: e.message }; }
  if (_ideConnect !== st) return;
  if (verdict && verdict.error) { showToast(verdict.error); return; }
  st.verdict = verdict;
  if (verdict.match === 'yes') startIdeCheck();
  else { st.step = 'warn'; renderIdeConnectOverlay(); }
}

async function startIdeCheck() {
  const st = _ideConnect;
  if (!st) return;
  st.step = 'check';
  renderIdeConnectOverlay();
  const proj = projects.find((p) => p.id === st.projectId);
  try { st.ideStatus = await window.quickclip.detectIde(proj?.repo_path); } catch { st.ideStatus = null; }
  if (_ideConnect !== st || st.step !== 'check') return;
  renderIdeConnectOverlay();
  // Poll until the MCP heartbeat flips active_in_ide (set by api-server, not by us).
  if (!st.poll) {
    st.poll = setInterval(async () => {
      const cur = _ideConnect;
      if (!cur || cur !== st || cur.step !== 'check') return;
      try {
        const fresh = await window.quickclip.getProjects();
        const p = fresh.find((x) => x.id === cur.projectId);
        if (p && (p.active_in_ide || p.activeInIde)) {
          clearInterval(cur.poll);
          cur.poll = null;
          cur.step = 'done';
          renderIdeConnectOverlay();
        }
      } catch {}
    }, 3000);
  }
}

function ideConnectPinSuggestion(proj) {
  if (!proj || !proj.repo_path || isWorkspacePinned(proj.id)) return '';
  return `<div class="ide-connect-pin">
    <span>Create a workspace shortcut to launch <strong>${esc(proj.name)}</strong> from the sidebar anytime.</span>
    <button class="btn-secondary" onclick="toggleWorkspacePin(${proj.id});renderIdeConnectOverlay()">&#x2606; Add to Workspaces</button>
  </div>`;
}

function renderIdeConnectOverlay() {
  const st = _ideConnect;
  if (!st) return;
  let el = document.getElementById('ide-connect-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ide-connect-overlay';
    el.className = 'mcp-setup-overlay';
    document.body.appendChild(el);
  }
  const proj = projects.find((p) => p.id === st.projectId) || {};
  const repoBase = projectRepoBase(proj);
  let body = '';

  if (st.step === 'loading') {
    body = `<h3>Connect to VS Code</h3><p class="ide-connect-hint">Looking for open VS Code windows&hellip;</p>
      <div class="mcp-setup-actions"><button class="btn-secondary" onclick="closeIdeConnect()">Cancel</button></div>`;

  } else if (st.step === 'pick') {
    body = `<h3>Connect to VS Code</h3>
      <p class="ide-connect-hint">Pick the window that has <strong>${esc(proj.name || 'this project')}</strong> open:</p>`;
    if (st.windows.length === 0) {
      body += `<p class="ide-connect-empty">No open VS Code windows found.<br>Open your project in VS Code, then hit Refresh.</p>`;
    } else {
      body += '<div class="ide-win-list">';
      st.windows.forEach((w, i) => {
        const likely = repoBase && w.folder && w.folder.toLowerCase() === repoBase.toLowerCase();
        body += `<button class="ide-win-row ${likely ? 'likely' : ''}" onclick="chooseIdeWindow(${i})" title="${escAttr(w.title)}">
          <span class="ide-win-folder">&#x1F4C1; ${esc(w.folder)}${w.remote ? ` <span class="ide-win-remote">${esc(w.remote)}</span>` : ''}${likely ? ' <span class="ide-win-likely">likely match</span>' : ''}</span>
          <span class="ide-win-title">${esc(w.title)}</span>
        </button>`;
      });
      body += '</div>';
    }
    body += `<div class="mcp-setup-actions">
      <button class="btn-secondary" onclick="refreshIdeWindows()">&#x21BB; Refresh</button>
      <button class="btn-secondary" onclick="closeIdeConnect()">Cancel</button>
    </div>`;

  } else if (st.step === 'warn') {
    const v = st.verdict || {};
    body = `<h3>Hmm, are you sure?</h3>`;
    if (v.match === 'no') {
      body += `<p class="ide-connect-warn">&#x26A0;&#xFE0F; This may not be the correct project/path &mdash; that window has
        <strong>${esc(v.folder || '?')}</strong> open, but this project's repo folder is
        <strong>${esc(v.repoBase || '?')}</strong>${proj.repo_path ? ` <span class="ide-win-title">(${esc(proj.repo_path)})</span>` : ''}.</p>`;
    } else {
      body += `<p class="ide-connect-warn">&#x26A0;&#xFE0F; HuminLoop can't verify this window &mdash; ${proj.repo_path ? 'the window title has no folder name' : `<strong>${esc(proj.name || 'this project')}</strong> has no repo path set. Add one in the project settings to enable verification and MCP setup`}.</p>`;
    }
    body += `<div class="mcp-setup-actions">
      <button class="btn-primary" onclick="startIdeCheck()">Connect anyway</button>
      <button class="btn-secondary" onclick="_ideConnect.step='pick';renderIdeConnectOverlay()">Pick another window</button>
      <button class="btn-secondary" onclick="closeIdeConnect()">Cancel</button>
    </div>`;

  } else if (st.step === 'check') {
    const s = st.ideStatus;
    const row = (ok, label) => `<div class="ide-check-row">${ok === null ? '&#x23F3;' : ok ? '&#x2705;' : '&#x274C;'} ${label}</div>`;
    body = `<h3>Checking IDE &amp; MCP</h3>
      <div class="ide-check-list">
        ${row(s ? s.vsCodeInstalled : null, 'VS Code CLI available')}
        ${row(s ? s.claudeCodeExtension : null, 'Claude Code extension installed')}
        ${row(s ? s.mcpConfigured : null, 'HuminLoop MCP configured for this repo')}
        <div class="ide-check-row">&#x1F4E1; Waiting for MCP heartbeat&hellip; <span class="ide-win-title">(reload the VS Code window / start your AI agent so the MCP server connects)</span></div>
      </div>`;
    if (s && !s.mcpConfigured && proj.repo_path) {
      body += `<p class="ide-connect-hint">The MCP bridge isn't set up yet &mdash; want HuminLoop to configure it?</p>`;
    }
    body += ideConnectPinSuggestion(proj);
    body += `<div class="mcp-setup-actions">
      ${s && !s.mcpConfigured && proj.repo_path ? `<button class="btn-primary" onclick="showMcpSetup(${proj.id})">Set up MCP connection</button>` : ''}
      <button class="btn-secondary" onclick="startIdeCheck()">&#x21BB; Re-check</button>
      <button class="btn-secondary" onclick="closeIdeConnect()">Close</button>
    </div>`;

  } else if (st.step === 'done') {
    body = `<h3>&#x1F7E2; Connected!</h3>
      <p class="ide-connect-hint">VS Code is talking to HuminLoop via MCP. Prompts you send from clips will land in this workspace.</p>
      <p class="ide-connect-hint">&#x1F43A; <strong>Meet Rel</strong> &mdash; your AI workflow assistant. He can look over this repo, answer questions, and help set up your workflow.</p>`;
    body += ideConnectPinSuggestion(proj);
    body += `<div class="mcp-setup-actions">
      <button class="btn-primary" onclick="closeIdeConnect();renderAll();window.quickclip.openRel(${proj.id})">&#x1F43A; Meet Rel</button>
      <button class="btn-secondary" onclick="closeIdeConnect();renderAll()">Done</button>
    </div>`;
  }

  el.innerHTML = `<div class="mcp-setup-panel ide-connect-panel">${body}</div>`;
}

// ── Rel (in-app AI assistant) ──

// Header-button entry: open Rel with the currently selected project (if any)
// so he starts with the right repo context.
function openRelChat() {
  window.quickclip.openRel(selectedProjectId || null);
}

// ── Workspaces Quick Launch ──

function isWorkspacePinned(projectId) {
  const pins = (settings && settings.workspace_quick_launch) || [];
  return pins.includes(projectId);
}

function renderWorkspacePinButton(proj) {
  if (!proj.repo_path) return '';
  const pinned = isWorkspacePinned(proj.id);
  return `<button class="sb-btn-action ${pinned ? 'ws-pinned' : ''}" onclick="toggleWorkspacePin(${proj.id})" title="${pinned ? 'Remove from Workspaces quick launch' : 'Add to Workspaces quick launch in the sidebar'}">${pinned ? '&#x2605;' : '&#x2606;'} Workspace</button>`;
}

async function toggleWorkspacePin(projectId) {
  const pins = ((settings && settings.workspace_quick_launch) || []).slice();
  const i = pins.indexOf(projectId);
  if (i >= 0) pins.splice(i, 1); else pins.push(projectId);
  settings.workspace_quick_launch = pins;
  try { await window.quickclip.saveSetting('workspace_quick_launch', pins); } catch {}
  showToast(i >= 0 ? 'Removed from Workspaces' : 'Added to Workspaces quick launch');
  renderAll();
}

function renderWorkspacesSection() {
  const pins = (settings && settings.workspace_quick_launch) || [];
  const pinned = pins.map((id) => projects.find((p) => p.id === id)).filter(Boolean);
  if (pinned.length === 0) return '';
  let html = '<div class="sec" style="margin-top:12px">Workspaces</div>';
  pinned.forEach((p) => {
    const ide = (p.active_in_ide || p.activeInIde) ? ' <span class="ide-dot" title="Connected via MCP">&#x1F7E2;</span>' : '';
    html += `<button class="sb-btn ws-launch" onclick="launchWorkspace(${p.id})" title="Open ${escAttr(p.name)} in VS Code">
      <span><span class="proj-dot" style="background:${esc(p.color)}"></span>&#x25B6;&#xFE0E; ${esc(p.name)}${ide}</span>
      <span class="ws-unpin" onclick="event.stopPropagation();toggleWorkspacePin(${p.id})" title="Remove from Workspaces">&times;</span></button>`;
  });
  return html;
}

async function launchWorkspace(projectId) {
  const p = projects.find((x) => x.id === projectId);
  showToast(`Opening ${p ? p.name : 'workspace'} in VS Code…`);
  try {
    const res = await window.quickclip.openProjectWorkspace(projectId);
    if (res && res.error) showToast(res.error);
  } catch (e) {
    showToast('Could not launch VS Code: ' + e.message);
  }
}

// ── Dev Workflow Functions ──

async function initDevWorkflow(projectId) {
  try {
    const result = await window.quickclip.initDevWorkflow(projectId);
    if (result.success) {
      await loadData();
      renderAll();
    } else {
      showToast(`Workflow setup failed: ${result.reason || 'unknown'}`);
    }
  } catch (e) {
    alert('Failed to initialize dev workflow: ' + e.message);
  }
}

async function showMcpSetup(projectId) {
  try {
    const config = await window.quickclip.generateMcpConfig(projectId);
    const configJson = JSON.stringify(config, null, 2);
    const project = projects.find(p => p.id === projectId);
    const mcpPath = project.repo_path.replace(/\\/g, '/') + '/.vscode/mcp.json';

    const overlay = document.createElement('div');
    overlay.className = 'mcp-setup-overlay';
    overlay.innerHTML = `
      <div class="mcp-setup-panel">
        <h3>Connect HuminLoop to VS Code</h3>
        <p>Write to <code>${esc(mcpPath)}</code>:</p>
        <pre class="mcp-config-preview">${esc(configJson)}</pre>
        <div class="mcp-setup-actions">
          <button class="btn-primary" onclick="applyMcpConfig(${projectId})">Apply</button>
          <button class="btn-secondary" onclick="copyMcpConfig()">Copy</button>
          <button class="btn-secondary" onclick="closeMcpSetup()">Cancel</button>
        </div>
      </div>
    `;
    overlay.id = 'mcp-setup-overlay';
    document.body.appendChild(overlay);
    window._pendingMcpConfig = configJson;
  } catch (e) {
    alert('Failed to generate MCP config: ' + e.message);
  }
}

async function applyMcpConfig(projectId) {
  try {
    await window.quickclip.writeMcpConfig(projectId);
    closeMcpSetup();
    const project = projects.find(p => p.id === projectId);
    ideStatus = await window.quickclip.detectIde(project?.repo_path);
    renderAll();
  } catch (e) {
    alert('Failed to write MCP config: ' + e.message);
  }
}

function copyMcpConfig() {
  if (window._pendingMcpConfig) {
    navigator.clipboard.writeText(window._pendingMcpConfig);
    showToast('MCP config copied to clipboard');
  }
}

function closeMcpSetup() {
  const overlay = document.getElementById('mcp-setup-overlay');
  if (overlay) overlay.remove();
  delete window._pendingMcpConfig;
}

// ── Bundle & Send (Dev Mode) ──

async function bundleAndSend(clipId) {
  try {
    const result = await window.quickclip.bundleAndSend(clipId);
    if (result.success) {
      showToast('Bundled and sent to IDE');
      await loadData();
      renderAll();
    }
  } catch (e) {
    console.error('Bundle & Send failed:', e.message);
    showToast('Bundle & Send failed: ' + e.message);
  }
}

async function bundleAndSendSelected() {
  if (selectedClipIds.size === 0) return;
  try {
    const result = await window.quickclip.bundleAndSendMultiple(
      [...selectedClipIds], selectedProjectId
    );
    if (result.success) {
      showToast('Bundled and sent to IDE');
      selectMode = false;
      selectedClipIds.clear();
      await loadData();
      renderAll();
    }
  } catch (e) {
    console.error('Bundle & Send failed:', e.message);
    showToast('Bundle & Send failed: ' + e.message);
  }
}

async function queueAsPlan() {
  if (selectedClipIds.size < 2) return;
  try {
    const result = await window.quickclip.queueAsPlan([...selectedClipIds], selectedProjectId);
    if (result.success) {
      showToast(`Plan queued: ${result.taskCount} tasks`);
      selectMode = false;
      selectedClipIds.clear();
      await loadData();
      renderAll();
    }
  } catch (e) {
    alert('Queue as Plan failed: ' + e.message);
  }
}

async function advancePlan(planId) {
  try {
    await window.quickclip.advancePlan(planId);
    await loadData();
    renderAll();
  } catch (e) {
    alert('Advance failed: ' + e.message);
  }
}

async function cancelPlan(planId) {
  if (!confirm('Cancel remaining tasks?')) return;
  try {
    await window.quickclip.cancelPlan(planId);
    await loadData();
    renderAll();
  } catch (e) {
    alert('Cancel failed: ' + e.message);
  }
}

// ── Dev Workflow Filters ──

function setDevFilter(filter) {
  devFilter = filter;
  renderAll();
}

// ── Dev Polling ──

function startDevPolling() {
  if (devPollInterval) return;
  devPollInterval = setInterval(async () => {
    if (!isDevMode || !isFocusedMode) return;
    try {
      const oldPrompts = JSON.stringify(devPrompts);
      devPrompts = await window.quickclip.getWorkflowPrompts(selectedProjectId);

      // Auto-advance plans if relay mode is auto
      const plans = await window.quickclip.getActivePlans();
      for (const plan of plans) {
        const currentTask = plan.tasks[plan.currentIndex];
        const prompt = devPrompts.find(p => p.id === currentTask?.promptId);
        if (prompt?.status === 'DONE' && plan.currentIndex < plan.totalTasks - 1) {
          const wfStatus = await window.quickclip.getWorkflowStatus(selectedProjectId);
          if (wfStatus.relayMode === 'auto') {
            await window.quickclip.advancePlan(plan.planId);
          }
        }
      }
      window._activePlans = plans;

      if (JSON.stringify(devPrompts) !== oldPrompts) {
        renderAll();
      }
    } catch (e) {
      console.error('Dev poll failed:', e.message);
    }
  }, 12000);
}

function stopDevPolling() {
  if (devPollInterval) {
    clearInterval(devPollInterval);
    devPollInterval = null;
  }
}

// ── Refresh on Window Focus ──

window.addEventListener('focus', async () => {
  if (isFocusedMode && selectedProjectId) {
    try {
      isDevMode = await window.quickclip.hasProjectWorkflow(selectedProjectId);
      if (isDevMode) {
        const project = projects.find(p => p.id === selectedProjectId);
        ideStatus = await window.quickclip.detectIde(project?.repo_path);
        devPrompts = await window.quickclip.getWorkflowPrompts(selectedProjectId);
      }
      updateModeLabel();
      renderAll();
    } catch (e) {
      console.error('Focus refresh failed:', e.message);
    }
  }
});

// end of file
