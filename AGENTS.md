# Project Instructions

- The user starts and manages `npm run dev` for this project.
- Do not start or restart the development server unless the user explicitly asks.
- For verification, prefer lint/tests only.
- Do not run extra production builds unless the user explicitly asks for a build.

## GLM-4.7-Flash / Z.ai Notes

- The app uses Z.ai/Zhipu GLM-4.7-Flash through `https://open.bigmodel.cn/api/paas/v4/chat/completions`.
- Read the API key from `.env` as `ZAI_API_KEY`; do not store or expose it in Settings.
- GLM-4.7-Flash free tier concurrency is limited to 1; keep free-model LLM concurrency at 1. When a user's dedicated/personal model is enabled, application LLM concurrency can be enabled up to 20 and defaults to 20.
- GLM structured output uses `response_format: { "type": "json_object" }`; include the expected JSON schema in the prompt and validate/normalize locally.
