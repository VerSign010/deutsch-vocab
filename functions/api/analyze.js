export async function onRequestPost(context) {
  return handleAnalyze(context.request, context.env);
}

async function handleAnalyze(request, env) {
  try {
    const body = await request.json().catch(() => ({}));
    const text = String(body.text || '').trim();

    if (!text) {
      return jsonResponse({ error: '请输入德语内容' }, 400);
    }
    if (text.length > 2500) {
      return jsonResponse({ error: '单次输入请控制在 2500 字符以内' }, 400);
    }

    // 可选 KV 缓存
    let cacheKey = null;
    if (env.VOCAB_CACHE) {
      cacheKey = `v1:${await sha256(text)}`;
      const cached = await env.VOCAB_CACHE.get(cacheKey, 'json');
      if (cached) {
        return jsonResponse({ ...cached, cached: true }, 200);
      }
    }

    // 默认走 OpenAI 兼容模式（Groq）
    const provider = (env.AI_PROVIDER || 'openai').toLowerCase().trim();
    const apiKey = (env.AI_API_KEY || '').trim();

    if (!apiKey) {
      return jsonResponse(
        { error: '服务器尚未配置 AI_API_KEY 环境变量', code: 'NO_API_KEY' },
        500
      );
    }

    const prompt = buildPrompt(text);
    let resultData;

    if (provider === 'gemini') {
      const model = env.AI_MODEL || 'gemini-3.8-flash';
      resultData = await callGemini(apiKey, model, prompt);
    } else {
      const baseUrl = (env.AI_BASE_URL || 'https://api.groq.com/openai/v1').trim().replace(/\/+$/, '');
      resultData = await callOpenAICompatible(baseUrl, apiKey, env.AI_MODEL, prompt);
    }

    if (env.VOCAB_CACHE && cacheKey && Array.isArray(resultData?.words)) {
      await env.VOCAB_CACHE.put(cacheKey, JSON.stringify(resultData), {
        expirationTtl: 60 * 60 * 24 * 30,
      });
    }

    return jsonResponse(resultData, 200);
  } catch (err) {
    return jsonResponse({ error: err.message || '服务器内部错误' }, 500);
  }
}

async function callOpenAICompatible(baseUrl, apiKey, modelConfig, prompt) {
  const configuredModels = String(modelConfig || '')
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m && m.toLowerCase() !== 'auto');

  let lastError = null;

  // 1. 先尝试环境变量里指定的模型
  for (const model of configuredModels) {
    try {
      return await requestOpenAIChat(baseUrl, apiKey, model, prompt, true);
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        throw err; // Key 无效，直接报错
      }
      lastError = err;
    }
  }

  // 2. 如果未指定模型，或指定模型已下线/无权限，自动查询账号当前可用的欧美模型
  try {
    const autoModels = await discoverAvailableNonChinaModels(baseUrl, apiKey);
    for (const model of autoModels) {
      if (configuredModels.includes(model)) continue;
      try {
        return await requestOpenAIChat(baseUrl, apiKey, model, prompt, true);
      } catch (err) {
        if (err.status === 401 || err.status === 403) {
          throw err;
        }
        lastError = err;
      }
    }
  } catch (discoverErr) {
    if (!lastError) lastError = discoverErr;
  }

  throw lastError || new Error('没有找到可用的模型，请检查 AI_API_KEY 或平台权限');
}

async function requestOpenAIChat(baseUrl, apiKey, model, prompt, useJsonMode) {
  const payload = {
    model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: '你是一位专业的德语词典编辑与德语教师，只输出严格合法的 JSON，不要输出多余解释。' },
      { role: 'user', content: prompt },
    ],
  };

  if (useJsonMode) {
    payload.response_format = { type: 'json_object' };
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `模型接口错误 (${res.status})`;
    // 部分模型不支持 response_format: json_object，自动去掉该参数重试一次
    if (useJsonMode && res.status === 400 && /response_format|json/i.test(msg)) {
      return requestOpenAIChat(baseUrl, apiKey, model, prompt, false);
    }
    const err = new Error(`[${model}] ${msg}`);
    err.status = res.status;
    throw err;
  }

  const rawText = data?.choices?.[0]?.message?.content || '';
  const parsed = safeParseJson(rawText);
  if (!Array.isArray(parsed?.words)) {
    throw new Error(`[${model}] 返回格式缺少 words 数组`);
  }
  return parsed;
}

async function discoverAvailableNonChinaModels(baseUrl, apiKey) {
  const res = await fetch(`${baseUrl}/models`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !Array.isArray(data?.data)) {
    throw new Error(data?.error?.message || `获取可用模型列表失败 (${res.status})`);
  }

  // 过滤掉非文本对话模型（语音/识别/安全审核）及中国大陆模型
  const nonTextRegex = /whisper|distil-whisper|playai|tts|orpheus|audio|speech|guard|safeguard|embed|rerank|moderation|dall-e|imagen|flux|realtime|transcribe/i;
  const mainlandChinaRegex = /qwen|deepseek|moonshot|kimi|glm|chatglm|yi-|baichuan|minimax|doubao|hunyuan|ernie|stepfun/i;

  const candidates = data.data
    .filter((m) => m && m.id && m.active !== false)
    .map((m) => m.id)
    .filter((id) => !nonTextRegex.test(id) && !mainlandChinaRegex.test(id));

  // 按德语理解与指令遵循能力优先排序
  const scoreModel = (id) => {
    let score = 0;
    if (/gpt-oss-120b|llama-4|llama-3\.3-70b|mistral-large/i.test(id)) score += 100;
    if (/70b|90b|120b|maverick|versatile/i.test(id)) score += 80;
    if (/gpt-oss|llama-3|scout|mistral|gemma/i.test(id)) score += 60;
    if (/8b|instant|mini|nano|1b|3b/i.test(id)) score -= 20;
    return score;
  };

  candidates.sort((a, b) => scoreModel(b) - scoreModel(a));
  return candidates.slice(0, 5);
}

async function callGemini(apiKey, modelConfig, prompt) {
  const models = String(modelConfig || 'gemini-3.8-flash')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

  let lastError = null;
  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return safeParseJson(rawText);
      }
      const msg = data?.error?.message || `Gemini API 错误 (${res.status})`;
      lastError = new Error(`[${model}] ${msg}`);
      if (res.status === 503 || res.status === 429) {
        await new Promise((r) => setTimeout(r, 900));
        continue;
      }
      break;
    }
  }
  throw lastError || new Error('Gemini 暂时不可用');
}

function buildPrompt(text) {
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
  const withoutThink = String(rawText || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const cleaned = withoutThink.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('未能从模型响应中解析出 JSON');
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
