"use client";

import { useEffect, useState } from "react";

type Invite = {
  id: number;
  code: string;
  used_by: number | null;
  used_at: string | null;
  disabled_at: string | null;
  expires_at: string | null;
  created_at: string;
};

type AdminUser = {
  id: number;
  username: string;
  role: "admin" | "user";
  disabled_at: string | null;
  created_at: string;
  active_sessions: number;
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) window.location.href = "/login";
  if (res.status === 403) window.location.href = "/";
  if (!res.ok) throw new Error(data.message || "请求失败");
  return data as T;
}

export default function AdminPage() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [passwords, setPasswords] = useState<Record<number, string>>({});
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function refresh() {
    const [inviteData, userData] = await Promise.all([
      api<{ invites: Invite[] }>("/api/admin/invites"),
      api<{ users: AdminUser[] }>("/api/admin/users")
    ]);
    setInvites(inviteData.invites);
    setUsers(userData.users);
  }

  useEffect(() => {
    refresh().catch((error) => setMessage(error instanceof Error ? error.message : "加载失败"));
  }, []);

  async function createInvite() {
    setLoading(true);
    setMessage("");
    try {
      const data = await api<{ invites: Invite[] }>("/api/admin/invites", { method: "POST", body: JSON.stringify({}) });
      setInvites(data.invites);
      setMessage("邀请码已生成");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "邀请码操作失败");
    } finally {
      setLoading(false);
    }
  }

  async function disableInvite(id: number) {
    const data = await api<{ invites: Invite[] }>("/api/admin/invites", { method: "POST", body: JSON.stringify({ action: "disable", id }) });
    setInvites(data.invites);
    setMessage("邀请码已禁用");
  }

  async function disableUser(id: number) {
    const data = await api<{ users: AdminUser[] }>("/api/admin/users", { method: "POST", body: JSON.stringify({ action: "disable", id }) });
    setUsers(data.users);
    setMessage("用户已禁用");
  }

  async function resetPassword(id: number) {
    const password = passwords[id] || "";
    const data = await api<{ users: AdminUser[] }>("/api/admin/users", { method: "POST", body: JSON.stringify({ action: "reset_password", id, password }) });
    setUsers(data.users);
    setPasswords((prev) => ({ ...prev, [id]: "" }));
    setMessage("密码已重置，旧 session 已失效");
  }

  return (
    <main className="admin-page">
      <div className="topbar">
        <div>
          <h1 className="title">管理员</h1>
          <p className="muted">邀请码和本地用户管理</p>
        </div>
        <a className="button-link" href="/">返回训练</a>
      </div>

      {message && <div className="notice">{message}</div>}

      <section className="section admin-section">
        <div className="topbar">
          <h2>邀请码</h2>
          <button className="primary" onClick={createInvite} disabled={loading}>{loading ? "生成中…" : "生成邀请码"}</button>
        </div>
        <div className="admin-table">
          {invites.map((invite) => (
            <div className="admin-row" key={invite.id}>
              <code>{invite.code}</code>
              <span>{invite.used_at ? `已使用 #${invite.used_by}` : invite.disabled_at ? "已禁用" : "可使用"}</span>
              <span>{new Date(invite.created_at).toLocaleString()}</span>
              <button disabled={Boolean(invite.used_at || invite.disabled_at)} onClick={() => disableInvite(invite.id)}>禁用</button>
            </div>
          ))}
          {invites.length === 0 && <p className="muted">还没有邀请码。</p>}
        </div>
      </section>

      <section className="section admin-section">
        <h2>用户</h2>
        <div className="admin-table">
          {users.map((user) => (
            <div className="admin-row user-admin-row" key={user.id}>
              <strong>{user.username}</strong>
              <span>{user.role === "admin" ? "管理员" : user.disabled_at ? "已禁用" : "普通用户"}</span>
              <span>sessions {user.active_sessions}</span>
              <input
                type="password"
                value={passwords[user.id] || ""}
                placeholder="新密码"
                onChange={(event) => setPasswords((prev) => ({ ...prev, [user.id]: event.target.value }))}
                disabled={Boolean(user.disabled_at)}
              />
              <button onClick={() => resetPassword(user.id)} disabled={(passwords[user.id] || "").length < 8 || Boolean(user.disabled_at)}>重置密码</button>
              <button className="danger" onClick={() => disableUser(user.id)} disabled={user.role === "admin" || Boolean(user.disabled_at)}>禁用</button>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
