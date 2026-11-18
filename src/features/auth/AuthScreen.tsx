import BrandMark from '../../shared/ui/BrandMark';
import { useState, type FormEvent } from "react";
import { api } from "../../shared/api/api";

export type SignedInUser = {
  id: number;
  email: string;
  displayName: string;
  level: "viewer" | "trader" | "admin";
};

const BRAND_MARK = <BrandMark/>;

/** Decorative rising candles for the sign-in panel (deterministic, no data). */
const HERO_CANDLES = Array.from({ length: 60 }, (_, i) => {
  const base = 150 - i * 1.6 - Math.sin(i * 0.45) * 14;
  const open = base + Math.sin(i * 1.9) * 9;
  const close = base + Math.cos(i * 1.3) * 9 - 3;
  return { x: 6 + i * 16, open, close, high: Math.min(open, close) - 5 - (i % 3) * 3, low: Math.max(open, close) + 5 + (i % 4) * 2 };
});

const FEATURES: readonly [string, string][] = [
  ["TradingView-style charts", "Indicators, drawing tools and candle-accurate replays."],
  ["ADX + Supertrend bot", "Backtest it, then paper trade with exactly the same rules."],
  ["Forecast lab", "Quantile Boost models checked on held-back data before use."],
  ["Your keys stay on this machine", "Exchange credentials are stored encrypted, locally."],
];

export default function AuthScreen({
  configured,
  databaseError,
  onAuthenticated,
}: {
  configured: boolean;
  databaseError?: string | null;
  onAuthenticated: (user: SignedInUser) => void;
}) {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const values = new FormData(event.currentTarget);
    try {
      const result = await api<{ user: SignedInUser }>(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: values.get("email"),
          password: values.get("password"),
          ...(mode === "sign-up"
            ? { display_name: values.get("displayName") }
            : {}),
        }),
      });
      onAuthenticated(result.user);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className='auth-page'>
      <section className='auth-hero' aria-label='About Trading Workspace'>
        <div className='auth-brand'>
          <span className='brand-mark'>{BRAND_MARK}</span>
          <div>
            <strong>TRADING</strong>
            <small>WORKSPACE</small>
          </div>
        </div>
        <div className='auth-hero-copy'>
          <h2>Your markets. One trading workspace.</h2>
          <p>Explore perpetual markets, download history and test strategies before trading on your exchange account.</p>
          <ul className='auth-features'>
            {FEATURES.map(([title, detail]) => (
              <li key={title}>
                <span aria-hidden='true'>✓</span>
                <div>
                  <b>{title}</b>
                  <small>{detail}</small>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <svg className='auth-chart' viewBox='0 0 966 190' preserveAspectRatio='xMidYMid meet' aria-hidden='true'>
          {HERO_CANDLES.map((c) => {
            const up = c.close < c.open;
            return (
              <g key={c.x} className={up ? "up" : "down"}>
                <line x1={c.x + 4.5} x2={c.x + 4.5} y1={c.high} y2={c.low} />
                <rect x={c.x} y={Math.min(c.open, c.close)} width={9} height={Math.max(2, Math.abs(c.close - c.open))} rx={1} />
              </g>
            );
          })}
        </svg>
      </section>
      <section className='auth-card'>
        <div className='auth-brand'>
          <span className='brand-mark'>{BRAND_MARK}</span>
          <div>
            <strong>TRADING</strong>
            <small>WORKSPACE</small>
          </div>
        </div>
        {!configured || databaseError ? (
          <>
            <span className='ui-eyebrow'>DATABASE SETUP REQUIRED</span>
            <h1>{configured ? "MySQL sign-in failed" : "Connect MySQL"}</h1>
            <p>
              {databaseError ?? (
                <>
                  Copy <code>.env.example</code> to <code>.env</code>, enter
                  your MySQL connection values, run <code>start.cmd</code>, and
                  reload this page.
                </>
              )}
            </p>
            {databaseError && (
              <p className='auth-error' role='alert'>
                Update the MySQL user or password, then restart the app.
              </p>
            )}
          </>
        ) : (
          <>
            <span className='ui-eyebrow'>SECURE WORKSPACE</span>
            <h1>{mode === "sign-in" ? "Sign in" : "Create your account"}</h1>
            <p>
              {mode === "sign-in"
                ? "Access your trading workspace."
                : "The first account becomes Admin. Later accounts start at Trader level."}
            </p>
            <div className='auth-tabs' role='tablist'>
              <button
                type='button'
                aria-selected={mode === "sign-in"}
                onClick={() => {
                  setMode("sign-in");
                  setError("");
                }}
              >
                Sign in
              </button>
              <button
                type='button'
                aria-selected={mode === "sign-up"}
                onClick={() => {
                  setMode("sign-up");
                  setError("");
                }}
              >
                Sign up
              </button>
            </div>
            <form onSubmit={submit}>
              {mode === "sign-up" && (
                <label>
                  <span>Display name</span>
                  <input
                    name='displayName'
                    autoComplete='name'
                    minLength={2}
                    maxLength={80}
                    required
                  />
                </label>
              )}
              <label>
                <span>Email</span>
                <input
                  name='email'
                  type='email'
                  autoComplete='email'
                  required
                />
              </label>
              <label>
                <span>Password</span>
                <input
                  name='password'
                  type='password'
                  autoComplete={
                    mode === "sign-up" ? "new-password" : "current-password"
                  }
                  minLength={mode === "sign-up" ? 10 : 1}
                  required
                />
              </label>
              {error && (
                <p className='auth-error' role='alert'>
                  {error}
                </p>
              )}
              <button type='submit' disabled={busy}>
                {busy
                  ? "Please wait…"
                  : mode === "sign-in"
                    ? "Sign in"
                    : "Create account"}
              </button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
