# Project Instructions

- The user starts and manages `npm run dev` for this project.
- Do not start or restart the development server unless the user explicitly asks.
- For verification, prefer lint/tests only.
- Do not run extra production builds unless the user explicitly asks for a build.

## LM Studio / Qwen Notes

- `qwen3.6-35b-a3b` through LM Studio may return structured JSON in `message.reasoning_content` while `message.content` is an empty string, even for requests where thinking is disabled or not explicitly requested.
- Keep LLM parsing compatible with this shape: prefer `message.content`, but if it is empty, fall back to `message.reasoning_content` before treating the response as invalid JSON.
