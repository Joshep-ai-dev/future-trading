import type {IPrimitivePaneRenderer,ISeriesPrimitive,SeriesAttachedParameter,Time} from 'lightweight-charts';

/** Horizontal background band between two values, like TradingView's RSI band fill. */
export class PaneBand implements ISeriesPrimitive<Time>{
  private host:SeriesAttachedParameter<Time>|null=null;
  private visible=true;
  constructor(private low:number,private high:number,private color:string){}
  private renderer:IPrimitivePaneRenderer={
    draw:()=>{},
    drawBackground:target=>target.useMediaCoordinateSpace(({context:ctx,mediaSize})=>{
      if(!this.visible)return;
      const a=this.host?.series.priceToCoordinate(this.low),b=this.host?.series.priceToCoordinate(this.high);
      if(a==null||b==null)return;
      ctx.save();ctx.fillStyle=this.color;ctx.fillRect(0,Math.min(a,b),mediaSize.width,Math.abs(a-b));ctx.restore();
    }),
  };
  private view={renderer:()=>this.renderer};
  attached(host:SeriesAttachedParameter<Time>){this.host=host;}
  detached(){this.host=null;}
  paneViews(){return [this.view];}
  setVisible(visible:boolean){this.visible=visible;this.host?.requestUpdate();}
}
