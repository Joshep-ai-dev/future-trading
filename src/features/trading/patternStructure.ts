import type {PatternCandle} from './patternRange';
import type {ReferenceMatch} from './patternSimilarity';
import {detectZigZag,type SwingPoint,type ZigZagResult} from './zigzag';

export type StructureCheck={label:string;passed:boolean;detail:string};
export type PatternBoundary={label:string;from:{index:number;value:number};to:{index:number;value:number}};
export type PatternAssessment={
  status:'confirmed'|'forming'|'rejected'|'unverified';checks:StructureCheck[];level:number|null;breakout:boolean;
  direction:'bullish'|'bearish'|'undetermined';pivots:SwingPoint[];provisional:SwingPoint|null;boundaries:PatternBoundary[];
  components:{geometry:number;trendlines:number;symmetry:number;structure:number};
};
type Swing={index:number;value:number;high:boolean};
const clamp=(value:number)=>Math.max(0,Math.min(100,value));
function line(points:Swing[]):{at:(index:number)=>number;slope:number;error:number}|null{
  if(points.length<2)return null;
  const x=points.reduce((sum,p)=>sum+p.index,0)/points.length,y=points.reduce((sum,p)=>sum+p.value,0)/points.length;
  const denominator=points.reduce((sum,p)=>sum+(p.index-x)**2,0);
  if(!denominator)return null;
  const slope=points.reduce((sum,p)=>sum+(p.index-x)*(p.value-y),0)/denominator;
  const at=(index:number)=>y+slope*(index-x);
  return {at,slope,error:Math.max(...points.map(p=>Math.abs(at(p.index)-p.value)))};
}

/** Geometry precedes template similarity. Only confirmed ATR ZigZag pivots
 * enter the rules; the unfinished leg is returned for display only.
 * A template's stage cannot confirm an observed closing breakout.
 */
