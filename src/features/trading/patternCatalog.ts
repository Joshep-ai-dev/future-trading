/** Reference names follow InvestinGoal's chart-pattern reading list; diagrams are original schematics. */
export type PatternGroup='Reversal'|'Continuation'|'Bilateral'|'Overview';
export type PatternBias='Bullish'|'Bearish'|'Either';
type Family='overview'|'shoulders'|'double'|'triple'|'cup'|'flag'|'pennant'|'triangle'|'wedge'|'diamond'|'megaphone'|'rectangle'|'rounding'|'island'|'bounce'|'measured'|'bump'|'pole'|'parabolic'|'channel'|'contraction'|'scallop'|'butterfly';
export type PatternReference={id:string;name:string;group:PatternGroup;bias:PatternBias;family:Family;inverted?:boolean;shape:number[];check:string;watch:string};

const shapes:Record<Family,number[]>={
  overview:[25,45,35,65,40,55,45,75],
  shoulders:[15,35,70,40,95,40,70,35,15],
  double:[15,45,85,45,82,42,20],triple:[15,45,85,45,83,44,84,40,20],
  cup:[80,60,38,25,22,25,38,60,80,62,68,90],
  flag:[10,35,85,65,78,58,70,50,65,90],
  pennant:[10,35,90,45,80,50,70,55,65,90],
  triangle:[20,85,35,85,50,85,65,85,95],
  wedge:[15,55,30,65,47,74,63,80,45],
  diamond:[50,65,30,85,10,80,25,68,40,60,25],
  megaphone:[50,60,40,72,28,85,15,95,5],
  rectangle:[20,75,25,75,25,75,25,75,95],
  rounding:[85,65,45,30,23,20,23,30,45,65,90],
  island:[90,75,60,25,18,25,20,25,60,80],
  bounce:[90,65,30,15,28,45,30,18,5],
  measured:[10,25,45,65,50,35,50,70,90],
  bump:[15,25,35,50,90,65,40,25,10],
  pole:[10,18,35,60,90],parabolic:[10,12,15,20,30,48,75,98],
  channel:[10,45,25,60,40,75,55,90,70],
  contraction:[20,90,30,85,50,83,65,82,74,90],
  scallop:[60,45,30,25,28,38,60,80,65,50,45,48,60,80,95],
  butterfly:[90,15,74,38,98,65],
};
const notes:Record<Family,[string,string]>={
  overview:['Identify the prior trend and the boundary being tested.','Category overview; the sketch is only an example.'],
  shoulders:['Check the neckline between the three swings.','A higher middle swing alone is insufficient.'],
  double:['Mark the middle swing as the confirmation level.','Two nearby extremes can still belong to a continuing trend.'],
  triple:['Compare all three tests and the intervening swings.','Uneven spacing and false breaks complicate recognition.'],
  cup:['Separate the rounded base from the smaller handle.','A deep handle can undermine the proposed structure.'],
  flag:['Distinguish the impulse from its parallel pullback.','An extended consolidation may no longer be a flag.'],
  pennant:['Check for a prior impulse and shrinking swings.','A triangle without an impulse is a different context.'],
  triangle:['Draw both boundaries from multiple swing touches.','The actual break can oppose the expected direction.'],
  wedge:['Check that both boundaries slope and converge.','A sloping channel has parallel boundaries instead.'],
  diamond:['Look for expansion followed by contraction.','Symmetry is illustrative, not a strict market requirement.'],
  megaphone:['Check whether successive swings expand outward.','Wider swings can increase the distance to invalidation.'],
  rectangle:['Mark repeated horizontal tests on both sides.','A wick outside the range can be a failed break.'],
  rounding:['Compare curvature across the whole formation.','A rounded path alone does not establish a reversal.'],
  island:['Verify genuine gaps around an isolated price cluster.','Missing feed data is not a market gap.'],
  bounce:['Check the bounce against the preceding decline.','It is difficult to distinguish from a recovery in real time.'],
  measured:['Compare the impulse, correction and second leg.','Equal leg lengths are a reference, not a promised target.'],
  bump:['Compare the steep acceleration with the earlier slope.','Choose the trendline before evaluating its break.'],
  pole:['Inspect the strong directional move before consolidation.','An impulse by itself does not provide a complete setup.'],
  parabolic:['Look for increasing slope across successive advances.','The timing of a reversal cannot be inferred from curvature.'],
  channel:['Check repeated swings inside parallel boundaries.','A channel direction does not guarantee a breakout direction.'],
  contraction:['Compare successive pullback depths.','Contracting price ranges alone do not verify volume conditions.'],
  scallop:['Look for rounded pullbacks within the broader trend.','A short noisy window can resemble many rounded formations.'],
  butterfly:['Label X-A-B-C-D and measure the swing ratios.','This sketch does not validate harmonic ratios or completion.'],
};
// Three category entries and 42 formation/family entries, matching the reading list.
const entries:[string,PatternGroup,PatternBias,Family,boolean?][]=[
  ['Reversal','Overview','Either','overview'],['Continuation','Overview','Either','overview'],['Bilateral','Overview','Either','overview'],
  ['Head and Shoulders','Reversal','Bearish','shoulders'],['Inverse Head and Shoulders','Reversal','Bullish','shoulders',true],
  ['Double Top','Reversal','Bearish','double'],['Double Bottom','Reversal','Bullish','double',true],
  ['Triple Top','Reversal','Bearish','triple'],['Triple Bottom','Reversal','Bullish','triple',true],
  ['Cup and Handle','Continuation','Bullish','cup'],['Inverted Cup and Handle','Continuation','Bearish','cup',true],
  ['Flag and Pennant','Continuation','Either','pennant'],['Flag','Continuation','Either','flag'],
  ['Bullish Flag','Continuation','Bullish','flag'],['Bearish Flag','Continuation','Bearish','flag',true],['High Tight Flag','Continuation','Bullish','flag'],
  ['Pennant','Continuation','Either','pennant'],['Bullish Pennant','Continuation','Bullish','pennant'],['Bearish Pennant','Continuation','Bearish','pennant',true],
  ['Triangle','Bilateral','Either','triangle'],['Ascending Triangle','Bilateral','Bullish','triangle'],['Descending Triangle','Bilateral','Bearish','triangle',true],['Symmetrical Triangle','Bilateral','Either','pennant'],
  ['Wedge','Bilateral','Either','wedge'],['Rising Wedge','Reversal','Bearish','wedge'],['Falling Wedge','Reversal','Bullish','wedge',true],
  ['Diamond','Reversal','Either','diamond'],['Diamond Top','Reversal','Bearish','diamond'],['Diamond Bottom','Reversal','Bullish','diamond',true],
  ['Megaphone','Bilateral','Either','megaphone'],['Rectangle','Bilateral','Either','rectangle'],
  ['Rounding Bottom','Reversal','Bullish','rounding'],['Rounding Top','Reversal','Bearish','rounding',true],['Island Reversal','Reversal','Either','island'],
  ['Dead Cat Bounce','Continuation','Bearish','bounce'],['Measured Move Up','Continuation','Bullish','measured'],['Bump and Run Reversal','Reversal','Bearish','bump'],
  ['Flagpole','Continuation','Either','pole'],['Parabolic Curve','Continuation','Either','parabolic'],
  ['Rising Channel','Continuation','Either','channel'],['Falling Channel','Continuation','Either','channel',true],
  ['Volatility Contraction','Continuation','Bullish','contraction'],['Descending Scallop','Continuation','Bearish','scallop',true],['Ascending Scallop','Continuation','Bullish','scallop'],
  ['Butterfly','Reversal','Either','butterfly'],
];
export const patternCatalog:PatternReference[]=entries.map(([name,group,bias,family,inverted])=>({
  id:name.toLowerCase().replaceAll(' ','-'),name,group,bias,family,inverted,
  shape:(name==='Symmetrical Triangle'?[10,90,25,78,38,67,47,58,52]:name==='High Tight Flag'?[5,12,25,90,80,87,78,84,80,98]:shapes[family]).map(value=>inverted?100-value:value),check:notes[family][0],watch:notes[family][1],
}));
