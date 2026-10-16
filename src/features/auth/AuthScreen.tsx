import {useState,type FormEvent} from 'react';
import {api} from '../../shared/api/api';

export type SignedInUser={id:number;email:string;displayName:string;level:'viewer'|'trader'|'admin'};

export default function AuthScreen({configured,databaseError,onAuthenticated}:{configured:boolean;databaseError?:string|null;onAuthenticated:(user:SignedInUser)=>void}){
  const [mode,setMode]=useState<'sign-in'|'sign-up'>('sign-in');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();setBusy(true);setError('');
    const values=new FormData(event.currentTarget);
    try{
      const result=await api<{user:SignedInUser}>(`/api/auth/${mode}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:values.get('email'),password:values.get('password'),...(mode==='sign-up'?{display_name:values.get('displayName')}:{})})});
      onAuthenticated(result.user);
    }catch(reason){setError(String(reason));}finally{setBusy(false);}
  }
  return <main className="auth-page"><section className="auth-card">
    <div className="auth-brand"><span className="brand-mark">↗</span><div><strong>SILVER</strong><small>TRADING WORKSPACE</small></div></div>
    {!configured||databaseError?<><span className="ui-eyebrow">DATABASE SETUP REQUIRED</span><h1>{configured?'MySQL sign-in failed':'Connect MySQL'}</h1><p>{databaseError??<>Copy <code>.env.example</code> to <code>.env</code>, enter your MySQL connection values, run <code>start.cmd</code>, and reload this page.</>}</p>{databaseError&&<p className="auth-error" role="alert">Update the MySQL user or password, then restart the app.</p>}</>:<>
      <span className="ui-eyebrow">SECURE WORKSPACE</span><h1>{mode==='sign-in'?'Sign in':'Create your account'}</h1><p>{mode==='sign-in'?'Access your trading workspace.':'The first account becomes Admin. Later accounts start at Trader level.'}</p>
      <div className="auth-tabs" role="tablist"><button type="button" aria-selected={mode==='sign-in'} onClick={()=>{setMode('sign-in');setError('');}}>Sign in</button><button type="button" aria-selected={mode==='sign-up'} onClick={()=>{setMode('sign-up');setError('');}}>Sign up</button></div>
      <form onSubmit={submit}>{mode==='sign-up'&&<label><span>Display name</span><input name="displayName" autoComplete="name" minLength={2} maxLength={80} required/></label>}<label><span>Email</span><input name="email" type="email" autoComplete="email" required/></label><label><span>Password</span><input name="password" type="password" autoComplete={mode==='sign-up'?'new-password':'current-password'} minLength={mode==='sign-up'?10:1} required/></label>{error&&<p className="auth-error" role="alert">{error}</p>}<button type="submit" disabled={busy}>{busy?'Please wait…':mode==='sign-in'?'Sign in':'Create account'}</button></form>
    </>}
  </section></main>;
}
