import {BB_MA_TYPES,BB_SOURCES} from './bollingerBands';
import {defaultIndicators,type IndicatorConfig,type MaSmoothing,type MaType,type SettingsKind} from './indicatorConfig';

type Config=IndicatorConfig;
export type ConfigKey=keyof Config;
type KeysOf<V>={[K in ConfigKey]-?:Config[K] extends V?K:never}[ConfigKey];
export type NumberKey=KeysOf<number>;
export type BooleanKey=KeysOf<boolean>;
/** String keys with a closed set of values (string literal unions). */
export type ChoiceKey={[K in ConfigKey]-?:Config[K] extends string?string extends Config[K]?never:K:never}[ConfigKey];
export type ColorKey=Extract<ConfigKey,`${string}Color`>;
export type WidthKey=Extract<ConfigKey,`${string}Width`>;

/** A label can depend on the draft, e.g. ADX zone colors that show the current levels. */
export type FieldLabel=string|((config:Config)=>string);

export type NumberField={type:'number';key:NumberKey;label:string;min?:number;max?:number;step?:number;integer?:boolean};
/** Distributed over the keys so `options` must match the key's value type. */
export type SelectField={[K in ChoiceKey]:{type:'select';key:K;label:string;options:readonly Config[K][];optionLabel?:(value:Config[K])=>string}}[ChoiceKey];
export type CheckField={type:'check';key:BooleanKey;label:string};
/** Read-only input shown for parity with TradingView (e.g. a fixed Close source). */
export type FixedField={type:'fixed';label:string;value:string};
export type NoteField={type:'note';text:string};
export type ColorField={type:'color';key:ColorKey;label:FieldLabel};
export type WidthField={type:'width';key:WidthKey;label?:string};

export type InputField=NumberField|SelectField|CheckField|FixedField|NoteField;
export type StyleField=ColorField|WidthField;
export type SettingsField=InputField|StyleField;

/** Cross-field constraint; `keys` are highlighted when it fails. */
export type SettingsRule={test:(config:Config)=>boolean;message:string;keys:readonly NumberKey[]};
export type IndicatorSchema={title:string;inputs:readonly InputField[];style:readonly StyleField[];rules?:readonly SettingsRule[]};
export type SettingsIssue={keys:readonly ConfigKey[];message:string};

export const LINE_WIDTHS=[1,2,3,4] as const;
const MA_SMOOTHINGS:readonly MaSmoothing[]=['RMA','SMA','EMA','WMA'];
const MA_TYPES:readonly MaType[]=['SMA','EMA'];

// Small builders keep the schema table readable.
const length=(key:NumberKey,label='Length'):NumberField=>({type:'number',key,label,min:1,max:1000,step:1,integer:true});
const level=(key:NumberKey,label:string):NumberField=>({type:'number',key,label,min:0,max:100,step:.5});
const color=(key:ColorKey,label:FieldLabel):ColorField=>({type:'color',key,label});
const width=(key:WidthKey):WidthField=>({type:'width',key});
const closeSource:FixedField={type:'fixed',label:'Source',value:'Close'};
const capitalize=(text:string)=>text[0].toUpperCase()+text.slice(1);

export const INDICATOR_SCHEMAS:Readonly<Record<SettingsKind,IndicatorSchema>>={
  zigzag:{
    title:'Zig Zag',
    inputs:[
      {type:'number',key:'zigzagDeviation',label:'Reversal (%)',min:.01,max:100,step:.1},
      {type:'note',text:'A close reversing by this percentage confirms a swing. The final leg follows new highs and lows.'},
    ],
    style:[color('zigzagColor','Zig Zag'),width('zigzagWidth')],
  },
  trendsma:{
    title:'MA',
    inputs:[length('trendSmaLength'),closeSource],
    style:[color('trendSmaColor','Plot'),width('trendSmaWidth')],
  },
  bollinger:{
    title:'BB',
    inputs:[
      {type:'number',key:'bbLength',label:'Length',min:1,step:1,integer:true}, // Unbounded, like validBollinger.
      {type:'select',key:'bbMaType',label:'Basis MA type',options:BB_MA_TYPES},
      {type:'select',key:'bbSource',label:'Source',options:BB_SOURCES,optionLabel:capitalize},
      {type:'number',key:'bbMultiplier',label:'StdDev',min:.001,max:50},
      {type:'number',key:'bbOffset',label:'Offset',min:-500,max:500,step:1,integer:true},
    ],
    style:[color('bbBasisColor','Basis'),color('bbUpperColor','Upper'),color('bbLowerColor','Lower'),width('bbWidth')],
  },
  supertrend:{
    title:'Supertrend',
    inputs:[length('supertrendLength','ATR length'),{type:'number',key:'supertrendMultiplier',label:'Factor',min:.01,max:100}],
    style:[color('stUpColor','Up trend'),color('stDownColor','Down trend'),width('stWidth')],
  },
  triplema:{
    title:'Triple MA',
    inputs:[
      {type:'select',key:'maType',label:'MA type',options:MA_TYPES},
      length('maFast','Fast length'),length('maMid','Middle length'),length('maSlow','Slow length'),
    ],
    style:[color('maFastColor','Fast MA'),color('maMidColor','Middle MA'),color('maSlowColor','Slow MA'),width('maWidth')],
  },
  rsi:{
    title:'RSI',
    inputs:[length('rsiLength','RSI length'),closeSource,level('rsiUpper','Upper band'),level('rsiLower','Lower band')],
    style:[color('rsiColor','RSI'),width('rsiWidth')],
    rules:[{test:c=>c.rsiLower<c.rsiUpper,message:'Lower band must be below the upper band.',keys:['rsiLower','rsiUpper']}],
  },
  adx:{
    title:'ADX Trend Strength',
    inputs:[
      length('diLength','DI length'),length('adxLength','ADX smoothing'),
      {type:'check',key:'showDi',label:'Display DI lines'},
      {type:'check',key:'showStatus',label:'Show trend label'},
      {type:'check',key:'showAdxLevels',label:'Show threshold lines'},
      level('adxTrendLevel','Level 1'),level('adxStrongLevel','Level 2'),
    ],
    style:[
      color('adxWeakColor',c=>`Weak (below ${c.adxTrendLevel})`),
      color('adxTrendColor',c=>`Trend (${c.adxTrendLevel}–${c.adxStrongLevel})`),
      color('adxStrongColor',c=>`Strong trend (${c.adxStrongLevel}+)`),
      width('adxWidth'),
      color('diPlusColor','+DI'),color('diMinusColor','−DI'),
      color('adxBullBgColor','Background +DI > −DI'),color('adxBearBgColor','Background −DI > +DI'),
    ],
    rules:[{test:c=>c.adxTrendLevel<c.adxStrongLevel,message:'Level 1 must be below level 2.',keys:['adxTrendLevel','adxStrongLevel']}],
  },
  atr:{
    title:'ATR',
    inputs:[
      length('atrLength'),
      {type:'select',key:'atrSmoothing',label:'Smoothing',options:MA_SMOOTHINGS},
      {type:'number',key:'atrThreshold',label:'Threshold',min:0},
    ],
    style:[color('atrColor','ATR'),width('atrWidth')],
  },
};

