import { runAgent, testApiKey, callOnce, MODELS, DEFAULT_MODEL, providerOf, isFreeModel, TRANSIENT_ERROR_RE } from './agent.js';

// ============================================================
//  حالة التطبيق
// ============================================================
const state = {
  apiKey: null,
  model: DEFAULT_MODEL,
  workspace: null,
  openFiles: new Map(),   // path -> { model, content, name }
  activeFile: null,
  history: [],            // سجل المحادثة لـ Claude
  running: false,
  lang: 'ar',
  theme: 'dark',
  learnMode: false,
  ghost: false,
  formatOnSave: true,
  usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, requests: 0 },
  lastTurn: null,          // آخر رد: { model, input, output, cost }
  crashReports: false,     // تقارير الأعطال — لا تُرسل إلا بموافقة صريحة
};

// التقاط أخطاء الواجهة غير المعالجة → تقرير عطل مجهول عبر جسر IPC (إن وافق المستخدم)
window.addEventListener('error', (e) => {
  if (!state.crashReports) return;
  window.api.reportError({
    message: e.message || String(e.error || ''),
    stack: e.error?.stack || `${e.filename || ''}:${e.lineno || ''}`,
    source: 'window.onerror',
  });
});
window.addEventListener('unhandledrejection', (e) => {
  if (!state.crashReports) return;
  const r = e.reason;
  window.api.reportError({
    message: r?.message || String(r ?? 'unhandled rejection'),
    stack: r?.stack || '',
    name: r?.name,
    source: 'unhandledrejection',
  });
});

// ============================================================
//  التسعير التقديري (دولار لكل مليون توكن)
// ============================================================
const PRICING = {
  fable: { in: 10, out: 50 },
  mythos: { in: 10, out: 50 },
  'opus-4-8': { in: 5, out: 25 },
  'opus-4-7': { in: 5, out: 25 },
  'opus-4-6': { in: 5, out: 25 },
  'opus-4-5': { in: 5, out: 25 },
  'sonnet': { in: 3, out: 15 },
  'haiku': { in: 1, out: 5 },
  'kimi': { in: 3, out: 15 },
};
function priceFor(model) {
  // المطابقة الدقيقة أولًا — الموديلات المجانية سعرها صفر ويجب ألا تقع في افتراض أعلى سعر
  const exact = MODELS.find((x) => x.id === model);
  if (exact) return { in: exact.in, out: exact.out };
  const m = (model || '').toLowerCase();
  for (const key of Object.keys(PRICING)) {
    if (m.includes(key)) return PRICING[key];
  }
  return PRICING.fable; // افتراض أعلى سعر للحذر
}
function costOf(u, model) {
  const p = priceFor(model);
  const inp = u.input_tokens || 0;
  const out = u.output_tokens || 0;
  const cc = u.cache_creation_input_tokens || 0;
  const cr = u.cache_read_input_tokens || 0;
  return ((inp + cc * 1.25 + cr * 0.1) * p.in + out * p.out) / 1e6;
}

