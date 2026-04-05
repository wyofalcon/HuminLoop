// renderer/index.js — Main window: tabbed notes viewer, projects, settings

// ── State ──

let activeTab = 'general';
let isLiteMode = false;
let clips = [];
let categories = [];
let projects = [];
let settings = {};
let appVersion = null;

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

// Workflow tab state
let workflowStatus = null;
let workflowChangelog = null;
let workflowPrompts = [];
let workflowAudits = null;
let workflowSection = 'status';

// ── Init ──

(async () => {
  const hasKey = await window.quickclip.hasApiKey();
  if (!hasKey) document.getElementById('noKeyBanner').style.display = 'block';
  appVersion = await window.quickclip.getAppVersion();

  // Check if we're in lite mode
  const mode = await window.quickclip.getAppMode();
  if (mode === 'lite') {
    isLiteMode = true;
    applyLiteMode();
  }

  await loadData();
  renderAll();
})();

function applyLiteMode() {
  // Hide General Notes and Workflow tabs
  document.querySelectorAll('.tab').forEach((btn) => {
    if (btn.dataset.tab === 'general' || btn.dataset.tab === 'workflow') {
      btn.style.display = 'none';
    }
  });
  // Add "Lite Mode" label to header
  const h1 = document.querySelector('.header h1');
  if (h1) {
    const label = document.createElement('span');
    label.className = 'lite-mode-label';
    label.textContent = 'Lite Mode';
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
  // In lite mode, auto-select the active project (or first project if none set)
  if (isLiteMode && selectedProjectId === null) {
    const liteProject = settings.lite_active_project;
    if (liteProject) {
      selectedProjectId = liteProject;
    } else if (projects.length > 0) {
      selectedProjectId = projects[0].id;
      window.quickclip.setLiteActiveProject(projects[0].id);
    }
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
  // In lite mode, only allow projects, settings, and help tabs
  if (isLiteMode && (tab === 'general' || tab === 'workflow')) return;
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
    sub.textContent = 'Help — how to use Sciurus';
  } else if (activeTab === 'workflow') {
    const mode = workflowStatus?.relayMode || '?';
    sub.textContent = `AI Dev Workflow · relay: ${mode}`;
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
  else if (activeTab === 'projects') renderProjectsSidebar(el);
  else if (activeTab === 'settings') renderSettingsSidebar(el);
  else if (activeTab === 'help') renderHelpSidebar(el);
  else if (activeTab === 'workflow') renderWorkflowSidebar(el);
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

  el.innerHTML = html;
}

function renderProjectsSidebar(el) {
  let html = '<div class="sec">Projects</div>';
  // In lite mode, hide "All Projects" — user must select a single project
  if (!isLiteMode) {
    html += `<button class="sb-btn ${selectedProjectId === null ? 'active' : ''}" onclick="selectProject(null)">
      <span>All Projects</span><span class="sb-count">${projects.length}</span></button>`;
  }

  projects.forEach((p) => {
    const active = selectedProjectId === p.id ? 'active' : '';
    const ideIndicator = (p.active_in_ide || p.activeInIde) ? '<span class="ide-dot" title="Open in IDE">&#x1F7E2;</span>' : '';
    html += `<button class="sb-btn ${active}" onclick="selectProject(${p.id})" style="${selectedProjectId === p.id ? 'border-left:3px solid ' + esc(p.color) : ''}">
      <span><span class="proj-dot" style="background:${esc(p.color)}"></span>${esc(p.name)}${ideIndicator}</span>
      <span class="sb-count">${p.clipCount || 0}</span></button>`;
  });

  html += `<button class="sb-btn sb-add" onclick="showNewProjectDialog()">+ New Project</button>`;

  html += '<div class="sec" style="margin-top:12px">Trash</div>';
  html += `<button class="sb-btn ${showTrash ? 'active' : ''}" onclick="toggleTrash()" title="View recently deleted notes">
    &#x1F5D1; Trash</button>`;

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
  el.innerHTML = `
    <div class="help-page">
      <h2>Help — Sciurus! v${esc(ver.version)}</h2>

      <div class="help-section" id="help-getting-started">
        <h3>Getting Started</h3>
        <p>Sciurus is an AI-powered knowledge capture tool. Screenshot anything on your screen,
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
        <p><strong>Automatic detection:</strong> Sciurus watches your clipboard. When you take a screenshot
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
        <p>Sciurus uses a <strong>priority chain</strong> to categorize clips automatically:</p>
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
        <p>Sciurus uses <strong>Gemini 2.5 Flash</strong> for vision analysis and search. AI is optional — the rule engine handles most categorization without it.</p>
        <ul>
          <li><strong>Auto-categorization:</strong> When rules don't match, AI reads the screenshot + note + window context and picks category, tags, summary, and URLs</li>
          <li><strong>AI Search:</strong> Type a natural language query like <em>"that paste thing for Marcus"</em> and click AI Search</li>
          <li><strong>Setup options:</strong> Free Gemini API key (recommended) or GCP Vertex AI service account. Configure in Settings or during first-run setup.</li>
        </ul>
      </div>

      <div class="help-section" id="help-database">
        <h3>Database</h3>
        <p>Sciurus supports two database backends:</p>
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
        </ul>
      </div>
    </div>
  `;
}

// =====================================================================
//  WORKFLOW TAB
// =====================================================================

async function loadWorkflowData() {
  [workflowStatus, workflowChangelog, workflowPrompts, workflowAudits] = await Promise.all([
    window.quickclip.getWorkflowStatus(),
    window.quickclip.getWorkflowChangelog(),
    window.quickclip.getWorkflowPrompts(),
    window.quickclip.getWorkflowAudits(),
  ]);
}

function renderWorkflowSidebar(el) {
  const sections = [
    { id: 'status', label: 'Status' },
    { id: 'prompts', label: 'Prompts' },
    { id: 'audits', label: 'Audits' },
    { id: 'session', label: 'Session' },
    { id: 'changelog', label: 'Changelog' },
  ];
  let html = '<div class="sec">Workflow</div>';
  sections.forEach((s) => {
    html += `<button class="sb-btn${workflowSection === s.id ? ' active' : ''}" onclick="workflowSection='${s.id}';renderAll()">${esc(s.label)}</button>`;
  });
  el.innerHTML = html;
}

function renderWorkflowContent(el) {
  if (!workflowStatus || !workflowStatus.hasWorkflow) {
    el.innerHTML = '<div class="wf-empty"><h2>No Workflow Found</h2><p>No <code>.ai-workflow/</code> directory detected in this project.</p></div>';
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
  const next = await window.quickclip.toggleRelayMode();
  workflowStatus.relayMode = next;
  renderAll();
}

async function toggleAudit() {
  const next = await window.quickclip.toggleAuditWatch();
  workflowStatus.auditMode = next;
  renderAll();
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
  else if (activeTab === 'settings') { renderSettingsContent(el); loadPromptBlocks(); loadAuditLog(); }
  else if (activeTab === 'help') renderHelpContent(el);
  else if (activeTab === 'workflow') { loadWorkflowData().then(() => renderWorkflowContent(el)); }
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
    filtered = filtered.filter((c) =>
      (c.comment || '').toLowerCase().includes(q) ||
      (c.category || '').toLowerCase().includes(q) ||
      (c.tags || []).some((t) => t.toLowerCase().includes(q)) ||
      (c.aiSummary || '').toLowerCase().includes(q) ||
      (c.comments || []).some((x) => x.text.toLowerCase().includes(q))
    );
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

  let projectClips = clips.filter((c) => c.project_id === selectedProjectId);
  const completedCount = projectClips.filter((c) => c.completedAt).length;
  if (hideCompleted) {
    projectClips = projectClips.filter((c) => !c.completedAt);
  }

  const ideActive = proj.active_in_ide || proj.activeInIde;

  let html = `<div class="project-detail-header">
    <div>
      <button class="back-btn" onclick="selectProject(null)">&larr; All Projects</button>
      <h2 style="display:inline;margin-left:8px"><span class="proj-dot big" style="background:${esc(proj.color)}"></span>${esc(proj.name)}</h2>
      ${ideActive ? '<span class="ide-badge">IN IDE</span>' : ''}
    </div>
    <div class="project-detail-actions">
      <button class="sb-btn-action ${ideActive ? 'ide-active' : ''}" onclick="toggleIde(${proj.id})" title="${ideActive ? 'Mark as not open in IDE' : 'Mark as open in IDE'}">
        ${ideActive ? '&#x1F7E2; In IDE' : '&#x2B55; Open in IDE'}
      </button>
      <button class="sb-btn-action summarize-btn" onclick="showProjectSummary(${proj.id})" title="Generate a side-by-side summary of all notes">&#x2728; Summarize</button>
      <button class="sb-btn-action" onclick="editProject(${proj.id})">Edit</button>
      <button class="sb-btn-action danger" onclick="confirmDeleteProject(${proj.id})">Delete</button>
    </div>
  </div>`;

  if (completedCount > 0) {
    html += `<div class="completed-toggle">
      <label class="toggle-label" title="Show or hide completed notes">
        <input type="checkbox" ${hideCompleted ? '' : 'checked'} onchange="toggleCompleted()" />
        <span>Show completed (${completedCount})</span>
      </label>
    </div>`;
  }

  if (proj.description) {
    html += `<div class="project-desc">${esc(proj.description)}</div>`;
  }
  if (proj.repo_path) {
    html += `<div class="project-repo">${esc(proj.repo_path)}</div>`;
  }

  html += `<div class="search-bar" style="margin-top:12px">
    <input id="projectSearchInput" placeholder="Search in project..."
      onkeydown="if(event.key==='Enter')searchProject()" oninput="searchProject()" />
  </div>`;

  if (projectClips.length === 0) {
    html += `<div class="empty"><div class="ico">&#x1F4DD;</div>
      <div class="empty-title">No clips in this project</div>
      <div class="empty-sub">Assign clips from General Notes or capture new ones</div></div>`;
  } else {
    try {
      const tags = getAllKnownTags();
      html += projectClips.map((c) => renderClipCard(c, true, tags)).join('');
    } catch (e) {
      html += `<div class="empty"><div class="empty-title">Render error: ${e.message}</div></div>`;
    }
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
  const q = input.value.trim().toLowerCase();
  const el = document.getElementById('mainArea');
  // Re-render with filter (simple approach: re-render all)
  const proj = projects.find((p) => p.id === selectedProjectId);
  if (!proj) return;

  let projectClips = clips.filter((c) => c.project_id === selectedProjectId);
  if (q) {
    projectClips = projectClips.filter((c) =>
      (c.comment || '').toLowerCase().includes(q) ||
      (c.category || '').toLowerCase().includes(q) ||
      (c.tags || []).some((t) => t.toLowerCase().includes(q)) ||
      (c.aiSummary || '').toLowerCase().includes(q) ||
      (c.comments || []).some((x) => x.text.toLowerCase().includes(q))
    );
  }

  const clipListHtml = projectClips.length > 0
    ? projectClips.map((c) => renderClipCard(c, true, getAllKnownTags())).join('')
    : `<div class="empty"><div class="empty-title">No matches</div></div>`;

  // Replace clip list only (find after search-bar)
  const searchBarEnd = el.innerHTML.lastIndexOf('</div><!--cliplist-->');
  // Simpler approach: just rebuild the clip area
  const container = el.querySelectorAll('.clip, .empty');
  container.forEach((node) => node.remove());

  const wrapper = document.createElement('div');
  wrapper.innerHTML = clipListHtml;
  while (wrapper.firstChild) el.appendChild(wrapper.firstChild);
  loadDiskImages(el);
}

function toggleCompleted() {
  hideCompleted = !hideCompleted;
  renderAll();
}

async function toggleIde(projectId) {
  await window.quickclip.toggleProjectIde(projectId);
}

function selectProject(id) {
  // In lite mode, must always have a project selected
  if (isLiteMode && id === null) return;
  selectedProjectId = id;
  // Sync active project setting in lite mode
  if (isLiteMode && id !== null) {
    window.quickclip.setLiteActiveProject(id);
  }
  renderAll();
}

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
  });
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
    <div class="dialog-actions">
      <button class="cap-btn small" onclick="saveNewProject()">Create</button>
      <button class="cancel-btn" onclick="document.getElementById('projectDialog').remove()">Cancel</button>
    </div>
  `;
  el.prepend(dialog);
  document.getElementById('projName').focus();
}

let newProjectColor = '#3b82f6';

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
  await window.quickclip.createProject({
    name,
    description: desc,
    repo_path: repo || null,
    color: newProjectColor,
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
  const proj = projects.find((p) => p.id === id);
  await window.quickclip.updateProject(id, {
    name,
    description: desc,
    repo_path: repo || null,
    color: editProjectColor || (proj ? proj.color : '#3b82f6'),
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
  const aiSettings = settings.ai || { enabled: true, autoCategorizeonSave: true, retryUncategorizedOnStartup: true };

  const ver = appVersion || { version: '?', electron: '?', node: '?' };

  el.innerHTML = `
    <div class="settings-page">
      <h2>Settings</h2>

      <div class="version-banner">
        Sciurus! v${esc(ver.version)}
        <span class="version-detail">Electron ${esc(ver.electron)} · Node ${esc(ver.node)}</span>
      </div>

      <div class="settings-section">
        <h3>General</h3>
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">Open window on launch</div>
            <div class="setting-desc">Show the main window when Sciurus starts</div>
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
      </div>

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

function renderClipCard(c, inProject, allKnownTags) {
  const id = escAttr(c.id);
  const isActive = c.status === 'active';
  const isCompleted = !!c.completedAt;
  const statusClass = isActive ? 'badge-active' : 'badge-parked';
  const statusLabel = isActive ? 'ACTIVE' : 'PARKED';

  // Progressive darkening based on summarize count
  const sumCount = c.summarizeCount || 0;
  const darkenStyle = sumCount > 0 ? ` style="background: color-mix(in srgb, var(--bg-card), black ${Math.min(sumCount * 6, 30)}%)"` : '';

  let html = `<div class="clip${isCompleted ? ' clip-completed' : ''}"${darkenStyle} data-testid="clip-card-${id}">`;

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

// end of file
