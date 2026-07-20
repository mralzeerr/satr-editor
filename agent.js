// ============================================================
//  وكيل الذكاء الاصطناعي — Claude Fable 5
//  يبني التطبيقات، يعدّل الملفات، يشغّل الأوامر، ويصلح الأخطاء
//  ذاتيًا في حلقة متكررة.
// ============================================================

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
// نقطة Moonshot المتوافقة مع صيغة Anthropic — نفس شكل الطلبات والردود والأدوات
const MOONSHOT_URL = 'https://api.moonshot.ai/anthropic/v1/messages';
const FALLBACK_MODEL = 'claude-opus-4-8';

// الموديلات المتاحة للاختيار — الأسعار بالدولار لكل مليون توكن (إدخال/إخراج)
export const MODELS = [
  { id: 'claude-fable-5',   label: 'Fable 5',   in: 10, out: 50 },
  { id: 'claude-opus-4-8',  label: 'Opus 4.8',  in: 5,  out: 25 },
  { id: 'claude-sonnet-5',  label: 'Sonnet 5',  in: 3,  out: 15 },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', in: 1,  out: 5 },
  { id: 'kimi-k3',          label: 'Kimi K3',   in: 3,  out: 15, provider: 'moonshot' },
];
export const DEFAULT_MODEL = 'claude-fable-5';

export function providerOf(model) {
  return MODELS.find((m) => m.id === model)?.provider || 'anthropic';
}
const apiUrlFor = (model) => (providerOf(model) === 'moonshot' ? MOONSHOT_URL : ANTHROPIC_URL);

// أدوات الوكيل — يقرأها Claude ويقرر متى يستخدمها
const TOOLS = [
  {
    name: 'read_file',
    description: 'اقرأ محتوى ملف من مساحة العمل. استخدمه قبل تعديل أي ملف لمعرفة محتواه الحالي.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'المسار الكامل للملف' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'أنشئ ملفًا جديدًا أو استبدل محتوى ملف موجود بالكامل. ينشئ المجلدات الأب تلقائيًا.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'المسار الكامل للملف' },
        content: { type: 'string', description: 'المحتوى الكامل للملف' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_dir',
    description: 'اعرض قائمة الملفات والمجلدات داخل مسار معيّن.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'مسار المجلد' } },
      required: ['path'],
    },
  },
  {
    name: 'edit_file',
    description: 'عدّل جزءًا من ملف موجود: استبدل نصًا محددًا بنص جديد دون إعادة كتابة الملف كاملًا. يجب أن يطابق old_text محتوى الملف حرفيًا (بما في ذلك المسافات) وأن يظهر مرة واحدة فقط، أو استخدم replace_all لاستبدال كل التكرارات. فضّله على write_file عند تعديل ملفات كبيرة.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'المسار الكامل للملف' },
        old_text: { type: 'string', description: 'النص الحالي المطلوب استبداله (مطابقة حرفية)' },
        new_text: { type: 'string', description: 'النص الجديد' },
        replace_all: { type: 'boolean', description: 'استبدال كل التكرارات (افتراضيًا: false ويجب أن يكون النص فريدًا)' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'run_command',
    description: 'شغّل أمرًا في الطرفية (PowerShell على ويندوز) داخل مجلد المشروع. استخدمه لتثبيت الحزم، تشغيل البناء، أو تشغيل الاختبارات. النتيجة (stdout+stderr) تُعاد إليك لتقرأ الأخطاء وتصلحها. للعمليات الطويلة التي لا تنتهي (مثل خوادم التطوير npm run dev / npm start) مرّر background=true حتى لا تنتظر انتهاءها — ستحصل على المخرجات الأولية ومعرّف العملية.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'الأمر المطلوب تنفيذه' },
        background: { type: 'boolean', description: 'true للعمليات المستمرة (خوادم التطوير) — يعيد المخرجات الأولية ويترك العملية تعمل' },
      },
      required: ['command'],
    },
  },
  {
    name: 'kill_process',
    description: 'أوقف عملية تعمل في الخلفية بمعرّفها (الذي أعاده run_command).',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'معرّف العملية' } },
      required: ['id'],
    },
  },
  {
    name: 'delete_path',
    description: 'احذف ملفًا أو مجلدًا.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'المسار المطلوب حذفه' } },
      required: ['path'],
    },
  },
];