// ============================================================
//  الترجمة (عربي / English)
// ============================================================
const I18N = {
  ar: {
    setupIntro: 'محرر أكواد ذكي يبني تطبيقاتك بالكامل بواسطة نموذج Claude Fable 5 — أقوى نماذج Anthropic. أدخل مفتاح API الخاص بك للبدء.',
    apiKeyLabel: 'مفتاح Anthropic API',
    saveStart: 'حفظ والبدء',
    noKey: 'ليس لديك مفتاح؟ أنشئ حسابك واحصل على المفتاح من',
    keyLocal: 'يُخزَّن المفتاح محليًا على جهازك فقط.',
    openFolder: '📂 فتح مجلد',
    closeFolder: '✖ إغلاق المجلد',
    save: '💾 حفظ',
    key: '⚙️ المفتاح',
    assistant: 'المساعد الذكي',
    greeting: 'مرحبًا! أنا مساعدك البرمجي. افتح مجلدًا ثم اطلب مني بناء ما تريد — مثلًا: «أنشئ لي تطبيق قائمة مهام بواجهة عربية أنيقة». سأبنيه، أشغّله، وأصلح أي أخطاء بنفسي.',
    editorPlaceholder: 'افتح ملفًا من الشجرة أو اطلب من المساعد إنشاء مشروع',
    terminal: 'الطرفية',
    clear: 'مسح',
    explorer: 'المستكشف',
    noFolder: 'لم يُفتح أي مجلد بعد',
    chatPlaceholder: 'اكتب طلبك... (@ لذكر ملف، لصق صورة مدعوم)',
    termPlaceholder: 'اكتب أمرًا ثم Enter...',
    working: 'المساعد يعمل...',
    openFolderFirst: 'من فضلك افتح مجلدًا أولًا (زر «فتح مجلد» في الأعلى) حتى أعمل بداخله.',
    emptyFolder: 'المجلد فارغ',
    tokens: 'توكن',
    errorPrefix: '⚠️ حدث خطأ: ',
    checking: 'جارٍ التحقق من المفتاح...',
    verified: '✓ تم التحقق بنجاح',
    enterKey: 'الرجاء إدخال المفتاح.',
    verifyFail: '✗ فشل التحقق: ',
    usage: 'الاستهلاك',
    statsTitle: 'معلومات الاستهلاك',
    totalTokens: 'إجمالي التوكنات (كل الجلسات)',
    inputTokens: 'توكنات الإدخال',
    outputTokens: 'توكنات الإخراج',
    requests: 'عدد الطلبات',
    estCost: 'التكلفة التقديرية',
    modelPrices: 'أسعار النماذج (دولار لكل مليون توكن — إدخال / إخراج)',
    resetStats: 'تصفير العدّاد',
    lastResp: 'آخر رد',
    resetConfirm: 'هل تريد تصفير عدّاد الاستهلاك التراكمي؟',
    preview: 'معاينة',
    search: 'بحث',
    searchPlaceholder: 'ابحث في الملفات... (Enter)',
    noResults: 'لا توجد نتائج',
    resultsCount: 'نتيجة',
    undo: 'تراجع',
    undoConfirm: 'التراجع عن آخر مهمة سيعيد الملفات التي عدّلها المساعد إلى حالتها السابقة. هل أنت متأكد؟',
    undoDone: '↩️ تم التراجع عن آخر مهمة — استُعيد',
    undoFile: 'ملف',
    undoNone: 'لا توجد نقطة استرجاع للتراجع عنها.',
    newFile: '📄 ملف جديد',
    newFolder: '📁 مجلد جديد',
    renameLbl: '✏️ إعادة تسمية',
    deleteLbl: '🗑️ حذف',
    refreshLbl: '🔄 تحديث',
    promptNewFile: 'اسم الملف الجديد:',
    promptNewFolder: 'اسم المجلد الجديد:',
    promptRename: 'الاسم الجديد:',
    deleteConfirm: 'هل تريد حذف:',
    alreadyExists: 'يوجد عنصر بهذا الاسم بالفعل.',
    ok: 'موافق',
    cancel: 'إلغاء',
    termTab: 'طرفية',
    bgRunning: 'عملية تعمل في الخلفية',
    quickActions: 'أوامر',
    quickActionsTitle: '⚡ أوامر سريعة',
    qaRun: '🚀 شغّل التطبيق',
    qaStop: '🛑 أوقف كل العمليات',
    qaBrowser: '🌍 افتح في المتصفح',
    qaInstaller: '📦 اصنع مثبّت (Installer)',
    qaDesktop: '🖥️ اختصار على سطح المكتب',
    qaEmulator: '📱 شغّل على المحاكي',
    qaTests: '🧪 شغّل الاختبارات',
    qaClean: '🧹 نظّف وأعد التثبيت',
    qaRunP: 'شغّل هذا التطبيق الآن. إن كان خادمًا مستمرًا استخدم background=true، وأخبرني كيف أفتحه وأجرّبه.',
    qaInstallerP: 'اصنع حزمة تثبيت (Installer) لهذا التطبيق بما يناسب نوعه ومنصته (ويندوز)، ونفّذ خطوات البناء كاملة حتى النهاية، ثم أخبرني بمسار الملف الناتج.',
    qaDesktopP: 'أنشئ اختصار تشغيل مباشر لهذا التطبيق على سطح مكتب المستخدم (ملف batch أو اختصار مناسب) بحيث يعمل التطبيق بنقرة مزدوجة، وتأكد أنه يعمل.',
    qaEmulatorP: 'شغّل هذا التطبيق على المحاكي المناسب لنوعه (مثل محاكي Android إن كان تطبيق جوال). إن لم يكن محاكٍ متاحًا فجهّز ما يلزم وأخبرني بالخطوات.',
    qaTestsP: 'شغّل اختبارات هذا المشروع، وإن فشل أي اختبار فأصلحه ثم أعد التشغيل حتى تنجح كلها.',
    qaCleanP: 'نظّف هذا المشروع من مخلفات البناء (مثل node_modules و dist وما يناسب نوعه) ثم أعد تثبيت الاعتماديات وتأكد أن المشروع يعمل.',
    stoppedAll: 'تم إيقاف كل العمليات الجارية.',
    noUrlYet: 'لا يوجد عنوان معاينة بعد — شغّل التطبيق أولًا.',
    sessionsTitle: '🕘 سجل المحادثات',
    noSessions: 'لا توجد محادثات محفوظة لهذا المشروع',
    ckptTitle: '⎌ نقاط الاسترجاع',
    restoreHere: 'استرجاع إلى ما قبل هذه المهمة',
    noCkpts: 'لا توجد نقاط استرجاع',
    filesCount: 'ملف',
    welcomeTitle: '🚀 ابدأ مشروعك',
    welcomeSub: 'اختر قالبًا وسيبنيه المساعد كاملًا، أو اكتب طلبك الخاص في الدردشة',
    tplTodo: '✅ تطبيق مهام',
    tplTodoP: 'أنشئ تطبيق قائمة مهام بواجهة عربية عصرية أنيقة: إضافة وحذف وإكمال المهام، حفظ محلي، وتصميم متجاوب جميل بألوان متناسقة. ثم شغّله.',
    tplPortfolio: '👤 موقع شخصي',
    tplPortfolioP: 'أنشئ موقعًا شخصيًا (Portfolio) عصريًا بواجهة عربية: صفحة تعريف، مهارات، أعمال، ونموذج تواصل، بتصميم جذاب وحركات ناعمة. ثم شغّله.',
    tplStore: '🛒 متجر بسيط',
    tplStoreP: 'أنشئ واجهة متجر إلكتروني بسيطة بالعربية: شبكة منتجات، سلة شراء تعمل محليًا، وتصميم عصري أنيق. ثم شغّله.',
    tplDashboard: '📊 لوحة تحكم',
    tplDashboardP: 'أنشئ لوحة تحكم (Dashboard) عربية ببطاقات إحصائيات ورسوم بيانية وجدول بيانات، بتصميم داكن أنيق. ثم شغّلها.',
    tplGame: '🎮 لعبة بسيطة',
    tplGameP: 'أنشئ لعبة متصفح بسيطة وممتعة (مثل لعبة ذاكرة أو ثعبان) بواجهة عربية جميلة ونظام نقاط. ثم شغّلها.',
    tplCalc: '🧮 آلة حاسبة',
    tplCalcP: 'أنشئ آلة حاسبة أنيقة بواجهة عربية عصرية بتأثيرات زجاجية، تدعم العمليات الأساسية والنسبة المئوية. ثم شغّلها.',
    fixError: '🔧 أصلح هذا الخطأ',
    fixErrorPrompt: 'فشل الأمر التالي في الطرفية:',
    fixErrorOutput: 'المخرجات:',
    fixErrorAsk: 'حلّل سبب الخطأ وأصلحه ثم أعد المحاولة.',
    copyCode: 'نسخ',
    copiedCode: '✓ تم النسخ',
    attachedImg: 'صورة مرفقة',
    stopped: 'تم إيقاف المهمة.',
    learnOn: '🎓 وضع التعلّم مفعّل — سأشرح لك كل خطوة كمعلّم.',
    learnOff: 'وضع التعلّم متوقف.',
    ghostOn: '👻 الإكمال الذكي أثناء الكتابة مفعّل (نموذج Haiku — يستهلك توكنات).',
    ghostOff: 'الإكمال الذكي متوقف.',
    replacePlaceholder: 'استبدال بـ...',
    replaceAll: 'استبدال الكل',
    replaceConfirm: 'سيُستبدل النص في كل ملفات المشروع (مع نقطة استرجاع). متابعة؟',
    replaceDone: 'تم الاستبدال:',
    replaceIn: 'موضعًا في',
    notRepo: 'هذا المجلد ليس مستودع Git بعد',
    gitInit: 'تهيئة مستودع Git',
    commitPlaceholder: 'رسالة الحفظ (Commit)...',
    commit: '✓ Commit',
    changes: 'التغييرات',
    gitLog: 'آخر الحفظات',
    noChanges: 'لا توجد تغييرات',
    commitNeedMsg: 'اكتب رسالة الحفظ أولًا.',
    commitDone: 'تم الحفظ في Git ✓',
    stageAllConfirm: 'لا توجد ملفات مجهزة — تجهيز كل التغييرات ثم الحفظ؟',
    newBranchPrompt: 'اسم الفرع الجديد:',
    gitMissing: 'Git غير مثبّت على الجهاز — ثبّته من git-scm.com لتفعيل هذه اللوحة.',
    inlineEditPh: 'صف التعديل المطلوب على الكود المحدد... (Enter)',
    acceptEdit: '✓ قبول التعديل',
    rejectEdit: 'رفض',
    inlineNoFile: 'افتح ملفًا أولًا ثم اضغط Ctrl+K.',
    explainError: '🔍 اشرح الخطأ',
    explaining: 'جارٍ تحليل الخطأ...',
    voiceHint: 'الإدخال الصوتي يحتاج مفتاح Groq المجاني — تسجيل بحساب Google أو GitHub بدون بطاقة بنكية. أنشئ المفتاح من console.groq.com/keys ثم اضغط زر المايك وأدخله.',
    voiceListening: 'يسجّل... تحدث بلهجتك ثم انقر مرة أخرى للتحويل',
    voiceKeyPrompt: 'أدخل مفتاح Groq (مجاني بدون بطاقة من console.groq.com/keys)',
    voiceTranscribing: 'جارٍ تحويل الصوت إلى نص...',
    voiceErr: 'تعذر التعرف الصوتي: ',
    setVoiceKey: 'مفتاح الإدخال الصوتي (Groq)',
    modelBadgeTitle: 'النموذج الحالي — الاستهلاك يُحسب حسب سعره',
    modelActual: 'انتبه: تم الرد بنموذج بديل — الحساب حسبه: ',
    setMoonshotKey: 'مفتاح Moonshot (Kimi)',
    moonshotKeyPrompt: 'أدخل مفتاح Moonshot API — أنشئه من platform.moonshot.ai',
    setOpenrouterKey: 'مفتاح OpenRouter (الموديلات المجانية)',
    openrouterKeyPrompt: 'أدخل مفتاح OpenRouter — أنشئه مجانًا من openrouter.ai/keys (تسجيل بحساب Google/GitHub، بدون بطاقة بنكية)',
    freeBadge: 'مجاني',
    groupPaid: 'الموديلات الأساسية',
    groupFree: '🎁 موديلات مجانية',
    freeNotice: 'الموديلات المجانية (عبر OpenRouter):\n\n• مناسبة للتجربة والمهام البسيطة — جودتها وسرعتها أقل من الموديلات الأساسية.\n• الطلبات محدودة؛ قد تظهر رسالة ازدحام وقت الضغط.\n• تنبيه خصوصية: قد تُستخدم بياناتك للتدريب لدى بعض المزوّدين المجانيين — لا تستخدمها مع كود حساس أو أسرار.\n\nيلزمك مفتاح OpenRouter مجاني (openrouter.ai/keys).',
    freeRateLimit: '🎁 الموديل المجاني مزدحم حاليًا لدى مزوّده — حاولتُ تلقائيًا أكثر من مرة دون جدوى. انتظر دقيقة ثم أعد إرسال طلبك، أو بدّل مؤقتًا إلى موديل آخر من القائمة.',
    freeModelGone: '🎁 يبدو أن هذا الموديل المجاني لم يعد متاحًا لدى OpenRouter — قائمة الموديلات المجانية تتغير باستمرار. اختر موديلًا آخر من القائمة.',
    setupOr: 'أو',
    setupFreeBtn: '🎁 جرّب مجانًا بمفتاح OpenRouter',
    setCrash: 'تقارير الأعطال المجهولة 🛡️',
    crashConsent: 'هل تسمح بإرسال تقارير أعطال مجهولة عند حدوث خطأ في التطبيق؟\n\n• تساعدنا على اكتشاف المشاكل وإصلاحها بسرعة.\n• لا تتضمن كودك ولا مفاتيحك ولا محتوى ملفاتك — فقط تفاصيل الخطأ التقنية وإصدار التطبيق والنظام، مع إخفاء اسم المستخدم من المسارات.\n• يمكنك تغيير الخيار في أي وقت من الإعدادات.',
    qaDocs: '📚 وثّق المشروع بالعربية',
    qaDocsP: 'أنشئ توثيقًا عربيًا كاملًا لهذا المشروع: ملف README.md بالعربية يشرح الفكرة والتشغيل والبنية، مع تعليقات عربية موجزة للأجزاء المهمة من الكود.',
    paletteFilesPh: 'اكتب اسم ملف للفتح، أو > للأوامر...',
    cmdSave: 'حفظ الملف الحالي',
    cmdFormat: 'تنسيق الملف الحالي (Prettier)',
    cmdNewFile: 'ملف جديد',
    cmdNewFolder: 'مجلد جديد',
    cmdOpenFolder: 'فتح مجلد',
    cmdTheme: 'تبديل المظهر (ليلي/نهاري)',
    cmdLang: 'تبديل اللغة (عربي/English)',
    cmdNewTerm: 'طرفية جديدة',
    cmdPreview: 'إظهار/إخفاء المعاينة',
    cmdNewChat: 'محادثة جديدة',
    cmdRunApp: 'شغّل التطبيق',
    cmdStopAll: 'أوقف كل العمليات',
    cmdGhost: 'تفعيل/إيقاف الإكمال الذكي',
    cmdLearn: 'تفعيل/إيقاف وضع التعلّم',
    cmdFormatOnSave: 'تفعيل/إيقاف التنسيق عند الحفظ',
    cmdGitPanel: 'فتح لوحة Git',
    cmdDocs: 'وثّق المشروع بالعربية',
    cmdTour: 'إعادة الجولة التعريفية',
    formatOnSaveOn: 'التنسيق التلقائي عند الحفظ مفعّل.',
    formatOnSaveOff: 'التنسيق التلقائي عند الحفظ متوقف.',
    tourSkip: 'تخطي',
    tourNext: 'التالي',
    tourDone: 'ابدأ الآن 🚀',
    tourChatT: 'المساعد الذكي',
    tourChatX: 'اكتب طلبك هنا وسيبني المساعد مشروعك كاملًا: ينشئ الملفات، يشغّل الأوامر، ويصلح الأخطاء بنفسه. الصق صورة تصميم أو اذكر ملفًا بـ @.',
    tourModelT: 'اختيار الموديل',
    tourModelX: 'بدّل بين النماذج حسب حاجتك: Fable 5 للأقوى، وHaiku للأسرع والأرخص.',
    tourActionsT: 'الأوامر السريعة',
    tourActionsX: 'تشغيل التطبيق، صنع مثبّت، اختصار سطح المكتب، والمزيد — بنقرة واحدة.',
    tourSideT: 'المستكشف والبحث وGit',
    tourSideX: 'تنقّل بين ملفاتك، ابحث واستبدل في المشروع كله، وأدر Git كاملًا من هنا.',
    tourTermT: 'الطرفية',
    tourTermX: 'طرفيات متعددة بألوان كاملة. عند فشل أمر يظهر زر «أصلح هذا الخطأ» و«اشرح الخطأ».',
    tourLearnT: 'وضع التعلّم',
    tourLearnX: 'فعّله ليتحول المساعد إلى معلّم برمجة يشرح كل خطوة بالعربية.',
    tourUndoT: 'نقاط الاسترجاع',
    tourUndoX: 'كل مهمة لها نقطة استرجاع — تراجع عن أي شيء فعله المساعد بأمان.',
    settingsBtn: '⚙️ الإعدادات',
    settingsTitle: '⚙️ الإعدادات',
    setLang: 'اللغة',
    setTheme: 'المظهر',
    themeDarkName: '🌙 ليلي',
    themeLightName: '☀️ نهاري',
    setFos: 'تنسيق تلقائي عند الحفظ (Prettier)',
    setGhost: 'إكمال ذكي أثناء الكتابة 👻',
    setLearn: 'وضع التعلّم 🎓',
    changeKey: 'تغيير المفتاح',
    versionLbl: 'الإصدار',
    welcomeHome: '👋 مرحبًا بك في سطر',
    welcomeHomeSub: 'أنشئ مشروعًا جديدًا، افتح مجلدًا، أو اختر مجلدًا حديثًا',
    openFolderBig: '📂 فتح مجلد...',
    newProj: '✨ مشروع جديد',
    newProjTitle: '✨ مشروع جديد',
    newProjName: 'اسم المشروع',
    newProjLoc: 'مكان الإنشاء',
    browse: 'تغيير...',
    createProj: 'إنشاء وفتح',
    newProjBadName: 'اسم غير صالح — تجنّب المحارف: < > : " / \\ | ? *',
    newProjNeedName: 'اكتب اسم المشروع أولًا.',
    newProjTimeout: 'تعذّر الإنشاء في هذا المكان (قد يكون مجلدًا سحابيًا معلقًا). جرّب مكانًا آخر.',
    recentFolders: 'المجلدات الحديثة',
    folderGone: 'المجلد لم يعد موجودًا وأُزيل من القائمة.',
    updateReady: '⬆️ تم تنزيل تحديث جديد — سيُثبَّت عند إغلاق التطبيق.',
    setReport: 'واجهت مشكلة أو لديك اقتراح؟',
    reportBtn: '🐞 أبلغ عن مشكلة',
  },
  en: {
    setupIntro: 'A smart code editor that builds your apps end-to-end with Claude Fable 5 — Anthropic’s most capable model. Enter your API key to begin.',
    apiKeyLabel: 'Anthropic API Key',
    saveStart: 'Save & Start',
    noKey: 'No key yet? Create an account and get one from',
    keyLocal: 'The key is stored locally on your device only.',
    openFolder: '📂 Open Folder',
    closeFolder: '✖ Close Folder',
    save: '💾 Save',
    key: '⚙️ API Key',
    assistant: 'AI Assistant',
    greeting: 'Hi! I’m your coding assistant. Open a folder, then ask me to build anything — e.g. "Create a to-do app with a clean, modern UI." I’ll build it, run it, and fix any errors myself.',
    editorPlaceholder: 'Open a file from the tree, or ask the assistant to create a project',
    terminal: 'Terminal',
    clear: 'Clear',
    explorer: 'Explorer',
    noFolder: 'No folder opened yet',
    chatPlaceholder: 'Type your request... (@ to mention a file, paste images)',
    termPlaceholder: 'Type a command, then Enter...',
    working: 'Assistant is working...',
    openFolderFirst: 'Please open a folder first (the "Open Folder" button at the top) so I can work inside it.',
    emptyFolder: 'Folder is empty',
    tokens: 'tokens',
    errorPrefix: '⚠️ Error: ',
    checking: 'Verifying the key...',
    verified: '✓ Verified successfully',
    enterKey: 'Please enter the key.',
    verifyFail: '✗ Verification failed: ',
    usage: 'Usage',
    statsTitle: 'Usage Info',
    totalTokens: 'Total tokens (all sessions)',
    inputTokens: 'Input tokens',
    outputTokens: 'Output tokens',
    requests: 'Requests',
    estCost: 'Estimated cost',
    modelPrices: 'Model rates ($ per 1M tokens — in / out)',
    resetStats: 'Reset counter',
    lastResp: 'Last response',
    resetConfirm: 'Reset the cumulative usage counter?',
    preview: 'Preview',
    search: 'Search',
    searchPlaceholder: 'Search in files... (Enter)',
    noResults: 'No results',
    resultsCount: 'results',
    undo: 'Undo',
    undoConfirm: 'Undoing the last task will restore the files the assistant modified. Are you sure?',
    undoDone: '↩️ Last task undone — restored',
    undoFile: 'file(s)',
    undoNone: 'No checkpoint to undo.',
    newFile: '📄 New file',
    newFolder: '📁 New folder',
    renameLbl: '✏️ Rename',
    deleteLbl: '🗑️ Delete',
    refreshLbl: '🔄 Refresh',
    promptNewFile: 'New file name:',
    promptNewFolder: 'New folder name:',
    promptRename: 'New name:',
    deleteConfirm: 'Delete:',
    alreadyExists: 'An item with this name already exists.',
    ok: 'OK',
    cancel: 'Cancel',
    termTab: 'Terminal',
    bgRunning: 'process running in background',
    quickActions: 'Actions',
    quickActionsTitle: '⚡ Quick Actions',
    qaRun: '🚀 Run the app',
    qaStop: '🛑 Stop all processes',
    qaBrowser: '🌍 Open in browser',
    qaInstaller: '📦 Build installer',
    qaDesktop: '🖥️ Desktop shortcut',
    qaEmulator: '📱 Run on emulator',
    qaTests: '🧪 Run tests',
    qaClean: '🧹 Clean & reinstall',
    qaRunP: 'Run this app now. If it is a long-running server use background=true, and tell me how to open and try it.',
    qaInstallerP: 'Build an installer for this app appropriate for its type and platform (Windows). Run the full build steps to completion, then tell me the path of the output file.',
    qaDesktopP: 'Create a direct-launch shortcut for this app on the user desktop (a batch file or suitable shortcut) so it starts with a double click, and verify it works.',
    qaEmulatorP: 'Run this app on the appropriate emulator for its type (e.g. an Android emulator for mobile apps). If no emulator is available, set up what is needed and tell me the steps.',
    qaTestsP: 'Run this project\'s tests. If any test fails, fix it and re-run until all pass.',
    qaCleanP: 'Clean this project\'s build artifacts (node_modules, dist, etc. as appropriate), then reinstall dependencies and verify the project still works.',
    stoppedAll: 'All running processes stopped.',
    noUrlYet: 'No preview URL yet — run the app first.',
    sessionsTitle: '🕘 Chat History',
    noSessions: 'No saved chats for this project',
    ckptTitle: '⎌ Checkpoints',
    restoreHere: 'Restore to before this task',
    noCkpts: 'No checkpoints',
    filesCount: 'file(s)',
    welcomeTitle: '🚀 Start your project',
    welcomeSub: 'Pick a template and the assistant will build it — or type your own request in the chat',
    tplTodo: '✅ To-do app',
    tplTodoP: 'Create a to-do list app with a clean, modern UI: add, delete, and complete tasks, local storage persistence, and a beautiful responsive design. Then run it.',
    tplPortfolio: '👤 Portfolio site',
    tplPortfolioP: 'Create a modern portfolio website: about section, skills, projects, and a contact form, with an attractive design and smooth animations. Then run it.',
    tplStore: '🛒 Simple store',
    tplStoreP: 'Create a simple e-commerce storefront: product grid, a locally-working shopping cart, and a sleek modern design. Then run it.',
    tplDashboard: '📊 Dashboard',
    tplDashboardP: 'Create a dashboard with stat cards, charts, and a data table, in an elegant dark design. Then run it.',
    tplGame: '🎮 Mini game',
    tplGameP: 'Create a fun simple browser game (like memory or snake) with a nice UI and scoring. Then run it.',
    tplCalc: '🧮 Calculator',
    tplCalcP: 'Create an elegant calculator with a modern glassmorphism UI supporting basic operations and percentage. Then run it.',
    fixError: '🔧 Fix this error',
    fixErrorPrompt: 'The following command failed in the terminal:',
    fixErrorOutput: 'Output:',
    fixErrorAsk: 'Analyze the cause and fix it, then retry.',
    copyCode: 'Copy',
    copiedCode: '✓ Copied',
    attachedImg: 'Attached image',
    stopped: 'Task stopped.',
    learnOn: '🎓 Learning mode on — I will explain each step like a tutor.',
    learnOff: 'Learning mode off.',
    ghostOn: '👻 AI autocomplete enabled (Haiku model — consumes tokens).',
    ghostOff: 'AI autocomplete disabled.',
    replacePlaceholder: 'Replace with...',
    replaceAll: 'Replace all',
    replaceConfirm: 'This will replace the text across all project files (with a checkpoint). Continue?',
    replaceDone: 'Replaced:',
    replaceIn: 'occurrence(s) in',
    notRepo: 'This folder is not a Git repository yet',
    gitInit: 'Initialize Git repository',
    commitPlaceholder: 'Commit message...',
    commit: '✓ Commit',
    changes: 'Changes',
    gitLog: 'Recent commits',
    noChanges: 'No changes',
    commitNeedMsg: 'Write a commit message first.',
    commitDone: 'Committed ✓',
    stageAllConfirm: 'Nothing staged — stage all changes and commit?',
    newBranchPrompt: 'New branch name:',
    gitMissing: 'Git is not installed — install it from git-scm.com to enable this panel.',
    inlineEditPh: 'Describe the change for the selected code... (Enter)',
    acceptEdit: '✓ Accept edit',
    rejectEdit: 'Reject',
    inlineNoFile: 'Open a file first, then press Ctrl+K.',
    explainError: '🔍 Explain error',
    explaining: 'Analyzing the error...',
    voiceHint: 'Voice input needs a free Groq key — sign up with Google/GitHub, no credit card. Create it at console.groq.com/keys, then click the mic and enter it.',
    voiceListening: 'Recording... speak, then click again to transcribe',
    voiceKeyPrompt: 'Enter your Groq key (free, no card — console.groq.com/keys)',
    voiceTranscribing: 'Transcribing audio...',
    voiceErr: 'Speech recognition failed: ',
    setVoiceKey: 'Voice input key (Groq)',
    modelBadgeTitle: 'Current model — usage is billed at its rates',
    modelActual: 'Note: a fallback model answered — billed as: ',
    setMoonshotKey: 'Moonshot key (Kimi)',
    moonshotKeyPrompt: 'Enter your Moonshot API key — create it at platform.moonshot.ai',
    setOpenrouterKey: 'OpenRouter key (free models)',
    openrouterKeyPrompt: 'Enter your OpenRouter key — create it free at openrouter.ai/keys (Google/GitHub sign-in, no credit card)',
    freeBadge: 'Free',
    groupPaid: 'Main models',
    groupFree: '🎁 Free models',
    freeNotice: 'Free models (via OpenRouter):\n\n• Great for trying things out and simple tasks — quality and speed are below the main models.\n• Requests are rate-limited; you may see a busy message at peak times.\n• Privacy note: some free providers may use your data for training — avoid sensitive code or secrets.\n\nYou need a free OpenRouter key (openrouter.ai/keys).',
    freeRateLimit: '🎁 The free model\'s provider is busy right now — I retried automatically without luck. Wait a minute and resend, or switch to another model from the list.',
    freeModelGone: '🎁 This free model seems to be no longer available on OpenRouter — the free list changes often. Pick another model from the list.',
    setupOr: 'or',
    setupFreeBtn: '🎁 Try free with an OpenRouter key',
    setCrash: 'Anonymous crash reports 🛡️',
    crashConsent: 'Allow sending anonymous crash reports when an error occurs?\n\n• Helps us find and fix problems quickly.\n• Never includes your code, keys, or file contents — only technical error details, app version and OS, with your username removed from paths.\n• You can change this anytime in Settings.',
    qaDocs: '📚 Generate Arabic docs',
    qaDocsP: 'Create full Arabic documentation for this project: an Arabic README.md explaining the idea, setup, and structure, plus concise Arabic comments for the important parts of the code.',
    paletteFilesPh: 'Type a file name to open, or > for commands...',
    cmdSave: 'Save current file',
    cmdFormat: 'Format current file (Prettier)',
    cmdNewFile: 'New file',
    cmdNewFolder: 'New folder',
    cmdOpenFolder: 'Open folder',
    cmdTheme: 'Toggle theme (dark/light)',
    cmdLang: 'Toggle language (عربي/English)',
    cmdNewTerm: 'New terminal',
    cmdPreview: 'Toggle preview',
    cmdNewChat: 'New chat',
    cmdRunApp: 'Run the app',
    cmdStopAll: 'Stop all processes',
    cmdGhost: 'Toggle AI autocomplete',
    cmdLearn: 'Toggle learning mode',
    cmdFormatOnSave: 'Toggle format on save',
    cmdGitPanel: 'Open Git panel',
    cmdDocs: 'Generate Arabic docs',
    cmdTour: 'Replay the welcome tour',
    formatOnSaveOn: 'Format on save enabled.',
    formatOnSaveOff: 'Format on save disabled.',
    tourSkip: 'Skip',
    tourNext: 'Next',
    tourDone: 'Start now 🚀',
    tourChatT: 'AI Assistant',
    tourChatX: 'Type your request here and the assistant builds your whole project: creates files, runs commands, and fixes errors by itself. Paste a design image or mention a file with @.',
    tourModelT: 'Model picker',
    tourModelX: 'Switch models as needed: Fable 5 for maximum power, Haiku for speed and low cost.',
    tourActionsT: 'Quick actions',
    tourActionsX: 'Run the app, build an installer, create a desktop shortcut, and more — in one click.',
    tourSideT: 'Explorer, Search & Git',
    tourSideX: 'Browse your files, search and replace across the project, and manage Git — all from here.',
    tourTermT: 'Terminal',
    tourTermX: 'Multiple terminals with full colors. When a command fails, "Fix this error" and "Explain error" buttons appear.',
    tourLearnT: 'Learning mode',
    tourLearnX: 'Turn it on and the assistant becomes a programming tutor that explains every step.',
    tourUndoT: 'Checkpoints',
    tourUndoX: 'Every task gets a checkpoint — safely undo anything the assistant did.',
    settingsBtn: '⚙️ Settings',
    settingsTitle: '⚙️ Settings',
    setLang: 'Language',
    setTheme: 'Theme',
    themeDarkName: '🌙 Dark',
    themeLightName: '☀️ Light',
    setFos: 'Format on save (Prettier)',
    setGhost: 'AI autocomplete 👻',
    setLearn: 'Learning mode 🎓',
    changeKey: 'Change key',
    versionLbl: 'Version',
    welcomeHome: '👋 Welcome to Satr',
    welcomeHomeSub: 'Create a new project, open a folder, or pick a recent one',
    openFolderBig: '📂 Open folder...',
    newProj: '✨ New project',
    newProjTitle: '✨ New Project',
    newProjName: 'Project name',
    newProjLoc: 'Location',
    browse: 'Change...',
    createProj: 'Create & open',
    newProjBadName: 'Invalid name — avoid the characters: < > : " / \\ | ? *',
    newProjNeedName: 'Enter a project name first.',
    newProjTimeout: 'Could not create here (possibly a stuck cloud-synced folder). Try another location.',
    recentFolders: 'Recent folders',
    folderGone: 'That folder no longer exists and was removed from the list.',
    updateReady: '⬆️ An update was downloaded — it will install when you close the app.',
    setReport: 'Found a bug or have a suggestion?',
    reportBtn: '🐞 Report an issue',
  },
};

function t(key) {
  return (I18N[state.lang] && I18N[state.lang][key]) || key;
}

function applyLang(lang) {
  state.lang = lang;
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.documentElement.setAttribute('lang', lang);
  document.documentElement.setAttribute('dir', dir);
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    const k = node.getAttribute('data-i18n');
    if (I18N[lang][k]) node.textContent = I18N[lang][k];
  });
  document.querySelectorAll('[data-i18n-ph]').forEach((node) => {
    const k = node.getAttribute('data-i18n-ph');
    if (I18N[lang][k]) node.setAttribute('placeholder', I18N[lang][k]);
  });
  const langLabel = document.getElementById('lang-label');
  if (langLabel) langLabel.textContent = lang === 'ar' ? 'EN' : 'ع';
  initModelSelect(); // إعادة بناء القائمة لترجمة عناوين المجموعات (أساسية/مجانية)
  updateUsageUI();
}

// إجمالي التوكنات (إدخال + إخراج + تخزين مؤقت)
function totalTokens() {
  const u = state.usage;
  return u.input + u.output + u.cacheCreate + u.cacheRead;
}

