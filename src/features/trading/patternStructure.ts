import type {PatternCandle} from './patternRange';
import type {ReferenceMatch} from './patternSimilarity';

export type StructureCheck={label:string;passed:boolean;detail:string};
export type PatternAssessment={status:'confirmed'|'forming'|'rejected'|'unverified';checks:StructureCheck[];level:number|null;breakout:boolean};
type Swing={index:number;value:number;high:boolean};

/** Local extrema must reverse by at least 12% of the selected price range.
 * Same-side extrema are consolidated. Ambiguous high+low candles are skipped:
 * OHLC cannot establish which extreme occurred first within that candle.
 */
function swings(rows:readonly PatternCandle[],from:number,to:number,range:number,sign=1):Swing[]{
  const radius=Math.max(1,Math.min(4,Math.floor((to-from)/16))),found:Swing[]=[];
  const high=(i:number)=>sign===1?rows[i].high!:-rows[i].low!;
  const low=(i:number)=>sign===1?rows[i].low!:-rows[i].high!;
  for(let i=from+radius;i<=to-radius;i++){
    let isHigh=true,isLow=true;
    for(let j=i-radius;j<=i+radius;j++)if(j!==i){isHigh&&=j<i?high(i)>high(j):high(i)>=high(j);isLow&&=j<i?low(i)<low(j):low(i)<=low(j);}
    if(isHigh===isLow)continue;
    const next={index:i,value:isHigh?high(i):low(i),high:isHigh},previous=found.at(-1);
    if(previous?.high===next.high){if(next.high?next.value>previous.value:next.value<previous.value)found[found.length-1]=next;}
    else if(!previous||Math.abs(next.value-previous.value)>=range*.12)found.push(next);
  }
  return found;
}
function line(points:Swing[]):{at:(index:number)=>number;slope:number;error:number}|null{
  if(points.length<2)return null;
  const x=points.reduce((sum,p)=>sum+p.index,0)/points.length,y=points.reduce((sum,p)=>sum+p.value,0)/points.length;
  const denominator=points.reduce((sum,p)=>sum+(p.index-x)**2,0);
  if(!denominator)return null;
  const slope=points.reduce((sum,p)=>sum+(p.index-x)*(p.value-y),0)/denominator;
  const at=(index:number)=>y+slope*(index-x);
  return {at,slope,error:Math.max(...points.map(p=>Math.abs(at(p.index)-p.value)))};
}

/** Rule-based OHLC checks are independent of the schematic's time-warped fit.
 * 'confirmed' means these explicit rules and the final closing breakout passed;
 * it is not a guarantee of future price direction. Unsupported families remain
 * unverified, rather than acquiring a confirmation from their template stage.
 */