function systemPrompt(workspace, extras = {}) {
  const sections = [];
  if (extras.projectIndex) {
    sections.push(`خريطة ملفات المشروع (استخدمها لتعرف البنية دون استكشاف متكرر):\n${extras.projectIndex}`);
  }
  if (extras.rules) {
    sections.push(`تعليمات المستخدم الدائمة لهذا المشروع (من ملف satr.md — التزم بها دائمًا):\n${extras.rules}`);
  }
  if (extras.learningMode) {
    sections.push(`وضع التعلّم مفعّل: المستخدم يتعلم البرمجة. اشرح بالعربية المبسطة قبل كل خطوة ماذا ستفعل ولماذا، وبعد كل ملف تنشئه لخّص فكرته التقنية في سطرين كدرس صغير. اجعل الشرح ممتعًا وتدريجيًا دون إطالة مملة.`);
  }
  return `أنت وكيل برمجي خبير مدمج داخل محرر أكواد اسمه "سطر (Satr)". تعمل بشكل مستقل لبناء التطبيقات وإصلاح الأخطاء دون أن يكتب المستخدم أي كود.

مجلد العمل الحالي: ${workspace || '(لم يُفتح مجلد بعد)'}
${sections.length ? '\n' + sections.join('\n\n') + '\n' : ''}

مبادئ العمل:
- عندما يطلب المستخدم بناء شيء، خطّط ثم نفّذ مباشرة باستخدام الأدوات. لا تكتفِ بالشرح.
- استخدم write_file لإنشاء الملفات الجديدة، و edit_file للتعديلات الجزئية على الملفات الموجودة (أوفر وأدق من إعادة كتابة الملف كاملًا).
- استخدم run_command لتثبيت الحزم وتشغيل المشاريع. للخوادم المستمرة (npm run dev ونحوها) مرّر background=true حتى لا تعلق في الانتظار، وأوقفها لاحقًا بـ kill_process إن لزم.
- بعد أي أمر، اقرأ النتيجة. إن ظهر خطأ، أصلحه بنفسك وأعد المحاولة حتى ينجح — لا تتوقف وتسأل المستخدم عن أخطاء يمكنك إصلاحها.
- اكتب كودًا نظيفًا وحديثًا. للواجهات: صمّم واجهات جميلة وعصرية بألوان متناسقة، لا تصاميم عامة مملة.
- استخدم المسارات الكاملة داخل مجلد العمل عند استدعاء الأدوات.
- تكلّم مع المستخدم بالعربية بإيجاز: اذكر ما فعلته والنتيجة، دون إطالة.
- عند الانتهاء، لخّص ما أنجزته في جملة أو جملتين، ووضّح كيف يشغّل المستخدم التطبيق.

اعمل بشكل استباقي وأكمل المهمة كاملة قبل أن تنهي دورك.`;
}

