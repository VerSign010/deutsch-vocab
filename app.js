// ===== 状态管理 =====
const state = {
  words: [],                // 当前分析出的全部生词
  selectedLevels: new Set(['ALL']), // 'ALL' | 'A1-A2' | 'B1-B2' | 'C'
  isReaderMode: false,
  originalText: '',
  vocabBook: loadVocabBook(),
  settings: loadSettings(),
};

const SAMPLE_GERMAN_TEXT = `Der Einfluss der digitalen Medien auf unseren Alltag wächst ständig. Viele Menschen verbringen täglich mehrere Stunden vor dem Bildschirm, obwohl sie eigentlich mehr Zeit draußen verbringen möchten. Experten weisen darauf hin, dass ein bewusster Umgang mit Smartphones entscheidend ist, um die Konzentrationsfähigkeit langfristig zu erhalten.`;

// ===== DOM 元素 =====
const els = {
  germanInput: document.getElementById('germanInput'),
  readerView: document.getElementById('readerView'),
  charCount: document.getElementById('charCount'),
  toggleReaderModeBtn: document.getElementById('toggleReaderModeBtn'),
  sampleTextBtn: document.getElementById('sampleTextBtn'),
  clearTextBtn: document.getElementById('clearTextBtn'),
  analyzeBtn: document.getElementById('analyzeBtn'),
  analyzeBtnIcon: document.getElementById('analyzeBtnIcon'),
  analyzeBtnText: document.getElementById('analyzeBtnText'),
  errorBox: document.getElementById('errorBox'),
  loadingSkeleton: document.getElementById('loadingSkeleton'),
  emptyState: document.getElementById('emptyState'),
  vocabList: document.getElementById('vocabList'),
  resultSummary: document.getElementById('resultSummary'),
  levelFilterGroup: document.getElementById('levelFilterGroup'),
  // 生词本
  openVocabBookBtn: document.getElementById('openVocabBookBtn'),
  closeVocabBookBtn: document.getElementById('closeVocabBookBtn'),
  vocabBookDrawer: document.getElementById('vocabBookDrawer'),
  vocabBookBackdrop: document.getElementById('vocabBookBackdrop'),
  vocabBookList: document.getElementById('vocabBookList'),
  vocabCountBadge: document.getElementById('vocabCountBadge'),
  exportCsvBtn: document.getElementById('exportCsvBtn'),
  // 设置 & 主题
  themeToggleBtn: document.getElementById('themeToggleBtn'),
  themeIcon: document.getElementById('themeIcon'),
  openSettingsBtn: document.getElementById('openSettingsBtn'),
  closeSettingsBtn: document.getElementById('closeSettingsBtn'),
  settingsModal: document.getElementById('settingsModal'),
  settingsBackdrop: document.getElementById('settingsBackdrop'),
  settingProvider: document.getElementById('settingProvider'),
  customApiFields: document.getElementById('customApiFields'),
  openaiBaseUrlWrap: document.getElementById('openaiBaseUrlWrap'),
  settingBaseUrl: document.getElementById('settingBaseUrl'),
  settingModel: document.getElementById('settingModel'),
  settingApiKey: document.getElementById('settingApiKey'),
  saveSettingsBtn: document.getElementById('saveSettingsBtn'),
};

// ===== 初始化 =====
function init() {
  initTheme();
  updateVocabBadge();
  syncSettingsUI();
  bindEvents();
}

