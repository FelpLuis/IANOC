import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { KeyRound, Loader2, LockKeyhole, UserRound } from 'lucide-react';
import { AiCore } from './AiCore';

export interface AuthUser {
  username: string;
  display_name?: string;
  role: string;
}

/**
 * Só monta o app (e abre o WebSocket) com sessão válida.
 * Login com usuário local da NIA (ex.: administrador master) ou do sistema NOC; quem valida
 * é o backend. Usuário local com troca de senha pendente vê só a tela de troca.
 */
export function AuthGate({ children }: { children: (user: AuthUser, logout: () => void) => ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [mustChange, setMustChange] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        setUser(data?.authenticated ? data.user : null);
        setMustChange(Boolean(data?.mustChangePassword));
      })
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
  }, []);

  const logout = () => {
    fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
      // Recarrega para fechar o WebSocket e limpar o estado do chat.
      .finally(() => window.location.reload());
  };

  if (checking) {
    return (
      <div className="relative flex min-h-[100dvh] items-center justify-center">
        <div className="hud-bg" />
        <AiCore size={64} state="thinking" />
      </div>
    );
  }
  if (!user) return <LoginForm onLogin={(u, troca) => { setUser(u); setMustChange(troca); }} />;
  if (mustChange) return <ChangePassword user={user} onDone={() => setMustChange(false)} onLogout={logout} />;
  return <>{children(user, logout)}</>;
}

function Shell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="relative flex min-h-[100dvh] items-center justify-center px-4">
      <div className="hud-bg" />
      <div className="glass hud-corners w-full max-w-sm space-y-5 rounded-2xl p-6 animate-reveal">
        <div className="flex items-center gap-3">
          <AiCore size={44} state="idle" />
          <div>
            <h1 className="text-lg font-bold tracking-[0.25em] neon-text" style={{ fontFamily: 'Orbitron, Inter, sans-serif' }}>{title}</h1>
            <p className="text-xs text-slate-400">{subtitle}</p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="hud-label">{label}</span>
      <input {...props} className="input mt-1" />
    </label>
  );
}

/** Tela de entrada na identidade da UpDown: logo, boas-vindas e o acesso do NOC. */
function WelcomeShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-[100dvh] flex-col items-center justify-center px-4 py-10">
      <div className="hud-bg" />
      <div className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(900px_520px_at_50%_-10%,rgba(26,0,168,0.75),transparent_70%)]" />
      <div className="w-full max-w-sm animate-reveal">
        <img src="/brand/updown-internet-branco.png" alt="UpDown Internet" className="mx-auto mb-8 h-auto w-56 drop-shadow-[0_8px_30px_rgba(18,186,234,0.25)] sm:w-64" />
        <div className="glass hud-corners space-y-5 rounded-2xl p-6">
          <div className="flex items-center gap-3">
            <AiCore size={44} state="idle" />
            <div>
              <h1 className="text-2xl font-bold text-white">Bem-vindo</h1>
              <p className="text-sm text-slate-300">à <span className="font-semibold text-cyan-300">NIA</span>, a assistente virtual do NOC</p>
            </div>
          </div>
          {children}
        </div>
        <p className="mt-6 text-center text-xs text-slate-400">UpDown Internet · Centro de Operações de Rede</p>
      </div>
    </div>
  );
}

function IconField({ label, icon, ...props }: { label: string; icon: ReactNode } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="hud-label">{label}</span>
      <span className="relative mt-1 block">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">{icon}</span>
        <input {...props} className="input pl-10" />
      </span>
    </label>
  );
}

function LoginForm({ onLogin }: { onLogin: (user: AuthUser, mustChange: boolean) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSending(true);
    setError(null);
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `Falha no login (HTTP ${r.status})`);
      setPassword('');
      onLogin(data.user, Boolean(data.mustChangePassword));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha no login');
    } finally {
      setSending(false);
    }
  };

  return (
    <WelcomeShell>
      <form onSubmit={submit} className="space-y-4">
        <IconField label="Usuário" icon={<UserRound className="h-4 w-4" />} autoFocus autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} />
        <IconField label="Senha" icon={<LockKeyhole className="h-4 w-4" />} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <p role="alert" className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</p>}
        <button type="submit" disabled={sending || !username || !password} className="btn-primary w-full py-2.5">
          {sending && <Loader2 className="h-4 w-4 animate-spin" />}
          Entrar
        </button>
      </form>
    </WelcomeShell>
  );
}

function ChangePassword({ user, onDone, onLogout }: { user: AuthUser; onDone: () => void; onLogout: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const regras = [
    { ok: next.length >= 10, txt: 'pelo menos 10 caracteres' },
    { ok: /[a-z]/.test(next) && /[A-Z]/.test(next), txt: 'letras maiúsculas e minúsculas' },
    { ok: /\d/.test(next), txt: 'pelo menos um número' },
    { ok: next.length > 0 && next === confirm, txt: 'confirmação igual' },
  ];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSending(true);
    setError(null);
    try {
      const r = await fetch('/api/auth/password', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current, next }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `Falha ao trocar a senha (HTTP ${r.status})`);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao trocar a senha');
    } finally {
      setSending(false);
    }
  };

  return (
    <Shell title="NIA" subtitle={`Primeiro acesso de ${user.display_name || user.username}`}>
      <div className="flex gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
        <KeyRound className="mt-0.5 h-4 w-4 flex-shrink-0" />
        Defina uma senha nova para continuar. A senha inicial deixa de valer.
      </div>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Senha atual" type="password" autoFocus autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        <Field label="Senha nova" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        <Field label="Confirme a senha nova" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <ul className="space-y-0.5 text-xs">
          {regras.map((r) => (
            <li key={r.txt} className={r.ok ? 'text-emerald-300' : 'text-slate-500'}>{r.ok ? '✓' : '·'} {r.txt}</li>
          ))}
        </ul>
        {error && <p className="text-sm text-red-300">{error}</p>}
        <button type="submit" disabled={sending || !current || regras.some((r) => !r.ok)} className="btn-primary w-full">
          {sending && <Loader2 className="h-4 w-4 animate-spin" />}
          Salvar e entrar
        </button>
        <button type="button" onClick={onLogout} className="btn-ghost w-full text-slate-400">Sair</button>
      </form>
    </Shell>
  );
}