// تنفيذ أداة عبر جسر IPC
async function execTool(name, input, ctx) {
  const ws = ctx.workspace || '';
  try {
    switch (name) {
      case 'read_file': {
        const r = await window.api.readFile(input.path);
        return r.ok ? r.content : `خطأ في القراءة: ${r.error}`;
      }
      case 'write_file': {
        const prev = await window.api.readFile(input.path);
        await window.api.ckptRecord(input.path);
        const r = await window.api.writeFile(input.path, input.content);
        if (r.ok) {
          ctx.onFileChanged?.(input.path);
          ctx.onEdit?.({ path: input.path, before: prev.ok ? prev.content : '', after: input.content });
          return `تم حفظ الملف: ${input.path}`;
        }
        return `خطأ في الكتابة: ${r.error}`;
      }
      case 'edit_file': {
        const read = await window.api.readFile(input.path);
        if (!read.ok) return `خطأ في القراءة: ${read.error}`;
        const { old_text: oldText, new_text: newText, replace_all: replaceAll } = input;
        if (!oldText) return 'خطأ: old_text فارغ.';
        const parts = read.content.split(oldText);
        const count = parts.length - 1;
        if (count === 0) return 'خطأ: النص المطلوب استبداله غير موجود في الملف. اقرأ الملف وتأكد من المطابقة الحرفية.';
        if (count > 1 && !replaceAll) return `خطأ: النص يظهر ${count} مرات. وسّع old_text ليكون فريدًا أو مرّر replace_all=true.`;
        const updated = replaceAll
          ? parts.join(newText)
          : read.content.replace(oldText, newText);
        await window.api.ckptRecord(input.path);
        const w = await window.api.writeFile(input.path, updated);
        if (w.ok) {
          ctx.onFileChanged?.(input.path);
          ctx.onEdit?.({ path: input.path, before: read.content, after: updated });
          return `تم التعديل (${count} ${count === 1 ? 'موضع' : 'مواضع'}): ${input.path}`;
        }
        return `خطأ في الكتابة: ${w.error}`;
      }
      case 'list_dir': {
        const items = await window.api.readDir(input.path);
        if (!items || !items.length) return '(المجلد فارغ أو غير موجود)';
        return items.map((i) => `${i.type === 'dir' ? '📁' : '📄'} ${i.name}`).join('\n');
      }
      case 'run_command': {
        const id = 'agent-' + Date.now();
        ctx.onCommand?.(input.command, id);
        // للأوامر العادية مهلة 120 ثانية ثم تتحول تلقائيًا لعملية خلفية،
        // ولطلبات background نلتقط المخرجات الأولية فقط (4 ثوانٍ).
        const timeoutMs = input.background ? 4000 : 120000;
        const r = await window.api.runCommand({ id, command: input.command, cwd: ws, timeoutMs });
        const out = (r.output || '').trim() || '(لا مخرجات)';
        if (r.running) {
          return `[العملية لا تزال تعمل في الخلفية — المعرّف: ${id}. مخرجاتها تظهر في الطرفية، ويمكن إيقافها بـ kill_process]\n${out}`;
        }
        return `[كود الخروج: ${r.code ?? 'غير معروف'}]\n${out}`;
      }
      case 'kill_process': {
        const killed = await window.api.killCommand(input.id);
        return killed ? `تم إيقاف العملية: ${input.id}` : `لا توجد عملية جارية بهذا المعرّف: ${input.id}`;
      }
      case 'delete_path': {
        await window.api.ckptRecord(input.path);
        const r = await window.api.deletePath(input.path);
        ctx.onFileChanged?.(input.path);
        return r.ok ? `تم الحذف: ${input.path}` : `خطأ في الحذف: ${r.error}`;
      }
      default:
        return `أداة غير معروفة: ${name}`;
    }
  } catch (err) {
    return `فشل تنفيذ الأداة: ${String(err)}`;
  }
}

