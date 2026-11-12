import type {IPrimitivePaneRenderer,ISeriesPrimitive,SeriesAttachedParameter,Time,UTCTimestamp} from 'lightweight-charts';
import {supertrendSegments,type SupertrendPoint} from './supertrend';

/** Pine's separate linebr plots and body-middle fills, without connecting gaps. */
export class SupertrendOverlay implements ISeriesPrimitive<Time>{
  private host:SeriesAttachedParameter<Time>|null=null;
  private visible=false;
  private segments:SupertrendPoint[][]=[];
  private renderer:IPrimitivePaneRenderer={draw:target=>{
    const host=this.host;if(!host||!this.visible)return;
    target.useMediaCoordinateSpace(({context:ctx,mediaSize})=>{
      ctx.save();
      for(const segment of this.segments){
        const points=segment.map(point=>({
          x:host.chart.timeScale().timeToCoordinate(point.time as UTCTimestamp),
          y:host.series.priceToCoordinate(point.value!),
          body:host.series.priceToCoordinate(point.bodyMiddle!),
        }));
        const color=segment[0].direction==='up'?'#4caf50':'#f23645';
        ctx.fillStyle=ctx.strokeStyle=color;ctx.lineWidth=1;
        for(let i=1;i<points.length;i++){
          const left=points[i-1],right=points[i];
          if(left.x===null||right.x===null||left.y===null||right.y===null||left.body===null||right.body===null)continue;
          if(right.x<0||left.x>mediaSize.width)continue;
          ctx.globalAlpha=.1;
          ctx.beginPath();ctx.moveTo(left.x,left.body);ctx.lineTo(right.x,right.body);
          ctx.lineTo(right.x,right.y);ctx.lineTo(left.x,left.y);ctx.closePath();ctx.fill();
          ctx.globalAlpha=1;
          ctx.beginPath();ctx.moveTo(left.x,left.y);ctx.lineTo(right.x,right.y);ctx.stroke();
        }
      }
      ctx.restore();
    });
  }};
  private view={zOrder:()=> 'bottom' as const,renderer:()=>this.renderer};
  attached(host:SeriesAttachedParameter<Time>){this.host=host;}
  detached(){this.host=null;}
  paneViews(){return [this.view];}
  setVisible(visible:boolean){this.visible=visible;this.host?.requestUpdate();}
  setData(points:SupertrendPoint[]){this.segments=supertrendSegments(points);this.host?.requestUpdate();}
  autoscaleInfo(start:number,end:number){
    if(!this.host||!this.visible)return null;
    const scale=this.host.chart.timeScale();
    let min=Infinity,max=-Infinity;
    for(const segment of this.segments)for(const point of segment){
      const x=scale.timeToCoordinate(point.time as UTCTimestamp);
      const logical=x===null?null:scale.coordinateToLogical(x);
      if(logical!==null&&logical>=start-1&&logical<=end+1){min=Math.min(min,point.value!);max=Math.max(max,point.value!);}
    }
    return Number.isFinite(min)?{priceRange:{minValue:min,maxValue:max}}:null;
  }
}