function updateUsageUI() {
  const total = totalTokens();
  el.usageBadge.textContent = total ? `${total.toLocaleString()} ${t('tokens')}` : '';
  const set = (id, v) => { const n = document.getElementById(id); if (n) n.textContent = v; };
  set('st-total', total.toLocaleString());
  set('st-input', (state.usage.input + state.usage.cacheCreate + state.usage.cacheRead).toLocaleString());
  set('st-output', state.usage.output.toLocaleString());
  set('st-requests', state.usage.requests.toLocaleString());
  set('st-cost', '$' + state.usage.cost.toFixed(state.usage.cost < 1 ? 4 : 2));
  const lt = state.lastTurn;
  if (lt) {
    const cost = lt.cost < 0.01 ? lt.cost.toFixed(4) : lt.cost.toFixed(3);
    set('st-last-model', modelShort(lt.model));
    set('st-last', `↑ ${lt.input.toLocaleString()} · ↓ ${lt.output.toLocaleString()} · ~$${cost}`);
  }
  renderModelRates();
}

// جدول أسعار النماذج داخل لوحة الاستهلاك (بدل عرضها بجانب كل موديل في القائمة)
function renderModelRates() {
  const box = document.getElementById('st-models');
  if (!box) return;
  box.innerHTML = '';
  for (const m of MODELS) {
    const row = document.createElement('div');
    const current = state.model === m.id;
    row.className = 'stats-row stats-model' + (current ? ' current' : '');
    const name = document.createElement('span');
    name.textContent = (current ? '● ' : '') + m.label;
    if (current) name.title = t('modelBadgeTitle');
    const rate = document.createElement('span');
    if (m.free) {
      rate.textContent = '🎁 ' + t('freeBadge');
      rate.className = 'rate-free';
    } else {
      rate.textContent = `$${m.in} / $${m.out}`;
    }
    row.append(name, rate);
    box.appendChild(row);
  }
}

async function persistUsage() {
  await window.api.setConfig({ usage: state.usage });
}

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.getElementById('theme-icon');
  if (icon) icon.textContent = theme === 'dark' ? '☀️' : '🌙';
  if (monaco) monaco.editor.setTheme(theme === 'dark' ? 'satr' : 'satr-light');
  // مزامنة ألوان كل الطرفيات المفتوحة
  for (const { term } of terms.values()) term.options.theme = xtermTheme();
}

let monacoEditor = null;
let monaco = null;

// ============================================================
//  إعداد Monaco
// ============================================================
window.MonacoEnvironment = {
  getWorkerUrl(_moduleId, _label) {
    // baseUrl يجب أن يشير إلى مجلد min/ لأن العامل يطلب 'vs/...' نسبيًا إليه
    const base = new URL('node_modules/monaco-editor/min/', window.location.href).href;
    const code = `self.MonacoEnvironment={baseUrl:'${base}'};importScripts('${base}vs/base/worker/workerMain.js');`;
    return 'data:text/javascript;charset=utf-8,' + encodeURIComponent(code);
  },
};

function initMonaco() {
  return new Promise((resolve) => {
    const base = new URL('node_modules/monaco-editor/min/vs', window.location.href).href;
    window.require.config({ paths: { vs: base } });
    window.require(['vs/editor/editor.main'], () => {
      monaco = window.monaco;
      monaco.editor.defineTheme('satr', {
        base: 'vs-dark',
        inherit: true,
        rules: [],
        colors: {
          'editor.background': '#0d1117',
          'editor.lineHighlightBackground': '#161b22',
          'editorGutter.background': '#0d1117',
          'editorLineNumber.foreground': '#484f58',
        },
      });
      monaco.editor.defineTheme('satr-light', {
        base: 'vs',
        inherit: true,
        rules: [],
        colors: {
          'editor.background': '#ffffff',
          'editor.lineHighlightBackground': '#f6f8fa',
          'editorGutter.background': '#ffffff',
          'editorLineNumber.foreground': '#8c959f',
        },
      });
      resolve();
    });
  });
}

// اكتشاف لغة الملف من الامتداد
function langFromPath(p) {
  const ext = p.split('.').pop().toLowerCase();
  const map = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', json: 'json', html: 'html', htm: 'html',
    css: 'css', scss: 'scss', less: 'less', py: 'python', java: 'java',
    c: 'c', cpp: 'cpp', h: 'cpp', cs: 'csharp', go: 'go', rs: 'rust',
    php: 'php', rb: 'ruby', sh: 'shell', ps1: 'powershell', md: 'markdown',
    xml: 'xml', yml: 'yaml', yaml: 'yaml', sql: 'sql', vue: 'html',
  };
  return map[ext] || 'plaintext';
}

// ============================================================
//  عناصر الواجهة
// ============================================================
const el = {
  setup: document.getElementById('setup'),
  app: document.getElementById('app'),
  apiKey: document.getElementById('api-key'),
  saveKey: document.getElementById('save-key'),
  setupStatus: document.getElementById('setup-status'),
  wsName: document.getElementById('ws-name'),
  tree: document.getElementById('tree'),
  tabs: document.getElementById('tabs'),
  editorPlaceholder: document.getElementById('editor-placeholder'),
  chatLog: document.getElementById('chat-log'),
  chatInput: document.getElementById('chat-input'),
  sendBtn: document.getElementById('send-btn'),
  usageBadge: document.getElementById('usage-badge'),
  termContainer: document.getElementById('term-container'),
  termTabs: document.getElementById('term-tabs'),
  modelSelect: document.getElementById('model-select'),
  modelBadge: document.getElementById('model-badge'),
};

// ============================================================
//  قائمة اختيار الموديل
// ============================================================
function modelInfoOf(id) {
  return MODELS.find((x) => x.id === id) || MODELS.find((x) => id && String(id).startsWith(x.id));
}
function modelShort(id) {
  const m = modelInfoOf(id);
  return m ? m.label : (id || '');
}

// شارة النموذج أسفل صندوق المحادثة — تؤكد الاختيار وتوضح السعر المعتمد في الحساب
function updateModelBadge(servedModel) {
  const differs = servedModel && !String(servedModel).startsWith(state.model);
  const shown = differs ? servedModel : state.model;
  const m = modelInfoOf(shown);
  el.modelBadge.textContent = (m?.free ? '🎁 ' : '🧠 ') + (m ? m.label : shown);
  el.modelBadge.classList.toggle('actual-differs', !!differs);
  el.modelBadge.title = differs ? t('modelActual') + servedModel : t('modelBadgeTitle');
}
function flashModelBadge() {
  el.modelBadge.classList.remove('flash');
  void el.modelBadge.offsetWidth; // إعادة تشغيل الحركة
  el.modelBadge.classList.add('flash');
}

function initModelSelect() {
  el.modelSelect.innerHTML = '';
  const paid = MODELS.filter((m) => !m.free);
  const free = MODELS.filter((m) => m.free);
  const addGroup = (label, models) => {
    const group = document.createElement('optgroup');
    group.label = label;
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      group.appendChild(opt);
    }
    el.modelSelect.appendChild(group);
  };
  addGroup(t('groupPaid'), paid);
  addGroup(t('groupFree'), free);
  el.modelSelect.value = state.model;
  updateModelBadge();
}

// اختيار المفتاح المناسب حسب مزوّد النموذج (Anthropic أو Moonshot أو OpenRouter)
function keyForModel(id) {
  const provider = providerOf(id);
  if (provider === 'moonshot') return state.moonshotKey;
  if (provider === 'openrouter') return state.openrouterKey;
  return state.apiKey;
}
async function promptMoonshotKey() {
  const key = await askString(t('moonshotKeyPrompt'), state.moonshotKey || '');
  if (!key) return false;
  state.moonshotKey = key;
  await window.api.setConfig({ moonshotKey: key });
  return true;
}
async function promptOpenrouterKey() {
  const key = await askString(t('openrouterKeyPrompt'), state.openrouterKey || '');
  if (!key) return false;
  state.openrouterKey = key;
  await window.api.setConfig({ openrouterKey: key });
  return true;
}
async function ensureModelKey() {
  const provider = providerOf(state.model);
  // من دخل بالمسار المجاني ثم اختار موديل Claude: نعرض شاشة إدخال مفتاح Anthropic
  if (provider === 'anthropic' && !state.apiKey) {
    el.setup.style.display = 'flex';
    el.apiKey.value = '';
    el.saveKey.disabled = false;
    el.setupStatus.textContent = '';
    return false;
  }
  if (provider === 'moonshot' && !state.moonshotKey) return promptMoonshotKey();
  if (provider === 'openrouter') {
    // تنبيه لمرة واحدة عند أول اختيار لموديل مجاني: الجودة، الازدحام، والخصوصية
    if (!state.freeNoticeSeen) {
      await showNotice(t('freeNotice'));
      state.freeNoticeSeen = true;
      await window.api.setConfig({ freeNoticeSeen: true });
    }
    if (!state.openrouterKey) return promptOpenrouterKey();
  }
  return true;
}

el.modelSelect.addEventListener('change', async () => {
  state.model = el.modelSelect.value;
  await window.api.setConfig({ model: state.model });
  updateModelBadge();
  renderModelRates();
  flashModelBadge();
  await ensureModelKey();
});

// ============================================================
//  شاشة الإعداد
// ============================================================
async function boot() {
  const cfg = await window.api.getConfig();
  if (cfg.usage) state.usage = { ...state.usage, ...cfg.usage };
  if (cfg.model && MODELS.some((m) => m.id === cfg.model)) state.model = cfg.model;
  initModelSelect();
  state.learnMode = !!cfg.learnMode;
  state.ghost = !!cfg.ghost;
  state.groqKey = cfg.groqKey || '';
  state.moonshotKey = cfg.moonshotKey || '';
  state.openrouterKey = cfg.openrouterKey || '';
  state.freeNoticeSeen = !!cfg.freeNoticeSeen;
  state.crashReports = cfg.crashReports === true;
  state.crashAsked = !!cfg.crashAsked;
  state.formatOnSave = cfg.formatOnSave !== false;
  state.seenTour = !!cfg.seenTour;
  state.recents = cfg.recentFolders || [];
  updateLearnBtn();
  updateGhostBtn();
  applyLang(cfg.lang || 'ar');
  applyTheme(cfg.theme || 'dark');
  initSplitters(cfg.layout);
  // الدخول بمفتاح Anthropic، أو بمفتاح OpenRouter وحده (مسار البدء المجاني)
  if (cfg.apiKey || cfg.openrouterKey) {
    state.apiKey = cfg.apiKey || null;
    if (cfg.workspace) state.workspace = cfg.workspace;
    await enterApp();
  }
}

el.saveKey.addEventListener('click', async () => {
  const key = el.apiKey.value.trim();
  if (!key) {
    el.setupStatus.textContent = t('enterKey');
    el.setupStatus.style.color = 'var(--red)';
    return;
  }
  el.saveKey.disabled = true;
  el.setupStatus.style.color = 'var(--text-dim)';
  el.setupStatus.textContent = t('checking');
  const res = await testApiKey(key);
  if (res.ok) {
    state.apiKey = key;
    await window.api.setConfig({ apiKey: key });
    el.setupStatus.style.color = 'var(--green)';
    el.setupStatus.textContent = t('verified');
    await enterApp();
  } else {
    el.saveKey.disabled = false;
    el.setupStatus.style.color = 'var(--red)';
    el.setupStatus.textContent = t('verifyFail') + res.error;
  }
});

el.apiKey.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el.saveKey.click();
});

// البدء المجاني: مفتاح OpenRouter بدل مفتاح Anthropic — يدخل التطبيق على أول موديل مجاني
document.getElementById('start-free').addEventListener('click', async () => {
  if (!state.freeNoticeSeen) {
    await showNotice(t('freeNotice'));
    state.freeNoticeSeen = true;
    await window.api.setConfig({ freeNoticeSeen: true });
  }
  if (!(await promptOpenrouterKey())) return;
  if (providerOf(state.model) !== 'openrouter') {
    state.model = MODELS.find((m) => m.free).id;
    await window.api.setConfig({ model: state.model });
  }
  initModelSelect();
  await enterApp();
});

async function enterApp() {
  el.setup.style.display = 'none';
  el.app.style.display = 'flex';
  await initMonaco();
  applyTheme(state.theme);
  if (state.workspace) {
    updateWsUI();
    await refreshTree();
  } else {
    updateWelcome(false);
  }
  setupTerminalListeners();
  await updateUndoButton();
  await refreshGit();
  if (!state.seenTour) {
    state.seenTour = true;
    setTimeout(startTour, 800);
  } else if (!state.crashAsked) {
    // موافقة تقارير الأعطال — سؤال لمرة واحدة، وليس في أول تشغيل (كي لا يزاحم الجولة)
    const info = await window.api.getInfo();
    if (info.crashReportsAvailable) {
      state.crashAsked = true;
      state.crashReports = await askConfirm(t('crashConsent'));
      await window.api.setConfig({ crashReports: state.crashReports, crashAsked: true });
    }
  }
}

// ============================================================
//  شجرة الملفات
// ============================================================
const btnCloseFolder = document.getElementById('btn-close-folder');

function updateWsUI() {
  el.wsName.textContent = state.workspace || '';
  btnCloseFolder.style.display = state.workspace ? '' : 'none';
}

async function openWorkspace(dir) {
  state.workspace = dir;
  updateWsUI();
  // تحديث قائمة المجلدات الحديثة (الأحدث أولًا، حتى 8)
  state.recents = [dir, ...(state.recents || []).filter((d) => d !== dir)].slice(0, 8);
  await window.api.setConfig({ workspace: dir, recentFolders: state.recents });
  await refreshTree();
  await refreshGit();
}

document.getElementById('btn-open-folder').addEventListener('click', async () => {
  const dir = await window.api.openFolder();
  if (dir) await openWorkspace(dir);
});

// ============================================================
//  إنشاء مشروع جديد
// ============================================================
const npOverlay = document.getElementById('newproj-overlay');
const npName = document.getElementById('newproj-name');
const npLocEl = document.getElementById('newproj-loc');
const npStatus = document.getElementById('newproj-status');
let npLocation = '';

async function openNewProject() {
  if (!npLocation) npLocation = await window.api.defaultProjectsDir();
  npLocEl.textContent = npLocation;
  npName.value = '';
  npStatus.textContent = '';
  npOverlay.style.display = 'flex';
  requestAnimationFrame(() => npName.focus());
}
function closeNewProject() { npOverlay.style.display = 'none'; }

async function createNewProject() {
  const name = npName.value.trim();
  if (!name) { npStatus.textContent = t('newProjNeedName'); return; }
  if (/[<>:"/\\|?*]/.test(name) || /^\.+$/.test(name)) {
    npStatus.textContent = t('newProjBadName');
    return;
  }
  const dir = npLocation + SEP + name;
  if (await window.api.exists(dir)) { npStatus.textContent = t('alreadyExists'); return; }
  // مهلة حماية: إن علّق المسار (مزامنة سحابية مثلًا) نظهر خطأ بدل التجمد
  const r = await Promise.race([
    window.api.mkdir(dir),
    new Promise((res) => setTimeout(() => res({ ok: false, error: t('newProjTimeout') }), 6000)),
  ]);
  if (!r.ok) { npStatus.textContent = r.error; return; }
  closeNewProject();
  await openWorkspace(dir);
}

document.getElementById('btn-new-project').addEventListener('click', openNewProject);
document.getElementById('newproj-create').addEventListener('click', createNewProject);
document.getElementById('newproj-cancel').addEventListener('click', closeNewProject);
npOverlay.addEventListener('click', (e) => { if (e.target === npOverlay) closeNewProject(); });
npName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') createNewProject();
  if (e.key === 'Escape') closeNewProject();
});
document.getElementById('newproj-browse').addEventListener('click', async () => {
  const d = await window.api.pickDir(npLocation);
  if (d) { npLocation = d; npLocEl.textContent = d; }
});

// إغلاق المجلد: إغلاق كل الملفات المفتوحة وتفريغ الشجرة ومسح مساحة العمل المحفوظة
btnCloseFolder.addEventListener('click', async () => {
  await saveSession();
  for (const path of [...state.openFiles.keys()]) closeFile(path);
  state.workspace = null;
  state.history = [];
  sessionId = 'sess-' + Date.now();
  allFiles = [];
  updateWsUI();
  updateWelcome(false);
  el.tree.innerHTML = `<div class="tree-empty">${t('noFolder')}</div>`;
  await window.api.setConfig({ workspace: null });
});

async function refreshTree() {
  if (!state.workspace) return;
  const items = await window.api.readTree(state.workspace);
  el.tree.innerHTML = '';
  refreshFileList();
  if (!items || !items.length) {
    el.tree.innerHTML = `<div class="tree-empty">${t('emptyFolder')}</div>`;
    updateWelcome(true);
    return;
  }
  renderTreeItems(items, el.tree, 0);
  updateWelcome(false);
  applyTreeGitColors();
}

function renderTreeItems(items, container, depth) {
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'tree-item';
    row.style.paddingInlineStart = (8 + depth * 14) + 'px';
    row.dataset.path = item.path;

    const ico = document.createElement('span');
    ico.className = 'ico';
    ico.textContent = item.type === 'dir' ? '📁' : fileIcon(item.name);
    const label = document.createElement('span');
    label.textContent = item.name;
    row.append(ico, label);
    container.appendChild(row);

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showCtxMenu(e.clientX, e.clientY, treeItemMenu(item));
    });

    if (item.type === 'dir') {
      const childBox = document.createElement('div');
      childBox.style.display = 'none';
      container.appendChild(childBox);
      let loaded = false;
      row.addEventListener('click', async (e) => {
        e.stopPropagation();
        const open = childBox.style.display === 'none';
        childBox.style.display = open ? 'block' : 'none';
        ico.textContent = open ? '📂' : '📁';
        if (open && !loaded) {
          const kids = await window.api.readDir(item.path);
          renderTreeItems(kids, childBox, depth + 1);
          loaded = true;
          applyTreeGitColors();
        }
      });
    } else {
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        openFile(item.path, item.name);
      });
    }
  }
}

function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const icons = {
    js: '🟨', ts: '🔷', json: '🟫', html: '🟧', css: '🎨',
    md: '📝', py: '🐍', png: '🖼️', jpg: '🖼️', svg: '🖼️',
  };
  return icons[ext] || '📄';
}