const API_HEADERS = (apiKey, model) =>
  providerOf(model) === 'moonshot'
    ? {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        Authorization: 'Bearer ' + apiKey,
        'anthropic-version': '2023-06-01',
      }
    : {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'server-side-fallback-2026-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      };

async function throwApiError(res) {
  let detail = '';
  try {
    const j = await res.json();
    detail = j?.error?.message || JSON.stringify(j);
  } catch {
    detail = await res.text();
  }
  throw new Error(`HTTP ${res.status}: ${detail}`);
}

async function callAnthropic(apiKey, body, signal) {
  const res = await fetch(apiUrlFor(body.model), {
    method: 'POST',
    headers: API_HEADERS(apiKey, body.model),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) await throwApiError(res);
  return res.json();
}

// استدعاء واحد غير متدفق — للميزات الخفيفة (Ctrl+K، شرح الأخطاء، Ghost Text)
export async function callOnce({ apiKey, model, system, messages, maxTokens = 2048, signal, stopSequences }) {
  const body = { model, max_tokens: maxTokens, messages };
  if (system) body.system = system;
  if (stopSequences) body.stop_sequences = stopSequences;
  const data = await callAnthropic(apiKey, body, signal);
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text, usage: data.usage, model: data.model, stop_reason: data.stop_reason };
}

// استدعاء متدفق (SSE): يبني الرسالة كاملة ويبث نص كل كتلة أولًا بأول
async function callAnthropicStream(apiKey, body, { signal, onTextDelta } = {}) {
  const res = await fetch(apiUrlFor(body.model), {
    method: 'POST',
    headers: API_HEADERS(apiKey, body.model),
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });
  if (!res.ok) await throwApiError(res);

  const message = { content: [], stop_reason: null, usage: {}, model: '' };
  let curBlock = null;
  let curJson = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      switch (ev.type) {
        case 'message_start':
          message.model = ev.message?.model || '';
          Object.assign(message.usage, ev.message?.usage || {});
          break;
        case 'content_block_start':
          curBlock = { ...ev.content_block };
          curJson = '';
          if (curBlock.type === 'tool_use') curBlock.input = {};
          if (curBlock.type === 'text') curBlock.text = curBlock.text || '';
          if (curBlock.type === 'thinking') {
            curBlock.thinking = curBlock.thinking || '';
            curBlock.signature = curBlock.signature || '';
          }
          message.content.push(curBlock);
          break;
        case 'content_block_delta':
          if (!curBlock) break;
          if (ev.delta.type === 'text_delta') {
            curBlock.text += ev.delta.text;
            onTextDelta?.(ev.delta.text, curBlock.text);
          } else if (ev.delta.type === 'input_json_delta') {
            curJson += ev.delta.partial_json;
          } else if (ev.delta.type === 'thinking_delta') {
            curBlock.thinking += ev.delta.thinking;
          } else if (ev.delta.type === 'signature_delta') {
            curBlock.signature = (curBlock.signature || '') + ev.delta.signature;
          }
          break;
        case 'content_block_stop':
          if (curBlock && curBlock.type === 'tool_use') {
            try { curBlock.input = curJson ? JSON.parse(curJson) : {}; } catch { curBlock.input = {}; }
          }
          curBlock = null;
          break;
        case 'message_delta':
          if (ev.delta?.stop_reason) message.stop_reason = ev.delta.stop_reason;
          Object.assign(message.usage, ev.usage || {});
          break;
        case 'error':
          throw new Error(ev.error?.message || 'stream error');
      }
    }
  }
  return message;
}

// كاش الموجه (Prompt Caching): النظام والأدوات ثابتة عبر الطلبات،
// ونحرّك نقطة كاش إضافية مع آخر رسالة حتى يُقرأ سجل المحادثة من الكاش
// بدل إعادة معالجته كاملًا في كل خطوة — توفير كبير في التكلفة.
function applyIncrementalCache(messages) {
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const b of m.content) delete b.cache_control;
    }
  }
  const last = messages[messages.length - 1];
  if (last && Array.isArray(last.content) && last.content.length) {
    // لا يجوز وضع cache_control على بلوكات التفكير — نختار آخر بلوك غير تفكير
    for (let i = last.content.length - 1; i >= 0; i--) {
      const b = last.content[i];
      if (b.type !== 'thinking' && b.type !== 'redacted_thinking') {
        b.cache_control = { type: 'ephemeral' };
        break;
      }
    }
  }
}