export function assessPatternStructure(candles:readonly PatternCandle[],match:ReferenceMatch):PatternAssessment{
  const rows=candles.slice(match.start,match.start+match.length),checks:StructureCheck[]=[];
  const check=(label:string,passed:boolean,detail:string)=>checks.push({label,passed,detail});
  const out=(status:PatternAssessment['status'],level:number|null=null,breakout=false)=>({status,checks,level,breakout});
  check('Enough candles',rows.length>=20,`${rows.length} candles; at least 20 required for structural checks.`);
  const valid=rows.every(row=>Number.isFinite(row.high)&&Number.isFinite(row.low)&&Number.isFinite(row.close)&&row.low!>0&&row.low!<=row.close&&row.high!>=row.close);
  check('OHLC available',valid,'Uses actual candle highs, lows and completed closes.');
  if(rows.length<20||!valid)return out('unverified');
  const max=Math.max(...rows.map(row=>row.high!)),min=Math.min(...rows.map(row=>row.low!)),range=max-min,n=rows.length;
  if(range<=0)return out('rejected');
  check('Distinct from random curves',match.confidence>=95,`${Math.round(match.confidence)}% random-walk percentile; 95% minimum (not a success probability).`);
  check('Close geometric fit',match.fit>=80,`${Math.round(match.fit)}/100 fit; 80 minimum.`);
  const family=match.pattern.family;
  if(['double','triple','shoulders'].includes(family)){
    const sign=match.pattern.inverted?-1:1;
    const turns=swings(rows,0,n-1,range,sign),peaks=turns.filter(p=>p.high),expected=family==='double'?2:3;
    check('Swing sequence',peaks.length===expected,`${peaks.length} prominent ${sign===1?'peaks':'troughs'}; ${expected} required.`);
    if(peaks.length!==expected)return out('rejected');
    const valleys=turns.filter(p=>!p.high&&p.index>peaks[0].index&&p.index<peaks.at(-1)!.index);
    check('Intervening swings',valleys.length===expected-1,'Each test must be separated by a significant opposite swing.');
    if(valleys.length!==expected-1)return out('rejected');
    check('Prior trend',sign*rows[peaks[0].index].close-sign*rows[0].close>=range*.18,'The first test must follow a directional move of at least 18% of this range.');
    if(family==='shoulders'){
      check('Higher head / lower inverse head',peaks[1].value-Math.max(peaks[0].value,peaks[2].value)>=range*.12,'The head must extend at least 12% of the selected range beyond both shoulders.');
      check('Shoulder symmetry',Math.abs(peaks[0].value-peaks[2].value)<=range*.15,'Shoulder heights must agree within 15% of the selected range.');
    }else{
      check('Repeated test level',Math.max(...peaks.map(p=>p.value))-Math.min(...peaks.map(p=>p.value))<=range*.1,'Tests must agree within 10% of the selected range.');
    }
    check('Pullback depth',valleys.every(v=>Math.min(...peaks.map(p=>p.value))-v.value>=range*.2),'Each pullback must span at least 20% of the selected range.');
    const neck=valleys.length===1?{at:()=>valleys[0].value}:line(valleys)!;
    const level=neck.at(n-1),last=sign*rows.at(-1)!.close;
    const breakout=last<level-range*.02&&n-1>peaks.at(-1)!.index;
    const failed=checks.some(item=>!item.passed);
    check('Closing neckline break',breakout,'The final completed candle must close beyond the neckline by 2% of the selected range.');
    return out(failed?'rejected':breakout?'confirmed':'forming',sign*level,breakout);
  }
  if(!['flag','pennant','triangle','wedge','rectangle','channel'].includes(family)){
    check('Structure rule implemented',false,'This family currently has schematic comparison only; no verified structural classification.');
    return out('unverified');
  }
  const impulse=['flag','pennant'].includes(family)&&match.pattern.id!=='symmetrical-triangle';
  let from=0;
  if(impulse){
    const sign=match.pattern.bias==='Bearish'?-1:1;
    for(let i=1;i<Math.ceil(n*.45);i++)if(sign*rows[i].close>sign*rows[from].close)from=i;
    check('Directional impulse',from>=2&&sign*(rows[from].close-rows[0].close)>=range*.45,'An impulse of at least 45% of the selected range must precede consolidation.');
  }
  const end=match.stage==='complete'?n-1-Math.max(2,Math.round(n*.12)):n-2;
  const turns=swings(rows,from,end,range),highs=turns.filter(p=>p.high),lows=turns.filter(p=>!p.high);
  check('Repeated boundary tests',highs.length>=2&&lows.length>=2,`${highs.length} high tests and ${lows.length} low tests; at least two of each required.`);
  const upper=line(highs),lower=line(lows);
  if(!upper||!lower)return out('rejected');
  check('Boundary fit',Math.max(upper.error,lower.error)<=range*.08,'Swing points must stay within 8% of the selected range of their fitted boundaries.');
  const span=end-from,widthStart=upper.at(from)-lower.at(from),widthEnd=upper.at(end)-lower.at(end);
  check('Ordered boundaries',widthStart>range*.1&&widthEnd>range*.02,'Resistance must remain above support throughout the formation.');
  const up=upper.slope*span,down=lower.slope*span,flat=range*.12;
  if(family==='flag'||family==='channel'){
    check('Parallel boundaries',Math.abs(up-down)<=range*.15,'The two slopes must agree within 15% of the selected range.');
    if(family==='flag')check('Countertrend consolidation',match.pattern.bias==='Bearish'?up>=-flat&&down>=-flat:up<=flat&&down<=flat,'The consolidation must drift against, or sideways to, the impulse.');
    else check('Channel direction',match.pattern.inverted?up<-flat&&down<-flat:up>flat&&down>flat,'Both boundaries must slope in the channel direction.');
  }else if(family==='rectangle'){
    check('Horizontal boundaries',Math.abs(up)<=flat&&Math.abs(down)<=flat,'Support and resistance must both be approximately horizontal.');
  }else{
    check('Contraction',widthEnd>0&&widthEnd<=widthStart*.7,'The boundary separation must contract by at least 30%.');
    if(family==='wedge')check('Wedge direction',match.pattern.inverted?up<-flat&&down<-flat:up>flat&&down>flat,'Both boundaries must slope together and converge.');
    else if(match.pattern.id==='ascending-triangle')check('Ascending support / flat resistance',Math.abs(up)<=flat&&down>flat,'Higher lows must approach horizontal resistance.');
    else if(match.pattern.id==='descending-triangle')check('Descending resistance / flat support',up<-flat&&Math.abs(down)<=flat,'Lower highs must approach horizontal support.');
    else check('Converging swings',up<0&&down>0,'Resistance must descend while support rises.');
  }
  const last=rows.at(-1)!.close,above=last>upper.at(n-1)+range*.02,below=last<lower.at(n-1)-range*.02;
  const breakout=match.pattern.bias==='Bullish'?above:match.pattern.bias==='Bearish'?below:above||below;
  const failed=checks.some(item=>!item.passed);
  check('Closing boundary break',breakout,'The final completed candle must close beyond the expected boundary by 2% of the selected range.');
  return out(failed?'rejected':breakout?'confirmed':'forming',above?upper.at(n-1):below?lower.at(n-1):null,breakout);
}
