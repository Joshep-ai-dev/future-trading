import type {IPrimitivePaneRenderer,ISeriesPrimitive,Logical,SeriesAttachedParameter,Time,UTCTimestamp} from 'lightweight-charts';
import type {BollingerPoint} from './bollingerBands';

/** Offset is in chart bars, not seconds; weekends and missing times stay aligned. */
export class BollingerOverlay implements ISeriesPrimitive<Time>{
  private host:SeriesAttachedParameter<Time>|null=null;
  private points:BollingerPoint[]=[];
  private visible=false;
  private offset=0;
  private coordinates(point:BollingerPoint){
    const host=this.host;if(!host)return null;
    const scale=host.chart.timeScale(),x=scale.timeToCoordinate(point.time as UTCTimestamp);
    const logical=x===null?null:scale.coordinateToLogical(x);
    if(logical===null)return null;
    return {logical:logical+this.offset,x:scale.logicalToCoordinate((logical+this.offset) as Logical),
      basis:point.basis===null?null:host.series.priceToCoordinate(point.basis),
      upper:point.upper===null?null:host.series.priceToCoordinate(point.upper),
      lower:point.lower===null?null:host.series.priceToCoordinate(point.lower)};
  }
  private renderer:IPrimitivePaneRenderer={draw:target=>{
    if(!this.host||!this.visible)return;
    target.useMediaCoordinateSpace(({context:ctx,mediaSize})=>{
      const rows=this.points.map(point=>this.coordinates(point));
      ctx.save();ctx.lineWidth=1;
      for(let i=1;i<rows.length;i++){
        const a=rows[i-1],b=rows[i];
        if(!a||!b||a.x===null||b.x===null||b.x<0||a.x>mediaSize.width)continue;
        if(a.upper!==null&&a.lower!==null&&b.upper!==null&&b.lower!==null){
          ctx.fillStyle='rgba(33,150,243,0.05)';ctx.beginPath();ctx.moveTo(a.x,a.upper);ctx.lineTo(b.x,b.upper);
          ctx.lineTo(b.x,b.lower);ctx.lineTo(a.x,a.lower);ctx.closePath();ctx.fill();
        }
        for(const [key,color] of [['basis','#2962ff'],['upper','#f23645'],['lower','#089981']] as const){
          if(a[key]===null||b[key]===null)continue;
          ctx.strokeStyle=color;ctx.beginPath();ctx.moveTo(a.x,a[key]!);ctx.lineTo(b.x,b[key]!);ctx.stroke();
        }
      }
      ctx.restore();
    });
  }};
  private view={zOrder:()=> 'bottom' as const,renderer:()=>this.renderer};
  attached(host:SeriesAttachedParameter<Time>){this.host=host;}
  detached(){this.host=null;}
  paneViews(){return [this.view];}
  setVisible(value:boolean){this.visible=value;this.host?.requestUpdate();}
  setData(points:BollingerPoint[],offset:number){this.points=points;this.offset=offset;this.host?.requestUpdate();}
  autoscaleInfo(start:number,end:number){
    if(!this.host||!this.visible)return null;
    let min=Infinity,max=-Infinity;
    for(const point of this.points){
      const row=this.coordinates(point);if(!row||row.logical<start-1||row.logical>end+1)continue;
      for(const value of [point.basis,point.upper,point.lower])if(value!==null){min=Math.min(min,value);max=Math.max(max,value);}
    }
    return Number.isFinite(min)?{priceRange:{minValue:min,maxValue:max}}:null;
  }
}
