const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;

const TOTAL_RESPONSE_BUDGET_MS = 4200; 
const SERPER_TIMEOUT_MS = 400;
const GEMINI_TIMEOUT_MS = 3800;

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

const SYSTEM_PROMPT = [
  "Ты — полезный голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай естественно, по-русски, кратко и так, чтобы ответ было удобно слушать.",
  "Обычно используй 1–3 коротких предложения.",
  "Не используй Markdown, таблицы, списки с символами или длинные вступления.",
  "Если вопрос требует актуальных данных и переданы результаты поиска, опирайся на них; не выдумывай отсутствующие факты.",
  "Если не знаешь ответа, честно скажи об этом."
].join(" ");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history }
  };
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) {
    return text || "Не удалось подготовить ответ.";
  }

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);

  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );

  if (sentenceEnd >= 300) {
    return candidate.slice(0, sentenceEnd + 1).trim();
  }

  const lastSpace = candidate.lastIndexOf(" ");

  return (
    lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate
  ).trim() + "…";
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные/i.test(text);
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter(item =>
      item &&
      (item.role === "user" || item.role === "model") &&
      typeof item.text === "string"
    )
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({
      role: item.role,
      text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS)
    }));
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = Math.max(100, timeoutMs);
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;

  if (!key || timeoutMs < 150) return "";

  try {
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          q: query,
          gl: "ru",
          hl: "ru",
          num: 3
        })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );

    if (!response.ok) {
      console.warn(`Serper request failed: HTTP ${response.status}`);
      return "";
    }

    const items = (
      Array.isArray(data.organic) ? data.organic : []
    )
      .slice(0, 3)
      .map((item, index) => {
        const title = String(item.title || "").slice(0, 160);
        const snippet = String(item.snippet || "").slice(0, 280);
        const link = String(item.link || "").slice(0, 200);

        return `${index + 1}. ${title}: ${snippet} ${link}`.trim();
      });

    const answerBox =
      data.answerBox?.answer || data.answerBox?.snippet;

    if (answerBox) {
      items.unshift(
        `Краткий ответ поисковика: ${String(answerBox).slice(0, 280)}`
      );
    }

    return items.length ? items.join("\n") : "";
  } catch (error) {
    console.warn(
      error?.name === "AbortError"
        ? "Serper request timed out; continuing without web search."
        : `Serper request failed: ${String(
            error?.message || "unknown error"
          ).slice(0, 180)}`
    );

    return "";
  }
}

function getGeminiErrorMessage(data) {
  const message = data?.error?.message;

  if (typeof message !== "string") return "";

  return message.replace(/\s+/g, " ").slice(0, 300);
}

function getBackoffDelay(attempt, baseDelayMs = 600) {
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
  return Math.floor(exponentialDelay * (0.7 + Math.random() * 0.6));
}

async function askGemini(text, history, searchContext, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;

  if (!key) {
    throw new Error("MISSING_GEMINI_KEY");
  }

  if (timeoutMs < 800) {
    throw new Error("TIME_BUDGET_EXHAUSTED");
  }

  const startedAt = Date.now();
  const remainingMs = () => timeoutMs - (Date.now() - startedAt);

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  const prompt = searchContext
    ? `${text}

Результаты поиска в интернете:
${searchContext}

Используй их только там, где они относятся к вопросу.`
    : text;

  contents.push({
    role: "user",
    parts: [{ text: prompt }]
  });

  const defaultModels = [
    GEMINI_MODEL,
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash"
  ];

  const models = [...new Set(defaultModels)];
  let lastError = new Error("GEMINI_REQUEST_FAILED");

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const maxAttempts = 2;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const remaining = remainingMs();

      if (remaining < 800) {
        throw lastError;
      }

      const timeout = Math.min(
        GEMINI_TIMEOUT_MS,
        Math.max(800, remaining - 200)
      );

      const url =
        "https://generativelanguage.googleapis.com/v1beta/models/" +
        `${encodeURIComponent(model)}:generateContent`;

      console.info(
        `Gemini request started; model=${model}; attempt=${attempt + 1}; timeoutMs=${timeout}`
      );

      let result;

      try {
        result = await fetchJson(
          url,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": key
            },
            body: JSON.stringify({
              systemInstruction: {
                parts: [{ text: SYSTEM_PROMPT }]
              },
              contents,
              generationConfig: {
                temperature: 0.4,
                maxOutputTokens: 160,
                // ИСПРАВЛЕНИЕ: используем thinkingLevel вместо thinkingBudget
                thinkingConfig: {
                  thinkingLevel: "MINIMAL"
                }
              }
            })
          },
          timeout
        );
      } catch (error) {
        if (error?.name === "AbortError") {
          console.warn(`Gemini timeout; model=${model}`);
          lastError = new Error("GEMINI_TIMEOUT");
        } else {
          console.warn(`Gemini network error; model=${model}`);
          lastError = new Error("GEMINI_NETWORK_ERROR");
        }
        break;
      }

      const { response, data } = result;

      if (!response.ok) {
        const apiMessage = getGeminiErrorMessage(data);

        console.warn(
          `Gemini API error; model=${model}; status=${response.status}; message=${apiMessage || "no error message"}`
        );

        if (response.status === 401 || response.status === 403) {
          throw new Error("GEMINI_KEY_REJECTED");
        }
        if (response.status === 429) {
          throw new Error("GEMINI_QUOTA");
        }
        if (response.status === 400) {
          // Если 400 всё ещё возникает, пробуем следующую модель
          lastError = new Error("GEMINI_BAD_REQUEST");
          break;
        }

        if (response.status === 503 || response.status >= 500) {
          lastError = new Error("GEMINI_OVERLOADED");
          if (attempt < maxAttempts - 1 && remainingMs() > 1200) {
            const delay = getBackoffDelay(attempt);
            console.warn(`Model ${model} overloaded. Retrying in ${delay}ms...`);
            await sleep(delay);
            continue;
          }
          break;
        }

        if (response.status === 404) {
           lastError = new Error("GEMINI_MODEL_NOT_FOUND");
           break;
        }

        lastError = new Error("GEMINI_REQUEST_FAILED");
        break;
      }

      const candidate = data?.candidates?.[0];
      const answer = (candidate?.content?.parts || [])
        .map(part => (typeof part.text === "string" ? part.text : ""))
        .join("")
        .trim();

      if (answer) return answer;

      if (
        candidate?.finishReason === "SAFETY" ||
        candidate?.finishReason === "BLOCKLIST"
      ) {
        throw new Error("GEMINI_BLOCKED");
      }

      console.warn(`Gemini returned no text; model=${model}; finishReason=${candidate?.finishReason}`);
      lastError = new Error("GEMINI_EMPTY_RESPONSE");
      break;
    }
  }

  throw lastError;
}

