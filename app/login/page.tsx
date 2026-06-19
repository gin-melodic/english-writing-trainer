"use client";

import { useState } from "react";
import TurnstileWidget from "@/app/components/TurnstileWidget";

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_CLOUDFLARE_TURNSTILE_SITE_KEY || "";

async function submitLogin(username: string, password: string, turnstileToken?: string) {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, turnstileToken }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || "登录失败");
}

const features = [
  {
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
    ),
    title: "六维能力评估",
    desc: "从时态、介词、定语从句、连词、被动语态到冠词，全面诊断你的语法薄弱点。",
  },
  {
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
        <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
      </svg>
    ),
    title: "每日自适应练习",
    desc: "系统根据你的薄弱维度智能出题，优先训练需要加强的知识点。",
  },
  {
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
      </svg>
    ),
    title: "AI 智能批改",
    desc: "基于 GLM-4.7-Flash 的即时评分、参考答案、错误标注与记忆口诀。",
  },
  {
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    ),
    title: "错题巩固复习",
    desc: "连续两次答对自动移除，让你把时间花在真正需要提升的地方。",
  },
  {
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 20V10" /><path d="M12 20V4" /><path d="M6 20v-6" />
      </svg>
    ),
    title: "进度可视化面板",
    desc: "雷达图、30天趋势线、错误分布和连续打卡天数，直观追踪学习轨迹。",
  },
];

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string>("");

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setMessage("");
    try {
      await submitLogin(username, password, turnstileToken || undefined);
      window.location.href = "/";
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "登录失败");
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
            {features.map((f) => (
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

      {/* Right — Login Form */}
      <div className="login-form-side">
        <form className="auth-panel" onSubmit={onSubmit}>
          <h2>欢迎回来</h2>
          <p className="muted">登录以继续你的训练</p>
          <label>用户名<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></label>
          <label>密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label>
          {TURNSTILE_SITE_KEY && (
            <TurnstileWidget siteKey={TURNSTILE_SITE_KEY} onTokenReady={setTurnstileToken} action="login" />
          )}
          <button className="primary" disabled={loading || !username.trim() || !password}>{loading ? "登录中…" : "登录"}</button>
          {message && <div className="notice">{message}</div>}
        </form>
        <p className="login-register-link">
          还没有账号？<a href="/register">使用邀请码注册</a>
        </p>
      </div>
    </div>
  );
}
