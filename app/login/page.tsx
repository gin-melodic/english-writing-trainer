"use client";

import { useState } from "react";

async function submitLogin(username: string, password: string) {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || "登录失败");
}

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setMessage("");
    try {
      await submitLogin(username, password);
      window.location.href = "/";
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "登录失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-page">
      <form className="auth-panel" onSubmit={onSubmit}>
        <h1>登录</h1>
        <label>用户名<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></label>
        <label>密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label>
        <button className="primary" disabled={loading || !username.trim() || !password}>{loading ? "登录中…" : "登录"}</button>
        {message && <div className="notice">{message}</div>}
        <a href="/register">使用邀请码注册</a>
      </form>
    </main>
  );
}