function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_GEMINI_KEY":
      return "Сервер пока не настроен. Проверьте переменную GEMINI_API_KEY в настройках Vercel.";
    case "GEMINI_KEY_REJECTED":
      return "Не удалось подключиться к Gemini. Проверьте API-ключ в настройках Vercel.";
    case "GEMINI_MODEL_NOT_FOUND":
      return "Указанная модель Gemini недоступна. Проверьте переменную GEMINI_MODEL в Vercel.";
    case "GEMINI_QUOTA":
      return "Сейчас превышен лимит запросов к Gemini. Попробуйте немного позже.";
    case "GEMINI_OVERLOADED":
      return "Сервис Gemini временно не отвечает. Попробуйте ещё раз через минуту.";
    case "GEMINI_TIMEOUT":
    case "TIME_BUDGET_EXHAUSTED":
    case "AbortError":
      return "Не успела подготовить ответ. Попробуйте задать вопрос ещё раз, чуть короче.";
    case "GEMINI_NETWORK_ERROR":
      return "Не удалось связаться с сервисом Gemini. Попробуйте ещё раз чуть позже.";
    case "GEMINI_BLOCKED":
      return "Я не смогла обработать этот запрос. Попробуйте спросить иначе.";
    case "GEMINI_EMPTY_RESPONSE":
      return "Не получилось сформировать ответ. Попробуйте задать вопрос иначе.";
    case "GEMINI_BAD_REQUEST":
      return "Gemini отклонила запрос. Попробуйте сформулировать вопрос иначе.";
    default:
      return "Не получилось получить ответ от нейросети. Попробуйте ещё раз чуть позже.";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-gemini-serper",
      model: GEMINI_MODEL,
      message: "Webhook is ready. Yandex Dialogs should send POST requests to /api."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = Date.now();

  const remainingMs = () =>
    TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);

  const body = req.body && typeof req.body === "object" ? req.body : {};

  const text = String(
    body?.request?.command ||
    body?.request?.original_utterance ||
    ""
  ).trim();

  const oldHistory = safeHistory(body?.state?.session?.history);

  if (!text) {
    return res.status(200).json(
      aliceResponse(
        "Привет! Я могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?",
        false,
        oldHistory
      )
    );
  }

  try {
    let searchContext = "";

    if (isSearchIntent(text) && process.env.SERPER_API_KEY) {
      const searchBudget = Math.min(
        SERPER_TIMEOUT_MS,
        Math.max(0, remainingMs() - 3200) 
      );

      if (searchBudget >= 150) {
        searchContext = await searchWeb(text, searchBudget);
      }
    }

    const geminiBudget = Math.max(0, remainingMs() - 200);

    const answer = await askGemini(
      text,
      oldHistory,
      searchContext,
      geminiBudget
    );

    const history = [
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES);

    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    const safeError = (
      error?.name === "AbortError" ||
      error?.message === "This operation was aborted"
    )
      ? new Error("GEMINI_TIMEOUT")
      : error;

    console.warn(
      `Alice webhook fallback; code=${String(
        safeError?.message || "unknown error"
      ).slice(0, 100)}`
    );

    return res.status(200).json(
      aliceResponse(errorForUser(safeError), false, oldHistory)
    );
  }
}

export {
  aliceResponse,
  fitAliceText,
  isSearchIntent,
  safeHistory
};