export function assessPatternStructure(candles:readonly PatternCandle[],match:Pick<ReferenceMatch,'pattern'|'start'|'length'>,detected?:ZigZagResult):PatternAssessment{
  const rows=candles.slice(match.start,match.start+match.length),checks:StructureCheck[]=[];
  const zz=detected??detectZigZag(rows),boundaries:PatternBoundary[]=[];
  const components={geometry:0,trendlines:0,symmetry:0,structure:0};
  let direction:PatternAssessment['direction']='undetermined';
  const check=(label:string,passed:boolean,detail:string)=>checks.push({label,passed,detail});
  const out=(status:PatternAssessment['status'],level:number|null=null,breakout=false):PatternAssessment=>{
    components.structure=checks.length?100*checks.filter(item=>item.passed).length/checks.length:0;
    return {status,checks,level,breakout,direction,pivots:zz.pivots,provisional:zz.provisional,boundaries,components:{...components}};
  };
  check('Enough candles',rows.length>=20,`${rows.length} completed candles; at least 20 required.`);
  const valid=rows.every(row=>Number.isFinite(row.high)&&Number.isFinite(row.low)&&Number.isFinite(row.close)&&row.low!>0&&row.low!<=row.close&&row.high!>=row.close);
  check('OHLC available',valid,'Actual candle highs, lows and completed closes are required.');
  if(rows.length<20||!valid)return out('unverified');
  const step=rows[1].time-rows[0].time;
  const continuous=step>0&&rows.every((row,index)=>Number.isFinite(row.time)&&(!index||row.time-rows[index-1].time===step));
  check('Continuous candle data',continuous,'Missing, duplicate or unordered candles cannot validate a formation.');
  if(!continuous)return out('unverified');
  check('Confirmed ATR swings',zz.pivots.filter(p=>!p.seed).length>=3,`${zz.pivots.filter(p=>!p.seed).length} confirmed swings; reversal threshold ${zz.reversalAtr} × ATR(14), with a 0.05% price floor.`);
  // An unfinished spike must not widen geometric tolerances. Only committed
  // pivots define the formation's scale; current closes test its breakout.
  const max=Math.max(...zz.pivots.map(point=>point.value)),min=Math.min(...zz.pivots.map(point=>point.value)),range=max-min,n=rows.length;
  if(!Number.isFinite(range)||range<=0)return out('rejected');
  const buffer=Math.max((zz.atr.at(-2)??0)*.1,range*.01),family=match.pattern.family;
  const addLine=(label:string,at:(index:number)=>number,from:number,to=n-1,sign=1)=>boundaries.push({label,from:{index:from,value:sign*at(from)},to:{index:to,value:sign*at(to)}});
  const finish=(level:number|null,breakout:boolean,invalidated=false)=>{
    const failed=checks.some(item=>!item.passed)||invalidated;
    check('Closing breakout',breakout,`The last completed close must cross the boundary by ${buffer.toFixed(4)} or more.`);
    return out(failed?'rejected':breakout?'confirmed':'forming',level,breakout);
  };
  if(['double','triple','shoulders'].includes(family)){
    const sign=match.pattern.inverted?-1:1;
    const turns=zz.pivots.filter(p=>!p.seed).map(p=>({...p,value:sign*p.value,high:sign===1?p.high:!p.high}));
    const peaks=turns.filter(p=>p.high),expected=family==='double'?2:3;
    check('Swing sequence',peaks.length===expected,`${peaks.length} confirmed ${sign===1?'peaks':'troughs'}; ${expected} required.`);
    if(peaks.length!==expected)return out('rejected');
    const valleys=turns.filter(p=>!p.high&&p.index>peaks[0].index&&p.index<peaks.at(-1)!.index);
    check('Intervening swings',valleys.length===expected-1,'Each test must be separated by a confirmed opposite swing.');
    if(valleys.length!==expected-1)return out('rejected');
    check('Prior trend',sign*(rows[peaks[0].index].close-rows[0].close)>=range*.18,'The first test must follow a directional move of at least 18% of the selected range.');
    let heightError=0;
    if(family==='shoulders'){
      check('Distinct head',peaks[1].value-Math.max(peaks[0].value,peaks[2].value)>=range*.12,'The head must exceed both shoulders by 12% of the selected range.');
      heightError=Math.abs(peaks[0].value-peaks[2].value);
      check('Shoulder symmetry',heightError<=range*.15,'Shoulders must agree within 15% of the selected range.');
    }else{
      heightError=Math.max(...peaks.map(p=>p.value))-Math.min(...peaks.map(p=>p.value));
      check('Repeated test level',heightError<=range*.1,'Repeated highs/lows must agree within 10% of the selected range.');
    }
    const gaps=peaks.slice(1).map((p,index)=>p.index-peaks[index].index);
    const legs=valleys.flatMap((valley,index)=>[valley.index-peaks[index].index,peaks[index+1].index-valley.index]);
    const spacing=Math.min(...legs)/Math.max(...legs);
    check('Swing spacing',Math.min(...gaps)>=3&&Math.min(...legs)>=2&&spacing>=.35,'Tests must be at least three bars apart; each intervening leg needs two bars and no leg may be more than 2.9× another.');
    check('Pullback depth',valleys.every(v=>Math.min(...peaks.map(p=>p.value))-v.value>=range*.2),'Each intervening pullback must span 20% of the selected range.');
    const neck=valleys.length===1?{at:()=>valleys[0].value,error:0}:line(valleys)!;
    addLine('Neckline',neck.at,valleys[0].index,n-1,sign);
    const level=neck.at(n-1),breakout=sign*rows.at(-1)!.close<level-buffer;
    const invalidated=sign*rows.at(-1)!.close>Math.max(...peaks.map(p=>p.value))+buffer;
    check('Not invalidated',!invalidated,'A close beyond the opposite formation extreme invalidates the setup.');
    direction=sign===1?'bearish':'bullish';
    components.geometry=clamp(100-100*heightError/(range*.25));components.symmetry=clamp(spacing*100);
    components.trendlines=clamp(100-100*neck.error/(range*.1));
    return finish(sign*level,breakout,invalidated);
  }
  if(family==='cup'){
    const sign=match.pattern.inverted?-1:1;
    const turns=zz.pivots.map(p=>({...p,value:sign*p.value,high:sign===1?p.high:!p.high}));
    const highs=turns.filter(p=>p.high),left=highs[0],right=highs[1];
    const base=left&&right?turns.find(p=>!p.high&&p.index>left.index&&p.index<right.index):undefined;
    const handle=right?turns.find(p=>!p.high&&p.index>right.index):undefined;
    check('Cup and handle swings',highs.length===2&&!!base&&!!handle,'Two rim highs, a confirmed cup low and a later confirmed handle low are required (mirrored for bearish cups).');
    if(!left||!right||!base||!handle||highs.length!==2)return out('rejected');
    const depth=Math.min(left.value,right.value)-base.value,rimError=Math.abs(left.value-right.value);
    check('Rim agreement',depth>0&&rimError<=depth*.2,'The two rims must agree within 20% of the cup depth.');
    check('Shallow handle',right.value-handle.value>buffer&&right.value-handle.value<=depth*.5,'The handle must retrace no more than half the cup depth.');
    const cupBars=right.index-left.index,handleBars=handle.index-right.index;
    check('Cup duration',cupBars>=10&&cupBars>=2*handleBars,'The cup must span at least ten bars and twice the handle duration.');
    const bottomBars=rows.slice(left.index,right.index+1).filter(row=>sign*row.close<=base.value+depth*.25).length;
    check('Broad base',bottomBars>=Math.max(3,cupBars*.15),'A meaningful portion of the cup must form near its base, rather than one isolated spike.');
    check('Prior trend',sign*(rows[left.index].close-rows[0].close)>=range*.15,'The rim must follow a directional move inside the selection.');
    const level=Math.max(left.value,right.value),breakout=sign*rows.at(-1)!.close>level+buffer;
    const invalidated=sign*rows.at(-1)!.close<handle.value-buffer;
    check('Handle intact',!invalidated,'A close through the handle low invalidates the proposed completion.');
    addLine('Rim / breakout',()=>level,left.index,n-1,sign);
    direction=sign===1?'bullish':'bearish';
    components.geometry=clamp(100-100*rimError/Math.max(depth*.3,buffer));components.symmetry=clamp(100-100*Math.abs((base.index-left.index)-(right.index-base.index))/cupBars);components.trendlines=components.geometry;
    return finish(sign*level,breakout,invalidated);
  }
  if(!['flag','pennant','triangle','wedge','rectangle','channel'].includes(family)){
    check('Structural rules available',false,'This family currently has reference sketches only; it cannot be identified by these rules.');
    return out('unverified');
  }
  const impulse=['flag','pennant'].includes(family)&&match.pattern.id!=='symmetrical-triangle';
  let from=0;
  if(impulse){
    const sign=match.pattern.bias==='Bearish'?-1:1;
    for(let i=1;i<Math.ceil(n*.45);i++)if(sign*rows[i].close>sign*rows[from].close)from=i;
    check('Directional impulse',from>=2&&sign*(rows[from].close-rows[0].close)>=range*.45,'An impulse of at least 45% of the selected range must precede consolidation.');
  }
  // The unfinished leg cannot enter the boundary regression.
  const turns=zz.pivots.filter(p=>p.index>=from),highs=turns.filter(p=>p.high),lows=turns.filter(p=>!p.high);
  check('Repeated boundary tests',highs.length>=2&&lows.length>=2,`${highs.length} high tests and ${lows.length} low tests; at least two of each required.`);
  const upper=line(highs),lower=line(lows);
  if(!upper||!lower)return out('rejected');
  const end=Math.max(...turns.map(p=>p.index)),span=end-from;
  addLine('Resistance',upper.at,from);addLine('Support',lower.at,from);
  const error=Math.max(upper.error,lower.error);
  check('Boundary fit',error<=range*.08,'Confirmed swing points must stay within 8% of the selected range of their fitted boundaries.');
  const widthStart=upper.at(from)-lower.at(from),widthEnd=upper.at(end)-lower.at(end);
  check('Ordered boundaries',widthStart>range*.1&&widthEnd>range*.02,'Resistance must stay above support throughout the fitted formation.');
  const up=upper.slope*span,down=lower.slope*span,flat=range*.12;
  let shapeError=0;
  if(family==='flag'||family==='channel'){
    shapeError=Math.abs(up-down);
    check('Parallel boundaries',shapeError<=range*.15,'The two boundary slopes must agree within 15% of the selected range.');
    if(family==='flag')check('Countertrend consolidation',match.pattern.bias==='Bearish'?up>=-flat&&down>=-flat:up<=flat&&down<=flat,'The consolidation must drift against, or sideways to, the impulse.');
    else check('Channel direction',match.pattern.inverted?up<-flat&&down<-flat:up>flat&&down>flat,'Both boundaries must slope in the channel direction.');
  }else if(family==='rectangle'){
    shapeError=Math.max(Math.abs(up),Math.abs(down));
    check('Horizontal boundaries',shapeError<=flat,'Both support and resistance must be approximately horizontal.');
  }else{
    check('Contraction',widthEnd>0&&widthEnd<=widthStart*.7,'The boundaries must converge by at least 30%.');
    shapeError=widthEnd/Math.max(widthStart,buffer)*range*.15;
    if(family==='wedge')check('Wedge direction',match.pattern.inverted?up<-flat&&down<-flat:up>flat&&down>flat,'Both boundaries must slope together and converge.');
    else if(match.pattern.id==='ascending-triangle')check('Ascending support / flat resistance',Math.abs(up)<=flat&&down>flat,'Higher lows must approach horizontal resistance.');
    else if(match.pattern.id==='descending-triangle')check('Descending resistance / flat support',up<-flat&&Math.abs(down)<=flat,'Lower highs must approach horizontal support.');
    else check('Converging swings',up<0&&down>0,'Resistance must descend while support rises.');
  }
  const last=rows.at(-1)!.close,above=last>upper.at(n-1)+buffer,below=last<lower.at(n-1)-buffer;
  const bilateral=family==='triangle'||family==='rectangle'||family==='channel'||match.pattern.id==='symmetrical-triangle';
  const breakout=bilateral?above||below:match.pattern.bias==='Bullish'?above:below;
  const invalidated=!bilateral&&(match.pattern.bias==='Bullish'?below:above);
  check('Not invalidated',!invalidated,'A closing break opposite the proposed directional setup invalidates it.');
  direction=breakout?(above?'bullish':'bearish'):bilateral?'undetermined':match.pattern.bias==='Bullish'?'bullish':'bearish';
  components.geometry=clamp(100-100*shapeError/(range*.3));components.trendlines=clamp(100-100*error/(range*.12));
  const gaps=highs.length>2?highs.slice(1).map((p,i)=>p.index-highs[i].index):[1];
  components.symmetry=100*Math.min(...gaps)/Math.max(...gaps);
  return finish(above?upper.at(n-1):below?lower.at(n-1):null,breakout,invalidated);
}
