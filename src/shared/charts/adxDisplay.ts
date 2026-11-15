import type {ISeriesPrimitive,SeriesAttachedParameter,Time,IPrimitivePaneRenderer,UTCTimestamp} from 'lightweight-charts';
import {TV} from './tvTheme';

/**
 * "ADX 14 Trend Strength Visualizer v6" (ggs92, MPL-2.0) ported to the chart.
 * Pine color constants: blue #2962ff, green #4caf50, yellow #ffeb3b,
 * orange #ff9800, red #f23645, lime #00e676.
 */
export const ADX_LEVELS=[
  {below:20,color:'#2962ff',label:'Weak'},
  {below:25,color:'#4caf50',label:'Emerging'},
  {below:50,color:'#ffeb3b',label:'Strong'},
  {below:75,color:'#ff9800',label:'Very Strong'},
  {below:Infinity,color:'#f23645',label:'Extremely Strong'},
] as const;
export const DI_COLORS={plus:'#00e676',minus:'#f23645'};
const level=(adx:number)=>ADX_LEVELS.find(item=>adx<item.below)!;
/** Threshold line color: the strength color that starts at this level (20 green, 25 yellow, ...). */
export const levelColor=(value:number)=>level(value).color;
export const adxColor=(adx:number|null)=>adx===null||!Number.isFinite(adx)?TV.muted:level(adx).color;
export const adxLabel=(adx:number)=>level(adx).label;

export type AdxRow={time:number;adx:number|null;pdi:number|null;mdi:number|null};

/** bgcolor(+DI > -DI ? green 90% : red 90%) and the last-bar trend label. */
export class AdxVisualizer implements ISeriesPrimitive<Time>{
  private host:SeriesAttachedParameter<Time>|null=null;
  private rows:AdxRow[]=[];
  private visible=true;
  constructor(private showLabel:boolean){}
  setVisible(visible:boolean){this.visible=visible;this.host?.requestUpdate();}
  setData(rows:AdxRow[]){this.rows=rows;this.host?.requestUpdate();}
  private renderer:IPrimitivePaneRenderer={
    drawBackground:target=>target.useMediaCoordinateSpace(({context:ctx,mediaSize})=>{
      const host=this.host;if(!host||!this.visible||!this.rows.length)return;
      const scale=host.chart.timeScale(),spacing=scale.options().barSpacing;
      // Collect visible bars, then paint each run of equal color as one block.
      // Neighbouring blocks share the same rounded edge (midpoint between bars),
      // so there are no seams or overlapping alpha lines between bars.
      const bars:{x:number;bull:boolean|null}[]=[];
      for(const row of this.rows){
        const x=scale.timeToCoordinate(row.time as UTCTimestamp);
        if(x===null||x<-spacing*2||x>mediaSize.width+spacing*2)continue;
        bars.push({x,bull:row.pdi===null||row.mdi===null?null:row.pdi>row.mdi});
      }
      const edge=(i:number)=>Math.round(i<=0?bars[0].x-spacing/2:i>=bars.length?bars[bars.length-1].x+spacing/2:(bars[i-1].x+bars[i].x)/2);
      ctx.save();
      let start=0;
      for(let i=1;i<=bars.length;i++){
        if(i<bars.length&&bars[i].bull===bars[start].bull)continue;
        const bull=bars[start].bull;
        if(bull!==null){
          const left=edge(start),right=edge(i);
          ctx.fillStyle=bull?'rgba(76,175,80,0.1)':'rgba(242,54,69,0.1)';
          ctx.fillRect(left,0,right-left,mediaSize.height);
        }
        start=i;
      }
      ctx.restore();
    }),
    draw:target=>target.useMediaCoordinateSpace(({context:ctx,mediaSize})=>{
      const host=this.host;if(!host||!this.visible||!this.showLabel)return;
      const last=[...this.rows].reverse().find(row=>row.adx!==null);if(!last)return;
      const x=host.chart.timeScale().timeToCoordinate(last.time as UTCTimestamp),y=host.series.priceToCoordinate(last.adx!);
      if(x===null||y===null||x<0||x>mediaSize.width)return;
      // label.style_label_up: box under the point with an arrow pointing up at it.
      const text=adxLabel(last.adx!),color=adxColor(last.adx);
      ctx.save();ctx.font=`11px ${TV.font}`;
      const width=ctx.measureText(text).width+12,height=18,arrow=5;
      const tip=Math.min(y,mediaSize.height-height-arrow-1),left=Math.max(2,Math.min(mediaSize.width-width-2,x-width/2));
      ctx.fillStyle=color;
      ctx.beginPath();ctx.moveTo(x,tip);ctx.lineTo(x-arrow,tip+arrow);ctx.lineTo(x+arrow,tip+arrow);ctx.closePath();ctx.fill();
      ctx.beginPath();ctx.roundRect(left,tip+arrow,width,height,3);ctx.fill();
      ctx.fillStyle='#ffffff';ctx.textAlign='center';ctx.textBaseline='middle';
      ctx.fillText(text,left+width/2,tip+arrow+height/2+.5);
      ctx.restore();
    }),
  };
  private view={renderer:()=>this.renderer};
  attached(host:SeriesAttachedParameter<Time>){this.host=host;}
  detached(){this.host=null;}
  paneViews(){return [this.view];}
}
