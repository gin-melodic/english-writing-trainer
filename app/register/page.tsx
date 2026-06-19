"use client";

import { useState } from "react";
import TurnstileWidget from "@/app/components/TurnstileWidget";

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_CLOUDFLARE_TURNSTILE_SITE_KEY || "";

export default function RegisterPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string>("");

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, inviteCode, turnstileToken }),
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
    <div className="login-landing">
      {/* Left — Brand + Features */}
      <div className="login-hero">
        <div className="login-hero-content">
          <div className="login-logo-badge">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
          </div>
          <h1 className="login-title">English Writing Trainer</h1>
          <p className="login-subtitle">面向中文母语者的中译英自适应训练系统</p>

          <div className="login-features">
            {[
              { icon: "⚡", title: "六维能力评估", desc: "从时态、介词、定语从句、连词、被动语态到冠词，全面诊断你的语法薄弱点。" },
              { icon: "📖", title: "每日自适应练习", desc: "系统根据你的薄弱维度智能出题，优先训练需要加强的知识点。" },
              { icon: "✍️", title: "AI 智能批改", desc: "基于 GLM-4.7-Flash 的即时评分、参考答案、错误标注与记忆口诀。" },
              { icon: "🎯", title: "错题巩固复习", desc: "连续两次答对自动移除，让你把时间花在真正需要提升的地方。" },
              { icon: "📊", title: "进度可视化面板", desc: "雷达图、30天趋势线、错误分布和连续打卡天数，直观追踪学习轨迹。" },
            ].map((f) => (
              <div key={f.title} className="login-feature-card">
                <span className="login-feature-icon">{f.icon}</span>
                <div>
                  <strong>{f.title}</strong>
                  <p>{f.desc}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="login-stats">
            <div className="login-stat">
              <span className="login-stat-value">6</span>
              <span className="login-stat-label">语法维度评估</span>
            </div>
            <div className="login-stat">
              <span className="login-stat-value">AI</span>
              <span className="login-stat-label">智能批改反馈</span>
            </div>
            <div className="login-stat">
              <span className="login-stat-value">∞</span>
              <span className="login-stat-label">自适应出题</span>
            </div>
          </div>
        </div>
      </div>

      {/* Right — Register Form */}
      <div className="login-form-side">
        <form className="auth-panel" onSubmit={onSubmit}>
          <h2>创建账号</h2>
          <p className="muted">使用邀请码注册并开始训练</p>
          <label>用户名<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></label>
          <label>密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" /></label>
          <span style={{ display: "flex", justifyContent: "space-between" }}>
            <label>邀请码</label>
            <a href="mailto:enginvi@ginmel.ai?subject=%E8%AF%B7%E6%B1%82%E8%8E%B7%E5%8F%96%20English%20Writing%20Trainer%20%E9%82%80%E8%AF%B7%E7%A0%81&body=%E4%BD%A0%E5%A5%BD%EF%BC%8C%0A%0A%E6%88%91%E6%83%B3%E7%94%B3%E8%AF%B7%E4%B8%80%E4%B8%AA%20English%20Writing%20Trainer%20%E7%9A%84%E6%B3%A8%E5%86%8C%E9%82%80%E8%AF%B7%E7%A0%81%E3%80%82%0A%0A%E8%B0%A2%E8%B0%A2%EF%BC%81">获取邀请码</a>
          </span>
          <input value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} />
          {TURNSTILE_SITE_KEY && (
            <TurnstileWidget siteKey={TURNSTILE_SITE_KEY} onTokenReady={setTurnstileToken} action="register" />
          )}
          <button className="primary" disabled={loading || !username.trim() || password.length < 8 || !inviteCode.trim()}>{loading ? "注册中…" : "注册并登录"}</button>
          {message && <div className="notice">{message}</div>}
        </form>
        <p className="login-register-link">
          已有账号？<a href="/login">返回登录</a>
        </p>
      </div>
    </div>
  );
}
