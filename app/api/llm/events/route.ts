import { authErrorResponse, requireUser } from "@/lib/auth";
import { snapshot } from "@/lib/llmQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  let user;
  try {
    user = requireUser(request);
  } catch (error) {
    return authErrorResponse(error) ?? new Response(JSON.stringify({ message: "请先登录。" }), { status: 401 });
  }

  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      let lastPayload = "";
      let closed = false;
      const write = (event: string, payload: string) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${payload}\n\n`));
        } catch {
          cleanup();
        }
      };
      const send = () => {
        if (closed) return;
        try {
          const payload = JSON.stringify(snapshot(user.id));
          if (payload === lastPayload) return;
          lastPayload = payload;
          write("status", payload);
        } catch (error) {
          const payload = JSON.stringify({
            message: error instanceof Error ? error.message : "读取队列状态失败"
          });
          write("error", payload);
        }
      };
      send();
      const interval = setInterval(send, 1500);
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(interval);
        try {
          controller.close();
        } catch {
          // The stream may already be closed by the runtime.
        }
      };
      request.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      cleanup();
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}