// ============================================================
//  المحرر والتبويبات
// ============================================================
async function openFile(filePath, name) {
  if (state.openFiles.has(filePath)) {
    activateFile(filePath);
    return;
  }
  const res = await window.api.readFile(filePath);
  if (!res.ok) {
    appendTerminal('تعذّر فتح الملف: ' + res.error + '\n', 'err');
    return;
  }
  const model = monaco.editor.createModel(res.content, langFromPath(filePath));
  state.openFiles.set(filePath, { model, name, saved: true });
  model.onDidChangeContent(() => {
    const f = state.openFiles.get(filePath);
    if (f && f.saved) {
      f.saved = false;
      renderTabs();
    }
  });
  renderTabs();
  activateFile(filePath);
}

function activateFile(filePath) {
  state.activeFile = filePath;
  const f = state.openFiles.get(filePath);
  if (!f) return;
  el.editorPlaceholder.style.display = 'none';
  welcomeEl.style.display = 'none';
  if (!monacoEditor) {
    monacoEditor = monaco.editor.create(document.getElementById('editor'), {
      model: f.model,
      theme: state.theme === 'dark' ? 'satr' : 'satr-light',
      fontSize: 14,
      fontFamily: "'Cascadia Code','Consolas',monospace",
      minimap: { enabled: true },
      automaticLayout: true,
      scrollBeyondLastLine: false,
      tabSize: 2,
      renderWhitespace: 'selection',
      smoothScrolling: true,
      inlineSuggest: { enabled: true },
    });
    // Ctrl+K: تحرير مباشر بالذكاء
    monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => openInlineEdit());
    setupGhostProvider();
  } else {
    monacoEditor.setModel(f.model);
  }
  requestAnimationFrame(() => { if (monacoEditor) monacoEditor.layout(); });
  renderTabs();
  updateGutter(filePath);
}

function renderTabs() {
  el.tabs.innerHTML = '';
  // إبلاغ العملية الرئيسية بعدد الملفات غير المحفوظة (لتحذير الإغلاق)
  let unsaved = 0;
  for (const f of state.openFiles.values()) if (!f.saved) unsaved++;
  window.api.setUnsaved(unsaved);
  for (const [path, f] of state.openFiles) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (path === state.activeFile ? ' active' : '');
    const label = document.createElement('span');
    label.textContent = (f.saved ? '' : '● ') + f.name;
    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = '✕';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeFile(path); });
    tab.append(label, close);
    tab.addEventListener('click', () => activateFile(path));
    el.tabs.appendChild(tab);
  }
}

function closeFile(path) {
  const f = state.openFiles.get(path);
  if (f) f.model.dispose();
  state.openFiles.delete(path);
  if (state.activeFile === path) {
    const remaining = [...state.openFiles.keys()];
    if (remaining.length) {
      activateFile(remaining[remaining.length - 1]);
    } else {
      state.activeFile = null;
      if (monacoEditor) monacoEditor.setModel(null);
      el.editorPlaceholder.style.display = 'flex';
    }
  }
  renderTabs();
}

async function saveActiveFile() {
  if (!state.activeFile) return;
  const f = state.openFiles.get(state.activeFile);
  if (!f) return;
  if (state.formatOnSave) await formatActive();
  const content = f.model.getValue();
  const res = await window.api.writeFile(state.activeFile, content);
  if (res.ok) {
    f.saved = true;
    renderTabs();
    refreshGit();
    updateGutter(state.activeFile);
  } else {
    appendTerminal('فشل الحفظ: ' + res.error + '\n', 'err');
  }
}

document.getElementById('btn-save').addEventListener('click', saveActiveFile);
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveActiveFile();
  }
});

// ============================================================
//  لوحة الإعدادات الموحدة
// ============================================================
const settingsOverlay = document.getElementById('settings-overlay');

async function openSettings() {
  document.getElementById('set-lang').textContent = state.lang === 'ar' ? 'العربية' : 'English';
  document.getElementById('set-theme').textContent = state.theme === 'dark' ? t('themeDarkName') : t('themeLightName');
  document.getElementById('set-fos').checked = state.formatOnSave;
  document.getElementById('set-ghost').checked = state.ghost;
  document.getElementById('set-learn').checked = state.learnMode;
  document.getElementById('set-crash').checked = state.crashReports;
  const info = await window.api.getInfo();
  document.getElementById('set-about').textContent =
    `سطر (Satr) — ${t('versionLbl')} ${info.version} · Electron ${info.electron}`;
  settingsOverlay.style.display = 'flex';
}
function closeSettings() { settingsOverlay.style.display = 'none'; }

document.getElementById('btn-settings').addEventListener('click', openSettings);
document.getElementById('settings-close').addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) closeSettings(); });

document.getElementById('set-lang').addEventListener('click', async (e) => {
  const next = state.lang === 'ar' ? 'en' : 'ar';
  applyLang(next);
  await window.api.setConfig({ lang: next });
  e.target.textContent = next === 'ar' ? 'العربية' : 'English';
  document.getElementById('set-theme').textContent = state.theme === 'dark' ? t('themeDarkName') : t('themeLightName');
});
document.getElementById('set-theme').addEventListener('click', async (e) => {
  const next = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  await window.api.setConfig({ theme: next });
  e.target.textContent = next === 'dark' ? t('themeDarkName') : t('themeLightName');
});
document.getElementById('set-fos').addEventListener('change', async (e) => {
  state.formatOnSave = e.target.checked;
  await window.api.setConfig({ formatOnSave: state.formatOnSave });
});
document.getElementById('set-ghost').addEventListener('change', async (e) => {
  state.ghost = e.target.checked;
  updateGhostBtn();
  await window.api.setConfig({ ghost: state.ghost });
});
document.getElementById('set-learn').addEventListener('change', async (e) => {
  state.learnMode = e.target.checked;
  updateLearnBtn();
  await window.api.setConfig({ learnMode: state.learnMode });
});
document.getElementById('set-crash').addEventListener('change', async (e) => {
  state.crashReports = e.target.checked;
  await window.api.setConfig({ crashReports: state.crashReports, crashAsked: true });
});
document.getElementById('set-report').addEventListener('click', async () => {
  const info = await window.api.getInfo();
  const body = encodeURIComponent(
    `**وصف المشكلة / الاقتراح:**\n\n\n**خطوات إعادة الإنتاج (إن وجدت):**\n\n\n---\nSatr ${info.version} · Electron ${info.electron} · ${window.api.platform}`
  );
  window.api.openExternal(`https://github.com/mralzeerr/satr-editor/issues/new?body=${body}`);
});
document.getElementById('set-key').addEventListener('click', () => {
  closeSettings();
  el.setup.style.display = 'flex';
  el.apiKey.value = state.apiKey || '';
  el.saveKey.disabled = false;
  el.setupStatus.textContent = '';
});
document.getElementById('set-voice-key').addEventListener('click', async () => {
  closeSettings();
  await promptGroqKey();
});
document.getElementById('set-moonshot-key').addEventListener('click', async () => {
  closeSettings();
  await promptMoonshotKey();
});
document.getElementById('set-openrouter-key').addEventListener('click', async () => {
  closeSettings();
  await promptOpenrouterKey();
});

// تبديل اللغة
document.getElementById('btn-lang').addEventListener('click', async () => {
  const next = state.lang === 'ar' ? 'en' : 'ar';
  applyLang(next);
  await window.api.setConfig({ lang: next });
});

// تبديل المظهر (ليلي / نهاري)
document.getElementById('btn-theme').addEventListener('click', async () => {
  const next = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  await window.api.setConfig({ theme: next });
});

// لوحة الاستهلاك
const statsPanel = document.getElementById('stats-panel');
function toggleStats() { statsPanel.classList.toggle('open'); updateUsageUI(); }
document.getElementById('btn-stats').addEventListener('click', toggleStats);
el.usageBadge.addEventListener('click', toggleStats);
document.getElementById('btn-reset-stats').addEventListener('click', async () => {
  if (!(await askConfirm(t('resetConfirm')))) return;
  state.usage = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, requests: 0 };
  await persistUsage();
  updateUsageUI();
});
// إغلاق اللوحة عند النقر خارجها
document.addEventListener('click', (e) => {
  if (statsPanel.classList.contains('open') &&
      !statsPanel.contains(e.target) &&
      e.target.id !== 'btn-stats' &&
      !el.usageBadge.contains(e.target)) {
    statsPanel.classList.remove('open');
  }
});

// إعادة تحميل ملف مفتوح إن غيّره الوكيل من القرص
async function reloadIfOpen(filePath) {
  if (state.openFiles.has(filePath)) {
    const res = await window.api.readFile(filePath);
    if (res.ok) {
      const f = state.openFiles.get(filePath);
      if (f.model.getValue() !== res.content) {
        f.model.setValue(res.content);
        f.saved = true;
        renderTabs();
      }
    }
  }
}

// ============================================================
//  الطرفية — xterm.js بتبويبات متعددة
// ============================================================
const terms = new Map();      // tabId -> { term, fit, wrap, name }
const procToTab = new Map();  // معرّف العملية -> التبويب الذي أطلقها
let termCounter = 0;
let activeTermId = null;

function xtermTheme() {
  return state.theme === 'dark'
    ? { background: '#0a0d12', foreground: '#c9d1d9', cursor: '#c9d1d9', selectionBackground: '#2d3350' }
    : { background: '#f6f8fa', foreground: '#1f2328', cursor: '#1f2328', selectionBackground: '#c8d1ff' };
}

function createTerminalTab(activate = true) {
  termCounter++;
  const id = 't' + termCounter;
  const wrap = document.createElement('div');
  wrap.className = 'term-view';
  el.termContainer.appendChild(wrap);
  const term = new window.Terminal({
    fontFamily: "'Cascadia Code','Consolas',monospace",
    fontSize: 13,
    theme: xtermTheme(),
    convertEol: true,     // يحوّل \n إلى \r\n تلقائيًا
    disableStdin: true,   // الإدخال عبر حقل الأوامر أسفل الطرفية
    scrollback: 5000,
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(wrap);
  terms.set(id, { term, fit, wrap, name: `${t('termTab')} ${termCounter}` });
  renderTermTabs();
  if (activate) activateTermTab(id);
  return id;
}

function activateTermTab(id) {
  if (!terms.has(id)) return;
  activeTermId = id;
  for (const [tid, tt] of terms) {
    tt.wrap.style.display = tid === id ? 'block' : 'none';
  }
  renderTermTabs();
  requestAnimationFrame(() => {
    const tt = terms.get(id);
    if (tt) try { tt.fit.fit(); } catch {}
  });
}

function closeTerminalTab(id) {
  const tt = terms.get(id);
  if (!tt) return;
  tt.term.dispose();
  tt.wrap.remove();
  terms.delete(id);
  for (const [pid, tid] of [...procToTab]) {
    if (tid === id) procToTab.delete(pid);
  }
  if (!terms.size) {
    createTerminalTab();
  } else if (activeTermId === id) {
    activateTermTab([...terms.keys()].pop());
  } else {
    renderTermTabs();
  }
}

function renderTermTabs() {
  el.termTabs.innerHTML = '';
  for (const [tid, tt] of terms) {
    const tab = document.createElement('button');
    tab.className = 'term-tab' + (tid === activeTermId ? ' active' : '');
    const label = document.createElement('span');
    label.textContent = tt.name;
    tab.appendChild(label);
    if (terms.size > 1) {
      const close = document.createElement('span');
      close.className = 'term-tab-close';
      close.textContent = '✕';
      close.addEventListener('click', (e) => { e.stopPropagation(); closeTerminalTab(tid); });
      tab.appendChild(close);
    }
    tab.addEventListener('click', () => activateTermTab(tid));
    el.termTabs.appendChild(tab);
  }
}

const ANSI = { cmd: '\x1b[1;34m', err: '\x1b[31m', dim: '\x1b[2m', reset: '\x1b[0m' };

function writeTerm(tabId, text, cls) {
  const tt = terms.get(tabId) || terms.get(activeTermId);
  if (!tt) return;
  tt.term.write(cls && ANSI[cls] ? ANSI[cls] + text + ANSI.reset : text);
}

// واجهة مبسطة تكتب في التبويب النشط (تستخدمها بقية الواجهة)
function appendTerminal(text, cls) {
  writeTerm(activeTermId, text, cls);
}

function setupTerminalListeners() {
  if (!terms.size) createTerminalTab();
  window.api.onTermData((d) => {
    writeTerm(procToTab.get(d.id), d.data);
    detectPreviewUrl(d.data);
    // تجميع مخرجات أوامر المستخدم لزر «أصلح هذا الخطأ»
    if (d.id && d.id.startsWith('user-')) {
      const cur = (userOutputs.get(d.id) || '') + d.data;
      userOutputs.set(d.id, cur.slice(-5000));
    }
  });
  window.api.onTermExit((d) => {
    writeTerm(procToTab.get(d.id), `\n[انتهى — كود الخروج: ${d.code}]\n`, d.code === 0 ? 'dim' : 'err');
    procToTab.delete(d.id);
    if (d.id && d.id.startsWith('user-')) {
      if (d.code !== 0 && userCmds.has(d.id)) {
        showFixButton({ cmd: userCmds.get(d.id), output: userOutputs.get(d.id) || '' });
      } else if (d.code === 0) {
        hideFixButton();
      }
      userCmds.delete(d.id);
      userOutputs.delete(d.id);
    }
  });
  const panel = document.querySelector('.terminal-panel');
  new ResizeObserver(() => {
    const tt = terms.get(activeTermId);
    if (tt) try { tt.fit.fit(); } catch {}
  }).observe(panel);
}

document.getElementById('btn-new-term').addEventListener('click', () => createTerminalTab());
document.getElementById('btn-clear-term').addEventListener('click', () => {
  const tt = terms.get(activeTermId);
  if (tt) tt.term.clear();
});

// طرفية تفاعلية: كتابة الأوامر وتنفيذها
const termInput = document.getElementById('terminal-input');
const termHistory = [];
let termHistIdx = -1;

// النقر في الطرفية يركّز حقل الإدخال (إلا عند تحديد نص للنسخ)
document.querySelector('.terminal-panel').addEventListener('click', (e) => {
  if (e.target.closest('.icon-btn') || e.target.closest('.term-tab')) return;
  const tt = terms.get(activeTermId);
  if (tt && tt.term.hasSelection()) return;
  termInput.focus();
});

termInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    const cmd = termInput.value.trim();
    if (!cmd) return;
    termInput.value = '';
    termHistory.push(cmd);
    termHistIdx = termHistory.length;
    const tabId = activeTermId;
    writeTerm(tabId, `\n$ ${cmd}\n`, 'cmd');
    hideFixButton();
    const id = 'user-' + Date.now();
    procToTab.set(id, tabId);
    userCmds.set(id, cmd);
    await window.api.runCommand({ id, command: cmd, cwd: state.workspace || undefined });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (termHistIdx > 0) { termHistIdx--; termInput.value = termHistory[termHistIdx] || ''; }
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (termHistIdx < termHistory.length - 1) { termHistIdx++; termInput.value = termHistory[termHistIdx] || ''; }
    else { termHistIdx = termHistory.length; termInput.value = ''; }
  }
});

// ============================================================
//  لوحة المعاينة الحية
// ============================================================
const previewPanel = document.getElementById('preview-panel');
const previewWebview = document.getElementById('preview-webview');
const previewUrl = document.getElementById('preview-url');
let lastDetectedUrl = null;

function showPreview(url) {
  previewPanel.style.display = 'flex';
  const sp = document.getElementById('split-preview');
  if (sp) sp.style.display = '';
  if (url) {
    previewUrl.value = url;
    previewWebview.src = url;
  }
  requestAnimationFrame(() => { if (monacoEditor) monacoEditor.layout(); });
}

function hidePreview() {
  previewPanel.style.display = 'none';
  const sp = document.getElementById('split-preview');
  if (sp) sp.style.display = 'none';
  requestAnimationFrame(() => { if (monacoEditor) monacoEditor.layout(); });
}

// اكتشاف عنوان خادم تطوير في مخرجات الطرفية → فتح المعاينة تلقائيًا
function detectPreviewUrl(text) {
  const m = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/[^\s"'\]\)>,]*)?/);
  if (!m) return;
  const url = m[0].replace(/[.,;:]+$/, '');
  if (url === lastDetectedUrl) return;
  lastDetectedUrl = url;
  showPreview(url);
}

document.getElementById('btn-preview').addEventListener('click', () => {
  if (previewPanel.style.display !== 'none') { hidePreview(); return; }
  // إن كان الملف النشط HTML اعرضه مباشرة، وإلا افتح اللوحة بآخر عنوان معروف
  if (state.activeFile && /\.html?$/i.test(state.activeFile)) {
    showPreview('file:///' + state.activeFile.replace(/\\/g, '/'));
  } else {
    showPreview(lastDetectedUrl || '');
    previewUrl.focus();
  }
});
document.getElementById('preview-close').addEventListener('click', hidePreview);
document.getElementById('preview-refresh').addEventListener('click', () => {
  try { previewWebview.reload(); } catch {}
});
document.getElementById('preview-external').addEventListener('click', () => {
  const u = previewUrl.value.trim();
  if (u) window.api.openExternal(u);
});
previewUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    let u = previewUrl.value.trim();
    if (!u) return;
    if (!/^(https?|file):/i.test(u)) u = 'http://' + u;
    previewUrl.value = u;
    previewWebview.src = u;
  }
});

// ============================================================
//  البحث الشامل في المشروع
// ============================================================
const searchPane = document.getElementById('search-pane');
const searchInput = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');
const sideTabFiles = document.getElementById('side-tab-files');
const sideTabSearch = document.getElementById('side-tab-search');
const sideTabGit = document.getElementById('side-tab-git');
const sideActions = document.getElementById('side-actions');
const gitPane = document.getElementById('git-pane');

function switchSideTab(which) {
  sideTabFiles.classList.toggle('active', which === 'files');
  sideTabSearch.classList.toggle('active', which === 'search');
  sideTabGit.classList.toggle('active', which === 'git');
  el.tree.style.display = which === 'files' ? '' : 'none';
  sideActions.style.display = which === 'files' ? '' : 'none';
  searchPane.style.display = which === 'search' ? 'flex' : 'none';
  gitPane.style.display = which === 'git' ? 'flex' : 'none';
  if (which === 'search') searchInput.focus();
  if (which === 'git') refreshGit().then(renderGitPane);
}
sideTabFiles.addEventListener('click', () => switchSideTab('files'));
sideTabSearch.addEventListener('click', () => switchSideTab('search'));
sideTabGit.addEventListener('click', () => switchSideTab('git'));

