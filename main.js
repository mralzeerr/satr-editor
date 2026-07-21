const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

let mainWindow;

// ملف تخزين الإعدادات (مفتاح API) محليًا على جهاز المستخدم
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

// ==================== تقارير الأعطال (Sentry) — اختيارية بموافقة صريحة ====================
// DSN فارغ = الميزة معطلة بالكامل
const SENTRY_DSN = 'https://a3e2f44625c8e16c295acd07a85f56d3@o4511772691398656.ingest.us.sentry.io/4511772695003136';
let sentry = null;              // مرجع SDK بعد التهيئة
let crashReportsEnabled = loadConfig().crashReports === true; // موافقة المستخدم — تتحدث فورًا عند التبديل

// تنظيف أي مسارات تحمل اسم مستخدم الجهاز قبل الإرسال — لا معلومات شخصية في التقارير
function scrubEvent(event) {
  try {
    const user = os.userInfo().username;
    const re = new RegExp(user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return JSON.parse(JSON.stringify(event).replace(re, '<user>'));
  } catch {
    return event;
  }
}

// يجب تهيئة Sentry قبل حدث ready لذا تتم هنا في نطاق الوحدة — لكن الإرسال نفسه
// مقفول ببوابة beforeSend حتى يوافق المستخدم، فيسري تبديل الموافقة فورًا بالاتجاهين.
// تكامل minidump الأصلي مستبعد لأن رفعه قد يتجاوز beforeSend (بوابة الخصوصية).
if (SENTRY_DSN) {
  try {
    sentry = require('@sentry/electron/main');
    sentry.init({
      dsn: SENTRY_DSN,
      release: 'satr@' + app.getVersion(),
      autoSessionTracking: false,
      sendDefaultPii: false,
      integrations: (defaults) => defaults.filter((i) => i.name !== 'SentryMinidump'),
      beforeSend: (event) => (crashReportsEnabled ? scrubEvent(event) : null),
    });
  } catch {
    sentry = null;
  }
}

// أخطاء الواجهة تصل عبر جسر IPC (الواجهة بلا حزم بناء فلا يمكنها تحميل SDK مباشرة)
ipcMain.handle('error:report', (_e, payload) => {
  if (!sentry || !crashReportsEnabled || !payload?.message) return false;
  try {
    const err = new Error(String(payload.message).slice(0, 500));
    err.name = payload.name || 'RendererError';
    if (payload.stack) err.stack = String(payload.stack).slice(0, 4000);
    sentry.captureException(err, { tags: { process: 'renderer', source: payload.source || '' } });
    return true;
  } catch {
    return false;
  }
});

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d1117',
    title: 'سطر | Satr',
    icon: path.join(__dirname, process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  // خادم Moonshot (Kimi) لا يرسل ترويسات CORS، فنحقنها هنا ليقبل المتصفح الرد
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['https://api.moonshot.ai/*'] },
    (details, cb) => {
      const h = details.responseHeaders || {};
      h['Access-Control-Allow-Origin'] = ['*'];
      h['Access-Control-Allow-Headers'] = ['*'];
      h['Access-Control-Allow-Methods'] = ['POST, OPTIONS'];
      cb({ responseHeaders: h });
    }
  );

  mainWindow.loadFile('index.html');

  mainWindow.on('close', (e) => {
    if (forceClose || unsavedCount === 0) return;
    e.preventDefault();
    const ar = (loadConfig().lang || 'ar') === 'ar';
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      title: ar ? 'ملفات غير محفوظة' : 'Unsaved files',
      message: ar
        ? `لديك ${unsavedCount} ملف بتعديلات غير محفوظة.\nهل تريد الإغلاق دون حفظ؟`
        : `You have ${unsavedCount} file(s) with unsaved changes.\nClose without saving?`,
      buttons: ar ? ['إغلاق دون حفظ', 'إلغاء'] : ['Close without saving', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (choice === 0) {
      forceClose = true;
      mainWindow.close();
    }
  });
}

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('com.aetiger.satr');
  createWindow();
  // تحديث تلقائي: يعمل فقط في النسخة المثبتة وعند توفر إصدارات على GitHub Releases
  if (app.isPackaged) {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.autoDownload = true;
      autoUpdater.on('update-downloaded', () => {
        if (mainWindow) mainWindow.webContents.send('app:updateReady');
      });
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    } catch {}
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ==================== إدارة الإعدادات ====================
// المفاتيح الحساسة تُخزَّن مشفرة بـ safeStorage (DPAPI على ويندوز) بدل نص صريح
const SECRET_KEYS = [
  ['apiKey', 'apiKeyEnc'],
  ['groqKey', 'groqKeyEnc'],
  ['moonshotKey', 'moonshotKeyEnc'],
  ['openrouterKey', 'openrouterKeyEnc'],
];
function encryptApiKey(cfg) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return;
    for (const [plain, enc] of SECRET_KEYS) {
      if (cfg[plain]) {
        cfg[enc] = safeStorage.encryptString(cfg[plain]).toString('base64');
        delete cfg[plain];
      }
    }
  } catch {}
}
function decryptApiKey(cfg) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return;
    for (const [plain, enc] of SECRET_KEYS) {
      if (cfg[enc]) {
        cfg[plain] = safeStorage.decryptString(Buffer.from(cfg[enc], 'base64'));
      }
    }
  } catch {}
}

