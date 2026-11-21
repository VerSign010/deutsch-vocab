export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json().catch(() => ({}));
    const text = String(body.text || '').trim();

    if (!text) {
      return jsonResponse({ error: '请输入德语内容' }, 400);
    }
    if (text.length > 2500) {
      return jsonResponse({ error: '单次输入请控制在 2500 字符以内' }, 400);
    }

    // 1. 可选：如果配置了 Cloudflare KV (绑定名为 VOCAB_CACHE)，优先读取缓存
    let cacheKey = null;
    if (env.VOCAB_CACHE) {
      cacheKey = `v1:${await sha256(text)}`;
      const cached = await env.VOCAB_CACHE.get(cacheKey, 'json');
      if (cached) {
        return jsonResponse({ ...cached, cached: true }, 200);
      }
    }

    // 2. 读取环境变量配置（默认优先支持 Gemini 免费版，也支持 OpenAI 兼容接口）
    const provider = (env.AI_PROVIDER || 'gemini').toLowerCase();
    const apiKey = env.AI_API_KEY;

    if (!apiKey) {
      return jsonResponse(
        { error: '服务器尚未配置 AI_API_KEY 环境变量', code: 'NO_API_KEY' },
        500
      );
    }

    const prompt = buildPrompt(text);
    let resultData;

    if (provider === 'gemini') {
      const model = env.AI_MODEL || 'gemini-2.5-flash';
      resultData = await callGemini(apiKey, model, prompt);
    } else {
      const baseUrl = (env.AI_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
      const model = env.AI_MODEL || 'deepseek-chat';
      resultData = await callOpenAICompatible(baseUrl, apiKey, model, prompt);
    }

    // 3. 写入 KV 缓存（保存 30 天）
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

async function callGemini(apiKey, modelConfig, prompt) {
  const models = String(modelConfig || 'gemini-3.8-flash')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

  let lastError = null;

  for (const model of models) {
    // 每个模型遇到 503/429 拥堵时最多尝试 2 次
    for (let attempt = 1; attempt <= 2; attempt++) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.2,
          },
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return safeParseJson(rawText);
      }

      const msg = data?.error?.message || `Gemini API 错误 (${res.status})`;
      lastError = new Error(`[${model}] ${msg}`);

      // 如果是 503 拥堵或 429 限流，短暂等待后重试或切换下一个模型
      if (res.status === 503 || res.status === 429) {
        await new Promise((r) => setTimeout(r, 900));
        continue;
      }
      // 如果是模型名不存在(404)或Key错误(400/403)，直接跳出当前模型尝试下一个
      break;
    }
  }

  throw lastError || new Error('所有备用模型均暂时不可用，请稍后再试');
}

async function callOpenAICompatible(baseUrl, apiKey, model, prompt) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
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
  if (!res.ok) {
    throw new Error(data?.error?.message || `模型接口错误 (${res.status})`);
  }
  const rawText = data?.choices?.[0]?.message?.content || '';
  return safeParseJson(rawText);
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
  const cleaned = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) {
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
