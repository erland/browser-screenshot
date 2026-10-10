import { FormEvent, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  createScreenshot,
  getCurrentUser,
  getLinkedIdentities,
  unlinkGoogle,
  type LinkedIdentity,
  getScreenshotPresets,
  logout,
  type AuthenticatedUser,
  type ScreenshotMetadata,
  type ScreenshotPresetsResponse,
} from './api';
import { screenshotPayloadFromForm, type ScreenshotFormState, type ViewportSelection } from './form';

type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'forbidden'; message: string }
  | { status: 'authenticated'; user: AuthenticatedUser };

const DEFAULT_FORM: ScreenshotFormState = {
  url: '',
  viewport: 'desktop',
  width: '1440',
  height: '900',
  deviceScaleFactor: '1',
  fullPage: false,
};

function formatDuration(value: number | null): string {
  if (value === null) return '–';
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Något gick fel.';
}

export function App() {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [identities, setIdentities] = useState<LinkedIdentity[]>([]);
  const [unlinkBusy, setUnlinkBusy] = useState(false);
  const [presets, setPresets] = useState<ScreenshotPresetsResponse | null>(null);
  const [form, setForm] = useState<ScreenshotFormState>(DEFAULT_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<ScreenshotMetadata | null>(null);

  useEffect(() => {
    fetch('/api/auth/providers').then(r => r.ok ? r.json() : null)
      .then((value: { google?: boolean } | null) => setGoogleEnabled(value?.google === true))
      .catch(() => setGoogleEnabled(false));
  }, []);

  useEffect(() => {
    let active = true;
    getCurrentUser()
      .then((user) => {
        if (active) setAuth({ status: 'authenticated', user });
      })
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof ApiError && err.status === 403) {
          setAuth({ status: 'forbidden', message: err.message });
        } else {
          setAuth({ status: 'anonymous' });
        }
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (auth.status !== 'authenticated') return;
    let active = true;
    getLinkedIdentities().then(items => { if (active) setIdentities(items); })
      .catch(() => { if (active) setIdentities([]); });
    return () => { active = false; };
  }, [auth.status]);

  useEffect(() => {
    if (auth.status !== 'authenticated') return;
    let active = true;
    getScreenshotPresets()
      .then((value) => { if (active) setPresets(value); })
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof ApiError && err.status === 401) setAuth({ status: 'anonymous' });
        else if (err instanceof ApiError && err.status === 403) setAuth({ status: 'forbidden', message: err.message });
        else setError(errorMessage(err));
      });
    return () => { active = false; };
  }, [auth.status]);

  useEffect(() => () => {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
  }, [resultUrl]);

  const selectedPreset = useMemo(() => {
    if (!presets || form.viewport === 'custom') return null;
    return presets.presets[form.viewport];
  }, [form.viewport, presets]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const payload = screenshotPayloadFromForm(form);
      const result = await createScreenshot(payload);
      if (resultUrl) URL.revokeObjectURL(resultUrl);
      const objectUrl = URL.createObjectURL(result.blob);
      setResultUrl(objectUrl);
      setMetadata(result.metadata);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setAuth({ status: 'anonymous' });
      else if (err instanceof ApiError && err.status === 403 && err.code === 'AUTH_NOT_ALLOWED') {
        setAuth({ status: 'forbidden', message: err.message });
      } else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function disconnectGoogle() {
    if (!window.confirm('Vill du koppla bort Google från ditt konto? Du kan fortsätta logga in med GitHub.')) return;
    setUnlinkBusy(true);
    setError(null);
    try {
      await unlinkGoogle();
      setIdentities(await getLinkedIdentities());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUnlinkBusy(false);
    }
  }

  async function signOut() {
    setError(null);
    try {
      await logout();
      setAuth({ status: 'anonymous' });
      setPresets(null);
      if (resultUrl) URL.revokeObjectURL(resultUrl);
      setResultUrl(null);
      setMetadata(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (auth.status === 'loading') {
    return <main className="auth-shell"><div className="auth-card"><div className="spinner" aria-label="Laddar" /><p>Kontrollerar inloggning…</p></div></main>;
  }

  if (auth.status === 'anonymous') {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <p className="eyebrow">Browser Screenshot</p>
          <h1>Skärmdumpar av webbsidor, på begäran.</h1>
          <p className="lede">Logga in med GitHub eller Google. Endast e-postadresser som finns i tjänstens allowlist får använda screenshot-funktionen.</p>
          <a className="button primary full" href="/auth/login">Logga in med GitHub</a>
          {googleEnabled && <a className="button secondary full" href="/auth/login/google">Logga in med Google</a>}
        </section>
      </main>
    );
  }

  if (auth.status === 'forbidden') {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <p className="eyebrow">Browser Screenshot</p>
          <h1>Åtkomst saknas</h1>
          <p className="lede">{auth.message}</p>
          <div className="button-row">
            <a className="button primary" href="/auth/login">Försök med ett annat konto</a>
            <button className="button secondary" type="button" onClick={signOut}>Logga ut</button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="brand">Browser Screenshot</p>
          <p className="subtitle">Öppna en publik webbsida i Chromium och få tillbaka en PNG.</p>
        </div>
        <div className="account">
          <div className="account-copy"><strong>{auth.user.provider === "google" ? "Google-konto" : `@${auth.user.githubLogin}`}</strong><span>{auth.user.email}</span></div>
          <button className="button ghost" type="button" onClick={signOut}>Logga ut</button>
        </div>
      </header>

      <section className="panel" aria-label="Inloggningskonton">
        <div className="panel-heading">
          <h2>Inloggningskonton</h2>
          <p>Hantera vilka inloggningssätt som hör till ditt konto.</p>
        </div>
        {identities.map(identity => <p key={identity.provider}>
          <strong>{identity.provider === 'google' ? 'Google' : 'GitHub'}</strong>
          {identity.email ? ` – ${identity.email}` : ''}
        </p>)}
        {auth.user.provider !== 'google' && googleEnabled &&
          !identities.some(identity => identity.provider === 'google') &&
          <a className="button secondary" href="/auth/link/google">Koppla Google-konto</a>}
        {auth.user.provider !== 'google' &&
          identities.some(identity => identity.provider === 'google') &&
          <button type="button" className="button secondary" disabled={unlinkBusy}
            onClick={disconnectGoogle}>{unlinkBusy ? 'Kopplar bort…' : 'Koppla bort Google'}</button>}
      </section>
      <main className="workspace">
        <section className="panel controls-panel">
          <div className="panel-heading">
            <p className="eyebrow">Ny skärmdump</p>
            <h1>Vad vill du visa?</h1>
            <p>Ange adress och välj en vanlig enhetsstorlek eller ett eget viewportmått.</p>
          </div>

          <form onSubmit={submit} className="form-stack">
            <label className="field">
              <span>URL</span>
              <input
                type="url"
                inputMode="url"
                placeholder="https://example.com"
                value={form.url}
                onChange={(event) => setForm({ ...form, url: event.target.value })}
                required
                disabled={busy}
              />
            </label>

            <fieldset className="fieldset" disabled={busy || !presets}>
              <legend>Viewport</legend>
              <div className="preset-grid">
                {(['desktop', 'tablet', 'mobile', 'custom'] as ViewportSelection[]).map((option) => {
                  const preset = option === 'custom' ? null : presets?.presets[option];
                  const label = option === 'desktop' ? 'Desktop' : option === 'tablet' ? 'Tablet' : option === 'mobile' ? 'Mobil' : 'Egen';
                  const detail = preset ? `${preset.width} × ${preset.height}` : 'Ange mått';
                  return (
                    <label key={option} className={`preset-card ${form.viewport === option ? 'selected' : ''}`}>
                      <input
                        type="radio"
                        name="viewport"
                        value={option}
                        checked={form.viewport === option}
                        onChange={() => setForm({ ...form, viewport: option })}
                      />
                      <span className="preset-label">{label}</span>
                      <span className="preset-detail">{detail}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            {form.viewport === 'custom' && (
              <div className="custom-grid">
                <label className="field"><span>Bredd</span><input type="number" min={presets?.limits.minWidth ?? 1} max={presets?.limits.maxWidth ?? 4096} value={form.width} onChange={(event) => setForm({ ...form, width: event.target.value })} disabled={busy} /></label>
                <label className="field"><span>Höjd</span><input type="number" min={presets?.limits.minHeight ?? 1} max={presets?.limits.maxHeight ?? 4096} value={form.height} onChange={(event) => setForm({ ...form, height: event.target.value })} disabled={busy} /></label>
                <label className="field"><span>Skalfaktor</span><input type="number" step="0.25" min={presets?.limits.minDeviceScaleFactor ?? 0.5} max={presets?.limits.maxDeviceScaleFactor ?? 3} value={form.deviceScaleFactor} onChange={(event) => setForm({ ...form, deviceScaleFactor: event.target.value })} disabled={busy} /></label>
              </div>
            )}

            {selectedPreset && <p className="hint">Vald viewport: {selectedPreset.width} × {selectedPreset.height}, skalfaktor {selectedPreset.deviceScaleFactor}.</p>}

            <label className="toggle-row">
              <input type="checkbox" checked={form.fullPage} onChange={(event) => setForm({ ...form, fullPage: event.target.checked })} disabled={busy} />
              <span><strong>Hela sidan</strong><small>Fånga hela dokumentets höjd i stället för bara viewporten.</small></span>
            </label>

            {error && <div className="error-banner" role="alert">{error}</div>}

            <button className="button primary full" type="submit" disabled={busy || !presets}>
              {busy ? <><span className="button-spinner" /> Skapar skärmdump…</> : 'Skapa skärmdump'}
            </button>
          </form>
        </section>

        <section className="panel preview-panel" aria-live="polite">
          {resultUrl ? (
            <>
              <div className="preview-header">
                <div><p className="eyebrow">Resultat</p><h2>Skärmdump klar</h2></div>
                <a className="button secondary" href={resultUrl} download="screenshot.png">Hämta PNG</a>
              </div>
              <div className="image-frame"><img src={resultUrl} alt="Genererad skärmdump" /></div>
              {metadata && (
                <dl className="metadata-grid">
                  <div><dt>Bild</dt><dd>{metadata.width ?? '–'} × {metadata.height ?? '–'} px</dd></div>
                  <div><dt>Viewport</dt><dd>{metadata.viewportWidth ?? '–'} × {metadata.viewportHeight ?? '–'}</dd></div>
                  <div><dt>Skala</dt><dd>{metadata.deviceScaleFactor ?? '–'}×</dd></div>
                  <div><dt>Tid</dt><dd>{formatDuration(metadata.durationMs)}</dd></div>
                </dl>
              )}
            </>
          ) : (
            <div className="empty-state">
              <div className="empty-illustration" aria-hidden="true"><span /><span /><span /></div>
              <h2>Resultatet visas här</h2>
              <p>När skärmdumpen är klar kan du förhandsgranska den och hämta PNG-filen direkt.</p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