async function runSearch() {
  const query = searchInput.value.trim();
  searchResults.innerHTML = '';
  if (!query || !state.workspace) return;
  const results = await window.api.searchInFiles({ root: state.workspace, query });
  if (!results.length) {
    searchResults.innerHTML = `<div class="search-empty">${t('noResults')}</div>`;
    return;
  }
  const head = document.createElement('div');
  head.className = 'search-count';
  head.textContent = `${results.length} ${t('resultsCount')}`;
  searchResults.appendChild(head);
  // تجميع النتائج حسب الملف
  const byFile = new Map();
  for (const r of results) {
    if (!byFile.has(r.path)) byFile.set(r.path, []);
    byFile.get(r.path).push(r);
  }
  for (const [filePath, hits] of byFile) {
    const fileRow = document.createElement('div');
    fileRow.className = 'search-file';
    fileRow.textContent = `${fileIcon(hits[0].name)} ${hits[0].name}`;
    fileRow.title = filePath;
    searchResults.appendChild(fileRow);
    for (const h of hits) {
      const row = document.createElement('div');
      row.className = 'search-hit';
      row.innerHTML = `<span class="ln">${h.line}</span>`;
      const txt = document.createElement('span');
      txt.className = 'txt';
      txt.textContent = h.text;
      row.appendChild(txt);
      row.addEventListener('click', () => openFileAt(h.path, h.name, h.line, h.col));
      searchResults.appendChild(row);
    }
  }
}
searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });

async function openFileAt(filePath, name, line, col) {
  await openFile(filePath, name);
  if (monacoEditor && state.activeFile === filePath) {
    const pos = { lineNumber: line, column: col || 1 };
    monacoEditor.revealPositionInCenter(pos);
    monacoEditor.setPosition(pos);
    monacoEditor.focus();
  }
}

// ============================================================
//  إدارة الملفات: قائمة زر يمين + مودال إدخال اسم
// ============================================================
const SEP = window.api.platform === 'win32' ? '\\' : '/';
const ctxMenu = document.getElementById('ctx-menu');
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const modalInput = document.getElementById('modal-input');
let modalResolve = null;

function baseName(p) {
  return p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1);
}
function parentDir(p) {
  return p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')));
}

// بديل prompt() غير المدعوم في Electron
function askString(title, defaultValue = '') {
  return new Promise((resolve) => {
    modalResolve = resolve;
    modalTitle.textContent = title;
    modalInput.value = defaultValue;
    modalOverlay.style.display = 'flex';
    requestAnimationFrame(() => { modalInput.focus(); modalInput.select(); });
  });
}
function closeModal(value) {
  modalOverlay.style.display = 'none';
  if (modalResolve) { modalResolve(value); modalResolve = null; }
}
document.getElementById('modal-ok').addEventListener('click', () => closeModal(modalInput.value.trim() || null));
document.getElementById('modal-cancel').addEventListener('click', () => closeModal(null));
modalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') closeModal(modalInput.value.trim() || null);
  if (e.key === 'Escape') closeModal(null);
});
modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(null); });

// بدائل alert/confirm الأصلية — نوافذ Electron الأصلية تعطّل إدخال الكيبورد
// في النافذة بعد إغلاقها (علة معروفة) فنستخدم مودالًا داخليًا دائمًا
const noticeOverlay = document.getElementById('notice-overlay');
const noticeText = document.getElementById('notice-text');
const noticeOk = document.getElementById('notice-ok');
const noticeCancel = document.getElementById('notice-cancel');
let noticeResolve = null;
function openNotice(message, withCancel) {
  return new Promise((resolve) => {
    noticeResolve = resolve;
    noticeText.textContent = message;
    noticeCancel.style.display = withCancel ? '' : 'none';
    noticeOverlay.style.display = 'flex';
    requestAnimationFrame(() => noticeOk.focus());
  });
}
const showNotice = (message) => openNotice(message, false);
const askConfirm = (message) => openNotice(message, true);
function closeNotice(val) {
  noticeOverlay.style.display = 'none';
  if (noticeResolve) { noticeResolve(val); noticeResolve = null; }
}
noticeOk.addEventListener('click', () => closeNotice(true));
noticeCancel.addEventListener('click', () => closeNotice(false));
noticeOverlay.addEventListener('click', (e) => { if (e.target === noticeOverlay) closeNotice(false); });
document.addEventListener('keydown', (e) => {
  if (noticeOverlay.style.display === 'flex' && e.key === 'Escape') closeNotice(false);
});

function hideCtxMenu() { ctxMenu.style.display = 'none'; }
document.addEventListener('click', hideCtxMenu);
window.addEventListener('blur', hideCtxMenu);

function showCtxMenu(x, y, items) {
  ctxMenu.innerHTML = '';
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'ctx-item' + (it.danger ? ' danger' : '');
    row.textContent = it.label;
    row.addEventListener('click', (e) => { e.stopPropagation(); hideCtxMenu(); it.action(); });
    ctxMenu.appendChild(row);
  }
  ctxMenu.style.display = 'block';
  const rect = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
  ctxMenu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
}

async function createFileIn(dir) {
  const name = await askString(t('promptNewFile'));
  if (!name) return;
  const p = dir + SEP + name;
  if (await window.api.exists(p)) { await showNotice(t('alreadyExists')); return; }
  const r = await window.api.writeFile(p, '');
  if (r.ok) {
    await refreshTree();
    openFile(p, name);
  } else {
    appendTerminal('\n' + r.error + '\n', 'err');
  }
}

async function createFolderIn(dir) {
  const name = await askString(t('promptNewFolder'));
  if (!name) return;
  const p = dir + SEP + name;
  if (await window.api.exists(p)) { await showNotice(t('alreadyExists')); return; }
  const r = await window.api.mkdir(p);
  if (r.ok) await refreshTree();
  else appendTerminal('\n' + r.error + '\n', 'err');
}

async function renamePathUI(p) {
  const oldName = baseName(p);
  const newName = await askString(t('promptRename'), oldName);
  if (!newName || newName === oldName) return;
  const np = parentDir(p) + SEP + newName;
  const r = await window.api.rename(p, np);
  if (!r.ok) {
    await showNotice(r.error === 'already-exists' ? t('alreadyExists') : r.error);
    return;
  }
  // أغلق أي تبويب مفتوح للمسار القديم (أو ما بداخله إن كان مجلدًا)
  for (const key of [...state.openFiles.keys()]) {
    if (key === p || key.startsWith(p + SEP)) closeFile(key);
  }
  await refreshTree();
}

async function deletePathUI(p) {
  if (!(await askConfirm(`${t('deleteConfirm')}\n${p}`))) return;
  const r = await window.api.deletePath(p);
  if (!r.ok) { appendTerminal('\n' + r.error + '\n', 'err'); return; }
  for (const key of [...state.openFiles.keys()]) {
    if (key === p || key.startsWith(p + SEP)) closeFile(key);
  }
  await refreshTree();
}

function treeItemMenu(item) {
  const items = [];
  if (item.type === 'dir') {
    items.push({ label: t('newFile'), action: () => createFileIn(item.path) });
    items.push({ label: t('newFolder'), action: () => createFolderIn(item.path) });
  }
  items.push({ label: t('renameLbl'), action: () => renamePathUI(item.path) });
  items.push({ label: t('deleteLbl'), danger: true, action: () => deletePathUI(item.path) });
  return items;
}

// زر يمين على خلفية الشجرة → عمليات على جذر المشروع
el.tree.addEventListener('contextmenu', (e) => {
  if (!state.workspace || e.target.closest('.tree-item')) return;
  e.preventDefault();
  showCtxMenu(e.clientX, e.clientY, [
    { label: t('newFile'), action: () => createFileIn(state.workspace) },
    { label: t('newFolder'), action: () => createFolderIn(state.workspace) },
    { label: t('refreshLbl'), action: () => refreshTree() },
  ]);
});

document.getElementById('btn-new-file').addEventListener('click', () => {
  if (state.workspace) createFileIn(state.workspace);
});
document.getElementById('btn-new-folder').addEventListener('click', () => {
  if (state.workspace) createFolderIn(state.workspace);
});
document.getElementById('btn-refresh-tree').addEventListener('click', () => refreshTree());

// ============================================================
//  الدردشة والوكيل — عرض Markdown مع تلوين الأكواد
// ============================================================
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// تنسيقات السطر الواحد: كود، عريض، مائل، روابط
function inlineMd(s) {
  s = escapeHtml(s);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="#" data-url="$2">$1</a>');
  return s;
}

const CODE_LANG_MAP = {
  js: 'javascript', javascript: 'javascript', mjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', typescript: 'typescript', tsx: 'typescript',
  html: 'html', css: 'css', scss: 'scss', json: 'json', py: 'python', python: 'python',
  sh: 'shell', bash: 'shell', powershell: 'powershell', ps1: 'powershell',
  sql: 'sql', xml: 'xml', yaml: 'yaml', yml: 'yaml', md: 'markdown',
  java: 'java', c: 'c', cpp: 'cpp', csharp: 'csharp', cs: 'csharp', go: 'go', rust: 'rust', php: 'php', ruby: 'ruby',
};

function buildCodeBlock(code, lang) {
  const wrap = document.createElement('div');
  wrap.className = 'code-block';
  const head = document.createElement('div');
  head.className = 'code-head';
  const langLbl = document.createElement('span');
  langLbl.textContent = lang || 'code';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'code-copy';
  copyBtn.textContent = t('copyCode');
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(code);
    copyBtn.textContent = t('copiedCode');
    setTimeout(() => { copyBtn.textContent = t('copyCode'); }, 1500);
  });
  head.append(langLbl, copyBtn);
  const pre = document.createElement('pre');
  const codeEl = document.createElement('code');
  codeEl.textContent = code;
  pre.appendChild(codeEl);
  wrap.append(head, pre);
  // تلوين بمحرك Monaco المحمّل أصلًا
  const monacoLang = CODE_LANG_MAP[(lang || '').toLowerCase()];
  if (monaco && monacoLang) {
    monaco.editor.colorize(code, monacoLang, { tabSize: 2 })
      .then((html) => { codeEl.innerHTML = html; })
      .catch(() => {});
  }
  return wrap;
}

// تحويل Markdown إلى DOM: كتل الكود أولًا ثم الفقرات والقوائم والعناوين
function renderMarkdown(container, text) {
  container.innerHTML = '';
  const parts = text.split(/```(\w*)\n?([\s\S]*?)```/g);
  // parts: [نص, لغة, كود, نص, لغة, كود, ...]
  for (let i = 0; i < parts.length; i++) {
    if (i % 3 === 1) continue; // اللغة تُعالج مع الكود
    if (i % 3 === 2) {
      container.appendChild(buildCodeBlock(parts[i].replace(/\n$/, ''), parts[i - 1]));
      continue;
    }
    const chunk = parts[i];
    if (!chunk || !chunk.trim()) continue;
    const box = document.createElement('div');
    box.className = 'md';
    let html = '';
    let list = null; // 'ul' | 'ol'
    const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
    for (const rawLine of chunk.split('\n')) {
      const line = rawLine.trimEnd();
      const h = line.match(/^(#{1,4})\s+(.*)/);
      const ul = line.match(/^\s*[-*•]\s+(.*)/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
      if (h) {
        closeList();
        const lvl = Math.min(h[1].length + 1, 5);
        html += `<h${lvl}>${inlineMd(h[2])}</h${lvl}>`;
      } else if (ul) {
        if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
        html += `<li>${inlineMd(ul[1])}</li>`;
      } else if (ol) {
        if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; }
        html += `<li>${inlineMd(ol[1])}</li>`;
      } else if (!line.trim()) {
        closeList();
      } else {
        closeList();
        html += `<p>${inlineMd(line)}</p>`;
      }
    }
    closeList();
    box.innerHTML = html;
    // الروابط تُفتح في المتصفح الخارجي
    box.querySelectorAll('a[data-url]').forEach((a) => {
      a.addEventListener('click', (e) => { e.preventDefault(); window.api.openExternal(a.dataset.url); });
    });
    container.appendChild(box);
  }
}

function addUserMessage(text, imageUrls) {
  const div = document.createElement('div');
  div.className = 'msg user';
  if (imageUrls && imageUrls.length) {
    const strip = document.createElement('div');
    strip.className = 'msg-imgs';
    for (const url of imageUrls) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = t('attachedImg');
      strip.appendChild(img);
    }
    div.appendChild(strip);
  }
  if (text) {
    const span = document.createElement('div');
    span.textContent = text;
    div.appendChild(span);
  }
  el.chatLog.appendChild(div);
  scrollChat();
}

function addAiText(text) {
  const div = document.createElement('div');
  div.className = 'msg ai';
  const content = document.createElement('div');
  content.className = 'content';
  renderMarkdown(content, text);
  div.appendChild(content);
  el.chatLog.appendChild(div);
  scrollChat();
}

function addToolChip(name, input) {
  const labels = {
    read_file: '📖 قراءة', write_file: '✍️ كتابة', edit_file: '✏️ تعديل',
    list_dir: '📂 عرض', run_command: '⚡ تنفيذ', kill_process: '⏹ إيقاف',
    delete_path: '🗑️ حذف',
  };
  let detail = input.path || input.command || '';
  if (detail.length > 50) detail = '…' + detail.slice(-48);
  const chip = document.createElement('div');
  chip.className = 'tool-chip';
  chip.textContent = `${labels[name] || name}: ${detail}`;
  el.chatLog.appendChild(chip);
  scrollChat();
  return chip;
}

// ============================================================
//  عارض الفروقات (Diff) بمحرر Monaco
// ============================================================
const diffState = { editor: null, models: [] };
const diffOverlay = document.getElementById('diff-overlay');

function disposeDiffModels() {
  for (const m of diffState.models) { try { m.dispose(); } catch {} }
  diffState.models = [];
}

let diffAcceptHandler = null;

function showDiff(filePath, before, after, onAccept) {
  if (!monaco) return;
  diffOverlay.style.display = 'flex';
  document.getElementById('diff-title').textContent = filePath;
  diffAcceptHandler = onAccept || null;
  document.getElementById('diff-actions').style.display = onAccept ? 'flex' : 'none';
  if (!diffState.editor) {
    diffState.editor = monaco.editor.createDiffEditor(document.getElementById('diff-editor'), {
      readOnly: true,
      automaticLayout: true,
      renderSideBySide: true,
      minimap: { enabled: false },
      fontSize: 13,
    });
  }
  monaco.editor.setTheme(state.theme === 'dark' ? 'satr' : 'satr-light');
  disposeDiffModels();
  const lang = langFromPath(filePath);
  const original = monaco.editor.createModel(before, lang);
  const modified = monaco.editor.createModel(after, lang);
  diffState.models = [original, modified];
  diffState.editor.setModel({ original, modified });
}

function hideDiff() {
  diffOverlay.style.display = 'none';
  disposeDiffModels();
  if (diffState.editor) diffState.editor.setModel(null);
}
document.getElementById('diff-close').addEventListener('click', hideDiff);
diffOverlay.addEventListener('click', (e) => { if (e.target === diffOverlay) hideDiff(); });
document.getElementById('diff-accept').addEventListener('click', () => {
  const fn = diffAcceptHandler;
  hideDiff();
  diffAcceptHandler = null;
  if (fn) fn();
});
document.getElementById('diff-reject').addEventListener('click', () => {
  diffAcceptHandler = null;
  hideDiff();
});

// تفاصيل آخر رد تُعرض في لوحة الاستهلاك بدل سطر أسفل كل رد في المحادثة
function addUsageLine(turn) {
  state.lastTurn = { ...turn, model: turn.model || state.model };
  updateUsageUI();
}

let thinkingEl = null;
function showThinking(show) {
  if (show && !thinkingEl) {
    thinkingEl = document.createElement('div');
    thinkingEl.className = 'thinking';
    thinkingEl.innerHTML = `<span class="spin"></span> ${t('working')}`;
    el.chatLog.appendChild(thinkingEl);
    scrollChat();
  } else if (!show && thinkingEl) {
    thinkingEl.remove();
    thinkingEl = null;
  }
}

function scrollChat() {
  el.chatLog.scrollTop = el.chatLog.scrollHeight;
}

function setRunning(running) {
  state.running = running;
  el.sendBtn.textContent = running ? '■' : '➤';
  el.sendBtn.classList.toggle('stop-btn', running);
  el.chatInput.disabled = running;
}

async function sendMessage() {
  if (state.running) return;
  const text = el.chatInput.value.trim();
  if (!text && !pendingImages.length) return;
  if (!state.workspace) {
    addAiText(t('openFolderFirst'));
    return;
  }

  hideMentionPop();
  el.chatInput.value = '';
  el.chatInput.style.height = 'auto';
  const images = pendingImages.slice();
  pendingImages = [];
  renderAttachStrip();
  addUserMessage(text, images.map((i) => i.url));

  // إرفاق محتوى الملفات المذكورة بـ @ في الطلب
  const expanded = await expandMentions(text);
  let content;
  if (images.length) {
    content = images.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.media_type, data: img.data },
    }));
    content.push({ type: 'text', text: expanded || 'انظر الصورة المرفقة ونفّذ ما تعرضه.' });
  } else {
    content = expanded;
  }
  if (!(await ensureModelKey())) return;
  state.history.push({ role: 'user', content });

  // نقطة استرجاع جديدة لهذه المهمة — تُسجَّل فيها الملفات قبل تعديلها
  await window.api.ckptBegin((text || t('attachedImg')).slice(0, 60));

  setRunning(true);
  showThinking(true);
  agentAbort = new AbortController();

  // مجمّع استهلاك هذا الرد
  const turn = { input: 0, output: 0, cost: 0, model: '' };

  // عنصر الرسالة المتدفقة الحالي
  let streamEl = null;
  let streamRaf = null;
  const flushStream = () => {
    streamRaf = null;
    if (streamEl) {
      renderMarkdown(streamEl, streamEl.__text || '');
      scrollChat();
    }
  };

  const result = await runAgent({
    apiKey: keyForModel(state.model),
    model: state.model,
    workspace: state.workspace,
    history: state.history,
    signal: agentAbort.signal,
    extras: {
      projectIndex: allFiles.slice(0, 300).join('\n'),
      rules: projectRules,
      learningMode: state.learnMode,
    },
    callbacks: {
      onTextDelta: (_delta, fullText) => {
        showThinking(false);
        if (!streamEl) {
          const div = document.createElement('div');
          div.className = 'msg ai';
          streamEl = document.createElement('div');
          streamEl.className = 'content';
          div.appendChild(streamEl);
          el.chatLog.appendChild(div);
        }
        streamEl.__text = fullText;
        if (!streamRaf) streamRaf = requestAnimationFrame(flushStream);
      },
      onTextDone: (fullText) => {
        if (streamEl) {
          renderMarkdown(streamEl, fullText);
          streamEl = null;
          scrollChat();
        } else {
          addAiText(fullText);
        }
        showThinking(state.running);
      },
      onText: (txt) => { showThinking(false); addAiText(txt); showThinking(state.running); },
      onAborted: () => { showThinking(false); streamEl = null; addAiText('⏹ ' + t('stopped')); },
      onToolUse: (name, input) => { showThinking(false); lastToolChip = addToolChip(name, input); showThinking(true); },
      onEdit: (d) => {
        // شريحة الأداة تصبح قابلة للنقر لعرض الفروقات
        const chip = lastToolChip;
        if (!chip) return;
        chip.classList.add('has-diff');
        chip.title = 'عرض الفروقات / Show diff';
        chip.addEventListener('click', () => showDiff(d.path, d.before, d.after));
      },
      onCommand: (cmd, id) => {
        if (id) procToTab.set(id, activeTermId);
        appendTerminal(`\n$ ${cmd}\n`, 'cmd');
      },
      onFileChanged: async (p) => { await refreshTree(); await reloadIfOpen(p); },
      onUsage: (usage, model) => {
        if (usage) {
          const inp = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
          const out = usage.output_tokens || 0;
          const c = costOf(usage, model);
          // تراكمي (كل الجلسات)
          state.usage.input += usage.input_tokens || 0;
          state.usage.output += out;
          state.usage.cacheCreate += usage.cache_creation_input_tokens || 0;
          state.usage.cacheRead += usage.cache_read_input_tokens || 0;
          state.usage.cost += c;
          state.usage.requests += 1;
          // هذا الرد
          turn.input += inp;
          turn.output += out;
          turn.cost += c;
          updateUsageUI();
        }
        // إن اختلف الموديل الفعلي عن المختار (احتياطي الرفض)، أظهره في التلميح والشارة
        if (model) {
          turn.model = model;
          el.modelSelect.title = model === state.model
            ? 'Model / الموديل'
            : `${'Model / الموديل'} — actual: ${model}`;
          updateModelBadge(model);
        }
      },
      onError: (err) => {
        showThinking(false);
        // الموديلات المجانية: رسائل ودّية لأخطائها الشائعة (ازدحام الحد المجاني أو المزود المنبع، اختفاء الموديل)
        if (isFreeModel(state.model) && TRANSIENT_ERROR_RE.test(err)) return addAiText(t('freeRateLimit'));
        if (isFreeModel(state.model) && /HTTP 404/.test(err)) return addAiText(t('freeModelGone'));
        addAiText(t('errorPrefix') + err);
      },
    },
  });

  showThinking(false);
  setRunning(false);
  agentAbort = null;

  // سطر توكنات هذا الرد
  if (turn.input || turn.output) {
    addUsageLine(turn);
  }
  await persistUsage();
  await updateUndoButton();
  await refreshGit();

  if (result.messages) state.history = result.messages;
  await saveSession();
  el.chatInput.focus();
}
let lastToolChip = null;
let agentAbort = null;
let projectRules = '';