function bindEvents() {
  els.germanInput.addEventListener('input', () => {
    els.charCount.textContent = `${els.germanInput.value.length} / 2500 字`;
  });

  els.sampleTextBtn.addEventListener('click', () => {
    switchToEditMode();
    els.germanInput.value = SAMPLE_GERMAN_TEXT;
    els.charCount.textContent = `${SAMPLE_GERMAN_TEXT.length} / 2500 字`;
  });

  els.clearTextBtn.addEventListener('click', () => {
    switchToEditMode();
    els.germanInput.value = '';
    els.charCount.textContent = '0 / 2500 字';
    hideError();
  });

  els.toggleReaderModeBtn.addEventListener('click', () => {
    if (state.isReaderMode) {
      switchToEditMode();
    } else {
      switchToReaderMode();
    }
  });

  els.analyzeBtn.addEventListener('click', handleAnalyze);

  // 词汇水平多选筛选
  els.levelFilterGroup.addEventListener('click', (e) => {
    const btn = e.target.closest('.level-btn');
    if (!btn) return;
    const level = btn.dataset.level;

    if (level === 'ALL') {
      state.selectedLevels = new Set(['ALL']);
    } else {
      state.selectedLevels.delete('ALL');
      if (state.selectedLevels.has(level)) {
        state.selectedLevels.delete(level);
      } else {
        state.selectedLevels.add(level);
      }
      if (state.selectedLevels.size === 0 || state.selectedLevels.size === 3) {
        state.selectedLevels = new Set(['ALL']);
      }
    }
    updateLevelButtonsUI();
    renderWordCards();
  });

  // 主题切换
  els.themeToggleBtn.addEventListener('click', toggleTheme);

  // 生词本抽屉
  els.openVocabBookBtn.addEventListener('click', () => {
    renderVocabBook();
    els.vocabBookDrawer.classList.remove('hidden');
  });
  els.closeVocabBookBtn.addEventListener('click', () => els.vocabBookDrawer.classList.add('hidden'));
  els.vocabBookBackdrop.addEventListener('click', () => els.vocabBookDrawer.classList.add('hidden'));
  els.exportCsvBtn.addEventListener('click', exportVocabToCsv);

  // 设置弹窗
  els.openSettingsBtn.addEventListener('click', () => {
    syncSettingsUI();
    els.settingsModal.classList.remove('hidden');
  });
  els.closeSettingsBtn.addEventListener('click', () => els.settingsModal.classList.add('hidden'));
  els.settingsBackdrop.addEventListener('click', () => els.settingsModal.classList.add('hidden'));
  els.settingProvider.addEventListener('change', toggleSettingsFields);
  els.saveSettingsBtn.addEventListener('click', saveSettingsFromUI);
}

// ===== 核心：调用分析接口 =====
async function handleAnalyze() {
  const text = (state.isReaderMode ? state.originalText : els.germanInput.value).trim();
  if (!text) {
    showError('请先输入或粘贴一段德语内容。');
    return;
  }
  if (text.length < 5) {
    showError('输入的德语内容太短啦，请再多输入几个词。');
    return;
  }

  hideError();
  setLoading(true);
  state.originalText = text;

  try {
    let resultData;
    if (state.settings.provider === 'server') {
      resultData = await callServerApi(text);
    } else {
      resultData = await callDirectBrowserApi(text, state.settings);
    }

    if (!resultData || !Array.isArray(resultData.words)) {
      throw new Error('返回数据格式异常，请重试。');
    }

    state.words = resultData.words;
    renderReaderView();
    switchToReaderMode();
    renderWordCards();
  } catch (err) {
    console.error(err);
    showError(err.message || '查询失败，请稍后重试。');
  } finally {
    setLoading(false);
  }
}

async function callServerApi(text) {
  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  if (res.status === 404) {
    throw new Error('未检测到后台接口（如果你部署在纯静态 GitHub Pages 上，请点击右上角 ⚙️ 设置你自己的免费 API Key）。');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.code === 'NO_API_KEY') {
      throw new Error('站点后台尚未配置 API Key，请点击右上角 ⚙️ 填写你的个人 Key 或在 Cloudflare 后台配置环境变量。');
    }
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data;
}

// 纯静态模式下的浏览器直连逻辑（用于 GitHub Pages）
async function callDirectBrowserApi(text, settings) {
  if (!settings.apiKey) {
    throw new Error('请先点击右上角 ⚙️ 填写你的 API Key。');
  }

  const prompt = buildGermanPrompt(text);

  if (settings.provider === 'gemini') {
    const model = settings.model || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || 'Gemini 接口调用失败');
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return safeParseJson(raw);
  }

  // OpenAI 兼容模式（DeepSeek / SiliconFlow / Groq / OpenAI）
  const baseUrl = (settings.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  const model = settings.model || 'deepseek-chat';
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: '你是一位专业的德语词典编辑与德语教师，只输出严格合法的 JSON。' },
        { role: 'user', content: prompt },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || 'API 调用失败');
  const raw = data?.choices?.[0]?.message?.content || '';
  return safeParseJson(raw);
}

