const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('quickclip', {
  // Window controls
  onScreenshot: (cb) => ipcRenderer.on('new-screenshot', (_, data, meta) => cb(data, meta)),
  closeCapture: () => ipcRenderer.send('close-capture'),
  hideMain: () => ipcRenderer.send('hide-main'),
  openCapture: () => ipcRenderer.send('open-capture'),

  // Clips
  getClips: () => ipcRenderer.invoke('get-clips'),
  getGeneralClips: () => ipcRenderer.invoke('get-general-clips'),
  getClipsForProject: (projectId) => ipcRenderer.invoke('get-clips-for-project', projectId),
  saveClip: (clip) => ipcRenderer.invoke('save-clip', clip),
  updateClip: (id, updates) => ipcRenderer.invoke('update-clip', id, updates),
  deleteClip: (id) => ipcRenderer.invoke('delete-clip', id),
  getTrash: () => ipcRenderer.invoke('get-trash'),
  restoreClip: (id) => ipcRenderer.invoke('restore-clip', id),
  permanentDeleteClip: (id) => ipcRenderer.invoke('permanent-delete-clip', id),
  emptyTrash: () => ipcRenderer.invoke('empty-trash'),
  getClipImage: (clipId) => ipcRenderer.invoke('get-clip-image', clipId),
  copyImageToClipboard: (clipId) => ipcRenderer.invoke('copy-image-to-clipboard', clipId),
  assignClipToProject: (clipId, projectId) => ipcRenderer.invoke('assign-clip-to-project', clipId, projectId),
  completeClip: (clipId, archive) => ipcRenderer.invoke('complete-clip', clipId, archive),
  uncompleteClip: (clipId) => ipcRenderer.invoke('uncomplete-clip', clipId),

  // Categories
  getCategories: () => ipcRenderer.invoke('get-categories'),
  saveCategories: (cats) => ipcRenderer.invoke('save-categories', cats),

  // Projects
  getProjects: () => ipcRenderer.invoke('get-projects'),
  createProject: (data) => ipcRenderer.invoke('create-project', data),
  updateProject: (id, data) => ipcRenderer.invoke('update-project', id, data),
  deleteProject: (id) => ipcRenderer.invoke('delete-project', id),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  getSetting: (key) => ipcRenderer.invoke('get-setting', key),
  saveSetting: (key, value) => ipcRenderer.invoke('save-setting', key, value),

  // AI
  aiCategorize: (comment, imageData) => ipcRenderer.invoke('ai-categorize', comment, imageData),
  aiSearch: (query) => ipcRenderer.invoke('ai-search', query),
  summarizeProject: (projectId) => ipcRenderer.invoke('summarize-project', projectId),
  hasApiKey: () => ipcRenderer.invoke('has-api-key'),
  getPromptBlocks: () => ipcRenderer.invoke('get-prompt-blocks'),
  savePromptBlocks: (enabled, custom) => ipcRenderer.invoke('save-prompt-blocks', enabled, custom),
  resetPromptBlocks: () => ipcRenderer.invoke('reset-prompt-blocks'),
  addCustomBlock: (label, text) => ipcRenderer.invoke('add-custom-block', label, text),

  // AI retrigger
  retriggerAi: (clipId) => ipcRenderer.invoke('retrigger-ai', clipId),

  // Audit ledger
  getAuditLog: () => ipcRenderer.invoke('get-audit-log'),
  clearAuditLog: () => ipcRenderer.invoke('clear-audit-log'),

  // Workflow
  getWorkflowStatus: () => ipcRenderer.invoke('get-workflow-status'),
  getWorkflowChangelog: () => ipcRenderer.invoke('get-workflow-changelog'),
  getWorkflowPrompts: () => ipcRenderer.invoke('get-workflow-prompts'),
  toggleRelayMode: () => ipcRenderer.invoke('toggle-relay-mode'),
  toggleAuditWatch: () => ipcRenderer.invoke('toggle-audit-watch'),
  getWorkflowAudits: () => ipcRenderer.invoke('get-workflow-audits'),

  // App info
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // Toolbar
  enterDrawMode: (color) => ipcRenderer.invoke('enter-draw-mode', color),
  exitDrawMode: () => ipcRenderer.invoke('exit-draw-mode'),
  takeSnippet: () => ipcRenderer.invoke('take-snippet'),
  getToolbarProject: () => ipcRenderer.invoke('get-toolbar-project'),
  showMain: () => ipcRenderer.send('show-main'),
  minimizeToolbar: () => ipcRenderer.send('minimize-toolbar'),
  restoreToolbar: () => ipcRenderer.send('restore-toolbar'),
  closeToolbar: () => ipcRenderer.send('close-toolbar'),

  snippetCaptured: (dataUrl) => ipcRenderer.invoke('snippet-captured', dataUrl),

  // Overlay events (main → renderer)
  onColorChange: (cb) => ipcRenderer.on('set-color', (_, color) => cb(color)),
  onEnterRegionSelect: (cb) => ipcRenderer.on('enter-region-select', (_, screenshotDataUrl) => cb(screenshotDataUrl)),
  onDrawModeExited: (cb) => ipcRenderer.on('draw-mode-exited', () => cb()),
  onTextModeToggle: (cb) => ipcRenderer.on('text-mode-toggle', (_, enabled) => cb(enabled)),
  onTextModeExited: (cb) => ipcRenderer.on('text-mode-exited', () => cb()),

  // Text mode (toolbar → overlay relay)
  toggleTextMode: (enabled) => ipcRenderer.send('toggle-text-mode', enabled),
  textModeChanged: (enabled) => ipcRenderer.send('text-mode-changed', enabled),
  textModeExited: () => ipcRenderer.send('text-mode-exited'),

  // Events
  onClipsChanged: (cb) => ipcRenderer.on('clips-changed', () => cb()),
  onProjectsChanged: (cb) => ipcRenderer.on('projects-changed', () => cb()),

  // App mode
  toggleAppMode: () => ipcRenderer.invoke('toggle-app-mode'),
  getAppMode: () => ipcRenderer.invoke('get-app-mode'),
  getLiteClips: () => ipcRenderer.invoke('get-lite-clips'),
  setLiteActiveProject: (projectId) => ipcRenderer.invoke('set-lite-active-project', projectId),
  toggleProjectIde: (projectId) => ipcRenderer.invoke('toggle-project-ide', projectId),

  // Setup wizard
  checkDocker: () => ipcRenderer.invoke('setup-check-docker'),
  checkDb: () => ipcRenderer.invoke('setup-check-db'),
  startDb: () => ipcRenderer.invoke('setup-start-db'),
  checkCredentials: () => ipcRenderer.invoke('setup-check-credentials'),
  useSqlite: () => ipcRenderer.invoke('setup-use-sqlite'),
  getDbBackend: () => ipcRenderer.invoke('get-db-backend'),
  saveEnvValue: (key, value) => ipcRenderer.invoke('setup-save-env', key, value),
  finishSetup: () => ipcRenderer.invoke('setup-finish'),
});
