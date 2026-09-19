import { useState } from 'react';
import type { FormEvent } from 'react';
import { useAuthActions } from '@convex-dev/auth/react';
import { errorMessage } from '../lib/errorMessage';

export function SignIn() {
  const { signIn } = useAuthActions();
  const [flow, setFlow] = useState<'signIn' | 'signUp'>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = flow === 'signIn' ? 'Sign in' : 'Create account';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await signIn('password', { email, password, flow });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="auth">
      <form className="auth-form" onSubmit={(event) => { void submit(event); }}>
        <h1>{title}</h1>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="email" required value={email}
          onChange={(event) => setEmail(event.target.value)} disabled={pending} />
        <label htmlFor="password">Password</label>
        <input id="password" type="password" autoComplete={flow === 'signIn' ? 'current-password' : 'new-password'}
          required value={password} onChange={(event) => setPassword(event.target.value)} disabled={pending} />
        {error && <p className="notice error" role="alert">{error}</p>}
        <button className="btn primary" type="submit" disabled={pending}>{pending ? 'Please wait…' : title}</button>
        <button className="btn" type="button" disabled={pending} onClick={() => {
          setFlow(flow === 'signIn' ? 'signUp' : 'signIn');
          setError(null);
        }}>
          {flow === 'signIn' ? 'Create account' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