ipcMain.handle('config:get', () => {
  const cfg = loadConfig();
  // ترحيل: مفتاح قديم بنص صريح → يُشفَّر ويُحفظ
  if (SECRET_KEYS.some(([plain]) => cfg[plain]) && safeStorage.isEncryptionAvailable()) {
    const migrated = { ...cfg };
    encryptApiKey(migrated);
    saveConfig(migrated);
  }
  decryptApiKey(cfg);
  return cfg;
});
ipcMain.handle('config:set', (_e, cfg) => {
  // تبديل تقارير الأعطال يسري فورًا دون إعادة تشغيل (البوابة في beforeSend)
  if ('crashReports' in cfg) crashReportsEnabled = cfg.crashReports === true;
  const current = loadConfig();
  const merged = { ...current, ...cfg };
  encryptApiKey(merged);
  return saveConfig(merged);
});

// معلومات التطبيق (لنافذة «حول»)
ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  crashReportsAvailable: !!SENTRY_DSN,
}));

// ==================== تحذير الملفات غير المحفوظة عند الإغلاق ====================
let unsavedCount = 0;
let forceClose = false;
ipcMain.on('app:setUnsaved', (_e, n) => { unsavedCount = n | 0; });

// ==================== نظام الملفات ====================
ipcMain.handle('dialog:openFolder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

// اختيار مجلد لموقع مشروع جديد (مع مسار بداية)
ipcMain.handle('dialog:pickDir', async (_e, defaultPath) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: defaultPath || undefined,
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

// المسار الافتراضي للمشاريع الجديدة داخل مجلد المستخدم مباشرة —
// نتجنب «المستندات» لأنها قد تكون معاد توجيهها لـ OneDrive وتعلق عمليات الكتابة
ipcMain.handle('app:defaultProjectsDir', () => {
  return path.join(app.getPath('home'), 'Satr Projects');
});

// قراءة شجرة الملفات (تتجاهل المجلدات الثقيلة)
const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', '.cache']);

function readTree(dir, depth = 0) {
  if (depth > 8) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const result = [];
  for (const e of entries) {
    if (IGNORE.has(e.name) || e.name.startsWith('.git')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      result.push({ name: e.name, path: full, type: 'dir', children: null });
    } else {
      result.push({ name: e.name, path: full, type: 'file' });
    }
  }
  // المجلدات أولاً ثم الملفات، مرتبة أبجديًا
  result.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return result;
}

ipcMain.handle('fs:readTree', (_e, dir) => readTree(dir));
ipcMain.handle('fs:readDir', (_e, dir) => readTree(dir));

ipcMain.handle('fs:readFile', (_e, filePath) => {
  try {
    return { ok: true, content: fs.readFileSync(filePath, 'utf8') };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('fs:writeFile', (_e, filePath, content) => {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// لا-متزامن حتى لا يجمّد مسارٌ معلّق (OneDrive مثلًا) العمليةَ الرئيسية كلها
ipcMain.handle('fs:mkdir', async (_e, dirPath) => {
  try {
    await fs.promises.mkdir(dirPath, { recursive: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('fs:delete', (_e, target) => {
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('fs:exists', (_e, target) => fs.existsSync(target));

ipcMain.handle('fs:rename', (_e, oldPath, newPath) => {
  try {
    if (fs.existsSync(newPath)) return { ok: false, error: 'already-exists' };
    fs.renameSync(oldPath, newPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// فتح رابط في المتصفح الخارجي
ipcMain.handle('app:openExternal', (_e, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  return true;
});

// ==================== البحث الشامل في الملفات ====================
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf', '.mp3', '.mp4', '.wav', '.ogg',
  '.zip', '.rar', '.7z', '.gz', '.tar', '.exe', '.dll', '.node', '.pdf',
  '.db', '.sqlite', '.class', '.jar', '.pyc', '.wasm', '.lock',
]);

ipcMain.handle('search:inFiles', (_e, { root, query, maxResults = 300 }) => {
  const results = [];
  if (!root || !query || !query.trim()) return results;
  const q = query.toLowerCase();

  function searchDir(dir, depth) {
    if (depth > 10 || results.length >= maxResults) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (results.length >= maxResults) return;
      if (IGNORE.has(e.name) || e.name.startsWith('.git')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { searchDir(full, depth + 1); continue; }
      if (BINARY_EXT.has(path.extname(e.name).toLowerCase())) continue;
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.size > 1500000) continue;
      let content;
      try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
      if (content.includes('\u0000')) continue;
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length && results.length < maxResults; i++) {
        const idx = lines[i].toLowerCase().indexOf(q);
        if (idx !== -1) {
          results.push({
            path: full,
            name: e.name,
            line: i + 1,
            col: idx + 1,
            text: lines[i].trim().slice(0, 200),
          });
        }
      }
    }
  }

  searchDir(root, 0);
  return results;
});

// ==================== نقاط الاسترجاع (Checkpoints) ====================
// لكل مهمة للوكيل نقطة استرجاع تحفظ نسخة الملفات قبل تعديلها أو حذفها.
const checkpoints = [];
const MAX_CHECKPOINTS = 20;
const SNAP_FILE_LIMIT = 5 * 1024 * 1024;   // أقصى حجم للملف الواحد
const SNAP_TOTAL_LIMIT = 40 * 1024 * 1024; // أقصى حجم إجمالي للنقطة الواحدة

function activeCheckpoint() {
  return checkpoints.length ? checkpoints[checkpoints.length - 1] : null;
}

// لقطة لملف واحد أو مجلد كامل (تتجاهل المجلدات الثقيلة)
function snapshotInto(ck, target) {
  if (ck.files[target] !== undefined) return;
  try {
    if (!fs.existsSync(target)) {
      ck.files[target] = { existed: false };
      return;
    }
    const st = fs.statSync(target);
    if (st.isFile()) {
      if (st.size > SNAP_FILE_LIMIT || ck.size + st.size > SNAP_TOTAL_LIMIT) {
        ck.files[target] = { tooBig: true };
        return;
      }
      ck.files[target] = { existed: true, content: fs.readFileSync(target) };
      ck.size += st.size;
    } else if (st.isDirectory()) {
      const entries = fs.readdirSync(target, { withFileTypes: true });
      ck.files[target] = { existed: true, dir: true };
      for (const e of entries) {
        if (IGNORE.has(e.name) || e.name.startsWith('.git')) continue;
        snapshotInto(ck, path.join(target, e.name));
      }
    }
  } catch {
    ck.files[target] = { tooBig: true };
  }
}

ipcMain.handle('ckpt:begin', (_e, label) => {
  checkpoints.push({ id: Date.now(), label: label || '', time: new Date().toISOString(), files: {}, size: 0 });
  if (checkpoints.length > MAX_CHECKPOINTS) checkpoints.shift();
  return true;
});

ipcMain.handle('ckpt:record', (_e, target) => {
  const ck = activeCheckpoint();
  if (!ck) return false;
  snapshotInto(ck, target);
  return true;
});

ipcMain.handle('ckpt:count', () => {
  return checkpoints.filter((c) => Object.keys(c.files).length > 0).length;
});

function restoreCheckpoint(ck) {
  const keys = Object.keys(ck.files);
  // المسارات الأقصر أولًا حتى تُنشأ المجلدات قبل ملفاتها
  keys.sort((a, b) => a.length - b.length);
  const restored = [];
  const failed = [];
  for (const p of keys) {
    const rec = ck.files[p];
    try {
      if (rec.tooBig) { failed.push(p); continue; }
      if (!rec.existed) {
        // الملف لم يكن موجودًا قبل المهمة → نحذفه
        fs.rmSync(p, { recursive: true, force: true });
        restored.push(p);
      } else if (rec.dir) {
        fs.mkdirSync(p, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, rec.content);
        restored.push(p);
      }
    } catch {
      failed.push(p);
    }
  }
  return { restored, failed };
}

ipcMain.handle('ckpt:undoLast', () => {
  for (let i = checkpoints.length - 1; i >= 0; i--) {
    const ck = checkpoints[i];
    if (!Object.keys(ck.files).length) { checkpoints.splice(i, 1); continue; }
    const { restored, failed } = restoreCheckpoint(ck);
    checkpoints.splice(i, 1);
    return { ok: true, label: ck.label, restored, failed };
  }
  return { ok: false, error: 'no-checkpoint' };
});

// سجل النقاط للعرض في الواجهة (الأحدث أولًا)
ipcMain.handle('ckpt:list', () => {
  return checkpoints
    .filter((c) => Object.keys(c.files).length > 0)
    .map((c) => ({
      id: c.id,
      label: c.label,
      time: c.time,
      fileCount: Object.keys(c.files).filter((k) => !c.files[k].dir).length,
    }))
    .reverse();
});

// استرجاع إلى نقطة محددة: نعيد كل النقاط من الأحدث حتى النقطة المطلوبة (ضمنًا)
ipcMain.handle('ckpt:undoTo', (_e, id) => {
  const index = checkpoints.findIndex((c) => c.id === id);
  if (index === -1) return { ok: false, error: 'not-found' };
  const restored = new Set();
  const failed = new Set();
  for (let i = checkpoints.length - 1; i >= index; i--) {
    const r = restoreCheckpoint(checkpoints[i]);
    r.restored.forEach((p) => restored.add(p));
    r.failed.forEach((p) => failed.add(p));
  }
  checkpoints.splice(index);
  return { ok: true, restored: [...restored], failed: [...failed] };
});

// ==================== تكامل Git ====================
function runGit(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => resolve({ code, out, err }));
    child.on('error', (e) => resolve({ code: -1, out: '', err: String(e) }));
  });
}

ipcMain.handle('git:status', async (_e, cwd) => {
  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code === -1) return { gitMissing: true, isRepo: false };
  if (inside.code !== 0 || inside.out.trim() !== 'true') return { isRepo: false };
  const branch = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const st = await runGit(cwd, ['status', '--porcelain']);
  const files = st.out.split('\n').filter(Boolean).map((l) => ({
    x: l[0],
    y: l[1],
    path: l.slice(3).replace(/^"|"$/g, '').replace(/ -> .*$/, ''),
  }));
  return { isRepo: true, branch: branch.out.trim(), files };
});

ipcMain.handle('git:init', async (_e, cwd) => {
  const r = await runGit(cwd, ['init']);
  return { ok: r.code === 0, error: r.err };
});

ipcMain.handle('git:stage', async (_e, cwd, paths) => {
  const r = await runGit(cwd, ['add', '--', ...paths]);
  return { ok: r.code === 0, error: r.err };
});

ipcMain.handle('git:unstage', async (_e, cwd, paths) => {
  const r = await runGit(cwd, ['reset', 'HEAD', '--', ...paths]);
  return { ok: r.code === 0, error: r.err };
});

ipcMain.handle('git:commit', async (_e, cwd, message) => {
  // تأكد من وجود هوية — إن لم توجد فاضبط هوية محلية للمستودع
  const name = await runGit(cwd, ['config', 'user.name']);
  if (name.code !== 0 || !name.out.trim()) {
    await runGit(cwd, ['config', 'user.name', 'Satr User']);
    await runGit(cwd, ['config', 'user.email', 'user@satr.local']);
  }
  const r = await runGit(cwd, ['commit', '-m', message]);
  return { ok: r.code === 0, error: r.err || r.out };
});

ipcMain.handle('git:log', async (_e, cwd) => {
  const r = await runGit(cwd, ['log', '-25', '--date=format:%Y-%m-%d %H:%M', '--pretty=format:%h%x1f%ad%x1f%s']);
  if (r.code !== 0) return [];
  return r.out.split('\n').filter(Boolean).map((l) => {
    const [hash, date, subject] = l.split('\x1f');
    return { hash, date, subject };
  });
});

ipcMain.handle('git:branches', async (_e, cwd) => {
  const r = await runGit(cwd, ['branch', '--list']);
  if (r.code !== 0) return [];
  return r.out.split('\n').filter(Boolean).map((l) => ({
    current: l.startsWith('*'),
    name: l.replace(/^\*?\s+/, '').trim(),
  }));
});

ipcMain.handle('git:checkout', async (_e, cwd, branch, create) => {
  const args = create ? ['checkout', '-b', branch] : ['checkout', branch];
  const r = await runGit(cwd, args);
  return { ok: r.code === 0, error: r.err };
});

ipcMain.handle('git:push', async (_e, cwd) => {
  const r = await runGit(cwd, ['push']);
  return { ok: r.code === 0, error: r.err, out: r.out };
});

ipcMain.handle('git:pull', async (_e, cwd) => {
  const r = await runGit(cwd, ['pull']);
  return { ok: r.code === 0, error: r.err, out: r.out };
});

// محتوى الملف في HEAD (لفروقات الهامش وعرض الفرق)
ipcMain.handle('git:show', async (_e, cwd, relPath) => {
  const r = await runGit(cwd, ['show', 'HEAD:' + relPath.replace(/\\/g, '/')]);
  return r.code === 0 ? { ok: true, content: r.out } : { ok: false, error: r.err };
});

// ==================== الاستبدال الشامل في الملفات ====================
ipcMain.handle('search:replace', (_e, { root, query, replacement, maxFiles = 200 }) => {
  if (!root || !query) return { ok: false, count: 0, files: 0 };
  // نقطة استرجاع خاصة بالاستبدال حتى يمكن التراجع عنه
  checkpoints.push({ id: Date.now(), label: `استبدال: ${query.slice(0, 30)}`, time: new Date().toISOString(), files: {}, size: 0 });
  if (checkpoints.length > MAX_CHECKPOINTS) checkpoints.shift();
  const ck = checkpoints[checkpoints.length - 1];
  let count = 0;
  let filesChanged = 0;

  function walk(dir, depth) {
    if (depth > 10 || filesChanged >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (filesChanged >= maxFiles) return;
      if (IGNORE.has(e.name) || e.name.startsWith('.git')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (BINARY_EXT.has(path.extname(e.name).toLowerCase())) continue;
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.size > 1500000) continue;
      let content;
      try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
      if (content.includes('\u0000') || !content.includes(query)) continue;
      const parts = content.split(query);
      snapshotInto(ck, full);
      try {
        fs.writeFileSync(full, parts.join(replacement), 'utf8');
        count += parts.length - 1;
        filesChanged++;
      } catch {}
    }
  }

  walk(root, 0);
  return { ok: true, count, files: filesChanged };
});

// ==================== جلسات المحادثة ====================
const SESSIONS_DIR = path.join(app.getPath('userData'), 'sessions');
const MAX_SESSIONS = 40;

function ensureSessionsDir() {
  try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}
}

function readSessionMeta(file) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
    return {
      id: s.id,
      title: s.title || '',
      workspace: s.workspace || '',
      updatedAt: s.updatedAt || '',
      count: Array.isArray(s.messages) ? s.messages.length : 0,
    };
  } catch {
    return null;
  }
}

ipcMain.handle('sessions:list', (_e, workspace) => {
  ensureSessionsDir();
  let files;
  try { files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  const metas = files.map(readSessionMeta).filter(Boolean);
  const filtered = workspace ? metas.filter((m) => m.workspace === workspace) : metas;
  filtered.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return filtered.slice(0, MAX_SESSIONS);
});

ipcMain.handle('sessions:save', (_e, session) => {
  ensureSessionsDir();
  try {
    session.updatedAt = new Date().toISOString();
    fs.writeFileSync(path.join(SESSIONS_DIR, session.id + '.json'), JSON.stringify(session), 'utf8');
    // تنظيف: احذف الأقدم إن تجاوز العدد الحد
    const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
    if (files.length > MAX_SESSIONS) {
      const metas = files.map((f) => ({ f, m: readSessionMeta(f) })).filter((x) => x.m);
      metas.sort((a, b) => (a.m.updatedAt || '').localeCompare(b.m.updatedAt || ''));
      for (const x of metas.slice(0, files.length - MAX_SESSIONS)) {
        fs.rmSync(path.join(SESSIONS_DIR, x.f), { force: true });
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('sessions:load', (_e, id) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, id + '.json'), 'utf8'));
  } catch {
    return null;
  }
});

ipcMain.handle('sessions:delete', (_e, id) => {
  try {
    fs.rmSync(path.join(SESSIONS_DIR, id + '.json'), { force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// ==================== قائمة الملفات المسطحة (لإكمال @ في الدردشة) ====================
ipcMain.handle('fs:listAllFiles', (_e, root) => {
  const out = [];
  if (!root) return out;
  function walk(dir, rel, depth) {
    if (depth > 8 || out.length >= 2000) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= 2000) return;
      if (IGNORE.has(e.name) || e.name.startsWith('.git')) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r, depth + 1);
      else out.push(r);
    }
  }
  walk(root, '', 0);
  return out;
});

// ==================== الطرفية / تشغيل الأوامر ====================
const runningProcs = new Map();

// قتل شجرة العملية كاملة (على ويندوز child.kill لا يقتل العمليات الفرعية مثل node)
function killTree(child) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGKILL');
    }
  } catch {}
}

// timeoutMs: إن ظلّت العملية تعمل بعد هذه المدة نعيد النتيجة فورًا مع
// running=true وتبقى العملية مستمرة في الخلفية (مخرجاتها تتدفق للطرفية).
// timeoutMs=0 أو غير محدد → انتظار بلا حد (أوامر المستخدم في الطرفية).
ipcMain.handle('term:run', (e, { id, command, cwd, timeoutMs }) => {
  return new Promise((resolve) => {
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
    const args = process.platform === 'win32'
      ? ['-NoProfile', '-Command', command]
      : ['-c', command];
    const child = spawn(shell, args, { cwd: cwd || os.homedir(), windowsHide: true });
    runningProcs.set(id, child);
    let out = '';
    let settled = false;
    let timer = null;
    const settle = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(payload);
    };

    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        settle({ ok: true, running: true, id, output: out.slice(-8000) });
      }, timeoutMs);
    }

    child.stdout.on('data', (d) => {
      const s = d.toString();
      out += s;
      if (out.length > 200000) out = out.slice(-100000);
      mainWindow.webContents.send('term:data', { id, data: s });
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      out += s;
      if (out.length > 200000) out = out.slice(-100000);
      mainWindow.webContents.send('term:data', { id, data: s });
    });
    child.on('close', (code) => {
      runningProcs.delete(id);
      mainWindow.webContents.send('term:exit', { id, code });
      settle({ ok: true, code, output: out.slice(-8000) });
    });
    child.on('error', (err) => {
      runningProcs.delete(id);
      settle({ ok: false, error: String(err), output: out });
    });
  });
});

ipcMain.handle('term:kill', (_e, id) => {
  const p = runningProcs.get(id);
  if (p) {
    killTree(p);
    runningProcs.delete(id);
    return true;
  }
  return false;
});

// قائمة العمليات الجارية في الخلفية
ipcMain.handle('term:list', () => {
  return [...runningProcs.keys()];
});

// قتل كل العمليات عند إغلاق التطبيق
app.on('before-quit', () => {
  for (const p of runningProcs.values()) killTree(p);
  runningProcs.clear();
});