const SCHEMAS=Object.values(INDICATOR_SCHEMAS);
const STYLE_FIELDS=SCHEMAS.flatMap(schema=>schema.style);
const HEX_COLOR=/^#[0-9a-f]{6}$/i;

export const fieldLabel=(label:FieldLabel,config:Config)=>typeof label==='function'?label(config):label;
export const hasKey=(field:SettingsField):field is Extract<SettingsField,{key:ConfigKey}>=>'key' in field;
/** Every config key a dialog edits; used by "Reset settings". */
export const schemaKeys=(kind:SettingsKind):ConfigKey[]=>{
  const {inputs,style}=INDICATOR_SCHEMAS[kind];
  return [...inputs,...style].filter(hasKey).map(field=>field.key);
};

function range(min?:number,max?:number){
  return min!==undefined&&max!==undefined?`between ${min} and ${max}`:min!==undefined?`at least ${min}`:`at most ${max}`;
}
function inputIssue(field:InputField,config:Config):SettingsIssue|null{
  switch(field.type){
    case 'number':{
      const value=config[field.key];
      const fail=(message:string)=>({keys:[field.key],message:`${field.label} ${message}.`});
      if(typeof value!=='number'||!Number.isFinite(value))return fail('is required');
      if(field.integer&&!Number.isInteger(value))return fail('must be a whole number');
      if((field.min!==undefined&&value<field.min)||(field.max!==undefined&&value>field.max))return fail(`must be ${range(field.min,field.max)}`);
      return null;
    }
    case 'select':
      return (field.options as readonly unknown[]).includes(config[field.key])?null:{keys:[field.key],message:`Choose a ${field.label.toLowerCase()}.`};
    case 'check':
      return typeof config[field.key]==='boolean'?null:{keys:[field.key],message:`${field.label} must be on or off.`};
    default:
      return null;
  }
}

/** Input problems for one dialog, field checks first, then cross-field rules. */
export function validateSettings(kind:SettingsKind,config:Config):SettingsIssue[]{
  const {inputs,rules=[]}=INDICATOR_SCHEMAS[kind];
  const issues=inputs.map(field=>inputIssue(field,config)).filter(issue=>issue!==null);
  for(const rule of rules)if(!rule.test(config))issues.push({keys:rule.keys,message:rule.message});
  return issues;
}
export const isValidConfig=(config:Config)=>
  (Object.keys(INDICATOR_SCHEMAS) as SettingsKind[]).every(kind=>validateSettings(kind,config).length===0);

/** Bad style values fall back one by one; any bad input resets everything to defaults. */
export function normalizeIndicatorConfig(raw:unknown):IndicatorConfig{
  const config={...defaultIndicators,...(raw&&typeof raw==='object'?raw:{})} as Config;
  for(const field of STYLE_FIELDS){
    const value:unknown=config[field.key];
    const ok=field.type==='color'?typeof value==='string'&&HEX_COLOR.test(value):(LINE_WIDTHS as readonly unknown[]).includes(value);
    if(!ok)(config as Record<ConfigKey,unknown>)[field.key]=defaultIndicators[field.key];
  }
  return isValidConfig(config)?config:{...defaultIndicators};
}

const legacyStorageKey='silver.chart.indicatorSettings';
/** Settings saved before per-study configs existed; seeds new studies. */
export function readIndicatorSettings():IndicatorConfig{
  try{return normalizeIndicatorConfig(JSON.parse(localStorage.getItem(legacyStorageKey)??'{}'));}
  catch{return {...defaultIndicators};}
}
