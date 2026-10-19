import {useState} from 'react';
import type {BacktestSettings} from '../../shared/types/types';
import {STRATEGY_LABELS} from './strategyDefaults';

export type SavedSetup={name:string;settings:BacktestSettings};

/** Choose one of the user's saved bot setups and apply it in place. */
export default function SetupPicker({profiles,onApply,label='Saved setup',disabled=false,actionLabel}:{profiles:SavedSetup[];onApply:(setup:SavedSetup)=>void;label?:string;disabled?:boolean;actionLabel?:string}){
  const [selected,setSelected]=useState('');
  if(!profiles.length)return <div className="setup-picker is-empty"><span>{label}</span><small>No saved setups yet — save one in Bot settings.</small></div>;
  const chosen=profiles.find(profile=>profile.name===selected);
  return <div className="setup-picker">
    <label><span>{label}</span>
      <select value={selected} disabled={disabled} onChange={event=>{setSelected(event.target.value);if(!actionLabel){const setup=profiles.find(profile=>profile.name===event.target.value);if(setup)onApply(setup);}}}>
        <option value="">Choose a saved setup…</option>
        {profiles.map(profile=><option key={profile.name} value={profile.name}>{profile.name} · {STRATEGY_LABELS[profile.settings.strategy]??profile.settings.strategy} · {profile.settings.entry_timeframe}</option>)}
      </select>
    </label>
    {actionLabel&&<button type="button" className="secondary" disabled={disabled||!chosen} onClick={()=>chosen&&onApply(chosen)}>{actionLabel}</button>}
  </div>;
}