// قراءة ملف القواعد satr.md من جذر المشروع (تعليمات دائمة للوكيل)
async function loadProjectRules() {
  projectRules = '';
  if (!state.workspace) return;
  const r = await window.api.readFile(state.workspace + SEP + 'satr.md');
  if (r.ok) projectRules = r.content.slice(0, 8000);
}

// تتبع استهلاك الاستدعاءات الخفيفة (Ctrl+K، الشرح، الإكمال)
function trackUsage(usage, model) {
  if (!usage) return;
  state.usage.input += usage.input_tokens || 0;
  state.usage.output += usage.output_tokens || 0;
  state.usage.cacheCreate += usage.cache_creation_input_tokens || 0;
  state.usage.cacheRead += usage.cache_read_input_tokens || 0;
  state.usage.cost += costOf(usage, model);
  state.usage.requests += 1;
  updateUsageUI();
  persistUsage();
}

// ============================================================
//  نقاط الاسترجاع: لوحة سجل زمني مرئي
// ============================================================
const btnUndo = document.getElementById('btn-undo');
const ckptPanel = document.getElementById('ckpt-panel');
const ckptList = document.getElementById('ckpt-list');

async function updateUndoButton() {
  const n = await window.api.ckptCount();
  btnUndo.style.display = n > 0 ? '' : 'none';
}

async function afterRestore(restoredCount) {
  await refreshTree();
  for (const key of [...state.openFiles.keys()]) {
    const stillThere = await window.api.exists(key);
    if (!stillThere) closeFile(key);
    else await reloadIfOpen(key);
  }
  addAiText(`${t('undoDone')} ${restoredCount} ${t('undoFile')}.`);
  await updateUndoButton();
}

async function renderCkptPanel() {
  const items = await window.api.ckptList();
  ckptList.innerHTML = '';
  if (!items.length) {
    ckptList.innerHTML = `<div class="drop-empty">${t('noCkpts')}</div>`;
    return;
  }
  for (const c of items) {
    const row = document.createElement('div');
    row.className = 'ckpt-row';
    const info = document.createElement('div');
    info.className = 'ckpt-info';
    const title = document.createElement('div');
    title.className = 'ckpt-label';
    title.textContent = c.label || '—';
    const meta = document.createElement('div');
    meta.className = 'ckpt-meta';
    const when = c.time ? new Date(c.time).toLocaleTimeString(state.lang === 'ar' ? 'ar-EG' : 'en-US', { hour: '2-digit', minute: '2-digit' }) : '';
    meta.textContent = `${when} · ${c.fileCount} ${t('filesCount')}`;
    info.append(title, meta);
    const btn = document.createElement('button');
    btn.className = 'ckpt-restore';
    btn.textContent = '↩';
    btn.title = t('restoreHere');
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (state.running) return;
      if (!(await askConfirm(t('undoConfirm')))) return;
      ckptPanel.classList.remove('open');
      const r = await window.api.ckptUndoTo(c.id);
      if (r.ok) await afterRestore(r.restored.length);
    });
    row.append(info, btn);
    ckptList.appendChild(row);
  }
}

btnUndo.addEventListener('click', async (e) => {
  e.stopPropagation();
  document.getElementById('sessions-panel').classList.remove('open');
  ckptPanel.classList.toggle('open');
  if (ckptPanel.classList.contains('open')) await renderCkptPanel();
});

// ============================================================
//  لصق الصور في الدردشة (Vision)
// ============================================================
let pendingImages = []; // { media_type, data, url }
const attachStrip = document.getElementById('attach-strip');

function renderAttachStrip() {
  attachStrip.innerHTML = '';
  attachStrip.style.display = pendingImages.length ? 'flex' : 'none';
  pendingImages.forEach((img, idx) => {
    const box = document.createElement('div');
    box.className = 'attach-thumb';
    const im = document.createElement('img');
    im.src = img.url;
    const x = document.createElement('button');
    x.className = 'attach-x';
    x.textContent = '✕';
    x.addEventListener('click', () => { pendingImages.splice(idx, 1); renderAttachStrip(); });
    box.append(im, x);
    attachStrip.appendChild(box);
  });
}

function addPendingImage(file) {
  if (!file || !file.type.startsWith('image/') || pendingImages.length >= 4) return;
  const fr = new FileReader();
  fr.onload = () => {
    const m = String(fr.result).match(/^data:(image\/[\w+.-]+);base64,(.*)$/s);
    if (m) {
      pendingImages.push({ media_type: m[1], data: m[2], url: fr.result });
      renderAttachStrip();
    }
  };
  fr.readAsDataURL(file);
}

el.chatInput.addEventListener('paste', (e) => {
  const items = e.clipboardData ? [...e.clipboardData.items] : [];
  const imgs = items.filter((i) => i.type.startsWith('image/'));
  if (imgs.length) {
    e.preventDefault();
    for (const it of imgs) addPendingImage(it.getAsFile());
  }
});
const chatBox = document.querySelector('.chat-input-box');
chatBox.addEventListener('dragover', (e) => { e.preventDefault(); });
chatBox.addEventListener('drop', (e) => {
  e.preventDefault();
  for (const f of e.dataTransfer.files) addPendingImage(f);
});

// ============================================================
//  ذكر الملفات بـ @ في الدردشة
// ============================================================
let allFiles = [];
const mentionPop = document.getElementById('mention-pop');
let mentionItems = [];
let mentionIndex = 0;

async function refreshFileList() {
  allFiles = state.workspace ? await window.api.listAllFiles(state.workspace) : [];
  await loadProjectRules();
}

function currentMentionToken() {
  const caret = el.chatInput.selectionStart;
  const before = el.chatInput.value.slice(0, caret);
  const m = before.match(/@([^\s@]*)$/);
  return m ? { token: m[1], start: caret - m[1].length - 1, end: caret } : null;
}

function hideMentionPop() {
  mentionPop.style.display = 'none';
  mentionItems = [];
}

function updateMentionPop() {
  const cur = currentMentionToken();
  if (!cur || !allFiles.length) { hideMentionPop(); return; }
  const q = cur.token.toLowerCase();
  mentionItems = allFiles.filter((f) => f.toLowerCase().includes(q)).slice(0, 8);
  if (!mentionItems.length) { hideMentionPop(); return; }
  mentionIndex = 0;
  mentionPop.innerHTML = '';
  mentionItems.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'mention-item' + (i === mentionIndex ? ' sel' : '');
    row.textContent = `${fileIcon(f)} ${f}`;
    row.addEventListener('mousedown', (e) => { e.preventDefault(); pickMention(i); });
    mentionPop.appendChild(row);
  });
  mentionPop.style.display = 'block';
}

function pickMention(i) {
  const cur = currentMentionToken();
  if (!cur || !mentionItems[i]) return;
  const v = el.chatInput.value;
  el.chatInput.value = v.slice(0, cur.start) + '@' + mentionItems[i] + ' ' + v.slice(cur.end);
  hideMentionPop();
  el.chatInput.focus();
}

// يعالج أسهم التنقل واختيار الملف؛ يعيد true إن التهم الحدث
function mentionHandleKey(e) {
  if (mentionPop.style.display === 'none') return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    mentionIndex = (mentionIndex + (e.key === 'ArrowDown' ? 1 : mentionItems.length - 1)) % mentionItems.length;
    [...mentionPop.children].forEach((c, i) => c.classList.toggle('sel', i === mentionIndex));
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    pickMention(mentionIndex);
    return true;
  }
  if (e.key === 'Escape') { hideMentionPop(); return true; }
  return false;
}

el.chatInput.addEventListener('input', updateMentionPop);
el.chatInput.addEventListener('blur', () => setTimeout(hideMentionPop, 150));

// إرفاق محتوى الملفات المذكورة بالطلب المرسل للوكيل
async function expandMentions(text) {
  if (!text.includes('@')) return text;
  const mentioned = [];
  for (const m of text.matchAll(/@([^\s@]+)/g)) {
    if (allFiles.includes(m[1])) mentioned.push(m[1]);
  }
  if (!mentioned.length) return text;
  let extra = '';
  for (const rel of [...new Set(mentioned)].slice(0, 5)) {
    const p = state.workspace + SEP + rel.split('/').join(SEP);
    const r = await window.api.readFile(p);
    if (r.ok) extra += `\n\n[محتوى الملف @${rel}]:\n\`\`\`\n${r.content.slice(0, 30000)}\n\`\`\``;
  }
  return text + extra;
}

// ============================================================
//  جلسات المحادثة المحفوظة
// ============================================================
let sessionId = 'sess-' + Date.now();
const sessionsPanel = document.getElementById('sessions-panel');
const sessionsList = document.getElementById('sessions-list');

function sessionTitleOf(history) {
  const first = history.find((m) => m.role === 'user');
  if (!first) return '';
  if (typeof first.content === 'string') return first.content.slice(0, 50);
  const txt = Array.isArray(first.content) ? first.content.find((b) => b.type === 'text') : null;
  return (txt ? txt.text : '📷').slice(0, 50);
}

async function saveSession() {
  if (!state.history.length) return;
  await window.api.sessionsSave({
    id: sessionId,
    workspace: state.workspace || '',
    title: sessionTitleOf(state.history),
    messages: state.history,
  });
}

function resetChatLog() {
  el.chatLog.innerHTML = '';
  addAiText(t('greeting'));
}

function renderHistory(messages) {
  el.chatLog.innerHTML = '';
  for (const m of messages) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        addUserMessage(m.content.split('\n\n[محتوى الملف @')[0]);
      } else if (Array.isArray(m.content)) {
        const isToolResult = m.content.some((b) => b.type === 'tool_result');
        if (isToolResult) continue;
        const imgs = m.content
          .filter((b) => b.type === 'image' && b.source && b.source.type === 'base64')
          .map((b) => `data:${b.source.media_type};base64,${b.source.data}`);
        const txt = m.content.find((b) => b.type === 'text');
        addUserMessage(txt ? txt.text.split('\n\n[محتوى الملف @')[0] : '', imgs);
      }
    } else if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'text' && b.text.trim()) addAiText(b.text);
        else if (b.type === 'tool_use') addToolChip(b.name, b.input || {});
      }
    }
  }
  scrollChat();
}

async function startNewChat() {
  await saveSession();
  sessionId = 'sess-' + Date.now();
  state.history = [];
  resetChatLog();
  el.chatInput.focus();
}

async function renderSessionsPanel() {
  const metas = await window.api.sessionsList(state.workspace || '');
  sessionsList.innerHTML = '';
  const others = metas.filter((m) => m.id !== sessionId || m.count);
  if (!others.length) {
    sessionsList.innerHTML = `<div class="drop-empty">${t('noSessions')}</div>`;
    return;
  }
  for (const meta of others) {
    const row = document.createElement('div');
    row.className = 'sess-row' + (meta.id === sessionId ? ' current' : '');
    const info = document.createElement('div');
    info.className = 'sess-info';
    const title = document.createElement('div');
    title.className = 'sess-title';
    title.textContent = meta.title || '—';
    const time = document.createElement('div');
    time.className = 'sess-meta';
    time.textContent = meta.updatedAt
      ? new Date(meta.updatedAt).toLocaleString(state.lang === 'ar' ? 'ar-EG' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '';
    info.append(title, time);
    const del = document.createElement('button');
    del.className = 'sess-del';
    del.textContent = '🗑';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.api.sessionsDelete(meta.id);
      await renderSessionsPanel();
    });
    row.append(info, del);
    row.addEventListener('click', async () => {
      sessionsPanel.classList.remove('open');
      if (meta.id === sessionId) return;
      await saveSession();
      const s = await window.api.sessionsLoad(meta.id);
      if (!s) return;
      sessionId = s.id;
      state.history = s.messages || [];
      renderHistory(state.history);
    });
    sessionsList.appendChild(row);
  }
}

document.getElementById('btn-new-chat').addEventListener('click', startNewChat);
document.getElementById('btn-sessions').addEventListener('click', async (e) => {
  e.stopPropagation();
  ckptPanel.classList.remove('open');
  sessionsPanel.classList.toggle('open');
  if (sessionsPanel.classList.contains('open')) await renderSessionsPanel();
});

// إغلاق اللوحات المنسدلة عند النقر خارجها
document.addEventListener('click', (e) => {
  for (const [panel, opener] of [
    [sessionsPanel, 'btn-sessions'],
    [ckptPanel, 'btn-undo'],
    [document.getElementById('actions-panel'), 'btn-actions'],
  ]) {
    if (panel.classList.contains('open') && !panel.contains(e.target) && !e.target.closest('#' + opener)) {
      panel.classList.remove('open');
    }
  }
});

// ============================================================
//  قائمة الأوامر السريعة
// ============================================================
const actionsPanel = document.getElementById('actions-panel');

const QUICK_ACTIONS = [
  { key: 'qaRun', prompt: 'qaRunP' },
  { key: 'qaBrowser', run: () => {
    if (lastDetectedUrl) window.api.openExternal(lastDetectedUrl);
    else addAiText(t('noUrlYet'));
  } },
  { key: 'qaStop', run: async () => {
    const ids = await window.api.listCommands();
    for (const id of ids) await window.api.killCommand(id);
    appendTerminal(`\n[${t('stoppedAll')}]\n`, 'dim');
  } },
  { key: 'qaTests', prompt: 'qaTestsP' },
  { key: 'qaInstaller', prompt: 'qaInstallerP' },
  { key: 'qaDesktop', prompt: 'qaDesktopP' },
  { key: 'qaEmulator', prompt: 'qaEmulatorP' },
  { key: 'qaDocs', prompt: 'qaDocsP' },
  { key: 'qaClean', prompt: 'qaCleanP' },
];

function renderActionsPanel() {
  const list = document.getElementById('actions-list');
  list.innerHTML = '';
  for (const a of QUICK_ACTIONS) {
    const row = document.createElement('div');
    row.className = 'action-row';
    row.textContent = t(a.key);
    row.addEventListener('click', () => {
      actionsPanel.classList.remove('open');
      if (a.run) { a.run(); return; }
      if (state.running) return;
      el.chatInput.value = t(a.prompt);
      sendMessage();
    });
    list.appendChild(row);
  }
}

document.getElementById('btn-actions').addEventListener('click', (e) => {
  e.stopPropagation();
  renderActionsPanel();
  actionsPanel.classList.toggle('open');
});

// ============================================================
//  زر «أصلح هذا الخطأ» عند فشل أمر في الطرفية
// ============================================================
const userCmds = new Map();     // id -> الأمر
const userOutputs = new Map();  // id -> آخر المخرجات
let lastFailure = null;

const fixBtn = document.createElement('button');
fixBtn.className = 'fix-error-btn';
fixBtn.style.display = 'none';
document.querySelector('.terminal-panel').appendChild(fixBtn);