// إزالة بلوكات التفكير الفاسدة (فارغة أو بلا توقيع) من سجلات محفوظة بإصدارات قديمة
function sanitizeHistory(history) {
  return history.map((m) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return m;
    const content = m.content.filter(
      (b) => !(b.type === 'thinking' && (!b.thinking || !b.signature))
    );
    return content.length === m.content.length ? m : { ...m, content };
  }).filter((m) => !Array.isArray(m.content) || m.content.length > 0);
}

const CACHED_TOOLS = TOOLS.map((tool, i) =>
  i === TOOLS.length - 1 ? { ...tool, cache_control: { type: 'ephemeral' } } : tool
);

// الحلقة الرئيسية للوكيل
export async function runAgent({ apiKey, model, workspace, history, callbacks, signal, extras }) {
  const messages = sanitizeHistory(history);
  const selectedModel = model || DEFAULT_MODEL;
  let iterations = 0;
  const MAX = 60;

  while (iterations < MAX) {
    iterations++;

    applyIncrementalCache(messages);
    const body = {
      model: selectedModel,
      max_tokens: 16000,
      system: [{ type: 'text', text: systemPrompt(workspace, extras), cache_control: { type: 'ephemeral' } }],
      tools: CACHED_TOOLS,
      messages,
    };
    // احتياطي الرفض الأمني متاح لـ Fable 5 فقط (الموديل الاحتياطي المدعوم: Opus 4.8)
    if (selectedModel === 'claude-fable-5') {
      body.fallbacks = [{ model: FALLBACK_MODEL }];
    }

    let data;
    try {
      data = await callAnthropicStream(apiKey, body, {
        signal,
        onTextDelta: (delta, fullText) => callbacks.onTextDelta?.(delta, fullText),
      });
    } catch (err) {
      if (err.name === 'AbortError' || signal?.aborted) {
        callbacks.onAborted?.();
        return { messages, aborted: true };
      }
      callbacks.onError?.(String(err.message || err));
      return { messages, error: true };
    }

    // معالجة الرفض الأمني
    if (data.stop_reason === 'refusal') {
      callbacks.onText?.('⚠️ رفض النموذج تنفيذ هذا الطلب لأسباب تتعلق بسياسة الاستخدام.');
      return { messages, refused: true };
    }

    // إضافة رد المساعد للسجل
    messages.push({ role: 'assistant', content: data.content });

    // إنهاء عرض النصوص المتدفقة وجمع استدعاءات الأدوات
    const toolUses = [];
    for (const block of data.content) {
      if (block.type === 'text' && block.text.trim()) {
        callbacks.onTextDone?.(block.text);
      } else if (block.type === 'tool_use') {
        toolUses.push(block);
      }
    }

    // لا أدوات → انتهى الدور
    if (data.stop_reason !== 'tool_use' || toolUses.length === 0) {
      callbacks.onUsage?.(data.usage, data.model);
      return { messages, done: true };
    }

    // تنفيذ الأدوات وإعادة النتائج
    const toolResults = [];
    for (const tu of toolUses) {
      if (signal?.aborted) { callbacks.onAborted?.(); return { messages, aborted: true }; }
      callbacks.onToolUse?.(tu.name, tu.input);
      const result = await execTool(tu.name, tu.input, {
        workspace,
        onFileChanged: callbacks.onFileChanged,
        onCommand: callbacks.onCommand,
        onEdit: callbacks.onEdit,
      });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: result,
      });
    }

    messages.push({ role: 'user', content: toolResults });
    callbacks.onUsage?.(data.usage, data.model);
    if (signal?.aborted) { callbacks.onAborted?.(); return { messages, aborted: true }; }
  }

  callbacks.onText?.('⏸️ توقفت بعد الوصول للحد الأقصى من الخطوات. اكتب "أكمل" للمتابعة.');
  return { messages, maxed: true };
}

// اختبار صحة مفتاح API
export async function testApiKey(apiKey) {
  try {
    await callAnthropic(apiKey, {
      model: FALLBACK_MODEL,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'مرحبا' }],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}
