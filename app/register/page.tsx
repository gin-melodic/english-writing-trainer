"use client";

import { useState } from "react";

export default function RegisterPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, inviteCode })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "注册失败");
      window.location.href = "/";
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "注册失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-page">
      <form className="auth-panel" onSubmit={onSubmit}>
        <h1>注册</h1>
        <label>用户名<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></label>
        <label>密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" /></label>
        <label>邀请码<input value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} /></label>
        <button className="primary" disabled={loading || !username.trim() || password.length < 8 || !inviteCode.trim()}>{loading ? "注册中…" : "注册并登录"}</button>
        {message && <div className="notice">{message}</div>}
        <a href="/login">返回登录</a>
      </form>
    </main>
  );
}