function showFixButton(failure) {
  lastFailure = failure;
  fixBtn.textContent = t('fixError');
  fixBtn.style.display = 'block';
  explainBtn.textContent = t('explainError');
  explainBtn.style.display = 'block';
}
function hideFixButton() {
  lastFailure = null;
  fixBtn.style.display = 'none';
  explainBtn.style.display = 'none';
}
fixBtn.addEventListener('click', () => {
  if (!lastFailure || state.running) return;
  el.chatInput.value =
    `${t('fixErrorPrompt')}\n$ ${lastFailure.cmd}\n\n${t('fixErrorOutput')}\n\`\`\`\n${lastFailure.output.slice(-3000)}\n\`\`\`\n${t('fixErrorAsk')}`;
  hideFixButton();
  sendMessage();
});

// ============================================================
//  شاشة البداية: قوالب جاهزة
// ============================================================
const welcomeEl = document.getElementById('welcome');
const TEMPLATES = ['tplTodo', 'tplPortfolio', 'tplStore', 'tplDashboard', 'tplGame', 'tplCalc'];

function renderWelcome() {
  const grid = document.getElementById('welcome-grid');
  grid.innerHTML = '';
  for (const key of TEMPLATES) {
    const card = document.createElement('button');
    card.className = 'welcome-card';
    card.textContent = t(key);
    card.addEventListener('click', () => {
      if (state.running) return;
      el.chatInput.value = t(key + 'P');
      sendMessage();
    });
    grid.appendChild(card);
  }
}

function updateWelcome(treeIsEmpty) {
  const noWs = !state.workspace;
  const emptyWs = !!state.workspace && treeIsEmpty && !state.openFiles.size;
  const show = noWs || emptyWs;
  welcomeEl.style.display = show ? 'flex' : 'none';
  if (!show) return;
  document.getElementById('welcome-title').textContent = noWs ? t('welcomeHome') : t('welcomeTitle');
  document.getElementById('welcome-sub').textContent = noWs ? t('welcomeHomeSub') : t('welcomeSub');
  document.getElementById('welcome-grid').style.display = emptyWs ? 'grid' : 'none';
  document.getElementById('welcome-recents').style.display = noWs ? 'flex' : 'none';
  if (emptyWs) renderWelcome();
  if (noWs) renderRecents();
}

// شاشة البداية بلا مجلد: زر فتح + المجلدات الحديثة
function renderRecents() {
  const box = document.getElementById('welcome-recents');
  box.innerHTML = '';
  const btnRow = document.createElement('div');
  btnRow.className = 'recent-btn-row';
  const newBtn = document.createElement('button');
  newBtn.className = 'btn-primary recent-open';
  newBtn.textContent = t('newProj');
  newBtn.addEventListener('click', openNewProject);
  const openBtn = document.createElement('button');
  openBtn.className = 'modal-cancel recent-open';
  openBtn.textContent = t('openFolderBig');
  openBtn.addEventListener('click', () => document.getElementById('btn-open-folder').click());
  btnRow.append(newBtn, openBtn);
  box.appendChild(btnRow);
  const recents = state.recents || [];
  if (recents.length) {
    const head = document.createElement('div');
    head.className = 'recent-head';
    head.textContent = t('recentFolders');
    box.appendChild(head);
    for (const dir of recents) {
      const row = document.createElement('button');
      row.className = 'recent-row';
      const name = document.createElement('span');
      name.className = 'recent-name';
      name.textContent = '📁 ' + baseName(dir);
      const full = document.createElement('span');
      full.className = 'recent-path';
      full.textContent = dir;
      row.append(name, full);
      row.addEventListener('click', async () => {
        if (!(await window.api.exists(dir))) {
          state.recents = state.recents.filter((d) => d !== dir);
          await window.api.setConfig({ recentFolders: state.recents });
          renderRecents();
          addAiText(t('folderGone'));
          return;
        }
        await openWorkspace(dir);
      });
      box.appendChild(row);
    }
  }
}

// ============================================================
//  الألواح القابلة لتغيير الحجم (مع حفظ التخطيط)
// ============================================================
const layoutState = {};
let layoutSaveTimer = null;

function persistLayout() {
  clearTimeout(layoutSaveTimer);
  layoutSaveTimer = setTimeout(() => window.api.setConfig({ layout: layoutState }), 400);
}

function makeSplitter(id, target, prop, signFn, min, max, key) {
  const sp = document.getElementById(id);
  if (!sp) return;
  sp.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const horizontal = prop === 'height';
    const startPos = horizontal ? e.clientY : e.clientX;
    const startSize = target.getBoundingClientRect()[prop];
    document.body.style.cursor = horizontal ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev) => {
      const delta = (horizontal ? ev.clientY : ev.clientX) - startPos;
      const size = Math.max(min, Math.min(max, startSize + delta * signFn()));
      target.style[prop] = size + 'px';
      target.style.flex = '0 0 auto';
      layoutState[key] = size;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      persistLayout();
      if (monacoEditor) monacoEditor.layout();
      const tt = terms.get(activeTermId);
      if (tt) try { tt.fit.fit(); } catch {}
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function initSplitters(saved) {
  const chat = document.querySelector('.chat');
  const sidebar = document.querySelector('.sidebar');
  const termPanel = document.querySelector('.terminal-panel');
  const rtl = () => (document.documentElement.getAttribute('dir') === 'rtl' ? -1 : 1);
  const rtlOpp = () => -rtl();
  if (saved) {
    Object.assign(layoutState, saved);
    if (saved.chatW) { chat.style.width = saved.chatW + 'px'; }
    if (saved.sideW) { sidebar.style.width = saved.sideW + 'px'; }
    if (saved.termH) { termPanel.style.height = saved.termH + 'px'; }
    if (saved.prevW) { previewPanel.style.width = saved.prevW + 'px'; previewPanel.style.flex = '0 0 auto'; }
  }
  makeSplitter('split-chat', chat, 'width', rtl, 260, 640, 'chatW');
  makeSplitter('split-side', sidebar, 'width', rtlOpp, 160, 480, 'sideW');
  makeSplitter('split-term', termPanel, 'height', () => -1, 100, 500, 'termH');
  makeSplitter('split-preview', previewPanel, 'width', rtlOpp, 220, 1000, 'prevW');
}

el.sendBtn.addEventListener('click', () => {
  if (state.running) {
    // إيقاف حقيقي: يقطع الطلب الجاري فورًا
    agentAbort?.abort();
  } else {
    sendMessage();
  }
});

el.chatInput.addEventListener('keydown', (e) => {
  if (mentionHandleKey(e)) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// توسيع تلقائي لحقل الإدخال
el.chatInput.addEventListener('input', () => {
  el.chatInput.style.height = 'auto';
  el.chatInput.style.height = Math.min(el.chatInput.scrollHeight, 140) + 'px';
});

// ============================================================
//  تكامل Git
// ============================================================
const gitState = { isRepo: false, branch: '', files: [], map: new Map(), gitMissing: false };

async function refreshGit() {
  if (!state.workspace) { gitState.isRepo = false; gitState.map.clear(); updateGitUI(); return; }
  const st = await window.api.gitStatus(state.workspace);
  gitState.isRepo = !!st.isRepo;
  gitState.gitMissing = !!st.gitMissing;
  gitState.branch = st.branch || '';
  gitState.files = st.files || [];
  gitState.map = new Map(gitState.files.map((f) => [f.path.replace(/\//g, SEP), f]));
  updateGitUI();
  applyTreeGitColors();
}

function updateGitUI() {
  const badge = document.getElementById('git-branch');
  badge.style.display = gitState.isRepo ? '' : 'none';
  document.getElementById('git-branch-name').textContent = gitState.branch;
  if (gitPane.style.display !== 'none') renderGitPane();
}

function relOf(absPath) {
  if (!state.workspace) return absPath;
  return absPath.startsWith(state.workspace + SEP) ? absPath.slice(state.workspace.length + 1) : absPath;
}

// تلوين عناصر الشجرة حسب حالة Git
function applyTreeGitColors() {
  document.querySelectorAll('.tree-item[data-path]').forEach((row) => {
    row.classList.remove('git-mod', 'git-new');
    if (!gitState.isRepo) return;
    const rel = relOf(row.dataset.path);
    const f = gitState.map.get(rel);
    if (!f) {
      // مجلد يحوي تغييرات؟
      for (const p of gitState.map.keys()) {
        if (p.startsWith(rel + SEP)) { row.classList.add('git-mod'); return; }
      }
      return;
    }
    row.classList.add(f.x === '?' || f.y === '?' ? 'git-new' : 'git-mod');
  });
}

async function renderGitPane() {
  const noRepo = document.getElementById('git-norepo');
  const repo = document.getElementById('git-repo');
  if (!gitState.isRepo) {
    noRepo.style.display = '';
    repo.style.display = 'none';
    if (gitState.gitMissing) noRepo.querySelector('.drop-empty').textContent = t('gitMissing');
    return;
  }
  noRepo.style.display = 'none';
  repo.style.display = '';

  // الفروع
  const sel = document.getElementById('git-branch-select');
  const branches = await window.api.gitBranches(state.workspace);
  sel.innerHTML = '';
  for (const b of branches) {
    const opt = document.createElement('option');
    opt.value = b.name;
    opt.textContent = '🌿 ' + b.name;
    if (b.current) opt.selected = true;
    sel.appendChild(opt);
  }

  // التغييرات
  const changes = document.getElementById('git-changes');
  changes.innerHTML = '';
  if (!gitState.files.length) {
    changes.innerHTML = `<div class="drop-empty">${t('noChanges')}</div>`;
  }
  for (const f of gitState.files) {
    const row = document.createElement('div');
    row.className = 'git-file';
    const staged = f.x !== ' ' && f.x !== '?';
    const badge = document.createElement('span');
    badge.className = 'git-badge ' + (f.x === '?' ? 'new' : 'mod');
    badge.textContent = f.x === '?' ? 'U' : (staged ? f.x : f.y);
    const name = document.createElement('span');
    name.className = 'git-file-name';
    name.textContent = f.path;
    name.title = f.path;
    const stageBtn = document.createElement('button');
    stageBtn.className = 'icon-btn';
    stageBtn.textContent = staged ? '−' : '+';
    stageBtn.title = staged ? 'Unstage' : 'Stage';
    stageBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (staged) await window.api.gitUnstage(state.workspace, [f.path]);
      else await window.api.gitStage(state.workspace, [f.path]);
      await refreshGit();
    });
    row.append(badge, name, stageBtn);
    if (staged) row.classList.add('staged');
    // النقر يعرض فرق الملف مقابل HEAD
    row.addEventListener('click', async () => {
      const head = await window.api.gitShow(state.workspace, f.path);
      const abs = state.workspace + SEP + f.path.replace(/\//g, SEP);
      const cur = await window.api.readFile(abs);
      showDiff(f.path, head.ok ? head.content : '', cur.ok ? cur.content : '');
    });
    changes.appendChild(row);
  }

  // السجل
  const logBox = document.getElementById('git-log');
  const log = await window.api.gitLog(state.workspace);
  logBox.innerHTML = '';
  for (const c of log) {
    const row = document.createElement('div');
    row.className = 'git-commit';
    row.innerHTML = `<span class="hash">${escapeHtml(c.hash)}</span><span class="subj"></span><span class="date">${escapeHtml(c.date)}</span>`;
    row.querySelector('.subj').textContent = c.subject;
    logBox.appendChild(row);
  }
}

document.getElementById('btn-git-init').addEventListener('click', async () => {
  await window.api.gitInit(state.workspace);
  await refreshGit();
});
document.getElementById('btn-git-refresh').addEventListener('click', refreshGit);
document.getElementById('btn-git-pull').addEventListener('click', async () => {
  const r = await window.api.gitPull(state.workspace);
  appendTerminal(`\n[git pull] ${(r.out || r.error || '').trim()}\n`, r.ok ? 'dim' : 'err');
  await refreshGit();
  await refreshTree();
});
document.getElementById('btn-git-push').addEventListener('click', async () => {
  const r = await window.api.gitPush(state.workspace);
  appendTerminal(`\n[git push] ${(r.out || r.error || '').trim()}\n`, r.ok ? 'dim' : 'err');
});
document.getElementById('git-branch-select').addEventListener('change', async (e) => {
  const r = await window.api.gitCheckout(state.workspace, e.target.value, false);
  if (!r.ok) appendTerminal('\n' + r.error + '\n', 'err');
  await refreshGit();
  await refreshTree();
});
document.getElementById('btn-git-newbranch').addEventListener('click', async () => {
  const name = await askString(t('newBranchPrompt'));
  if (!name) return;
  const r = await window.api.gitCheckout(state.workspace, name, true);
  if (!r.ok) appendTerminal('\n' + r.error + '\n', 'err');
  await refreshGit();
});
document.getElementById('btn-git-commit').addEventListener('click', async () => {
  const msgBox = document.getElementById('git-commit-msg');
  const msg = msgBox.value.trim();
  if (!msg) { await showNotice(t('commitNeedMsg')); return; }
  const hasStaged = gitState.files.some((f) => f.x !== ' ' && f.x !== '?');
  if (!hasStaged) {
    if (!(await askConfirm(t('stageAllConfirm')))) return;
    await window.api.gitStage(state.workspace, ['.']);
  }
  const r = await window.api.gitCommit(state.workspace, msg);
  if (r.ok) {
    msgBox.value = '';
    addAiText(t('commitDone'));
  } else {
    appendTerminal('\n' + r.error + '\n', 'err');
  }
  await refreshGit();
});

// فرق سطري بسيط (Myers مبسط عبر LCS) لفروقات الهامش
function lineDiff(oldLines, newLines) {
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > 2000000) return null; // ملفات ضخمة — نتجاوز
  // LCS بجدول مسطح
  const dp = new Uint32Array((n + 1) * (m + 1));
  const W = m + 1;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] = oldLines[i] === newLines[j]
        ? dp[(i + 1) * W + j + 1] + 1
        : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
  }
  const added = [];
  const modified = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) { i++; j++; }
    else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) {
      // حذف من القديم — إن قابله إدراج فهو تعديل
      let del = 0;
      while (i < n && j < m && oldLines[i] !== newLines[j] && dp[(i + 1) * W + j] >= dp[i * W + j + 1]) { i++; del++; }
      let ins = 0;
      while (i < n && j < m && oldLines[i] !== newLines[j] && dp[i * W + j + 1] > dp[(i + 1) * W + j]) { modified.push(j + 1); j++; ins++; }
      if (del && !ins && j < m) modified.push(Math.min(j + 1, m));
    } else {
      added.push(j + 1);
      j++;
    }
  }
  while (j < m) { added.push(j + 1); j++; }
  return { added, modified };
}

// فروقات الهامش في المحرر مقابل HEAD
async function updateGutter(absPath) {
  const f = state.openFiles.get(absPath);
  if (!f || !monacoEditor || !gitState.isRepo) return;
  const rel = relOf(absPath).replace(/\\/g, '/');
  const head = await window.api.gitShow(state.workspace, rel);
  let decorations = [];
  if (head.ok) {
    const d = lineDiff(head.content.split(/\r?\n/), f.model.getValue().split(/\r?\n/));
    if (d) {
      decorations = [
        ...d.added.map((ln) => ({
          range: new monaco.Range(ln, 1, ln, 1),
          options: { isWholeLine: false, linesDecorationsClassName: 'gutter-added' },
        })),
        ...d.modified.map((ln) => ({
          range: new monaco.Range(ln, 1, ln, 1),
          options: { isWholeLine: false, linesDecorationsClassName: 'gutter-modified' },
        })),
      ];
    }
  } else {
    // ملف جديد كليًا
    decorations = [{
      range: new monaco.Range(1, 1, f.model.getLineCount(), 1),
      options: { linesDecorationsClassName: 'gutter-added' },
    }];
  }
  f.gutterIds = f.model.deltaDecorations(f.gutterIds || [], decorations);
}

// ============================================================
//  لوحة الأوامر (Ctrl+P ملفات / Ctrl+Shift+P أوامر)
// ============================================================
const paletteOverlay = document.getElementById('palette-overlay');
const paletteInput = document.getElementById('palette-input');
const paletteList = document.getElementById('palette-list');
let paletteItems = [];
let paletteIndex = 0;

const COMMANDS = [
  { id: 'save', title: () => '💾 ' + t('cmdSave'), run: saveActiveFile },
  { id: 'format', title: () => '✨ ' + t('cmdFormat'), run: () => formatActive() },
  { id: 'newFile', title: () => '📄 ' + t('cmdNewFile'), run: () => state.workspace && createFileIn(state.workspace) },
  { id: 'newFolder', title: () => '📁 ' + t('cmdNewFolder'), run: () => state.workspace && createFolderIn(state.workspace) },
  { id: 'openFolder', title: () => '📂 ' + t('cmdOpenFolder'), run: () => document.getElementById('btn-open-folder').click() },
  { id: 'theme', title: () => '🌓 ' + t('cmdTheme'), run: () => document.getElementById('btn-theme').click() },
  { id: 'lang', title: () => '🌐 ' + t('cmdLang'), run: () => document.getElementById('btn-lang').click() },
  { id: 'newTerm', title: () => '➕ ' + t('cmdNewTerm'), run: () => createTerminalTab() },
  { id: 'preview', title: () => '👁 ' + t('cmdPreview'), run: () => document.getElementById('btn-preview').click() },
  { id: 'newChat', title: () => '✚ ' + t('cmdNewChat'), run: startNewChat },
  { id: 'runApp', title: () => '🚀 ' + t('cmdRunApp'), run: () => { el.chatInput.value = t('qaRunP'); sendMessage(); } },
  { id: 'stopAll', title: () => '🛑 ' + t('cmdStopAll'), run: async () => { for (const id of await window.api.listCommands()) await window.api.killCommand(id); } },
  { id: 'ghost', title: () => '👻 ' + t('cmdGhost'), run: () => toggleGhost() },
  { id: 'learn', title: () => '🎓 ' + t('cmdLearn'), run: () => toggleLearn() },
  { id: 'fos', title: () => '🧹 ' + t('cmdFormatOnSave'), run: () => toggleFormatOnSave() },
  { id: 'git', title: () => '🌿 ' + t('cmdGitPanel'), run: () => switchSideTab('git') },
  { id: 'docs', title: () => '📚 ' + t('cmdDocs'), run: () => { el.chatInput.value = t('qaDocsP'); sendMessage(); } },
  { id: 'settings', title: () => '⚙️ ' + t('settingsTitle').replace('⚙️ ', ''), run: () => openSettings() },
  { id: 'tour', title: () => '🧭 ' + t('cmdTour'), run: () => startTour() },
];

