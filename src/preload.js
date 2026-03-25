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
  getClipImage: (clipId) => ipcRenderer.invoke('get-clip-image', clipId),
  assignClipToProject: (clipId, projectId) => ipcRenderer.invoke('assign-clip-to-project', clipId, projectId),

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
  hasApiKey: () => ipcRenderer.invoke('has-api-key'),

  // App info
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // Events
  onClipsChanged: (cb) => ipcRenderer.on('clips-changed', () => cb()),
  onProjectsChanged: (cb) => ipcRenderer.on('projects-changed', () => cb()),

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
