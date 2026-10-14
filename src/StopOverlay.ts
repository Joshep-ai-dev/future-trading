import type {IPrimitivePaneRenderer,ISeriesPrimitive,SeriesAttachedParameter,Time,UTCTimestamp} from 'lightweight-charts';

export type StopPoint={time:number;price:number;reason:string};
export type StopPath={from:number;to:number;history:StopPoint[]};
export const STOP_COLORS={initial:'#ff667d',trailing:'#54ef91'};

/** Each trade is a separate path, so reversals never join unrelated stop prices. */
export class StopOverlay implements ISeriesPrimitive<Time> {
  private host:SeriesAttachedParameter<Time>|null=null;
  private paths:StopPath[]=[];
  private renderer:IPrimitivePaneRenderer={draw:target=>{
    const host=this.host;if(!host)return;
    target.useMediaCoordinateSpace(({context:ctx,mediaSize})=>{
      ctx.save();ctx.lineWidth=2;ctx.font='600 10px sans-serif';
      for(const path of this.paths){
        const coords=path.history.map(p=>({...p,x:host.chart.timeScale().timeToCoordinate(p.time as UTCTimestamp),y:host.series.priceToCoordinate(p.price)}));
        const end=host.chart.timeScale().timeToCoordinate(path.to as UTCTimestamp);
        if(end===null)continue;
        for(let i=0;i<coords.length;i++){
          const p=coords[i],next=coords[i+1];
          if(p.x===null||p.y===null)continue;
          const right=next?.x??end;
          if(right<0||p.x>mediaSize.width)continue;
          const trailing=p.reason!=='initial';
          ctx.strokeStyle=trailing?STOP_COLORS.trailing:STOP_COLORS.initial;
          ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(right,p.y);ctx.stroke();
          if(next?.y!==null&&next?.y!==undefined){
            ctx.strokeStyle=STOP_COLORS.trailing;ctx.beginPath();ctx.moveTo(right,p.y);ctx.lineTo(right,next.y);ctx.stroke();
          }
          if(trailing&&(p.reason==='activation'||(i>0&&coords[i-1].reason==='initial'))&&p.x>=0&&p.x<=mediaSize.width){
            ctx.fillStyle=STOP_COLORS.trailing;ctx.beginPath();ctx.arc(p.x,p.y,3,0,Math.PI*2);ctx.fill();
            ctx.lineWidth=4;ctx.strokeStyle='#10141d';ctx.strokeText('TRAIL',p.x+6,p.y-8);
            ctx.fillText('TRAIL',p.x+6,p.y-8);ctx.lineWidth=2;
          }
        }
      }
      ctx.restore();
    });
  }};
  private view={renderer:()=>this.renderer};
  attached(host:SeriesAttachedParameter<Time>){this.host=host;}
  detached(){this.host=null;}
  paneViews(){return [this.view];}
  autoscaleInfo(start:number,end:number){
    if(!this.host)return null;
    const scale=this.host.chart.timeScale();
    const prices=this.paths.filter(p=>{
      const x=scale.timeToCoordinate(p.from as UTCTimestamp),y=scale.timeToCoordinate(p.to as UTCTimestamp);
      if(x===null||y===null)return false;
      const a=scale.coordinateToLogical(x),b=scale.coordinateToLogical(y);
      return a!==null&&b!==null&&a<=end&&b>=start;
    }).flatMap(p=>p.history.map(h=>h.price));
    return prices.length?{priceRange:{minValue:Math.min(...prices),maxValue:Math.max(...prices)}}:null;
  }
  setPaths(paths:StopPath[],first?:number,last?:number){
    this.paths=first===undefined||last===undefined?[]:paths.filter(p=>p.from<=last&&p.to>=first).map(p=>{
      const previous=p.history.filter(h=>h.time<first).at(-1);
      return {...p,from:Math.max(first,p.from),to:Math.min(last,p.to),history:[...(previous?[{...previous,time:first,reason:previous.reason==='initial'?'initial':'trailing'}]:[]),...p.history.filter(h=>h.time>=first&&h.time<=last)]};
    });
    this.host?.requestUpdate();
  }
}