function buildGermanPrompt(text) {
  return `请分析以下德语段落，提取其中值得学习的实词和核心词汇（包括名词、动词、形容词、副词及重要连词/介词，跳过纯标点、人称代词和简单的冠词）。注意准确识别德语动词变位、名词复数以及可分动词，还原其词典原形。

要求严格返回如下 JSON 格式：
{
  "words": [
    {
      "lemma": "词典原形（名词首字母大写且不带冠词，如 Einfluss；可分动词写合写原形，如 hinweisen）",
      "article": "仅名词填写 der / die / das，其他词性填 null",
      "plural": "仅名词填写复数变化如 -¨e 或 -en，无复数或非名词填 null",
      "pos": "中文词性，如 名词 / 动词 / 形容词 / 副词 / 连词 / 介词",
      "level": "CEFR难度等级，只能是 A1, A2, B1, B2, C1, C2 之一",
      "in_text": "该词在原文中的实际出现形式（如 verbringen 或 weisen ... hin）",
      "meaning": "结合该段落语境的准确中文意思（简洁明了）",
      "collocations": [
        { "de": "常用固定搭配1（如 Einfluss auf (+A) haben）", "zh": "搭配中文意思" },
        { "de": "常用固定搭配2", "zh": "搭配中文意思" }
      ],
      "examples": [
        { "de": "一句简单实用的德语例句。", "zh": "例句中文翻译。" }
      ]
    }
  ]
}

德语段落如下：
"""
${text}
"""`;
}

function safeParseJson(rawText) {
  const cleaned = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('未能解析出有效词汇数据');
  return JSON.parse(cleaned.slice(start, end + 1));
}

// ===== 筛选与渲染词汇卡片 =====
function getLevelBucket(cefr) {
  const upper = String(cefr || '').toUpperCase().trim();
  if (upper === 'A1' || upper === 'A2') return 'A1-A2';
  if (upper === 'B1' || upper === 'B2') return 'B1-B2';
  if (upper === 'C1' || upper === 'C2' || upper === 'C') return 'C';
  return 'B1-B2';
}

function getFilteredWords() {
  if (state.selectedLevels.has('ALL')) return state.words;
  return state.words.filter((w) => state.selectedLevels.has(getLevelBucket(w.level)));
}

function renderWordCards() {
  const total = state.words.length;
  const filtered = getFilteredWords();

  if (total === 0) {
    els.vocabList.innerHTML = '';
    els.emptyState.classList.remove('hidden');
    els.resultSummary.textContent = '等待输入文本';
    return;
  }

  els.emptyState.classList.add('hidden');
  els.resultSummary.textContent = `共 ${total} 词，当前显示 ${filtered.length} 词`;

  if (filtered.length === 0) {
    els.vocabList.innerHTML = `
      <div class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-8 text-center text-sm text-slate-500">
        当前筛选级别下没有匹配词汇，试着点选其他等级或点击“全部”。
      </div>`;
    return;
  }

  els.vocabList.innerHTML = filtered.map((word) => {
    const globalIdx = state.words.indexOf(word);
    return createWordCardHTML(word, globalIdx);
  }).join('');

  // 绑定卡片内按钮事件（朗读 & 收藏）
  els.vocabList.querySelectorAll('[data-speak]').forEach((btn) => {
    btn.addEventListener('click', () => speakGerman(btn.dataset.speak));
  });
  els.vocabList.querySelectorAll('[data-save-idx]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.saveIdx);
      toggleSaveWord(state.words[idx]);
      renderWordCards();
    });
  });
}

