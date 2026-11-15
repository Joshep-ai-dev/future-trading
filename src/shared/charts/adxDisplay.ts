import type {ISeriesPrimitive,SeriesAttachedParameter,Time,IPrimitivePaneRenderer} from 'lightweight-charts';
import {TV} from './tvTheme';

export const ADX_COLORS={trend:TV.up,range:TV.orange,weak:TV.muted};
export const strengthColor=(raw:number|null)=>raw!==null&&raw>25?ADX_COLORS.trend:raw!==null&&raw>=20?ADX_COLORS.range:ADX_COLORS.weak;
export function displayAdx(rows:{time:number;adx:number|null}[],length:number){
  let ema:number|null=null;
  return rows.map(row=>{if(row.adx===null)ema=null;else ema=ema===null?row.adx:ema+2/(length+1)*(row.adx-ema);return {...row,display:ema,color:strengthColor(row.adx)};});
}
function roundRect(ctx:CanvasRenderingContext2D,x:number,y:number,w:number,h:number,r:number){
  ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();
}
export class AdxDecoration implements ISeriesPrimitive<Time>{
  private host:SeriesAttachedParameter<Time>|null=null;
  private raw:number|null=null;private previous:number|null=null;
  private visible=true;
  setVisible(visible:boolean){this.visible=visible;this.host?.requestUpdate();}
  constructor(private showStatus:boolean,private threshold:number){}
  autoscaleInfo(){return {priceRange:{minValue:0,maxValue:Math.max(30,this.threshold)}};}
  private renderer:IPrimitivePaneRenderer={
    // 20-25 range zone, filled like a TradingView hline band.
    drawBackground:target=>target.useMediaCoordinateSpace(({context:ctx,mediaSize})=>{
      if(!this.visible)return;
      const a=this.host?.series.priceToCoordinate(20),b=this.host?.series.priceToCoordinate(25);
      if(a==null||b==null)return;
      ctx.save();ctx.fillStyle='rgba(255,152,0,0.06)';ctx.fillRect(0,Math.min(a,b),mediaSize.width,Math.abs(a-b));ctx.restore();
    }),
    draw:target=>{if(!this.showStatus||!this.visible)return;target.useMediaCoordinateSpace(({context:ctx,mediaSize})=>{
      const raw=this.raw,previous=this.previous;
      const strength=raw===null?'Warming up':raw>25?'Trend':raw>=20?'Range':'Weak';
      const arrow=raw===null||previous===null?'':raw>previous?'▲':raw<previous?'▼':'■';
      const color=strengthColor(raw);
      ctx.save();ctx.font=`12px ${TV.font}`;ctx.textBaseline='middle';
      const label=strength,value=raw===null?'':raw.toFixed(2);
      const dot=8,gap=6,pad=8;
      const width=pad+dot+gap+ctx.measureText(label).width+(value?gap+ctx.measureText(value).width:0)+(arrow?gap+9:0)+pad;
      const height=22,x=Math.max(4,mediaSize.width-width-8),y=6;
      roundRect(ctx,x,y,width,height,4);ctx.fillStyle='rgba(19,23,34,0.9)';ctx.fill();ctx.strokeStyle=TV.border;ctx.lineWidth=1;ctx.stroke();
      let cursor=x+pad;
      ctx.fillStyle=color;ctx.beginPath();ctx.arc(cursor+dot/2,y+height/2,dot/2-1,0,Math.PI*2);ctx.fill();cursor+=dot+gap;
      ctx.fillStyle=TV.textStrong;ctx.fillText(label,cursor,y+height/2+0.5);cursor+=ctx.measureText(label).width+gap;
      if(value){ctx.fillStyle=color;ctx.fillText(value,cursor,y+height/2+0.5);cursor+=ctx.measureText(value).width+gap;}
      if(arrow){ctx.font=`9px ${TV.font}`;ctx.fillStyle=raw!==null&&previous!==null&&raw>previous?TV.up:raw!==null&&previous!==null&&raw<previous?TV.down:TV.muted;ctx.fillText(arrow,cursor,y+height/2+0.5);}
      ctx.restore();
    });},
  };
  private view={renderer:()=>this.renderer};
  attached(host:SeriesAttachedParameter<Time>){this.host=host;}
  detached(){this.host=null;}
  paneViews(){return [this.view];}
  update(raw:number|null,previous:number|null){this.raw=raw;this.previous=previous;this.host?.requestUpdate();}
}
