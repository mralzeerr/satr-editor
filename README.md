<div align="center">

<img src="assets/logo.svg" width="110" alt="شعار سطر — Satr logo">

# سطر (Satr)

**أول وكيل برمجي عربي — تكتب أو تتكلم بالعربية، وهو يبني التطبيق كاملًا ويصلح أخطاءه بنفسه.**

*The first Arabic-native AI coding agent — describe your app in Arabic (or English), and it builds, runs, and self-fixes the whole thing.*

[![أحدث إصدار](https://img.shields.io/github/v/release/mralzeerr/satr-editor?label=%D8%A3%D8%AD%D8%AF%D8%AB%20%D8%A5%D8%B5%D8%AF%D8%A7%D8%B1&color=7c8cff)](https://github.com/mralzeerr/satr-editor/releases/latest)
[![التحميلات](https://img.shields.io/github/downloads/mralzeerr/satr-editor/total?label=%D8%AA%D8%AD%D9%85%D9%8A%D9%84%D8%A7%D8%AA&color=c792ea)](https://github.com/mralzeerr/satr-editor/releases)
[![الرخصة](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[⬇️ تحميل لويندوز](https://github.com/mralzeerr/satr-editor/releases/latest) · [🌐 الموقع](https://mralzeerr.github.io/satr-editor/) · [🐞 أبلغ عن مشكلة](https://github.com/mralzeerr/satr-editor/issues/new)

</div>

---

## 🇸🇦 بالعربية

### ما هو سطر؟

سطر ليس محرر أكواد يقترح عليك أسطرًا — بل **وكيل** يبني تطبيقك من الفكرة إلى التشغيل: ينشئ الملفات، يشغّل الأوامر في الطرفية، يفتح معاينة حية، وإذا ظهر خطأ **يقرأه ويصلحه بنفسه** ثم يكمل. كل ذلك بواجهة عربية RTL حقيقية صُممت عربية من أول سطر، لا ترجمة لاحقة.

> يكفي سطر واحد منك — والوكيل يكتب آلاف الأسطر.

### المزايا

| | |
|---|---|
| 🤖 **وكيل ذاتي الإصلاح** | ينشئ ويعدّل ويشغّل، ويقرأ أخطاء الطرفية ويعالجها بنفسه حتى يعمل التطبيق |
| 🎙️ **إدخال صوتي بلهجتك** | قل «أبغى متجرًا إلكترونيًا» بلهجتك الخليجية — يفهمك (Whisper عبر Groq) |
| 🎓 **وضع التعلّم** | يشرح لك كل خطوة بالعربية كأنه معلم — تعلّم البرمجة بلا حاجز اللغة |
| 🖥️ **معاينة حية + طرفية حقيقية** | xterm بتبويبات متعددة وعمليات خلفية، ومعاينة تفتح تلقائيًا |
| 🧰 **قوالب عربية جاهزة** | ابدأ مشروعك من قوالب RTL بذوق عربي أصيل |
| 🔀 **تكامل Git كامل** | حالة، فروقات، إيداعات — من داخل التطبيق |
| ⏪ **نقاط استرجاع** | لقطة قبل كل مهمة، وتراجع بضغطة واحدة |
| 🧠 **تعدد النماذج** | Claude (Anthropic) وKimi (Moonshot) — ومفاتيحك مشفرة على جهازك |
| 🎁 **موديلات مجانية** | جرّب المحرر بلا بطاقة بنكية عبر مفتاح [OpenRouter](https://openrouter.ai/keys) مجاني |
| ⬆️ **تحديث تلقائي** | كل إصدار جديد يصلك ويثبّت نفسه بلا تدخل |

### التحميل والبدء

1. حمّل [أحدث إصدار](https://github.com/mralzeerr/satr-editor/releases/latest): `Satr-Setup-x.x.x.exe` (مثبّت) أو `Satr-x.x.x-portable.exe` (محمول).
2. عند أول تشغيل أدخل مفتاح [Anthropic API](https://console.anthropic.com) — أو ابدأ **مجانًا** بمفتاح [OpenRouter](https://openrouter.ai/keys) (تسجيل بلا بطاقة). المفاتيح تُحفظ **مشفرة على جهازك** ولا تغادره.
3. افتح مجلدًا أو اختر قالبًا، واطلب بالعربية. انتهى.

> **⚠️ تحذير SmartScreen؟** طبيعي ومؤقت — الإصدارات الحالية غير موقّعة رقميًا بعد (الشهادة قيد الإجراء). اضغط **More info** ثم **Run anyway**. الكود كله مفتوح أمامك في هذا المستودع.

### التشغيل من المصدر

```bash
git clone https://github.com/mralzeerr/satr-editor.git
cd satr-editor
npm install
npm start        # تشغيل التطبيق
npm run dist     # بناء المثبّت والنسخة المحمولة
```

### المساهمة

المشروع مفتوح المصدر برخصة MIT — البلاغات والاقتراحات عبر [Issues](https://github.com/mralzeerr/satr-editor/issues)، والمساهمات البرمجية عبر Pull Requests مرحّب بها.

---

## 🇬🇧 English

### What is Satr?

**Satr** (Arabic for *"a line"* — as in a line of code) is the first Arabic-native AI coding agent. It's not an autocomplete editor: it's an **agent** that takes your idea to a running app — creating files, executing terminal commands, opening a live preview, and when something breaks it **reads the error and fixes it itself**, then keeps going. Built RTL-first with a true Arabic UI (English UI included), not a retrofit translation.

> One line from you — thousands of lines from the agent.

### Features

- 🤖 **Self-healing agent** — creates, edits, runs, reads terminal errors and fixes them until your app works
- 🎙️ **Voice input in Arabic dialects** — powered by Whisper (Groq); Gulf dialects understood
- 🎓 **Learning mode** — explains every step in Arabic like a teacher; learn to code without the language barrier
- 🖥️ **Live preview + real terminal** — multi-tab xterm with background processes
- 🧰 **Authentic Arabic RTL templates** — not translated foreign ones
- 🔀 **Full Git integration**, ⏪ **checkpoints with one-click rollback**
- 🧠 **Multi-model** — Claude (Anthropic) & Kimi (Moonshot); your API keys stay encrypted on your machine
- 🎁 **Free models** — try the editor with no credit card via a free [OpenRouter](https://openrouter.ai/keys) key
- ⬆️ **Auto-updates** on every release

### Getting started

1. Download the [latest release](https://github.com/mralzeerr/satr-editor/releases/latest) — installer or portable.
2. On first run, enter your [Anthropic API key](https://console.anthropic.com) — or start **free** with an [OpenRouter key](https://openrouter.ai/keys) (no credit card). Keys are stored **encrypted, locally**.
3. Open a folder or pick a template, and ask — in Arabic or English.

> **SmartScreen warning?** Expected and temporary — current builds aren't code-signed yet (certificate in progress). Click **More info → Run anyway**. The entire source is right here.

### Run from source

```bash
git clone https://github.com/mralzeerr/satr-editor.git
cd satr-editor
npm install
npm start
```

### License

[MIT](LICENSE) — free forever. Built with 🤍 from the Arab world.