function createWordCardHTML(word, idx) {
  const bucket = getLevelBucket(word.level);
  const levelColors = {
    'A1-A2': 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30',
    'B1-B2': 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30',
    'C': 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-500/15 dark:text-purple-300 dark:border-purple-500/30',
  };

  const articleColors = {
    der: 'text-blue-600 dark:text-blue-400',
    die: 'text-rose-600 dark:text-rose-400',
    das: 'text-emerald-600 dark:text-emerald-400',
  };

  const articleHtml = word.article
    ? `<span class="font-semibold ${articleColors[word.article.toLowerCase()] || ''}">${escapeHtml(word.article)}</span> `
    : '';
  const pluralHtml = word.plural
    ? `<span class="text-sm font-normal text-slate-400">, ${escapeHtml(word.plural)}</span>`
    : '';

  const speakWordText = word.article ? `${word.article} ${word.lemma}` : word.lemma;
  const isSaved = isWordSaved(word.lemma);

  const collocationsHtml = Array.isArray(word.collocations) && word.collocations.length
    ? `
      <div class="pt-2.5 border-t border-slate-100 dark:border-slate-800">
        <div class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">🔗 常用固定搭配</div>
        <ul class="space-y-1.5">
          ${word.collocations.map((c) => `
            <li class="text-sm flex flex-col sm:flex-row sm:items-baseline sm:gap-2">
              <span class="font-medium text-slate-800 dark:text-slate-200">• ${escapeHtml(c.de)}</span>
              <span class="text-xs sm:text-sm text-slate-500 dark:text-slate-400">${escapeHtml(c.zh)}</span>
            </li>
          `).join('')}
        </ul>
      </div>`
    : '';

  const examplesHtml = Array.isArray(word.examples) && word.examples.length
    ? `
      <div class="pt-2.5 border-t border-slate-100 dark:border-slate-800">
        <div class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">💬 简单例句</div>
        <div class="space-y-2">
          ${word.examples.map((ex) => `
            <div class="bg-slate-50 dark:bg-slate-950/60 rounded-xl p-2.5 sm:p-3 flex items-start gap-2.5">
              <button data-speak="${escapeAttr(ex.de)}" title="朗读例句" class="mt-0.5 shrink-0 w-7 h-7 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center text-xs hover:border-brand-500 transition">
                🔊
              </button>
              <div class="text-sm leading-relaxed">
                <p class="text-slate-800 dark:text-slate-200 font-medium">${escapeHtml(ex.de)}</p>
                <p class="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-0.5">${escapeHtml(ex.zh)}</p>
              </div>
            </div>
          `).join('')}
        </div>
      </div>`
    : '';

  const showInText = word.in_text && word.in_text.toLowerCase() !== word.lemma.toLowerCase();

  return `
    <article id="word-card-${idx}" class="bg-white dark:bg-slate-900 rounded-2xl shadow-sm border border-slate-200/80 dark:border-slate-800 p-4 sm:p-5 space-y-3 transition">
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="flex items-center gap-2 flex-wrap">
            <span class="px-2 py-0.5 text-xs font-bold rounded-md border ${levelColors[bucket]}">${escapeHtml(word.level || bucket)}</span>
            <h3 class="text-lg sm:text-xl font-bold tracking-tight">
              ${articleHtml}${escapeHtml(word.lemma)}${pluralHtml}
            </h3>
            <button data-speak="${escapeAttr(speakWordText)}" title="朗读单词" class="w-7 h-7 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-brand-50 hover:text-brand-600 dark:hover:bg-brand-500/20 flex items-center justify-center text-xs transition">
              🔊
            </button>
          </div>
          <div class="flex items-center gap-2 mt-1 text-xs text-slate-400">
            <span>${escapeHtml(word.pos || '')}</span>
            ${showInText ? `<span>· 文中形式: <strong class="text-slate-600 dark:text-slate-300 font-medium">${escapeHtml(word.in_text)}</strong></span>` : ''}
          </div>
        </div>

        <button data-save-idx="${idx}" title="${isSaved ? '移出生词本' : '加入生词本'}" class="shrink-0 px-2.5 py-1.5 rounded-xl text-xs font-medium border transition ${
          isSaved
            ? 'bg-amber-50 border-amber-200 text-amber-600 dark:bg-amber-500/15 dark:border-amber-500/30 dark:text-amber-300'
            : 'bg-slate-50 border-slate-200 text-slate-500 hover:text-amber-500 dark:bg-slate-800 dark:border-slate-700'
        }">
          ${isSaved ? '★ 已收藏' : '☆ 收藏'}
        </button>
      </div>

      <div class="text-sm sm:text-base text-slate-700 dark:text-slate-200">
        <span class="font-semibold text-brand-600 dark:text-brand-100">意思：</span>${escapeHtml(word.meaning)}
      </div>

      ${collocationsHtml}
      ${examplesHtml}
    </article>
  `;
}

