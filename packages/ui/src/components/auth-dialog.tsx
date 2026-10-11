import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { AuthError } from "@localnotes/sync";

export interface AuthDialogProps {
  open: boolean;
  /** Pre-selects the create-account view, which is what a first-time user needs. */
  initialMode?: "sign-in" | "sign-up";
  onSignIn(email: string, password: string): Promise<void>;
  onSignUp(email: string, password: string, name: string): Promise<void>;
  onClose: () => void;
}

/**
 * Sign-in / sign-up.
 *
 * Both are the same form with a different endpoint, so they share one component
 * rather than duplicating validation. The dialog is dismissible and the app is
 * fully usable while it is closed: local notes never require an account.
 */
export function AuthDialog(props: AuthDialogProps): ReactNode {
  const [mode, setMode] = useState<AuthDialogProps["initialMode"]>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const emailId = useId();
  const passwordId = useId();
  const nameId = useId();
  const errorId = useId();
  const emailRef = useRef<HTMLInputElement | null>(null);

  if (!props.open) return null;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "sign-in") await props.onSignIn(email.trim(), password);
      else await props.onSignUp(email.trim(), password, name.trim() || email.split("@")[0] || "Notes");
      setPassword("");
      props.onClose();
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Something went wrong. Please try again.";
      const code = (caught as AuthError | undefined)?.code;
      setError(
        code === "unavailable"
          ? "Could not reach the sync server. Your notes are safe on this device."
          : message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ln-backdrop">
      <div
        className="ln-dialog ln-dialog-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${emailId}-title`}
      >
        <h2 id={`${emailId}-title`}>
          {mode === "sign-in" ? "Sign in to sync" : "Create a sync account"}
        </h2>
        <p>
          Your notes are stored on this device first. Signing in adds a backup and lets this device
          pick up changes from your others — nothing leaves the device until you do.
        </p>

        <form onSubmit={(event) => void submit(event)}>
          {mode === "sign-up" ? (
            <>
              <label className="ln-field" htmlFor={nameId}>
                <span>Name</span>
                <input
                  id={nameId}
                  value={name}
                  autoComplete="name"
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
            </>
          ) : null}

          <label className="ln-field" htmlFor={emailId}>
            <span>Email</span>
            <input
              id={emailId}
              ref={emailRef}
              type="email"
              required
              value={email}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>

          <label className="ln-field" htmlFor={passwordId}>
            <span>Password</span>
            <input
              id={passwordId}
              type="password"
              required
              minLength={8}
              value={password}
              autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              onChange={(event) => setPassword(event.target.value)}
            />
            {mode === "sign-up" ? (
              <small>At least 8 characters.</small>
            ) : null}
          </label>

          {error ? (
            <p className="ln-warning" role="alert" id={errorId}>
              {error}
            </p>
          ) : null}

          <div className="ln-dialog-actions ln-dialog-actions-split">
            <button
              type="button"
              className="ln-link"
              onClick={() => {
                setMode(mode === "sign-in" ? "sign-up" : "sign-in");
                setError(null);
              }}
            >
              {mode === "sign-in" ? "Create an account" : "I already have an account"}
            </button>
            <div className="ln-dialog-actions">
              <button type="button" className="ln-button" onClick={props.onClose} disabled={busy}>
                Not now
              </button>
              <button type="submit" className="ln-button ln-primary" disabled={busy}>
                {busy ? "Working…" : mode === "sign-in" ? "Sign in" : "Create account"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
