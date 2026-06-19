import { NextResponse } from "next/server";

const ALLOWED_WEBLLM_MODEL_HOSTS = new Set(["huggingface.co", "hf-mirror.com"]);

function decodeBaseUrl(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function contentTypeFor(pathname: string) {
  if (pathname.endsWith(".json")) return "application/json; charset=utf-8";
  if (pathname.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (pathname.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

async function proxyWebLlmModelFile(request: Request, path: string[], method: "GET" | "HEAD") {
  if (path.length < 2) {
    return NextResponse.json({ message: "WebLLM proxy path is incomplete" }, { status: 400 });
  }

  const upstreamBase = new URL(decodeBaseUrl(path[0]));
  if (!["https:", "http:"].includes(upstreamBase.protocol) || !ALLOWED_WEBLLM_MODEL_HOSTS.has(upstreamBase.hostname)) {
    return NextResponse.json({ message: "WebLLM model mirror is not allowed" }, { status: 400 });
  }

  const upstreamPath = path.slice(1).map((segment) => encodeURIComponent(segment)).join("/");
  const upstreamUrl = new URL(`${upstreamBase.pathname.replace(/\/+$/, "")}/${upstreamPath}`, upstreamBase);
  const upstreamHeaders = new Headers({
    "Accept-Encoding": "identity",
    "User-Agent": "english-writing-trainer-webllm-proxy"
  });
  for (const name of ["range", "if-none-match", "if-modified-since"]) {
    const value = request.headers.get(name);
    if (value) upstreamHeaders.set(name, value);
  }
  const upstreamResponse = await fetch(upstreamUrl, { method, headers: upstreamHeaders });

  if (!upstreamResponse.ok && upstreamResponse.status !== 304) {
    return NextResponse.json({ message: `WebLLM model mirror returned ${upstreamResponse.status}` }, { status: upstreamResponse.status });
  }

  const headers = new Headers();
  for (const name of ["accept-ranges", "content-length", "content-range", "etag", "last-modified"]) {
    const value = upstreamResponse.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("Content-Type", contentTypeFor(upstreamUrl.pathname));
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(method === "HEAD" ? null : upstreamResponse.body, { status: upstreamResponse.status, headers });
}

export async function GET(request: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  try {
    const path = (await params).path || [];
    return proxyWebLlmModelFile(request, path, "GET");
  } catch {
    return NextResponse.json({ message: "WebLLM model proxy failed" }, { status: 500 });
  }
}

export async function HEAD(request: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  try {
    const path = (await params).path || [];
    return proxyWebLlmModelFile(request, path, "HEAD");
  } catch {
    return NextResponse.json({ message: "WebLLM model proxy failed" }, { status: 500 });
  }
}
