const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // الإعدادات
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (cfg) => ipcRenderer.invoke('config:set', cfg),

  // نظام الملفات
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  pickDir: (defaultPath) => ipcRenderer.invoke('dialog:pickDir', defaultPath),
  defaultProjectsDir: () => ipcRenderer.invoke('app:defaultProjectsDir'),
  readTree: (dir) => ipcRenderer.invoke('fs:readTree', dir),
  readDir: (dir) => ipcRenderer.invoke('fs:readDir', dir),
  readFile: (p) => ipcRenderer.invoke('fs:readFile', p),
  writeFile: (p, c) => ipcRenderer.invoke('fs:writeFile', p, c),
  mkdir: (p) => ipcRenderer.invoke('fs:mkdir', p),
  deletePath: (p) => ipcRenderer.invoke('fs:delete', p),
  exists: (p) => ipcRenderer.invoke('fs:exists', p),
  rename: (oldPath, newPath) => ipcRenderer.invoke('fs:rename', oldPath, newPath),

  // البحث الشامل
  searchInFiles: (payload) => ipcRenderer.invoke('search:inFiles', payload),

  // نقاط الاسترجاع
  ckptBegin: (label) => ipcRenderer.invoke('ckpt:begin', label),
  ckptRecord: (p) => ipcRenderer.invoke('ckpt:record', p),
  ckptUndoLast: () => ipcRenderer.invoke('ckpt:undoLast'),
  ckptUndoTo: (id) => ipcRenderer.invoke('ckpt:undoTo', id),
  ckptList: () => ipcRenderer.invoke('ckpt:list'),
  ckptCount: () => ipcRenderer.invoke('ckpt:count'),

  // جلسات المحادثة
  sessionsList: (workspace) => ipcRenderer.invoke('sessions:list', workspace),
  sessionsSave: (session) => ipcRenderer.invoke('sessions:save', session),
  sessionsLoad: (id) => ipcRenderer.invoke('sessions:load', id),
  sessionsDelete: (id) => ipcRenderer.invoke('sessions:delete', id),

  // قائمة الملفات المسطحة
  listAllFiles: (root) => ipcRenderer.invoke('fs:listAllFiles', root),

  // الطرفية
  runCommand: (payload) => ipcRenderer.invoke('term:run', payload),
  killCommand: (id) => ipcRenderer.invoke('term:kill', id),
  listCommands: () => ipcRenderer.invoke('term:list'),
  onTermData: (cb) => ipcRenderer.on('term:data', (_e, d) => cb(d)),
  onTermExit: (cb) => ipcRenderer.on('term:exit', (_e, d) => cb(d)),

  // Git
  gitStatus: (cwd) => ipcRenderer.invoke('git:status', cwd),
  gitInit: (cwd) => ipcRenderer.invoke('git:init', cwd),
  gitStage: (cwd, paths) => ipcRenderer.invoke('git:stage', cwd, paths),
  gitUnstage: (cwd, paths) => ipcRenderer.invoke('git:unstage', cwd, paths),
  gitCommit: (cwd, msg) => ipcRenderer.invoke('git:commit', cwd, msg),
  gitLog: (cwd) => ipcRenderer.invoke('git:log', cwd),
  gitBranches: (cwd) => ipcRenderer.invoke('git:branches', cwd),
  gitCheckout: (cwd, branch, create) => ipcRenderer.invoke('git:checkout', cwd, branch, create),
  gitPush: (cwd) => ipcRenderer.invoke('git:push', cwd),
  gitPull: (cwd) => ipcRenderer.invoke('git:pull', cwd),
  gitShow: (cwd, relPath) => ipcRenderer.invoke('git:show', cwd, relPath),

  // الاستبدال الشامل
  replaceInFiles: (payload) => ipcRenderer.invoke('search:replace', payload),

  // متفرقات
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  onUpdateReady: (cb) => ipcRenderer.on('app:updateReady', () => cb()),
  setUnsaved: (n) => ipcRenderer.send('app:setUnsaved', n),
  getInfo: () => ipcRenderer.invoke('app:info'),
  platform: process.platform,
});
