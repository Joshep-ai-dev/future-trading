import type {ReactNode} from 'react';
import type {IndicatorConfig} from './indicatorConfig';
import {fieldLabel,LINE_WIDTHS,type ConfigKey,type SettingsField} from './indicatorSchema';

export type FieldChange=<K extends ConfigKey>(key:K,value:IndicatorConfig[K])=>void;

function Row({label,children}:{label:string;children:ReactNode}){
  return <label className="tv-dialog-row"><span>{label}</span><span className="tv-dialog-control">{children}</span></label>;
}

/** Renders one schema field with the shared TradingView dialog controls. */
export default function SettingsFieldControl({field,config,invalid,onChange}:{field:SettingsField;config:IndicatorConfig;invalid:boolean;onChange:FieldChange}){
  switch(field.type){
    case 'number':{
      const value=config[field.key];
      return <Row label={field.label}>
        <input type="number" min={field.min} max={field.max} step={field.step??'any'}
          value={Number.isFinite(value)?value:''} aria-invalid={invalid}
          onChange={event=>onChange(field.key,event.target.valueAsNumber)}/>
      </Row>;
    }
    case 'select':{
      const options=field.options as readonly string[];
      const optionLabel=(field.optionLabel??String) as (value:string)=>string;
      return <Row label={field.label}>
        <select value={config[field.key]} aria-invalid={invalid}
          onChange={event=>onChange(field.key,event.target.value as IndicatorConfig[typeof field.key])}>
          {options.map(option=><option key={option} value={option}>{optionLabel(option)}</option>)}
        </select>
      </Row>;
    }
    case 'check':
      return <label className="tv-dialog-check">
        <input type="checkbox" checked={config[field.key]} onChange={event=>onChange(field.key,event.target.checked)}/>{field.label}
      </label>;
    case 'fixed':
      return <Row label={field.label}><select disabled value={field.value}><option value={field.value}>{field.value}</option></select></Row>;
    case 'note':
      return <p className="tv-dialog-note">{field.text}</p>;
    case 'color':{
      const label=fieldLabel(field.label,config);
      return <Row label={label}>
        <span className="tv-color"><input type="color" value={config[field.key]} aria-label={`${label} color`} onChange={event=>onChange(field.key,event.target.value)}/></span>
      </Row>;
    }
    case 'width':{
      const label=field.label??'Line thickness';
      return <Row label={label}>
        <span className="tv-widths" role="radiogroup" aria-label={label}>
          {LINE_WIDTHS.map(width=><button type="button" key={width} role="radio" aria-checked={config[field.key]===width} title={`${width}px`} onClick={()=>onChange(field.key,width)}><i style={{height:width}}/></button>)}
        </span>
      </Row>;
    }
  }
}
