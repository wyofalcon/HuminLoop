// renderer/setup.js — First-run setup wizard

let currentStep = 1;
let aiOption = 'apikey';
let dbBackend = 'none'; // 'postgresql', 'sqlite'
let dockerOk = false;
let dbOk = false;

// ── Step Navigation ──

function goToStep(step) {
  document.querySelectorAll('.step-content').forEach((el) => el.classList.add('hidden'));
  document.getElementById('step-' + step).classList.remove('hidden');
  document.querySelectorAll('.dot').forEach((d, i) => {
    d.classList.toggle('active', i < step);
    d.classList.toggle('done', i < step - 1);
  });
  currentStep = step;

  if (step === 2) checkCredentials();
  if (step === 3) updateSummary();
}

// ── Step 1: Docker & Database ──

async function checkDocker() {
  const result = await window.quickclip.checkDocker();
  const icon = document.getElementById('dockerIcon');
  const status = document.getElementById('dockerStatus');

  if (result.installed) {
    icon.textContent = '\u2713';
    icon.classList.add('ok');
    status.textContent = `Docker ${result.version || ''} found`;
    dockerOk = true;
    checkDb();
  } else {
    icon.textContent = '\u2717';
    icon.classList.add('err');
    status.textContent = 'Not installed';
    document.getElementById('dockerMissing').classList.remove('hidden');
    // Show SQLite fallback option
    document.getElementById('sqliteOption').classList.remove('hidden');
    document.getElementById('step1Btn').textContent = 'Retry Docker';
    document.getElementById('step1Btn').disabled = false;
    document.getElementById('step1Btn').onclick = () => { location.reload(); };
  }
}

async function checkDb() {
  const icon = document.getElementById('dbIcon');
  const status = document.getElementById('dbStatus');
  status.textContent = 'Checking container...';

  const result = await window.quickclip.checkDb();
  if (result.running) {
    icon.textContent = '\u2713';
    icon.classList.add('ok');
    status.textContent = 'Running and healthy';
    dbOk = true;
    document.getElementById('step1Btn').textContent = 'Next';
    document.getElementById('step1Btn').disabled = false;
    document.getElementById('step1Btn').onclick = () => goToStep(2);
  } else {
    // Need to start it
    icon.textContent = '...';
    status.textContent = 'Not running — starting...';
    document.getElementById('dbStarting').classList.remove('hidden');
    startDb();
  }
}

async function startDb() {
  const icon = document.getElementById('dbIcon');
  const status = document.getElementById('dbStatus');

  const result = await window.quickclip.startDb();
  document.getElementById('dbStarting').classList.add('hidden');

  if (result.ok) {
    icon.textContent = '\u2713';
    icon.classList.add('ok');
    status.textContent = 'Started successfully';
    dbOk = true;
    dbBackend = 'postgresql';
    document.getElementById('step1Btn').textContent = 'Next';
    document.getElementById('step1Btn').disabled = false;
    document.getElementById('step1Btn').onclick = () => goToStep(2);
  } else {
    icon.textContent = '\u2717';
    icon.classList.add('err');
    status.textContent = result.error || 'Failed to start';
    document.getElementById('step1Btn').textContent = 'Retry';
    document.getElementById('step1Btn').disabled = false;
    document.getElementById('step1Btn').onclick = () => { location.reload(); };
  }
}

async function useSqlite() {
  const btn = document.getElementById('sqliteBtn');
  btn.disabled = true;
  btn.textContent = 'Setting up...';

  const result = await window.quickclip.useSqlite();
  if (result.ok) {
    dbBackend = 'sqlite';
    dbOk = true;
    const icon = document.getElementById('dbIcon');
    const status = document.getElementById('dbStatus');
    icon.textContent = '\u2713';
    icon.classList.add('ok');
    status.textContent = 'SQLite (built-in) — ready';
    document.getElementById('step1Btn').textContent = 'Next';
    document.getElementById('step1Btn').disabled = false;
    document.getElementById('step1Btn').onclick = () => goToStep(2);
  } else {
    btn.textContent = 'Failed — try again';
    btn.disabled = false;
  }
}

function runDbSetup() {
  checkDocker();
}

// ── Step 2: AI Setup ──

function selectAiOption(opt) {
  aiOption = opt;
  document.querySelectorAll('.ai-option').forEach((el) => el.classList.remove('selected'));
  document.getElementById('opt' + opt.charAt(0).toUpperCase() + opt.slice(1)).classList.add('selected');
  document.querySelectorAll('input[name="aiopt"]').forEach((r) => { r.checked = r.value === opt; });
  document.getElementById('apiKeyForm').classList.toggle('hidden', opt !== 'apikey');
  document.getElementById('vertexForm').classList.toggle('hidden', opt !== 'vertex');
}

async function checkCredentials() {
  if (aiOption !== 'vertex') return;
  const result = await window.quickclip.checkCredentials();
  const icon = document.getElementById('credIcon');
  const status = document.getElementById('credStatus');
  if (result.found) {
    icon.textContent = '\u2713';
    icon.classList.add('ok');
    status.textContent = `Found (project: ${result.projectId || 'unknown'})`;
  } else {
    icon.textContent = '\u2717';
    icon.classList.add('err');
    status.textContent = 'Not found — place credentials.json in the HuminLoop folder';
  }
}

async function saveAiConfig() {
  if (aiOption === 'apikey') {
    const key = document.getElementById('apiKeyInput').value.trim();
    if (!key) {
      // Allow skipping if empty
      if (!confirm('No API key entered. Continue without AI features?')) return;
      aiOption = 'skip';
    } else {
      await window.quickclip.saveEnvValue('GEMINI_API_KEY', key);
      await window.quickclip.saveEnvValue('AI_AUTH_MODE', 'apikey');
    }
  } else if (aiOption === 'vertex') {
    await window.quickclip.saveEnvValue('AI_AUTH_MODE', 'vertex');
  } else {
    await window.quickclip.saveEnvValue('AI_AUTH_MODE', 'none');
  }
  goToStep(3);
}

// ── Step 3: Summary ──

function updateSummary() {
  // Database backend
  const dbEl = document.getElementById('summaryDb');
  if (dbEl) {
    dbEl.textContent = dbBackend === 'sqlite' ? 'SQLite (built-in)' : 'PostgreSQL (Docker)';
    dbEl.classList.add('ok');
  }

  // AI config
  const aiEl = document.getElementById('summaryAi');
  if (aiOption === 'apikey') {
    aiEl.textContent = 'Gemini API Key';
    aiEl.classList.add('ok');
  } else if (aiOption === 'vertex') {
    aiEl.textContent = 'Vertex AI (Service Account)';
    aiEl.classList.add('ok');
  } else {
    aiEl.textContent = 'Disabled (can enable later)';
    aiEl.classList.add('dim');
  }
}

function finishSetup() {
  window.quickclip.finishSetup();
}

// ── Init: start checking ──

(async () => {
  document.getElementById('step1Btn').disabled = false;
  document.getElementById('step1Btn').textContent = 'Check & Setup';
  // Show Linux hint on Linux
  if (navigator.platform.startsWith('Linux')) {
    document.getElementById('linuxHint').classList.remove('hidden');
  }
  // Auto-start checks
  checkDocker();
})();