// ===== 互动高亮阅读模式 =====
function renderReaderView() {
  const tokenMap = new Map();
  state.words.forEach((w, idx) => {
    if (w.lemma) tokenMap.set(w.lemma.toLowerCase(), idx);
    if (w.in_text) {
      w.in_text.split(/[\s.,…]+/).forEach((part) => {
        const clean = part.trim().toLowerCase();
        if (clean.length > 1 && !tokenMap.has(clean)) {
          tokenMap.set(clean, idx);
        }
      });
    }
  });

  const parts = state.originalText.split(/([a-zA-ZäöüÄÖÜß]+)/g);
  els.readerView.innerHTML = parts.map((part) => {
    if (!part) return '';
    const idx = tokenMap.get(part.toLowerCase());
    if (idx !== undefined) {
      return `<button type="button" data-jump-idx="${idx}" class="inline px-1 py-0.5 mx-0.5 rounded bg-brand-50 hover:bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:hover:bg-brand-500/35 dark:text-brand-100 font-medium underline decoration-brand-300 underline-offset-4 transition cursor-pointer">${escapeHtml(part)}</button>`;
    }
    return escapeHtml(part).replace(/\n/g, '<br>');
  }).join('');

  els.readerView.querySelectorAll('[data-jump-idx]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.jumpIdx);
      let card = document.getElementById(`word-card-${idx}`);
      // 如果当前被筛选隐藏了，自动切回“全部”再跳转
      if (!card) {
        state.selectedLevels = new Set(['ALL']);
        updateLevelButtonsUI();
        renderWordCards();
        card = document.getElementById(`word-card-${idx}`);
      }
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.remove('card-flash');
        void card.offsetWidth;
        card.classList.add('card-flash');
      }
    });
  });
}

function switchToReaderMode() {
  if (!state.words.length) return;
  state.isReaderMode = true;
  els.germanInput.classList.add('hidden');
  els.readerView.classList.remove('hidden');
  els.toggleReaderModeBtn.classList.remove('hidden');
  els.toggleReaderModeBtn.textContent = '✏️ 返回编辑';
}

function switchToEditMode() {
  state.isReaderMode = false;
  els.readerView.classList.add('hidden');
  els.germanInput.classList.remove('hidden');
  if (state.words.length) {
    els.toggleReaderModeBtn.classList.remove('hidden');
    els.toggleReaderModeBtn.textContent = '👁️ 阅读高亮';
  } else {
    els.toggleReaderModeBtn.classList.add('hidden');
  }
}

function updateLevelButtonsUI() {
  els.levelFilterGroup.querySelectorAll('.level-btn').forEach((btn) => {
    const active = state.selectedLevels.has(btn.dataset.level);
    btn.className = `level-btn px-3 py-1 rounded-full text-xs sm:text-sm font-medium transition ${
      active
        ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900 shadow-xs'
        : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'
    }`;
  });
}

// ===== 浏览器德语朗读 (Web Speech API) =====
function speakGerman(text) {
  if (!('speechSynthesis' in window)) {
    alert('当前浏览器不支持语音朗读功能。');
    return;
  }
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'de-DE';
  utter.rate = 0.92;
  const voices = window.speechSynthesis.getVoices();
  const deVoice = voices.find((v) => v.lang.startsWith('de'));
  if (deVoice) utter.voice = deVoice;
  window.speechSynthesis.speak(utter);
}

// ===== 生词本管理 (localStorage + CSV导出) =====
function loadVocabBook() {
  try {
    return JSON.parse(localStorage.getItem('deutsch_vocab_book') || '[]');
  } catch {
    return [];
  }
}

function saveVocabBook() {
  localStorage.setItem('deutsch_vocab_book', JSON.stringify(state.vocabBook));
  updateVocabBadge();
}

function isWordSaved(lemma) {
  return state.vocabBook.some((w) => w.lemma.toLowerCase() === String(lemma).toLowerCase());
}

function toggleSaveWord(word) {
  const idx = state.vocabBook.findIndex((w) => w.lemma.toLowerCase() === word.lemma.toLowerCase());
  if (idx > -1) {
    state.vocabBook.splice(idx, 1);
  } else {
    state.vocabBook.unshift({ ...word, savedAt: Date.now() });
  }
  saveVocabBook();
}

function updateVocabBadge() {
  els.vocabCountBadge.textContent = state.vocabBook.length;
}

