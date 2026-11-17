import type {PatternReference} from './patternCatalog';
import type {PatternCandle} from './patternRange';
import {assessPatternStructure,type PatternAssessment} from './patternStructure';
import {fitReferenceCurve} from './patternSimilarity';
import {detectZigZag,type ZigZagOptions} from './zigzag';

/** Twenty distinct geometric formations. Broad category/family entries and
 * specialized patterns without geometry rules remain available as references.
 */
export const GEOMETRIC_PATTERN_IDS=new Set([
  'head-and-shoulders','inverse-head-and-shoulders','double-top','double-bottom','triple-top','triple-bottom',
  'bullish-flag','bearish-flag','bullish-pennant','bearish-pennant',
  'ascending-triangle','descending-triangle','symmetrical-triangle','rising-wedge','falling-wedge',
  'rectangle','rising-channel','falling-channel','cup-and-handle','inverted-cup-and-handle',
]);
export type GeometricMatch={pattern:PatternReference;assessment:PatternAssessment;score:number;templateFit:number;curve:number[];reference:number[]};

/** OHLC -> ATR ZigZag -> geometry -> secondary template ranking. No template
 * score or simulated percentile can promote a failed structure to a match.
 */
export function recognizePatterns(candles:readonly PatternCandle[],catalog:readonly PatternReference[],options:ZigZagOptions={}){
  const zigzag=detectZigZag(candles,options);
  const eligible=catalog.filter(pattern=>GEOMETRIC_PATTERN_IDS.has(pattern.id));
  const evaluated=eligible.map(pattern=>({pattern,assessment:assessPatternStructure(candles,{pattern,start:0,length:candles.length},zigzag)}));
  const ranked:GeometricMatch[]=evaluated.map(({pattern,assessment})=>{
    const reference=fitReferenceCurve(candles.map(row=>row.close),pattern.shape,assessment.status==='forming'&&!['channel'].includes(pattern.family));
    const component=assessment.components;
    // Geometry, boundary fit and symmetry carry 90%; resemblance is a tie-breaker.
    const score=.3*component.geometry+.25*component.trendlines+.15*component.symmetry+.2*component.structure+.1*reference.fit;
    return {pattern,assessment,score,templateFit:reference.fit,curve:reference.curve,reference:reference.reference};
  });
  ranked.sort((a,b)=>b.score-a.score||a.pattern.name.localeCompare(b.pattern.name));
  return {
    zigzag,supported:eligible.length,unsupported:catalog.filter(pattern=>pattern.group!=='Overview'&&!GEOMETRIC_PATTERN_IDS.has(pattern.id)).length,
    matches:ranked.filter(item=>item.assessment.status==='confirmed'||item.assessment.status==='forming'),
    rejected:ranked.filter(item=>item.assessment.status==='rejected'||item.assessment.status==='unverified'),
  };
}
