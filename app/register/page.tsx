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
        <span style={{ display: "flex", justifyContent: "space-between" }}>
          <label>邀请码</label>
          <a href="mailto:enginvi@ginmel.ai?subject=%E8%AF%B7%E6%B1%82%E8%8E%B7%E5%8F%96%20English%20Writing%20Trainer%20%E9%82%80%E8%AF%B7%E7%A0%81&body=%E4%BD%A0%E5%A5%BD%EF%BC%8C%0A%0A%E6%88%91%E6%83%B3%E7%94%B3%E8%AF%B7%E4%B8%80%E4%B8%AA%20English%20Writing%20Trainer%20%E7%9A%84%E6%B3%A8%E5%86%8C%E9%82%80%E8%AF%B7%E7%A0%81%E3%80%82%0A%0A%E8%B0%A2%E8%B0%A2%EF%BC%81">获取邀请码</a>
        </span>
        <input value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} />
        <button className="primary" disabled={loading || !username.trim() || password.length < 8 || !inviteCode.trim()}>{loading ? "注册中…" : "注册并登录"}</button>
        {message && <div className="notice">{message}</div>}
        <a href="/login">返回登录</a>
      </form>
    </main>
  );
}