function renderVocabBook() {
  if (!state.vocabBook.length) {
    els.vocabBookList.innerHTML = `<p class="text-center text-sm text-slate-400 py-12">生词本还是空的，点击卡片右上角的“☆ 收藏”即可加入。</p>`;
    return;
  }
  els.vocabBookList.innerHTML = state.vocabBook.map((w, idx) => `
    <div class="rounded-xl border border-slate-200 dark:border-slate-800 p-3 bg-slate-50/60 dark:bg-slate-950/60 space-y-1.5">
      <div class="flex items-center justify-between gap-2">
        <div class="font-bold text-sm">
          <span class="text-xs px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-800 mr-1">${escapeHtml(w.level || '')}</span>
          ${w.article ? escapeHtml(w.article) + ' ' : ''}${escapeHtml(w.lemma)}
        </div>
        <div class="flex items-center gap-1.5">
          <button data-book-speak="${escapeAttr((w.article ? w.article + ' ' : '') + w.lemma)}" class="text-xs p-1 hover:bg-slate-200 dark:hover:bg-slate-800 rounded">🔊</button>
          <button data-book-del="${idx}" class="text-xs text-rose-500 hover:underline px-1">移除</button>
        </div>
      </div>
      <p class="text-xs sm:text-sm text-slate-600 dark:text-slate-300">${escapeHtml(w.meaning)}</p>
    </div>
  `).join('');

  els.vocabBookList.querySelectorAll('[data-book-speak]').forEach((b) => {
    b.addEventListener('click', () => speakGerman(b.dataset.bookSpeak));
  });
  els.vocabBookList.querySelectorAll('[data-book-del]').forEach((b) => {
    b.addEventListener('click', () => {
      state.vocabBook.splice(Number(b.dataset.bookDel), 1);
      saveVocabBook();
      renderVocabBook();
      renderWordCards();
    });
  });
}

function exportVocabToCsv() {
  if (!state.vocabBook.length) return;
  const headers = ['词汇原形', '冠词', '复数', '词性', '等级', '中文意思', '固定搭配', '例句'];
  const rows = state.vocabBook.map((w) => [
    w.lemma || '',
    w.article || '',
    w.plural || '',
    w.pos || '',
    w.level || '',
    w.meaning || '',
    (w.collocations || []).map((c) => `${c.de} (${c.zh})`).join('; '),
    (w.examples || []).map((e) => `${e.de} (${e.zh})`).join('; '),
  ].map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','));

  const csvContent = '\uFEFF' + [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `deutsch-vocab-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ===== 设置 & 主题 =====
function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem('deutsch_vocab_settings') || '{"provider":"server"}');
  } catch {
    return { provider: 'server' };
  }
}

function syncSettingsUI() {
  els.settingProvider.value = state.settings.provider || 'server';
  els.settingBaseUrl.value = state.settings.baseUrl || 'https://api.deepseek.com/v1';
  els.settingModel.value = state.settings.model || '';
  els.settingApiKey.value = state.settings.apiKey || '';
  toggleSettingsFields();
}

function toggleSettingsFields() {
  const val = els.settingProvider.value;
  els.customApiFields.classList.toggle('hidden', val === 'server');
  els.openaiBaseUrlWrap.classList.toggle('hidden', val !== 'openai');
}

function saveSettingsFromUI() {
  state.settings = {
    provider: els.settingProvider.value,
    baseUrl: els.settingBaseUrl.value.trim(),
    model: els.settingModel.value.trim(),
    apiKey: els.settingApiKey.value.trim(),
  };
  localStorage.setItem('deutsch_vocab_settings', JSON.stringify(state.settings));
  els.settingsModal.classList.add('hidden');
}

function initTheme() {
  const saved = localStorage.getItem('deutsch_theme');
  const isDark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.toggle('dark', isDark);
  els.themeIcon.textContent = isDark ? '☀️' : '🌙';
}

function toggleTheme() {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('deutsch_theme', isDark ? 'dark' : 'light');
  els.themeIcon.textContent = isDark ? '☀️' : '🌙';
}

// ===== UI 辅助函数 =====
function setLoading(loading) {
  els.analyzeBtn.disabled = loading;
  els.analyzeBtnIcon.textContent = loading ? '⏳' : '✨';
  els.analyzeBtnText.textContent = loading ? '正在解析词汇...' : '学习词汇';
  els.loadingSkeleton.classList.toggle('hidden', !loading);
  if (loading) {
    els.emptyState.classList.add('hidden');
    els.vocabList.innerHTML = '';
  }
}

function showError(msg) {
  els.errorBox.textContent = msg;
  els.errorBox.classList.remove('hidden');
}

function hideError() {
  els.errorBox.classList.add('hidden');
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  return escapeHtml(str);
}

init();