import type {SeriesMarker,UTCTimestamp,IPrimitivePaneRenderer,ISeriesPrimitive,SeriesAttachedParameter,Time} from 'lightweight-charts';

/** Center the marker on the actual execution price, including off-candle fills. */
export function fillMarker(time:number,price:number,_label:string,kind:'entry'|'close',direction:number,id:string,quantity:number):SeriesMarker<UTCTimestamp> {
  const buy=kind==='entry'?direction===1:direction!==1;
  const name=kind==='entry'?(direction===1?'Long':'Short'):`Close ${direction===1?'long':'short'}`;
  return {
    time:time as UTCTimestamp,position:buy?'atPriceBottom':'atPriceTop',price,
    shape:buy?'arrowUp':'arrowDown',
    color:buy?'#7d8bff':'#d485e8',
    id,text:`${name}\n${buy?'+':'-'}${Number(quantity.toFixed(3))}\n@ ${Number(price.toFixed(8))}`,size:1,
  };
}

/** Canvas labels stay attached to fill coordinates while panning, zooming and replaying. */
export class FillLabels implements ISeriesPrimitive<Time> {
  private attachedTo:SeriesAttachedParameter<Time>|null=null;
  private markers:SeriesMarker<UTCTimestamp>[]=[];
  private renderer:IPrimitivePaneRenderer={draw:target=>{
    const attached=this.attachedTo;
    if(!attached)return;
    target.useMediaCoordinateSpace(({context:ctx,mediaSize})=>{
      ctx.font='11px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
      for(const marker of this.markers){
        if(marker.price===undefined)continue;
        const x=attached.chart.timeScale().timeToCoordinate(marker.time),y=attached.series.priceToCoordinate(marker.price);
        if(x===null||y===null||x<0||x>mediaSize.width)continue;
        const below=marker.shape==='arrowUp',lines=(marker.text??'').split('\n');
        const start=below?y+27:y-27-(lines.length-1)*14;
        lines.forEach((line,index)=>{
          ctx.lineWidth=3;ctx.strokeStyle='#10141d';ctx.strokeText(line,x,start+index*14);
          ctx.fillStyle=index===1?marker.color:'#c5cede';ctx.fillText(line,x,start+index*14);
        });
      }
    });
  }};
  private view={renderer:()=>this.renderer};
  attached(parameters:SeriesAttachedParameter<Time>){this.attachedTo=parameters;}
  detached(){this.attachedTo=null;}
  paneViews(){return [this.view];}
  setMarkers(markers:SeriesMarker<UTCTimestamp>[]){this.markers=markers.filter(m=>m.price!==undefined);this.attachedTo?.requestUpdate();}
}