function fuzzyMatch(query, target) {
  const q = query.toLowerCase();
  const s = target.toLowerCase();
  if (s.includes(q)) return 2;
  let qi = 0;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] === q[qi]) qi++;
  }
  return qi === q.length ? 1 : 0;
}

function openPalette(mode) {
  paletteOverlay.style.display = 'flex';
  paletteInput.value = mode === 'commands' ? '>' : '';
  paletteInput.placeholder = t('paletteFilesPh');
  paletteInput.focus();
  updatePaletteList();
}
function closePalette() { paletteOverlay.style.display = 'none'; }

function updatePaletteList() {
  const raw = paletteInput.value;
  const isCmd = raw.startsWith('>');
  const q = (isCmd ? raw.slice(1) : raw).trim();
  paletteItems = [];
  if (isCmd) {
    for (const c of COMMANDS) {
      const title = c.title();
      if (!q || fuzzyMatch(q, title)) paletteItems.push({ label: title, run: c.run });
    }
  } else {
    const scored = [];
    for (const fp of allFiles) {
      const score = q ? fuzzyMatch(q, fp) : 1;
      if (score) scored.push({ fp, score });
    }
    scored.sort((a, b) => b.score - a.score || a.fp.length - b.fp.length);
    for (const { fp } of scored.slice(0, 12)) {
      paletteItems.push({
        label: `${fileIcon(fp)} ${fp}`,
        run: () => {
          const abs = state.workspace + SEP + fp.split('/').join(SEP);
          openFile(abs, fp.split('/').pop());
        },
      });
    }
  }
  paletteIndex = 0;
  paletteList.innerHTML = '';
  paletteItems.slice(0, 14).forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'palette-item' + (i === paletteIndex ? ' sel' : '');
    row.textContent = item.label;
    row.addEventListener('mousedown', (e) => { e.preventDefault(); closePalette(); item.run(); });
    paletteList.appendChild(row);
  });
}

paletteInput.addEventListener('input', updatePaletteList);
paletteInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closePalette(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const nShown = Math.min(paletteItems.length, 14);
    if (!nShown) return;
    paletteIndex = (paletteIndex + (e.key === 'ArrowDown' ? 1 : nShown - 1)) % nShown;
    [...paletteList.children].forEach((c, i) => c.classList.toggle('sel', i === paletteIndex));
    return;
  }
  if (e.key === 'Enter') {
    const item = paletteItems[paletteIndex];
    closePalette();
    if (item) item.run();
  }
});
paletteOverlay.addEventListener('click', (e) => { if (e.target === paletteOverlay) closePalette(); });

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
    e.preventDefault();
    openPalette('commands');
  } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'p') {
    e.preventDefault();
    openPalette('files');
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    // Ctrl+K عام — إلا داخل حقول الدردشة والطرفية والبحث
    const a = document.activeElement;
    const inField = a && (a.id === 'chat-input' || a.id === 'terminal-input' || a.id === 'search-input' ||
      a.id === 'replace-input' || a.id === 'palette-input' || a.id === 'inline-edit-input' ||
      a.id === 'git-commit-msg' || a.id === 'modal-input' || a.id === 'api-key' || a.id === 'preview-url');
    if (!inField && state.activeFile) {
      e.preventDefault();
      openInlineEdit();
    }
  }
}, true);

// ============================================================
//  الاستبدال الشامل
// ============================================================
document.getElementById('btn-replace-all').addEventListener('click', async () => {
  const query = searchInput.value.trim();
  const replacement = document.getElementById('replace-input').value;
  if (!query || !state.workspace) return;
  if (!(await askConfirm(t('replaceConfirm')))) return;
  const r = await window.api.replaceInFiles({ root: state.workspace, query, replacement });
  addAiText(`${t('replaceDone')} ${r.count} ${t('replaceIn')} ${r.files} ${t('filesCount')}.`);
  for (const key of [...state.openFiles.keys()]) await reloadIfOpen(key);
  await runSearch();
  await updateUndoButton();
  await refreshGit();
});

// ============================================================
//  التحرير المباشر بالذكاء (Ctrl+K)
// ============================================================
const inlineEditBox = document.getElementById('inline-edit');
const inlineEditInput = document.getElementById('inline-edit-input');
const inlineEditSpin = document.getElementById('inline-edit-spin');
let inlineBusy = false;

function openInlineEdit() {
  if (!state.activeFile) { addAiText(t('inlineNoFile')); return; }
  inlineEditBox.style.display = 'flex';
  inlineEditInput.value = '';
  inlineEditInput.focus();
}
function closeInlineEdit() {
  inlineEditBox.style.display = 'none';
  inlineEditSpin.style.display = 'none';
  inlineBusy = false;
  if (monacoEditor) monacoEditor.focus();
}

inlineEditInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') { closeInlineEdit(); return; }
  if (e.key !== 'Enter' || inlineBusy) return;
  const instruction = inlineEditInput.value.trim();
  if (!instruction) return;
  inlineBusy = true;
  inlineEditSpin.style.display = 'inline-block';

  const f = state.openFiles.get(state.activeFile);
  const model = f.model;
  const sel = monacoEditor.getSelection();
  const hasSel = sel && !sel.isEmpty();
  const target = hasSel ? model.getValueInRange(sel) : model.getValue();
  const fileContent = model.getValue().slice(0, 30000);
  const lang = langFromPath(state.activeFile);

  try {
    const r = await callOnce({
      apiKey: keyForModel(state.model),
      model: state.model,
      maxTokens: 8000,
      system: 'أنت محرر كود دقيق. يعطيك المستخدم كودًا وتعليمات تعديل. أعد فقط الكود البديل كاملًا داخل كتلة كود واحدة، دون أي شرح قبلها أو بعدها.',
      messages: [{
        role: 'user',
        content: `الملف: ${state.activeFile}\nاللغة: ${lang}\n\nمحتوى الملف كاملًا (للسياق):\n\`\`\`\n${fileContent}\n\`\`\`\n\n${hasSel ? `الجزء المطلوب تعديله فقط:\n\`\`\`\n${target}\n\`\`\`` : 'المطلوب تعديل الملف كاملًا.'}\n\nالتعليمات: ${instruction}\n\nأعد ${hasSel ? 'الجزء البديل فقط' : 'الملف كاملًا بعد التعديل'} داخل كتلة كود واحدة.`,
      }],
    });
    trackUsage(r.usage, r.model);
    let code = r.text.trim();
    const m = code.match(/```[\w]*\n?([\s\S]*?)```/);
    if (m) code = m[1].replace(/\n$/, '');
    closeInlineEdit();
    // عرض الفرق مع أزرار قبول/رفض
    showDiff(state.activeFile, target, code, () => {
      if (hasSel) {
        monacoEditor.executeEdits('satr-inline', [{ range: sel, text: code }]);
      } else {
        model.setValue(code);
      }
    });
  } catch (err) {
    closeInlineEdit();
    addAiText(t('errorPrefix') + String(err.message || err));
  }
});

// ============================================================
//  الإكمال الذكي أثناء الكتابة (Ghost Text — Haiku)
// ============================================================
function setupGhostProvider() {
  monaco.languages.registerInlineCompletionsProvider({ pattern: '**' }, {
    async provideInlineCompletions(model, position, _context, token) {
      if (!state.ghost || !state.apiKey || state.running) return { items: [] };
      await new Promise((r) => setTimeout(r, 600));
      if (token.isCancellationRequested) return { items: [] };
      const before = model.getValueInRange({
        startLineNumber: Math.max(1, position.lineNumber - 40), startColumn: 1,
        endLineNumber: position.lineNumber, endColumn: position.column,
      });
      const endLine = Math.min(model.getLineCount(), position.lineNumber + 10);
      const after = model.getValueInRange({
        startLineNumber: position.lineNumber, startColumn: position.column,
        endLineNumber: endLine, endColumn: model.getLineMaxColumn(endLine),
      });
      try {
        const r = await callOnce({
          apiKey: state.apiKey,
          model: 'claude-haiku-4-5',
          maxTokens: 160,
          system: 'أنت محرك إكمال كود. أعد فقط النص الذي يُدرج مكان <CURSOR> لإكمال الكود بشكل طبيعي. بلا شرح، بلا كتل كود، بلا تكرار لما قبل المؤشر. إن لم يكن هناك إكمال منطقي أعد نصًا فارغًا.',
          messages: [{ role: 'user', content: `اللغة: ${model.getLanguageId()}\n${before}<CURSOR>${after}` }],
        });
        trackUsage(r.usage, r.model);
        if (token.isCancellationRequested) return { items: [] };
        let text = r.text.replace(/^```[\w]*\n?/, '').replace(/\n?```\s*$/, '');
        if (!text.trim()) return { items: [] };
        return { items: [{ insertText: text }] };
      } catch {
        return { items: [] };
      }
    },
    freeInlineCompletions() {},
  });
}

function toggleGhost() {
  state.ghost = !state.ghost;
  window.api.setConfig({ ghost: state.ghost });
  updateGhostBtn();
  addAiText(state.ghost ? t('ghostOn') : t('ghostOff'));
}
function updateGhostBtn() {
  document.getElementById('btn-ghost').classList.toggle('toggled-on', state.ghost);
}
document.getElementById('btn-ghost').addEventListener('click', toggleGhost);

function toggleLearn() {
  state.learnMode = !state.learnMode;
  window.api.setConfig({ learnMode: state.learnMode });
  updateLearnBtn();
  addAiText(state.learnMode ? t('learnOn') : t('learnOff'));
}
function updateLearnBtn() {
  document.getElementById('btn-learn').classList.toggle('toggled-on', state.learnMode);
}
document.getElementById('btn-learn').addEventListener('click', toggleLearn);

function toggleFormatOnSave() {
  state.formatOnSave = !state.formatOnSave;
  window.api.setConfig({ formatOnSave: state.formatOnSave });
  addAiText(state.formatOnSave ? t('formatOnSaveOn') : t('formatOnSaveOff'));
}

// ============================================================
//  Prettier: تنسيق عند الحفظ
// ============================================================
let prettierMod = null;
async function loadPrettier() {
  if (prettierMod) return prettierMod;
  const [core, babel, estree, html, postcss, ts, md] = await Promise.all([
    import('./node_modules/prettier/standalone.mjs'),
    import('./node_modules/prettier/plugins/babel.mjs'),
    import('./node_modules/prettier/plugins/estree.mjs'),
    import('./node_modules/prettier/plugins/html.mjs'),
    import('./node_modules/prettier/plugins/postcss.mjs'),
    import('./node_modules/prettier/plugins/typescript.mjs'),
    import('./node_modules/prettier/plugins/markdown.mjs'),
  ]);
  prettierMod = {
    prettier: core.default || core,
    plugins: [babel, estree, html, postcss, ts, md].map((m) => m.default || m),
  };
  return prettierMod;
}

const PRETTIER_PARSER = {
  js: 'babel', mjs: 'babel', cjs: 'babel', jsx: 'babel',
  ts: 'typescript', tsx: 'typescript', json: 'json',
  css: 'css', scss: 'scss', less: 'less', html: 'html', vue: 'html', md: 'markdown',
};

async function formatActive() {
  if (!state.activeFile) return false;
  const f = state.openFiles.get(state.activeFile);
  if (!f) return false;
  const ext = state.activeFile.split('.').pop().toLowerCase();
  const parser = PRETTIER_PARSER[ext];
  if (!parser) return false;
  try {
    const { prettier, plugins } = await loadPrettier();
    const src = f.model.getValue();
    const out = await prettier.format(src, { parser, plugins, tabWidth: 2, printWidth: 100 });
    if (out !== src) {
      const pos = monacoEditor ? monacoEditor.getPosition() : null;
      f.model.setValue(out);
      if (pos && monacoEditor) monacoEditor.setPosition(pos);
    }
    return true;
  } catch {
    return false; // كود فيه خطأ صياغي — نحفظ دون تنسيق
  }
}

// ============================================================
//  شرح الأخطاء بالعربية + الإدخال الصوتي
// ============================================================
const explainBtn = document.createElement('button');
explainBtn.className = 'fix-error-btn explain-btn';
explainBtn.style.display = 'none';
document.querySelector('.terminal-panel').appendChild(explainBtn);

explainBtn.addEventListener('click', async () => {
  if (!lastFailure || !state.apiKey) return;
  explainBtn.disabled = true;
  showThinking(true);
  try {
    const r = await callOnce({
      apiKey: state.apiKey,
      model: 'claude-haiku-4-5',
      maxTokens: 1000,
      system: state.lang === 'ar'
        ? 'أنت خبير يشرح أخطاء البرمجة للمبتدئين بالعربية. اشرح سبب الخطأ ببساطة في سطرين إلى أربعة، ثم اقترح الحل خطوة بخطوة بإيجاز.'
        : 'You explain programming errors to beginners. Explain the cause simply in 2-4 lines, then suggest the fix briefly step by step.',
      messages: [{ role: 'user', content: `$ ${lastFailure.cmd}\n\n${lastFailure.output.slice(-3000)}` }],
    });
    trackUsage(r.usage, r.model);
    addAiText('🔍 ' + r.text);
  } catch (err) {
    addAiText(t('errorPrefix') + String(err.message || err));
  }
  showThinking(false);
  explainBtn.disabled = false;
});

// الإدخال الصوتي — تسجيل بالمايك ثم تحويل عبر Whisper على Groq (مجاني بدون بطاقة)
// (SpeechRecognition الخاصة بكروم لا تعمل داخل Electron، وكتابة ويندوز الصوتية لا تدعم العربية)
let mediaRecorder = null;
let recChunks = [];
let recording = false;
const micBtn = document.getElementById('btn-mic');
const MIC_TITLE = micBtn.title;

async function promptGroqKey() {
  const key = await askString(t('voiceKeyPrompt'), state.groqKey || '');
  if (!key) return false;
  state.groqKey = key;
  await window.api.setConfig({ groqKey: key });
  return true;
}

async function transcribeAudio(blob) {
  const fd = new FormData();
  fd.append('file', blob, 'speech.webm');
  fd.append('model', 'whisper-large-v3');
  fd.append('language', state.lang === 'ar' ? 'ar' : 'en');
  fd.append('response_format', 'json');
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + state.groqKey },
    body: fd,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(res.status + ' ' + body.slice(0, 200));
  }
  const data = await res.json();
  return (data.text || '').trim();
}

micBtn.addEventListener('click', async () => {
  if (recording) {
    try { mediaRecorder.stop(); } catch {}
    return;
  }
  if (!state.groqKey) {
    addAiText(t('voiceHint'));
    const ok = await promptGroqKey();
    if (!ok) return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    addAiText(t('voiceErr') + String(err?.message || err));
    return;
  }
  recChunks = [];
  mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
  mediaRecorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  mediaRecorder.onstop = async () => {
    stream.getTracks().forEach((tr) => tr.stop());
    recording = false;
    micBtn.classList.remove('recording');
    const blob = new Blob(recChunks, { type: 'audio/webm' });
    recChunks = [];
    if (blob.size < 1000) { micBtn.title = MIC_TITLE; return; } // تسجيل فارغ
    micBtn.disabled = true;
    micBtn.title = t('voiceTranscribing');
    try {
      const text = await transcribeAudio(blob);
      if (text) {
        el.chatInput.value += (el.chatInput.value ? ' ' : '') + text;
        el.chatInput.focus();
      }
    } catch (err) {
      addAiText(t('voiceErr') + String(err?.message || err));
    }
    micBtn.disabled = false;
    micBtn.title = MIC_TITLE;
  };
  mediaRecorder.start();
  recording = true;
  micBtn.classList.add('recording');
  micBtn.title = t('voiceListening');
});

// ============================================================
//  الجولة التعريفية
// ============================================================
const TOUR_STEPS = [
  { sel: '.chat', title: 'tourChatT', text: 'tourChatX' },
  { sel: '#model-select', title: 'tourModelT', text: 'tourModelX' },
  { sel: '#btn-actions', title: 'tourActionsT', text: 'tourActionsX' },
  { sel: '.side-tabs', title: 'tourSideT', text: 'tourSideX' },
  { sel: '.terminal-panel', title: 'tourTermT', text: 'tourTermX' },
  { sel: '#btn-learn', title: 'tourLearnT', text: 'tourLearnX' },
  { sel: '#btn-undo', title: 'tourUndoT', text: 'tourUndoX', optional: true },
];
let tourIdx = 0;
const tourOverlay = document.getElementById('tour-overlay');

function positionTourBox(target) {
  const box = document.getElementById('tour-box');
  const spot = document.getElementById('tour-spot');
  const r = target ? target.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0, bottom: innerHeight / 2 };
  // مستطيل الكشّاف حول العنصر المستهدف (بهامش بسيط)
  const pad = 5;
  spot.style.left = (r.left - pad) + 'px';
  spot.style.top = (r.top - pad) + 'px';
  spot.style.width = (r.width + pad * 2) + 'px';
  spot.style.height = (r.height + pad * 2) + 'px';
  const bw = 330;
  let x = Math.min(Math.max(10, r.left + r.width / 2 - bw / 2), innerWidth - bw - 10);
  let y = r.bottom + 14;
  if (y + 190 > innerHeight) y = Math.max(10, r.top - 200);
  box.style.left = x + 'px';
  box.style.top = y + 'px';
}

function showTourStep() {
  const steps = TOUR_STEPS.filter((s) => !s.optional || document.querySelector(s.sel)?.offsetParent);
  if (tourIdx >= steps.length) { endTour(); return; }
  const step = steps[tourIdx];
  const target = document.querySelector(step.sel);
  document.getElementById('tour-title').textContent = t(step.title);
  document.getElementById('tour-text').textContent = t(step.text);
  document.getElementById('tour-step').textContent = `${tourIdx + 1} / ${steps.length}`;
  document.getElementById('tour-next').textContent = tourIdx === steps.length - 1 ? t('tourDone') : t('tourNext');
  positionTourBox(target);
}

function startTour() {
  tourIdx = 0;
  tourOverlay.style.display = 'block';
  showTourStep();
}
function endTour() {
  tourOverlay.style.display = 'none';
  window.api.setConfig({ seenTour: true });
}
document.getElementById('tour-next').addEventListener('click', () => { tourIdx++; showTourStep(); });
document.getElementById('tour-skip').addEventListener('click', endTour);

// إشعار التحديث الجاهز
window.api.onUpdateReady(() => addAiText(t('updateReady')));

// ============================================================
//  الإقلاع
// ============================================================
boot();
