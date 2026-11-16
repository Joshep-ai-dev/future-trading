import type {ISeriesPrimitive,SeriesAttachedParameter,Time,IPrimitivePaneRenderer,UTCTimestamp} from 'lightweight-charts';
import {TV} from './tvTheme';

/**
 * ADX trend strength, based on "ADX 14 Trend Strength Visualizer v6" (ggs92, MPL-2.0).
 * Two thresholds split ADX into three zones, each with its own color:
 * below the trend level = Weak, from the trend level = Trend, from the strong level = Strong trend.
 */
export type AdxStyle={
  adxTrendLevel:number;adxStrongLevel:number;
  adxWeakColor:string;adxTrendColor:string;adxStrongColor:string;
  diPlusColor:string;diMinusColor:string;adxBullBgColor:string;adxBearBgColor:string;
};
type Zone={color:string;label:string};
const zone=(adx:number,c:AdxStyle):Zone=>adx>=c.adxStrongLevel?{color:c.adxStrongColor,label:'Strong trend'}
  :adx>=c.adxTrendLevel?{color:c.adxTrendColor,label:'Trend'}:{color:c.adxWeakColor,label:'Weak'};
/** Threshold line color: the zone color that starts at this level. */
export const levelColor=(value:number,c:AdxStyle)=>zone(value,c).color;
export const adxColor=(adx:number|null,c:AdxStyle)=>adx===null||!Number.isFinite(adx)?c.adxWeakColor:zone(adx,c).color;
export const adxLabel=(adx:number,c:AdxStyle)=>zone(adx,c).label;
export const adxLevels=(c:AdxStyle)=>[c.adxTrendLevel,c.adxStrongLevel];
export const diColors=(c:AdxStyle)=>({plus:c.diPlusColor,minus:c.diMinusColor});
/** Background tint: the chosen color at 10% opacity. */
const tint=(hex:string)=>hex+'1a';

export type AdxRow={time:number;adx:number|null;pdi:number|null;mdi:number|null};

/** bgcolor(+DI > -DI ? green 90% : red 90%) and the last-bar trend label. */
export class AdxVisualizer implements ISeriesPrimitive<Time>{
  private host:SeriesAttachedParameter<Time>|null=null;
  private rows:AdxRow[]=[];
  private visible=true;
  constructor(private showLabel:boolean,private style:AdxStyle){}
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
          ctx.fillStyle=tint(bull?this.style.adxBullBgColor:this.style.adxBearBgColor);
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
      const text=adxLabel(last.adx!,this.style),color=adxColor(last.adx,this.style);
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
