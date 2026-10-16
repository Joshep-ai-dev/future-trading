import type {ISeriesPrimitive,SeriesAttachedParameter,Time,IPrimitivePaneRenderer} from 'lightweight-charts';

export const strengthColor=(raw:number|null)=>raw!==null&&raw>25?'#26a69a':raw!==null&&raw>=20?'#ffb74d':'#90a4ae';
export function displayAdx(rows:{time:number;adx:number|null}[],length:number){
  let ema:number|null=null;
  return rows.map(row=>{if(row.adx===null)ema=null;else ema=ema===null?row.adx:ema+2/(length+1)*(row.adx-ema);return {...row,display:ema,color:strengthColor(row.adx)};});
}
export class AdxDecoration implements ISeriesPrimitive<Time>{
  private host:SeriesAttachedParameter<Time>|null=null;
  private raw:number|null=null;private previous:number|null=null;
  private visible=true;
  setVisible(visible:boolean){this.visible=visible;this.host?.requestUpdate();}
  constructor(private showStatus:boolean,private threshold:number){}
  autoscaleInfo(){return {priceRange:{minValue:0,maxValue:Math.max(30,this.threshold)}};}
  private renderer:IPrimitivePaneRenderer={
    drawBackground:target=>target.useMediaCoordinateSpace(({context:ctx,mediaSize})=>{
      if(!this.visible)return;
      const a=this.host?.series.priceToCoordinate(20),b=this.host?.series.priceToCoordinate(25);
      if(a==null||b==null)return;
      ctx.save();ctx.fillStyle='rgba(255,183,77,.07)';ctx.fillRect(0,Math.min(a,b),mediaSize.width,Math.abs(a-b));ctx.restore();
    }),
    draw:target=>{if(!this.showStatus||!this.visible)return;target.useMediaCoordinateSpace(({context:ctx,mediaSize})=>{
      const raw=this.raw,previous=this.previous;
      const strength=raw===null?'WARMING UP':raw>25?'TREND':raw>=20?'RANGE':'WEAK';
      const arrow=raw===null||previous===null?'':raw>previous?' ↑':raw<previous?' ↓':' →';
      const text=raw===null?strength:`ADX ${raw.toFixed(1)}${arrow} · ${strength}`;
      ctx.save();ctx.font='11px sans-serif';const width=ctx.measureText(text).width+18,x=Math.max(4,mediaSize.width-width-8);
      const top=mediaSize.width<650?34:7;
      ctx.fillStyle='#12161c';ctx.fillRect(x,top,width,24);ctx.fillStyle=strengthColor(raw);ctx.globalAlpha=.1;ctx.fillRect(x,top,width,24);ctx.globalAlpha=1;ctx.fillText(text,x+9,top+16);ctx.restore();
    });},
  };
  private view={renderer:()=>this.renderer};
  attached(host:SeriesAttachedParameter<Time>){this.host=host;}
  detached(){this.host=null;}
  paneViews(){return [this.view];}
  update(raw:number|null,previous:number|null){this.raw=raw;this.previous=previous;this.host?.requestUpdate();}
}
